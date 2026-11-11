'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifica } = require('../ai/router/classifier');
const { costruisci } = require('../ai/context');
const { costruisciPrompt } = require('../ai/providers/claude-code');
const { testoAutonomo } = require('../ai/router/testo-autonomo');
const { appProva, settingsProva, chiedi } = require('./helpers');
const coppia = (q, a) => [{ ruolo: 'user', contenuto: q }, { ruolo: 'assistant', contenuto: a }];
const traduzione = coppia('Traduci in inglese: buongiorno a tutti', 'Good morning everyone.');
const investimento = coppia('Confronta questi investimenti: fondo A e fondo B', 'I due fondi hanno rischi differenti.');
const cls = (msg, storia) => classifica(msg, { storia, haVault: false });
function salva(app, storia) {
  const c = app.storage.creaConversazione();
  for (const m of storia) app.storage.aggiungiMessaggio({ conversazione: c.id, ...m });
  return c.id;
}
const app = limiti => appProva({ settings: settingsProva({ limiti: { verificaAI: 'auto', ...limiti } }) });

test('continuita B: pronomi e istruzioni lunghe riconoscono lo stesso antecedente', () => {
  for (const msg of ['Riassumilo', 'Ora fallo in francese',
    'Ora fallo in francese mantenendo il tono formale e senza cambiare il significato',
    'Spiegamelo in modo piu semplice', 'Riassumi il testo precedente']) {
    const c = cls(msg, traduzione);
    assert.equal(c.riferimento.stato, 'chiaro', msg);
    assert.equal(c.riferimento.indice, 0);
    assert.equal(c.serveStoria, true);
    assert.equal(c.ambigua, false);
    assert.equal(testoAutonomo(msg, c), false);
    const ctx = costruisci({ messaggio: msg, storia: traduzione, classificazione: c, maxInputToken: 8000 });
    assert.match(costruisciPrompt({ messages: ctx.messaggi }), /Good morning everyone/);
  }
});

test('continuita B: antecedente assente chiede chiarimento anche per frasi lunghe', () => {
  for (const msg of ['Riassumilo', 'Ora fallo in francese mantenendo il tono formale',
    'E quello di prima?', 'Quale conviene?', "Fallo anche per l'altro", 'Qual e la differenza?', 'Spiegamelo in modo piu semplice']) {
    const c = cls(msg, []);
    assert.equal(c.riferimento.stato, 'assente', msg);
    assert.equal(c.ambigua, true, msg);
  }
});

test('continuita B: scelta fra alternative e trasformazione del confronto sono distinte', () => {
  for (const msg of ['Quale conviene?', 'Qual e la differenza?', 'Riassumilo']) {
    const c = cls(msg, investimento);
    assert.equal(c.riferimento.stato, 'chiaro');
    assert.equal(c.rischio, 'high');
  }
  for (const msg of ["Fallo anche per l'altro", 'E quello di prima?']) {
    const c = cls(msg, investimento);
    assert.equal(c.riferimento.stato, 'ambiguo');
    assert.equal(c.ambigua, true);
    assert.equal(c.rischio, 'high');
  }
  assert.equal(cls('Quale conviene?', traduzione).riferimento.stato, 'ambiguo');
  assert.equal(cls('Qual e la differenza?', traduzione).ambigua, true);
});

test('continuita B: tema esplicito non adiacente e riferimento generico ambiguo', () => {
  const storia = [...investimento, ...coppia('Spiegami il ciclo dell acqua', 'Evaporazione e condensazione.')];
  const c = cls('Tornando agli investimenti, quale conviene?', storia);
  assert.equal(c.riferimento.indice, 0);
  assert.equal(c.rischio, 'high');
  assert.equal(cls('E quello di prima?', storia).riferimento.stato, 'ambiguo');
  assert.equal(cls('Tornando ai treni, quale conviene?', storia).riferimento.stato, 'assente');
  assert.equal(cls('Riassumilo', storia).rischio, 'low');
});

test('continuita B: cambio autentico di tema e richieste autonome non ereditano high', () => {
  for (const msg of ['Cambiamo argomento: raccontami una fiaba', 'Ora parliamo di cucina',
    'Qual e la capitale della Francia?', 'E la capitale della Francia?', 'come va?', 'Fai un elenco dei numeri primi minori di venti',
    'Traduci in inglese: buongiorno a tutti']) {
    const c = cls(msg, investimento);
    assert.equal(c.rischio, 'low', msg);
    assert.equal(c.ambigua, false, msg);
    assert.ok(['autonoma', 'cambio_argomento'].includes(c.riferimento.stato));
  }
  assert.equal(cls('Cambiamo argomento: raccontami una fiaba', investimento).serveStoria, false);
  assert.equal(cls('come va?', investimento).serveStoria, false);
  const nuovo = cls('Traduci in inglese: buongiorno a tutti', []);
  assert.equal(testoAutonomo('Traduci in inglese: buongiorno a tutti', nuovo), true);
});

test('continuita B: rischio e dipendenze si conservano attraverso piu follow-up', () => {
  const storia = [...investimento, ...coppia('Quale conviene?', 'La scelta dipende dalle condizioni.'),
    ...coppia('Spiegamelo in modo piu semplice', 'Bisogna considerare le condizioni.')];
  const c = cls('Riassumilo', storia);
  assert.equal(c.rischio, 'high');
  assert.deepEqual(c.riferimento.necessari.sort(), [0, 2, 4]);
  const lunga = [...investimento];
  for (let i = 0; i < 18; i++) lunga.push(...coppia('E quello di prima?', 'Risposta sintetica.'));
  assert.equal(cls('E quello di prima?', lunga).rischio, 'high');
});

test('continuita B: turni orfani o chiarimenti non diventano materiale da trasformare', () => {
  assert.equal(cls('Riassumilo', [...traduzione, { ruolo: 'user', contenuto: 'Domanda non completata' }]).ambigua, true);
  const storia = coppia('Riassumilo', 'Quale testo?');
  storia[1].verifica = 'CHIARIMENTO';
  assert.equal(cls('Ora fallo in francese', storia).ambigua, true);
});

test('continuita B: prompt effettivo, rischio high e Quality Gate semantico nel flusso mock', async () => {
  const a = app();
  try {
    const id = salva(a, [...investimento, ...coppia('Spiegami il ciclo dell acqua', 'Evaporazione.')]);
    const { r } = await chiedi(a, 'Tornando agli investimenti, quale conviene?', { conversazioneId: id });
    assert.equal(r.verifica, 'PASS');
    assert.equal(r.piano.rischio, 'high');
    assert.equal(r.piano.verifica.modo, 'semantico');
    assert.notEqual(r.piano.tierIniziale, 'haiku');
    assert.equal(a.provider.chiamate.length, 2);
    const prompt = costruisciPrompt(a.provider.chiamate[0]);
    assert.match(prompt, /fondo A e fondo B/);
    assert.match(prompt, /Tornando agli investimenti/);
  } finally { a.storage.chiudi(); }
});

test('continuita B: antecedente enorme escluso porta a chiarimento senza modello o strumenti', async () => {
  const a = app();
  try {
    const id = salva(a, coppia('Confronta questi investimenti', 'Risposta lunga '.repeat(2000)));
    a.integrazioni.esegui = () => { throw new Error('Non deve eseguire strumenti'); };
    const { r, eventi } = await chiedi(a, 'Quale conviene?', { conversazioneId: id });
    assert.equal(r.verifica, 'CHIARIMENTO');
    assert.equal(a.provider.chiamate.length, 0);
    assert.equal(eventi.find(e => e.tipo === 'contesto_pronto').cronologia.stato, 'esclusa');
    assert.match(r.testo, /non entra nel contesto/);
  } finally { a.storage.chiudi(); }
});

test('continuita B: catena recente inclusa ma radice esclusa non consente una risposta inventata', async () => {
  const a = app();
  try {
    const id = salva(a, [...coppia('Confronta questi investimenti', 'Risposta lunga '.repeat(2000)),
      ...coppia('Quale conviene?', 'Dipende dalle condizioni.')]);
    const { r, eventi } = await chiedi(a, 'Spiegamelo in modo piu semplice', { conversazioneId: id });
    assert.equal(eventi.find(e => e.tipo === 'contesto_pronto').storia, 2);
    assert.equal(r.verifica, 'CHIARIMENTO');
    assert.equal(a.provider.chiamate.length, 0);
  } finally { a.storage.chiudi(); }
});

test('continuita B: nuove conversazioni e riferimenti ambigui non invocano il provider', async () => {
  const a = app();
  try {
    salva(a, traduzione);
    const { r } = await chiedi(a, 'Riassumilo');
    assert.equal(r.verifica, 'CHIARIMENTO');
    const id = salva(a, investimento);
    assert.equal((await chiedi(a, "Fallo anche per l'altro", { conversazioneId: id })).r.verifica, 'CHIARIMENTO');
    assert.equal(a.provider.chiamate.length, 0);
  } finally { a.storage.chiudi(); }
});

test('continuita B: conversazione low isolata da high e compatibilita vocale del prompt', async () => {
  const a = app();
  try {
    salva(a, investimento);
    const id = salva(a, traduzione);
    const { r } = await chiedi(a, 'Ora fallo in francese mantenendo il tono formale e senza cambiare il significato',
      { conversazioneId: id, voce: true });
    assert.equal(r.piano.rischio, 'low');
    assert.equal(r.piano.contesto.storiaMessaggi, 2);
    const prompt = costruisciPrompt(a.provider.chiamate[0]);
    assert.match(prompt, /Good morning everyone/);
    assert.doesNotMatch(prompt, /investimenti|fondo A/);
    assert.match(a.provider.chiamate[0].system, /Mai percorsi di file/);
  } finally { a.storage.chiudi(); }
});
