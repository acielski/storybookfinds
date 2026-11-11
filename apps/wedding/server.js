import express from 'express';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import {sqliteStore,supabaseStore} from './store.js';
import {mutatePlan} from './domain.js';
export const appRoot=dirname(fileURLToPath(import.meta.url));
export function configuration(env){
 const url=env.SUPABASE_URL?.trim(),key=env.SUPABASE_PUBLISHABLE_KEY?.trim();
 if(!url&&!key&&!env.VERCEL)return {mode:'local',environment:'development'};
 if(!url||!key)throw Error('Add SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY to this wedding app’s Vercel project, then redeploy.');
 let parsed;try{parsed=new URL(url);}catch{throw Error('Enter your Supabase HTTPS project URL.');}
 if(parsed.protocol!=='https:'||parsed.pathname!=='/'||parsed.username||parsed.password||parsed.search||parsed.hash)throw Error('Enter your Supabase HTTPS project URL without a path.');
 let role;try{role=JSON.parse(Buffer.from(key.split('.')[1]||'','base64url')).role;}catch{}
 if(key.startsWith('sb_secret_')||role==='service_role')throw Error('Use a Supabase publishable or anon key, never a privileged key.');
 return {mode:'supabase',url:parsed.origin,publishableKey:key,environment:env.APP_ENV==='development'?'development':'production'};
}
export async function createApp({env=process.env,store:provided,fetchImpl,apiOnly=false}={}){
 const app=express();let config,error;
 try{config=configuration(env);}catch(e){error=e;}
 const store=provided||(!error?(config.mode==='local'?sqliteStore(env.WEDDING_DB_PATH||resolve(appRoot,'data/wedding.sqlite')):supabaseStore({url:config.url,key:config.publishableKey},fetchImpl)):null);
 app.locals.store=store;app.disable('x-powered-by');
 app.use('/api',(req,res,next)=>{res.set('Cache-Control','no-store');next();});
 app.get('/api/config',(req,res)=>error?res.status(503).json({error:error.message}):res.json(config));
 app.use('/api',async(req,res,next)=>{try{if(error)throw Object.assign(error,{status:503});const token=config.mode==='supabase'?req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1]:null;if(config.mode==='supabase'&&!token)return res.status(401).json({error:'Please sign in to see your wedding plan.'});req.token=token;req.workspace=await store.load(token);if(!['owner','editor','viewer'].includes(req.workspace.role))throw Error('Invalid plan permissions.');next();}catch(e){next(e);}});
 app.get('/api/plan',(req,res)=>res.json(req.workspace));
 app.post('/api/mutate',express.json({limit:'128kb'}),async(req,res,next)=>{try{
  if(req.workspace.role==='viewer')return res.status(403).json({error:'This plan is view only. Ask the owner for editor access.'});
  if(!Number.isSafeInteger(req.body.version)||req.body.version!==req.workspace.version)return res.status(409).json({error:'Your plan changed in another window. Refresh and try again.'});
  const plan=mutatePlan(req.workspace.plan,req.body);const version=await store.save(req.token,req.body.version,plan);res.json({plan,version,role:req.workspace.role});
 }catch(e){next(e);}});
 app.use('/api',(req,res)=>res.status(404).json({error:'Not found.'}));
 if(!apiOnly){if(env.NODE_ENV==='production'){app.use(express.static(resolve(appRoot,'dist')));app.get('/{*path}',(req,res)=>res.sendFile(resolve(appRoot,'dist/index.html')));}else{const {createServer}=await import('vite');const vite=await createServer({root:appRoot,server:{middlewareMode:true,hmr:{port:24780}},appType:'spa'});app.use(vite.middlewares);app.locals.vite=vite;}}
 app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.status?e.message:'Something went wrong. Please refresh and try again.'}));return app;
}
