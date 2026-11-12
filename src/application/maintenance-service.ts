import { rewriteRelationBullets } from '../domain/model.js';
import { ulid } from 'ulid';
import type { AuditSink, ChangesetStore, EntityStorage, SearchIndex } from '../ports/index.js';
import type { ChangeOperation, Changeset, Diagnostic, Entity, EntityMetadata, Scope } from '../domain/types.js';
import { MemoryError } from '../domain/errors.js';
import { MemoryService } from './memory-service.js';
import { GraphService } from './graph-service.js';
import { claimKey, legacyRelationId, normalizeClaims, relationIdentity, structuredRelations } from '../domain/model.js';
import { compactForm } from '../domain/similarity.js';
import { escapeRegExp, wikilinkLabel } from '../domain/path-safety.js';

export class MaintenanceService{
 constructor(private readonly storage:EntityStorage,private readonly index:SearchIndex,private readonly changesets:ChangesetStore,private readonly memory:MemoryService,private readonly audit:AuditSink){}
 private graphForChangesets:GraphService|undefined;
 private graph():GraphService{if(!this.graphForChangesets)this.graphForChangesets=new GraphService(this.storage,this.index,this.audit,this.memory);return this.graphForChangesets;}
 async reindex(){return this.index.rebuild(this.storage.scan());}
 async externalFiles(scope:Scope={kind:'vault'},includeContent=false,maxContentChars=20000){return (await this.storage.externalFiles()).filter(f=>pathInScope(f.path,scope)).map(f=>includeContent?{...f,content:f.content.slice(0,maxContentChars),content_truncated:f.content.length>maxContentChars}:{path:f.path,revision:f.revision,bytes:f.bytes,error:f.error});}
 async inspect(scope:Scope={kind:'vault'}){const files=(await this.storage.inspectFiles()).filter(f=>!f.entity?pathInScope(f.path,scope):entityInScope(f.entity,scope));const diagnostics:Diagnostic[]=files.filter(f=>f.error).map(f=>({code:'MALFORMED_MARKDOWN',severity:'error',message:f.error!,path:f.path}));const ids=new Map<string,string>();const indexedIds=new Set<string>();for(const f of files){if(!f.entity)continue;const prior=ids.get(f.entity.metadata.id);if(prior)diagnostics.push({code:'DUPLICATE_ID',severity:'error',message:`ID also used by ${prior}`,path:f.path,entity_id:f.entity.metadata.id});else ids.set(f.entity.metadata.id,f.path);indexedIds.add(f.entity.metadata.id);}for(const collision of await this.index.aliasCollisions())if(collision.entity_ids.every(id=>indexedIds.has(id)))diagnostics.push({code:'ALIAS_COLLISION',severity:'warning',message:`Alias key '${collision.key}' (${collision.form}) is claimed by ${collision.entity_ids.length} entities`,entity_id:collision.entity_ids[0]});return {files:files.length,valid:files.length-diagnostics.filter(d=>d.severity!=='warning').length,diagnostics};}
 async brokenLinks(scope:Scope={kind:'vault'}){const all=[];for await(const e of this.storage.scan())all.push(e);const entities=all.filter(e=>entityInScope(e,scope));const known=new Set(all.flatMap(e=>[e.metadata.title,...e.metadata.aliases,e.path.replace(/\.md$/i,''),e.path.replace(/\.md$/i,'').split('/').at(-1)??'']).map(normalizeLink));return entities.flatMap(e=>e.wikilinks.filter(l=>!known.has(normalizeLink(l))).map(link=>({source_id:e.metadata.id,path:e.path,link})));}
 async duplicates(scope:Scope={kind:'vault'}){const groups=new Map<string,Array<{id:string;title:string;path:string}>>();for await(const e of this.storage.scan()){if(!entityInScope(e,scope))continue;const key=compactForm(e.metadata.title);if(!key)continue;const list=groups.get(key)??[];list.push({id:e.metadata.id,title:e.metadata.title,path:e.path});groups.set(key,list);}return [...groups.values()].filter(group=>group.length>1);}
 async suggestLinks(scope:Scope={kind:'vault'},limit=100){const all=[];for await(const e of this.storage.scan())if(entityInScope(e,scope))all.push(e);const suggestions=[];for(let i=0;i<all.length;i++)for(let j=i+1;j<all.length;j++){const a=all[i]!,b=all[j]!,shared=a.metadata.tags.filter(tag=>b.metadata.tags.includes(tag));if(shared.length)suggestions.push({source_id:a.metadata.id,target_id:b.metadata.id,reason:'shared_tags',shared_tags:shared});if(suggestions.length>=limit)return suggestions;}return suggestions;}
 async prepare(description:string,operations:ChangeOperation[],diagnostics:Diagnostic[]=[]):Promise<Changeset>{const cs:Changeset={id:ulid(),created_at:new Date().toISOString(),status:'prepared',description,operations,diagnostics};await this.changesets.save(cs);return cs;}
 async apply(id:string,client?:string):Promise<{changeset:Changeset;entities:string[]}>{const cs=await this.changesets.get(id);if(!cs)throw new MemoryError('NOT_FOUND',`Changeset not found: ${id}`);if(cs.status!=='prepared')throw new MemoryError('CONFLICT',`Changeset is ${cs.status}`);
   // Validate every precondition before the first write.
   for(const op of cs.operations){
     if(op.kind==='adopt'){if(!op.path||!op.expected_revision||!op.draft)throw new MemoryError('VALIDATION_ERROR','Adopt operation requires path, draft, and expected_revision');const external=(await this.storage.externalFiles()).find(file=>file.path===op.path);if(!external)throw new MemoryError('CONFLICT',`External file is missing or already managed: ${op.path}`);if(external.revision!==op.expected_revision)throw new MemoryError('CONFLICT',`Conflict for external file ${op.path}`);}
     else if(op.kind==='merge'){if(!op.entity_id||!op.target_id||!op.expected_revision||!op.expected_target_revision)throw new MemoryError('VALIDATION_ERROR','Merge operation requires entity_id, target_id, and both expected revisions');const source=await this.memory.get(op.entity_id);const target=await this.memory.get(op.target_id);if(source.metadata.id===target.metadata.id)throw new MemoryError('VALIDATION_ERROR','An entity cannot be merged into itself');if(source.revision!==op.expected_revision)throw new MemoryError('CONFLICT',`Conflict for ${op.entity_id}`);if(target.revision!==op.expected_target_revision)throw new MemoryError('CONFLICT',`Conflict for ${op.target_id}`);}
     else if(op.kind==='relation'){if(!op.entity_id||!op.expected_revision||!op.relation_type||!op.target_id)throw new MemoryError('VALIDATION_ERROR','Relation operation requires entity_id, expected_revision, relation_type, and target_id');const e=await this.memory.get(op.entity_id);if(e.revision!==op.expected_revision)throw new MemoryError('CONFLICT',`Conflict for ${op.entity_id}`);if(op.target_id===op.entity_id)throw new MemoryError('VALIDATION_ERROR','Self-relations are not supported');await this.memory.get(op.target_id);}
     else if(op.kind==='claim'){if(!op.entity_id||!op.expected_revision||!op.predicate||op.value===undefined)throw new MemoryError('VALIDATION_ERROR','Claim operation requires entity_id, expected_revision, predicate, and value');const e=await this.memory.get(op.entity_id);if(e.revision!==op.expected_revision)throw new MemoryError('CONFLICT',`Conflict for ${op.entity_id}`);for(const sourceId of op.source_ids??[]){let resolved:Entity;try{resolved=await this.memory.get(sourceId);}catch{throw new MemoryError('VALIDATION_ERROR',`Claim source entity not found: ${sourceId}`);}if(resolved.metadata.type!=='source')throw new MemoryError('INVALID_SOURCE_TYPE',`Claim source ${sourceId} is a ${resolved.metadata.type}, not a source`);}}
     else if(op.kind==='delete'){/*
       * Physical delete, restricted on purpose: only migration-created source
       * entities (Phase-3C §27 rollback) ever qualify, so this changeset kind
       * can never become a generic vault-delete path through any client tool.
       */
       if(!op.entity_id)throw new MemoryError('VALIDATION_ERROR','Delete operation requires entity_id');const e=await this.memory.get(op.entity_id);if(e.metadata.type!=='source'||typeof e.metadata.derived_from!=='string'||typeof e.metadata.identity_type!=='string')throw new MemoryError('VALIDATION_ERROR','Delete changeset operations are restricted to migration-created source entities');}
     else if(op.kind!=='create'){if(!op.entity_id||!op.expected_revision)throw new MemoryError('VALIDATION_ERROR',op.kind==='restore'?'Restore operation requires entity_id and expected_revision':'Mutating operation requires entity_id and expected_revision');const e=await this.memory.get(op.entity_id);if(e.revision!==op.expected_revision)throw new MemoryError('CONFLICT',`Conflict for ${op.entity_id}`);}}
   const entities:string[]=[];
   // All-or-nothing for the batch: every executed write of the compensable
   // kinds is tracked with its pre-batch state, so a failure anywhere after
   // the first write restores the exact prior metadata + content of every
   // touched entity. `merge` compensates itself; `create`, `move`, and
   // `adopt` change file locations and are not compensable here, and
   // `delete` is irreversible by design (migration rollback only). Operations
   // on the same entity chain their revisions: after the first write to an
   // entity, later ops of the same changeset use the running revision (the
   // plan's expected_revision would otherwise be stale).
   const executed:Array<{before:Entity;after:Entity}>=[];
   const running=new Map<string,string>();
   try{
   for(const op of cs.operations){
    const revisionNow=(op.entity_id&&running.has(op.entity_id))?running.get(op.entity_id):undefined;
    if(op.kind==='create'&&op.draft)entities.push((await this.memory.create(op.draft,client)).metadata.id);
    else if(op.kind==='delete'&&op.entity_id)entities.push((await this.memory.delete(op.entity_id,client)).metadata.id);
    else if(op.kind==='update'&&op.entity_id&&op.patch&&op.expected_revision)entities.push((await this.trackOp(op.entity_id!,op.kind,executed,running,async(before)=>this.memory.update(op.entity_id!,op.patch!,revisionNow??before.revision,client))).metadata.id);
    else if(op.kind==='archive'&&op.entity_id&&op.expected_revision)entities.push((await this.trackOp(op.entity_id!,op.kind,executed,running,async(before)=>this.memory.archive(op.entity_id!,revisionNow??before.revision,client))).metadata.id);
    else if(op.kind==='move'&&op.entity_id&&op.destination&&op.expected_revision)entities.push((await this.memory.move(op.entity_id,op.destination,op.expected_revision,client)).metadata.id);
    else if(op.kind==='adopt'&&op.path&&op.draft&&op.expected_revision)entities.push((await this.memory.adopt(op.path,op.draft,op.expected_revision,client)).metadata.id);
    else if(op.kind==='restore'&&op.entity_id&&op.expected_revision&&op.patch?.metadata)entities.push((await this.trackOp(op.entity_id!,op.kind,executed,running,async(before)=>this.restoreOp({...op,expected_revision:revisionNow??before.revision},client))).metadata.id);
    else if(op.kind==='relation'&&op.entity_id&&op.relation_type&&op.target_id){
      const before=await this.memory.get(op.entity_id);
      const result=await this.graph().createRelation({entity_id:op.entity_id,relation_type:op.relation_type,target_id:op.target_id,expected_revision:revisionNow??op.expected_revision!,
        ...(op.relation_id===undefined?{}:{relation_id:op.relation_id}),
        ...(op.timestamp===undefined?{}:{timestamp:op.timestamp})},client) as{created:boolean;revision?:string};
      if(result.created&&result.revision){
        const after=await this.memory.get(op.entity_id);
        executed.push({before,after});
        running.set(op.entity_id,after.revision);
      }
      entities.push(op.entity_id);}
    else if(op.kind==='claim'&&op.entity_id&&op.predicate&&op.value!==undefined){
      // Idempotence inside the batch: an identical open claim (same identity
      // key) already on the entity is skipped, never duplicated.
      const before=await this.memory.get(op.entity_id);
      if(normalizeClaims(before.metadata).some(claim=>claimKey(claim)===claimKey({predicate:op.predicate!,value:op.value,valid_to:null})&&(claim.status===undefined||claim.status==='current'||claim.status==='disputed'))){entities.push(op.entity_id);continue;}
      await this.graph().createClaim(op.entity_id,{predicate:op.predicate,value:op.value,source_ids:op.source_ids,
        ...(op.confidence===undefined?{}:{confidence:op.confidence}),
        ...(op.valid_from===undefined?{}:{valid_from:op.valid_from}),
        ...(op.close_existing===undefined?{}:{close_existing:op.close_existing}),
        ...(op.claim_id===undefined?{}:{claim_id:op.claim_id}),
        ...(op.timestamp===undefined?{}:{timestamp:op.timestamp})},
        revisionNow??op.expected_revision!,client);
      const after=await this.memory.get(op.entity_id);
      executed.push({before,after});
      running.set(op.entity_id,after.revision);
      entities.push(op.entity_id);}
    else if(op.kind==='merge'&&(op.entity_id||op.target_id))entities.push(...(await this.mergeEntities(op,client)));
    else throw new MemoryError('VALIDATION_ERROR',`Unsupported/incomplete operation: ${op.kind}`);}
   }catch(error){
    if(executed.length)for(const item of executed)await this.storage.write(item.after.metadata.id,item.before.metadata,item.before.content,item.after.revision,{timestamp:item.before.metadata.updated_at}).catch(()=>undefined);
    throw error;
   }
   cs.status='applied';await this.changesets.save(cs);return {changeset:cs,entities};}
 async repairRelationLinks(scope:Scope={kind:'vault'}){
  // Dry run: builds a changeset from legacy relation bullets; nothing is written until apply_changeset.
  const operations:ChangeOperation[]=[];const unresolved:Array<{entity_id:string;relation_id:string}>=[];
  const entities=[];for await(const e of this.storage.scan())if(entityInScope(e,scope))entities.push(e);
  const byId=new Map<string,Entity>();for(const e of entities)byId.set(e.metadata.id,e);
  for(const e of entities){
    if(!/<!--\s*rel:/.test(e.content))continue;
    const targets=new Map<string,{title:string;path:string}>();
    for(const rel of (e.metadata.relations??[]) as Array<{id:string;target_id:string}>){
      const target=byId.get(rel.target_id)??await this.memory.get(rel.target_id).catch(()=>undefined);
      if(target)targets.set(rel.id,{title:target.metadata.title,path:target.path});
    }
    const result=rewriteRelationBullets(e.content,targets);
    for(const id of result.unresolved)unresolved.push({entity_id:e.metadata.id,relation_id:id});
    if(result.changed>0)operations.push({kind:'update',entity_id:e.metadata.id,expected_revision:e.revision,patch:{content:result.content}});
  }
  const changeset=await this.prepare(`Rewrite legacy relation links to basename aliases (${operations.length} entities)`,operations,unresolved.map(u=>({code:'UNRESOLVED_RELATION',severity:'warning',message:`Relation ${u.relation_id} has no resolvable target`,entity_id:u.entity_id})) as Diagnostic[]);
  return {changeset,entities_to_change:operations.length,unresolved,next_steps:['apply_changeset with changeset_id = changeset.id (only after reviewing the operations)','reindex only if the neural sidecar was unavailable during apply (writes are mirrored into the in-memory and neural indexes; reindex repairs a lagging index)']};
 }
 async migrateSchema(target:number,scope:Scope={kind:'vault'}):Promise<Changeset>{const operations:ChangeOperation[]=[];for await(const e of this.storage.scan()){if(!entityInScope(e,scope))continue;if(e.metadata.schema_version<target)operations.push({kind:'update',entity_id:e.metadata.id,expected_revision:e.revision,patch:{metadata:{schema_version:target}}});}return this.prepare(`Migrate schema to ${target}`,operations);}
 async history(entityId?:string,limit=100){return this.audit.list(entityId,limit);}
 async prepareRollback(eventId:string):Promise<Changeset>{const events=await this.audit.list(undefined,10000);const event=events.find(item=>item.id===eventId);if(!event?.entity_id)throw new MemoryError('NOT_FOUND',`Audit event not found: ${eventId}`);
   if(event.operation==='merge'){const bundle=await this.audit.readBundle(eventId);if(!bundle.length)throw new MemoryError('VALIDATION_ERROR','This merge event has no restorable bundle snapshot');const operations:ChangeOperation[]=[];for(const item of bundle){if(!item.before)continue;const current=await this.memory.get(item.entity_id);operations.push({kind:'restore',entity_id:current.metadata.id,expected_revision:current.revision,patch:{title:item.before.metadata.title,content:item.before.content,metadata:item.before.metadata}});}return this.prepare(`Rollback audit event ${eventId}`,operations);}
   const before=await this.audit.readSnapshot(eventId,'before');if(!before)throw new MemoryError('VALIDATION_ERROR','This event has no restorable before snapshot');const current=await this.memory.get(event.entity_id);
   // Restore semantics, not update: a rolled-back entity must drop keys added since the snapshot (relations/claims), not merge the old metadata over the new.
   return this.prepare(`Rollback audit event ${eventId}`,[{kind:'restore',entity_id:current.metadata.id,expected_revision:current.revision,patch:{title:before.metadata.title,content:before.content,metadata:before.metadata}}]);}

 /**
  * Merge source into target as one all-or-nothing bundle: aliases, relations,
  * and claims move into the target (identity-deduplicated), every external
  * wikilink is rewritten, the source is archived, and one audit event holds
  * before/after snapshots of every touched file for rollback.
  */
 private async mergeEntities(op:ChangeOperation,client?:string):Promise<string[]>{const source=await this.memory.get(op.entity_id!);const target=await this.memory.get(op.target_id!);
   if(source.revision!==op.expected_revision)throw new MemoryError('CONFLICT',`Conflict for ${source.metadata.id}`);
   if(target.revision!==op.expected_target_revision)throw new MemoryError('CONFLICT',`Conflict for ${target.metadata.id}`);
   // Identifiers of the source that may be rewritten in other files' wikilinks —
   // only names that resolve to exactly the source entity, never an ambiguous alias.
   // Archived claimants are deliberately still counted here (includeArchived:true):
   // a wikilink may still have been written for an archived duplicate file that
   // exists in the vault, and silently redirecting it would destroy intent. This
   // is the conservative pre-existing behaviour; normal resolution hides archived.
   const identifiers:string[]=[];const seenIdentifiers=new Set<string>();
   for(const name of [source.metadata.title,...source.metadata.aliases]){const key=name.toLocaleLowerCase();if(seenIdentifiers.has(key))continue;seenIdentifiers.add(key);const matches=await this.index.resolveLookup(name,{includeArchived:true});if(matches.length&&matches.every(match=>match.entity.metadata.id===source.metadata.id))identifiers.push(name);}
   const now=new Date().toISOString();
   interface PlannedWrite{current:Entity;metadata:EntityMetadata;content:string;}
   const planned:PlannedWrite[]=[];
   const conflicts:string[]=[];
   for await(const entity of this.storage.scan()){
     if(entity.metadata.id===source.metadata.id||entity.metadata.id===target.metadata.id)continue;
     let content=entity.content;let changed=false;
     const safeTitle=wikilinkLabel(target.metadata.title)||'untitled';
     for(const identifier of identifiers)for(const flags of ['', 'i']){const rewritten=content.replace(new RegExp(`\\[\\[\\s*${escapeRegExp(identifier)}([\\]|#]{1,2})`,'g'+flags),(_match,suffix:string)=>`[[${safeTitle}${suffix}`);if(rewritten!==content){content=rewritten;changed=true;break;}}
     const metadata:EntityMetadata={...entity.metadata};
     const relations=structuredRelations(entity.metadata);const legacy=Array.isArray(entity.metadata.relationships)?entity.metadata.relationships:[];
     const remappedRelations=relations.map(edge=>edge.target_id===source.metadata.id?{...edge,target_id:target.metadata.id,updated_at:now}:edge);
     const remappedLegacy=legacy.map(raw=>{const entry=raw as{type?:unknown;target_id?:unknown};if(entry&&entry.target_id===source.metadata.id)return{...entry,target_id:target.metadata.id};return raw;});
     if(remappedRelations.some((edge,index)=>edge!==relations[index])){changed=true;
       const identities=new Set<string>();for(const edge of remappedRelations){const key=relationIdentity(edge);if(identities.has(key))conflicts.push(`${entity.metadata.id}: duplicate relation ${key} after merge`);identities.add(key);}
       // De-duplicated rewrite would silently drop knowledge, so both entries stay; the conflict is reported instead.
       metadata.relations=remappedRelations;}
     if(remappedLegacy.some((entry,index)=>entry!==legacy[index])){changed=true;metadata.relationships=remappedLegacy;}
     if(changed)planned.push({current:entity,metadata,content});
   }
   // Target patch: aliases gain the source title, relations and claims merge identity-deduplicated.
   const targetMetadata:EntityMetadata={...target.metadata};
   targetMetadata.aliases=[...new Set([...target.metadata.aliases.filter(alias=>alias.toLocaleLowerCase()!==source.metadata.title.toLocaleLowerCase()),source.metadata.title])];
   const mergedRelations=[...structuredRelations(target.metadata)];const identities=new Set(mergedRelations.map(relationIdentity));let relationsMerged=0;
   for(const edge of structuredRelations(source.metadata)){if(edge.target_id===target.metadata.id)continue;const key=relationIdentity(edge);if(identities.has(key)){conflicts.push(`already-represented relation ${key} on target`);continue;}identities.add(key);mergedRelations.push(edge);relationsMerged++;}
   for(const entry of Array.isArray(source.metadata.relationships)?source.metadata.relationships:[]){const raw=entry as{type?:unknown;target_id?:unknown};const type=String(raw.type??''),targetId=String(raw.target_id??'');if(!type||!targetId)continue;if(targetId===target.metadata.id)continue;const key=relationIdentity({type,target_id:targetId});if(identities.has(key)){conflicts.push(`already-represented legacy relation ${key} on target`);continue;}identities.add(key);mergedRelations.push({id:legacyRelationId(target.metadata.id,type,targetId),type,target_id:targetId,created_at:now,updated_at:now});relationsMerged++;}
   targetMetadata.relations=mergedRelations;
   const targetClaims=normalizeClaims(target.metadata);const claimIds=new Set(targetClaims.map(claim=>claimKey(claim)));const mergedClaims=[...targetClaims];let claimsMerged=0;
   for(const claim of normalizeClaims(source.metadata)){const key=claimKey(claim);if(claimIds.has(key)){conflicts.push(`already-represented claim ${claim.predicate} on target`);continue;}claimIds.add(key);mergedClaims.push(claim);claimsMerged++;}
   targetMetadata.claims=mergedClaims;
   const targetWrite:PlannedWrite={current:target,metadata:targetMetadata,content:target.content};
   // Validate every affected revision before the first write.
   for(const item of [targetWrite,...planned]){const live=await this.memory.get(item.current.metadata.id);if(live.revision!==item.current.revision)throw new MemoryError('CONFLICT',`Conflict for ${item.current.metadata.id}`);}
   const applied:PlannedWrite[]=[targetWrite,...planned];
   const executed:Array<{before:Entity;after:Entity}>=[];let afterSource:Entity;
   try{
     for(const item of applied)executed.push({before:item.current,after:await this.storage.write(item.current.metadata.id,item.metadata,item.content,item.current.revision)});
     const sourceMetadata:EntityMetadata={...source.metadata,status:'archived',archived_at:now};
     afterSource=await this.storage.write(source.metadata.id,sourceMetadata,source.content,source.revision);
   }catch(error){
     for(const item of executed)await this.storage.write(item.after.metadata.id,item.before.metadata,item.before.content,item.after.revision).catch(()=>undefined);
     throw error;
   }
   const eventId=ulid();
   const bundle=[...executed.map(item=>({entity_id:item.before.metadata.id,path:item.before.path,before:item.before,after:item.after})),{entity_id:source.metadata.id,path:source.path,before:source,after:afterSource}];
   await this.audit.append({id:eventId,timestamp:now,operation:'merge',entity_id:source.metadata.id,client,before_revision:source.revision,after_revision:afterSource.revision,details:{target_id:target.metadata.id,aliases_added:[source.metadata.title],relations_merged:relationsMerged,claims_merged:claimsMerged,files_rewritten:planned.length,identifiers_rewritten:identifiers,conflicts}},undefined,undefined,bundle);
   return [target.metadata.id,source.metadata.id];
 }

 /** Wholesale restore of one entity from an audit snapshot; bypasses the graph-key guardrail on purpose. */
 private async restoreOp(op:ChangeOperation,client?:string):Promise<Entity>{const current=await this.memory.get(op.entity_id!);const after=await this.storage.write(current.metadata.id,op.patch!.metadata as EntityMetadata,op.patch!.content??'',op.expected_revision!,{timestamp:(op.patch!.metadata as EntityMetadata).updated_at});const eventId=ulid();await this.audit.append({id:eventId,timestamp:new Date().toISOString(),operation:'restore',entity_id:after.metadata.id,client,before_revision:current.revision,after_revision:after.revision,before_snapshot:`${eventId}-before.json`,after_snapshot:`${eventId}-after.json`,details:{restored_from_changeset:true}},current,after);return after;}

 /**
  * Runs one state write with batch-coverage bookkeeping: the pre-write state
  * and post-write state are remembered so that a batch failure can restore
  * every already-written entity, and later ops in the same changeset chain
  * onto the running revision.
  */
 private async trackOp(entityId:string,kind:string,executed:Array<{before:Entity;after:Entity}>,running:Map<string,string>,mutate:(before:Entity)=>Promise<Entity>):Promise<Entity>{
   if(!['relation','claim','update','archive','restore'].includes(kind))return mutate(await this.memory.get(entityId));
   const before=await this.memory.get(entityId);
   const after=await mutate(before);
   executed.push({before,after});
   running.set(after.metadata.id,after.revision);
   return after;
 }
}

function pathInScope(path:string,scope:Scope):boolean{if(scope.kind==='file')return path===scope.path;if(scope.kind==='folder')return path===scope.path||path.startsWith(`${scope.path.replace(/\/$/,'')}/`);return scope.kind==='vault';}
function entityInScope(entity:import('../domain/types.js').Entity,scope:Scope):boolean{switch(scope.kind){case'vault':return true;case'file':case'folder':return pathInScope(entity.path,scope);case'entity_type':return entity.metadata.type===scope.entity_type;case'project':return entity.metadata.id===scope.entity_id||arrayHas(entity.metadata.projects,scope.entity_id);case'changed_since':return new Date(entity.metadata.updated_at)>=new Date(scope.timestamp);}}
function arrayHas(value:unknown,item:string):boolean{return Array.isArray(value)&&value.map(String).includes(item);}
function normalizeLink(value:string):string{return value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/\\/g,'/').replace(/\.md$/i,'').replace(/\/$/,'').toLocaleLowerCase();}
