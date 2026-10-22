import express from 'express';
import {resolve} from 'node:path';
import {createApp} from './server.js';
import {exportWorkspace} from './workspace.js';
import {usernameSignIn} from './username-auth.js';

function failure(message,status=503){return Object.assign(new Error(message),{status});}
export function cloudConfig(env=process.env){
 const url=env.SUPABASE_URL?.trim(),key=env.SUPABASE_PUBLISHABLE_KEY?.trim();
 if(!url&&!key&&!env.VERCEL)return null;
 if(!url||!key)throw failure('Supabase is not configured. Add SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in Vercel Settings → Environment Variables, then redeploy.');
 let parsed;try{parsed=new URL(url);}catch{throw failure('SUPABASE_URL must be your HTTPS project URL.');}
 if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash)throw failure('SUPABASE_URL must be your HTTPS project URL without a path.');
 let role;try{role=JSON.parse(Buffer.from(key.split('.')[1]||'','base64url').toString()).role;}catch{}
 if(key.startsWith('sb_secret_')||role==='service_role')throw failure('Use the Supabase publishable (or legacy anon) key, never a secret or service-role key.');
 if(env.VERCEL_ENV==='preview'&&env.APP_ENV!=='development')throw failure('Preview deployments need a separate development database. Configure the development environment before using this preview.');
 if(env.APP_ENV==='development'&&!env.PRODUCTION_SUPABASE_URL)throw failure('Set PRODUCTION_SUPABASE_URL in the development project so it can verify database separation.');
 if(env.APP_ENV==='development'&&env.PRODUCTION_SUPABASE_URL){
  let production;try{production=new URL(env.PRODUCTION_SUPABASE_URL).origin;}catch{throw failure('Check the production database URL guard in the development project.');}
  if(parsed.origin===production)throw failure('Development is pointing at the production database. Set SUPABASE_URL to the separate development Supabase project.');
 }
 return {url:parsed.origin,key};
}
export function supabaseGateway(config,fetchImpl=fetch){
 async function request(path,token,options={}){
  let response;
  try{response=await fetchImpl(config.url+path,{...options,headers:{apikey:config.key,Authorization:'Bearer '+token,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(15000)});}catch{throw failure('Cannot reach Supabase. Please try again.');}
  if(!response.ok){
   if(response.status===401)throw failure('Your session expired. Please sign in again.',401);
   if(response.status===403)throw failure('Your account cannot access this workspace.',403);
   throw failure('Supabase could not save or load your data. Check that the SQL setup has been run, then try again.');
  }
  return response.status===204?null:response.json();
 }
 return {
  async load(token){
   const user=await request('/auth/v1/user',token);
   if(!user?.id)throw failure('Please sign in again.',401);
   const context=await request('/rest/v1/rpc/workspace_context',token,{method:'POST',body:'{}'});
   if(!context?.ownerId||!['owner','editor','viewer'].includes(context.role))throw failure('Check that the shared workspace SQL setup has been run.');
   const rows=await request('/rest/v1/workspaces?select=version,state&owner_id=eq.'+encodeURIComponent(context.ownerId),token);
   if(!Array.isArray(rows))throw failure('Unexpected Supabase response.');
   return {version:rows[0]?.version||0,state:rows[0]?.state||null,role:context.role};
  },
  async save(token,version,state){
   const saved=await request('/rest/v1/rpc/save_workspace',token,{method:'POST',body:JSON.stringify({expected_version:version,new_state:state})});
   if(!Number.isInteger(saved))throw failure('Your data changed in another tab. Retry this action; CSV duplicates will be skipped.',409);
   return saved;
  }
 };
}
export async function createRuntimeApp({env=process.env,gateway,fetchImpl,apiOnly=false}={}){
 let config,configurationError;
 try{config=cloudConfig(env);}catch(error){configurationError=error;}
 if(!config&&!configurationError){
  const local=await createApp(env.DB_PATH||'data/ledger.sqlite',{apiOnly:true});
  const app=express();
  app.get('/api/config',(req,res)=>res.set('Cache-Control','no-store').json({mode:'local',environment:'development'}));
  app.get('/api/session',(req,res)=>res.set('Cache-Control','no-store').json({role:'owner'}));
  app.use(local);
  if(!apiOnly)await attachFrontend(app,env);
  app.locals.db=local.locals.db;
  return app;
 }
 const app=express(),store=gateway||(config?supabaseGateway(config,fetchImpl):null);
 app.use('/api',(req,res,next)=>{res.set('Cache-Control','no-store');next();});
 app.get('/api/config',(req,res)=>configurationError?res.status(503).json({error:configurationError.message}):res.json({mode:'supabase',url:config.url,publishableKey:config.key,environment:env.APP_ENV==='development'?'development':'production'}));
 app.post('/api/auth/username',express.json({limit:'4kb'}),(req,res,next)=>{
  if(configurationError)return res.status(503).json({error:configurationError.message});
  return usernameSignIn({env,config,fetchImpl})(req,res,next);
 });
 app.use(async(req,res,next)=>{
  if(!req.path.startsWith('/api/'))return next();
  try{
   if(configurationError)throw configurationError;
   const token=req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
   if(!token)throw failure('Please sign in to access your shop.',401);
   const workspace=await store.load(token);let version=workspace.version;
   const role=workspace.role||'owner';
   if(req.path==='/api/session'&&req.method==='GET')return res.json({role});
   if(role==='viewer'&&!['GET','HEAD'].includes(req.method))throw failure('This account has view-only access. Ask the shop owner for editor access to make changes.',403);
   const dataApi=await createApp(':memory:',{apiOnly:true,state:workspace.state,persist:async db=>{version=await store.save(token,version,exportWorkspace(db));}});
   let closed=false;const close=()=>{if(!closed){closed=true;dataApi.locals.db.close();}};
   res.once('finish',close);res.once('close',close);
   dataApi(req,res,next);
  }catch(error){res.status(error.status||503).json({error:error.message});}
 });
 if(!apiOnly)await attachFrontend(app,env);
 app.use((error,req,res,next)=>res.status(error.status||500).json({error:'Unable to process the request. Please try again.'}));
 return app;
}
async function attachFrontend(app,env){
 if(env.NODE_ENV==='production'){
  app.use(express.static('dist'));
  app.get('/{*path}',(req,res)=>res.sendFile(resolve('dist/index.html')));
 }else{
  const {createServer}=await import('vite');
  const vite=await createServer({server:{middlewareMode:true},appType:'spa'});
  app.use(vite.middlewares);app.locals.vite=vite;
 }
}
