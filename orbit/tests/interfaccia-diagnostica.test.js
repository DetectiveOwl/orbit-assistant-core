'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ambienteUI}=require('./performance-ui-fixture');
const stato={performanceTrace:false,preferenze:{modalita:'testo'},configurazione:[],abbonamento:{ok:true},modelli:{tiers:{}},memoria:{ok:true},oggi:{}};
const diagnostica=()=>({storico:{costo:12.345678,chiamate:8,costiNoti:8,costiMancanti:0,dal:Date.UTC(2020,0,1)},oggi:{costo:1,token_in:12,token_out:4,chiamate:2},riepilogo:{richieste:{richieste:3,verificate:2,escalation:1},perModello:[]},richieste:[]});
const apri=async u=>{u.elementi.get('mDiagnostica').listeners.click();await u.scarica();};

test('UI diagnostica: distingue storico e oggi, e non azzera al cambio di giorno o riapertura',async()=>{
 const d=diagnostica(),api={'/api/status':stato,'/api/diagnostics':d};const u=ambienteUI(undefined,api);await u.scarica();await apri(u);
 assert.match(u.elementi.get('diagCostoStorico').textContent,/12,345678/);
 const iniziale=u.elementi.get('diagCostoStorico').textContent;d.oggi.costo=0;u.avanza(86400000);
 u.elementi.get('diagAggiorna').listeners.click();await u.scarica();assert.equal(u.elementi.get('diagCostoStorico').textContent,iniziale);assert.match(u.elementi.get('diagCostoOggi').textContent,/0,0000/);
 const v=ambienteUI(undefined,api);await v.scarica();await apri(v);assert.equal(v.elementi.get('diagCostoStorico').textContent,iniziale);
 assert.equal(u.chiamateApi.filter(x=>x.url==='/api/chat').length,0);
});

test('UI diagnostica: totale incompleto, dati mancanti e microcosti sono espliciti',async()=>{
 const d=diagnostica(),api={'/api/status':stato,'/api/diagnostics':d};const u=ambienteUI(undefined,api);await u.scarica();
 d.storico.costo=0.000012;d.storico.costiMancanti=2;d.storico.costiNoti=6;await apri(u);
 assert.match(u.elementi.get('diagCostoStorico').textContent,/0,000012/);assert.match(u.elementi.get('diagCopertura').textContent,/Totale parziale.*2 senza costo/);
 d.storico.costo=null;u.elementi.get('diagAggiorna').listeners.click();await u.scarica();assert.equal(u.elementi.get('diagCostoStorico').textContent,'Non disponibile');
 delete d.storico;u.elementi.get('diagAggiorna').listeners.click();await u.scarica();assert.match(u.elementi.get('diagCopertura').textContent,/non disponibile in questa versione/);
});

test('UI diagnostica: tabella compatta e dettaglio accessibile con sezioni separate',async()=>{
 const d=diagnostica();d.richieste=[{id:'req_123',creata:1,categoria:'chat',verifica:'PASS',costo:0.1,chiamate:2}];
 const api={'/api/status':stato,'/api/diagnostics':d,'/api/diagnostics/req_123':{...d.richieste[0],chiamateDettaglio:[{ruolo:'verificatore',modello:'mock',costo:0.04}],eventi:[{tipo:'esito_verifica',status:'PASS',semantico:true}]}};
 const u=ambienteUI(undefined,api);await u.scarica();await apri(u);const row=u.elementi.get('diagRighe').children[0];assert.equal(row.children.length,6);const b=row.children[0].children[0];assert.equal(b.tagName,'BUTTON');
 b.listeners.click();await u.scarica();const box=u.elementi.get('diagDettaglio');assert.equal(box.hidden,false);assert.equal(box.children.filter(x=>x.tagName==='DETAILS').length,3);assert.equal(box.children[0].children[1].textContent,'Chiudi dettagli');
 let ritorno=false;b.focus=()=>{ritorno=true;};box.children[0].children[1].listeners.click();assert.equal(box.hidden,true);assert.equal(ritorno,true);
});

test('UI diagnostica: un errore di aggiornamento conserva l’ultimo totale mostrato',async()=>{
 const d=diagnostica(),api={'/api/status':stato,'/api/diagnostics':d};const u=ambienteUI(undefined,api);await u.scarica();await apri(u);const totale=u.elementi.get('diagCostoStorico').textContent;
 api['/api/diagnostics']=null;u.elementi.get('diagAggiorna').listeners.click();await u.scarica();assert.equal(u.elementi.get('diagCostoStorico').textContent,totale);assert.match(u.elementi.get('diagStato').textContent,/Aggiornamento non riuscito/);assert.equal(u.elementi.get('diagAggiorna').disabled,false);
});
test('UI diagnostica: un costo positivo inferiore alla precisione visualizzata non appare zero',async()=>{
 const d=diagnostica();d.storico.costo=0.00000001;const u=ambienteUI(undefined,{'/api/status':stato,'/api/diagnostics':d});await u.scarica();await apri(u);assert.equal(u.elementi.get('diagCostoStorico').textContent,'Meno di 0,000001 USD');
});


test('UI diagnostica: la copertura richiede conteggi presenti, validi e coerenti',async()=>{
 const d=diagnostica(),u=ambienteUI(undefined,{'/api/status':stato,'/api/diagnostics':d});await u.scarica();
 for(const conteggi of [{},{costiNoti:8},{costiMancanti:0},{costiNoti:null,costiMancanti:0},{costiNoti:7,costiMancanti:0},{costiNoti:9,costiMancanti:-1},{costiNoti:'8',costiMancanti:0}]){
  d.storico={costo:12,chiamate:8,...conteggi};await apri(u);assert.match(u.elementi.get('diagCopertura').textContent,/Copertura non determinabile/);
 }
 d.storico={costo:12,chiamate:8,costiNoti:8,costiMancanti:0};await apri(u);assert.match(u.elementi.get('diagCopertura').textContent,/Copertura completa/);
 d.storico={costo:12,chiamate:8,costiNoti:6,costiMancanti:2};await apri(u);assert.match(u.elementi.get('diagCopertura').textContent,/Totale parziale.*2 senza costo/);
});
