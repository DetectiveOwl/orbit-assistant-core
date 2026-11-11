#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { leggiSnapshot } = require('./reader');
const { pianifica } = require('./planner');
const { prepara, creaHost } = require('./writer');
const { relativo, canonico, sotto, errore } = require('./policy');
const { STAGE } = require('./perimetro');

const VERSION = 'smart-inbox-cli/1';
function keys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some(k => !allowed.includes(k))) throw errore('INPUT_CLI_NON_VALIDO');
}
function context(value) {
  keys(value, ['stage', 'vault', 'technical']);
  if (typeof value.stage !== 'string' || !/^[a-z]:\\/i.test(value.stage) || !path.isAbsolute(value.stage)
    || path.resolve(value.stage) !== value.stage || !STAGE.test(path.basename(value.stage))) throw errore('STAGING_SINTETICO_RICHIESTO');
  // Stage reale: il vault e un percorso assoluto (validato da perimetro e dal bridge, che lo confronta col marker dell'host).
  const vaultAssoluto = /^orbit-smart-inbox-real-/.test(path.basename(value.stage)) && path.resolve(String(value.vault)) === value.vault && /^[a-z]:\\/i.test(value.vault);
  if (!vaultAssoluto && relativo(value.vault) !== value.vault) throw errore('PERCORSO_NON_SICURO');
  if (relativo(value.technical) !== value.technical) throw errore('PERCORSO_NON_SICURO');
  return value;
}
function bundle(value) {
  keys(value, ['version', 'context', 'rootIdentity', 'snapshot', 'creazioni', 'piano', 'richiesteSemantiche', 'valutazioniUsate']);
  if (value.version !== VERSION || !/^[0-9A-F]{8}:[0-9A-F]{16}$/.test(value.rootIdentity)) throw errore('BUNDLE_NON_VALIDO');
  context(value.context); return value;
}
async function plan(snapshot, creazioni, evaluations = []) {
  if (!Array.isArray(evaluations) || evaluations.length > 20) throw errore('VALUTAZIONI_NON_VALIDE');
  const known = new Set(), used = new Set(), richiesteSemantiche = [];
  for (const row of evaluations) {
    keys(row, ['sorgente', 'valutazioni']); keys(row.sorgente, ['percorso', 'sha256']);
    if (!snapshot.sorgenti.some(n => n.percorso === row.sorgente.percorso && n.sha256 === row.sorgente.sha256)
      || known.has(canonico(row.sorgente)) || !Array.isArray(row.valutazioni)) throw errore('VALUTAZIONI_NON_VALIDE');
    known.add(canonico(row.sorgente));
  }
  // Per dimostrare l'assenza ogni nota del catalogo viene confrontata, a LOTTI di 16 note (planner.dividiInLotti): nessun limite al numero di note fino a 12 lotti (circa 190 note),
  // oltre il quale il motivo e CATALOGO_OLTRE_I_LIMITI_DI_CONFRONTO. Ogni riga di valutazione copre una sorgente e tutti i suoi lotti; qui la si ripartisce per lotto.
  const piano = await pianifica(snapshot, { creaIn: creazioni, maxChiamate: 240, maxCandidati: 16, maxCaratteri: 60000, valuta: input => {
    const sorgente = { percorso: input.sorgente.percorso, sha256: input.sorgente.sha256 };
    richiesteSemantiche.push({ sorgente: input.sorgente, candidati: input.candidati, copertura: input.copertura, lotto: input.lotto, lotti: input.lotti });
    const row = evaluations.find(r => canonico(r.sorgente) === canonico(sorgente));
    if (row) {
      used.add(canonico(sorgente));
      // del lotto: le righe sui suoi percorsi; il lotto 0 riceve anche quelle su percorsi fuori dal catalogo, cosi il planner le rifiuta (PROPOSTA_FUORI_CONTRATTO) come prima.
      const nelLotto = new Set(input.candidati.map(n => n.percorso)), nelCatalogo = new Set(input.catalogoPercorsi);
      return { valutazioni: row.valutazioni.filter(v => (!v || typeof v !== 'object') ? input.lotto === 0 : (nelLotto.has(v.percorso) || (input.lotto === 0 && !nelCatalogo.has(v.percorso)))) };
    }
    return { valutazioni: input.candidati.map(n => ({ percorso: n.percorso, sha256: n.sha256, relazione: 'incerta' })) };
  } });
  if (used.size !== evaluations.length) throw errore('VALUTAZIONI_NON_RICHIESTE');
  return { piano, richiesteSemantiche, valutazioniUsate: used.size };
}

// Il backend e codice dell'host fidato, non un percorso o una callback ricevuti dal JSON del modello.
// Aggiunte pure (solo create/append, nessuna archiviazione, poche note, dimensioni contenute): l'unico caso in cui l'host puo saltare la finestra di consenso.
// Il bridge ripete lo stesso controllo (cli-host.ps1, Test-Additive) e parte con -AutoAdditive solo se lo decide l'host.
// Autorizzazione persistente (regole dell'host, vedi perimetro.regoleAuto): solo i tipi di operazione e le cartelle autorizzati saltano la finestra.
// Creare una cartella richiede 'create_dir' tra le operazioni (di default NO) e la cartella dentro quelle autorizzate. Il bridge ripete lo stesso controllo.
const REGOLE_BASE = { operazioni: ['create', 'append'], cartelle: null };
const inCartelle = (p, cartelle) => !cartelle || cartelle.some(c => sotto(p, c));
const additivo = (spec, archive, { operazioni, cartelle } = REGOLE_BASE) => !archive.length && spec.outputs.length >= 1 && spec.outputs.length <= 20
  && (!spec.mkdirs.length || (operazioni.includes('create_dir') && spec.mkdirs.every(d => inCartelle(d.path, cartelle))))
  && spec.outputs.every(o => ['create', 'append'].includes(o.kind) && operazioni.includes(o.kind) && o.data.length <= 262144 && inCartelle(o.path, cartelle));
// Operazioni che le regole consentono senza finestra: la selezione parziale (writer.seleziona) esclude le altre, che restano da confermare.
const ammettiDa = ({ operazioni, cartelle }) => (op, piano) => {
  const kind = op.tipo === 'create_note' ? 'create' : 'append', p = op.destinazione.percorso, dir = p.slice(0, p.lastIndexOf('/'));
  return operazioni.includes(kind) && inCartelle(p, cartelle) && (!piano.cartelleDaCreare.includes(dir) || (operazioni.includes('create_dir') && inCartelle(dir, cartelle)));
};
// Sottoinsieme applicabile senza finestra secondo le regole (stessa decisione di run() con auto:true; ogni errore = null) e cio che resta in sospeso.
function selezione(b, regole) {
  try { const s = prepara(b.piano, b.snapshot, { ammetti: ammettiDa(regole) }).spec; return { applicabile: additivo(s, [], regole), scritte: s.outputs.map(o => o.path), aggiunte: s.outputs.filter(o => o.kind === 'append').map(o => o.path), sospese: s.sospese || [] }; } catch { return null; }
}
const autorizzato = (b, regole) => !!selezione(b, regole)?.applicabile;
async function run(command, input, makeBackend = c => require('./cli-windows').open(c), { autoApplica = false, regole = REGOLE_BASE } = {}) {
  let backend;
  try {
    if (command === 'prepare') {
      keys(input, ['context', 'autorizzati', 'creaIn', 'creazioni', 'creaDefault']);
      const c = context(input.context); backend = await makeBackend(c);
      const info = await backend.attributes();
      const snapshot = leggiSnapshot({ radice: path.resolve(c.stage, c.vault), autorizzati: input.autorizzati, creaIn: input.creaIn,
        verificaReparse: p => {
          const attr = info.attributes[p.toLowerCase()];
          if (!Number.isInteger(attr)) throw errore('VERIFICA_REPARSE_INCOMPLETA');
          return !!(attr & 0x400);
        } });
      // creaDefault (config host): cartella per le note nuove senza una destinazione esplicita in creazioni; la nota si chiama come la sorgente.
      const creazioni = { ...(typeof input.creaDefault === 'string' ? Object.fromEntries(snapshot.sorgenti.map(s => [s.percorso, input.creaDefault])) : {}), ...(input.creazioni || {}) };
      return { version: VERSION, context: c, rootIdentity: info.rootIdentity, snapshot, creazioni, ...await plan(snapshot, creazioni) };
    }
    if (command === 'plan') {
      keys(input, ['bundle', 'valutazioni']); const b = bundle(input.bundle);
      return { ...b, ...await plan(b.snapshot, b.creazioni, input.valutazioni) };
    }
    if (!['apply', 'status', 'recover'].includes(command)) throw errore('COMANDO_NON_VALIDO');
    keys(input, command === 'status' ? ['bundle', 'auto'] : ['bundle', 'archivia', 'recupero', 'auto']);
    // auto:true vale solo se l'host ha acceso l'autorizzazione persistente (autoApplica): sottoinsieme verificato dal codice, piano originale invariato.
    const opzioni = autoApplica === true && input.auto === true ? { ammetti: ammettiDa(regole) } : {};
    const b = bundle(input.bundle), preview = prepara(b.piano, b.snapshot, opzioni);
    const action = command === 'status' ? 'inspect' : command;
    const archive = input.archivia || [], recovery = input.recupero || {};
    if (!Array.isArray(archive)) throw errore('INPUT_CLI_NON_VALIDO');
    backend = await makeBackend(b.context);
    const host = creaHost({ rootId: b.snapshot.rootId, rootIdentity: b.rootIdentity, backend: body => backend.execute(body), opzioni });
    const scope = { azione: action, operazioni: preview.spec.outputs.flatMap(o => o.operationIds), archivia: archive, recupero: recovery };
    const capability = host.confermaDaHost(preview, scope);   // ambito non valido (es. recupero per output sconosciuto) = rifiuto prima di disturbare l'utente con il consenso
    // Piano di soli NOOP senza archiviazione: nessuna scrittura possibile, quindi niente consenso. Il writer fa solo inspect (verifica catalogo e sorgenti) e l'esito e NOOP, non APPLIED.
    if (action === 'apply' && opzioni.ammetti && !preview.spec.outputs.length) return { state: 'NESSUNA_OPERAZIONE_APPLICABILE', code: 'TUTTO_IN_SOSPESO_O_NON_AUTORIZZATO', sospese: preview.spec.sospese || [] };
    const nulla = action === 'apply' && !preview.spec.outputs.length && !archive.length;
    const aggiunta = autoApplica === true && action === 'apply' && additivo(preview.spec, archive, regole);
    if (action !== 'inspect' && !nulla && !aggiunta) {
      const body = canonico({ spec: preview.spec, preview: preview.impronta, rootFileId: b.rootIdentity, action, archive, recovery });
      if ((await backend.confirm(body)) !== true) throw errore('CONSENSO_UMANO_NON_DISPONIBILE_O_NEGATO');
    }
    const result = await host.esegui(b.piano, b.snapshot, nulla ? host.confermaDaHost(preview, { azione: 'inspect' }) : capability);
    if (nulla) return result.state === 'INSPECTED' ? { state: 'NOOP', code: 'NESSUNA_MODIFICA_NECESSARIA', outputs: [], inspection: result } : result;
    if (result.state === 'APPLIED') {
      const inspection = await host.esegui(b.piano, b.snapshot, host.confermaDaHost(preview, { azione: 'inspect' }));
      if (inspection.state !== 'INSPECTED' || inspection.outputs.some(o => o.state !== 'APPLIED')) return { state: 'FAIL', code: 'POST_VERIFICA_NON_RIUSCITA', writer: result, inspection };
      return { ...result, inspection, sintesi: { scritte: preview.spec.outputs.map(o => o.path), aggiunte: preview.spec.outputs.filter(o => o.kind === 'append').map(o => o.path), cartelleCreate: preview.spec.mkdirs.map(d => d.path), sospese: preview.spec.sospese || [] } };
    }
    return result;
  } finally { await backend?.close(); }
}

async function main(args, input, makeBackend) {
  try {
    if (args.length !== 1) throw errore('COMANDO_NON_VALIDO');
    if (args[0] === '--help') return { exit: 0, output: { version: VERSION, commands: ['prepare', 'plan', 'apply', 'recover', 'status'], input: 'JSON su stdin; nessuna approvazione nel JSON' } };
    if (Buffer.byteLength(input) > 32 * 1024 * 1024) throw errore('INPUT_CLI_TROPPO_GRANDE');
    const output = await run(args[0], JSON.parse(input), makeBackend);
    return { exit: output.state === 'FAIL' ? 1 : 0, output };
  } catch (e) { return { exit: 1, output: { state: 'FAIL', code: e.code || 'INPUT_O_HOST_NON_VALIDO' } }; }
}
if (require.main === module) {
  const finish = async input => { const result = await main(process.argv.slice(2), input); process.stdout.write(JSON.stringify(result.output) + '\n'); process.exitCode = result.exit; };
  if (process.argv.length === 3 && process.argv[2] === '--help') void finish('');
  else {
    let input = ''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', text => { input += text; if (Buffer.byteLength(input) > 32 * 1024 * 1024) { process.stdout.write('{"state":"FAIL","code":"INPUT_CLI_TROPPO_GRANDE"}\n'); process.exit(1); } });
    process.stdin.on('end', () => void finish(input));
  }
}
module.exports = { run, main, autorizzato, selezione };
