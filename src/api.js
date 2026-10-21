let authClient=null;
export function setAuthClient(client){authClient=client;}
export async function apiFetch(path,options={}){
 const headers=new Headers(options.headers);
 if(authClient){
  const {data,error}=await authClient.auth.getSession();
  if(error||!data.session)throw Error('Please sign in again.');
  headers.set('Authorization','Bearer '+data.session.access_token);
 }
 return fetch(path,{...options,headers});
}
export async function importFiles(files,type,onProgress=()=>{}){
 const results=[];
 // Vercel's request limit is 4.5 MB: send one <=2 MB CSV per request.
 for(let index=0;index<files.length;index++){
  const file=files[index];onProgress(index+1,files.length);
  try{
   const form=new FormData();form.set('type',type);form.append('file',file);
   const response=await apiFetch('/api/import',{method:'POST',body:form});
   const result=await response.json();
   if(!response.ok)throw Error(result.error||'Import failed.');
   results.push({filename:file.name,status:'success',...result});
  }catch(error){results.push({filename:file.name,status:'error',error:error.message,imported:0,skipped:0,updated:0});}
 }
 return {results,totals:results.reduce((sum,file)=>({imported:sum.imported+file.imported,skipped:sum.skipped+file.skipped,updated:sum.updated+file.updated,failed:sum.failed+(file.status==='error'?1:0)}),{imported:0,skipped:0,updated:0,failed:0})};
}
