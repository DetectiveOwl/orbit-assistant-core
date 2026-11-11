'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const {Storage}=require('../storage/db');
const {creaServer}=require('../server');
const {appProva}=require('./helpers');
const registra=(s,costo,creata=Date.now(),giorno='2026-10-14')=>s.registraChiamata({richiesta:'req_sintetica',ruolo:'produttore',giorno,creata,costo,esito:'ok',tentativo:1});

test('benchmark API: totale storico persistente tra giorni e riapertura, senza duplicazioni',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-costo-test-')),file=path.join(dir,'prova.sqlite');let s=new Storage(file);
 try {
  assert.equal((await s.totaleStorico()).costo,0); assert.equal((await s.totaleStorico()).chiamate,0);
  registra(s,2.5,Date.UTC(2020,0,1),'2020-01-01'); registra(s,3.75,Date.UTC(2026,9,15),'2026-10-15');
  assert.equal(s.totaleGiorno('2026-10-15').costo,3.75); assert.equal((await s.totaleStorico()).costo,6.25);
  s.chiudi();s=new Storage(file);
  for(let i=0;i<3;i++) assert.equal((await s.totaleStorico()).costo,6.25);
  assert.equal((await s.totaleStorico()).dal,Date.UTC(2020,0,1));
  registra(s,0);registra(s,null);
  assert.equal((await s.totaleStorico()).costo,6.25);assert.equal((await s.totaleStorico()).costiNoti,3);assert.equal((await s.totaleStorico()).costiMancanti,1);
 } finally {s.chiudi();fs.rmSync(dir,{recursive:true,force:true});}
});

test('benchmark API: costi tutti mancanti non diventano zero',async()=>{
 const s=new Storage(':memory:');try{registra(s,null);assert.equal((await s.totaleStorico()).costo,null);assert.equal((await s.totaleStorico()).costiMancanti,1);}finally{s.chiudi();}
});

test('benchmark API: diagnostica espone lo storico senza cambiare la finestra giornaliera',async()=>{
 const app=appProva();registra(app.storage,7,Date.UTC(2020,0,1),'2020-01-01');
 const prova=creaServer(app,{port:0});await new Promise(r=>prova.listen(0,'127.0.0.1',r));const port=prova.address().port;await new Promise(r=>prova.close(r));
 const server=creaServer(app,{port});await new Promise(r=>server.listen(port,'127.0.0.1',r));
 try{const res=await fetch('http://127.0.0.1:'+port+'/api/diagnostics');assert.equal(res.status,200);const d=await res.json();assert.equal(d.storico.costo,7);assert.equal(d.storico.chiamate,1);assert.equal(d.oggi.chiamate,0);assert.equal(app.provider.chiamate.length,0);}
 finally{server.closeAllConnections();await new Promise(r=>server.close(r));app.storage.chiudi();}
});


test('benchmark API: storico grande in blocchi indicizzati, riuso e invalidazione delle scritture',async()=>{
 const s=new Storage(':memory:');try{
  s.db.exec("WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<49999) INSERT INTO chiamate(richiesta,giorno,creata,ruolo,esito,costo) SELECT 'req_sintetica','2020-01-01',100000+x,'produttore','ok',CASE WHEN x%10=0 THEN NULL ELSE 0.25 END FROM n");
  const prepare=s.db.prepare.bind(s.db);let letture=0,massimo=0;
  s.db.prepare=sql=>{const st=prepare(sql);if(!sql.includes('SUM(costo)'))return st;return{get:(...p)=>{letture++;const r=st.get(...p);massimo=Math.max(massimo,r.chiamate);return r;}};};
  let turnoLibero=false;setImmediate(()=>{turnoLibero=true;});
  const [a,b]=await Promise.all([s.totaleStorico(),s.totaleStorico()]);assert.ok(turnoLibero);assert.deepEqual(a,b);assert.equal(a.chiamate,50000);assert.equal(a.costo,11250);assert.equal(a.costiMancanti,5000);assert.ok(massimo<=2048);
  const n=letture;a.costo=-1;assert.equal((await s.totaleStorico()).costo,11250);assert.equal(letture,n,'nessuna nuova scansione senza scritture');
  const piano=prepare('EXPLAIN QUERY PLAN SELECT id,costo,creata FROM chiamate WHERE id > ? ORDER BY id LIMIT 2048').all(1);assert.ok(piano.some(r=>/SEARCH.*INTEGER PRIMARY KEY/i.test(r.detail)));
  registra(s,3,1);let d=await s.totaleStorico();assert.equal(d.costo,11253);assert.equal(d.dal,1);assert.equal(d.chiamate,50001);
  s.db.exec('UPDATE chiamate SET costo = 2 WHERE id = 1');d=await s.totaleStorico();assert.equal(d.costo,11255);assert.equal(d.costiMancanti,4999);
  s.db.exec('DELETE FROM chiamate WHERE id = 50001');d=await s.totaleStorico();assert.equal(d.costo,11252);assert.equal(d.dal,100000);
  s.db.exec('BEGIN; UPDATE chiamate SET costo = 100 WHERE id = 1; ROLLBACK');assert.equal((await s.totaleStorico()).costo,11252);
  s.db.exec('BEGIN; UPDATE chiamate SET costo = 100 WHERE id = 1');assert.equal((await s.totaleStorico()).costo,11350);
  s.db.exec('ROLLBACK');assert.equal((await s.totaleStorico()).costo,11252);
 }finally{s.chiudi();}
});

test('benchmark API: invalidazione da altra connessione e scritture durante la costruzione',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-storico-esterno-')),file=path.join(dir,'prova.sqlite');const s=new Storage(file);let altro;
 try{
  registra(s,1);assert.equal((await s.totaleStorico()).costo,1);altro=new Storage(file);registra(altro,2);assert.equal((await s.totaleStorico()).costo,3);
  altro.db.exec('UPDATE chiamate SET costo = 4 WHERE id = 1');assert.equal((await s.totaleStorico()).costo,6);
  altro.db.exec('DELETE FROM chiamate WHERE id = 2');assert.equal((await s.totaleStorico()).costo,4);
  registra(s,1);const pendente=s.totaleStorico();registra(altro,3);const d=await pendente;assert.equal(d.costo,8);assert.equal(d.chiamate,3);
 }finally{altro?.chiudi();s.chiudi();fs.rmSync(dir,{recursive:true,force:true});}
});


test('benchmark API: scritture continue non pubblicano un aggregato incoerente',async()=>{
 const s=new Storage(':memory:');try{
  registra(s,1);const prepare=s.db.prepare.bind(s.db);let mutazioni=0;
  s.db.prepare=sql=>{const st=prepare(sql);if(!sql.includes('SUM(costo)'))return st;return{get:(...p)=>{const r=st.get(...p);if(!r.chiamate){registra(s,1);mutazioni++;}return r;}};};
  await assert.rejects(s.totaleStorico(),/Storico in aggiornamento/);assert.equal(mutazioni,3);
  s.db.prepare=prepare;assert.equal((await s.totaleStorico()).costo,4);
 }finally{s.chiudi();}
});
