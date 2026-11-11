'use strict';
// Validazione della memoria di Orbit con risposte attese fissate PRIMA di chiamare il modello.
// Due modalita:
//   node orbit/tools/validazione-memoria.js --locale            nessuna chiamata AI: precisione per sezione e copertura dei fatti nel contesto
//   node orbit/tools/validazione-memoria.js --modello --max N   chiama davvero il modello con la pipeline di Orbit (abbonamento), al massimo N chiamate
// Con --dataset privato (predefinito) usa le domande originali in privato/benchmark e il vault personale; con --dataset pubblico
// il vault inventato in esempi/benchmark. Il dataset privato non e mai sostituito in silenzio da quello pubblico (vedi dataset.js).
// Lavora su una COPIA del vault (il vault vero non viene mai scritto) e su un database temporaneo; integrazioni spente
// (si valuta la memoria: niente calendario, web o scrittura nel cervello). Il Quality Gate resta quello normale.
const fs = require('fs');
const os = require('os');
const path = require('path');

const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const CODICE = path.resolve(arg('--codice') || path.join(__dirname, '..', '..'));
let DATASET;
try { DATASET = require('./dataset').carica(require('./dataset').nomeScelto()); } catch (e) { process.stderr.write('Errore: ' + e.message + '\n'); process.exit(2); }
const ORIG = DATASET.vaultOrigine;
process.stderr.write('Dataset: ' + DATASET.nome + ' (' + DATASET.file + ')\n');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-valid-'));
const COPIA = path.join(BASE, 'vault');
(function copia(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const v of fs.readdirSync(src, { withFileTypes: true })) {
    if (v.isDirectory()) { if (!v.name.startsWith('.') && v.name !== 'node_modules') copia(path.join(src, v.name), path.join(dst, v.name)); }
    else if (v.isFile()) fs.copyFileSync(path.join(src, v.name), path.join(dst, v.name));
  }
})(ORIG, COPIA);
fs.mkdirSync(path.join(COPIA, '.obsidian'), { recursive: true });
process.env.ORBIT_VAULT_PATH = COPIA; process.env.ORBIT_INDEX_DIR = path.join(BASE, 'indice');

// Domande (identiche al benchmark) e risposte attese ricavate dal vault, lette dal dataset scelto. "fatti": espressioni che devono comparire nel contesto
// perche la risposta sia possibile; una sezione inviata e "utile" se contiene almeno un fatto.
const DOMANDE = DATASET.domande;

const memoria = require(path.join(CODICE, 'memoria', 'memoria'));
const { classifica } = require(path.join(CODICE, 'orbit', 'ai', 'router', 'classifier'));
const { costruisci } = require(path.join(CODICE, 'orbit', 'ai', 'context'));
memoria.avvia();

// Contesto locale: sezioni inviate e fatti coperti
function analizzaContesto(d) {
  const cls = classifica(d.q, { storia: 0, haVault: true });
  if (cls.ambigua) return { ambigua: true, sezioni: [], utili: 0, fattiTrovati: 0 };
  const ctx = costruisci({ messaggio: d.q, storia: [], classificazione: cls, memoria, maxInputToken: 12000 });
  const vault = (ctx.messaggi.at(-1).content.match(/<contesto_vault>[\s\S]*?<\/contesto_vault>/) || [''])[0];
  // frammenti: le <sezione> (passo 2) oppure le <nota> intere (codice precedente)
  const sez = [...vault.matchAll(/<sezione percorso="([^"]*)"[^>]*>([\s\S]*?)<\/sezione>/g)].map(m => ({ id: m[1], testo: m[2] }));
  const frammenti = sez.length ? sez : [...vault.matchAll(/<nota percorso="([^"]*)"[^>]*>([\s\S]*?)<\/nota>/g)].map(m => ({ id: m[1], testo: m[2] }));
  const utili = frammenti.filter(f => d.fatti.some(re => re.test(f.testo))).length;
  const fattiTrovati = d.fatti.filter(re => re.test(ctx.messaggi.at(-1).content)).length;   // anche dal profilo: anche quello arriva al modello
  return { ambigua: false, frammenti: frammenti.map(f => f.id), nFrammenti: frammenti.length, utili, precisioneFrammenti: frammenti.length ? +(utili / frammenti.length).toFixed(2) : (d.fatti.length ? 0 : 1), fattiTrovati, fattiTotali: d.fatti.length };
}

async function conModello(maxChiamate) {
  const { creaApp } = require(path.join(CODICE, 'orbit', 'app'));
  const config = require(path.join(CODICE, 'orbit', 'config'));
  const { Storage } = require(path.join(CODICE, 'orbit', 'storage', 'db'));
  const { settings } = config.carica();
  settings.dataDir = path.join(BASE, 'dati'); fs.mkdirSync(settings.dataDir, { recursive: true });
  const app = creaApp({ settings, memoria, storage: new Storage(path.join(BASE, 'dati', 'valid.sqlite')) });
  // tetto rigido di chiamate: oltre, la richiesta si ferma (nessun consumo nascosto)
  // Registro di ogni chiamata reale (ruolo, modello, token riportati da Claude Code) e tetto rigido.
  const orig = app.provider.executeTask.bind(app.provider); let chiamate = 0, corrente = null; const registro = [];
  app.provider.executeTask = async req => {
    if (chiamate >= maxChiamate) throw Object.assign(new Error('Tetto di chiamate della validazione raggiunto'), { code: 'TETTO' });
    chiamate++;
    const voce = { domanda: corrente, ruolo: /verificatore di qualita/.test(req.system || '') ? 'verificatore' : 'produttore', modelloRichiesto: req.model };
    try { const r = await orig(req); Object.assign(voce, { modello: r.model, tokenIn: r.usage && r.usage.inputTokens, tokenOut: r.usage && r.usage.outputTokens, ok: true }); return r; }
    catch (e) { Object.assign(voce, { ok: false, errore: e.code || e.message }); throw e; }
    finally { registro.push(voce); }
  };
  const scelte = arg('--domande') ? arg('--domande').split(',').map(Number) : DOMANDE.map((_, i) => i + 1);
  const out = [];
  for (const n of scelte) {
    const d = DOMANDE[n - 1]; corrente = n;
    if (chiamate >= maxChiamate) { out.push({ n, q: d.q, saltata: 'tetto di chiamate raggiunto' }); continue; }
    const prima = chiamate; const t0 = Date.now();
    const r = await app.orchestrator.elabora({ messaggio: d.q });
    out.push({ n, q: d.q, ok: r.ok, testo: r.testo || r.errore, verifica: r.verifica || r.codice, limitazioni: r.limitazioni || null, fonti: (r.fonti || []).map(f => f.percorso), chiamate: chiamate - prima,
      modelli: registro.filter(v => v.domanda === n).map(v => v.ruolo + ':' + (v.modello || v.modelloRichiesto)),
      tokenIn: registro.filter(v => v.domanda === n).reduce((s, v) => s + (v.tokenIn || 0), 0), tokenOut: registro.filter(v => v.domanda === n).reduce((s, v) => s + (v.tokenOut || 0), 0),
      ms: Date.now() - t0, tentativi: r.tentativi, escalation: r.escalation });
    process.stderr.write('[domanda ' + n + '] chiamate finora: ' + chiamate + '\n');
  }
  return { chiamateTotali: chiamate, tetto: maxChiamate, risposte: out, registro };
}

(async () => {
  const locale = DOMANDE.map(d => Object.assign({ tipo: d.tipo, q: d.q, attesa: d.attesa }, analizzaContesto(d)));
  const res = { dataset: DATASET.nome, codice: CODICE, data: new Date().toISOString(), locale };
  if (process.argv.includes('--modello')) res.modello = await conModello(Number(arg('--max')) || 12);
  const json = JSON.stringify(res, null, 1);
  if (arg('--json')) fs.writeFileSync(arg('--json'), json); else process.stdout.write(json + '\n');
})().catch(e => { process.stderr.write('Errore: ' + e.message + '\n'); process.exit(1); });
