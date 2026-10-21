import {test} from 'node:test';
import assert from 'node:assert/strict';
import {usernameSignIn} from '../username-auth.js';
import {createRuntimeApp} from '../cloud.js';
const env={VERCEL:'1',SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test',SHOP_USERNAME:'StorybookFinds',SHOP_LOGIN_EMAIL:'private-owner@example.com'};
const config={url:env.SUPABASE_URL,key:env.SUPABASE_PUBLISHABLE_KEY};
async function invoke(body,options={}){
 let status=200,result;
 const response={status(code){status=code;return this;},json(value){result=value;return this;}};
 await usernameSignIn({env,config,...options})({body},response);
 return {status,result};
}
test('username resolves privately and Supabase verifies the existing password',async()=>{
 const calls=[];
 const result=await invoke({username:'  STORYBOOKFINDS ',password:'test-password'},{fetchImpl:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({access_token:'test-access',refresh_token:'test-refresh',user:{email:env.SHOP_LOGIN_EMAIL}}));}});
 assert.equal(result.status,200);assert.deepEqual(result.result,{access_token:'test-access',refresh_token:'test-refresh'});
 assert.equal(calls[0].url,config.url+'/auth/v1/token?grant_type=password');assert.deepEqual(JSON.parse(calls[0].options.body),{email:env.SHOP_LOGIN_EMAIL,password:'test-password'});assert.equal(calls[0].options.headers.apikey,config.key);
 assert.ok(!JSON.stringify(result.result).includes(env.SHOP_LOGIN_EMAIL));
});
test('invalid usernames, missing passwords and wrong passwords receive generic errors',async()=>{
 for(const body of [{username:'someoneelse',password:'bad'},{username:'storybookfinds',password:''},{}]){
  const result=await invoke(body,{fetchImpl:()=>{throw Error('Must not call provider');}});assert.equal(result.status,401);assert.deepEqual(result.result,{error:'Invalid username or password.'});
 }
 const wrong=await invoke({username:'storybookfinds',password:'bad'},{fetchImpl:async()=>new Response(JSON.stringify({error:'Provider details must not leak'}),{status:400})});assert.equal(wrong.status,401);assert.equal(wrong.result.error,'Invalid username or password.');
});
test('provider rate limits, failures and missing username setup are handled without leaking credentials',async()=>{
 const body={username:'storybookfinds',password:'secret-test-password'};
 const rate=await invoke(body,{fetchImpl:async()=>new Response('',{status:429})});assert.equal(rate.status,429);
 const down=await invoke(body,{fetchImpl:async()=>{throw Error('private-provider-details');}});assert.equal(down.status,503);assert.ok(!JSON.stringify(down).includes('private-provider-details'));
 const missing=await invoke(body,{env:{}});assert.equal(missing.status,503);assert.match(missing.result.error,/use your email/);
 const malformed=await invoke(body,{fetchImpl:async()=>new Response('{}')});assert.equal(malformed.status,503);
});
test('public config omits the email alias; username endpoint is available before sign-in without opening shop data',async()=>{
 const app=await createRuntimeApp({env,apiOnly:true,fetchImpl:async()=>new Response(JSON.stringify({access_token:'access',refresh_token:'refresh'}))});
 const server=app.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
 const base='http://127.0.0.1:'+server.address().port;
 try{
  const publicConfig=await(await fetch(base+'/api/config')).text();assert.ok(!publicConfig.includes(env.SHOP_LOGIN_EMAIL));assert.ok(!publicConfig.includes(env.SHOP_USERNAME));
  const response=await fetch(base+'/api/auth/username',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'storybookfinds',password:'test-password'})});assert.equal(response.status,200);assert.deepEqual(await response.json(),{access_token:'access',refresh_token:'refresh'});
  assert.equal((await fetch(base+'/api/transactions')).status,401);
  const malformed=await fetch(base+'/api/auth/username',{method:'POST',headers:{'Content-Type':'application/json'},body:'{bad'});assert.equal(malformed.status,400);assert.ok((await malformed.json()).error);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
