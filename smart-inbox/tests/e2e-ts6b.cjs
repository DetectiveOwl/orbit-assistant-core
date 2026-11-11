'use strict';
// Collaudo end-to-end TS-6B su vault SINTETICO: bridge Windows (pwsh pinnato), Engine e Safe Writer reali. Nessuna AI, nessun dato personale.
// Verifica: integrita degli script, perimetro, RECOVER dopo interruzione (crash reale del processo del bridge), backup, journal, replay, richieste non autorizzate.
// CONSENSO SIMULATO (non umano): il bridge accetta il consenso solo dalla propria finestra; qui una copia temporanea di cli-host.ps1 sostituisce SOLO
// `$answer=Confirm-ExactRequest ...` con `$answer=$true` (e aggiunge un punto di crash nei checkpoint del motore). Il manifest della copia e ricalcolato
// apposta (la copia e un host di test: la verifica dell originale e coperta dai casi "script alterato"). Il bridge originale non e toccato.
// Uso (Windows): $env:SMART_INBOX_PWSH='<pwsh.exe 7.6.7 con SHA-256 pinnato>'; node smart-inbox/tests/e2e-ts6b.cjs   (exit 1 se un controllo fallisce)
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), { spawn } = require('node:child_process');
const { run } = require('../cli');
const { prepara, creaHost } = require('../writer');
const { creaIntegrazioneSmartInbox } = require('../../orbit/integrations/smartinbox');
const { sha, canonico } = require('../policy');
const { scriviMarker, MARKER } = require('../perimetro');
const { scriviManifest, MANIFEST, verificaScript, copiaVerificata } = require('../integrita');

if (!process.env.SMART_INBOX_PWSH) throw new Error('SMART_INBOX_PWSH richiesto');
const TMP = fs.realpathSync(os.tmpdir()), SORGENTI = path.join(__dirname, '..');
const SRC_REL = 'to sort/Film da guardare.md', DST_REL = 'liste/Film da vedere.md';
const KEY_DST = sha(DST_REL), KEY_SRC = sha(SRC_REL);
const risultati = [], pulizia = [];
const verifica = (nome, ok, dettaglio) => { risultati.push({ nome, ok: !!ok, ...(ok ? {} : { dettaglio }) }); };
const esito = p => p.then(r => ({ state: r.state, code: r.code, r }), e => ({ state: 'ERRORE', code: e.code || e.message }));

// --- host di test (copia del codice host: layout smart-inbox/ dentro una cartella dedicata, cosi l'area "repository" non contiene lo stage)
function creaHostDiTest(etichetta, { crash = true, alterazione = null } = {}) {
  const radice = fs.mkdtempSync(path.join(TMP, 'orbit-ts6b-' + etichetta + '-')), dir = path.join(radice, 'smart-inbox');
  pulizia.push(radice);
  fs.cpSync(path.join(SORGENTI, 'windows'), path.join(dir, 'windows'), { recursive: true });
  for (const f of ['cli-windows.js', 'policy.js', 'integrita.js', 'perimetro.js']) fs.copyFileSync(path.join(SORGENTI, f), path.join(dir, f));
  const ps1 = path.join(dir, 'windows', 'cli-host.ps1'), originale = fs.readFileSync(ps1, 'utf8').replace(/\r\n/g, '\n');
  const consenso = '$answer=Confirm-ExactRequest $request $hash $vault', esegui = '$answer=[SmartInboxWindows.Engine]::new().Execute($vault,$technical,[string]$packet.payload)|ConvertFrom-Json';
  if (originale.split(consenso).length !== 2 || originale.split(esegui).length !== 2) throw new Error('punti di sostituzione non trovati');
  const guasto = "$fault=Join-Path $Stage 'tmp\\fault.json';$cp=[Action[string]]{param($n) if([IO.File]::Exists($fault) -and ([IO.File]::ReadAllText($fault)|ConvertFrom-Json).at -ceq $n){[Environment]::Exit(73)}};"
    + '$answer=[SmartInboxWindows.Engine]::new().Execute($vault,$technical,[string]$packet.payload,$cp)|ConvertFrom-Json';
  fs.writeFileSync(ps1, originale.replace(consenso, '$answer=$true').replace(esegui, crash ? guasto : esegui));
  scriviManifest(path.join(dir, 'windows'));   // solo per la copia di test: il manifest descrive la copia con le sostituzioni sopra
  if (alterazione) alterazione(dir);          // ...e un'alterazione successiva (senza aggiornare il manifest) deve essere rifiutata
  const aprire = require(path.join(dir, 'cli-windows.js')).open, pin = sha(require('../integrita').normalizza(fs.readFileSync(path.join(dir, 'windows', MANIFEST))));
  // il pin e dell'host di test (manifest della copia), non del repo; impostato al momento dell'apertura
  return { dir, pin, aprireGrezzo: aprire, open: (c, o) => { process.env.SMART_INBOX_SCRIPT_MANIFEST_SHA256 = pin; return aprire(c, o); } };
}
const contesto = S => ({ stage: S.stage, vault: S.vault, technical: S.technical });
const backendDi = (host, stat, { consenso = true } = {}) => async c => {
  const b = await host.open(c);
  return { ...b, confirm: async body => { stat.consensi++; return consenso ? b.confirm(body) : false; } };
};

// --- vault sintetico: sorgente grande (la scrittura procede a blocchi da 4096 byte, quindi un crash lascia un parziale)
function nuovoStage(etichetta, righe = 400) {
  const stage = path.join(TMP, 'orbit-smart-inbox-ts3-' + crypto.randomBytes(16).toString('hex')), vault = 'data/' + etichetta + '/vault', technical = 'technical/' + etichetta;
  const root = path.join(stage, vault);
  for (const d of ['home', 'tmp', vault + '/to sort', vault + '/liste', technical]) fs.mkdirSync(path.join(stage, d), { recursive: true });
  const sorgente = '# Film da guardare\n' + Array.from({ length: righe }, (_, i) => '- Titolo sintetico ' + i).join('\n') + '\n', destinazione = '# Film da vedere\n- Alien\n';
  fs.writeFileSync(path.join(root, SRC_REL), sorgente); fs.writeFileSync(path.join(root, DST_REL), destinazione);
  fs.mkdirSync(path.join(root, 'archivio')); fs.writeFileSync(path.join(root, 'archivio/Ricette.md'), '# Ricette\n- Pasta\n'); fs.writeFileSync(path.join(root, 'Indice.md'), '# Indice\n');
  scriviMarker(stage); pulizia.push(stage);
  return { stage, vault, technical, root, dst: path.join(root, DST_REL), src: path.join(root, SRC_REL), tech: path.join(stage, technical), righe, sorgente, destinazione };
}
const istantanea = stage => Object.fromEntries(fs.readdirSync(stage, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
  .map(e => { const f = path.join(e.parentPath, e.name); return [path.relative(stage, f).split(path.sep).join('/'), sha(fs.readFileSync(f))]; }));
async function pianifica(S, backend) {
  const input = { context: contesto(S), autorizzati: ['liste'], creaIn: ['liste'], creazioni: { [SRC_REL]: 'liste' } };
  const b = await run('prepare', input, backend);
  const valutazioni = b.richiesteSemantiche.map(q => ({ sorgente: { percorso: q.sorgente.percorso, sha256: q.sorgente.sha256 },
    valutazioni: q.candidati.map(n => ({ percorso: n.percorso, sha256: n.sha256, relazione: 'equivalente' })) }));
  return run('plan', { bundle: b, valutazioni }, backend);
}
const guasto = (S, at) => fs.writeFileSync(path.join(S.stage, 'tmp', 'fault.json'), JSON.stringify({ at }));
const senzaGuasto = S => fs.rmSync(path.join(S.stage, 'tmp', 'fault.json'), { force: true });
const concessione = status => Object.fromEntries(status.outputs.filter(o => o.state === 'RECOVERY_REQUIRED').map(o => [o.key, { hash: o.hash, fileId: o.fileId }]));
const conta = (testo, riga) => testo.split('\n').filter(l => l === riga).length;
const completo = (S, testo) => Array.from({ length: S.righe }, (_, i) => conta(testo, '- Titolo sintetico ' + i)).every(n => n === 1) && conta(testo, '- Alien') === 1;
function journal(S) {   // verifica indipendente della catena: nome = progressivo + sha256 del file, prev = digest precedente (parte da request.json)
  const piani = fs.readdirSync(S.tech).filter(n => n.startsWith('plan-')); if (piani.length !== 1) return { errore: 'piani=' + piani.length };
  const dir = path.join(S.tech, piani[0]); let prev = sha(fs.readFileSync(path.join(dir, 'request.json'))); const tipi = [];
  const nomi = fs.readdirSync(dir).filter(n => /^\d{6}-[0-9a-f]{64}\.json$/.test(n)).sort();
  for (const [i, nome] of nomi.entries()) {
    const byte = fs.readFileSync(path.join(dir, nome)), rec = JSON.parse(byte);
    if (nome !== String(i + 1).padStart(6, '0') + '-' + sha(byte) + '.json' || rec.prev !== prev) return { errore: 'catena rotta a ' + nome };
    prev = sha(byte); tipi.push(rec.kind + (rec.key === KEY_DST ? '' : ':' + rec.key.slice(0, 6)));
  }
  return { dir, tipi, backup: fs.readdirSync(dir).filter(n => n.endsWith('.bak')) };
}
const backupUguale = (j, prefisso, byte) => { const f = j.backup.filter(n => n.startsWith(prefisso)); return f.length >= 1 && f.some(n => sha(fs.readFileSync(path.join(j.dir, n))) === sha(byte)); };

// === Scenario A: apply interrotto -> richieste non autorizzate -> recover -> replay -> modifiche successive
async function scenarioA(host) {
  const S = nuovoStage('rec-a'), stat = { consensi: 0 }, backend = backendDi(host, stat), snap0 = istantanea(S.stage);
  const origDst = fs.readFileSync(S.dst), origSrc = fs.readFileSync(S.src);
  const bundle = await pianifica(S, backend);
  verifica('A: piano MERGE chiaro', bundle.piano.decisioni[0].esito === 'MERGE', bundle.piano.decisioni);
  const dopoPiano = istantanea(S.stage); verifica('A: prepare/plan non scrivono nel vault', Object.keys(snap0).every(k => k.startsWith('technical') || dopoPiano[k] === snap0[k]));
  const dopo = prepara(bundle.piano, bundle.snapshot).spec.outputs[0].after;
  guasto(S, 'after-write-chunk');
  const crash = await esito(run('apply', { bundle }, backend));
  verifica('A: apply interrotto dal crash reale del bridge', crash.state === 'ERRORE', crash);
  senzaGuasto(S);
  const snapMid = istantanea(S.stage), parziale = fs.readFileSync(S.dst);
  verifica('A: destinazione parziale (prefisso originale, piu lunga, non completa)', parziale.subarray(0, origDst.length).equals(origDst) && parziale.length > origDst.length && sha(parziale) !== dopo, { len: parziale.length });
  verifica('A: sorgente intatta dopo il crash', fs.readFileSync(S.src).equals(origSrc));
  // Dopo "riavvio" di Orbit i piani in memoria non esistono piu
  const nuova = creaIntegrazioneSmartInbox({ ambito: { context: contesto(S), autorizzati: ['liste'], creaIn: ['liste'] }, esegui: (c, i) => run(c, i, backend) });
  const riavvio = await esito(nuova.strumenti.recupera.esegui({ piano: 'si_' + 'a'.repeat(32) }, { conversazione: 'c' }));
  verifica('A: dopo riavvio un piano precedente non e recuperabile dall integrazione (il bundle non e persistito)', riavvio.code === 'PIANO_SMART_INBOX_NON_DISPONIBILE', riavvio);
  const status = (await run('status', { bundle }, backend));
  verifica('A: status = RECOVERY_REQUIRED con hash e fileId osservati', status.state === 'INSPECTED' && status.outputs[0].state === 'RECOVERY_REQUIRED' && status.outputs[0].hash === sha(parziale), status);
  const grant = concessione(status);
  // --- richieste di recupero non autorizzate
  const prima = sha(fs.readFileSync(S.dst)), invariata = () => sha(fs.readFileSync(S.dst)) === prima;
  const apply = await esito(run('apply', { bundle }, backend));
  verifica('A: apply su un parziale e rifiutato (RECOVERY_REQUIRED) senza scrivere', apply.state === 'FAIL' && apply.code === 'RECOVERY_REQUIRED' && invariata(), apply);
  const sbagliato = await esito(run('recover', { bundle, recupero: { [KEY_DST]: { hash: '0'.repeat(64), fileId: grant[KEY_DST].fileId } } }, backend));
  verifica('A: recover con hash non osservato rifiutato', sbagliato.state === 'FAIL' && sbagliato.code === 'RECOVERY_AUTHORIZATION_REQUIRED' && invariata(), sbagliato);
  const altroFile = await esito(run('recover', { bundle, recupero: { [KEY_DST]: { hash: grant[KEY_DST].hash, fileId: 'DEADBEEF:0000000000000001' } } }, backend));
  verifica('A: recover con fileId diverso rifiutato', altroFile.state === 'FAIL' && altroFile.code === 'RECOVERY_AUTHORIZATION_REQUIRED' && invariata(), altroFile);
  const vuoto = await esito(run('recover', { bundle, recupero: {} }, backend));
  verifica('A: recover senza concessione rifiutato', vuoto.state === 'FAIL' && vuoto.code === 'RECOVERY_AUTHORIZATION_REQUIRED' && invariata(), vuoto);
  const consensiPrima = stat.consensi, ignota = await esito(run('recover', { bundle, recupero: { [sha('altro')]: grant[KEY_DST] } }, backend));
  verifica('A: recover per un output sconosciuto rifiutato dall host Node prima di chiedere il consenso', ignota.code === 'AMBITO_AUTORIZZAZIONE_NON_VALIDO' && stat.consensi === consensiPrima && invariata(), ignota);
  const negato = await esito(run('recover', { bundle, recupero: grant }, backendDi(host, stat, { consenso: false })));
  verifica('A: consenso negato = nessun recover', negato.code === 'CONSENSO_UMANO_NON_DISPONIBILE_O_NEGATO' && invariata(), negato);
  const b = await host.open(contesto(S));
  try {
    const preview = prepara(bundle.piano, bundle.snapshot), h = creaHost({ rootId: bundle.snapshot.rootId, rootIdentity: bundle.rootIdentity, backend: body => b.execute(body) });
    const senzaFinestra = await esito(h.esegui(bundle.piano, bundle.snapshot, h.confermaDaHost(preview, { azione: 'recover', operazioni: preview.spec.outputs.flatMap(o => o.operationIds), recupero: grant })));
    verifica('A: execute con capability Node ma senza consenso del bridge rifiutato (HOST_CONFIRMATION_REQUIRED)', senzaFinestra.code === 'HOST_CONFIRMATION_REQUIRED' && invariata(), senzaFinestra);
    const grezza = await esito(b.execute(canonico({ spec: preview.spec, preview: preview.impronta, rootFileId: bundle.rootIdentity, action: 'rollback', archive: [], recovery: {} })));
    verifica('A: azione non autorizzata (rollback) rifiutata dal bridge', grezza.code === 'ACTION_NOT_AUTHORIZED' && invariata(), grezza);
  } finally { await b.close().catch(() => {}); }
  // --- recupero autorizzato
  stat.consensi = 0;
  const recover = await esito(run('recover', { bundle, recupero: grant }, backend));
  verifica('A: recover autorizzato -> APPLIED', recover.state === 'APPLIED' && stat.consensi === 1, recover);
  const finale = fs.readFileSync(S.dst, 'utf8');
  verifica('A: destinazione completa, Alien e ogni titolo una sola volta, hash = previsto', sha(fs.readFileSync(S.dst)) === dopo && completo(S, finale) && finale.startsWith(origDst.toString('utf8')));
  verifica('A: sorgente intatta (non archiviata)', fs.readFileSync(S.src).equals(origSrc));
  const j = journal(S);
  verifica('A: journal coerente (catena di hash) con write-intent ripetuto e un solo done', !j.errore && j.tipi.filter(t => t === 'write-intent').length === 2 && j.tipi.filter(t => t === 'done').length === 1 && j.tipi.at(-1) === 'done', j);
  verifica('A: backup coerenti (originale destinazione, originale sorgente, stato prima del tentativo = originale e parziale)',
    backupUguale(j, 'original-out-', origDst) && backupUguale(j, 'original-src-', origSrc) && backupUguale(j, 'before-attempt-' + KEY_DST + '-', origDst) && backupUguale(j, 'before-attempt-' + KEY_DST + '-', parziale), j.backup);
  // --- replay senza duplicazioni
  const hashFinale = sha(fs.readFileSync(S.dst));
  const replay = await esito(run('apply', { bundle }, backend)), replay2 = await esito(run('recover', { bundle, recupero: {} }, backend));
  verifica('A: replay apply/recover senza nuove scritture ne duplicati', sha(fs.readFileSync(S.dst)) === hashFinale && completo(S, fs.readFileSync(S.dst, 'utf8')), { replay: replay.state + ':' + replay.code, replay2: replay2.state + ':' + replay2.code });
  const st2 = await run('status', { bundle }, backend);
  verifica('A: status finale APPLIED', st2.outputs[0].state === 'APPLIED', st2);
  // --- modifica dell utente dopo il recupero: nessuna perdita
  fs.appendFileSync(S.dst, '- Nota utente successiva\n');
  const conNota = fs.readFileSync(S.dst);
  const dopoNota = await esito(run('apply', { bundle }, backend));
  verifica('A: una modifica successiva dell utente non viene sovrascritta ne persa', dopoNota.state === 'FAIL' && fs.readFileSync(S.dst).equals(conNota), dopoNota);
  const cambiamenti = Object.entries(istantanea(S.stage)).filter(([k, h]) => snap0[k] !== h).map(([k]) => k);
  verifica('A: fuori dal perimetro nulla cambia (vault: solo la destinazione; note esca intatte)', cambiamenti.filter(k => k.startsWith(S.vault)).join() === S.vault + '/' + DST_REL && cambiamenti.every(k => k.startsWith(S.vault) || /^(technical|home|tmp)\//.test(k)), cambiamenti);
  const dopoFinale = istantanea(S.stage);
  const tecnici = Object.keys(snapMid).filter(k => k.startsWith(S.technical + '/'));
  verifica('A: dopo il crash i file della cartella tecnica (request, journal, backup) restano invariati: il recupero aggiunge soltanto', tecnici.length > 3 && tecnici.every(k => dopoFinale[k] === snapMid[k]), tecnici.length);
  return { stage: S.stage, journal: j.tipi };
}

// === Scenario B: l utente modifica la destinazione tra crash e recupero
async function scenarioB(host) {
  const S = nuovoStage('rec-b'), stat = { consensi: 0 }, backend = backendDi(host, stat);
  const bundle = await pianifica(S, backend); guasto(S, 'after-write-chunk');
  await esito(run('apply', { bundle }, backend)); senzaGuasto(S);
  const status = await run('status', { bundle }, backend), grant = concessione(status);
  fs.appendFileSync(S.dst, '- Nota utente durante il parziale\n'); const modificata = fs.readFileSync(S.dst);
  const st = await esito(run('status', { bundle }, backend)), rec = await esito(run('recover', { bundle, recupero: grant }, backend));
  verifica('B: dopo una modifica dell utente il recover (anche con la concessione precedente) e rifiutato', rec.state === 'FAIL' && fs.readFileSync(S.dst).equals(modificata), { st: st.state + ':' + st.code, rec });
  verifica('B: nessuna perdita: parziale e nota dell utente intatti', fs.readFileSync(S.dst).equals(modificata) && modificata.toString('utf8').endsWith('- Nota utente durante il parziale\n'));
  return { stage: S.stage };
}

// === Scenario Z: integrazione Orbit (strumenti reali) con perimetro reale e bridge reale
async function scenarioZ(host) {
  const S = nuovoStage('integr', 3), stat = { consensi: 0 }, backend = backendDi(host, stat);
  const integr = creaIntegrazioneSmartInbox({ ambito: { context: contesto(S), autorizzati: ['liste'], creaIn: ['liste'], creazioni: { [SRC_REL]: 'liste' } }, esegui: (c, i) => run(c, i, backend) });
  verifica('Z: prerequisiti ok solo con perimetro valido su disco (marker, root reale)', (await integr.prerequisiti()).ok === true);
  const ctx = { conversazione: 'e2e-ts6b', richiesta: 'e2e' }, tool = (n, p) => integr.strumenti[n].esegui(p, ctx);
  const prep = await tool('prepara', {});
  const piano = await tool('valuta_piano', { piano: prep.piano, valutazioni: JSON.stringify(prep.richiesteSemantiche.map(q => ({ sorgente: { percorso: q.sorgente.percorso, sha256: q.sorgente.sha256 },
    valutazioni: q.candidati.map(n => ({ percorso: n.percorso, sha256: n.sha256, relazione: 'equivalente' })) }))) });
  verifica('Z: MERGE e apply via strumenti Orbit', piano.decisioni[0].esito === 'MERGE' && (await tool('applica', { piano: prep.piano })).state === 'APPLIED' && completo(S, fs.readFileSync(S.dst, 'utf8')));
  const nulla = await esito(tool('recupera', { piano: prep.piano }));
  verifica('Z: recupera su un piano senza parziale rifiutato', nulla.code === 'PARZIALE_SMART_INBOX_NON_DISPONIBILE', nulla);
  const prep2 = await tool('prepara', {});
  const piano2 = await tool('valuta_piano', { piano: prep2.piano, valutazioni: JSON.stringify(prep2.richiesteSemantiche.map(q => ({ sorgente: { percorso: q.sorgente.percorso, sha256: q.sorgente.sha256 },
    valutazioni: q.candidati.map(n => ({ percorso: n.percorso, sha256: n.sha256, relazione: 'equivalente' })) }))) });
  const consensiPrima = stat.consensi, hash = sha(fs.readFileSync(S.dst)), a2 = await tool('applica', { piano: prep2.piano });
  verifica('Z: secondo ciclo = NOOP senza consenso locale e senza modifiche', piano2.decisioni[0].esito === 'NOOP' && a2.state === 'NOOP' && stat.consensi === consensiPrima && sha(fs.readFileSync(S.dst)) === hash, { d: piano2.decisioni[0].esito, s: a2.state });
  return { stage: S.stage };
}

// === Scenario P: integrita degli script e perimetro sul bridge reale
async function scenarioP() {
  const S = nuovoStage('perim', 3), ctx = contesto(S), temp = () => fs.readdirSync(path.join(S.stage, 'tmp')).filter(n => n.startsWith('bridge-'));
  const buono = creaHostDiTest('buono', { crash: false });
  for (const [nome, alterazione] of [['Engine.cs', d => fs.appendFileSync(path.join(d, 'windows', 'Engine.cs'), '\n// alterato\n')],
    ['cli-host.ps1', d => fs.appendFileSync(path.join(d, 'windows', 'cli-host.ps1'), '\n# alterato\n')],
    ['file in piu', d => fs.writeFileSync(path.join(d, 'windows', 'Extra.cs'), 'class X {}')]]) {
    const h = creaHostDiTest('alt', { alterazione });   // manifest NON ricalcolato: e quello del repo
    const r = await esito(h.open(ctx));
    verifica('P: script alterati (' + nome + ') -> nessun bridge, nessuna copia avviata', r.code === 'SCRIPT_BRIDGE_NON_VERIFICATI' && !temp().length, r);
  }
  const pinGiusto = sha(require('../integrita').normalizza(fs.readFileSync(path.join(buono.dir, 'windows', MANIFEST))));
  delete process.env.SMART_INBOX_SCRIPT_MANIFEST_SHA256;
  const pinMancante = await esito(buono.aprireGrezzo(ctx));   // pin obbligatorio: senza, il bridge non parte
  process.env.SMART_INBOX_SCRIPT_MANIFEST_SHA256 = '0'.repeat(64);
  const pinErrato = await esito(buono.aprireGrezzo(ctx));
  process.env.SMART_INBOX_SCRIPT_MANIFEST_SHA256 = pinGiusto;
  const b = await buono.aprireGrezzo(ctx).catch(e => ({ errore: e.code })); const copie = temp().length;
  if (!b.errore) await b.close();
  delete process.env.SMART_INBOX_SCRIPT_MANIFEST_SHA256;
  verifica('P: pin dell host sul manifest: mancante e errato rifiutati, corretto accettato, copia verificata rimossa alla chiusura', pinMancante.code === 'MANIFEST_BRIDGE_PIN_MANCANTE' && pinErrato.code === 'MANIFEST_BRIDGE_PIN_DIVERSO' && !b.errore && copie === 1 && temp().length === 0, { pinMancante, pinErrato, b: b.errore, copie });
  const ok = await buono.open(ctx); const att = await ok.attributes(); await ok.close();
  verifica('P: bridge su stage valido: attributi e chiusura regolare', /^[0-9A-F]{8}:[0-9A-F]{16}$/.test(att.rootIdentity));
  const aree = await esito(buono.open(ctx, { aree: [path.dirname(S.stage)] }));
  verifica('P: stage dentro un area operativa dichiarata dall host rifiutato', aree.code === 'PERIMETRO_SOVRAPPOSTO_AD_AREA_ORBIT', aree);
  const marker = path.join(S.stage, MARKER), testo = fs.readFileSync(marker);
  fs.rmSync(marker); const senza = await esito(buono.open(ctx));
  fs.writeFileSync(marker, JSON.stringify({ versione: 1, tipo: 'personale', stage: S.stage })); const personale = await esito(buono.open(ctx));
  fs.writeFileSync(marker, testo);
  verifica('P: senza marker o con tipo non sintetico il bridge non parte', senza.code === 'PERIMETRO_NON_VERIFICABILE' && personale.code === 'AMBIENTE_NON_SINTETICO_NON_ABILITATO', { senza, personale });
  // Difesa nel bridge stesso: hash degli .cs e marker controllati da PowerShell anche se Node fosse aggirato
  const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: path.dirname(process.env.SMART_INBOX_PWSH) };
  for (const k of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) env[k] = path.join(S.stage, 'home');
  for (const k of ['TEMP', 'TMP']) env[k] = path.join(S.stage, 'tmp');
  // copia verificata (LF) come quella che avvia cli-windows.js: gli hash passati al bridge sono quelli dei byte che esegue
  const vc = copiaVerificata(verificaScript({ dir: path.join(buono.dir, 'windows') }), path.join(S.stage, 'tmp', 'bridge-prova'));
  const ps = (cs, stage = S.stage) => new Promise(resolve => {
    const p = spawn(process.env.SMART_INBOX_PWSH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(vc.dir, 'cli-host.ps1'), '-Stage', stage, '-CsSha256', cs],
      { env, cwd: stage, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); let err = ''; p.stderr.on('data', d => { err += d; }); p.stdin.end();
    p.on('close', code => resolve({ code, err: err.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, '') }));   // l'output di PowerShell va a capo e colora: confronto senza spazi
  });
  const reali = vc.hashCs;
  const hashErrato = await ps(reali.replace(/=[0-9a-f]{2}/, '=00')), hashMancante = await ps(reali.split(';')[0]);
  fs.rmSync(marker); const senzaMarker = await ps(reali); fs.writeFileSync(marker, testo);
  verifica('P: il bridge rifiuta da solo hash .cs diversi/mancanti e lo stage senza marker', hashErrato.code !== 0 && /BRIDGE_SCRIPT_CHANGED/.test(hashErrato.err) && hashMancante.code !== 0 && /BRIDGE_SCRIPT_HASHES_REQUIRED/.test(hashMancante.err)
    && senzaMarker.code !== 0 && /PERIMETER_MARKER_REQUIRED/.test(senzaMarker.err), { h: hashErrato.err.slice(-300), m: hashMancante.err.slice(-300), s: senzaMarker.err.slice(-300) });
  if (process.env.SMART_INBOX_PWSH_SBAGLIATO) {
    const buonoRuntime = process.env.SMART_INBOX_PWSH; process.env.SMART_INBOX_PWSH = process.env.SMART_INBOX_PWSH_SBAGLIATO;
    const r = await esito(buono.open(ctx)); process.env.SMART_INBOX_PWSH = buonoRuntime;
    verifica('P: runtime diverso dal pin rifiutato', r.code === 'RUNTIME_PWSH_NON_VERIFICATO', r);
  }
  return { stage: S.stage };
}

// === Scenario M (create_dir): cartella assente di creaIn creata nello stesso apply, via bridge reale (consenso simulato come negli altri scenari)
async function scenarioM(host) {
  const nuovo = etichetta => { const S = nuovoStage(etichetta, 30); fs.rmSync(S.dst); return S; };
  const piano = async (S, backend) => {
    const input = { context: contesto(S), autorizzati: ['liste'], creaIn: ['liste/nuova'], creazioni: { [SRC_REL]: 'liste/nuova' } };
    const b = await run('prepare', input, backend);
    return run('plan', { bundle: b, valutazioni: b.richiesteSemantiche.map(q => ({ sorgente: { percorso: q.sorgente.percorso, sha256: q.sorgente.sha256 },
      valutazioni: q.candidati.map(n => ({ percorso: n.percorso, sha256: n.sha256, relazione: 'distinta' })) })) }, backend);
  };
  const S = nuovo('mkdir-a'), stat = { consensi: 0 }, backend = backendDi(host, stat), snap0 = istantanea(S.stage);
  const bundle = await piano(S, backend);
  verifica('M: piano CREATE con cartella da creare', bundle.piano.decisioni[0].esito === 'CREATE' && JSON.stringify(bundle.piano.cartelleDaCreare) === '["liste/nuova"]', bundle.piano);
  const dopoPiano = istantanea(S.stage);
  verifica('M: prepare/plan non scrivono nel vault e non creano la cartella', Object.keys(snap0).every(k => k.startsWith('technical') || dopoPiano[k] === snap0[k]) && !fs.existsSync(path.join(S.root, 'liste/nuova')));
  // consenso negato: nessuna cartella, nessuna nota
  const negato = await esito(run('apply', { bundle }, backendDi(host, { consensi: 0 }, { consenso: false })));
  verifica('M: consenso negato = nessuna cartella e nessuna nota', negato.state === 'ERRORE' && !fs.existsSync(path.join(S.root, 'liste/nuova')), negato);
  // autoApplica dell'host: la creazione di cartelle richiede comunque la finestra (Node) e il bridge la richiede da solo (HOST_CONFIRMATION_REQUIRED)
  const statAuto = { consensi: 0 }, autoBackend = async c => { const b = await host.open(c, { autoApplica: true }); return { ...b, confirm: async body => { statAuto.consensi++; return false; } }; };
  const auto = await esito(run('apply', { bundle }, autoBackend, { autoApplica: true }));
  verifica('M: con autoApplica la cartella chiede comunque la finestra locale', auto.state === 'ERRORE' && statAuto.consensi === 1 && !fs.existsSync(path.join(S.root, 'liste/nuova')), { auto, statAuto });
  const grezzo = await host.open(contesto(S), { autoApplica: true });
  const info = await grezzo.attributes(), anteprima = prepara(bundle.piano, bundle.snapshot);
  const senzaFinestra = await esito(grezzo.execute(canonico({ spec: anteprima.spec, preview: anteprima.impronta, rootFileId: info.rootIdentity, action: 'apply', archive: [], recovery: {} })));
  await grezzo.close().catch(() => {});
  verifica('M: il bridge rifiuta da solo un apply con cartelle senza la finestra, anche con -AutoAdditive', senzaFinestra.state === 'ERRORE' && /HOST_CONFIRMATION_REQUIRED/.test(String(senzaFinestra.code)) && !fs.existsSync(path.join(S.root, 'liste/nuova')), senzaFinestra);
  const prima = istantanea(S.stage);
  const applicato = await esito(run('apply', { bundle }, backend));
  verifica('M: apply autorizzato -> APPLIED', applicato.state === 'APPLIED', applicato);
  const dir = path.join(S.root, 'liste/nuova');
  verifica('M: cartella e nota create, byte della sorgente identici', fs.lstatSync(dir).isDirectory() && fs.readFileSync(path.join(dir, 'Film da guardare.md'), 'utf8') === S.sorgente && fs.readdirSync(dir).length === 1);
  const dopo = istantanea(S.stage);
  verifica('M: fuori dalla nuova nota nulla cambia (sorgente, archivio, indice)', Object.keys(prima).filter(k => k.startsWith('data/')).every(k => dopo[k] === prima[k]), Object.keys(prima).filter(k => dopo[k] !== prima[k]));   // solo il vault: home/ e tmp/ sono rumore di PowerShell e copie del bridge
  const tipi = (() => { const j = journal(S); return j.errore ? [] : j.tipi; })();
  verifica('M: journal con mkdir-intent e mkdir-done prima della scrittura', tipi.includes('mkdir-intent:' + sha('liste/nuova').slice(0, 6)) && tipi.indexOf('mkdir-done:' + sha('liste/nuova').slice(0, 6)) > tipi.indexOf('mkdir-intent:' + sha('liste/nuova').slice(0, 6)), tipi);
  const replay = await esito(run('apply', { bundle }, backend));
  verifica('M: replay apply senza nuove scritture', replay.state === 'APPLIED' && fs.readdirSync(dir).length === 1 && istantanea(S.stage)['data/mkdir-a/vault/liste/nuova/Film da guardare.md'] === sha(S.sorgente), replay);

  // crash reale del bridge subito dopo MakeDirectory (intent senza done), poi replay: la cartella vuota viene ripresa
  const T = nuovo('mkdir-b'), statT = { consensi: 0 }, backendT = backendDi(host, statT), bundleT = await piano(T, backendT);
  guasto(T, 'after-mkdir');
  const crash = await esito(run('apply', { bundle: bundleT }, backendT));
  senzaGuasto(T);
  const dirT = path.join(T.root, 'liste/nuova');
  verifica('M: crash dopo la creazione della cartella: cartella vuota, nessuna nota, sorgente intatta', crash.state === 'ERRORE' && fs.lstatSync(dirT).isDirectory() && fs.readdirSync(dirT).length === 0 && fs.readFileSync(T.src, 'utf8') === T.sorgente, crash);
  const ripreso = await esito(run('apply', { bundle: bundleT }, backendT));
  verifica('M: replay dopo il crash -> APPLIED con la nota nella cartella', ripreso.state === 'APPLIED' && fs.readFileSync(path.join(dirT, 'Film da guardare.md'), 'utf8') === T.sorgente, ripreso);

  // cartella creata da altri dopo la pianificazione: FAIL, nessuna nota
  const U = nuovo('mkdir-c'), backendU = backendDi(host, { consensi: 0 }), bundleU = await piano(U, backendU);
  fs.mkdirSync(path.join(U.root, 'liste/nuova'));
  const corsa = await esito(run('apply', { bundle: bundleU }, backendU));
  verifica('M: cartella creata da altri dopo il piano: apply rifiutato, nessuna nota scritta', /CATALOG_NAMES_CHANGED/.test(String(corsa.code)), corsa);
  verifica('M: ... e la cartella altrui resta vuota', fs.readdirSync(path.join(U.root, 'liste/nuova')).length === 0);
  return { stage: S.stage };
}

// === Scenario U (nomi non ASCII): il bridge reale deve restituire attributi completi per trattini lunghi, apostrofi tipografici e accenti
async function scenarioU(host) {
  const S = nuovoStage('unicode', 30), nomi = ['Introduzione al C – Schema.md', 'Rappresentazione dell’informazione – Schema.md', 'Proattività.md', 'Caffé.md'];
  fs.rmSync(S.dst); fs.mkdirSync(path.join(S.root, 'liste/Notes'));
  for (const n of nomi) fs.writeFileSync(path.join(S.root, 'liste/Notes', n), '# ' + n + '\n- sintetica\n');
  const stat = { consensi: 0 }, backend = backendDi(host, stat), dirNuova = 'liste/Città – nuova';
  const input = { context: contesto(S), autorizzati: ['liste'], creaIn: [dirNuova], creazioni: { [SRC_REL]: dirNuova } };
  const info = await (await host.open(contesto(S))).attributes().catch(e => ({ errore: e.code || e.message }));
  const chiavi = Object.keys(info.attributes || {});
  verifica('U: attributi nativi presenti per tutti i nomi non ASCII', nomi.every(n => chiavi.includes(path.join(S.root, 'liste/Notes', n).toLowerCase())), nomi.filter(n => !chiavi.includes(path.join(S.root, 'liste/Notes', n).toLowerCase())));
  const b = await run('prepare', input, backend);
  verifica('U: prepare senza VERIFICA_REPARSE_INCOMPLETA e copertura completa', b.snapshot.copertura.completa === true && !b.snapshot.copertura.problemi.some(p => /REPARSE/.test(p.code)), b.snapshot.copertura.problemi);
  const piano = await run('plan', { bundle: b, valutazioni: b.richiesteSemantiche.map(q => ({ sorgente: { percorso: q.sorgente.percorso, sha256: q.sorgente.sha256 },
    valutazioni: q.candidati.map(n => ({ percorso: n.percorso, sha256: n.sha256, relazione: 'distinta' })) })) }, backend);
  verifica('U: CREATE con cartella non ASCII da creare', piano.piano.decisioni[0].esito === 'CREATE' && piano.piano.cartelleDaCreare[0] === dirNuova, piano.piano);
  const applicato = await esito(run('apply', { bundle: piano }, backend));
  const dir = path.join(S.root, dirNuova);
  verifica('U: apply crea cartella e nota con il nome esatto (canale UTF-8 anche in ingresso)', applicato.state === 'APPLIED' && fs.readdirSync(path.join(S.root, 'liste')).includes('Città – nuova') && fs.readFileSync(path.join(dir, 'Film da guardare.md'), 'utf8') === S.sorgente, applicato);
  return { stage: S.stage };
}

// === Scenario Q: applicazione PARZIALE (2 CREATE indipendenti, 2 note equivalenti in sospeso) con crash reale, retry, RECOVER, riavvio e replay
const QSRC = { 'Film da vedere': '# Film da vedere\n- Dune\n', 'Serie TV da vedere': '# Serie TV da vedere\n- Dark\n', 'Informazioni Ipad': '# Informazioni Ipad\n' + Array.from({ length: 400 }, (_, i) => '- Riga sintetica ' + i).join('\n') + '\n', 'Opening scacchi': '# Opening scacchi\n- Italiana\n' };
function tipiJournal(S) {
  const piani = fs.readdirSync(S.tech).filter(n => n.startsWith('plan-')); if (piani.length !== 1) return { errore: 'piani=' + piani.length };
  const dir = path.join(S.tech, piani[0]);
  return { tipi: fs.readdirSync(dir).filter(n => /^\d{6}-[0-9a-f]{64}\.json$/.test(n)).sort().map(n => JSON.parse(fs.readFileSync(path.join(dir, n))).kind) };
}
async function scenarioQ(host) {
  const S = nuovoStage('parziale', 5), stat = { consensi: 0 };
  fs.rmSync(S.src); fs.rmSync(S.dst);
  for (const [n, t] of Object.entries(QSRC)) fs.writeFileSync(path.join(S.root, 'to sort', n + '.md'), t);
  const backend = async c => { const b = await host.open(c, { autoApplica: true }); return { ...b, confirm: async body => { stat.consensi++; return b.confirm(body); } }; };
  const opz = { autoApplica: true }, snap0 = istantanea(S.stage);
  const b = await run('prepare', { context: contesto(S), autorizzati: ['liste'], creaIn: ['liste'], creaDefault: 'liste' }, backend, opz);
  verifica('Q: piano 3 CREATE + 1 CONFIRM (Serie TV potenzialmente equivalente a Film)', b.piano.decisioni.filter(d => d.esito === 'CREATE').length === 3 && b.piano.decisioni.filter(d => d.esito === 'CONFIRM').length === 1, b.piano.decisioni.map(d => d.esito));
  const spec = prepara(b.piano, b.snapshot, { ammetti: () => true }).spec;
  verifica('Q: sottoinsieme calcolato dal codice = 2 output; Film e Serie sospese; hash del piano originale', spec.outputs.length === 2 && spec.sospese.length === 2 && spec.plan === b.piano.impronta
    && !spec.outputs.some(o => /Film|Serie/.test(o.path)), { out: spec.outputs.map(o => o.path), sospese: spec.sospese });
  const intatto = istantanea(S.stage); verifica('Q: prepare non scrive nel vault', Object.keys(snap0).every(k => k.startsWith('technical') || intatto[k] === snap0[k]));
  guasto(S, 'after-write-chunk');
  const crash = await esito(run('apply', { bundle: b, auto: true }, backend, opz));
  verifica('Q: apply parziale interrotto dal crash reale del bridge', crash.state === 'ERRORE', crash);
  senzaGuasto(S);
  const scritti = () => fs.readdirSync(path.join(S.root, 'liste')).sort();
  verifica('Q: dopo il crash nessuna nota sospesa e stata toccata (Film e Serie assenti, sorgenti intatte)', !scritti().some(n => /Film|Serie/.test(n))
    && Object.keys(QSRC).every(n => fs.readFileSync(path.join(S.root, 'to sort', n + '.md'), 'utf8') === QSRC[n]), scritti());
  // Riavvio: nuova istanza dell'integrazione, nessuna memoria del tentativo
  const status = await run('status', { bundle: b, auto: true }, backend, opz);
  const stati = status.outputs.map(o => o.state).sort();
  verifica('Q: status dopo il crash distingue gli output (uno da recuperare/incompleto, l altro non iniziato)', status.state === 'INSPECTED' && stati.includes('PENDING') && stati.some(s => s !== 'PENDING'), status);
  const retry = await esito(run('apply', { bundle: b, auto: true }, backend, opz));
  verifica('Q: retry automatico su un parziale non scrive e non duplica (RECOVERY_REQUIRED)', retry.state === 'FAIL' && retry.code === 'RECOVERY_REQUIRED', retry);
  const grant = Object.fromEntries(status.outputs.filter(o => o.state === 'RECOVERY_REQUIRED').map(o => [o.key, { hash: o.hash, fileId: o.fileId }]));
  verifica('Q: il crash ha lasciato un solo output da recuperare (Ipad parziale, Opening non iniziato)', Object.keys(grant).length === 1 && stati.join() === 'PENDING,RECOVERY_REQUIRED', stati);
  if (Object.keys(grant).length) {
    stat.consensi = 0;
    const rec = await esito(run('recover', { bundle: b, recupero: grant, auto: true }, backend, opz));
    verifica('Q: RECOVER autorizzato (consenso simulato) completa il sottoinsieme', rec.state === 'APPLIED' && stat.consensi === 1, rec);
  } else {
    const rec = await esito(run('apply', { bundle: b, auto: true }, backend, opz));
    verifica('Q: nessun parziale da recuperare: apply riprende', rec.state === 'APPLIED', rec);
  }
  verifica('Q: file effettivi = solo le 2 note indipendenti, byte identici alle sorgenti', JSON.stringify(scritti()) === JSON.stringify(['Informazioni Ipad.md', 'Opening scacchi.md'])
    && ['Informazioni Ipad', 'Opening scacchi'].every(n => fs.readFileSync(path.join(S.root, 'liste', n + '.md'), 'utf8') === QSRC[n]), scritti());
  const j = tipiJournal(S);
  verifica('Q: journal coerente: un done per ognuna delle 2 note, nessun intento per Film/Serie, write-intent ripetuto solo per il parziale', !j.errore && j.tipi.filter(t => t === 'done').length === 2 && j.tipi.filter(t => t === 'create-intent').length === 2 && j.tipi.filter(t => t === 'write-intent').length === 3, j);
  const dopoRec = istantanea(S.stage);
  const replay = await esito(run('apply', { bundle: b, auto: true }, backend, opz));
  verifica('Q: replay dello stesso piano: nessuna nuova scrittura e nessun duplicato', Object.keys(dopoRec).filter(k => k.startsWith(S.vault)).every(k => istantanea(S.stage)[k] === dopoRec[k]) && scritti().length === 2, replay);
  // Riavvio dopo l'applicazione parziale: nuova pianificazione
  const b2 = await run('prepare', { context: contesto(S), autorizzati: ['liste'], creaIn: ['liste'], creaDefault: 'liste' }, backend, opz);
  const per = n => b2.piano.decisioni.find(d => d.sorgente.percorso.endsWith(n + '.md')).esito;
  verifica('Q: nuova pianificazione dopo riavvio: le due note scritte sono NOOP, le sospese restano sospese', per('Informazioni Ipad') === 'NOOP' && per('Opening scacchi') === 'NOOP' && per('Serie TV da vedere') === 'CONFIRM', b2.piano.decisioni.map(d => [d.sorgente.percorso, d.esito]));
  const s2 = prepara(b2.piano, b2.snapshot, { ammetti: () => true }).spec;
  verifica('Q: la nuova pianificazione non propone di riscrivere nulla (nessun output)', s2.outputs.length === 0, s2.outputs.map(o => o.path));
  const sicura = await esito(run('apply', { bundle: b2, auto: true }, backend, opz));
  verifica('Q: apply senza operazioni applicabili non dichiara NOOP ne scrive', sicura.state === 'NESSUNA_OPERAZIONE_APPLICABILE' && scritti().length === 2, sicura);
  return { stage: S.stage, journal: j.tipi };
}

(async () => {
  const out = { consenso: 'SIMULATO (host di test, non umano)', runtime: sha(fs.readFileSync(process.env.SMART_INBOX_PWSH)) };
  const host = creaHostDiTest('host');
  try {
    out.A = await scenarioA(host); out.B = await scenarioB(host); out.Z = await scenarioZ(host); out.M = await scenarioM(host); out.U = await scenarioU(host); out.P = await scenarioP(); out.Q = await scenarioQ(host);
  } catch (e) { verifica('esecuzione completa', false, e.stack || e.message); }
  const falliti = risultati.filter(r => !r.ok);
  out.controlli = risultati.length; out.falliti = falliti; out.risultati = risultati.map(r => (r.ok ? 'OK   ' : 'FAIL ') + r.nome);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exitCode = falliti.length ? 1 : 0;
})().finally(() => { if (!process.env.SMART_INBOX_KEEP) for (const p of pulizia) fs.rmSync(p, { recursive: true, force: true }); });
