'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { costruisci, sceltaStoria } = require('../ai/context');
const { costruisciPrompt } = require('../ai/providers/claude-code');
const { stimaToken } = require('../ai/providers/gateway');
const coppia = (q, a) => [{ ruolo: 'user', contenuto: q }, { ruolo: 'assistant', contenuto: a }];
const ctx = (storia, extra = {}) => costruisci({ messaggio: 'Riassumilo', storia,
  classificazione: { serveStoria: true }, maxInputToken: 8000, ...extra });

test('continuita A: assenza, inclusione e taglio sono distinti', () => {
  assert.equal(ctx([]).cronologia.stato, 'assente');
  const storia = [...coppia('Prima domanda', 'Prima risposta'), ...coppia('Seconda domanda', 'Seconda risposta')];
  assert.equal(ctx(storia).cronologia.stato, 'inclusa');
  const t = sceltaStoria(storia.slice(2), 1000).token;
  const s = sceltaStoria(storia, t);
  assert.deepEqual(s.messaggi, storia.slice(2));
  assert.deepEqual(s.indici, [2, 3]);
  assert.equal(s.token, t);
  assert.equal(sceltaStoria(storia, t - 1).messaggi.length, 0);
});

test('continuita A: risposta enorme non lascia domande orfane o antecedenti piu vecchi', () => {
  const storia = [...coppia('Vecchio tema', 'Vecchia risposta'), ...coppia('Tema corrente', 'molto lungo '.repeat(2000))];
  assert.deepEqual(sceltaStoria(storia, 3000).messaggi, []);
  const c = ctx(storia);
  assert.equal(c.cronologia.stato, 'esclusa');
  const prompt = costruisciPrompt({ messages: c.messaggi });
  assert.match(prompt, /Cronologia incompleta/);
  assert.match(prompt, /Riassumilo/);
  assert.doesNotMatch(prompt, /Vecchio tema|Tema corrente/);
});

test('continuita A: sequenze malformate non diventano coppie fittizie', () => {
  const storia = [{ ruolo: 'assistant', contenuto: 'Orfana' }, ...coppia('Q1', 'A1'),
    { ruolo: 'user', contenuto: 'Senza risposta' }, ...coppia('Q2', 'A2')];
  assert.deepEqual(sceltaStoria(storia, 3000).messaggi, storia.slice(4));
  const c = ctx(storia);
  assert.equal(c.cronologia.stato, 'parziale');
  assert.match(c.messaggi.at(-1).content, /Cronologia incompleta/);
});

test('continuita A: profilo, note e richiesta riducono il budget senza perdere il messaggio corrente', () => {
  const storia = coppia('Q', 'risposta '.repeat(70));
  const base = ctx(storia, { maxInputToken: 1000 });
  const pieno = ctx(storia, { maxInputToken: 1000, classificazione: { serveStoria: true, richiamaVault: true },
    memoria: { leggiNota: () => ({ percorso: 'fixture/profilo.md', contenuto: 'profilo '.repeat(90) }),
      contestoPerDomanda: () => ({ testo: 'note '.repeat(100), fonti: [] }) } });
  assert.ok(pieno.cronologia.occupati.profilo > 0);
  assert.ok(pieno.cronologia.occupati.note > 0);
  assert.ok(pieno.cronologia.budgetToken < base.cronologia.budgetToken);
  assert.equal(pieno.storiaUsata, 0);
  assert.match(pieno.messaggi.at(-1).content, /Riassumilo/);
  assert.equal(pieno.tokenStimati, stimaToken(pieno.messaggi.at(-1).content));
});

test('continuita A: richiesta autonoma non include una storia non richiesta', () => {
  const c = ctx(coppia('Q', 'A'), { messaggio: 'come va?', classificazione: { serveStoria: false } });
  assert.equal(c.storiaUsata, 0);
  assert.equal(c.cronologia.motivo, 'non_richiesta');
  assert.doesNotMatch(c.messaggi.at(-1).content, /Cronologia incompleta/);
});

test('continuita A: conversazioni indipendenti non condividono stato nel builder', () => {
  const a = ctx(coppia('Tema A', 'Risposta A'));
  const b = ctx(coppia('Tema B', 'Risposta B'));
  assert.match(costruisciPrompt({ messages: a.messaggi }), /Tema A/);
  assert.doesNotMatch(costruisciPrompt({ messages: b.messaggi }), /Tema A|Risposta A/);
});
