import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { compose } from '../src/composition.js';
import { createHttpApp } from '../src/transports/http/server.js';
import type { AppConfig } from '../src/config/schema.js';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});

describe('HTTP and MCP transports',()=>{
 it('serves health, REST and MCP tool discovery/calls over Streamable HTTP',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'memory-transport-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'vault'));
  const config:AppConfig={name:'Transport Test',vault_root:path.join(root,'vault'),read_only:false,audit_dir:path.join(root,'audit'),transport:'http',toolset:'full',tool_discovery:'eager',response:'full',http:{bind:'127.0.0.1',port:3333,allowed_origins:[],bearer_token_env:'UNSET_TEST_TOKEN'},routing:{memory:{backend:'markdown',path:'Memory/{slug}.md'},note:{backend:'markdown',path:'Notes/{slug}.md'},person:{backend:'markdown',path:'People/{slug}.md'},project:{backend:'markdown',path:'Projects/{slug}/index.md'},inbox:{backend:'markdown',path:'Inbox/{slug}.md'}}};
  const services=await compose(config);const app=createHttpApp(services);const http=await listen(app);cleanup.push(()=>close(http));const address=http.address();if(!address||typeof address==='string')throw new Error('No TCP address');const base=`http://127.0.0.1:${address.port}`;
  expect((await fetch(`${base}/healthz`)).status).toBe(200);
  expect((await fetch(`${base}/api/v1/memory`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'note',title:'REST note',content:'created over HTTP'})})).status).toBe(201);
  const client=new Client({name:'test-client',version:'1.0.0'},{versionNegotiation:{mode:'auto'}});cleanup.push(()=>client.close());await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const listed=await client.listTools();expect(listed.tools.map(t=>t.name)).toEqual(expect.arrayContaining(['remember','people','projects','apply_changeset','reindex']));
  const called=await client.callTool({name:'reindex',arguments:{}});expect(called.isError).not.toBe(true);expect(called.structuredContent).toMatchObject({ok:true,data:{indexed:1}});
 });
 it('exposes get_entity_timeline as a read tool that separates planned, present, and past claims',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'memory-transport-timeline-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'vault'));
  const config:AppConfig={name:'Transport Timeline Test',vault_root:path.join(root,'vault'),read_only:false,audit_dir:path.join(root,'audit'),transport:'http',toolset:'full',tool_discovery:'eager',response:'full',http:{bind:'127.0.0.1',port:3333,allowed_origins:[],bearer_token_env:'UNSET_TEST_TOKEN'},routing:{memory:{backend:'markdown',path:'Memory/{slug}.md'},note:{backend:'markdown',path:'Notes/{slug}.md'},person:{backend:'markdown',path:'People/{slug}.md'},project:{backend:'markdown',path:'Projects/{slug}/index.md'},inbox:{backend:'markdown',path:'Inbox/{slug}.md'}}};
  const services=await compose(config);const app=createHttpApp(services);const http=await listen(app);cleanup.push(()=>close(http));const address=http.address();if(!address||typeof address==='string')throw new Error('No TCP address');const base=`http://127.0.0.1:${address.port}`;
  const created=await (await fetch(`${base}/api/v1/memory`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'note',title:'Timeline via MCP'})})).json() as {metadata:{id:string};revision:string};
  const client=new Client({name:'test-client',version:'1.0.0'},{versionNegotiation:{mode:'auto'}});cleanup.push(()=>client.close());await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  expect((await client.listTools()).tools.map(t=>t.name)).toContain('get_entity_timeline');
  const claim=await client.callTool({name:'create_claim',arguments:{entity_id:created.metadata.id,predicate:'upgrade',value:'RTX 4090',valid_from:'2027-01-01',expected_revision:created.revision}}) as {isError?:boolean;structuredContent?:{ok:boolean;data:{claim:{id:string}}}};
  expect(claim.isError).not.toBe(true);expect(claim.structuredContent?.ok).toBe(true);
  const timeline=await client.callTool({name:'get_entity_timeline',arguments:{entity_id:created.metadata.id,as_of:'2026-10-09'}}) as {isError?:boolean;structuredContent?:{ok:boolean;data:{counts:{past:number;present:number;planned:number;errors:number};planned:Array<{id:string}>;present:Array<{id:string}>;errors:Array<{id:string}>}}};
  expect(timeline.isError).not.toBe(true);
  expect(timeline.structuredContent?.data.counts).toEqual({past:0,present:0,planned:1,errors:0});
  expect(timeline.structuredContent?.data.planned.map(c=>c.id)).toEqual([claim.structuredContent?.data.claim.id]);
  expect(timeline.structuredContent?.data.present).toEqual([]);
  const bad=await client.callTool({name:'get_entity_timeline',arguments:{entity_id:created.metadata.id,as_of:'not-a-date'}});
  expect(bad.isError).toBe(true);
 });
 it('exposes correct_claim and find_suspect_claims, keeping the erroneous claim in the record',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'memory-transport-correction-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'vault'));
  const config:AppConfig={name:'Transport Correction Test',vault_root:path.join(root,'vault'),read_only:false,audit_dir:path.join(root,'audit'),transport:'http',toolset:'full',tool_discovery:'eager',response:'full',http:{bind:'127.0.0.1',port:3333,allowed_origins:[],bearer_token_env:'UNSET_TEST_TOKEN'},routing:{memory:{backend:'markdown',path:'Memory/{slug}.md'},note:{backend:'markdown',path:'Notes/{slug}.md'},person:{backend:'markdown',path:'People/{slug}.md'},project:{backend:'markdown',path:'Projects/{slug}/index.md'},inbox:{backend:'markdown',path:'Inbox/{slug}.md'},source:{backend:'markdown',path:'Sources/{provider}/{date}-{slug}.md'}}};
  const services=await compose(config);const app=createHttpApp(services);const http=await listen(app);cleanup.push(()=>close(http));const address=http.address();if(!address||typeof address==='string')throw new Error('No TCP address');const base=`http://127.0.0.1:${address.port}`;
  const created=await (await fetch(`${base}/api/v1/memory`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'note',title:'Correction via MCP'})})).json() as {metadata:{id:string};revision:string};
  const client=new Client({name:'test-client',version:'1.0.0'},{versionNegotiation:{mode:'auto'}});cleanup.push(()=>client.close());await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const tools=await client.listTools();const names=tools.tools.map(t=>t.name);
  expect(names).toContain('correct_claim');expect(names).toContain('find_suspect_claims');
  expect(tools.tools.find(t=>t.name==='correct_claim')?.description).toMatch('wrong from the start');
  expect(tools.tools.find(t=>t.name==='find_suspect_claims')?.description).toMatch('never writes');
  const source=await client.callTool({name:'create_source',arguments:{title:'Spec Sheet',provider:'chatgpt',conversation_id:'spec-conv-1',message_range:null}}) as {structuredContent?:{data:{id:string}}};
  const claim=await client.callTool({name:'create_claim',arguments:{entity_id:created.metadata.id,predicate:'memory_size_gb',value:11,source_ids:[source.structuredContent?.data.id],expected_revision:created.revision}}) as {structuredContent?:{data:{claim:{id:string}}}};
  const current=(await services.memory.get(created.metadata.id)).revision;
  const correction=await client.callTool({name:'correct_claim',arguments:{entity_id:created.metadata.id,claim_id:claim.structuredContent?.data.claim.id,value:24,reason:'transcribed from the wrong spec sheet',expected_revision:current}}) as {isError?:boolean;structuredContent?:{ok:boolean;data:{original:{id:string;status:string;error_reason:string;corrected_by:string;valid_to:string|null};corrected:{id:string;corrects:string;status:string}}}};
  expect(correction.isError).not.toBe(true);expect(correction.structuredContent?.ok).toBe(true);
  expect(correction.structuredContent?.data.original.status).toBe('recorded_in_error');
  expect(correction.structuredContent?.data.original.error_reason).toBe('transcribed from the wrong spec sheet');
  expect(correction.structuredContent?.data.original.valid_to).toBeNull(); // no invented close date
  expect(correction.structuredContent?.data.corrected.corrects).toBe(claim.structuredContent?.data.claim.id);
  const suspects=await client.callTool({name:'find_suspect_claims',arguments:{source_id:source.structuredContent?.data.id,predicate:'memory_size_gb'}}) as {isError?:boolean;structuredContent?:{ok:boolean;data:{source_id:string;predicate:string|null;count:number;candidates:Array<{id:string;reason:string}>}}};
  expect(suspects.isError).not.toBe(true);
  expect(suspects.structuredContent?.data.count).toBe(1); // the correction shares the provenance; the erroneous claim is never a suspect
  expect(suspects.structuredContent?.data.candidates[0]?.reason).toBe('same source and predicate as a claim recorded in error');
  const bad=await client.callTool({name:'find_suspect_claims',arguments:{source_id:''}});
  expect(bad.isError).toBe(true);
 });
});

function listen(app:ReturnType<typeof createHttpApp>):Promise<Server>{return new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});}
function close(server:Server):Promise<void>{return new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
