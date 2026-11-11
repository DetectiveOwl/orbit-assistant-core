'use strict';
// Indice SQLite: spostamenti, rinomine, percorsi Windows, interruzioni e file corrotto (vault e indice sintetici in una cartella temporanea).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-idx-'));
const V = path.join(BASE, 'vault');
const IDX = path.join(BASE, 'indice');
const scrivi = (p, t) => { fs.mkdirSync(path.dirname(path.join(V, p)), { recursive: true }); fs.writeFileSync(path.join(V, p), t); };
fs.mkdirSync(path.join(V, '.obsidian'), { recursive: true });
scrivi('corsi/analisi.md', '# Analisi\n\nLimiti e derivate: parola zaffiro.\n');
scrivi('corsi/fisica.md', '# Fisica\n\nMoto e forze.\n');
scrivi('Notion/appunti.md', '# Appunti\n\nTesto qualsiasi.\n');
process.env.ORBIT_VAULT_PATH = V; process.env.ORBIT_INDEX_DIR = IDX;

const { Indice } = require('../../memoria/indice');
const indice = new Indice();
const percorsi = (i = indice) => i.db.prepare('SELECT percorso FROM note ORDER BY percorso').all().map(r => r.percorso);
const nelFts = (parola) => indice.db.prepare('SELECT n.percorso FROM note_fts f JOIN note n ON n.id = f.rowid WHERE note_fts MATCH ? ORDER BY n.percorso').all(parola).map(r => r.percorso);
const coerente = (i = indice) => {
  const indice = i;
  const n = indice.db.prepare('SELECT count(*) c FROM note').get().c;
  assert.equal(indice.db.prepare('SELECT count(DISTINCT percorso) c FROM note').get().c, n, 'nessun percorso duplicato');
  assert.equal(indice.db.prepare('SELECT count(*) c FROM note_fts').get().c, n, 'una riga full text per nota');
  assert.equal(indice.db.prepare('SELECT count(*) c FROM sezioni_fts').get().c, indice.db.prepare('SELECT count(*) c FROM sezioni').get().c);
  assert.equal(indice.db.prepare('SELECT count(*) c FROM link WHERE sorgente NOT IN (SELECT id FROM note)').get().c, 0, 'nessun link orfano');
};

test('indicizzazione iniziale e seconda passata senza modifiche', () => {
  const a = indice.sincronizza({ forza: true });
  assert.deepEqual([a.aggiunte, a.rimosse], [3, 0]);
  const b = indice.sincronizza({ forza: true });
  assert.deepEqual([b.aggiunte, b.aggiornate, b.rimosse, b.invariate], [0, 0, 0, 3]);
  coerente();
});

test('nota spostata: il vecchio percorso esce, il nuovo entra, nessuna collisione e il full text segue', () => {
  fs.mkdirSync(path.join(V, 'Polimi', 'Primo anno'), { recursive: true });
  fs.renameSync(path.join(V, 'corsi', 'analisi.md'), path.join(V, 'Polimi', 'Primo anno', 'analisi.md'));
  const e = indice.sincronizza({ forza: true });
  assert.deepEqual([e.aggiunte, e.rimosse], [1, 1]);
  assert.deepEqual(percorsi(), ['Notion/appunti.md', 'Polimi/Primo anno/analisi.md', 'corsi/fisica.md']);
  assert.deepEqual(nelFts('zaffiro'), ['Polimi/Primo anno/analisi.md']);
  coerente();
});

test('nota rinominata, poi una cartella intera spostata sul percorso di una nota rimossa', () => {
  fs.renameSync(path.join(V, 'corsi', 'fisica.md'), path.join(V, 'corsi', 'fisica-1.md'));
  indice.sincronizza({ forza: true });
  assert.deepEqual(percorsi().filter(p => p.startsWith('corsi/')), ['corsi/fisica-1.md']);
  fs.renameSync(path.join(V, 'Notion', 'appunti.md'), path.join(V, 'corsi', 'fisica.md'));   // un percorso liberato viene riusato da un'altra nota
  indice.sincronizza({ forza: true });
  assert.deepEqual(percorsi(), ['Polimi/Primo anno/analisi.md', 'corsi/fisica-1.md', 'corsi/fisica.md']);
  coerente();
});

test('aggiornamento mirato: percorso con backslash Windows, nota nuova, poi sparita dal file system', () => {
  scrivi('Polimi/Primo anno/nuova.md', '# Nuova\n\nParola cobalto.\n');
  assert.equal(indice.aggiornaFile('Polimi\\Primo anno\\nuova.md').esito, 'aggiunta');
  assert.equal(indice.aggiornaFile('Polimi/Primo anno/nuova.md').esito, 'invariata');
  assert.deepEqual(nelFts('cobalto'), ['Polimi/Primo anno/nuova.md']);
  fs.rmSync(path.join(V, 'Polimi', 'Primo anno', 'nuova.md'));
  assert.equal(indice.aggiornaFile('Polimi/Primo anno/nuova.md').esito, 'rimossa');
  assert.deepEqual(nelFts('cobalto'), []);
  coerente();
});

test('interruzione durante l\'indicizzazione: rollback completo e la passata successiva rimette tutto a posto', () => {
  scrivi('corsi/chimica.md', '# Chimica\n\nParola titanio.\n');
  const originale = indice._indicizzaNota;
  indice._indicizzaNota = () => { throw new Error('interrotta'); };
  assert.throws(() => indice.sincronizza({ forza: true }), /interrotta/);
  indice._indicizzaNota = originale;
  assert.ok(!percorsi().includes('corsi/chimica.md'));
  indice.sincronizza({ forza: true });
  assert.deepEqual(nelFts('titanio'), ['corsi/chimica.md']);
  coerente();
});

test('riapertura del database: stesso contenuto, nessun duplicato', () => {
  const prima = percorsi();
  indice.chiudi();
  indice.apri();
  assert.deepEqual(percorsi(), prima);
  indice.sincronizza({ forza: true });
  assert.deepEqual(percorsi(), prima);
  coerente();
});

test('file SQLite corrotto: viene messo da parte (non cancellato), l\'indice si rifa e il vault resta intatto', () => {
  const vaultPrima = fs.readdirSync(path.join(V, 'corsi')).sort();
  const attese = percorsi();
  indice.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const radice = indice.db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'note'").get().rootpage;
  indice.chiudi();
  const fd = fs.openSync(path.join(IDX, 'indice.sqlite'), 'r+');
  fs.writeSync(fd, Buffer.alloc(4096), 0, 4096, (radice - 1) * 4096);   // pagina della tabella note azzerata
  fs.closeSync(fd);

  const e = indice.sincronizza({ forza: true });                         // prima della correzione: "database disk image is malformed"
  assert.equal(e.aggiunte, attese.length);
  assert.deepEqual(percorsi(), attese);
  assert.deepEqual(nelFts('titanio'), ['corsi/chimica.md']);
  coerente();
  assert.match(indice.stato().indiceCorrottoMessoDaParte, /^indice\.corrotto-\d{8}T\d{9}\.sqlite$/);
  assert.ok(fs.readdirSync(IDX).some(f => /^indice\.corrotto-\d{8}T\d{9}\.sqlite$/.test(f)), 'copia esatta del file corrotto conservata');
  assert.deepEqual(fs.readdirSync(path.join(V, 'corsi')).sort(), vaultPrima);
  indice.sincronizza({ forza: true });                                    // ripetibile
  coerente();
});

test('un errore che non e corruzione non fa buttare via l\'indice', () => {
  const originale = indice._indicizzaNota;
  scrivi('corsi/altra.md', '# Altra\n');
  indice._indicizzaNota = () => { throw new Error('errore qualsiasi'); };
  assert.throws(() => indice.sincronizza({ forza: true }), /errore qualsiasi/);
  indice._indicizzaNota = originale;
  assert.equal(fs.readdirSync(IDX).filter(f => /^indice\.corrotto-\d{8}T\d{9}\.sqlite$/.test(f)).length, 1);
});

// --- recupero coerente: avvio, ricerca prima della sincronizzazione, WAL, una sola volta, fallimenti chiari ---
const contaCopie = () => fs.readdirSync(IDX).filter(f => /^indice\.corrotto-\d{8}T\d{9}\.sqlite$/.test(f)).length;
const riempiWal = (i) => { for (let k = 0; k < 3; k++) i.db.prepare("INSERT OR REPLACE INTO meta VALUES ('prova', ?)").run('w' + k); };


test('file danneggiato all\'avvio (non e un database): recupero all\'apertura, con la copia esatta dei byte', () => {
  indice.chiudi();
  fs.writeFileSync(path.join(IDX, 'indice.sqlite'), Buffer.concat([Buffer.from('questo non e sqlite'), Buffer.alloc(8192, 7)]));
  for (const x of ['-wal', '-shm']) fs.rmSync(path.join(IDX, 'indice.sqlite' + x), { force: true });
  const danneggiato = fs.readFileSync(path.join(IDX, 'indice.sqlite'));
  const n = contaCopie();
  const j = new Indice();
  j.apri();
  assert.equal(contaCopie(), n + 1);
  const copia = fs.readdirSync(IDX).filter(f => /^indice\.corrotto-\d{8}T\d{9}\.sqlite$/.test(f)).sort().pop();
  assert.deepEqual(fs.readFileSync(path.join(IDX, copia)), danneggiato, 'byte identici al file danneggiato');
  j.sincronizza({ forza: true });
  assert.deepEqual(percorsi(j), ['Polimi/Primo anno/analisi.md', 'corsi/altra.md', 'corsi/chimica.md', 'corsi/fisica-1.md', 'corsi/fisica.md']);
  coerente(j);
  j.chiudi();
});

test('corruzione scoperta durante il lavoro con un WAL in sospeso: il WAL viene conservato byte per byte', () => {
  const i = new Indice();
  i.sincronizza({ forza: true });
  i.db.exec('PRAGMA wal_autocheckpoint = 0');
  riempiWal(i);
  const wal = fs.readFileSync(path.join(IDX, 'indice.sqlite-wal'));
  assert.ok(wal.length > 0, 'il WAL esiste');
  const n = contaCopie();
  i._sincronizza = () => { throw Object.assign(new Error('database disk image is malformed'), { errcode: 11 }); };
  assert.throws(() => i.sincronizza({ forza: true }), /ricostruzione e fallita/);
  assert.equal(contaCopie(), n + 1);
  const copia = fs.readdirSync(IDX).filter(f => /^indice\.corrotto-\d{8}T\d{9}\.sqlite-wal$/.test(f)).sort().pop();
  assert.deepEqual(fs.readFileSync(path.join(IDX, copia)), wal);
  i.chiudi();
});

test('riavvio dopo la ricostruzione: nessun nuovo recupero, integrita e ricerca a posto', () => {
  const n = contaCopie();
  const k = new Indice();
  k.sincronizza({ forza: true });
  assert.equal(k.stato().indiceCorrottoMessoDaParte, undefined);
  assert.equal(contaCopie(), n);
  assert.deepEqual(k.db.prepare('PRAGMA integrity_check').all(), [{ integrity_check: 'ok' }]);
  assert.deepEqual(percorsi(k), ['Polimi/Primo anno/analisi.md', 'corsi/altra.md', 'corsi/chimica.md', 'corsi/fisica-1.md', 'corsi/fisica.md']);
  coerente(k);
  k.chiudi();
});

test('ricostruzione fallita: messaggio chiaro col nome del file messo da parte; una seconda corruzione nello stesso processo non rifa nulla', () => {
  const i = new Indice();
  i.apri();
  let chiamate = 0;
  i._sincronizza = () => {
    if (++chiamate === 1) throw Object.assign(new Error('database disk image is malformed'), { errcode: 11 });
    throw new Error('disco pieno');
  };
  assert.throws(() => i.sincronizza({ forza: true }), /messo da parte come indice\.corrotto-\S+\.sqlite, ma la ricostruzione e fallita: disco pieno/);
  const n = contaCopie();
  i._sincronizza = () => { throw Object.assign(new Error('database disk image is malformed'), { errcode: 11 }); };
  assert.throws(() => i.sincronizza({ forza: true }), /corrotto anche dopo la ricostruzione/);
  assert.equal(contaCopie(), n, 'nessun secondo recupero');
  i.chiudi();
  const ok = new Indice(); ok.sincronizza({ forza: true }); coerente(ok); ok.chiudi();   // il riavvio ricostruisce da solo
});

test('errori che non sono corruzione (SQL, lock) non fanno spostare l\'indice', () => {
  const i = new Indice();
  i.apri();
  const n = contaCopie();
  i._sincronizza = () => { throw new Error('database is locked'); };
  assert.throws(() => i.sincronizza({ forza: true }), /database is locked/);
  i._sincronizza = () => { throw new Error('no such table: note'); };
  assert.throws(() => i.sincronizza({ forza: true }), /no such table/);
  assert.equal(contaCopie(), n);
  i.chiudi();
});

test('il recupero non tocca le note Markdown del vault', () => {
  const elenco = fs.readdirSync(V, { recursive: true }).filter(f => /\.md$/.test(f)).map(f => f.split(path.sep).join('/')).sort();
  assert.deepEqual(elenco, ['Polimi/Primo anno/analisi.md', 'corsi/altra.md', 'corsi/chimica.md', 'corsi/fisica-1.md', 'corsi/fisica.md']);
});


test('corruzione trovata ALL\'APERTURA con un WAL in sospeso: copia byte per byte di file e WAL, prima di qualunque scrittura', () => {
  const dir = path.join(IDX, 'indice.sqlite');
  const i = new Indice();
  i.sincronizza({ forza: true });
  i.db.exec('PRAGMA wal_autocheckpoint = 0');
  riempiWal(i);
  const radice = i.db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'sezioni_fts_config'").get().rootpage;
  // un secondo processo simulato non e possibile: si congelano i byte con la connessione ancora aperta e si riscrive la pagina nel file principale
  const fd = fs.openSync(dir, 'r+'); fs.writeSync(fd, Buffer.alloc(4096), 0, 4096, (radice - 1) * 4096); fs.closeSync(fd);
  const main = fs.readFileSync(dir), wal = fs.readFileSync(dir + '-wal');
  i.db.close(); i.db = null;                                // senza checkpoint garantito: si ripristinano i byte congelati
  fs.writeFileSync(dir, main); fs.writeFileSync(dir + '-wal', wal); fs.rmSync(dir + '-shm', { force: true });
  const n = contaCopie();
  const j = new Indice();
  j.apri();
  assert.equal(contaCopie(), n + 1);
  const stamp = j.stato().indiceCorrottoMessoDaParte.replace(/\.sqlite$/, '');
  assert.deepEqual(fs.readFileSync(path.join(IDX, stamp + '.sqlite')), main, '.sqlite identico');
  assert.deepEqual(fs.readFileSync(path.join(IDX, stamp + '.sqlite-wal')), wal, 'WAL identico');
  j.sincronizza({ forza: true }); coerente(j); j.chiudi();
});

test.after(() => { try { indice.chiudi(); } catch (e) { /* gia chiuso */ } fs.rmSync(BASE, { recursive: true, force: true }); });
