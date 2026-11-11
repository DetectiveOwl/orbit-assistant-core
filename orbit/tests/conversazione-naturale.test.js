'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifica } = require('../ai/router/classifier');
const { appProva, settingsProva, chiedi } = require('./helpers');

function fixture() {
  const letture = { profilo: 0, rag: 0 };
  const memoria = {
    leggiNota(p) { letture.profilo++; return { percorso: p, contenuto: 'Preferenza sintetica: risposte brevi.' }; },
    contestoPerDomanda() { letture.rag++; return { testo: '<nota percorso="fixture/progetto.md">Progetto sintetico.</nota>', fonti: [{ percorso: 'fixture/progetto.md', titolo: 'Progetto' }] }; }
  };
  return { app: appProva({ memoria, settings: settingsProva({ limiti: { verificaAI: 'auto' } }) }), letture };
}

test('conversazione: formule autonome evitano RAG, conservano profilo e istruzioni naturali anche in voce', async () => {
  for (const msg of ['Ciao', 'Come va?', 'come va', 'Tutto bene?', 'Buongiorno', 'Ciao Orbit, come stai oggi?', 'Ehi, tutto a posto?', 'Come te la passi?']) {
    for (const voce of [false, true]) {
      const { app, letture } = fixture();
      try {
        const { r } = await chiedi(app, msg, { voce });
        assert.equal(r.piano.categoria, 'chitchat', msg);
        assert.equal(r.piano.agente, 'conversazione');
        assert.equal(r.piano.tierIniziale, 'haiku');
        assert.equal(r.piano.verifica.modo, 'deterministico');
        assert.equal(letture.rag, 0); assert.equal(letture.profilo, 4);
        assert.equal(app.provider.chiamate.length, 1);
        const prod = app.provider.chiamate[0];
        assert.match(prod.messages.at(-1).content, /Preferenza sintetica/);
        assert.match(prod.system, /Non aggiungere resoconti spontanei/);
        assert.match(prod.system, /Spiegali quando richiesti/);
        assert.match(prod.system, /senza nascondere errori effettivi/);
        if (voce) assert.match(prod.system, /Mai percorsi di file/);
      } finally { app.storage.chiudi(); }
    }
  }
});

test('conversazione: messaggio intero, domande personali, tecniche e composte non sono saluti', () => {
  for (const msg of ['Come va il mio progetto?', 'Tutto bene con il contratto?', 'Ciao, quale farmaco devo prendere?',
    'Ciao, che impegni ho oggi?', 'Come funziona la tua memoria?', 'Quali note hai consultato per rispondermi?',
    'Controlla se hai salvato qualcosa nel vault', 'Ciao, leggi le mie note', 'Come va? Ho un progetto da organizzare.']) {
    const c = classifica(msg, { storia: 2 });
    assert.notEqual(c.categoria, 'chitchat', msg);
    assert.ok(c.richiamaVault || c.cercaNelVault, msg);
  }
  assert.equal(classifica('Tutto bene con il contratto?').rischio, 'high');
  assert.equal(classifica('Ciao, quale farmaco devo prendere?').rischio, 'high');
});

test('conversazione: follow-up mantiene cronologia e richieste personali mantengono fonti', async () => {
  for (const msg of ['Come va il mio progetto?', 'Spiegamelo meglio.', 'Quali note hai consultato per rispondermi?', 'Come funziona la tua memoria?']) {
    const { app, letture } = fixture();
    try {
      const conv = app.storage.creaConversazione();
      app.storage.aggiungiMessaggio({ conversazione: conv.id, ruolo: 'user', contenuto: 'Progetto sintetico precedente.' });
      app.storage.aggiungiMessaggio({ conversazione: conv.id, ruolo: 'assistant', contenuto: 'Stato sintetico precedente.' });
      const { r } = await chiedi(app, msg, { conversazioneId: conv.id });
      assert.equal(letture.rag, 1); assert.equal(r.fonti[0].percorso, 'fixture/progetto.md');
      assert.equal(r.piano.contesto.storiaMessaggi, 2);
    } finally { app.storage.chiudi(); }
  }
});

test('conversazione: calendario conserva lettura deterministica con fixture', async () => {
  const { app } = fixture();
  app.permessi.impostaAbilitata('google', true);
  const google = app.integrazioni.integrazioni.get('google');
  google.prerequisiti = async () => ({ ok: true });
  google.strumenti.elenca_eventi.esegui = async () => ({ eventi: [], completo: true, totale: 0 });
  try {
    const { eventi } = await chiedi(app, 'Che impegni ho oggi?');
    assert.ok(eventi.some(e => e.tipo === 'strumento_fine' && e.nome === 'google.elenca_eventi' && e.ok));
  } finally { app.storage.chiudi(); }
});
