'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ambienteUI } = require('./performance-ui-fixture');

test('UI: ogni conferma mostra una sola operazione e riceve una scelta separata', async () => {
  const u = ambienteUI(); await u.scarica();
  const prima = u.win.__orbit.conferma({ titolo: 'Elimina A', testo: 'Solo A' });
  const seconda = u.win.__orbit.conferma({ titolo: 'Crea B', testo: 'Solo B' });
  await u.scarica();
  const dlg = u.elementi.get('dlgConferma');
  assert.equal(u.elementi.get('confTitolo').textContent, 'Elimina A');
  dlg.close('si'); assert.equal(await prima, true); await u.scarica();
  assert.equal(dlg.open, true);
  assert.equal(u.elementi.get('confTitolo').textContent, 'Crea B');
  dlg.close('no'); assert.equal(await seconda, false);
});

test('UI: conferme scadute o annullate, anche in coda, non autorizzano operazioni', async () => {
  const u = ambienteUI(); await u.scarica();
  const ctrl = new AbortController();
  const prima = u.win.__orbit.conferma({ titolo: 'Prima', testo: '', signal: ctrl.signal });
  const seconda = u.win.__orbit.conferma({ titolo: 'Scaduta in coda', testo: '', scade: u.adesso + 10 });
  await u.scarica(); u.avanza(11); ctrl.abort();
  assert.equal(await prima, false); assert.equal(await seconda, false);
  assert.equal(u.elementi.get('dlgConferma').open, false);
  const terza = u.win.__orbit.conferma({ titolo: 'Scadenza', testo: '', scade: u.adesso + 20 });
  await u.scarica(); u.avanza(20);
  assert.equal(await terza, false); assert.equal(u.elementi.get('dlgConferma').open, false);
});

test('UI: la scadenza non invia una decisione e l’esito del server viene controllato', async () => {
  const risposte = { '/api/conferme/cnf_prova': { stato: 'scaduta' } };
  const u = ambienteUI(undefined, risposte); await u.scarica();
  const prima = u.win.__orbit.confermaOperazione({ id: 'cnf_scaduta', descrizione: 'Scaduta', scade: u.adesso + 10 });
  await u.scarica(); u.avanza(10); await prima;
  assert.equal(u.chiamateApi.filter(x => x.url.startsWith('/api/conferme/')).length, 0);
  const seconda = u.win.__orbit.confermaOperazione({ id: 'cnf_prova', descrizione: 'Prova', scade: u.adesso + 100 });
  await u.scarica(); u.elementi.get('dlgConferma').close('si'); await seconda;
  assert.equal(JSON.parse(u.chiamateApi.find(x => x.url === '/api/conferme/cnf_prova').init.body).approva, true);
  assert.match(u.elementi.get('suggerimentoVoce').textContent, /non autorizzata/);
});

test('UI: un evento finale chiude le conferme della richiesta senza inviare approvazioni', async () => {
  const u = ambienteUI(); await u.scarica();
  await u.invia([
    { tipo: 'conferma_richiesta', conferma: { id: 'cnf_terminata', descrizione: 'Prova', scade: u.adesso + 1000 } },
    { tipo: 'finale', testo: 'Terminato', verifica: 'PASS' }
  ]);
  assert.equal(u.elementi.get('dlgConferma')?.open || false, false);
  assert.equal(u.chiamateApi.filter(x => x.url.startsWith('/api/conferme/')).length, 0);
  assert.equal(u.win.__orbit.stato().core.nome, 'responding');
});

test('UI: privacy della voce distingue ElevenLabs, Piper e riconoscimento locale o browser', async () => {
  const risposte = { '/api/voce/stato': { motore: 'whisper' } };
  const u = ambienteUI(undefined, risposte); await u.scarica();
  u.sintesi.voci = () => [{ name: '__locale__', etichetta: 'ElevenLabs' }];
  u.sintesi.locale = { disponibile: true, motore: 'ElevenLabs (cloud)', ripiego: 'Paola' };
  await u.win.__orbit.aggiornaVoci();
  assert.match(u.elementi.get('notaVoci').textContent, /inviato a ElevenLabs.*crediti/);
  assert.match(u.elementi.get('notaVoci').textContent, /usa Piper/);
  assert.match(u.elementi.get('notaRiconoscimento').textContent, /Whisper.*Vosk/);
  u.sintesi.locale = { disponibile: true, motore: 'Piper (locale, offline)' };
  risposte['/api/voce/stato'] = { motore: 'browser' };
  await u.win.__orbit.aggiornaVoci();
  assert.match(u.elementi.get('notaVoci').textContent, /Piper.*sul PC/);
  assert.doesNotMatch(u.elementi.get('notaVoci').textContent, /ElevenLabs/);
  assert.match(u.elementi.get('notaRiconoscimento').textContent, /browser puo ricevere l’audio/);
  u.sintesi.locale.elevenlabs = { configurata: true, pronta: false };
  await u.win.__orbit.aggiornaVoci();
  assert.match(u.elementi.get('notaVoci').textContent, /ElevenLabs resta configurato.*cloud/);
  u.sintesi.voci = () => [{ name: 'Browser online', localService: false }];
  await u.elementi.get('selVoce').listeners.change({ target: { value: 'Browser online' } }); await u.scarica();
  assert.match(u.elementi.get('notaVoci').textContent, /Voce del browser.*ricevere il testo/);
  assert.doesNotMatch(u.elementi.get('notaVoci').textContent, /Piper/);
});

test('UI: uno stato vocale HTTP non disponibile non mantiene informazioni precedenti', async () => {
  const { creaSintesiOrbit } = require('../public/voice');
  let ok = true;
  const voce = creaSintesiOrbit({}, { fetchFn: async () => ({ ok, json: async () => ({ disponibile: true, motore: 'Piper' }) }) });
  await voce.inizializza(); assert.equal(voce.locale.disponibile, true);
  ok = false; await voce.inizializza(); assert.equal(voce.locale.disponibile, false);
});
