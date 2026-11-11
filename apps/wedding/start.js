import {resolve} from 'node:path';
import {createApp,appRoot} from './server.js';
try{process.loadEnvFile(resolve(appRoot,'.env.local'));}catch(e){if(e.code!=='ENOENT')throw e;}
const app=await createApp();app.listen(Number(process.env.PORT||process.env.WEDDING_PORT||3100),'0.0.0.0',()=>console.log('Ever After wedding planner is running on port '+(process.env.PORT||process.env.WEDDING_PORT||3100)));
