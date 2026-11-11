'use strict';
// Controllo statico di smart-inbox/ (fuori da orbit/, quindi non coperto dalle regole generali di check.js).
// child_process e ammesso solo nell adapter cli-windows.js, e li solo come spawn senza shell dal runtime pinnato.
const fs = require('node:fs'), path = require('node:path');
const CHILD = /child_process/;
const AMMESSO = 'cli-windows.js';

// files: { 'cli-windows.js': testo, ... } relativi a smart-inbox/, test esclusi.
function controllaSmartInbox(files) {
  const problemi = [];
  for (const [nome, testo] of Object.entries(files)) {
    if (nome !== AMMESSO) {
      if (CHILD.test(testo)) problemi.push('smart-inbox/' + nome + ': child_process ammesso solo in ' + AMMESSO);
      continue;
    }
    if (/\b(exec|execSync|execFile|execFileSync|spawnSync|fork)\b/.test(testo.replace(/\/\/.*$/gm, ''))) problemi.push('smart-inbox/' + nome + ': solo spawn ammesso (niente exec/execFile/fork/spawnSync)');
    if (/shell\s*:(?!\s*false\b)/.test(testo)) problemi.push('smart-inbox/' + nome + ': shell diverso da false');
    if (!/shell\s*:\s*false/.test(testo)) problemi.push('smart-inbox/' + nome + ': spawn senza shell:false esplicito');
    if (!/RUNTIME_SHA256/.test(testo) || !/sha\(fs\.readFileSync\(runtime\)\)\s*!==\s*RUNTIME_SHA256/.test(testo)) problemi.push('smart-inbox/' + nome + ': runtime non verificato per SHA-256 prima dello spawn');
    if (!/verificaScript\([^)]*obbligatorio:\s*true/.test(testo)) problemi.push('smart-inbox/' + nome + ': il pin del manifest deve essere obbligatorio prima dello spawn');
    if (!/verificaScript\s*\(/.test(testo) || !/verificaPerimetroFs\s*\(/.test(testo)) problemi.push('smart-inbox/' + nome + ': script del bridge e perimetro non verificati prima dello spawn');
    if (/__dirname[^;\n]*(windows|cli-host)/.test(testo.replace(/\/\/.*$/gm, ''))) problemi.push('smart-inbox/' + nome + ': il bridge deve partire dalla copia verificata, non da un percorso del repository');
    if (/['"`]child['"`]\s*\+|require\s*\(\s*[^'"`\s)]|import\s*\(|process\.binding/.test(testo)) problemi.push('smart-inbox/' + nome + ': require/import dinamico o process.binding (aggira il controllo)');
  }
  return problemi;
}
// Legge ricorsivamente le sorgenti .js/.cjs/.mjs di una cartella smart-inbox (tests/ di primo livello escluso, dove child_process e ammesso).
function raccogliFile(radice, salta = new Set()) {
  const files = {};
  const scandisci = (dir, pre) => { for (const v of fs.readdirSync(dir, { withFileTypes: true })) {
    if (v.isDirectory()) { if (!salta.has(v.name) && !(pre === '' && v.name === 'tests')) scandisci(path.join(dir, v.name), pre + v.name + '/'); }
    else if (/\.(js|cjs|mjs)$/.test(v.name)) files[pre + v.name] = fs.readFileSync(path.join(dir, v.name), 'utf8');
  } };
  scandisci(radice, '');
  return files;
}
module.exports = { controllaSmartInbox, raccogliFile };
