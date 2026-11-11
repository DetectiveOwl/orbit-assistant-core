'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const guard = require('./guard.cjs');
const { leggiSnapshot, descrivi } = require('../reader');
const { pianifica, verificaPiano, candidati } = require('../planner');
const { sha, impronta } = require('../policy');
const examples = {};
const leggi = (name, extra = {}) => leggiSnapshot({ radice: path.join(guard.root, 'data', name), autorizzati: ['liste'], creaIn: ['liste'], verificaReparse: guard.verificaReparse, ...extra });
const valuta = (equivalenti = [], incerti = []) => ({ candidati: list }) => ({ valutazioni: list.map(n => ({ percorso: n.percorso, sha256: n.sha256,
  relazione: equivalenti.includes(n.percorso) ? 'equivalente' : incerti.includes(n.percorso) ? 'incerta' : 'distinta', confidence: 0.01 })) });
const crea = { 'to sort/Ricette.md': 'liste' };
const clone = x => JSON.parse(JSON.stringify(x));
function reseal(s) { delete s.impronta; s.impronta = impronta(s); return s; }

test('TS2: API contiene solo candidati, pianificazione e verifica senza esecuzione', () => {
  assert.deepEqual(Object.keys(require('../planner')).sort(), ['candidati', 'pianifica', 'verificaPiano']);
});

test('TS2: Film da guardare verso Film da vedere possibile MERGE con contenuti originali e verifica', async () => {
  const s = leggi('film');
  assert.equal(candidati(s.sorgenti[0], s.catalogo)[0].nota.percorso, 'liste/Film da vedere.md');
  const p = await pianifica(s, { valuta: valuta(['liste/Film da vedere.md']) });
  assert.equal(p.decisioni[0].esito, 'MERGE'); assert.equal(p.operazioni[0].aggiunte[0].content, '- Dune');
  assert.equal(p.operazioni[0].destinazione.percorso, 'liste/Film da vedere.md');
  assert.deepEqual(verificaPiano(p, s), { valido: true, motivi: [] });
  assert.ok(p.decisioni[0].conferme.includes('consenso-utente')); examples.merge = p;
});

test('TS2: Film gia visti resta distinto anche con proposta equivalente e confidence alta', async () => {
  const p = await pianifica(leggi('visto'), { valuta: ({ candidati: list }) => ({ valutazioni: list.map(n => ({
    percorso: n.percorso, sha256: n.sha256, relazione: 'equivalente', confidence: 1 })) }) });
  assert.equal(p.decisioni[0].esito, 'CONFIRM'); assert.equal(p.operazioni.length, 0); examples.visto = p;
});

for (const name of ['noop', 'titolo']) test('TS2: identico o solo titolo verso nota esistente NOOP: ' + name, async () => {
  const p = await pianifica(leggi(name));
  assert.equal(p.decisioni[0].esito, 'NOOP'); assert.equal(p.operazioni.length, 0); assert.equal(p.semantica.chiamate, 0);
  examples[name] = p;
});

test('TS2: due note plausibili CONFIRM prima della proposta semantica', async () => {
  let calls = 0;
  const p = await pianifica(leggi('doppio'), { valuta: () => { calls++; throw new Error('Non necessario'); } });
  assert.equal(p.decisioni[0].esito, 'CONFIRM'); assert.equal(calls, 0); examples.ambiguo = p;
});

for (const name of ['protetto', 'operativo', 'assoluto']) test('TS2: riferimento diretto a file protetto BLOCK: ' + name, async () => {
  let calls = 0; const p = await pianifica(leggi(name), { valuta: () => { calls++; } });
  assert.equal(p.decisioni[0].esito, 'BLOCK'); assert.equal(p.operazioni.length, 0); assert.equal(calls, 0); examples[name] = p;
});

test('TS2: destinazioni protette, inventate e contenuti del modello non superano policy e contratto', async () => {
  for (const dest of ['scadenze/Profilo.md', 'progetti/Orbit/bug.md', '../fuori.md', 'liste/Inventata.md']) {
    const p = await pianifica(leggi('film'), { valuta: () => ({ valutazioni: [{ percorso: dest, sha256: 'inventato', relazione: 'equivalente' }] }) });
    assert.equal(p.decisioni[0].esito, 'BLOCK', dest); assert.equal(p.operazioni.length, 0);
  }
  const p = await pianifica(leggi('film'), { valuta: ({ candidati: list }) => ({ valutazioni: list.map(n => ({
    percorso: n.percorso, sha256: n.sha256, relazione: 'equivalente', content: 'CONTENUTO INVENTATO' })) }) });
  assert.equal(p.decisioni[0].esito, 'BLOCK');
});

test('TS2: punteggio lessicale o confidence da soli non provano identita', async () => {
  assert.equal((await pianifica(leggi('film'))).decisioni[0].esito, 'CONFIRM');
  const p = await pianifica(leggi('film'), { valuta: valuta() });
  assert.equal(p.decisioni[0].esito, 'CONFIRM'); assert.equal(p.operazioni.length, 0);
});

test('TS2: CREATE solo con assenza nell ambito e directory certa esistente', async () => {
  const s = leggi('crea'), p = await pianifica(s, { creaIn: crea });
  assert.equal(p.decisioni[0].esito, 'CREATE'); assert.equal(p.semantica.chiamate, 0);
  assert.equal(p.operazioni[0].content, s.sorgenti[0].testo); assert.equal(p.operazioni[0].destinazione.percorso, 'liste/Ricette.md');
  assert.equal(verificaPiano(p, s).valido, true); examples.create = p;
  assert.equal((await pianifica(s)).decisioni[0].esito, 'CONFIRM');
  assert.equal((await pianifica(s, { creaIn: { 'to sort/Ricette.md': 'liste/inesistente' } })).decisioni[0].esito, 'BLOCK');
});

test('TS2: catalogo non vuoto richiede valutazione esaustiva a lotti: copertura incompleta (budget) non dimostra l assenza', async () => {
  const s = leggi('assenza');
  assert.equal((await pianifica(s, { creaIn: crea })).decisioni[0].esito, 'CONFIRM');
  assert.equal((await pianifica(s, { creaIn: crea, valuta: valuta() })).decisioni[0].esito, 'CREATE');
  // lotti di 1 nota: con budget per un solo confronto il catalogo non e coperto => CONFIRM; con budget sufficiente tutti i lotti sono valutati e l'assenza e dimostrata
  const p = await pianifica(leggi('top'), { creaIn: crea, valuta: valuta(), maxCandidati: 1, maxChiamate: 1 });
  assert.equal(p.decisioni[0].esito, 'CONFIRM'); assert.equal(p.operazioni.length, 0); assert.ok(p.decisioni[0].motivi.includes('BUDGET_SEMANTICO_ESAURITO')); examples.top = p;
  assert.equal((await pianifica(leggi('top'), { creaIn: crea, valuta: valuta(), maxCandidati: 1, maxChiamate: 50 })).decisioni[0].esito, 'CREATE');
});

test('TS2: nome gia occupato da una directory non diventa una creazione', async () => {
  const p = await pianifica(leggi('directoryEsistente'), { creaIn: crea });
  assert.equal(p.decisioni[0].esito, 'CONFIRM'); assert.equal(p.operazioni.length, 0);
});

test('TS2: catalogo incompleto non autorizza CREATE neanche se il modello propone assenza', async () => {
  const s = leggi('assenza', { limiti: { maxFileBytes: 20 } });
  const p = await pianifica(s, { creaIn: crea, valuta: valuta() });
  assert.equal(s.copertura.completa, false);
  assert.ok(p.decisioni.every(d => d.esito !== 'CREATE')); assert.equal(p.operazioni.length, 0); examples.incompleto = p;
});

for (const name of ['checkbox', 'negazione']) test('TS2: differenze di stato preservate richiedono conferma: ' + name, async () => {
  const p = await pianifica(leggi(name), { valuta: valuta(['liste/Film da vedere.md']) });
  assert.equal(p.decisioni[0].esito, 'CONFIRM'); assert.equal(p.operazioni.length, 0); examples[name] = p;
});

test('TS2: piu input e duplicati interni non duplicano aggiunte nella stessa destinazione', async () => {
  const s = leggi('multipli'), options = { valuta: valuta(['liste/Film da vedere.md']) };
  const p = await pianifica(s, options);
  assert.deepEqual(p.operazioni.flatMap(o => o.aggiunte.map(u => u.content)), ['- Dune', '- Alien']);
  assert.equal(verificaPiano(p, s).valido, true);
  const again = await pianifica(s, options); assert.equal(again.id, p.id); assert.equal(again.impronta, p.impronta);
  examples.multipli = p;
});

test('TS2: due input identici per la stessa nuova nota propongono una sola creazione', async () => {
  const s = leggi('nuovoDoppio');
  const p = await pianifica(s, { creaIn: Object.fromEntries(s.sorgenti.map(n => [n.percorso, 'liste'])) });
  assert.deepEqual(p.decisioni.map(d => d.esito), ['CREATE', 'NOOP']); assert.equal(p.operazioni.length, 1);
});

test('TS2: riesecuzione su contenuto gia presente NOOP e piano vecchio invalidato', async () => {
  const s = leggi('film'), p = await pianifica(s, { valuta: valuta(['liste/Film da vedere.md']) });
  const fresh = clone(s), i = fresh.catalogo.findIndex(n => n.percorso === 'liste/Film da vedere.md');
  const text = fresh.catalogo[i].testo + '- Dune\n';
  fresh.catalogo[i] = descrivi(text, fresh.catalogo[i].percorso, sha(Buffer.from(text))); reseal(fresh);
  assert.equal(verificaPiano(p, fresh).valido, false);
  assert.equal((await pianifica(fresh)).decisioni[0].esito, 'NOOP');
});

test('TS2: alterazioni del piano, contenuti non originali e duplicazioni sono rilevate', async () => {
  const s = leggi('film'), p = await pianifica(s, { valuta: valuta(['liste/Film da vedere.md']) });
  const modified = clone(p); modified.operazioni[0].aggiunte[0].content = '- Inventato';
  assert.equal(verificaPiano(modified, s).valido, false);
  const { id, impronta: oldHash, ...body } = modified; const hash = impronta(body);
  assert.equal(verificaPiano({ ...body, id: 'piano-' + hash.slice(0, 24), impronta: hash }, s).valido, false);
  const duplicate = clone(p); duplicate.operazioni.push(clone(duplicate.operazioni[0]));
  const { id: unusedId, impronta: unusedHash, ...b } = duplicate; const h = impronta(b);
  assert.equal(verificaPiano({ ...b, id: 'piano-' + h.slice(0, 24), impronta: h }, s).valido, false);
});

test('TS2: spostamenti P5 sintetici invalidano percorsi e impronta senza usare mappe reali', async () => {
  const s = leggi('p5', { autorizzati: ['corsi'], creaIn: [] });
  const p = await pianifica(s, { valuta: valuta(['corsi/Analisi Matematica 1/Analisi Matematica 1.md']) });
  const moved = clone(s); moved.catalogo[0].percorso = 'corsi/Analisi/Indice aggiornato.md'; reseal(moved);
  assert.equal(verificaPiano(p, moved).valido, false);
  const other = clone(s); other.rootId = sha('altra-radice-sintetica'); reseal(other);
  assert.equal(verificaPiano(p, other).valido, false); examples.p5 = { piano: p, verificaDopoSpostamento: verificaPiano(p, moved) };
});

test('TS2: budget, timeout, output parziale e incertezza non producono false certezze', async () => {
  assert.equal((await pianifica(leggi('multipli'), { maxChiamate: 1, valuta: valuta(['liste/Film da vedere.md']) })).semantica.chiamate, 1);
  const timeout = await pianifica(leggi('film'), { timeoutMs: 10, valuta: () => new Promise(() => {}) });
  assert.equal(timeout.decisioni[0].esito, 'CONFIRM'); assert.ok(timeout.decisioni[0].motivi.includes('TIMEOUT_SEMANTICO'));
  const partial = await pianifica(leggi('film'), { valuta: () => ({ valutazioni: [] }) });
  assert.equal(partial.decisioni[0].esito, 'CONFIRM');
  const uncertain = await pianifica(leggi('film'), { valuta: valuta(['liste/Film da vedere.md'], ['liste/Film già visti.md']) });
  assert.equal(uncertain.decisioni[0].esito, 'CONFIRM');
  assert.equal((await pianifica(leggi('film'), { maxCaratteri: 1, valuta: valuta() })).semantica.chiamate, 0);
});

for (const name of ['nomeGenerico', 'nomeGenericoMerge', 'aliasDiscordante', 'linkDiverso']) {
  test('TS2 audit: indizi non provano identita anche con mock fuorviante: ' + name, async () => {
    const s = leggi(name), p = await pianifica(s, { valuta: valuta(s.catalogo.map(n => n.percorso)) });
    assert.equal(p.decisioni[0].esito, 'CONFIRM'); assert.equal(p.operazioni.length, 0);
  });
}

function sigillaPiano(p) {
  const { id, impronta: old, ...body } = p, hash = impronta(body);
  return { ...body, id: 'piano-' + hash.slice(0, 24), impronta: hash };
}

test('TS2 audit: verificaPiano respinge MERGE con sola identita apparente anche con hash ricalcolato', async () => {
  const s = leggi('nomeGenericoMerge'), p = clone(await pianifica(s)), source = s.sorgenti[0], target = s.catalogo[0];
  p.decisioni[0].esito = 'MERGE'; p.decisioni[0].destinazione = { percorso: target.percorso, sha256: target.sha256 };
  p.operazioni = [{ inputId: p.decisioni[0].id, tipo: 'append_units', sorgente: p.decisioni[0].sorgente,
    destinazione: p.decisioni[0].destinazione, aggiunte: source.unita }];
  assert.equal(verificaPiano(sigillaPiano(p), s).valido, false);
});

test('TS2 audit: nomi diversi con testo e identita identici producono una sola CREATE', async () => {
  const s = leggi('nuoveIdentiche'), p = await pianifica(s, { creaIn: { 'to sort/A.md': 'liste', 'to sort/B.md': 'liste' } });
  assert.deepEqual(p.decisioni.map(d => d.esito), ['CREATE', 'NOOP']); assert.equal(p.operazioni.length, 1);
  assert.equal(verificaPiano(p, s).valido, true); examples.nuoveIdentiche = p;
});

test('TS2 audit: testi identici destinati a directory diverse richiedono conferma', async () => {
  const s = leggi('nuoveIdentiche', { creaIn: ['liste', 'liste/altre'] });
  const p = await pianifica(s, { creaIn: { 'to sort/A.md': 'liste', 'to sort/B.md': 'liste/altre' } });
  assert.deepEqual(p.decisioni.map(d => d.esito), ['CREATE', 'CONFIRM']); assert.equal(p.operazioni.length, 1);
});

for (const name of ['nuoveIncerte', 'nuoveSenzaTitolo', 'nuoveUnitaComuni']) test('TS2 audit: nuove identita incerte non si deduplicano aggressivamente: ' + name, async () => {
  const s = leggi(name), p = await pianifica(s, { creaIn: Object.fromEntries(s.sorgenti.map(n => [n.percorso, 'liste'])) });
  assert.deepEqual(p.decisioni.map(d => d.esito), ['CREATE', 'CONFIRM']); assert.equal(p.operazioni.length, 1);
});

test('TS2 audit: verificaPiano respinge anche NOOP con titoli discordanti e corpo identico', async () => {
  const s = leggi('nomeGenerico'), p = clone(await pianifica(s));
  p.decisioni[0].esito = 'NOOP'; p.decisioni[0].destinazione = { percorso: s.catalogo[0].percorso, sha256: s.catalogo[0].sha256 };
  assert.equal(verificaPiano(sigillaPiano(p), s).valido, false);
});

test('TS2 audit: contenuti e intenzioni distinti conservano due CREATE', async () => {
  const s = leggi('nuoveDistinte'), p = await pianifica(s, { creaIn: { 'to sort/A.md': 'liste', 'to sort/B.md': 'liste' } });
  assert.deepEqual(p.decisioni.map(d => d.esito), ['CREATE', 'CREATE']); assert.equal(verificaPiano(p, s).valido, true);
});

test('TS2 audit: verificaPiano respinge due CREATE equivalenti con nomi diversi', async () => {
  const s = leggi('nuoveIdentiche'), p = clone(await pianifica(s, { creaIn: { 'to sort/A.md': 'liste', 'to sort/B.md': 'liste' } }));
  const d = p.decisioni[1], source = s.sorgenti[1];
  d.esito = 'CREATE'; d.conferme = ['consenso-utente']; d.destinazione = { percorso: 'liste/B.md', sha256: null };
  p.operazioni = [p.operazioni[0], { inputId: d.id, tipo: 'create_note', sorgente: d.sorgente, destinazione: d.destinazione, content: source.testo }];
  assert.equal(verificaPiano(sigillaPiano(p), s).valido, false);
});

test('TS2 audit: fence differenti si aggiungono interi senza deduplicazione parziale', async () => {
  const s = leggi('fence'), p = await pianifica(s, { valuta: valuta(['liste/Codice.md']) });
  assert.equal(p.decisioni[0].esito, 'MERGE'); assert.equal(p.operazioni[0].aggiunte.length, 1);
  const u = p.operazioni[0].aggiunte[0]; assert.equal(u.kind, 'code');
  assert.equal(u.content, '````md\nprima\n```\n- interno\n````');
  assert.equal(s.sorgenti[0].testo.slice(u.start, u.end), u.content); assert.equal(verificaPiano(p, s).valido, true);
});

test('TS2 audit: fence non supportati restano segnalati e bloccano automatismi sulla nota', async () => {
  const s = leggi('fenceNonSupportato'), p = await pianifica(s, { valuta: valuta(['liste/Codice.md']) });
  assert.ok(s.copertura.problemi.some(x => x.code === 'MARKDOWN_PARZIALMENTE_SUPPORTATO')); assert.equal(p.decisioni[0].esito, 'CONFIRM');
  assert.equal(p.operazioni.length, 0); assert.equal(p.semantica.chiamate, 0);
});

for (const name of ['hashLetterale', 'hashDiversi']) test('TS2 hash: titoli distinti non diventano NOOP nemmeno con mock equivalente: ' + name, async () => {
  const s = leggi(name), p = await pianifica(s, { valuta: valuta(s.catalogo.map(n => n.percorso)) });
  assert.equal(p.decisioni[0].esito, 'CONFIRM'); assert.equal(p.operazioni.length, 0);
});

test('TS2 hash: NOOP contraffatto con hash ricalcolato non supera il verificatore', async () => {
  const s = leggi('hashLetterale'), p = clone(await pianifica(s));
  p.decisioni[0].esito = 'NOOP'; p.decisioni[0].destinazione = { percorso: s.catalogo[0].percorso, sha256: s.catalogo[0].sha256 };
  assert.equal(verificaPiano(sigillaPiano(p), s).valido, false);
});

test('TS2 hash: chiusura Markdown legittima mantiene NOOP fra titoli letterali identici', async () => {
  const s = leggi('hashChiusura'), p = await pianifica(s);
  assert.equal(p.decisioni[0].esito, 'NOOP'); assert.equal(p.semantica.chiamate, 0);
  assert.equal(verificaPiano(p, s).valido, true);
});

test('TS2 hash: note nuove solo titolo con identita distinte mantengono due CREATE', async () => {
  const s = leggi('nuoveHash'), p = await pianifica(s, { creaIn: { 'to sort/A.md': 'liste', 'to sort/B.md': 'liste' } });
  assert.deepEqual(p.decisioni.map(d => d.esito), ['CREATE', 'CREATE']);
  assert.equal(verificaPiano(p, s).valido, true);
});

test.after(() => fs.writeFileSync(path.join(guard.root, 'tmp/piani-sintetici.json'), JSON.stringify(examples, null, 2)));
