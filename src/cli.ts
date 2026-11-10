#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig } from './config/schema.js';
import { compose } from './composition.js';
import { createMemoryMcpServer } from './transports/mcp/server.js';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createHttpApp } from './transports/http/server.js';

const program=new Command().name('universal-memory-mcp').option('-c, --config <path>','configuration file',process.env.MEMORY_CONFIG??'config.yml');
program.command('serve').description('Serve configured MCP transport and REST API when using HTTP').action(async()=>{
 const config=await loadConfig(program.opts<{config:string}>().config);const services=await compose(config);
 if(config.transport==='stdio'){serveStdio(()=>createMemoryMcpServer(services),{legacy:'serve',onerror:e=>process.stderr.write(`${e.stack??e.message}\n`)});return;}
 const app=createHttpApp(services);app.listen(config.http.port,config.http.bind,()=>{
  process.stderr.write(`${config.name} listening on http://${config.http.bind}:${config.http.port}\n`);
  void services.maintenance.reindex().catch(error=>process.stderr.write(`Initial reindex failed: ${error instanceof Error?error.stack??error.message:String(error)}\n`));
 });
});
program.command('inspect').description('Read-only vault inspection report').action(async()=>{const config=await loadConfig(program.opts<{config:string}>().config);const services=await compose({...config,read_only:true});console.log(JSON.stringify(await services.maintenance.inspect({kind:'vault'}),null,2));});
program.command('reindex').description('Rebuild disposable index from Markdown').action(async()=>{const config=await loadConfig(program.opts<{config:string}>().config);const services=await compose(config);console.log(JSON.stringify(await services.maintenance.reindex(),null,2));});
program.command('import-chatgpt')
 .description('Import a ChatGPT export (.zip or conversations.json) as dedup-aware source entities')
 .argument('<path>','export file: .zip archive or plain conversations.json')
 .option('--dry-run','parse and print a JSON summary without writing anything')
 .action(async(opts:{dryRun?:boolean},args:{path:string})=>{
  const config=await loadConfig(program.opts<{config:string}>().config);
  const { parseChatGptExport }=await import('./domain/chatgpt-export.js');
  const conversations=await parseChatGptExport(args.path);
  if(opts.dryRun){console.log(JSON.stringify({file:args.path,conversation_count:conversations.length,conversations:conversations.map(c=>({id:c.id,title:c.title,created:c.createdUtc,updated:c.updatedUtc,message_count:c.messages.length}))},null,2));return;}
  const services=await compose(config);
  const { importChatGptExport }=await import('./application/chatgpt-import.js');
  console.log(JSON.stringify(await importChatGptExport(services.memory,args.path),null,2));
 });
program.command('phase3')
 .description('Phase-3 deterministic migration runner (relations/claims/sources)')
 .option('-s, --stage <stage>','migration stage to run','relations')
 .option('-m, --mode <mode>','preflight | dry-run | apply | validate | rollback','dry-run')
 .option('--migration-time <iso>','pinned ISO timestamp for deterministic re-application',new Date().toISOString())
 .option('--baseline-manifest <path>','baseline manifest file for preflight comparison')
 .option('--audit-path <path>','current audit events.jsonl path')
 .option('--baseline-audit <path>','Phase-2 audit snapshot for preflight comparison')
 .option('--expected-count <n>','expected vault file count','661')
 .option('--limit <n>','cap the batch to the first N ops')
 .option('--preview <path>','approved Phase-3B preview (migration-preview.json) — mandatory for stage claims: the preview is the only claim authorization source')
 .option('--out <path>','report output file (JSON)')
 .action(async(opts:{stage:string;mode:string;migrationTime:string;baselineManifest?:string;auditPath?:string;baselineAudit?:string;expectedCount:string;limit?:string;preview?:string;out?:string})=>{
  const { writeFile }=await import('node:fs/promises');
  const path=await import('node:path');
  const { planStage, applyStage, rollbackStage, validateStage, preflight }=await import('./migration/phase3.js');
  const root=program.opts<{config:string}>().config;
  const configDir=path.default.dirname(path.default.resolve(root));
  const config=await loadConfig(root);
  const stage=(opts.stage as 'relations'|'claims'|'sources');
  // Phase-3B guard: stage claims runs ONLY from the approved preview
  // (dry-run+apply+validate+rollback all key off the same ledger anyway). The
  // generic vault scan (planClaims) must never be the authorization mechanism.
  if(stage==='claims'&&!opts.preview){process.stderr.write("stage 'claims' requires --preview (approved migration-preview.json): the generic planner must not authorize claim migration (Phase-3B §4)\n");process.exitCode=1;return;}
  const ledgerPath=path.default.resolve(configDir,config.audit_dir,'migration-ledger.jsonl');
  const { MigrationLedger }=await import('./adapters/migration/migration-ledger.js');
  const opts3={ stage, migrationTime:opts.migrationTime, ledger:new MigrationLedger(ledgerPath), limit:opts.limit?Number(opts.limit):undefined, previewPath:opts.preview?path.default.resolve(opts.preview):undefined };
  if(opts.mode==='dry-run'||opts.mode==='preflight'){
   // Read-only modes run against a read-only compose — nothing can be written.
   const services=await compose({...config,read_only:true});
   const plan=await planStage(services,opts3);
   if(opts.mode==='dry-run'){
    const second=await planStage(services,opts3);
    const output={ ...plan, deterministic:plan.planned_hash===second.planned_hash };
    if(!output.deterministic) process.exitCode=2;
    const text=JSON.stringify(output,null,2);
    console.log(text);
    if(opts.out){await writeFile(opts.out,text).catch(()=>undefined);}
    return;
   }
   const result=await preflight(services,opts3,{
    baselineManifest:opts.baselineManifest?path.default.resolve(opts.baselineManifest):undefined,
    auditPath:opts.auditPath?path.default.resolve(opts.auditPath):undefined,
    baselineAudit:opts.baselineAudit?path.default.resolve(opts.baselineAudit):undefined,
    expected_count:opts.expectedCount===undefined?undefined:Number(opts.expectedCount),
   });
   if(!result.ok) process.exitCode=2;
   const text=JSON.stringify(result,null,2);
   console.log(text);
   if(opts.out){await writeFile(opts.out,text).catch(()=>undefined);}
   return;
  }
  const services=await compose(config);
  if(opts.mode==='apply'){
   const { plan,result }=await applyStage(services,opts3,false);
   if(result?.failed) process.exitCode=2;
   const text=JSON.stringify({ plan,result },null,2);
   console.log(text);
   if(opts.out){await writeFile(opts.out,text).catch(()=>undefined);}
   return;
  }
  if(opts.mode==='rollback'){
   const result=await rollbackStage(services,opts3);
   if(result.errors.length||result.rolled_back!==result.attempted) process.exitCode=2;
   const text=JSON.stringify(result,null,2);
   console.log(text);
   if(opts.out){await writeFile(opts.out,text).catch(()=>undefined);}
   return;
  }
  if(opts.mode==='validate'){
   const result=await validateStage(services,opts3);
   const text=JSON.stringify(result,null,2);
   console.log(text);
   if(opts.out){await writeFile(opts.out,text).catch(()=>undefined);}
   return;
  }
  process.stderr.write(`unknown mode: ${opts.mode}\n`);process.exitCode=1;
 });
await program.parseAsync();
