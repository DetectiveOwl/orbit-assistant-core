'use strict';
// Benchmark manuale: solo SQLite sintetico in memoria, stessa query e stessi dati prima/dopo.
const assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks');
const {Storage}=require('../storage/db');
const s=new Storage(':memory:');
const sql="SELECT COUNT(*) AS chiamate, COUNT(costo) AS costiNoti, COUNT(*)-COUNT(costo) AS costiMancanti, CASE WHEN COUNT(*)=0 THEN 0 ELSE SUM(costo) END AS costo, MIN(creata) AS dal, MAX(creata) AS al FROM chiamate";
async function misura(fn,n=5){const ms=[],ritardi=[];for(let i=0;i<n;i++){
 let precedente=performance.now();const timer=setInterval(()=>{const ora=performance.now();ritardi.push(ora-precedente);precedente=ora;},1);
 try{const t=performance.now(),d=await fn();ms.push(performance.now()-t);assert.equal(d.chiamate,1000000);assert.equal(d.costo,225000);assert.equal(d.costiMancanti,100000);await new Promise(r=>setTimeout(r,1));}finally{clearInterval(timer);}
 }return {ms,medianaMs:[...ms].sort((a,b)=>a-b)[Math.floor(n/2)],ritardoTimerMaxMs:Math.max(...ritardi)};}

(async()=>{try{
 s.db.exec("WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<999) INSERT INTO chiamate(richiesta,giorno,creata,ruolo,esito,costo) SELECT 'req_sintetica','2020-01-01',1577836800000+a.x*1000+b.x,'produttore','ok',CASE WHEN b.x%10=0 THEN NULL ELSE 0.25 END FROM n a CROSS JOIN n b");
 const prima=await misura(()=>s.db.prepare(sql).get()),costruzione=await misura(()=>s.totaleStorico(),1),dopo=await misura(()=>s.totaleStorico());
 process.stdout.write(JSON.stringify({righe:1000000,prima,costruzione,dopo},null,2)+'\n');
}finally{s.chiudi();}})().catch(e=>{process.stderr.write(e.stack+'\n');process.exitCode=1;});
