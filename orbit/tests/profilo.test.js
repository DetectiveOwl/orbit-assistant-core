'use strict';
// Profilo dell'utente, ricerca del vault e dataset dei benchmark: tutto con cartelle temporanee e dati inventati,
// senza leggere il vault personale ne i file privati del PC su cui girano i test.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../../memoria/profilo');
const D = require('../tools/dataset');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-profilo-'));
const cart = (...p) => { const d = path.join(BASE, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const vuoto = { ORBIT_LOCAL_ENV: '', ORBIT_ENV_FILE: path.join(BASE, 'non-esiste.env') };   // nessun file locale: conta solo l'ambiente passato
const RADICE = path.resolve(__dirname, '..', '..');

test.after(() => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (e) { /* temporanea */ } });

test('profilo: senza configurazione Orbit usa un nome neutro e nessuna descrizione', () => {
  P.azzeraCache();
  assert.equal(P.valore('ORBIT_UTENTE', vuoto), '');
  const env = Object.assign({}, vuoto);
  assert.equal(P.valore('ORBIT_UTENTE_PROFILO', env), '');
});

test('profilo: precedenza ambiente > file dei dati > file locale; una variabile vuota nell\'ambiente non lascia passare i file', () => {
  P.azzeraCache();
  const dati = path.join(cart('a'), '.env'), locale = path.join(cart('a'), 'orbit.env');
  fs.writeFileSync(dati, 'ORBIT_UTENTE=DaiDati\n# commento\nORBIT_UTENTE_PROFILO="studente di prova"\n');
  fs.writeFileSync(locale, 'ORBIT_UTENTE=DalLocale\nORBIT_PAROLE_CORSO=abc, due corsi\nORBIT_UTENTE_PROFILO=non usato\n');
  const base = { ORBIT_ENV_FILE: dati, ORBIT_LOCAL_ENV: locale };
  assert.equal(P.valore('ORBIT_UTENTE', Object.assign({ ORBIT_UTENTE: 'Ambiente' }, base)), 'Ambiente');
  assert.equal(P.valore('ORBIT_UTENTE', base), 'DaiDati');
  assert.equal(P.valore('ORBIT_UTENTE_PROFILO', base), 'studente di prova');
  assert.equal(P.valore('ORBIT_PAROLE_CORSO', base), 'abc, due corsi');           // solo nel file locale
  assert.equal(P.valore('ORBIT_UTENTE', Object.assign({ ORBIT_UTENTE: '' }, base)), '');
});

test('profilo: nome, presentazione e parole di corso (con caratteri speciali neutralizzati)', () => {
  P.azzeraCache();
  const salvate = { u: process.env.ORBIT_UTENTE, d: process.env.ORBIT_UTENTE_PROFILO, c: process.env.ORBIT_PAROLE_CORSO, l: process.env.ORBIT_LOCAL_ENV };
  try {
    process.env.ORBIT_LOCAL_ENV = '';
    process.env.ORBIT_UTENTE = ''; process.env.ORBIT_UTENTE_PROFILO = ''; process.env.ORBIT_PAROLE_CORSO = '';
    assert.equal(P.nomeUtente(), 'Utente'); assert.equal(P.nomeConfigurato(), null); assert.equal(P.presentazioneUtente(), 'Utente'); assert.deepEqual(P.paroleCorsoRe(), []);
    process.env.ORBIT_UTENTE = 'Anna'; process.env.ORBIT_UTENTE_PROFILO = 'studentessa di fisica'; process.env.ORBIT_PAROLE_CORSO = 'fis, a.b, (x), due parole';
    assert.equal(P.nomeUtente(), 'Anna'); assert.equal(P.nomeConfigurato(), 'Anna');
    assert.equal(P.presentazioneUtente(), 'Anna, studentessa di fisica');
    assert.deepEqual(P.paroleCorsoRe(), ['fis', 'due\\s*parole']);                  // "a.b" e "(x)" non sono sigle valide: scartate
  } finally {
    for (const [k, v] of [['ORBIT_UTENTE', salvate.u], ['ORBIT_UTENTE_PROFILO', salvate.d], ['ORBIT_PAROLE_CORSO', salvate.c], ['ORBIT_LOCAL_ENV', salvate.l]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    P.azzeraCache();
  }
});

test('vault: ORBIT_VAULT_PATH ha sempre la precedenza', () => {
  const v = P.trovaVault({ ORBIT_VAULT_PATH: path.join(BASE, 'qualunque') }, path.join(BASE, 'repo'));
  assert.equal(v.percorso, path.join(BASE, 'qualunque')); assert.equal(v.origine, 'ORBIT_VAULT_PATH');
});

test('vault: se il repository sta dentro un vault Obsidian, il vault e la cartella che lo contiene', () => {
  const vault = cart('doc1', 'MioVault'); cart('doc1', 'MioVault', '.obsidian'); const repo = cart('doc1', 'MioVault', '.orbit-hud');
  const v = P.trovaVault({ USERPROFILE: path.join(BASE, 'nessuno') }, repo);
  assert.equal(v.percorso, vault); assert.match(v.origine, /contiene il repository/);
});

test('vault: Documenti reindirizzato su OneDrive viene trovato, senza usare solo la cartella home', () => {
  const home = cart('home'); const od = cart('home', 'OneDrive'); cart('home', 'OneDrive', 'Documents', 'Orbit', '.obsidian');
  const repo = cart('altrove', 'orbit-hud');                                       // repository fuori dal vault, come in un worktree
  const v = P.trovaVault({ USERPROFILE: home, OneDrive: od }, repo);
  assert.equal(v.percorso, path.join(od, 'Documents', 'Orbit')); assert.match(v.origine, /Documenti/);
  assert.ok(P.candidatiVault({ USERPROFILE: home, OneDrive: od }, repo).includes(path.join(home, 'Documents', 'Orbit')));
});

test('vault: se non lo trova non inventa nulla e dice dove ha cercato', () => {
  const repo = cart('vuoto', 'orbit-hud');
  const v = P.trovaVault({ USERPROFILE: path.join(BASE, 'senza-vault') }, repo);
  assert.match(v.origine, /ORBIT_VAULT_PATH/); assert.ok(path.isAbsolute(v.percorso));
});

test('dataset: il privato mancante NON viene sostituito dal pubblico', () => {
  const salvato = process.env.ORBIT_BENCH_PRIVATO;
  try {
    process.env.ORBIT_BENCH_PRIVATO = path.join(BASE, 'non-esiste', 'dataset.json');
    assert.throws(() => D.carica('privato'), /PRIVATO non disponibile.*--dataset pubblico/);
    assert.equal(D.nomeScelto(['node', 'x']), 'privato');                          // predefinito esplicito, mai il pubblico "per ripiego"
    assert.equal(D.nomeScelto(['node', 'x', '--dataset', 'pubblico']), 'pubblico');
    assert.throws(() => D.carica('altro'), /sconosciuto/);
  } finally { if (salvato === undefined) delete process.env.ORBIT_BENCH_PRIVATO; else process.env.ORBIT_BENCH_PRIVATO = salvato; }
});

test('dataset pubblico: e sintetico, completo e il suo vault contiene le note attese', () => {
  const d = D.carica('pubblico');
  assert.equal(d.nome, 'pubblico'); assert.equal(d.query.length, 12); assert.equal(d.domande.length, 12);
  for (const [, , attese] of d.query) for (const nota of attese) assert.ok(fs.existsSync(path.join(d.vaultOrigine, ...nota.split('/'))), nota);
  assert.ok(fs.existsSync(path.join(d.vaultOrigine, ...d.notaProva.split('/'))));
  assert.ok(d.domande.every(x => x.fatti.every(r => r instanceof RegExp)));
  // niente dati reali riconoscibili: nessun percorso utente di Windows e nessun indirizzo e-mail che non sia di esempio
  const testo = [fs.readFileSync(d.file, 'utf8')];
  (function giu(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) giu(p); else testo.push(fs.readFileSync(p, 'utf8')); } })(d.vaultOrigine);
  const tutto = testo.join('\n');
  assert.doesNotMatch(tutto, /[A-Za-z]:\\Users\\/);
  for (const m of tutto.matchAll(/[\w.+-]+@([\w-]+\.[\w.-]+)/g)) assert.match(m[1], /(^|\.)example(\.com)?$/, m[0]);
});

test('benchmark: la validazione locale sul dataset pubblico trova i fatti attesi nel contesto', () => {
  const r = spawnSync(process.execPath, [path.join(RADICE, 'orbit', 'tools', 'validazione-memoria.js'), '--dataset', 'pubblico', '--locale'], { encoding: 'utf8', env: Object.assign({}, process.env, { ORBIT_LOCAL_ENV: '', ORBIT_UTENTE: '', ORBIT_PAROLE_CORSO: '' }), timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Dataset: pubblico/);
  const out = JSON.parse(r.stdout);
  assert.equal(out.dataset, 'pubblico'); assert.equal(out.locale.length, 12);
  for (const x of out.locale.filter(x => x.fattiTotali > 0)) assert.equal(x.fattiTrovati, x.fattiTotali, x.q);
  assert.equal(out.locale.find(x => x.tipo === 'ambigua').ambigua, true);
});

test('benchmark: con --dataset privato e senza dataset privato si ferma con un errore e codice 2, senza usare il pubblico', () => {
  const r = spawnSync(process.execPath, [path.join(RADICE, 'orbit', 'tools', 'bench-memoria.js'), '--dataset', 'privato'], { encoding: 'utf8', env: Object.assign({}, process.env, { ORBIT_BENCH_PRIVATO: path.join(BASE, 'non-esiste', 'dataset.json') }), timeout: 60000 });
  assert.equal(r.status, 2); assert.match(r.stderr, /PRIVATO non disponibile/); assert.doesNotMatch(r.stderr, /Dataset: pubblico/);
});
