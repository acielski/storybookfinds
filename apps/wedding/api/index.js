import {createApp} from '../server.js';
const app=createApp({apiOnly:true});
export default async function handler(req,res){return (await app)(req,res);}
