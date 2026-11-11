'use strict';
// Indice corrotto in una tabella full text: la prima operazione (ricerca) rileva il danno e ricostruisce, senza dipendere dall'ordine
// tra ricerca e sincronizzazione. Vault e indice sintetici in una cartella temporanea.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-idxr-'));
const V = path.join(BASE, 'vault');
const IDX = path.join(BASE, 'indice');
fs.mkdirSync(path.join(V, '.obsidian'), { recursive: true });
fs.mkdirSync(path.join(V, 'Polimi'), { recursive: true });
fs.writeFileSync(path.join(V, 'Polimi', 'analisi.md'), '# Analisi\n\nLimiti e derivate: parola zaffiro.\n');
fs.writeFileSync(path.join(V, 'altra.md'), '# Altra\n\nNiente di speciale.\n');
process.env.ORBIT_VAULT_PATH = V; process.env.ORBIT_INDEX_DIR = IDX;

const { Indice } = require('../../memoria/indice');
const memoria = require('../../memoria/memoria');

test('ricerca prima di qualsiasi sincronizzazione su indice con tabella full text corrotta', () => {
  const i = new Indice();
  i.sincronizza({ forza: true });
  const radice = i.db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'sezioni_fts_config'").get().rootpage;
  i.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  i.chiudi();
  const fd = fs.openSync(path.join(IDX, 'indice.sqlite'), 'r+');
  fs.writeSync(fd, Buffer.alloc(4096), 0, 4096, (radice - 1) * 4096);
  fs.closeSync(fd);

  const r = memoria.cerca('zaffiro');
  assert.deepEqual(r.map(x => x.percorso), ['Polimi/analisi.md']);
  assert.match(memoria.stato().indiceCorrottoMessoDaParte, /^indice\.corrotto-\d{8}T\d{9}\.sqlite$/);
  assert.ok(fs.readdirSync(IDX).some(f => /^indice\.corrotto-\d{8}T\d{9}\.sqlite$/.test(f)));
  assert.equal(fs.readFileSync(path.join(V, 'altra.md'), 'utf8'), '# Altra\n\nNiente di speciale.\n');
  assert.equal(memoria.cerca('zaffiro').length, 1);        // ripetibile
});

test.after(() => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (e) { /* file ancora aperto dalla memoria su Windows */ } });
