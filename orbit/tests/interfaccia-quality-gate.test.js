'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ambienteUI } = require('./performance-ui-fixture');
const finale = extra => ({ tipo: 'finale', testo: 'Risposta sintetica.', verifica: 'PASS', ...extra });
const badge = u => u.elementi.get('rMeta').children.find(x => x.className === 'verifica-badge').children[0];
const dettagli = u => u.elementi.get('rMeta').children.at(-1).children[1];
const giro = (modo, status = 'PASS', semantico = modo === 'semantico') => [
  { tipo: 'verifica', modo }, { tipo: 'esito_verifica', status, semantico }
];

test('UI Quality Gate: il controllo locale ordinario usa gli eventi, senza tipo nel finale', async () => {
  const u = ambienteUI(); await u.scarica();
  await u.invia([...giro('deterministico'), finale()]);
  assert.equal(badge(u).textContent, 'Verifica locale');
  assert.equal(badge(u).tagName, 'SUMMARY');
  assert.match(dettagli(u).children[0].textContent, /non garantiscono la correttezza/);
  assert.ok(u.stati.some(s => s.nome === 'quality_checking'));
  assert.equal(u.win.__orbit.stato().core.nome, 'responding');
  assert.equal(u.richieste.filter(r => r.message).length, 1);
});

test('UI Quality Gate: verifica AI e controlli multipli conservano gli esiti precedenti', async () => {
  const u = ambienteUI(); await u.scarica();
  await u.invia([...giro('semantico'), finale()]);
  assert.equal(badge(u).textContent, 'Verifica AI');
  await u.invia([...giro('deterministico', 'FAIL'), ...giro('semantico'), ...giro('semantico'), finale()]);
  assert.equal(badge(u).textContent, 'Verifica locale + AI');
  const lista = dettagli(u).children[1].children;
  assert.equal(lista.length, 3);
  assert.match(lista[0].textContent, /locale: non superato/);
  assert.match(lista[1].textContent, /AI: superato/);
});

test('UI Quality Gate: PASS incompleto o piano AI senza esito non inventano controlli', async () => {
  const u = ambienteUI(); await u.scarica();
  for (const eventi of [[finale()], [{ tipo: 'verifica', modo: 'semantico' }, finale()],
    [{ tipo: 'esito_verifica', status: 'PASS' }, finale()], [...giro('deterministico', 'FAIL'), finale()]]) {
    await u.invia(eventi);
    assert.equal(badge(u).textContent, 'Controllo superato');
  }
  await u.invia([finale({ verificaModo: 'deterministico' })]);
  assert.equal(badge(u).textContent, 'Verifica locale');
  await u.invia([finale({ verifica: undefined })]);
  assert.equal(badge(u).textContent, 'Verifica non indicata');
});

test('UI Quality Gate: fallimento, chiarimento e verifica indisponibile conservano il risultato', async () => {
  const u = ambienteUI(); await u.scarica();
  await u.invia([...giro('semantico', 'ERROR', false), finale({ verifica: 'NON_VERIFICATA' })]);
  assert.equal(badge(u).textContent, 'Verifica incompleta');
  assert.match(dettagli(u).children[1].children[0].textContent, /AI richiesto: non disponibile/);
  assert.equal(badge(u).className, 'badge nv');
  await u.invia([...giro('deterministico', 'FAIL'), finale({ verifica: 'FAIL' })]);
  assert.equal(badge(u).textContent, 'Controllo non superato');
  assert.equal(u.win.__orbit.stato().core.fallimento, true);
  await u.invia([finale({ verifica: 'CHIARIMENTO' })]);
  assert.equal(badge(u).textContent, 'Serve un chiarimento');
});

test('UI Quality Gate: la cronologia legge gli eventi reali, non il modo previsto dal piano', async () => {
  const risposte = {
    '/api/conversations': [{ id: 'conv_prova', titolo: 'Prova', aggiornata: 1, messaggi: 2 }],
    '/api/conversations/conv_prova': { messaggi: [
      { ruolo: 'user', contenuto: 'Domanda' },
      { ruolo: 'assistant', contenuto: 'Risposta', verifica: 'PASS', verificaModo: 'semantico', richiesta: 'req_prova' }
    ] },
    '/api/diagnostics/req_prova': { eventi: giro('deterministico') }
  };
  const u = ambienteUI(undefined, risposte); await u.scarica();
  u.elementi.get('listaConv').children[0].children[0].listeners.click(); await u.scarica();
  assert.equal(badge(u).textContent, 'Verifica locale');
  assert.equal(u.chiamateApi.filter(x => x.url === '/api/diagnostics/req_prova').length, 1);
  u.elementi.get('rPrec').listeners.click(); await u.scarica();
  assert.equal(u.chiamateApi.filter(x => x.url === '/api/diagnostics/req_prova').length, 1);
  risposte['/api/diagnostics/req_prova'] = { eventi: [] };
  const v = ambienteUI(undefined, risposte); await v.scarica();
  v.elementi.get('listaConv').children[0].children[0].listeners.click(); await v.scarica();
  assert.equal(badge(v).textContent, 'Controllo superato');
});

test('UI Quality Gate: il badge conserva Ascolta senza avviare audio o nuovi controlli', async () => {
  const u = ambienteUI(); await u.scarica();
  let audio = 0; u.sintesi.haVoceItaliana = () => true; u.sintesi.parla = () => audio++;
  await u.invia([...giro('deterministico'), finale()]);
  assert.equal(badge(u).textContent, 'Verifica locale');
  assert.equal(u.elementi.get('rMeta').children.at(-1).textContent, 'Ascolta');
  assert.equal(audio, 0);
  assert.equal(u.chiamateApi.filter(x => x.url.startsWith('/api/diagnostics/')).length, 0);
});


test('UI Quality Gate: riverifica ed escalation usano il tentativo esplicito, non la posizione',async()=>{
 const u=ambienteUI();await u.scarica();await u.invia([
  {tipo:'tentativo',tentativo:1,tier:'haiku'},...giro('semantico','ERROR',false),...giro('semantico','FAIL'),
  {tipo:'escalation',da:'haiku',a:'sonnet'},{tipo:'tentativo',tentativo:2,tier:'sonnet'},...giro('semantico'),finale()
 ]);
 const righe=dettagli(u).children[1].children.map(x=>x.textContent);assert.match(righe[0],/Tentativo 1/);assert.match(righe[1],/Tentativo 1.*Riverifica/);assert.match(righe[2],/Tentativo 2.*escalation.*Verifica finale/);
 assert.match(dettagli(u).children[0].textContent,/Esito finale della risposta/);
});


test('UI Quality Gate: metadati assenti, invalidi o contraddittori non inventano tentativi',async()=>{
 const u=ambienteUI();await u.scarica();
 const casi=[
  [...giro('semantico','ERROR',false),...giro('semantico'),finale()],
  [{tipo:'tentativo',tentativo:1,tier:'haiku'},{tipo:'esecuzione',tier:'haiku'},...giro('semantico','FAIL'),{tipo:'esecuzione',tier:'sonnet'},...giro('semantico'),finale()],
  [{tipo:'tentativo',tentativo:1,tier:'haiku'},...giro('semantico','FAIL'),{tipo:'esecuzione',tier:'haiku'},...giro('semantico'),finale()],
  ...[0,-1,null,'1',1.5].map(tentativo=>[{tipo:'tentativo',tentativo},...giro('deterministico'),finale()]),
  [{tipo:'tentativo',tentativo:1},{tipo:'escalation',da:'haiku',a:'sonnet'},...giro('semantico'),finale()],
  [{tipo:'tentativo',tentativo:1},{tipo:'verifica',tentativo:1,modo:'semantico'},{tipo:'esito_verifica',tentativo:2,status:'PASS',semantico:true},finale()],
  [{tipo:'verifica',tentativo:3,modo:'semantico'},{tipo:'esito_verifica',tentativo:3,status:'PASS',semantico:true},finale()]
 ];
 for(const eventi of casi){await u.invia(eventi);const righe=dettagli(u).children[1].children.map(x=>x.textContent);assert.ok(righe.some(x=>/Tentativo non attribuibile|Tentativo 3/.test(x)));assert.ok(righe.every(x=>!x.includes('Verifica finale')&&!x.includes('Riverifica')));}
 await u.invia([{tipo:'tentativo',tentativo:2},...giro('semantico','FAIL'),{tipo:'tentativo',tentativo:1},...giro('semantico'),finale()]);assert.match(dettagli(u).children[1].children.at(-1).textContent,/Tentativo non attribuibile/);
 await u.invia([{tipo:'tentativo',tentativo:1,tier:'haiku'},...giro('semantico','FAIL'),{tipo:'escalation',da:'haiku',a:'sonnet'},{tipo:'tentativo',tentativo:2,tier:'opus'},...giro('semantico'),finale()]);assert.match(dettagli(u).children[1].children.at(-1).textContent,/Tentativo non attribuibile/);
});

test('UI Quality Gate: correzione mirata, numero ripetuto e candidato precedente mantengono gli esiti distinti',async()=>{
 const u=ambienteUI();await u.scarica();
 await u.invia([{tipo:'tentativo',tentativo:3,tier:'opus'},...giro('semantico','FAIL'),{tipo:'tentativo_mirato',tier:'opus'},{tipo:'tentativo',tentativo:4,tier:'opus'},...giro('semantico'),finale()]);assert.match(dettagli(u).children[1].children.at(-1).textContent,/Tentativo 4.*correzione mirata.*Verifica finale/);
 await u.invia([{tipo:'tentativo',tentativo:1},...giro('semantico','ERROR',false),{tipo:'tentativo',tentativo:1},...giro('semantico'),finale()]);assert.doesNotMatch(dettagli(u).children[1].children.at(-1).textContent,/Riverifica/);
 await u.invia([{tipo:'tentativo',tentativo:1},...giro('semantico','FAIL'),{tipo:'tentativo',tentativo:2},finale({verifica:'FAIL'})]);assert.doesNotMatch(dettagli(u).children[1].children[0].textContent,/Verifica finale/);assert.match(dettagli(u).children[0].textContent,/Esito finale della risposta: non superato/);
});

test('UI Quality Gate: cronologia e stream associano gli stessi controlli agli stessi tentativi',async()=>{
 const eventi=[{tipo:'tentativo',tentativo:1,tier:'haiku'},...giro('semantico','ERROR',false),...giro('semantico','FAIL'),{tipo:'escalation',da:'haiku',a:'sonnet'},{tipo:'tentativo',tentativo:2,tier:'sonnet'},...giro('semantico')];
 const live=ambienteUI();await live.scarica();await live.invia([...eventi,finale()]);const attesi=dettagli(live).children[1].children.map(x=>x.textContent);
 const u=ambienteUI(undefined,{'/api/conversations':[{id:'conv_test',titolo:'Prova',aggiornata:1,messaggi:2}],'/api/conversations/conv_test':{messaggi:[{ruolo:'user',contenuto:'Domanda'},{ruolo:'assistant',contenuto:'Risposta sintetica.',verifica:'PASS',richiesta:'req_test'}]},'/api/diagnostics/req_test':{eventi}});await u.scarica();u.elementi.get('listaConv').children[0].children[0].listeners.click();await u.scarica();assert.deepEqual(dettagli(u).children[1].children.map(x=>x.textContent),attesi);
});
