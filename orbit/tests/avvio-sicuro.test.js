'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const base = process.env.ORBIT_TEST_PATHS_BASE || fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-avvio-sicuro-'));
const vault = path.join(base, 'vault'), dati = path.join(base, 'dati');
fs.mkdirSync(vault, { recursive: true });
// Prima degli import, anche eseguendo solo questo file senza il runner di sviluppo.
process.env.ORBIT_VAULT_PATH = vault;
process.env.ORBIT_INDEX_DIR = path.join(base, 'indice');
process.env.ORBIT_DATA_DIR = dati;
process.env.ORBIT_ENV_FILE = path.join(base, 'facoltativo.env');
process.env.ORBIT_LOCAL_ENV = path.join(base, 'profilo-assente.env');
process.env.ORBIT_UTENTE = 'Utente sintetico';
process.env.ORBIT_UTENTE_PROFILO = '';
const config = require('../config');
const { creaApp } = require('../app');
const { MockProvider } = require('./helpers');

function settings(extra = {}, envFile = process.env.ORBIT_ENV_FILE) {
  return config.carica({ envProcesso: { ORBIT_DATA_DIR: dati, ...extra }, envFile });
}
const vietato = (s, code = 'DATA_IN_VAULT') => assert.throws(() => config.verificaPercorsi(s), { code });
function junction(target, link) {
  if (!process.env.ORBIT_TEST_PATHS_BASE) return fs.symlinkSync(target, link, 'junction');
  // Con i permessi Node i link sintetici vengono preparati dall'host prima degli import.
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(path.resolve(fs.readlinkSync(link).replace(/^\\\\\?\\/, '')), path.resolve(target));
}
function nessunDatoTecnico(dir) {
  for (const f of ['orbit.sqlite', 'orbit.sqlite-wal', 'orbit.sqlite-shm', 'google', 'tts', 'cc-cwd']) assert.equal(fs.existsSync(path.join(dir, f)), false, f);
}

for (const [nome, dataDir] of [
  ['radice', vault], ['discendente inesistente', path.join(vault, 'nuovi', 'dati')],
  ['relativo', path.relative(process.cwd(), path.join(vault, 'relativi'))],
  ['normalizzato', path.join(vault, 'cartella', '..', 'dati')]
]) test('avvio sicuro: vietata directory dati nel vault, ' + nome, () => {
  const r = settings({ ORBIT_DATA_DIR: dataDir });
  assert.ok(r.problemi.some(p => p.code === 'DATA_IN_VAULT'));
  vietato(r.settings); nessunDatoTecnico(path.resolve(dataDir));
});

test('avvio sicuro: file env nel vault, anche se inesistente, blocca senza creare dati', () => {
  const file = path.join(vault, 'config', '.env'), s = settings({}, file).settings;
  vietato(s, 'ENV_IN_VAULT'); nessunDatoTecnico(dati);
});

test('avvio sicuro: ..cache e un nome interno, non un componente padre, per i dati', () => {
  const cache = path.join(vault, '..cache'), dataDir = path.join(cache, 'dati');
  fs.mkdirSync(cache, { recursive: true });
  const r = settings({ ORBIT_DATA_DIR: dataDir });
  assert.ok(r.problemi.some(p => p.code === 'DATA_IN_VAULT'));
  assert.throws(() => creaApp({ settings: r.settings }), { code: 'DATA_IN_VAULT' });
  assert.equal(fs.existsSync(dataDir), false); nessunDatoTecnico(cache);
});

test('avvio sicuro: env sotto ..cache nel vault blocca prima dei dati tecnici', () => {
  const dataDir = path.join(base, 'env-cache-rifiutato');
  const r = settings({ ORBIT_DATA_DIR: dataDir }, path.join(vault, '..cache', '.env'));
  assert.ok(r.problemi.some(p => p.code === 'ENV_IN_VAULT'));
  assert.throws(() => creaApp({ settings: r.settings }), { code: 'ENV_IN_VAULT' });
  assert.equal(fs.existsSync(dataDir), false); nessunDatoTecnico(dataDir);
});

test('avvio sicuro: ..cache esterna al vault rimane valida', () => {
  const dataDir = path.join(base, '..cache', 'dati'), s = settings({ ORBIT_DATA_DIR: dataDir }).settings;
  assert.doesNotThrow(() => config.verificaPercorsi(s));
  assert.equal(fs.existsSync(dataDir), false);
});

test('avvio sicuro: dati da env file e precedenza del processo preservati', () => {
  const file = path.join(base, 'config.env');
  fs.writeFileSync(file, 'ORBIT_DATA_DIR=' + path.join(vault, 'da-file') + '\n');
  const daFile = config.carica({ envProcesso: {}, envFile: file });
  vietato(daFile.settings);
  const overrideValido = settings({ ORBIT_DATA_DIR: dati }, file);
  assert.doesNotThrow(() => config.verificaPercorsi(overrideValido.settings));
  fs.writeFileSync(file, 'ORBIT_DATA_DIR=' + dati + '\n');
  vietato(settings({ ORBIT_DATA_DIR: path.join(vault, 'dal-processo') }, file).settings);
});

test('avvio sicuro: junction esterna nel vault e figli ancora inesistenti vietati', () => {
  const link = path.join(base, 'alias-vault'); junction(vault, link);
  vietato(settings({ ORBIT_DATA_DIR: path.join(link, 'ancora', 'inesistente') }).settings);
  const fileEnv = path.join(link, 'segreti.env');
  vietato(settings({}, fileEnv).settings, 'ENV_IN_VAULT');
});

test('avvio sicuro: vault raggiunto tramite junction e confine lessicale preservati', () => {
  const link = path.join(base, 'vault-virtuale'); junction(vault, link);
  vietato({ ...settings().settings, vaultPath: link, dataDir: path.join(vault, 'dati-veri') });
  const fuori = path.join(base, 'fuori'); fs.mkdirSync(fuori, { recursive: true });
  const interno = path.join(vault, 'link-fuori'); junction(fuori, interno);
  vietato(settings({ ORBIT_DATA_DIR: path.join(interno, 'dati') }).settings);
});

test('avvio sicuro: link non risolvibile e errore di accesso falliscono chiusi', t => {
  const link = path.join(base, 'link-rotto'); junction(path.join(base, 'destinazione-assente'), link);
  vietato(settings({ ORBIT_DATA_DIR: path.join(link, 'dati') }).settings, 'CONFIG_PATH_UNVERIFIABLE');
  const original = fs.realpathSync, denied = path.join(base, 'negato');
  t.mock.method(fs, 'realpathSync', (p, ...args) => {
    if (p === denied) throw Object.assign(new Error('Diniego sintetico'), { code: 'EACCES' });
    return original(p, ...args);
  });
  vietato(settings({ ORBIT_DATA_DIR: denied }).settings, 'CONFIG_PATH_UNVERIFIABLE');
});

test('avvio sicuro: ricontrolla la risoluzione cambiata dopo il caricamento della configurazione', t => {
  const link = path.join(base, 'alias-successivo'), s = settings({ ORBIT_DATA_DIR: path.join(link, 'dati') }).settings;
  assert.doesNotThrow(() => config.verificaPercorsi(s));
  const original = fs.realpathSync;
  t.mock.method(fs, 'realpathSync', (p, ...args) => p === s.dataDir ? path.join(vault, 'dati') : original(p, ...args));
  vietato(s);
});

test('avvio sicuro: creaApp diretto non apre DB, WAL, provider o directory tecniche vietate', () => {
  const dataDir = path.join(vault, 'app-diretta'), s = settings({ ORBIT_DATA_DIR: dataDir }).settings;
  assert.throws(() => creaApp({ settings: s }), { code: 'DATA_IN_VAULT' });
  assert.equal(fs.existsSync(dataDir), false); nessunDatoTecnico(dataDir);
});

test('avvio sicuro: bootstrap si ferma prima di caricare la memoria e aprire lo storage', t => {
  const dataDir = path.join(vault, 'bootstrap'), s = settings({ ORBIT_DATA_DIR: dataDir }).settings;
  t.mock.method(config, 'carica', () => ({ settings: s, problemi: [] }));
  const original = Module._load; let memoriaCaricata = false;
  t.mock.method(Module, '_load', function (request, ...args) {
    if (request === '../memoria/memoria') { memoriaCaricata = true; throw new Error('Memoria non deve avviarsi'); }
    return original.call(this, request, ...args);
  });
  assert.throws(() => require('../server').avvia(), { code: 'DATA_IN_VAULT' });
  assert.equal(memoriaCaricata, false); assert.equal(fs.existsSync(dataDir), false);
  assert.equal(fs.existsSync(process.env.ORBIT_INDEX_DIR), false);
});

test('avvio sicuro: database preesistente nel vault non viene aperto o modificato', () => {
  const dataDir = path.join(vault, 'db-esistente'), file = path.join(dataDir, 'orbit.sqlite');
  fs.mkdirSync(dataDir, { recursive: true });
  const bytes = Buffer.from('Sentinella sintetica: non aprire come database'); fs.writeFileSync(file, bytes);
  assert.throws(() => creaApp({ settings: settings({ ORBIT_DATA_DIR: dataDir }).settings }), { code: 'DATA_IN_VAULT' });
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.existsSync(file + '-wal'), false); assert.equal(fs.existsSync(file + '-shm'), false);
});

test('avvio sicuro: configurazione valida mantiene storage SQLite e inizializzazione con mock', () => {
  const dataDir = path.join(base, 'validi'), s = settings({ ORBIT_DATA_DIR: dataDir }).settings;
  assert.doesNotThrow(() => config.verificaPercorsi(s));
  const app = creaApp({ settings: s, provider: new MockProvider(), tts: {}, voce: {}, cifratura: {} });
  try { assert.ok(fs.existsSync(path.join(dataDir, 'orbit.sqlite'))); assert.ok(app.orchestrator); }
  finally { app.storage.chiudi(); }
});
