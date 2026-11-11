'use strict';
// Solo note inventate: aspettative fissate prima del fix, stesso retrieval della chat e degli strumenti.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-memoria-fase2-'));
const V = path.join(BASE, 'vault');
fs.mkdirSync(path.join(V, '.obsidian'), { recursive: true });
const scrivi = (p, testo) => { const f = path.join(V, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, testo); };
scrivi('astronomia.md', '# Quasar\nIl quasar e un nucleo galattico luminoso.\n');
scrivi('sezioni.md', ['Prima', 'Seconda', 'Terza'].map(h => '# ' + h + '\nprovenienzaaudit: ' + 'contenuto documentato '.repeat(12) + '\n').join('\n'));
for (let i = 0; i < 90; i++) scrivi('fuori/' + i + '.md', '# Cristallino\ncristallino.\n');
for (const dir of ['dentro', 'dentro_simile', 'dentro%']) scrivi(dir + '/bersaglio.md', '# Lezione\ncristallino. ' + 'contenuto generico '.repeat(450) + '\n');
scrivi('sigle.md', '# Satellite\nSistema di Navigazione Sintetico (SNS) per la navigazione. [[strumenti]]\n');
scrivi('strumenti.md', '# Strumenti\nIl satellite usa una antenna. [[sigle]]\n');
scrivi('confronto/a.md', '# Orion\nIl progetto Orion termina lunedi.\n');
scrivi('confronto/b.md', '# Orion\nIl progetto Orion termina martedi.\n');
scrivi('AGENTS.md', '# Istruzioni\nquasar segretoescluso\n');
process.env.ORBIT_VAULT_PATH = V;
process.env.ORBIT_INDEX_DIR = path.join(BASE, 'index');
process.env.ORBIT_ENV_FILE = path.join(BASE, 'empty.env');
fs.writeFileSync(process.env.ORBIT_ENV_FILE, '');
const memoria = require('../../memoria/memoria');
const ricerca = require('../../memoria/ricerca');
const { costruisci } = require('../ai/context');
const { classifica } = require('../ai/router/classifier');
assert.equal(memoria.avvia().ok, true);
const percorsi = (q, o) => memoria.cercaNote(q, o).map(n => n.percorso);
const hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const note = []; (function scan(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) scan(p); else note.push([p, hash(p)]); } })(V);

test('Fase2: query naturale conserva il tema, nella chat e negli strumenti', () => {
  for (const q of ['quasar', 'Cerca nei miei appunti la spiegazione del quasar', 'Trova nelle mie note informazioni sul quasar']) {
    assert.deepEqual(percorsi(q), ['astronomia.md'], q);
    const c = costruisci({ messaggio: q, classificazione: { ...classifica(q), richiamaVault: true }, memoria, maxInputToken: 12000 });
    assert.ok(c.fonti.some(f => f.percorso === 'astronomia.md'), q);
    assert.match(c.messaggi.at(-1).content, /nucleo galattico luminoso/);
  }
});

test('Fase2: normalizzazione conservativa, negazioni e termini significativi conservati', () => {
  assert.deepEqual(ricerca.analizzaQuery('Cerca nei miei appunti quasar non luminoso').termini, ['quasar', 'non', 'luminoso']);
  assert.deepEqual(ricerca.analizzaQuery('la spiegazione e incompleta').termini, ['spiegazione', 'incompleta']);
  assert.deepEqual(ricerca.analizzaQuery('Cerca nei miei appunti la spiegazione del progetto appunti').termini, ['progetto', 'appunti']);
  assert.deepEqual(percorsi('Cerca nei miei appunti la spiegazione della carbonara'), []);
});

test('Fase2: filtro cartella prima del limite candidati, chiavi cache distinte', () => {
  percorsi('cristallino');
  for (const dir of ['dentro', 'dentro_simile', 'dentro%']) {
    assert.deepEqual(percorsi('cristallino', { cartella: dir }), [dir + '/bersaglio.md']);
    assert.deepEqual(percorsi('cartella:' + dir + ' cristallino'), [dir + '/bersaglio.md']);
    assert.ok(memoria.contestoPerDomanda('cartella:' + dir + ' cristallino').fonti.every(f => f.percorso.startsWith(dir + '/')));
  }
  assert.deepEqual(percorsi('cristallino', { cartella: '../' }), []);
  assert.deepEqual(percorsi('cristallino', { cartella: 'assente' }), []);
});

test('Fase2: tag e cartella restano filtri anche prima del ranking per sezioni', () => {
  scrivi('dentro/taggata.md', '---\ntags: [ottica]\n---\n# Lezione\ncristallino.\n');
  memoria.notificaModifica(['dentro/taggata.md']);
  assert.deepEqual(percorsi('cristallino tag:ottica', { cartella: 'dentro' }), ['dentro/taggata.md']);
  const m = ricerca.motore();
  assert.deepEqual(m.cercaSezioni('cristallino', { cartella: 'dentro', tag: 'ottica' }).sezioni.map(s => s.percorso), ['dentro/taggata.md']);
  assert.deepEqual(m.cercaSezioni('cristallino', { cartella: 'dentro', tag: 'assente' }).sezioni, []);
  assert.deepEqual(m.cercaSezioni('cartella:dentro tag:ottica cristallino').sezioni.map(s => s.percorso), ['dentro/taggata.md']);
  fs.unlinkSync(path.join(V, 'dentro/taggata.md')); memoria.notificaModifica(['dentro/taggata.md']);
});

test('Fase2: provenienza delle sole sezioni emesse, con frammenti e posizioni originali', () => {
  for (const maxCaratteri of [0, 1, 100, 380, 16000]) {
    const c = memoria.contestoPerDomanda('provenienzaaudit', { maxCaratteri });
    const emesse = [...c.testo.matchAll(/<sezione percorso="([^"]*)"/g)].map(m => m[1]);
    assert.deepEqual(c.fonti.flatMap(f => f.sezioni), emesse);
    assert.equal(c.sezioni, emesse.length);
    for (const f of c.fonti) for (const s of f.frammenti) {
      assert.ok(c.testo.includes(s.testo));
      assert.ok(s.fineSezione > s.inizioSezione && s.inizioSezione >= 0);
      const originale = fs.readFileSync(path.join(V, f.percorso), 'utf8').slice(s.inizioSezione, s.fineSezione);
      assert.ok(originale.includes(s.testo));
      if (maxCaratteri === 100) assert.equal(s.troncato, true);
    }
  }
});

test('Fase2: due note pertinenti, sigla derivata dalle note, assenze e contraddizioni', () => {
  assert.ok(percorsi('SNS').includes('sigle.md'));
  assert.match(memoria.contestoPerDomanda('Sistema di Navigazione Sintetico').testo, /Sistema di Navigazione Sintetico/);
  const due = memoria.contestoPerDomanda('satellite antenna', { ampia: true });
  assert.deepEqual(due.fonti.map(f => f.percorso).sort(), ['sigle.md', 'strumenti.md']);
  const nota = memoria.leggiNota('sigle.md');
  assert.ok(nota.linkUscenti.some(l => l.risolto === 'strumenti.md'));
  assert.deepEqual(percorsi('inesistenteaudit'), []);
  assert.match(memoria.contestoPerDomanda('inesistenteaudit').testo, /Assenza verificata/);
  const conflitto = memoria.contestoPerDomanda('Orion termina');
  assert.deepEqual(conflitto.fonti.map(f => f.percorso).sort(), ['confronto/a.md', 'confronto/b.md']);
  assert.match(conflitto.testo, /lunedi/); assert.match(conflitto.testo, /martedi/);
});

test('Fase2: sinonimi senza sovrapposizione lessicale non diventano fonti inventate', () => {
  assert.deepEqual(percorsi('radiotrasmettitore'), []);
});

test('Fase2: estratto discontinuo conserva frammento e intervallo della sezione, senza falsi offset', () => {
  const src = '# Dettagli\n\n' + 'Testo irrilevante. '.repeat(150) + '\n\nLa malachite e verde.\n\n' + 'Altro contenuto. '.repeat(150);
  scrivi('lunga.md', src); memoria.notificaModifica(['lunga.md']);
  const c = memoria.contestoPerDomanda('malachite');
  const f = c.fonti.find(f => f.percorso === 'lunga.md');
  assert.equal(f.frammenti[0].estratto, true);
  assert.equal(f.frammenti[0].inizioSezione, 0); assert.equal(f.frammenti[0].fineSezione, src.length);
  assert.match(f.frammenti[0].testo, /malachite/); assert.match(f.frammenti[0].testo, /\[\.\.\.\]/);
  assert.ok(c.testo.includes(f.frammenti[0].testo));
  fs.unlinkSync(path.join(V, 'lunga.md')); memoria.notificaModifica(['lunga.md']);
});

test('Fase2: retrieval non modifica le note, esclusioni e traversal conservati', () => {
  for (const [p, sha] of note) assert.equal(hash(p), sha);
  assert.deepEqual(percorsi('segretoescluso'), []);
  assert.throws(() => memoria.leggiNota('../../fuori.md'));
});

test('Fase2: invalidazione dopo modifica, rinomina, cancellazione, senza fonti obsolete', () => {
  scrivi('dentro/nuova.md', '# Azzurrite\nVersione uno.\n'); memoria.notificaModifica(['dentro/nuova.md']);
  assert.deepEqual(percorsi('azzurrite', { cartella: 'dentro' }), ['dentro/nuova.md']);
  scrivi('dentro/nuova.md', '# Azzurrite\nVersione due aggiornata.\n'); memoria.notificaModifica(['dentro/nuova.md']);
  assert.match(memoria.contestoPerDomanda('azzurrite').testo, /due aggiornata/);
  fs.renameSync(path.join(V, 'dentro/nuova.md'), path.join(V, 'dentro/rinominata.md'));
  memoria.notificaModifica(['dentro/nuova.md', 'dentro/rinominata.md']);
  assert.deepEqual(percorsi('azzurrite', { cartella: 'dentro' }), ['dentro/rinominata.md']);
  fs.unlinkSync(path.join(V, 'dentro/rinominata.md')); memoria.notificaModifica(['dentro/rinominata.md']);
  assert.deepEqual(percorsi('azzurrite', { cartella: 'dentro' }), []);
});

test('Fase2: flusso ordinario con MockProvider, fonti persistite e trace, nessun servizio reale', async () => {
  const { MockProvider } = require('./helpers');
  const { carica } = require('../config');
  const { creaApp } = require('../app');
  const { Storage } = require('../storage/db');
  const settings = carica({ envFile: process.env.ORBIT_ENV_FILE, envProcesso: {
    ORBIT_ENV_FILE: process.env.ORBIT_ENV_FILE, ORBIT_DATA_DIR: path.join(BASE, 'data'),
    ORBIT_MODEL_HAIKU: 'mock-haiku-1', ORBIT_MODEL_SONNET: 'mock-sonnet-1', ORBIT_MODEL_OPUS: 'mock-opus-1', ORBIT_AI_VERIFY: 'sempre'
  } }).settings;
  const provider = new MockProvider({ produttore: () => ({ text: 'Il quasar e un nucleo galattico luminoso (astronomia.md).' }) });
  const storage = new Storage(':memory:');
  const app = creaApp({ settings, provider, storage, memoria, tts: {}, voce: {}, attendiFn: () => Promise.resolve() });
  const eventi = [];
  const r = await app.orchestrator.elabora({ messaggio: 'Cerca nei miei appunti la spiegazione del quasar', onEvent: e => eventi.push(e) });
  assert.equal(r.ok, true); assert.equal(r.verifica, 'PASS');
  assert.ok(r.fonti.some(f => f.percorso === 'astronomia.md' && f.frammenti?.length));
  assert.ok(provider.chiamate.length > 0);
  assert.ok(provider.chiamate.some(c => JSON.stringify(c.messages).includes('nucleo galattico luminoso')));
  assert.ok(eventi.some(e => e.tipo === 'contesto_pronto'));
  const trace = [...app.performanceTrace.tracce.values()].at(-1);
  assert.ok(trace.eventi.some(e => e.fase === 'retrieval_inizio'));
  assert.ok(trace.eventi.some(e => e.fase === 'retrieval_fine'));
  assert.ok(storage.messaggi(r.conversazioneId).some(m => m.ruolo === 'assistant' && m.fonti.some(f => f.percorso === 'astronomia.md')));
  storage.chiudi();
});
