'use strict';
// Autorizzazione persistente con bridge REALE su vault TEMPORANEO di tipo reale (nessun dato personale; nessuna finestra deve comparire).
// Uso (Windows): $env:SMART_INBOX_PWSH='<pwsh.exe 7.6.7 pinnato>'; $env:SMART_INBOX_SCRIPT_MANIFEST_SHA256=(node smart-inbox/integrita.js --pin); node smart-inbox/tests/e2e-auto.cjs
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { scriviMarker } = require('../perimetro'), { run } = require('../cli'), cw = require('../cli-windows');
const { creaIntegrazioneSmartInbox } = require('../../orbit/integrations/smartinbox');
if (!process.env.SMART_INBOX_PWSH) throw new Error('SMART_INBOX_PWSH richiesto');
const base = fs.realpathSync(os.tmpdir()), h = n => crypto.randomBytes(n).toString('hex'), esiti = [], creati = [];
const verifica = (nome, ok, extra) => { esiti.push((ok ? 'OK   ' : 'FAIL ') + nome); if (!ok) console.log(nome, JSON.stringify(extra)); };
const SORGENTE = '# Prova\nNota sintetica.\n';
function nuovo() {
  const vault = path.join(base, 'vault-' + h(4)), stage = path.join(base, 'orbit-smart-inbox-real-' + h(16));
  creati.push(vault, stage);
  for (const d of ['home', 'tmp', 'technical/v']) fs.mkdirSync(path.join(stage, d), { recursive: true });
  for (const d of ['to sort', 'cervello', 'smart inbox']) fs.mkdirSync(path.join(vault, d), { recursive: true });
  fs.writeFileSync(path.join(vault, 'to sort', 'Prova.md'), SORGENTE);
  scriviMarker(stage, vault);
  return { stage, vault, ctx: { stage, vault, technical: 'technical/v' } };
}
const elenco = (v, d) => fs.existsSync(path.join(v, d)) ? fs.readdirSync(path.join(v, d)) : null;
const esito = p => p.then(r => ({ state: r.state, code: r.code }), e => ({ state: 'ERRORE', code: e.code || e.message }));
const auto = (A, regole) => c => cw.open(c, { aree: [A.vault], autoApplica: true, regole });

async function scenari() {
  // 1. Base: CREATE nella cartella predefinita; il bridge senza -AutoAdditive rifiuta anche se Node salta la finestra.
  let A = nuovo(); const input = { context: A.ctx, autorizzati: ['cervello', 'smart inbox'], creaIn: ['smart inbox'], creaDefault: 'smart inbox' };
  const b = await run('prepare', input, c => cw.open(c, { aree: [A.vault] }));
  verifica('prepare: CREATE nella cartella predefinita (creaDefault)', b.piano.decisioni[0].esito === 'CREATE', b.piano.decisioni);
  const rifiuto = await esito(run('apply', { bundle: b }, c => cw.open(c, { aree: [A.vault], autoApplica: false }), { autoApplica: true }));
  verifica('bridge senza -AutoAdditive rifiuta anche se Node salta la finestra', rifiuto.code === 'HOST_CONFIRMATION_REQUIRED', rifiuto);
  verifica('nessuna scrittura dopo il rifiuto', elenco(A.vault, 'smart inbox').length === 0);
  const ok = await run('apply', { bundle: b }, auto(A), { autoApplica: true });
  verifica('apply automatico di una CREATE: APPLIED senza finestra', ok.state === 'APPLIED', ok);
  verifica('nota creata con i byte della sorgente, sorgente intatta', fs.readFileSync(path.join(A.vault, 'smart inbox', 'Prova.md'), 'utf8') === SORGENTE && fs.existsSync(path.join(A.vault, 'to sort', 'Prova.md')));
  verifica('journal e backup fuori dal vault', fs.readdirSync(path.join(A.stage, 'technical/v')).length > 0 && !fs.readdirSync(A.vault).some(n => n.startsWith('.orbit')));

  // 2. Nessuna duplicazione: stesso piano riapplicato dopo il successo.
  const ancora = await esito(run('apply', { bundle: b }, auto(A), { autoApplica: true }));
  verifica('riapplicare lo stesso piano e idempotente: nessuna copia, stessi byte', elenco(A.vault, 'smart inbox').length === 1
    && fs.readFileSync(path.join(A.vault, 'smart inbox', 'Prova.md'), 'utf8') === SORGENTE, ancora);

  // 3. Modifica concorrente: un file con lo stesso nome compare dopo il piano.
  A = nuovo(); const bc = await run('prepare', { ...input, context: A.ctx }, c => cw.open(c, { aree: [A.vault] }));
  fs.writeFileSync(path.join(A.vault, 'smart inbox', 'Prova.md'), 'contenuto concorrente\n');
  const conc = await esito(run('apply', { bundle: bc }, auto(A), { autoApplica: true }));
  verifica('modifica concorrente: nessuna sovrascrittura, esito non APPLIED', conc.state !== 'APPLIED' && fs.readFileSync(path.join(A.vault, 'smart inbox', 'Prova.md'), 'utf8') === 'contenuto concorrente\n', conc);

  // 4. create_dir: il bridge lo accetta solo se l'host lo autorizza; Node piu permissivo del bridge = rifiuto del bridge.
  A = nuovo(); const dirInput = { context: A.ctx, autorizzati: ['cervello', 'smart inbox'], creaIn: ['smart inbox', 'smart inbox/nuova'], creaDefault: 'smart inbox/nuova' };
  const bd = await run('prepare', dirInput, c => cw.open(c, { aree: [A.vault] }));
  const permissive = { operazioni: ['create', 'append', 'create_dir'], cartelle: null };
  const dirRifiuto = await esito(run('apply', { bundle: bd }, auto(A), { autoApplica: true, regole: permissive }));
  verifica('create_dir: bridge con regole di default rifiuta anche se Node lo permette', dirRifiuto.code === 'HOST_CONFIRMATION_REQUIRED' && elenco(A.vault, 'smart inbox/nuova') === null, dirRifiuto);
  const dirFuori = await esito(run('apply', { bundle: bd }, auto(A, { operazioni: ['create', 'create_dir'], cartelle: ['cervello'] }), { autoApplica: true, regole: permissive }));
  verifica('cartella fuori da autoCartelle: il bridge rifiuta', dirFuori.code === 'HOST_CONFIRMATION_REQUIRED' && elenco(A.vault, 'smart inbox/nuova') === null, dirFuori);
  const dirOk = await esito(run('apply', { bundle: bd }, auto(A, permissive), { autoApplica: true, regole: permissive }));
  verifica('create_dir autorizzato: cartella e nota create senza finestra', dirOk.state === 'APPLIED' && elenco(A.vault, 'smart inbox/nuova')?.includes('Prova.md'), dirOk);

  // 5. Un solo comando (strumento prepara dell'integrazione, Node + bridge reali), con revoca.
  A = nuovo();
  const ambito = { ...dirInput, context: A.ctx, autoApplica: true, autoOperazioni: ['create', 'append', 'create_dir'] };
  const unico = await creaIntegrazioneSmartInbox({ ambito }).strumenti.prepara.esegui({}, { conversazione: 'e2e' });
  verifica('un solo comando: prepara crea cartella e nota e dichiara l\'esito reale', unico.applicato === true && unico.esito.state === 'APPLIED' && elenco(A.vault, 'smart inbox/nuova')?.includes('Prova.md'), unico);
  A = nuovo();
  const revocata = await creaIntegrazioneSmartInbox({ ambito: { ...ambito, context: A.ctx, autoApplica: false } }).strumenti.prepara.esegui({}, { conversazione: 'e2e' });
  verifica('revoca (autoApplica false): solo proposta, nessuna scrittura', revocata.esito === undefined && revocata.applicato === false && elenco(A.vault, 'smart inbox/nuova') === null, revocata);
}
scenari().catch(e => verifica('esecuzione', false, e.code || e.message)).finally(() => {
  for (const p of creati) fs.rmSync(p, { recursive: true, force: true });
  console.log(esiti.join('\n')); process.exitCode = esiti.some(l => l.startsWith('FAIL')) ? 1 : 0;
});
