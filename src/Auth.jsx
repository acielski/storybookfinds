import React,{createContext,useContext,useEffect,useState} from 'react';
import {createClient} from '@supabase/supabase-js';
import {Sparkles,LockKeyhole,ArrowRight,LogOut,Mail} from 'lucide-react';
import {setAuthClient} from './api.js';
const AuthContext=createContext(null);
export function Account(){
 const auth=useContext(AuthContext);
 if(!auth?.session)return null;
 return <button className="account-signout" onClick={async()=>{await auth.client.auth.signOut({scope:'local'});}} title={auth.session.user.email}><LogOut size={14}/> Sign out</button>;
}
export default function Auth({children}){
 const [client,setClient]=useState(null),[session,setSession]=useState(null),[loading,setLoading]=useState(true),[local,setLocal]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),[attempt,setAttempt]=useState(0);
 useEffect(()=>{
  let cancelled=false,subscription;
  setLoading(true);setError('');
  (async()=>{
   try{
    const response=await fetch('/api/config',{cache:'no-store'});const config=await response.json();
    if(!response.ok)throw Error(config.error||'Unable to load app settings.');
    if(cancelled)return;
    if(config.mode==='local'){setAuthClient(null);setLocal(true);setLoading(false);return;}
    const supabase=createClient(config.url,config.publishableKey,{auth:{detectSessionInUrl:false}});
    setAuthClient(supabase);setClient(supabase);
    subscription=supabase.auth.onAuthStateChange((_event,value)=>{if(!cancelled)setSession(value);}).data.subscription;
    const {data,error}=await supabase.auth.getSession();if(error)throw error;
    if(!cancelled){setSession(data.session);setLoading(false);}
   }catch(e){if(!cancelled){setError(e.message);setLoading(false);}}
  })();
  return()=>{cancelled=true;subscription?.unsubscribe();};
 },[attempt]);
 if(local)return children;
 if(session)return <AuthContext.Provider value={{client,session}}><React.Fragment key={session.user.id}>{children}</React.Fragment></AuthContext.Provider>;
 const signIn=async e=>{
  e.preventDefault();setBusy(true);setError('');
  const form=new FormData(e.target);
  try{const {error}=await client.auth.signInWithPassword({email:String(form.get('email')).trim(),password:String(form.get('password'))});if(error)throw error;}
  catch(e){setError(e.message);}finally{setBusy(false);}
 };
 return <div className="auth-page"><div className="auth-card"><span className="auth-pin"><Sparkles size={30}/></span><span className="eyebrow">YOUR SHOP’S LITTLE SECRET</span><h1>Welcome to<br/><em>Storybook Finds.</em></h1><p>A cozy corner for your pin business.<br/>Your numbers, just for you.</p>{loading?<div className="auth-loading" role="status">Opening your storybook…</div>:<>{error&&<div className="error" role="alert">{error}</div>}{client?<form onSubmit={signIn}><label><span><Mail size={13}/> Email address</span><input name="email" type="email" autoComplete="username" required autoFocus placeholder="you@example.com"/></label><label><span><LockKeyhole size={13}/> Password</span><input name="password" type="password" autoComplete="current-password" required placeholder="Your password"/></label><button className="button primary" disabled={busy}>{busy?'Signing in…':'Open my shop'}<ArrowRight size={15}/></button><p className="auth-help">Use the account created in Supabase Authentication. Need a password reset? Ask your shop administrator.</p></form>:<button className="button secondary" onClick={()=>setAttempt(n=>n+1)}>Try again</button>}</>}<span className="auth-footer">✧ A collection of little wins ✧</span></div></div>;
}
