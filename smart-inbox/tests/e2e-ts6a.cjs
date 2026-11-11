'use strict';
// Collaudo end-to-end TS-6A su vault SINTETICO: Safe Writer e bridge Windows reali (pwsh pinnato).
// Il consenso e SIMULATO da questo host di test (confirm = true), non e un consenso umano. Nessuna AI, nessun vault personale.
// Uso (Windows): $env:SMART_INBOX_PWSH='<pwsh.exe con SHA-256 pinnato>'; node smart-inbox/tests/e2e-ts6a.cjs
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { run } = require('../cli');
const { creaIntegrazioneSmartInbox } = require('../../orbit/integrations/smartinbox');
const { sha } = require('../policy');
const { scriviMarker } = require('../perimetro');
const { scriviManifest } = require('../integrita');

const stage = path.join(fs.realpathSync(os.tmpdir()), 'orbit-smart-inbox-ts3-' + crypto.randomBytes(16).toString('hex'));
const vault = 'data/e2e/vault', technical = 'technical/e2e', root = path.join(stage, vault);
for (const d of ['home', 'tmp', vault + '/to sort', vault + '/liste', technical]) fs.mkdirSync(path.join(stage, d), { recursive: true });
const SRC = path.join(root, 'to sort/Film da guardare.md'), DST = path.join(root, 'liste/Film da vedere.md');
fs.writeFileSync(SRC, '# Film da guardare\n- Dune\n'); fs.writeFileSync(DST, '# Film da vedere\n- Alien\n');
// Note esca fuori dalle cartelle autorizzate: non devono cambiare in nessun caso.
fs.mkdirSync(path.join(root, 'archivio')); fs.writeFileSync(path.join(root, 'archivio/Ricette.md'), '# Ricette\n- Pasta\n'); fs.writeFileSync(path.join(root, 'Indice.md'), '# Indice\n');
const snapshot = () => Object.fromEntries(fs.readdirSync(stage, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
  .map(e => { const f = path.join(e.parentPath, e.name); return [path.relative(stage, f).split(path.sep).join('/'), sha(fs.readFileSync(f))]; }));
const snap0 = snapshot();
const srcHash0 = sha(fs.readFileSync(SRC));
const tree = dir => fs.readdirSync(dir, { recursive: true }).sort();
const conta = (testo, s) => testo.split('\n').filter(l => l.trim() === s).length;

// Host di test: copia di cli-windows.js, policy.js e windows/ in una cartella temporanea dove l'UNICA modifica e la finestra di consenso
// (Confirm-ExactRequest -> true). Pin SHA-256, spawn, Engine nativo e Safe Writer restano quelli reali. Il bridge originale non e toccato.
// Dal TS-6B il bridge verifica manifest e perimetro: la copia sta in smart-inbox/ (cosi l'area "repository" non contiene lo stage), ha il proprio manifest ricalcolato e lo stage ha il marker dell'host.
const host = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'orbit-ts6a-testhost-')), hostSi = path.join(host, 'smart-inbox');
fs.cpSync(path.join(__dirname, '..', 'windows'), path.join(hostSi, 'windows'), { recursive: true });
for (const f of ['cli-windows.js', 'policy.js', 'integrita.js', 'perimetro.js']) fs.copyFileSync(path.join(__dirname, '..', f), path.join(hostSi, f));
const ps1 = path.join(hostSi, 'windows', 'cli-host.ps1'), CONF = '$answer=Confirm-ExactRequest $request $hash $vault';
const orig = fs.readFileSync(ps1, 'utf8'); if (orig.split(CONF).length !== 2) throw new Error('punto di consenso non trovato');
fs.writeFileSync(ps1, orig.replace(CONF, '$answer=$true')); scriviManifest(path.join(hostSi, 'windows')); scriviMarker(stage);
const aprire = require(path.join(hostSi, 'cli-windows.js')).open;
// pin dell'host di test = hash del manifest della copia
const open = (c, o) => { process.env.SMART_INBOX_SCRIPT_MANIFEST_SHA256 = sha(require('../integrita').normalizza(fs.readFileSync(path.join(hostSi, 'windows', 'MANIFEST.sha256')))); return aprire(c, o); };

let now = Date.now(); const log = [];
// Backend reale, ma confirm() risponde true: consenso simulato, ammesso solo perche lo stage e sintetico (context() in cli.js lo impone).
const backend = async c => { const b = await open(c); return { ...b, confirm: async body => (log.push('consenso-simulato'), b.confirm(body)) }; };
const integr = creaIntegrazioneSmartInbox({ orologio: () => now, esegui: (cmd, input) => run(cmd, input, backend),
  ambito: { context: { stage, vault, technical }, autorizzati: ['liste'], creaIn: ['liste'], creazioni: { 'to sort/Film da guardare.md': 'liste' } } });
const ctx = { conversazione: 'e2e-sintetica', richiesta: 'e2e' };
const tool = (n, p) => integr.strumenti[n].esegui(p, ctx);
const valuta = prep => JSON.stringify(prep.richiesteSemantiche.map(q => ({ sorgente: { percorso: q.sorgente.percorso, sha256: q.sorgente.sha256 },
  valutazioni: q.candidati.map(n => ({ percorso: n.percorso, sha256: n.sha256, relazione: 'equivalente' })) })));

(async () => {
  const out = { stage, testHost: host, consenso: 'SIMULATO (host di test, non umano)' };
  const prep = await tool('prepara', {}); const piano = await tool('valuta_piano', { piano: prep.piano, valutazioni: valuta(prep) });
  out.decisioni = piano.decisioni; out.statoPrima = (await tool('stato', { piano: prep.piano })).state;
  const treeBefore = tree(path.join(stage, technical));
  out.apply1 = (await tool('applica', { piano: prep.piano })).state;
  const testo = fs.readFileSync(DST, 'utf8');
  out.alienOk = conta(testo, '- Alien') === 1; out.duneOk = conta(testo, '- Dune') === 1;
  out.sorgenteIntatta = sha(fs.readFileSync(SRC)) === srcHash0;
  out.tecnicoPrima = treeBefore; out.tecnicoDopo = tree(path.join(stage, technical)); out.destinazione = testo;
  const hashDopo1 = sha(fs.readFileSync(DST));
  // Idempotenza: nuovo ciclo completo, nessun duplicato e destinazione invariata.
  const prep2 = await tool('prepara', {}); const piano2 = await tool('valuta_piano', { piano: prep2.piano, valutazioni: valuta(prep2) });
  out.decisioni2 = piano2.decisioni;
  try { out.apply2 = (await tool('applica', { piano: prep2.piano })).state; } catch (e) { out.apply2 = 'ERRORE ' + (e.code || e.message); }
  const testo2 = fs.readFileSync(DST, 'utf8');
  out.idempotente = sha(fs.readFileSync(DST)) === hashDopo1 && conta(testo2, '- Dune') === 1 && conta(testo2, '- Alien') === 1;
  // Piano scaduto: oltre i 10 minuti l'apply deve essere rifiutato senza scrivere.
  const prep3 = await tool('prepara', {}); now += 11 * 60 * 1000;
  try { await tool('applica', { piano: prep3.piano }); out.scaduto = 'ERRORE: accettato'; } catch (e) { out.scaduto = 'rifiutato: ' + (e.code || e.message); }
  out.scadutoNessunaScrittura = sha(fs.readFileSync(DST)) === hashDopo1;
  out.consensiSimulati = log.length;
  // Perimetro: rispetto allo stage iniziale cambia solo la destinazione; cartella tecnica e home/tmp del bridge possono solo crescere.
  const snap1 = snapshot(), dst = vault + '/liste/Film da vedere.md';
  out.fuoriPerimetro = Object.keys({ ...snap0, ...snap1 }).filter(k => snap0[k] !== snap1[k] && k !== dst && k !== '.orbit-smart-inbox-perimetro.json' && !['technical', 'home', 'tmp'].includes(k.split('/')[0]));
  out.vaultTocchiAttesi = Object.keys({ ...snap0, ...snap1 }).filter(k => snap0[k] !== snap1[k] && k.startsWith(vault + '/'));
  // Negativo: un pwsh.exe diverso dal pin (es. un altra release ufficiale) deve essere rifiutato.
  if (process.env.SMART_INBOX_PWSH_SBAGLIATO) {
    const buono = process.env.SMART_INBOX_PWSH; process.env.SMART_INBOX_PWSH = process.env.SMART_INBOX_PWSH_SBAGLIATO;
    try { await open({ stage, vault, technical }); out.runtimeSbagliato = 'ERRORE: accettato'; } catch (e) { out.runtimeSbagliato = 'rifiutato: ' + e.code; }
    process.env.SMART_INBOX_PWSH = buono;
  }
  // Esito: il processo esce con 1 se un controllo atteso fallisce (prima usciva 0 anche con controlli falliti).
  out.attesiOk = out.apply1 === 'APPLIED' && out.alienOk && out.duneOk && out.sorgenteIntatta && out.idempotente && out.scadutoNessunaScrittura
    && out.fuoriPerimetro.length === 0 && out.vaultTocchiAttesi.join() === dst && /^rifiutato/.test(out.scaduto) && (!('runtimeSbagliato' in out) || /^rifiutato/.test(out.runtimeSbagliato));
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  if (!out.attesiOk) process.exitCode = 1;
})().finally(() => fs.rmSync(host, { recursive: true, force: true })).catch(e => { process.stdout.write(JSON.stringify({ stage, FAIL: e.code || e.message }) + '\n'); process.exitCode = 1; });
