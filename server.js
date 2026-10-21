import express from 'express';
import multer from 'multer';
import {parseUpload, setupWhatnot} from './whatnot.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {restoreWorkspace} from './workspace.js';
import {isPinCategory} from './src/pins.js';

export function validate(row) {
  const type = String(row.type || '').trim().toLowerCase();
  const date = String(row.date || '').trim();
  const description = String(row.description || '').trim();
  let category = String(row.category || '').trim();
  if(category.toLowerCase()==='pins')category='Pins';
  const rawAmount = String(row.amount ?? '').trim();
  const amount = Number(rawAmount);
  if (!['sale', 'expense'].includes(type)) throw new Error('Type must be sale or expense.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date) throw new Error('Use a valid date in YYYY-MM-DD format.');
  if (!description || description.length > 200) throw new Error('Description is required (up to 200 characters).');
  if (!category || category.length > 80) throw new Error('Category is required (up to 80 characters).');
  if (!rawAmount || !Number.isFinite(amount) || amount <= 0 || amount > 1e9 || !/^\d+(\.\d{1,2})?$/.test(rawAmount)) throw new Error('Amount must be positive with at most two decimal places.');
  let quantity=null;
  if(row.quantity!==undefined && row.quantity!==null && String(row.quantity).trim()!==''){
    const value=String(row.quantity).trim();
    if(type!=='expense'||!isPinCategory(category))throw Error('Quantity is only used for Pins expenses.');
    if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<1||Number(value)>1000000)throw Error('Pin quantity must be a whole number between 1 and 1,000,000.');
    quantity=Number(value);
  }
  if(type==='expense'&&category==='Pins'&&quantity===null)throw Error('Enter the number of pins purchased for a Pins expense.');
  return { type, date, description, category, cents: Math.round(amount * 100),quantity };
}
export async function createApp(dbPath = 'data/ledger.sqlite',options={}) {
  if (dbPath !== ':memory:') mkdirSync(resolve(dbPath, '..'), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, date TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL, cents INTEGER NOT NULL);`);
  if(!db.prepare('PRAGMA table_info(transactions)').all().some(column=>column.name==='quantity')){
    db.exec('ALTER TABLE transactions ADD COLUMN quantity INTEGER CHECK(quantity IS NULL OR (typeof(quantity)=\'integer\' AND quantity BETWEEN 1 AND 1000000))');
  }
  const insert = db.prepare('INSERT INTO transactions (type,date,description,category,cents,quantity) VALUES (?,?,?,?,?,?)');
  const save = row => insert.run(row.type,row.date,row.description,row.category,row.cents,row.quantity??null);
  const whatnot=setupWhatnot(db);
  try{restoreWorkspace(db,options.state);}catch(error){db.close();throw error;}
  const persist=async()=>options.persist?.(db);
  const app = express();
  app.use(express.json({limit:'32kb'}));
  app.get('/api/transactions', (req,res) => res.json([...db.prepare('SELECT * FROM transactions ORDER BY date DESC,id DESC').all(),...whatnot.getTransactions()].sort((a,b)=>b.date.localeCompare(a.date))));
  app.get('/api/whatnot', (req,res)=>res.json(whatnot.summary()));
  app.post('/api/transactions', async (req,res,next) => { try { const row = validate(req.body); const result=save(row); await persist(); res.status(201).json({...row,id:Number(result.lastInsertRowid)}); } catch(e) { e.status ||=400; next(e); } });
  app.delete('/api/transactions/:id', async (req,res,next) => {try{ const result=db.prepare('DELETE FROM transactions WHERE id=?').run(req.params.id); if(result.changes)await persist();res.status(result.changes ? 204:404).end();}catch(error){next(error);} });
  app.patch('/api/transactions/:id',async(req,res,next)=>{
    try{
      const existing=db.prepare('SELECT * FROM transactions WHERE id=?').get(req.params.id);
      if(!existing)return res.status(404).json({error:'Transaction not found.'});
      if(existing.type!=='expense'||!isPinCategory(existing.category))throw Error('Only pin purchases have a pin quantity.');
      const row=validate({...existing,category:'Pins',amount:(existing.cents/100).toFixed(2),quantity:req.body.quantity});
      db.prepare('UPDATE transactions SET category=?,quantity=? WHERE id=?').run('Pins',row.quantity,existing.id);
      await persist();res.json({...existing,category:'Pins',quantity:row.quantity});
    }catch(error){error.status ||=400;next(error);}
  });
  const upload = multer({storage:multer.memoryStorage(),limits:{fileSize:2*1024*1024,files:20,fields:1}});
  const importFile=(file,type)=>{
    if(!file.originalname.toLowerCase().endsWith('.csv')) throw Error('Only CSV files are supported.');
    return whatnot.importReport(parseUpload(file.buffer,type,validate),file.originalname,save);
  };
  app.post('/api/import', upload.single('file'), async (req,res,next) => {
    try {
      if (!req.file) throw new Error('Choose a CSV file.');
      const result=importFile(req.file,req.body.type);await persist();res.json(result);
    } catch(e) {e.status ||=400;next(e);}
  });
  app.post('/api/import/batch', upload.array('files',20), async (req,res,next) => {
    try {
      if(!req.files?.length) throw Error('Choose at least one CSV file.');
      const results=req.files.map(file=>{
        try {return {filename:file.originalname,status:'success',...importFile(file,req.body.type)};}
        catch(error) {return {filename:file.originalname,status:'error',error:error.message,imported:0,skipped:0,updated:0};}
      });
      const totals=results.reduce((sum,file)=>({imported:sum.imported+file.imported,skipped:sum.skipped+file.skipped,updated:sum.updated+file.updated,failed:sum.failed+(file.status==='error'?1:0)}),{imported:0,skipped:0,updated:0,failed:0});
      await persist();res.json({results,totals});
    }catch(e){e.status ||=400;next(e);}
  });
  app.use('/api', (req,res)=>res.status(404).json({error:'Not found.'}));
  if(options.apiOnly) {
    // Static files are served separately by Vercel.
  } else if(process.env.NODE_ENV==='production') {
    app.use(express.static('dist'));
    app.get('/{*path}',(req,res)=>res.sendFile(resolve('dist/index.html')));
  } else {
    const {createServer}=await import('vite');
    const vite=await createServer({server:{middlewareMode:true},appType:'spa'});
    app.use(vite.middlewares);
    app.locals.vite=vite;
  }
  app.use((error,req,res,next)=>res.status(error.status || 400).json({error:error.code==='LIMIT_FILE_SIZE'?'Each CSV must be 2 MB or smaller.':error.code==='LIMIT_FILE_COUNT'||error.code==='LIMIT_UNEXPECTED_FILE'?'Upload at most 20 CSV files per batch.':error.message || 'Request failed.'}));
  app.locals.db=db;
  return app;
}
