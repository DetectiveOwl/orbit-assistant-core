'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ambienteUI } = require('./performance-ui-fixture');
const messaggi = [{ ruolo: 'user', contenuto: 'Domanda sintetica' }, { ruolo: 'assistant', contenuto: 'Risposta sintetica' }];
const chat = () => ({
  '/api/conversations': [{ id: 'a', titolo: 'A', aggiornata: 1 }, { id: 'b', titolo: 'B', aggiornata: 1 }],
  '/api/conversations/a': { messaggi }, '/api/conversations/b': { messaggi }
});
const scegli = (u, i) => u.elementi.get('listaConv').children[i].children[0].listeners.click();
function audio(u) {
  let stop = 0, parla = 0;
  u.sintesi.ferma = () => stop++;
  u.sintesi.parla = () => parla++;
  u.sintesi.inCorso = () => true;
  return { get stop() { return stop; }, get parla() { return parla; } };
}

test('navigazione voce: cambio chat ferma subito la lettura anche prima del caricamento', async () => {
  let completa;
  const u = ambienteUI(undefined, { ...chat(), '/api/conversations/b': () => new Promise(r => { completa = r; }) });
  await u.scarica(); scegli(u, 0); await u.scarica();
  const a = audio(u);
  u.elementi.get('input').value = 'Bozza A'; u.elementi.get('input').listeners.input({});
  scegli(u, 1);
  assert.equal(a.stop, 1);
  assert.equal(u.elementi.get('input').value, 'Bozza A');
  completa({ ok: true, json: async () => ({ messaggi }) }); await u.scarica();
  assert.equal(a.parla, 0); assert.equal(u.richieste.length, 0);
  assert.equal(u.elementi.get('btnVoceStop').disabled, true);
  scegli(u, 0); await u.scarica(); assert.equal(u.elementi.get('input').value, 'Bozza A');
  assert.equal(u.chiamateApi.some(c => c.url === '/api/preferences' || c.url === '/api/voce/parla'), false);
});

test('navigazione voce: scegliere la chat corrente lascia la lettura in corso', async () => {
  const u = ambienteUI(undefined, chat()); await u.scarica(); scegli(u, 0); await u.scarica();
  const a = audio(u); scegli(u, 0); await u.scarica(); assert.equal(a.stop, 0); assert.equal(a.parla, 0);
});

test('navigazione voce: caricamento fallito mantiene bozza e non riavvia audio', async () => {
  const u = ambienteUI(undefined, { ...chat(), '/api/conversations/b': () => { throw new TypeError('Rete simulata'); } });
  await u.scarica(); scegli(u, 0); await u.scarica(); const a = audio(u);
  u.elementi.get('input').value = 'Bozza da conservare'; u.elementi.get('input').listeners.input({});
  scegli(u, 1); await u.scarica();
  assert.equal(a.stop, 1); assert.equal(a.parla, 0); assert.equal(u.elementi.get('input').value, 'Bozza da conservare');
  assert.equal(u.win.__orbit.stato().core.nome, 'error'); assert.equal(u.richieste.length, 0);
});

test('navigazione voce: durante una richiesta il cambio bloccato non interrompe nuovamente', async () => {
  const u = ambienteUI(undefined, { ...chat(), '/api/chat': () => new Promise(() => {}) });
  await u.scarica(); scegli(u, 0); await u.scarica(); await u.invia([], false, 'Richiesta A');
  const a = audio(u), chiamate = u.chiamateApi.length;
  scegli(u, 1); await u.scarica();
  assert.equal(a.stop, 0); assert.equal(u.chiamateApi.length, chiamate); assert.equal(u.richieste.length, 1);
});
