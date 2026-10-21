// A private username alias for this shop's existing Supabase account.
// Supabase still verifies the password and issues the session. No admin key is used.
export function usernameSignIn({env,config,fetchImpl=fetch}){
  return async(req,res)=>{
    const username=env.SHOP_USERNAME?.trim().toLowerCase();
    const email=env.SHOP_LOGIN_EMAIL?.trim();
    if(!username||!email)return res.status(503).json({error:'Username sign-in is not set up yet. Please use your email address for now.'});
    const identifier=typeof req.body?.username==='string'?req.body.username.trim().toLowerCase():'';
    const password=typeof req.body?.password==='string'?req.body.password:'';
    const invalid=()=>res.status(401).json({error:'Invalid username or password.'});
    if(identifier!==username||!password||password.length>1024)return invalid();
    try{
      const response=await fetchImpl(config.url+'/auth/v1/token?grant_type=password',{
        method:'POST',headers:{apikey:config.key,'Content-Type':'application/json'},
        body:JSON.stringify({email,password}),signal:AbortSignal.timeout(15000),
      });
      if(response.status===429)return res.status(429).json({error:'Too many sign-in attempts. Please wait a few minutes and try again.'});
      if([400,401,403,422].includes(response.status))return invalid();
      if(!response.ok)throw Error('Authentication unavailable');
      const session=await response.json();
      if(typeof session.access_token!=='string'||typeof session.refresh_token!=='string')throw Error('Invalid session');
      res.json({access_token:session.access_token,refresh_token:session.refresh_token});
    }catch{
      res.status(503).json({error:'Cannot sign in right now. Please try again.'});
    }
  };
}
