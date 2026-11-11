'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { controllaSmartInbox, raccogliFile } = require('../tools/check-smart-inbox');

const reale = fs.readFileSync(path.join(__dirname, '..', '..', 'smart-inbox', 'cli-windows.js'), 'utf8');

test('smart-inbox reale: child_process solo nell adapter e conforme', () => {
  const files = {};
  const dir = path.join(__dirname, '..', '..', 'smart-inbox');
  for (const f of fs.readdirSync(dir)) if (/\.c?js$/.test(f)) files[f] = fs.readFileSync(path.join(dir, f), 'utf8');
  assert.deepStrictEqual(controllaSmartInbox(files), []);
});

test('child_process in un altro modulo smart-inbox e rifiutato', () => {
  for (const testo of ["require('child_process')", "require('node:child_process').spawn", "import cp from 'node:child_process'"]) {
    assert.match(controllaSmartInbox({ 'writer.js': testo })[0], /ammesso solo in cli-windows\.js/);
  }
});

test('child_process in sottocartelle e in file .mjs e rifiutato', () => {
  for (const nome of ['lib/x.js', 'lib/profondo/y.cjs', 'z.mjs']) assert.ok(controllaSmartInbox({ [nome]: "import { exec } from 'node:child_process'" }).length > 0, nome);
  assert.ok(controllaSmartInbox({ 'cli-windows.js': reale, 'lib/cli-windows.js': reale }).length > 0);
});

test('raccogliFile (la scansione di check.js): sottocartelle e .mjs rilevati in una cartella temporanea, tests/ escluso', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-si-check-'));
  try {
    for (const d of ['lib-prova', 'tests']) fs.mkdirSync(path.join(dir, d));
    fs.writeFileSync(path.join(dir, 'lib-prova', 'x.mjs'), "import { exec } from 'node:child_process'; exec('calc');");
    fs.writeFileSync(path.join(dir, 'tests', 'ok.js'), "require('node:child_process');");
    const files = raccogliFile(dir);
    assert.deepStrictEqual(Object.keys(files), ['lib-prova/x.mjs']);
    assert.match(controllaSmartInbox(files)[0], /lib-prova\/x\.mjs: child_process ammesso solo/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('l adapter perde le garanzie: rilevato', () => {
  const casi = {
    'shell:true': reale.replace('shell: false', 'shell: true'),
    'senza shell': reale.replace('shell: false, ', ''),
    'exec': reale + "\nrequire('node:child_process').exec('calc');",
    'senza hash': reale.replace('!== RUNTIME_SHA256', '!== undefined'),
    'require dinamico': reale + "\nconst n = 'child'; require(n + '_process');",
    'script del bridge non verificati': reale.replace(/verificaScript\s*\(/g, 'altro('),
    'pin del manifest facoltativo': reale.replace(/obbligatorio:\s*true/g, 'obbligatorio: false'),
    'perimetro non verificato': reale.replace(/verificaPerimetroFs\s*\(/g, 'altro('),
    'bridge dal repository': reale + "\nconst script = path.join(__dirname, 'windows/cli-host.ps1');",
    'import dinamico': reale + "\nimport('node:child_' + 'process');"
  };
  for (const [nome, testo] of Object.entries(casi)) assert.ok(controllaSmartInbox({ 'cli-windows.js': testo }).length > 0, nome);
});
