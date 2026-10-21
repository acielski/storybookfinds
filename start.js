import {createRuntimeApp} from './cloud.js';
try { process.loadEnvFile('.env.local'); } catch(error) {if(error.code!=='ENOENT')throw error;}
const app=await createRuntimeApp();
app.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Storybook Finds is running on port '+(process.env.PORT||3000)));
