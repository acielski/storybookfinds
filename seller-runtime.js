import express from 'express';
import {PDFDocument} from 'pdf-lib';
import {createSellerClient} from './seller-client.js';
import {createLocalSellerStore,createSupabaseSellerStore} from './seller-store.js';
import {createSellerRouter} from './seller-service.js';
import {parseSellerReport} from './whatnot.js';

const fail=(message,status=503)=>Object.assign(new Error(message),{status,publicMessage:message});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sellerBinding(env,{ownerId,cloud=false}={}){
  const configured=Boolean(env.WHATNOT_API_TOKEN?.trim());
  if(!configured)return false;
  if(!env.WHATNOT_SELLER_ID?.trim())throw fail('Add WHATNOT_SELLER_ID in the server environment, then redeploy.');
  if(cloud){
    if(!uuid.test(env.WHATNOT_WORKSPACE_OWNER_ID||''))throw fail('Add the shop owner’s Supabase user ID as WHATNOT_WORKSPACE_OWNER_ID, then redeploy.');
    if(ownerId!==env.WHATNOT_WORKSPACE_OWNER_ID)throw fail('The Whatnot connection belongs to a different shop workspace.',403);
  }
  return true;
}

// Validate the account behind a rotated token before any seller operation. The
// promise lives for one HTTP request, never as a durable account assumption.
export function verifiedSellerClient(client,sellerId){
  let verified;
  const check=()=>verified ||= client.request('GET','/users/me').then(user=>{
    if(String(user?.id)!==String(sellerId))throw fail('This Whatnot token belongs to a different seller. Check WHATNOT_SELLER_ID and the token.',403);
    return user;
  });
  return {
    async request(method,path,body){const user=await check();return method==='GET'&&path==='/users/me'?user:client.request(method,path,body);},
    async page(path,cursor){await check();return client.page(path,cursor);},
    async downloadReport(url){await check();return client.downloadReport(url);},
  };
}

export function createShopFactory({env=process.env,role='owner',ownerId,token,config,fetchImpl,clientFactory=createSellerClient,storeFactory}={}){
  return ({db,whatnot,save,persist})=>{
    const router=express.Router();
    // Initialize only for shop routes. An optional integration configuration
    // error must not interrupt the existing expense and financial workspace.
    router.use(async(req,res,next)=>{
      try{
        const configured=sellerBinding(env,{ownerId,cloud:Boolean(config)});
        const store=storeFactory?storeFactory():config?createSupabaseSellerStore({config,token,ownerId,fetchImpl}):createLocalSellerStore(db);
        const client=configured?verifiedSellerClient(clientFactory({token:env.WHATNOT_API_TOKEN.trim(),fetchImpl}),env.WHATNOT_SELLER_ID):null;
        const operations=createSellerRouter({store,client,env,role,ownerId,importFinancialReport:async(buffer,filename,reportType)=>{
          const parsed=parseSellerReport(buffer,reportType);
          const result=whatnot.importReport(parsed,filename,save);
          await persist();
          return result;
        }});
        const print=express.Router();
        print.post('/labels/print',async(req,res,next)=>{
          try{
            if(role==='viewer')throw fail('Ask a shop editor to print shipping labels.',403);
            if(!client)throw fail('Connect Whatnot before printing shipping labels.');
            const ids=req.body?.shipmentIds;
            if(!Array.isArray(ids)||!ids.length||ids.length>20||ids.some(id=>typeof id!=='string'||!id||id.length>200)||new Set(ids).size!==ids.length)throw fail('Select between 1 and 20 different shipments to print.',400);
            const output=await PDFDocument.create(),deadline=Date.now()+45000;
            for(const id of ids){
              if(Date.now()>deadline)throw fail('This print batch is taking too long. Select fewer shipments and try again.',504);
              const shipment=await client.request('GET','/shipments/'+encodeURIComponent(id));
              if(String(shipment?.id)!==id||shipment.fulfillment_method!=='shipping'||shipment.replacement_shipment_id||String(shipment.status).startsWith('cancelled'))throw fail('A selected shipment was replaced, cancelled, or is a pickup. Refresh the shipping queue.',409);
              if(!shipment.documents?.label_url)throw fail('A selected label is not ready or customer-document permission is missing. Refresh the shipment or check Whatnot permissions.',409);
              const bytes=await client.downloadReport(shipment.documents.label_url);
              let source;try{source=await PDFDocument.load(bytes);}catch{throw fail('Whatnot returned a label that could not be opened as a PDF.',502);}
              for(const page of source.getPages()){
                const {width,height}=page.getSize();
                if(!((Math.abs(width-288)<4&&Math.abs(height-432)<4)||(Math.abs(width-432)<4&&Math.abs(height-288)<4)))throw fail('This label is not 4 × 6 inches. Update the label size in Whatnot Seller Hub before generating labels.',409);
              }
              for(const page of await output.copyPages(source,source.getPageIndices()))output.addPage(page);
            }
            const pdf=Buffer.from(await output.save());
            if(!output.getPageCount())throw fail('No printable label pages were returned.',502);
            if(pdf.length>4*1024*1024)throw fail('This print file is too large. Select fewer shipments.',413);
            res.set({'Content-Type':'application/pdf','Content-Disposition':'inline; filename="storybook-shipping-labels.pdf"','Cache-Control':'no-store'}).send(pdf);
          }catch(error){next(error);}
        });
        print.use(operations);
        print.use((error,req,res,next)=>res.status(error.status||503).json({error:error.message||'The Whatnot request could not be completed.'}));
        print(req,res,next);
      }catch(error){res.status(error.status||503).json({error:error.message||'Set up the Whatnot integration to continue.'});}
    });
    return router;
  };
}
