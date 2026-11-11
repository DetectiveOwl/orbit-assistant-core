'use strict';
// Integrita degli script del bridge (TS-6B): manifest nel repo, verifica prima dello spawn, copia verificata. Nessun PowerShell, nessun dato personale.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verificaScript, copiaVerificata, scriviManifest, MANIFEST, normalizza } = require('../../smart-inbox/integrita');
const { sha } = require('../../smart-inbox/policy');

const REALE = path.join(__dirname, '..', '..', 'smart-inbox', 'windows');
const creati = [];
test.after(() => { for (const p of creati) fs.rmSync(p, { recursive: true, force: true }); });
const copia = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-si-integrita-')); creati.push(d); fs.cpSync(REALE, d, { recursive: true }); return d; };
const rifiuta = (fn, code) => assert.throws(fn, { code });

test('il manifest del repository corrisponde agli script (se cambi uno script: node smart-inbox/integrita.js --scrivi)', () => {
  const byte = verificaScript();
  assert.deepStrictEqual([...byte.keys()].sort(), ['Engine.cs', 'Handles.cs', 'cli-host.ps1']);
});

test('uno script modificato senza aggiornare il manifest e rifiutato', () => {
  for (const nome of ['cli-host.ps1', 'Engine.cs', 'Handles.cs']) {
    const d = copia();
    fs.appendFileSync(path.join(d, nome), '\n// modifica\n');
    rifiuta(() => verificaScript({ dir: d }), 'SCRIPT_BRIDGE_NON_VERIFICATI');
  }
});

test('file in piu, mancanti, cartelle o manifest incoerente sono rifiutati', () => {
  let d = copia(); fs.writeFileSync(path.join(d, 'Extra.cs'), 'class X {}');
  rifiuta(() => verificaScript({ dir: d }), 'SCRIPT_BRIDGE_NON_VERIFICATI');
  d = copia(); fs.rmSync(path.join(d, 'Engine.cs'));
  rifiuta(() => verificaScript({ dir: d }), 'SCRIPT_BRIDGE_NON_VERIFICATI');
  d = copia(); fs.mkdirSync(path.join(d, 'sub'));
  rifiuta(() => verificaScript({ dir: d }), 'SCRIPT_BRIDGE_NON_VERIFICATI');
  d = copia(); fs.rmSync(path.join(d, MANIFEST));
  rifiuta(() => verificaScript({ dir: d }), 'MANIFEST_BRIDGE_ASSENTE');
  for (const testo of ['', 'zzz  Engine.cs\n', sha('x') + '  ../Engine.cs\n', fs.readFileSync(path.join(REALE, MANIFEST), 'utf8').split('\n')[0] + '\n']) {
    d = copia(); fs.writeFileSync(path.join(d, MANIFEST), testo);
    rifiuta(() => verificaScript({ dir: d }), 'MANIFEST_BRIDGE_NON_VALIDO');
  }
});

test('il manifest non puo elencare script scelti dal chiamante: i nomi richiesti sono fissi', () => {
  const d = copia(); fs.writeFileSync(path.join(d, 'Altro.ps1'), 'Write-Host x');
  fs.rmSync(path.join(d, 'Engine.cs')); fs.rmSync(path.join(d, 'Handles.cs'));
  scriviManifest(d);   // manifest coerente ma senza i file nativi richiesti
  rifiuta(() => verificaScript({ dir: d }), 'MANIFEST_BRIDGE_NON_VALIDO');
});

test('pin facoltativo dell host sull hash del manifest', () => {
  const pin = sha(normalizza(fs.readFileSync(path.join(REALE, MANIFEST))));
  assert.ok(verificaScript({ pin }));
  assert.ok(verificaScript({ pin: pin.toUpperCase() }));
  rifiuta(() => verificaScript({ pin: '0'.repeat(64) }), 'MANIFEST_BRIDGE_PIN_DIVERSO');
  // Un manifest ricalcolato da chi ha modificato gli script non passa il pin dell host.
  const d = copia(); fs.appendFileSync(path.join(d, 'Engine.cs'), '\n// x\n'); scriviManifest(d);
  assert.ok(verificaScript({ dir: d }));
  rifiuta(() => verificaScript({ dir: d, pin }), 'MANIFEST_BRIDGE_PIN_DIVERSO');
});

test('CRLF e LF danno lo stesso risultato (autocrlf non rompe la verifica)', () => {
  const d = copia();
  for (const f of ['cli-host.ps1', 'Engine.cs', 'Handles.cs', MANIFEST]) {
    const p = path.join(d, f); fs.writeFileSync(p, fs.readFileSync(p, 'latin1').replace(/\r?\n/g, '\r\n'), 'latin1');
  }
  assert.ok(verificaScript({ dir: d }));
});

test('la copia contiene esattamente i byte verificati (LF) e gli hash degli .cs per il bridge', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-si-copia-')), byte = verificaScript(), dest = path.join(base, 'bridge');
  creati.push(base);
  const c = copiaVerificata(byte, dest);
  for (const [nome, contenuto] of byte) assert.ok(fs.readFileSync(path.join(c.dir, nome)).equals(contenuto));
  assert.match(c.hashCs, /^Handles\.cs=[0-9a-f]{64};Engine\.cs=[0-9a-f]{64}$/);
  assert.throws(() => copiaVerificata(byte, dest), { code: 'EEXIST' });   // cartella esclusiva: mai riuso
});

test('il bridge ricontrolla gli .cs e il marker prima di compilare (contenuto di cli-host.ps1)', () => {
  const ps1 = fs.readFileSync(path.join(REALE, 'cli-host.ps1'), 'utf8');
  assert.match(ps1, /\$CsSha256/);
  assert.ok(ps1.indexOf('BRIDGE_SCRIPT_CHANGED') < ps1.indexOf('Add-Type -LiteralPath'));
  assert.ok(ps1.indexOf('PERIMETER_MARKER_REQUIRED') < ps1.indexOf('Add-Type -LiteralPath'));
});

test('il dialogo di consenso viene mostrato esplicitamente (il bridge parte con la finestra nascosta)', () => {
  const ps1 = fs.readFileSync(path.join(REALE, 'cli-host.ps1'), 'utf8');
  assert.match(ps1, /Add_Shown\(\{\[void\]\[SmartInboxUi\.Win\]::ShowWindow\(\$form\.Handle,5\)/);
  assert.ok(ps1.indexOf('Add_Shown') < ps1.indexOf('ShowDialog'));
});

test('pin obbligatorio: senza pin o con pin non valido nessuno script e accettato', () => {
  const pin = sha(normalizza(fs.readFileSync(path.join(REALE, MANIFEST))));
  rifiuta(() => verificaScript({ obbligatorio: true }), 'MANIFEST_BRIDGE_PIN_MANCANTE');
  rifiuta(() => verificaScript({ obbligatorio: true, pin: '' }), 'MANIFEST_BRIDGE_PIN_MANCANTE');
  for (const cattivo of ['abc', 'g'.repeat(64), pin + '0']) rifiuta(() => verificaScript({ obbligatorio: true, pin: cattivo }), 'MANIFEST_BRIDGE_PIN_NON_VALIDO');
  rifiuta(() => verificaScript({ obbligatorio: true, pin: '0'.repeat(64) }), 'MANIFEST_BRIDGE_PIN_DIVERSO');
  assert.ok(verificaScript({ obbligatorio: true, pin }));
});

test('pin obbligatorio: un manifest ricalcolato dopo aver alterato gli script non passa il pin dell host', () => {
  const pin = sha(normalizza(fs.readFileSync(path.join(REALE, MANIFEST)))), d = copia();
  fs.appendFileSync(path.join(d, 'Engine.cs'), '\n// alterato\n'); scriviManifest(d);
  assert.ok(verificaScript({ dir: d }));
  rifiuta(() => verificaScript({ dir: d, obbligatorio: true, pin }), 'MANIFEST_BRIDGE_PIN_DIVERSO');
});
