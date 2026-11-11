'use strict';
// Controlli statici senza dipendenze: sintassi di ogni file JavaScript, regole di sicurezza e di coerenza.
// Non sostituisce un type checker: il progetto e JavaScript senza build (vedi README, sezione Limitazioni).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RADICE = path.resolve(__dirname, '..');
const SALTA = new Set(['node_modules', '.git']);
const problemi = [];

function file(dir, out = []) {
  for (const v of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SALTA.has(v.name)) continue;
    const p = path.join(dir, v.name);
    if (v.isDirectory()) file(p, out); else out.push(p);
  }
  return out;
}

const tutti = file(RADICE);
const js = tutti.filter(f => f.endsWith('.js'));
const rel = f => path.relative(RADICE, f).split(path.sep).join('/');

// 1. Sintassi.
for (const f of js) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) problemi.push(rel(f) + ': errore di sintassi\n' + r.stderr.split('\n').slice(0, 4).join('\n'));
}

// 2. Regole di codice: niente eval, niente console diretta nei moduli (solo log.js e server.js), niente segreti, niente em dash.
const REGOLE = [
  { re: /\beval\s*\(|new Function\s*\(/, msg: 'uso di eval o new Function (il codice generato dal modello non si esegue mai)', salta: f => f.includes('check.js') },
  { re: /child_process/, msg: 'child_process fuori dal server', salta: f => ['server.js', 'ai/providers/claude-code.js', 'ai/providers/claude-persistente.js', 'voice/piper.js', 'voice/whisper.js', 'voice/parola.js', 'tools/installa-stt.js', 'tools/prova-stt.js', 'integrations/documenti/lettori.js', 'integrations/google/cifratura.js', 'tools/installa-voce.js', 'tools/check.js', 'tools/check-smart-inbox.js'].includes(f) || f.startsWith('tests/') },
  { re: /\bconsole\.(log|error|warn)\b/, msg: 'console diretta: usa log.js', salta: f => ['log.js', 'tools/check.js', 'tools/installa-voce.js', 'tools/installa-stt.js', 'tools/prova-stt.js', 'tools/prova-elevenlabs.js'].includes(f) || f.startsWith('public/') },
  { re: /sk-ant-(?!test|\*\*\*|api03-ABCDEF|da-file|\.\.\.)[A-Za-z0-9_-]{12,}/, msg: 'possibile chiave API nel codice', salta: () => false },
  { re: /—/, msg: 'em dash nel testo (regola di scrittura del progetto)', salta: x => x === 'tools/check.js' },
  { re: /x-api-key|api\.anthropic\.com|anthropic-version|\/v1\/messages|new Anthropic\(|@anthropic-ai\/sdk|claude-agent-sdk/i, msg: 'codice o riferimento all API a pagamento (Orbit usa solo claude -p con l abbonamento)', salta: f => ['tools/check.js', 'log.js'].includes(f) || f.startsWith('tests/') },
  { re: /['"]--bare['"]/, msg: 'uso di --bare (richiede una chiave API)', salta: f => ['tools/check.js'].includes(f) || f.startsWith('tests/') },
  { re: /\bdebugger\b/, msg: 'debugger', salta: f => f.includes('check.js') },
  { re: /writeFileSync|appendFileSync|unlinkSync|rmSync|renameSync/, msg: 'scrittura su file: nel codice di Orbit solo storage/db.js e config (mai sul vault)', salta: f => f.startsWith('tests/') || ['tools/check.js', 'tools/installa-voce.js', 'voice/piper.js', 'integrations/obsidian/scrittura.js', 'integrations/documenti/lettori.js', 'integrations/google/oauth.js', 'tools/bench-memoria.js', 'tools/validazione-memoria.js', 'voice/whisper.js', 'tools/installa-stt.js', 'tools/prova-stt.js', 'tools/prova-elevenlabs.js'].includes(f) }
];
for (const f of tutti.filter(x => /\.(js|html|css|md)$/.test(x) || x.endsWith('.env.example'))) {
  const r = rel(f);
  const testo = fs.readFileSync(f, 'utf8');
  for (const regola of REGOLE) {
    if (!f.endsWith('.js') && !['—'].some(c => regola.re.source.includes(c)) && !regola.re.source.includes('sk-ant')) continue;
    if (regola.salta(r)) continue;
    const m = testo.match(regola.re);
    if (m) problemi.push(r + ': ' + regola.msg);
  }
}

// 3. Coerenza: ogni file pubblico servito esiste e ogni script dell'HTML e nella lista.
const server = fs.readFileSync(path.join(RADICE, 'server.js'), 'utf8');
for (const m of server.matchAll(/'\/[\w.-]*': \['([\w.-]+)'/g)) {
  if (!fs.existsSync(path.join(RADICE, 'public', m[1]))) problemi.push('public/' + m[1] + ': servito dal server ma assente');
}
const html = fs.readFileSync(path.join(RADICE, 'public', 'index.html'), 'utf8');
for (const m of html.matchAll(/(?:src|href)="\/([\w.-]+)"/g)) {
  if (!fs.existsSync(path.join(RADICE, 'public', m[1]))) problemi.push('index.html: riferimento a /' + m[1] + ' inesistente');
}
if (/<script>[^<]|style="/.test(html)) problemi.push('index.html: script o stili inline non consentiti dalla CSP');

// 4. Il codice di memoria resta in sola lettura.
const memoria = file(path.join(RADICE, '..', 'memoria')).filter(f => f.endsWith('.js'));
for (const f of memoria) {
  const t = fs.readFileSync(f, 'utf8');
  const sospetto = t.match(/\b(writeFileSync|appendFileSync|unlinkSync|rmSync|renameSync|copyFileSync)\b/g);
  if (sospetto && !f.endsWith('cli.js') && !/indice\.js$|config\.js$/.test(f)) problemi.push('memoria/' + path.basename(f) + ': scrittura su file (la memoria deve restare in sola lettura)');
}

// 5. smart-inbox/ vive fuori da orbit/: child_process solo nell adapter cli-windows.js e con i vincoli di quel controllo.
const SI = path.join(RADICE, '..', 'smart-inbox');
if (fs.existsSync(SI)) {
  const si = require('./check-smart-inbox');
  problemi.push(...si.controllaSmartInbox(si.raccogliFile(SI, SALTA)));   // ricorsivo, tests/ escluso (child_process vi e ammesso)
}

if (problemi.length) {
  process.stdout.write('Controlli statici: ' + problemi.length + ' problemi\n' + problemi.map(p => ' - ' + p).join('\n') + '\n');
  process.exit(1);
}
process.stdout.write('Controlli statici superati su ' + js.length + ' file JavaScript.\n');
