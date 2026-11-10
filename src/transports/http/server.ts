import type { Request, Response, NextFunction } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMemoryMcpServer } from '../mcp/server.js';
import type { Services } from '../../composition.js';
import { MemoryError } from '../../domain/errors.js';
import type { CorrectClaimInput } from '../../application/graph-service.js';

const loopback=(host:string)=>['127.0.0.1','localhost','::1'].includes(host);
export function createHttpApp(s:Services){
 const allowedOrigins=s.config.http.allowed_origins.map(o=>{try{return new URL(o).hostname;}catch{return o;}});
 const app=createMcpExpressApp({host:s.config.http.bind,...(allowedOrigins.length?{allowedOrigins}:{}) ,jsonLimit:'1mb'});
 const token=process.env[s.config.http.bearer_token_env];
 if(!loopback(s.config.http.bind)&&!token)throw new Error(`Non-loopback HTTP bind requires bearer token in ${s.config.http.bearer_token_env}`);
 const auth=(req:Request,res:Response,next:NextFunction)=>{if(!token)return next();if(req.headers.authorization!==`Bearer ${token}`){res.status(401).json({ok:false,error:{code:'AUTH_REQUIRED',message:'Valid bearer token required'}});return;}next();};
 app.get('/healthz',(_req,res)=>res.json({ok:true,name:s.config.name}));
 app.get('/readyz',async(_req,res)=>{try{await s.maintenance.inspect({kind:'vault'});res.json({ok:true});}catch(e){res.status(503).json({ok:false,error:String(e)});}});
 const mcp=createMcpHandler(()=>createMemoryMcpServer(s),{legacy:'stateless',responseMode:'auto',onerror:e=>process.stderr.write(`${e.message}\n`)});
 const nodeMcp=toNodeHandler(mcp);
 app.all('/mcp',auth,(req,res,next)=>{void nodeMcp(req,res,req.body).catch(next);});
 app.post('/api/v1/memory',auth,asyncRoute(async(req,res)=>res.status(201).json(await s.memory.create(req.body,req.header('x-client-id')))));
 app.get('/api/v1/memory/:id',auth,asyncRoute(async(req,res)=>res.json(await s.memory.get(String(req.params.id)))));
 app.get('/api/v1/search',auth,asyncRoute(async(req,res)=>{
  const limit=req.query.limit===undefined?undefined:Number(req.query.limit);
  if(limit!==undefined&&(!Number.isInteger(limit)||limit<=0))throw new MemoryError('VALIDATION_ERROR','limit must be a positive integer');
  res.json(await s.memory.search({query:String(req.query.q??''),types:typeof req.query.type==='string'?[req.query.type]:undefined,limit}));
 }));
 app.get('/api/v1/people/birthdays',auth,asyncRoute(async(req,res)=>res.json(await s.people.birthdays(String(req.query.from),String(req.query.to)))));
 app.post('/api/v1/reindex',auth,asyncRoute(async(_req,res)=>res.json(await s.maintenance.reindex())));
 app.get('/api/v1/external-files',auth,asyncRoute(async(req,res)=>{
  const maxContentChars=req.query.max_content_chars===undefined?undefined:Number(req.query.max_content_chars);
  if(maxContentChars!==undefined&&(!Number.isInteger(maxContentChars)||maxContentChars<=0))throw new MemoryError('VALIDATION_ERROR','max_content_chars must be a positive integer');
  res.json(await s.maintenance.externalFiles({kind:'vault'},req.query.include_content==='true',maxContentChars===undefined?20000:Math.min(maxContentChars,100000)));
 }));
 app.post('/api/v1/external-files/adoptions',auth,asyncRoute(async(req,res)=>res.status(201).json(await s.maintenance.prepare(`Adopt external Markdown file ${String(req.body.path)}`,[{kind:'adopt',path:String(req.body.path),expected_revision:String(req.body.expected_revision),draft:{type:String(req.body.entity_type),title:String(req.body.title),metadata:req.body.metadata??{}}}]))));
 app.post('/api/v1/changesets/:id/apply',auth,asyncRoute(async(req,res)=>res.json(await s.maintenance.apply(String(req.params.id),req.header('x-client-id')))));
 app.get('/api/v1/entities/:id/timeline',auth,asyncRoute(async(req,res)=>res.json(await s.graph.timeline({entity_id:String(req.params.id),as_of:typeof req.query.as_of==='string'?req.query.as_of:undefined}))));
 app.post('/api/v1/claims/:id/correct',auth,asyncRoute(async(req,res)=>{
  const body=req.body as Record<string,unknown>;
  if(typeof body.entity_id!=='string'||!body.entity_id)throw new MemoryError('VALIDATION_ERROR','entity_id is required to correct a claim');
  if(typeof body.expected_revision!=='string'||!body.expected_revision)throw new MemoryError('VALIDATION_ERROR','expected_revision is required to correct a claim');
  const input:CorrectClaimInput={value:body.value,reason:typeof body.reason==='string'?body.reason:''};
  if(typeof body.predicate==='string')input.predicate=body.predicate;
  if(Array.isArray(body.source_ids))input.source_ids=body.source_ids.map(String);
  if(typeof body.valid_from==='string')input.valid_from=body.valid_from;
  if(typeof body.confidence==='number')input.confidence=body.confidence;
  res.json(await s.graph.correctClaim(body.entity_id,String(req.params.id),input,body.expected_revision,req.header('x-client-id')||undefined));
 }));
 app.get('/api/v1/claims/suspects',auth,asyncRoute(async(req,res)=>{
  const limit=req.query.limit===undefined?undefined:Number(req.query.limit);
  if(limit!==undefined&&(!Number.isInteger(limit)||limit<=0))throw new MemoryError('VALIDATION_ERROR','limit must be a positive integer');
  res.json(await s.graph.findSuspectClaims({source_id:String(req.query.source??''),predicate:typeof req.query.predicate==='string'?req.query.predicate:undefined,entity_id:typeof req.query.entity==='string'?req.query.entity:undefined,limit}));
 }));
 app.use((error:unknown,_req:Request,res:Response,_next:NextFunction)=>{const known=error instanceof MemoryError;res.status(known?error.code==='NOT_FOUND'?404:error.code==='CONFLICT'?409:error.code==='READ_ONLY'?403:400:500).json({ok:false,error:{code:known?error.code:'INTERNAL_ERROR',message:error instanceof Error?error.message:String(error)}});});
 return app;
}
function asyncRoute(fn:(req:Request,res:Response)=>Promise<unknown>){return(req:Request,res:Response,next:NextFunction)=>{void fn(req,res).catch(next);};}
