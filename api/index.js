import {createRuntimeApp} from '../cloud.js';
// Reuse routing, but never share an in-memory user's data between requests.
const app=createRuntimeApp({apiOnly:true});
export default async function handler(req,res){return (await app)(req,res);}
