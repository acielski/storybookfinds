import express from 'express';
import multer from 'multer';
import {parseUpload, setupWhatnot} from './whatnot.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function validate(row) {
  const type = String(row.type || '').trim().toLowerCase();
  const date = String(row.date || '').trim();
  const description = String(row.description || '').trim();
  const category = String(row.category || '').trim();
  const rawAmount = String(row.amount ?? '').trim();
  const amount = Number(rawAmount);
  if (!['sale', 'expense'].includes(type)) throw new Error('Type must be sale or expense.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date) throw new Error('Use a valid date in YYYY-MM-DD format.');
  if (!description || description.length > 200) throw new Error('Description is required (up to 200 characters).');
  if (!category || category.length > 80) throw new Error('Category is required (up to 80 characters).');
  if (!rawAmount || !Number.isFinite(amount) || amount <= 0 || amount > 1e9 || !/^\d+(\.\d{1,2})?$/.test(rawAmount)) throw new Error('Amount must be positive with at most two decimal places.');
  return { type, date, description, category, cents: Math.round(amount * 100) };
}
export async function createApp(dbPath = 'data/ledger.sqlite') {
  if (dbPath !== ':memory:') mkdirSync(resolve(dbPath, '..'), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, date TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL, cents INTEGER NOT NULL);`);
  const insert = db.prepare('INSERT INTO transactions (type,date,description,category,cents) VALUES (?,?,?,?,?)');
  const save = row => insert.run(row.type,row.date,row.description,row.category,row.cents);
  const whatnot=setupWhatnot(db);
  const app = express();
  app.use(express.json({limit:'32kb'}));
  app.get('/api/transactions', (req,res) => res.json([...db.prepare('SELECT * FROM transactions ORDER BY date DESC,id DESC').all(),...whatnot.getTransactions()].sort((a,b)=>b.date.localeCompare(a.date))));
  app.get('/api/whatnot', (req,res)=>res.json(whatnot.summary()));
  app.post('/api/transactions', (req,res,next) => { try { const row = validate(req.body); const result=save(row); res.status(201).json({...row,id:Number(result.lastInsertRowid)}); } catch(e) { e.status=400; next(e); } });
  app.delete('/api/transactions/:id', (req,res) => { const result=db.prepare('DELETE FROM transactions WHERE id=?').run(req.params.id); res.status(result.changes ? 204:404).end(); });
  const upload = multer({storage:multer.memoryStorage(),limits:{fileSize:2*1024*1024,files:1}});
  app.post('/api/import', upload.single('file'), (req,res,next) => {
    try {
      if (!req.file) throw new Error('Choose a CSV file.');
      const report=parseUpload(req.file.buffer,req.body.type,validate);
      res.json(whatnot.importReport(report,req.file.originalname,save));
    } catch(e) {e.status=400;next(e);}
  });
  app.use('/api', (req,res)=>res.status(404).json({error:'Not found.'}));
  if(process.env.NODE_ENV==='production') {
    app.use(express.static('dist'));
    app.get('/{*path}',(req,res)=>res.sendFile(resolve('dist/index.html')));
  } else {
    const {createServer}=await import('vite');
    const vite=await createServer({server:{middlewareMode:true},appType:'spa'});
    app.use(vite.middlewares);
    app.locals.vite=vite;
  }
  app.use((error,req,res,next)=>res.status(error.status || 400).json({error:error.message || 'Request failed.'}));
  app.locals.db=db;
  return app;
}
if(process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app=await createApp(process.env.DB_PATH || 'data/ledger.sqlite');
  app.listen(Number(process.env.PORT || 3000),'0.0.0.0',()=>console.log('Ledger is running on port '+(process.env.PORT || 3000)));
}
