import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { compose } from '../src/composition.js';
import { createHttpApp } from '../src/transports/http/server.js';
import type { AppConfig } from '../src/config/schema.js';
import type { Services } from '../src/composition.js';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});

const routing:AppConfig['routing']={memory:{backend:'markdown',path:'Memory/{slug}.md'},note:{backend:'markdown',path:'Notes/{slug}.md'},person:{backend:'markdown',path:'People/{slug}.md'},project:{backend:'markdown',path:'Projects/{slug}/index.md'},inbox:{backend:'markdown',path:'Inbox/{slug}.md'},source:{backend:'markdown',path:'Sources/{provider}/{date}-{slug}.md'}};

interface Harness{base:string;services:Services;client:Client}

async function harness(name:string,bearerTokenEnv='UNSET_TEST_TOKEN',connectMcp=true):Promise<Harness>{
 const root=await mkdtemp(path.join(os.tmpdir(),name));cleanup.push(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'vault'));
 const config:AppConfig={name:'REST Parity Test',vault_root:path.join(root,'vault'),read_only:false,audit_dir:path.join(root,'audit'),transport:'http',http:{bind:'127.0.0.1',port:3333,allowed_origins:[],bearer_token_env:bearerTokenEnv},routing};
 const services=await compose(config);const app=createHttpApp(services);const http=await listen(app);cleanup.push(()=>close(http));
 const address=http.address();if(!address||typeof address==='string')throw new Error('No TCP address');
 const client=new Client({name:'test-client',version:'1.0.0'},{versionNegotiation:{mode:'auto'}});cleanup.push(()=>client.close());
 if(connectMcp)await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
 return {base:`http://127.0.0.1:${address.port}`,services,client};
}

type Json=Record<string,unknown>;
const ids=(bucket:unknown):string[]=>Array.isArray(bucket)?(bucket as Array<{id:string}>).map(c=>c.id):[];

describe('REST parity for timeline, correction and suspect endpoints',()=>{
 it('rejects unauthenticated timeline, correction and suspect requests with AUTH_REQUIRED',async()=>{
  process.env.REST_PARITY_TEST_TOKEN='parity-secret';
  const {base}=await harness('memory-rest-parity-auth-','REST_PARITY_TEST_TOKEN',false);
  for(const [method,url] of [['GET','/api/v1/entities/whatever/timeline'],['GET','/api/v1/claims/suspects?source=x'],['POST','/api/v1/claims/whatever/correct']]){
   const response=await fetch(`${base}${url}`,method==='POST'?{method,headers:{'content-type':'application/json'},body:'{}'}:{method});
   expect(response.status).toBe(401);
   const body=await response.json() as Json;
   expect(body.ok).toBe(false);
   expect((body.error as Json).code).toBe('AUTH_REQUIRED');
   expect((body.error as Json).message).toBe('Valid bearer token required');
  }
  const wrongToken=await fetch(`${base}/api/v1/claims/suspects?source=x`,{headers:{authorization:'Bearer nope'}});
  expect(wrongToken.status).toBe(401);
  const ok=await fetch(`${base}/api/v1/claims/suspects?source=x`,{headers:{authorization:'Bearer parity-secret'}});
  expect(ok.status).toBe(200); // authenticated: the scan runs and finds nothing for an unknown source
  delete process.env.REST_PARITY_TEST_TOKEN;
 });

 it('serves the timeline over REST with deterministic bucket order and the MCP payload shape',async()=>{
  const {base,services,client}=await harness('memory-rest-parity-timeline-');
  const created=await (await fetch(`${base}/api/v1/memory`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'note',title:'Timeline via REST'})})).json() as {metadata:{id:string};revision:string};
  const entityId=created.metadata.id;
  const call=async(name:string,args:Json)=>{const result=await client.callTool({name,arguments:args});if(result.isError)throw new Error(`${name} failed: ${JSON.stringify(result)}`);return result.structuredContent as {data:Json};};
  // three closed (past) windows, deliberately inserted oldest-first so ordering is proven, not accidental
  const pastIds:string[]=[];
  for(const [from,to] of [['2019-01-01','2021-06-30'],['2021-07-01','2023-03-15'],['2023-03-16','2024-12-31']]){
   const revision=(await services.memory.get(entityId)).revision;
   const made=await call('create_claim',{entity_id:entityId,predicate:'residence',value:`window ${from}`,valid_from:from,expected_revision:revision});
   const id=(made.data.claim as {id:string}).id;
   const nextRevision=(await services.memory.get(entityId)).revision;
   await call('update_claim',{entity_id:entityId,claim_id:id,patch:{value:`window ${from}`,valid_to:to},expected_revision:nextRevision});
   pastIds.push(id);
  }
  // two open claims already in effect (most recently started first)
  const presentIds:string[]=[];
  for(const from of ['2025-01-01','2026-05-01']){
   const revision=(await services.memory.get(entityId)).revision;
   const made=await call('create_claim',{entity_id:entityId,predicate:'current_focus',value:`focus ${from}`,valid_from:from,expected_revision:revision});
   presentIds.push((made.data.claim as {id:string}).id);
  }
  // two open claims that have not started yet (soonest start first)
  const plannedIds:string[]=[];
  for(const from of ['2027-01-01','2026-12-01']){
   const revision=(await services.memory.get(entityId)).revision;
   const made=await call('create_claim',{entity_id:entityId,predicate:'upgrade',value:`plan ${from}`,valid_from:from,expected_revision:revision});
   plannedIds.push((made.data.claim as {id:string}).id);
  }
  // one claim wrong from the start: it belongs in errors, never in past/present/planned
  const source=await call('create_source',{title:'Spec Sheet',provider:'chatgpt',conversation_id:'spec-conv-1',message_range:null});
  const sourceId=(source.data as {id:string}).id;
  const revision=(await services.memory.get(entityId)).revision;
  const erroneous=await call('create_claim',{entity_id:entityId,predicate:'memory_size_gb',value:11,source_ids:[sourceId],valid_from:'2024-01-01',expected_revision:revision});
  const erroneousId=(erroneous.data.claim as {id:string}).id;
  const correction=await (await fetch(`${base}/api/v1/claims/${erroneousId}/correct`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({entity_id:entityId,value:24,reason:'transcribed from the wrong spec sheet',expected_revision:(await services.memory.get(entityId)).revision})})).json() as Json;
  const correctedId=(correction.corrected as {id:string}).id;

  const response=await fetch(`${base}/api/v1/entities/${entityId}/timeline?as_of=2026-10-09`);
  expect(response.status).toBe(200);
  const timeline=await response.json() as Json;
  expect(timeline.entity_id).toBe(entityId);
  expect(timeline.as_of).toBe('2026-10-09');
  expect(timeline.counts).toEqual({past:3,present:3,planned:2,errors:1});
  expect(ids(timeline.past)).toEqual([...pastIds].reverse()); // newest valid_to first
  expect(ids(timeline.present)).toEqual([presentIds[1],presentIds[0],correctedId]); // valid_from desc; correction inherits 2024-01-01
  expect(ids(timeline.planned)).toEqual([plannedIds[1],plannedIds[0]]); // soonest start first
  expect(ids(timeline.errors)).toEqual([erroneousId]);
  expect((timeline.errors as Array<{status:string}>)[0]?.status).toBe('recorded_in_error');
  for(const bucket of [timeline.past,timeline.present,timeline.planned])
   for(const claim of bucket as Array<{id:string;status?:string}>)expect(claim.status).not.toBe('recorded_in_error');

  const mcp=await client.callTool({name:'get_entity_timeline',arguments:{entity_id:entityId,as_of:'2026-10-09'}}) as {structuredContent?:{data:Json}};
  expect(mcp.structuredContent?.data).toEqual(timeline);
  expect(ids((mcp.structuredContent?.data as Json).past)).toEqual(ids(timeline.past));
  expect(ids((mcp.structuredContent?.data as Json).planned)).toEqual(ids(timeline.planned));
  expect(ids((mcp.structuredContent?.data as Json).errors)).toEqual(ids(timeline.errors));

  const badAsOf=await fetch(`${base}/api/v1/entities/${entityId}/timeline?as_of=not-a-date`);
  expect(badAsOf.status).toBe(400);
  expect(((await badAsOf.json()) as Json).error).toMatchObject({code:'VALIDATION_ERROR'});
  const missing=await fetch(`${base}/api/v1/entities/00000000000000000000000000/timeline`);
  expect(missing.status).toBe(404);
  expect(((await missing.json()) as Json).error).toMatchObject({code:'NOT_FOUND'});
 });

 it('corrects a claim and scans suspects over REST with the MCP payload shape',async()=>{
  const {base,services,client}=await harness('memory-rest-parity-correction-');
  const created=await (await fetch(`${base}/api/v1/memory`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'note',title:'Correction via REST'})})).json() as {metadata:{id:string};revision:string};
  const entityId=created.metadata.id;
  const call=async(name:string,args:Json)=>{const result=await client.callTool({name,arguments:args});if(result.isError)throw new Error(`${name} failed: ${JSON.stringify(result)}`);return result.structuredContent as {data:Json};};
  const source=await call('create_source',{title:'Spec Sheet',provider:'chatgpt',conversation_id:'spec-conv-2',message_range:null});
  const sourceId=(source.data as {id:string}).id;
  const made=await call('create_claim',{entity_id:entityId,predicate:'memory_size_gb',value:11,source_ids:[sourceId],valid_from:'2024-01-01',expected_revision:created.revision});
  const claimId=(made.data.claim as {id:string}).id;

  const response=await fetch(`${base}/api/v1/claims/${claimId}/correct`,{method:'POST',headers:{'content-type':'application/json','x-client-id':'rest-parity-test'},body:JSON.stringify({entity_id:entityId,value:24,reason:'transcribed from the wrong spec sheet',expected_revision:(await services.memory.get(entityId)).revision})});
  expect(response.status).toBe(200);
  const correction=await response.json() as Json;
  expect(correction.entity_id).toBe(entityId);
  expect((correction.original as Json).id).toBe(claimId);
  expect((correction.original as Json).status).toBe('recorded_in_error');
  expect((correction.original as Json).error_reason).toBe('transcribed from the wrong spec sheet');
  expect((correction.original as Json).valid_to).toBeNull();
  expect((correction.corrected as Json).corrects).toBe(claimId);
  expect((correction.corrected as Json).value).toBe(24);

  const suspects=await fetch(`${base}/api/v1/claims/suspects?source=${sourceId}&predicate=memory_size_gb`);
  expect(suspects.status).toBe(200);
  const payload=await suspects.json() as Json;
  expect(payload.source_id).toBe(sourceId);
  expect(payload.predicate).toBe('memory_size_gb');
  expect(payload.count).toBe(1);
  expect((payload.candidates as Array<{id:string;reason:string}>)[0]?.id).toBe((correction.corrected as Json).id);
  expect((payload.candidates as Array<{reason:string}>)[0]?.reason).toBe('same source and predicate as a claim recorded in error');

  const mcpSuspects=await client.callTool({name:'find_suspect_claims',arguments:{source_id:sourceId,predicate:'memory_size_gb'}}) as {structuredContent?:{data:Json}};
  expect(mcpSuspects.structuredContent?.data).toEqual(payload);

  const limited=await fetch(`${base}/api/v1/claims/suspects?source=${sourceId}&limit=1`);
  expect(((await limited.json()) as Json).count).toBe(1);
  const noLimit=await fetch(`${base}/api/v1/claims/suspects?source=${sourceId}`);
  expect(((await noLimit.json()) as Json).count).toBe(1); // service default applies when limit is omitted
  const clamped=await fetch(`${base}/api/v1/claims/suspects?source=${sourceId}&limit=5000`);
  expect(((await clamped.json()) as Json).count).toBe(1); // service clamps to 1000

  const noSource=await fetch(`${base}/api/v1/claims/suspects`);
  expect(noSource.status).toBe(400);
  expect(((await noSource.json()) as Json).error).toMatchObject({code:'VALIDATION_ERROR'});

  const noReason=await fetch(`${base}/api/v1/claims/${claimId}/correct`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({entity_id:entityId,value:32,expected_revision:(await services.memory.get(entityId)).revision})});
  expect(noReason.status).toBe(400);
  expect(((await noReason.json()) as Json).error).toMatchObject({code:'VALIDATION_ERROR'});

  const noEntity=await fetch(`${base}/api/v1/claims/${claimId}/correct`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({value:32,expected_revision:'whatever'})});
  expect(noEntity.status).toBe(400);
  expect(((await noEntity.json()) as Json).error).toMatchObject({code:'VALIDATION_ERROR'});

  const noRevision=await fetch(`${base}/api/v1/claims/${claimId}/correct`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({entity_id:entityId,value:32,reason:'again'})});
  expect(noRevision.status).toBe(400);
  expect(((await noRevision.json()) as Json).error).toMatchObject({code:'VALIDATION_ERROR'});

  const staleRevision=await fetch(`${base}/api/v1/claims/${claimId}/correct`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({entity_id:entityId,value:32,reason:'stale',expected_revision:'00000000000000000000000000'})});
  expect(staleRevision.status).toBe(409);
  expect(((await staleRevision.json()) as Json).error).toMatchObject({code:'CONFLICT'});

  const alreadyCorrected=await fetch(`${base}/api/v1/claims/${claimId}/correct`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({entity_id:entityId,value:32,reason:'twice',expected_revision:(await services.memory.get(entityId)).revision})});
  expect(alreadyCorrected.status).toBe(400);
  expect(((await alreadyCorrected.json()) as Json).error).toMatchObject({code:'VALIDATION_ERROR'});

  const unknownClaim=await fetch(`${base}/api/v1/claims/00000000000000000000000000/correct`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({entity_id:entityId,value:32,reason:'unknown',expected_revision:(await services.memory.get(entityId)).revision})});
  expect(unknownClaim.status).toBe(404);
  expect(((await unknownClaim.json()) as Json).error).toMatchObject({code:'NOT_FOUND'});

  const unknownEntity=await fetch(`${base}/api/v1/claims/${claimId}/correct`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({entity_id:'00000000000000000000000000',value:32,reason:'unknown entity',expected_revision:'00000000000000000000000000'})});
  expect(unknownEntity.status).toBe(404);
  expect(((await unknownEntity.json()) as Json).error).toMatchObject({code:'NOT_FOUND'});
 });

 it('rejects a non-integer or non-positive suspect limit instead of silently returning no candidates',async()=>{
  const {base,services,client}=await harness('memory-rest-parity-limit-');
  const created=await (await fetch(`${base}/api/v1/memory`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'note',title:'Suspect limit via REST'})})).json() as {metadata:{id:string};revision:string};
  const entityId=created.metadata.id;
  const call=async(name:string,args:Json)=>{const result=await client.callTool({name,arguments:args});if(result.isError)throw new Error(`${name} failed: ${JSON.stringify(result)}`);return result.structuredContent as {data:Json};};
  const source=await call('create_source',{title:'Limit Sheet',provider:'chatgpt',conversation_id:'limit-conv-1',message_range:null});
  const sourceId=(source.data as {id:string}).id;
  for(const [predicate,value] of [['memory_size_gb',11],['battery_mah',4000],['weight_kg',2.1]]){
   await call('create_claim',{entity_id:entityId,predicate,value,source_ids:[sourceId],valid_from:'2024-01-01',expected_revision:(await services.memory.get(entityId)).revision});
  }
  for(const bad of ['abc','0','-5','1.5']){
   const response=await fetch(`${base}/api/v1/claims/suspects?source=${sourceId}&limit=${bad}`);
   expect(response.status).toBe(400);
   const body=await response.json() as Json;
   expect(body.error).toMatchObject({code:'VALIDATION_ERROR'});
   expect((body.error as Json).message).toBe('limit must be a positive integer');
  }
  const one=await fetch(`${base}/api/v1/claims/suspects?source=${sourceId}&limit=1`);
  expect(one.status).toBe(200);
  expect(((await one.json()) as Json).count).toBe(1);
  const clamped=await fetch(`${base}/api/v1/claims/suspects?source=${sourceId}&limit=5000`);
  expect(clamped.status).toBe(200);
  expect(((await clamped.json()) as Json).count).toBe(3); // all candidates survive the 1000 clamp
  const absent=await fetch(`${base}/api/v1/claims/suspects?source=${sourceId}`);
  expect(absent.status).toBe(200);
  expect(((await absent.json()) as Json).count).toBe(3); // service default of 100 applies when limit is omitted
 });
});


describe('numeric limit params on REST search and external-files routes',()=>{
 it('rejects non-integer or non-positive search limits while keeping the default and the service clamp',async()=>{
  const {base,services}=await harness('memory-rest-parity-search-limit-');
  for(let i=0;i<201;i++) await services.memory.create({type:'note',title:`Clamp note ${i}`,content:`clamp marker ${i}`,metadata:{}});
  for(const bad of ['abc','0','-5','1.5','NaN','Infinity']){
   const response=await fetch(`${base}/api/v1/search?q=clamp&limit=${bad}`);
   expect(response.status).toBe(400);
   const body=await response.json() as Json;
   expect(body.error).toMatchObject({code:'VALIDATION_ERROR'});
   expect((body.error as Json).message).toBe('limit must be a positive integer');
  }
  const absent=await fetch(`${base}/api/v1/search?q=clamp`);
  expect(absent.status).toBe(200);
  expect(((await absent.json()) as unknown[]).length).toBe(20); // default 20 still applies when the param is omitted
  const limited=await fetch(`${base}/api/v1/search?q=clamp&limit=50`);
  expect(((await limited.json()) as unknown[]).length).toBe(50);
  const clamped=await fetch(`${base}/api/v1/search?q=clamp&limit=5000`);
  expect(clamped.status).toBe(200);
  expect(((await clamped.json()) as unknown[]).length).toBe(200); // service clamps to the MCP max of 200
 });

 it('rejects non-integer or non-positive max_content_chars while keeping the default and the 100000 clamp',async()=>{
  const {base,services}=await harness('memory-rest-parity-external-limit-');
  const relative='03 Knowledge/big-external.md';
  await mkdir(path.join(services.config.vault_root,'03 Knowledge'),{recursive:true});
  await writeFile(path.join(services.config.vault_root,relative),'x'.repeat(150000));
  for(const bad of ['abc','0','-5','1.5','NaN','Infinity']){
   const response=await fetch(`${base}/api/v1/external-files?include_content=true&max_content_chars=${bad}`);
   expect(response.status).toBe(400);
   const body=await response.json() as Json;
   expect(body.error).toMatchObject({code:'VALIDATION_ERROR'});
   expect((body.error as Json).message).toBe('max_content_chars must be a positive integer');
  }
  const read=async(query:string)=>{const response=await fetch(`${base}/api/v1/external-files?include_content=true${query}`);expect(response.status).toBe(200);return (await response.json()) as Array<{path:string;content:string;content_truncated:boolean}>;};
  const [defaultFile]=await read('') as Array<{path:string;content:string;content_truncated:boolean}>;
  expect(defaultFile!.path).toBe(relative);
  expect(defaultFile!.content.length).toBe(20000); // default 20000
  expect(defaultFile!.content_truncated).toBe(true);
  const [small]=await read('&max_content_chars=10');
  expect(small!.content.length).toBe(10);
  expect(small!.content_truncated).toBe(true);
  const [over]=await read('&max_content_chars=1000000');
  expect(over!.content.length).toBe(100000); // sane max clamp still applies
  expect(over!.content_truncated).toBe(true);
  const [exact]=await read('&max_content_chars=100000');
  expect(exact!.content.length).toBe(100000);
 });

 it('rejects invalid numeric limit params on the MCP tools with isError instead of coercing them',async()=>{
  const {client}=await harness('memory-rest-parity-mcp-limit-');
  const invalid:Array<[string,Json]>=[
   ['search_memory',{query:'anything',limit:0}],
   ['search_memory',{query:'anything',limit:-5}],
   ['search_memory',{query:'anything',limit:'abc'}],
   ['search_memory',{query:'anything',limit:1.5}],
   ['search_entities',{query:'anything',limit:201}],
   ['find_suspect_claims',{source_id:'whatever',limit:0}],
   ['find_suspect_claims',{source_id:'whatever',limit:'abc'}],
   ['find_suspect_claims',{source_id:'whatever',limit:-5}],
   ['scan_external_files',{include_content:true,max_content_chars:0}],
   ['scan_external_files',{include_content:true,max_content_chars:'abc'}],
   ['scan_external_files',{include_content:true,max_content_chars:100001}],
  ];
  for(const [name,args] of invalid){
   const result=await client.callTool({name,arguments:args});
   expect(result.isError).toBe(true);
  }
  const defaults=await client.callTool({name:'search_memory',arguments:{query:'anything'}}) as {isError?:boolean;structuredContent?:{data:{lexical:unknown[];neural:unknown}}};
  expect(defaults.isError).toBeUndefined();
  expect(Array.isArray(defaults.structuredContent?.data.lexical)).toBe(true);
  expect(defaults.structuredContent?.data.neural).toBeDefined();
  const atMax=await client.callTool({name:'search_memory',arguments:{query:'anything',limit:200}}) as {isError?:boolean};
  expect(atMax.isError).toBeUndefined();
  const scanDefault=await client.callTool({name:'scan_external_files',arguments:{}}) as {isError?:boolean};
  expect(scanDefault.isError).toBeUndefined();
  const suspectsDefault=await client.callTool({name:'find_suspect_claims',arguments:{source_id:'whatever'}}) as {isError?:boolean};
  expect(suspectsDefault.isError).toBeUndefined();
 });
});

function listen(app:ReturnType<typeof createHttpApp>):Promise<Server>{return new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});}
function close(server:Server):Promise<void>{return new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
