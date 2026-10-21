// SQLite is an in-memory import/validation engine in cloud mode, never durable storage.
export function exportWorkspace(db) {
  return {
    schemaVersion:1,
    sequences:db.prepare("SELECT name,seq FROM sqlite_sequence WHERE name IN ('transactions','imports')").all(),
    transactions:db.prepare('SELECT * FROM transactions ORDER BY id').all(),
    records:db.prepare('SELECT * FROM whatnot_records ORDER BY source_key').all(),
    imports:db.prepare('SELECT * FROM imports ORDER BY id').all(),
  };
}
export function restoreWorkspace(db,state) {
  if(!state)return;
  if(state.schemaVersion!==1||!Array.isArray(state.transactions)||!Array.isArray(state.records)||!Array.isArray(state.imports))throw Error('Unsupported workspace data.');
  const transaction=db.prepare('INSERT INTO transactions(id,type,date,description,category,cents,quantity) VALUES(?,?,?,?,?,?,?)');
  const record=db.prepare('INSERT INTO whatnot_records(source_key,format,payload) VALUES(?,?,?)');
  const history=db.prepare('INSERT INTO imports(id,filename,format,imported,skipped,updated,created_at) VALUES(?,?,?,?,?,?,?)');
  db.exec('BEGIN');
  try {
    state.transactions.forEach(r=>transaction.run(r.id,r.type,r.date,r.description,r.category,r.cents,r.quantity??null));
    state.records.forEach(r=>record.run(r.source_key,r.format,r.payload));
    state.imports.forEach(r=>history.run(r.id,r.filename,r.format,r.imported,r.skipped,r.updated,r.created_at));
    if(state.sequences){
      for(const {name,seq} of state.sequences){
        if(!['transactions','imports'].includes(name)||!Number.isSafeInteger(seq)||seq<0)throw Error('Invalid workspace sequence.');
        db.prepare('DELETE FROM sqlite_sequence WHERE name=?').run(name);
        db.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(name,seq);
      }
    }
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
