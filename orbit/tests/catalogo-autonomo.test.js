'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifica } = require('../ai/router/classifier');
const { testoAutonomo } = require('../ai/router/testo-autonomo');
const { MockProvider, appProva, settingsProva, chiedi } = require('./helpers');

const ammessi = ['Traduci in inglese: buongiorno a tutti', 'Correggi questo testo: la casa sono bella',
  'Riassumi il seguente paragrafo: Il gruppo prepara una presentazione. Il lavoro procede con ordine.',
  'Riscrivi: Una frase semplice e completa.', 'Traduci in italiano:\nGood morning everyone.'];
const esclusi = ['Traduci in inglese', 'Riassumi: ...', 'Traduci in inglese questo testo: ciao',
  'Traduci il file allegato: buongiorno', 'Riassumi: come discusso sopra', 'Correggi questo testo: vedi la fonte citata',
  'Traduci: according to the attached document', 'Correggi: Apri https://example.test/testo',
  'Traduci: Il mio progetto procede bene', 'Riassumi le mie note', 'Riassumi: C:/documenti/testo.txt',
  'Correggi: [[nota-personale]]', 'Riassumi: Il dosaggio del farmaco aumenta', 'Traduci: medical dosage',
  'Traduci: prima il testo poi controlla il calendario', 'Correggi: salva il risultato nel vault'];

function ambiente(hit = false, produttore) {
  const conteggi = { profilo: 0, rag: 0, strumenti: [] };
  const memoria = { leggiNota: p => { conteggi.profilo++; return { percorso: p, contenuto: 'Preferenza sintetica: chiarezza.' }; },
    contestoPerDomanda: () => { conteggi.rag++; return hit ? { testo: '<nota percorso="fixture/fonte.md">Fonte sintetica.</nota>', fonti: [{ percorso: 'fixture/fonte.md', titolo: 'Fonte' }] } : { testo: '', fonti: [] }; } };
  const provider = new MockProvider({ produttore });
  const app = appProva({ provider, memoria, settings: settingsProva({ limiti: { verificaAI: 'auto' } }) });
  for (const [id, integrazione] of app.integrazioni.integrazioni) {
    app.permessi.impostaAbilitata(id, true);
    integrazione.prerequisiti = async () => ({ ok: true });
    for (const [nome, st] of Object.entries(integrazione.strumenti)) st.esegui = async () => {
      conteggi.strumenti.push(id + '.' + nome);
      return { testo: 'Dato sintetico.', fonti: [], eventi: [], completo: true, totale: 0 };
    };
  }
  app.permessi.impostaLivello('obsidian', 'crea', 'consenti');
  app.permessi.impostaLivello('obsidian', 'amplia', 'consenti');
  return { app, provider, conteggi };
}

test('catalogo autonomo: ammissibilita conservativa e fallback per dipendenze o ambiguita', () => {
  for (const msg of ammessi) assert.equal(testoAutonomo(msg, classifica(msg)), true, msg);
  for (const msg of esclusi) assert.equal(testoAutonomo(msg, classifica(msg)), false, msg);
  const msg = 'Traduci: buongiorno';
  assert.equal(testoAutonomo(msg, classifica(msg, { storia: 2 })), false);
});

test('catalogo autonomo: catalogo omesso, profilo/RAG/gate conservati, nessuna azione anche se proposta dal mock', async () => {
  for (const hit of [false, true]) for (const msg of ammessi) {
    const a = ambiente(hit, () => 'Testo trasformato. <orbit_strumento nome="web.cerca_web">{"domanda":"dato"}</orbit_strumento>' +
      '<orbit_ricorda nota="cervello/INDEX.md" sezione="Fatti">Preferenza contraffatta.</orbit_ricorda>' +
      '<orbit_nota percorso="fixture/fonte.md">Scrittura contraffatta.</orbit_nota>');
    a.app.orchestrator._pianoStrumenti = a.app.orchestrator._preparaScrittura = () => { throw new Error('Pianificazione non ammessa'); };
    try {
      const { r } = await chiedi(a.app, msg);
      assert.equal(r.ok, true); assert.equal(r.verifica, 'PASS', JSON.stringify({ msg, hit, limitazioni: r.limitazioni, testo: r.testo }));
      const p = a.provider.chiamate[0].messages.at(-1).content;
      assert.ok(!p.includes('<strumenti_disponibili>'));
      assert.ok(!p.includes('<capacita_orbit>'));
      assert.ok(!p.includes('<istruzioni_apprendimento>'));
      assert.match(p, /Preferenza sintetica/);
      assert.equal(a.conteggi.profilo, 4); assert.equal(a.conteggi.rag, 1);
      assert.deepEqual(a.conteggi.strumenti, []);
      assert.equal(r.piano.verifica.modo, hit ? 'semantico' : 'deterministico');
      assert.equal(a.provider.chiamate.length, hit ? 2 : 1);
    } finally { a.app.storage.chiudi(); }
  }
});

test('catalogo autonomo: richieste escluse mantengono catalogo, apprendimento e verifica sensibile', async () => {
  for (const msg of ['Traduci: according to the attached document', 'Correggi questo testo: vedi la fonte citata',
    'Riassumi le mie note', 'Riassumi: Il dosaggio del farmaco aumenta']) {
    const a = ambiente();
    try {
      const { r } = await chiedi(a.app, msg);
      assert.equal(r.ok, true);
      if (r.verifica === 'CHIARIMENTO') { assert.equal(a.provider.chiamate.length, 0); continue; }
      const p = a.provider.chiamate[0].messages.at(-1).content;
      assert.ok(p.includes('<strumenti_disponibili>'), msg);
      assert.ok(p.includes('<istruzioni_apprendimento>'), msg);
      if (msg.includes('farmaco')) { assert.equal(r.piano.rischio, 'high'); assert.equal(r.piano.verifica.modo, 'semantico'); assert.notEqual(r.piano.tierIniziale, 'haiku'); }
    } finally { a.app.storage.chiudi(); }
  }
});

test('catalogo autonomo: follow-up e strumenti necessari continuano a funzionare', async () => {
  for (const msg of ['Traduci: buongiorno', 'Riassumi il documento precedente']) {
    const a = ambiente(false, ({ n }) => n === 1 ? '<orbit_strumento nome="obsidian.leggi_nota">{"percorso":"fixture/fonte.md"}</orbit_strumento>' : 'Traduzione sintetica.');
    try {
      const conv = a.app.storage.creaConversazione();
      a.app.storage.aggiungiMessaggio({ conversazione: conv.id, ruolo: 'user', contenuto: 'Materiale precedente sintetico.' });
      a.app.storage.aggiungiMessaggio({ conversazione: conv.id, ruolo: 'assistant', contenuto: 'Risposta precedente sintetica.' });
      const { r } = await chiedi(a.app, msg, { conversazioneId: conv.id });
      assert.equal(r.ok, true);
      assert.ok(a.provider.chiamate[0].messages.at(-1).content.includes('<strumenti_disponibili>'));
      assert.equal(r.piano.contesto.storiaMessaggi, 2);
      assert.deepEqual(a.conteggi.strumenti, ['obsidian.leggi_nota']);
    } finally { a.app.storage.chiudi(); }
  }
});
