'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const guard = require('./guard.cjs');
const { NativeBackend } = require('./ts3-backend.cjs');
const { leggiSnapshot } = require('../reader'), { pianifica } = require('../planner'), { prepara, creaHost } = require('../writer');
const { sha, impronta, canonico } = require('../policy');
const { verificaPiano } = require('../planner');
let native; const allWorkers = [];
async function worker() { const w = new NativeBackend(guard.root, process.env.SMART_INBOX_TEST_RUNTIME); allWorkers.push(w); await w.ready; return w; }
const root = name => path.join(guard.root, 'data/cases', name, 'vault');
const technical = name => path.join(guard.root, 'technical', name);
const file = (name, relative) => path.join(root(name), relative);
const equivalent = ({ candidati }) => ({ valutazioni: candidati.map(n => ({ percorso: n.percorso, sha256: n.sha256, relazione: n.percorso === 'liste/Film da vedere.md' ? 'equivalente' : 'distinta' })) });
async function scenario(name, options = {}, creaInDir = 'liste') {
  const info = await native.call('attributes', name);
  if (!info.attributes) throw new Error(JSON.stringify(info));
  const snapshot = leggiSnapshot({ radice: root(name), autorizzati: ['liste'], creaIn: [creaInDir], verificaReparse: p => {
    const attr = info.attributes[p.toLowerCase()]; if (!Number.isInteger(attr)) throw new Error('MISSING_NATIVE_ATTRIBUTES'); return !!(attr & 0x400);
  } });
  assert.equal(snapshot.copertura.completa, true, JSON.stringify(snapshot.copertura.problemi));
  const plan = await pianifica(snapshot, { valuta: equivalent, maxCaratteri: 60000, creaIn: { 'to sort/Film da guardare.md': creaInDir }, ...options });
  const host = creaHost({ rootId: snapshot.rootId, rootIdentity: info.rootIdentity, backend: body => native.call('execute', name, body) });
  return { snapshot, plan, host, name, rootIdentity: info.rootIdentity };
}
function permit(s, action = 'apply', archive = [], recovery = {}) {
  const preview = prepara(s.plan, s.snapshot);
  return s.host.confermaDaHost(preview, { azione: action, operazioni: preview.spec.outputs.flatMap(o => o.operationIds), archivia: archive, recupero: recovery });
}
function altered(plan, change) {
  const p = JSON.parse(JSON.stringify(plan)); change(p);
  delete p.id; delete p.impronta; const hash = impronta(p);
  return { ...p, id: 'piano-' + hash.slice(0, 24), impronta: hash };
}
test.before(async () => { native = await worker(); });
test.after(async () => {
  for (const w of allWorkers) if (w.alive) { const result = await w.stop(); assert.equal(result.code, 0); }
  fs.writeFileSync(path.join(guard.root, 'tmp/ts3-native-events.json'), JSON.stringify(allWorkers.map(w => ({ pid: w.process.pid, events: w.events })), null, 2));
});

test('TS3 smoke: CREATE nativa con bytes originali, backup e manifest fuori vault', async () => {
  const s = await scenario('create'), source = fs.readFileSync(file('create', 'to sort/Film da guardare.md'));
  assert.equal(s.plan.decisioni[0].esito, 'CREATE');
  const result = await s.host.esegui(s.plan, s.snapshot, permit(s));
  assert.equal(result.state, 'APPLIED', JSON.stringify(result));
  assert.deepEqual(fs.readFileSync(file('create', 'liste/Film da guardare.md')), source);
  assert.ok(fs.existsSync(path.join(technical('create'), result.manifest, 'request.json')));
  assert.deepEqual(fs.readFileSync(file('create', 'to sort/Film da guardare.md')), source);
});

test('TS3 smoke: MERGE nativo append-only, autorizzazione separata per archive', async () => {
  const s = await scenario('merge'), before = fs.readFileSync(file('merge', 'liste/Film da vedere.md'));
  assert.equal(s.plan.decisioni[0].esito, 'MERGE');
  const result = await s.host.esegui(s.plan, s.snapshot, permit(s, 'apply', ['to sort/Film da guardare.md']));
  assert.equal(result.state, 'APPLIED', JSON.stringify(result));
  const actual = fs.readFileSync(file('merge', 'liste/Film da vedere.md'));
  assert.deepEqual(actual.subarray(0, before.length), before);assert.equal(actual.toString(), before.toString() + '- Dune\n');
  assert.equal(fs.existsSync(file('merge', 'to sort/Film da guardare.md')), false);
  const archive = path.join(technical('merge'), result.manifest, 'input-' + sha('to sort/Film da guardare.md') + '.input');
  assert.equal(fs.readFileSync(archive, 'utf8'), '# Film da guardare\n- Dune\n');
});

test('TS3: approved:true, capability serializzata e capability di un altro host non autorizzano il backend', async () => {
  const s = await scenario('auth'); let calls = 0;
  const host = creaHost({ rootId: s.snapshot.rootId, rootIdentity: '00000000:0000000000000001', backend: () => { calls++; } });
  const capability = permit(s);
  for (const fake of [{ approved: true }, JSON.parse(JSON.stringify(capability)), capability]) {
    await assert.rejects(host.esegui(s.plan, s.snapshot, fake), { code: 'CONFERMA_UTENTE_RICHIESTA' });
  }
  const empty = host.confermaDaHost(prepara(s.plan, s.snapshot), { azione: 'apply' });
  await assert.rejects(host.esegui(s.plan, s.snapshot, empty), { code: 'OPERAZIONE_NON_AUTORIZZATA' });
  assert.equal(calls, 0);
  assert.throws(() => host.confermaDaHost(prepara(s.plan, s.snapshot), { azione: 'recover', recupero: { sconosciuto: { hash: '0'.repeat(64), fileId: '00000000:0000000000000001' } } }), { code: 'AMBITO_AUTORIZZAZIONE_NON_VALIDO' });
});

test('TS3: due NOOP duplicati non possono omettere una sorgente pur mantenendo il conteggio corretto', async () => {
  const s = await scenario('dup-noop'); assert.deepEqual(s.plan.decisioni.map(d => d.esito), ['NOOP', 'NOOP']);
  const bad = altered(s.plan, p => { p.decisioni[1] = JSON.parse(JSON.stringify(p.decisioni[0])); });
  assert.equal(bad.decisioni.length, s.snapshot.sorgenti.length);
  assert.equal(verificaPiano(bad, s.snapshot).valido, true, 'Riproduzione del limite TS2 senza scritture');
  const n = native.events.length;
  await assert.rejects(s.host.esegui(bad, s.snapshot, { approved: true }), { code: 'PIANO_INCOMPLETO' });
  assert.equal(native.events.length, n, 'Nessun backend raggiunto');
});

test('TS3: operazione duplicata, decisione mancante e metadati ricalcolati non raggiungono il backend', async () => {
  const s = await scenario('dup-ops');
  assert.equal(s.plan.decisioni.length, 2);
  for (const bad of [altered(s.plan, p => p.operazioni.push(p.operazioni[0])), altered(s.plan, p => p.decisioni.pop())]) {
    assert.throws(() => prepara(bad, s.snapshot));
  }
  const snapshot = JSON.parse(JSON.stringify(s.snapshot)); snapshot.sorgenti[0].problemiParsing = ['META_CONTRAFFATTO'];
  delete snapshot.impronta; snapshot.impronta = impronta(snapshot);
  const plan = altered(s.plan, p => { p.snapshot = snapshot.impronta; });
  assert.equal(verificaPiano(plan, snapshot).valido, true, 'La fixture deve raggiungere il controllo aggiuntivo TS3');
  assert.throws(() => prepara(plan, snapshot), { code: 'METADATI_SNAPSHOT_ALTERATI' });
});

test('TS3: NOOP certificato non altera alcuna nota e non archivia senza consenso separato', async () => {
  const s = await scenario('noop'), before = fs.readFileSync(file('noop', 'liste/Film da vedere.md'));
  const result = await s.host.esegui(s.plan, s.snapshot, permit(s));
  assert.equal(result.state, 'APPLIED', JSON.stringify(result)); assert.deepEqual(result.outputs, []);
  assert.deepEqual(fs.readFileSync(file('noop', 'liste/Film da vedere.md')), before);
  assert.ok(fs.existsSync(file('noop', 'to sort/Film da guardare.md')));
});

for (const name of ['source-changed', 'dest-changed', 'missing', 'moved', 'stale']) test('TS3: snapshot non più corrente bloccato: ' + name, async () => {
  const s = await scenario(name), source = file(name, 'to sort/Film da guardare.md'), target = file(name, 'liste/Film da vedere.md');
  const before = fs.readFileSync(target);
  if (name === 'source-changed') fs.appendFileSync(source, 'Modifica sintetica\n');
  else if (name === 'dest-changed') fs.appendFileSync(target, 'Modifica sintetica\n');
  else if (name === 'missing' || name === 'moved') fs.renameSync(target, file(name, 'liste/Spostata.md'));
  else fs.writeFileSync(file(name, 'liste/Nuova.md'), '# Nuova\n');
  const current = name === 'missing' || name === 'moved' ? file(name, 'liste/Spostata.md') : target;
  const actual = fs.readFileSync(current);
  const result = await s.host.esegui(s.plan, s.snapshot, permit(s, 'apply', ['to sort/Film da guardare.md']));
  assert.equal(result.state, 'FAIL', JSON.stringify(result)); assert.deepEqual(fs.readFileSync(current), actual);
  assert.ok(fs.existsSync(source)); assert.ok(before.length);
});

for (const name of ['rollback-create', 'rollback-merge', 'rollback-user', 'repeat']) test('TS3: ripetizione e rollback senza sovrascrivere modifiche utente: ' + name, async () => {
  const s = await scenario(name), pathName = name === 'rollback-create' ? 'liste/Film da guardare.md' : 'liste/Film da vedere.md';
  const before = fs.existsSync(file(name, pathName)) ? fs.readFileSync(file(name, pathName)) : null;
  const moved = ['to sort/Film da guardare.md'];
  const applied = await s.host.esegui(s.plan, s.snapshot, permit(s, 'apply', moved));
  assert.equal(applied.state, 'APPLIED', JSON.stringify(applied));
  const after = fs.readFileSync(file(name, pathName));
  if (name === 'repeat') {
    const second = await s.host.esegui(s.plan, s.snapshot, permit(s, 'apply', moved));
    assert.equal(second.state, 'APPLIED', JSON.stringify(second)); assert.deepEqual(fs.readFileSync(file(name, pathName)), after); return;
  }
  if (name === 'rollback-user') fs.appendFileSync(file(name, pathName), 'Contributo successivo utente\n');
  const user = name === 'rollback-user' ? fs.readFileSync(file(name, pathName)) : null;
  const rolled = await s.host.esegui(s.plan, s.snapshot, permit(s, 'rollback', moved));
  if (user) { assert.equal(rolled.state, 'FAIL'); assert.deepEqual(fs.readFileSync(file(name, pathName)), user); return; }
  assert.equal(rolled.state, 'ROLLED_BACK', JSON.stringify(rolled));
  if (before) assert.deepEqual(fs.readFileSync(file(name, pathName)), before); else assert.equal(fs.existsSync(file(name, pathName)), false);
  assert.equal(fs.readFileSync(file(name, moved[0]), 'utf8'), '# Film da guardare\n- Dune\n');
});

function fault(name, at, kind) { fs.writeFileSync(path.join(guard.root, 'control/fault-' + name + '.json'), JSON.stringify({ at, kind })); }
function resume(name) { fs.writeFileSync(path.join(guard.root, 'control/resume-' + name), 'READY'); }
async function checkpoint(w, name, at, start) {
  const deadline = Date.now() + 12000;
  while (!w.events.slice(start).some(e => e.case === name && e.name === at)) {
    if (!w.alive || Date.now() > deadline) throw new Error('CHECKPOINT_NOT_REACHED: ' + at);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

for (const name of ['parallel-same', 'parallel-different']) test('TS3: due writer reali con esclusione condivisa: ' + name, async () => {
  const s = await scenario(name), other = await worker();
  assert.notEqual(native.process.pid, other.process.pid);
  const plan = name === 'parallel-same' ? s.plan : altered(s.plan, p => { p.semantica.maxChiamate++; });
  const host = creaHost({ rootId: s.snapshot.rootId, rootIdentity: s.rootIdentity, backend: body => other.call('execute', name, body) });
  const second = { ...s, plan, host };
  fault(name, 'mutex-acquired', 'pause'); const start = native.events.length;
  const first = s.host.esegui(s.plan, s.snapshot, permit(s));
  try {
    await checkpoint(native, name, 'mutex-acquired', start);
    const result = await second.host.esegui(plan, s.snapshot, permit(second));
    assert.equal(result.state, 'FAIL'); assert.equal(result.code, 'WRITER_BUSY');
  } finally { resume(name); }
  assert.equal((await first).state, 'APPLIED');
  assert.equal((await other.stop()).code, 0);
});

test('TS3: modifiche manuali e sostituzioni di directory bloccate mentre il writer tiene gli handle', async () => {
  const name = 'manual', s = await scenario(name); fault(name, 'after-backup', 'pause'); const start = native.events.length;
  const applied = s.host.esegui(s.plan, s.snapshot, permit(s));
  try {
    await checkpoint(native, name, 'after-backup', start);
    const denied = error => ['EBUSY', 'EPERM', 'EACCES'].includes(error.code);
    assert.throws(() => fs.appendFileSync(file(name, 'liste/Film da vedere.md'), 'SOVRASCRITTURA'), denied);
    assert.throws(() => fs.renameSync(file(name, 'liste'), file(name, 'spostate')), denied);
    const planDir = fs.readdirSync(technical(name)).find(n => n.startsWith('plan-'));
    const backups = fs.readdirSync(path.join(technical(name), planDir)).filter(n => n.endsWith('.bak'));
    assert.ok(backups.length >= 2);
    for (const b of backups) assert.throws(() => fs.appendFileSync(path.join(technical(name), planDir, b), 'ALTERAZIONE'), denied);
  } finally { resume(name); }
  assert.equal((await applied).state, 'APPLIED');
});

test('TS3: ENOSPC simulato prima della scrittura lascia sorgente e destinazione invariate', async () => {
  const name = 'full', s = await scenario(name), before = fs.readFileSync(file(name, 'liste/Film da vedere.md'));
  fault(name, 'before-write', 'disk-full');
  const result = await s.host.esegui(s.plan, s.snapshot, permit(s, 'apply', ['to sort/Film da guardare.md']));
  assert.equal(result.state, 'FAIL'); assert.equal(result.nativeCode, 112, JSON.stringify(result));
  assert.deepEqual(fs.readFileSync(file(name, 'liste/Film da vedere.md')), before);
  assert.ok(fs.existsSync(file(name, 'to sort/Film da guardare.md')));
});

for (const [name, at] of [['crash-backup', 'after-backup'], ['crash-written', 'after-write-before-archive'], ['crash-partial', 'after-write-chunk'], ['recovery-user', 'after-write-chunk']]) test('TS3: crash reale, mutex abbandonato e recovery esplicita: ' + name, async () => {
  const s = await scenario(name), moved = ['to sort/Film da guardare.md']; fault(name, at, 'crash');
  await assert.rejects(s.host.esegui(s.plan, s.snapshot, permit(s, 'apply', moved)), e => e.code === 73);
  assert.equal((await native.closed).code, 73); fault(name, '', 'disabled'); native = await worker();
  if (name === 'recovery-user') {
    const target = file(name, 'liste/Film da vedere.md'); fs.appendFileSync(target, 'AGGIUNTA_UTENTE_SUCCESSIVA\n'); const user = fs.readFileSync(target);
    const result = await s.host.esegui(s.plan, s.snapshot, permit(s, 'inspect'));
    assert.equal(result.state, 'FAIL'); assert.deepEqual(fs.readFileSync(target), user); return;
  }
  const inspected = await s.host.esegui(s.plan, s.snapshot, permit(s, 'inspect'));
  assert.equal(inspected.state, 'INSPECTED', JSON.stringify(inspected));
  let result;
  if (name === 'crash-partial') {
    assert.equal(inspected.outputs[0].state, 'RECOVERY_REQUIRED');
    const before = fs.readFileSync(file(name, 'liste/Film da vedere.md'));
    const denied = await s.host.esegui(s.plan, s.snapshot, permit(s));
    assert.equal(denied.state, 'FAIL'); assert.deepEqual(fs.readFileSync(file(name, 'liste/Film da vedere.md')), before);
    const recovery = Object.fromEntries(inspected.outputs.map(o => [o.key, { hash: o.hash, fileId: o.fileId }]));
    result = await s.host.esegui(s.plan, s.snapshot, permit(s, 'recover', moved, recovery));
  } else result = await s.host.esegui(s.plan, s.snapshot, permit(s, 'apply', moved));
  assert.equal(result.state, 'APPLIED', JSON.stringify(result));
  const preview = prepara(s.plan, s.snapshot), out = preview.spec.outputs[0];
  assert.equal(sha(fs.readFileSync(file(name, out.path))), out.after);
  assert.equal(fs.existsSync(file(name, moved[0])), false);
});

for (const name of ['block', 'confirm', 'structure']) test('TS3: BLOCK, CONFIRM e strutture non supportate non sono applicati: ' + name, async () => {
  const s = await scenario(name, name === 'confirm' ? { valuta: () => { throw new Error('Mock offline'); } } : {});
  const count = native.events.length;
  assert.throws(() => prepara(s.plan, s.snapshot)); assert.equal(native.events.length, count);
});

test('TS3: directory catalogo sostituita e collisioni Windows non diventano nuovi target', async () => {
  const name = 'p5', s = await scenario(name), before = fs.readFileSync(file(name, 'liste/Film da vedere.md'));
  fs.renameSync(file(name, 'liste'), file(name, 'spostate')); fs.mkdirSync(file(name, 'liste'));
  fs.writeFileSync(file(name, 'liste/Film da vedere.md'), before);
  const result = await s.host.esegui(s.plan, s.snapshot, permit(s));
  assert.equal(result.state, 'FAIL'); assert.equal(result.code, 'DIRECTORY_ID_CHANGED');
  assert.deepEqual(fs.readFileSync(file(name, 'liste/Film da vedere.md')), before);
});

test('TS3: archivio richiede consenso separato anche dopo una applicazione già completata', async () => {
  const name = 'archive-denied', s = await scenario(name), source = 'to sort/Film da guardare.md';
  assert.equal((await s.host.esegui(s.plan, s.snapshot, permit(s))).state, 'APPLIED');
  assert.ok(fs.existsSync(file(name, source)));
  assert.equal((await s.host.esegui(s.plan, s.snapshot, permit(s, 'apply', [source]))).state, 'APPLIED');
  assert.equal(fs.existsSync(file(name, source)), false);
});

test('TS3: collisione nell’archivio non sovrascrive file e non rimuove la sorgente', async () => {
  const name = 'archive-collision', s = await scenario(name), source = 'to sort/Film da guardare.md';
  fault(name, 'before-archive', 'pause'); const start = native.events.length;
  const result = s.host.esegui(s.plan, s.snapshot, permit(s, 'apply', [source])); let collision;
  try {
    await checkpoint(native, name, 'before-archive', start);
    const planDir = fs.readdirSync(technical(name)).find(n => n.startsWith('plan-'));
    collision = path.join(technical(name), planDir, 'input-' + sha(source) + '.input');
    fs.writeFileSync(collision, 'FILE_SINTETICO_PREESISTENTE');
  } finally { resume(name); }
  const answer = await result; assert.equal(answer.state, 'FAIL'); assert.equal(answer.nativeCode, 183, JSON.stringify(answer));
  assert.equal(fs.readFileSync(collision, 'utf8'), 'FILE_SINTETICO_PREESISTENTE'); assert.ok(fs.existsSync(file(name, source)));
});

test('TS3: backup alterato dopo la chiusura viene rilevato e blocca il rollback', async () => {
  const name = 'backup-tamper', s = await scenario(name), applied = await s.host.esegui(s.plan, s.snapshot, permit(s));
  assert.equal(applied.state, 'APPLIED'); const target = file(name, 'liste/Film da vedere.md'), before = fs.readFileSync(target);
  const out = prepara(s.plan, s.snapshot).spec.outputs[0];
  fs.appendFileSync(path.join(technical(name), applied.manifest, 'original-out-' + out.key + '.bak'), 'ALTERAZIONE_SINTETICA');
  const result = await s.host.esegui(s.plan, s.snapshot, permit(s, 'rollback'));
  assert.equal(result.state, 'FAIL'); assert.equal(result.code, 'BACKUP_CHANGED'); assert.deepEqual(fs.readFileSync(target), before);
});

test('TS3: record temporaneo incompleto non viene scambiato per journal pubblicato; record corrotto blocca', async () => {
  const name = 'torn', s = await scenario(name), applied = await s.host.esegui(s.plan, s.snapshot, permit(s)); assert.equal(applied.state, 'APPLIED');
  const folder = path.join(technical(name), applied.manifest), target = file(name, 'liste/Film da vedere.md'), before = fs.readFileSync(target);
  fs.writeFileSync(path.join(folder, 'pending-sintetico.tmp'), '{"prev":');
  assert.equal((await s.host.esegui(s.plan, s.snapshot, permit(s))).state, 'APPLIED');
  const bad = Buffer.from('{}'); fs.writeFileSync(path.join(folder, '999999-' + sha(bad) + '.json'), bad);
  const result = await s.host.esegui(s.plan, s.snapshot, permit(s)); assert.equal(result.state, 'FAIL'); assert.equal(result.code, 'JOURNAL_CHANGED_OR_GAP');
  assert.deepEqual(fs.readFileSync(target), before);
});

for (const name of ['bytes-create', 'bytes-merge']) test('TS3: byte originali, frontmatter, sezioni e wikilink preservati: ' + name, async () => {
  const s = await scenario(name), source = fs.readFileSync(file(name, 'to sort/Film da guardare.md'));
  const target = name === 'bytes-create' ? 'liste/Film da guardare.md' : 'liste/Film da vedere.md';
  const before = name === 'bytes-merge' ? fs.readFileSync(file(name, target)) : null;
  const result = await s.host.esegui(s.plan, s.snapshot, permit(s)); assert.equal(result.state, 'APPLIED', JSON.stringify(result));
  const actual = fs.readFileSync(file(name, target));
  if (before) { assert.deepEqual(actual.subarray(0, before.length), before); assert.equal(actual.toString(), before.toString() + '- [[Film/Dune|Dune]] #cinema\r\n'); }
  else assert.deepEqual(actual, source);
});

test('TS3: collisione Windows case-insensitive rifiutata senza sostituire il file concorrente', async () => {
  const name = 'windows-collision', s = await scenario(name), target = file(name, 'liste/FILM DA GUARDARE.MD');
  fs.writeFileSync(target, 'SENTINELLA_CASE_WINDOWS');
  const result = await s.host.esegui(s.plan, s.snapshot, permit(s)); assert.equal(result.state, 'FAIL');
  assert.equal(fs.readFileSync(target, 'utf8'), 'SENTINELLA_CASE_WINDOWS');
});

test('TS3: sostituzione della root con byte equivalenti non riutilizza il consenso della root originale', async () => {
  const name = 'root-replaced', s = await scenario(name), source = fs.readFileSync(file(name, 'to sort/Film da guardare.md'));
  const note = fs.readFileSync(file(name, 'liste/Film da vedere.md'));
  fs.renameSync(root(name), root(name) + '-old');
  fs.mkdirSync(file(name, 'to sort'), { recursive: true }); fs.mkdirSync(file(name, 'liste'));
  fs.writeFileSync(file(name, 'to sort/Film da guardare.md'), source); fs.writeFileSync(file(name, 'liste/Film da vedere.md'), note);
  const result = await s.host.esegui(s.plan, s.snapshot, permit(s)); assert.equal(result.state, 'FAIL'); assert.equal(result.code, 'ROOT_FILE_ID_CHANGED');
  assert.deepEqual(fs.readFileSync(file(name, 'liste/Film da vedere.md')), note);
});

for (const name of ['ordinary-partial', 'ordinary-create']) test('TS3 pratico: errore ordinario ripristina lo stato precedente e il replay non duplica: ' + name, async () => {
  const s = await scenario(name), output = prepara(s.plan, s.snapshot).spec.outputs[0], target = file(name, output.path);
  const before = fs.existsSync(target) ? fs.readFileSync(target) : null;
  const source = fs.readFileSync(file(name, 'to sort/Film da guardare.md'));
  fault(name, 'after-write-chunk', 'disk-full');
  const failed = await s.host.esegui(s.plan, s.snapshot, permit(s));
  assert.equal(failed.state, 'FAIL'); assert.equal(failed.nativeCode, 112, JSON.stringify(failed));
  assert.equal(failed.restoration.length, 1); assert.equal(failed.restoration[0].state, 'RESTORED', JSON.stringify(failed));
  if (before) assert.deepEqual(fs.readFileSync(target), before); else assert.equal(fs.existsSync(target), false);
  assert.deepEqual(fs.readFileSync(file(name, 'to sort/Film da guardare.md')), source);
  fault(name, '', 'disabled');
  const applied = await s.host.esegui(s.plan, s.snapshot, permit(s)); assert.equal(applied.state, 'APPLIED', JSON.stringify(applied));
  assert.equal(sha(fs.readFileSync(target)), output.after);
  assert.equal((await s.host.esegui(s.plan, s.snapshot, permit(s))).state, 'APPLIED');
  assert.equal(sha(fs.readFileSync(target)), output.after);
});

for (const [name, at] of [['rollback-error', 'after-rollback-output'], ['restore-error', 'source-restore-write']]) test('TS3 pratico: ripristino interrotto da errore ordinario è ripetibile senza perdita input: ' + name, async () => {
  const s = await scenario(name), source = 'to sort/Film da guardare.md', target = file(name, 'liste/Film da vedere.md');
  const original = fs.readFileSync(target), input = fs.readFileSync(file(name, source));
  const applied = await s.host.esegui(s.plan, s.snapshot, permit(s, 'apply', [source])); assert.equal(applied.state, 'APPLIED');
  fault(name, at, 'disk-full');
  const failed = await s.host.esegui(s.plan, s.snapshot, permit(s, 'rollback', [source])); assert.equal(failed.state, 'FAIL'); assert.equal(failed.nativeCode, 112, JSON.stringify(failed));
  assert.deepEqual(fs.readFileSync(target), original);
  const archived = path.join(technical(name), applied.manifest, 'input-' + sha(source) + '.input');
  assert.deepEqual(fs.readFileSync(archived), input);
  fault(name, '', 'disabled');
  const retry = await s.host.esegui(s.plan, s.snapshot, permit(s, 'rollback', [source])); assert.equal(retry.state, 'ROLLED_BACK', JSON.stringify(retry));
  assert.deepEqual(fs.readFileSync(target), original); assert.deepEqual(fs.readFileSync(file(name, source)), input);
});

test('TS3 pratico: CREATE interrotta, errore nel recovery e nuovo recovery mantengono il replay idempotente', async () => {
  const name = 'crash-create', s = await scenario(name), target = file(name, 'liste/Film da guardare.md');
  fault(name, 'after-write-chunk', 'crash');
  await assert.rejects(s.host.esegui(s.plan, s.snapshot, permit(s)), e => e.code === 73);
  assert.equal((await native.closed).code, 73); native = await worker(); fault(name, '', 'disabled');
  const inspect = async () => {
    const status = await s.host.esegui(s.plan, s.snapshot, permit(s, 'inspect'));
    assert.equal(status.state, 'INSPECTED', JSON.stringify(status)); assert.equal(status.outputs[0].state, 'RECOVERY_REQUIRED');
    return Object.fromEntries(status.outputs.map(o => [o.key, { hash: o.hash, fileId: o.fileId }]));
  };
  const before = fs.readFileSync(target), recovery = await inspect(); fault(name, 'after-write-chunk', 'disk-full');
  const failed = await s.host.esegui(s.plan, s.snapshot, permit(s, 'recover', [], recovery));
  assert.equal(failed.state, 'FAIL'); assert.equal(failed.restoration[0].state, 'RESTORED', JSON.stringify(failed));
  assert.deepEqual(fs.readFileSync(target), before); fault(name, '', 'disabled');
  const complete = await s.host.esegui(s.plan, s.snapshot, permit(s, 'recover', [], await inspect()));
  assert.equal(complete.state, 'APPLIED', JSON.stringify(complete));
  const expected = prepara(s.plan, s.snapshot).spec.outputs[0].after; assert.equal(sha(fs.readFileSync(target)), expected);
  assert.equal((await s.host.esegui(s.plan, s.snapshot, permit(s))).state, 'APPLIED'); assert.equal(sha(fs.readFileSync(target)), expected);
});

for (const [name, decision] of [['nested-merge', 'MERGE'], ['nested-target', 'MERGE'], ['nested-noop', 'NOOP'],
  ['nested-noop-target', 'NOOP'], ['nested-ordered', 'MERGE']]) test('TS3 revisione: struttura annidata respinta senza archivio: ' + name, async () => {
  const s = await scenario(name), source = file(name, 'to sort/Film da guardare.md'), target = file(name, 'liste/Film da vedere.md');
  assert.equal(s.plan.decisioni[0].esito, decision);
  assert.equal(verificaPiano(s.plan, s.snapshot).valido, true);
  if (name === 'nested-merge') assert.deepEqual(s.plan.operazioni[0].aggiunte.map(u => u.content), ['- Saga']);
  const before = fs.readFileSync(source), other = fs.existsSync(target) ? fs.readFileSync(target) : null, count = native.events.length;
  assert.throws(() => prepara(s.plan, s.snapshot), { code: 'STRUTTURA_ANNIDATA_NON_SUPPORTATA' });
  await assert.rejects(s.host.esegui(s.plan, s.snapshot, { approved: true, archivia: ['to sort/Film da guardare.md'] }), { code: 'STRUTTURA_ANNIDATA_NON_SUPPORTATA' });
  assert.equal(native.events.length, count, 'Nessun backend o archivio raggiunto');
  assert.deepEqual(fs.readFileSync(source), before);
  if (other) assert.deepEqual(fs.readFileSync(target), other);
  assert.deepEqual(fs.readdirSync(technical(name)), []);
});

test('TS3 revisione: CREATE annidata resta una copia byte-esatta senza deduplicazione', async () => {
  const name = 'nested-create', s = await scenario(name), source = file(name, 'to sort/Film da guardare.md');
  assert.equal(s.plan.decisioni[0].esito, 'CREATE'); const before = fs.readFileSync(source);
  const result = await s.host.esegui(s.plan, s.snapshot, permit(s));
  assert.equal(result.state, 'APPLIED', JSON.stringify(result));
  assert.deepEqual(fs.readFileSync(file(name, 'liste/Film da guardare.md')), before);
  assert.deepEqual(fs.readFileSync(source), before);
});

for (const name of ['crash-merge-retry', 'crash-merge-user']) test('TS3 revisione: MERGE parziale sopravvive a errore di recovery: ' + name, async () => {
  const s = await scenario(name), output = prepara(s.plan, s.snapshot).spec.outputs[0], target = file(name, output.path);
  assert.equal(output.kind, 'append');
  assert.ok(Buffer.from(output.data, 'base64').length > 8192, 'Almeno tre blocchi: crash e secondo errore lasciano un parziale');
  fault(name, 'after-write-chunk', 'crash');
  await assert.rejects(s.host.esegui(s.plan, s.snapshot, permit(s)), e => e.code === 73);
  assert.equal((await native.closed).code, 73); native = await worker(); fault(name, '', 'disabled');
  const inspect = () => s.host.esegui(s.plan, s.snapshot, permit(s, 'inspect'));
  const grant = status => Object.fromEntries(status.outputs.map(o => [o.key, { hash: o.hash, fileId: o.fileId }]));
  const observed = await inspect(), partial = fs.readFileSync(target);
  assert.equal(observed.state, 'INSPECTED'); assert.equal(observed.outputs[0].state, 'RECOVERY_REQUIRED');
  fault(name, 'after-write-chunk', 'disk-full');
  const failed = await s.host.esegui(s.plan, s.snapshot, permit(s, 'recover', [], grant(observed)));
  assert.equal(failed.state, 'FAIL'); assert.equal(failed.nativeCode, 112);
  assert.equal(failed.restoration[0].state, 'RESTORED', JSON.stringify(failed));
  assert.deepEqual(fs.readFileSync(target), partial); fault(name, '', 'disabled');
  const again = await inspect(); assert.equal(again.state, 'INSPECTED', JSON.stringify(again));
  assert.deepEqual(again.outputs, observed.outputs);
  if (name === 'crash-merge-user') {
    fs.appendFileSync(target, 'CONTRIBUTO_UTENTE_SUCCESSIVO\n'); const user = fs.readFileSync(target);
    assert.equal((await inspect()).state, 'FAIL');
    const denied = await s.host.esegui(s.plan, s.snapshot, permit(s, 'recover', [], grant(again)));
    assert.equal(denied.state, 'FAIL'); assert.deepEqual(fs.readFileSync(target), user); return;
  }
  const complete = await s.host.esegui(s.plan, s.snapshot, permit(s, 'recover', [], grant(again)));
  assert.equal(complete.state, 'APPLIED', JSON.stringify(complete)); assert.equal(sha(fs.readFileSync(target)), output.after);
  assert.equal((await s.host.esegui(s.plan, s.snapshot, permit(s))).state, 'APPLIED');
  assert.equal(sha(fs.readFileSync(target)), output.after);
  assert.ok(fs.existsSync(file(name, 'to sort/Film da guardare.md')));
});

test('TS3 revisione: un tentativo compensato definitivamente non riabilita intent precedenti', async () => {
  const name = 'compensated-proof', s = await scenario(name), output = prepara(s.plan, s.snapshot).spec.outputs[0], target = file(name, output.path);
  const original = fs.readFileSync(target); fault(name, 'after-write-chunk', 'disk-full');
  const failed = await s.host.esegui(s.plan, s.snapshot, permit(s));
  assert.equal(failed.state, 'FAIL'); assert.equal(failed.restoration[0].state, 'RESTORED'); fault(name, '', 'disabled');
  const status = await s.host.esegui(s.plan, s.snapshot, permit(s, 'inspect'));
  assert.equal(status.state, 'INSPECTED'); assert.equal(status.outputs[0].state, 'PENDING');
  assert.deepEqual(fs.readFileSync(target), original);
  fs.appendFileSync(target, Buffer.from(output.data, 'base64').subarray(0, 4096)); const user = fs.readFileSync(target);
  const denied = await s.host.esegui(s.plan, s.snapshot, permit(s, 'inspect'));
  assert.equal(denied.state, 'FAIL'); assert.equal(denied.code, 'DESTINATION_HASH_CHANGED');
  assert.deepEqual(fs.readFileSync(target), user);
});

// ---- create_dir: motore nativo reale, stage sintetico ----
const NUOVA = 'liste/nuova';
const tree = name => { const out = {}; const walk = (d, rel) => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n), r = rel ? rel + '/' + n : n; if (fs.lstatSync(p).isDirectory()) { out[r] = 'DIR'; walk(p, r); } else out[r] = sha(fs.readFileSync(p)); } }; walk(root(name), ''); return out; };
const mk = (name, options) => scenario(name, options, NUOVA);
const restartAfterCrash = async (name) => { assert.equal((await native.closed).code, 73); fault(name, '', 'disabled'); native = await worker(); };

test('TS3 create_dir: CREATE con cartella nuova autorizzata, APPLY dopo conferma, note preesistenti intatte', async () => {
  const name = 'mkdir-apply', s = await mk(name), before = tree(name);
  assert.equal(s.plan.decisioni[0].esito, 'CREATE'); assert.deepEqual(s.plan.cartelleDaCreare, [NUOVA]);
  const preview = prepara(s.plan, s.snapshot); assert.deepEqual(preview.spec.mkdirs.map(m => m.path), [NUOVA]);
  const source = fs.readFileSync(file(name, 'to sort/Film da guardare.md'));
  assert.deepEqual(tree(name), before, 'nulla scritto prima della conferma');
  const result = await s.host.esegui(s.plan, s.snapshot, permit(s));
  assert.equal(result.state, 'APPLIED', JSON.stringify(result));
  assert.ok(fs.lstatSync(file(name, NUOVA)).isDirectory()); assert.deepEqual(fs.readFileSync(file(name, NUOVA + '/Film da guardare.md')), source);
  const after = tree(name); for (const [k, v] of Object.entries(before)) assert.equal(after[k], v, 'preesistente alterato: ' + k);
  assert.deepEqual(Object.keys(after).filter(k => !(k in before)).sort(), [NUOVA, NUOVA + '/Film da guardare.md']);
  assert.equal((await s.host.esegui(s.plan, s.snapshot, permit(s))).state, 'APPLIED');   // ripetizione idempotente
  assert.deepEqual(tree(name), after);
});

test('TS3 create_dir: annullamento (nessuna conferma/capability) non chiama il motore e non modifica nulla', async () => {
  const name = 'mkdir-cancel', s = await mk(name), before = tree(name), count = native.events.length;
  await assert.rejects(s.host.esegui(s.plan, s.snapshot, { approved: true }), { code: 'CONFERMA_UTENTE_RICHIESTA' });
  await assert.rejects(s.host.esegui(s.plan, s.snapshot, Object.freeze(Object.create(null))), { code: 'CONFERMA_UTENTE_RICHIESTA' });
  assert.equal(native.events.length, count); assert.deepEqual(tree(name), before); assert.deepEqual(fs.readdirSync(technical(name)), []);
});

test('TS3 create_dir: crash prima della creazione della cartella, poi apply dopo il riavvio', async () => {
  const name = 'mkdir-crash-before', s = await mk(name), before = tree(name); fault(name, 'before-mkdir', 'crash');
  await assert.rejects(s.host.esegui(s.plan, s.snapshot, permit(s)), e => e.code === 73);
  await restartAfterCrash(name); assert.equal(fs.existsSync(file(name, NUOVA)), false);
  const inspected = await s.host.esegui(s.plan, s.snapshot, permit(s, 'inspect')); assert.equal(inspected.state, 'INSPECTED', JSON.stringify(inspected));
  const result = await s.host.esegui(s.plan, s.snapshot, permit(s)); assert.equal(result.state, 'APPLIED', JSON.stringify(result));
  const after = tree(name); for (const [k, v] of Object.entries(before)) assert.equal(after[k], v);
  assert.ok(fs.existsSync(file(name, NUOVA + '/Film da guardare.md')));
});

test('TS3 create_dir: crash dopo la creazione della cartella e prima del done (intent senza done), retry accetta solo la cartella vuota', async () => {
  const name = 'mkdir-crash-created', s = await mk(name); fault(name, 'after-mkdir', 'crash');
  await assert.rejects(s.host.esegui(s.plan, s.snapshot, permit(s)), e => e.code === 73);
  await restartAfterCrash(name); assert.ok(fs.lstatSync(file(name, NUOVA)).isDirectory()); assert.deepEqual(fs.readdirSync(file(name, NUOVA)), []);
  const inspected = await s.host.esegui(s.plan, s.snapshot, permit(s, 'inspect')); assert.equal(inspected.state, 'INSPECTED', JSON.stringify(inspected));
  const result = await s.host.esegui(s.plan, s.snapshot, permit(s)); assert.equal(result.state, 'APPLIED', JSON.stringify(result));
  assert.deepEqual(fs.readdirSync(file(name, NUOVA)), ['Film da guardare.md']);
});

test('TS3 create_dir: crash dopo la cartella e prima della scrittura, poi apply', async () => {
  const name = 'mkdir-crash-after', s = await mk(name); fault(name, 'before-write', 'crash');
  await assert.rejects(s.host.esegui(s.plan, s.snapshot, permit(s)), e => e.code === 73);
  await restartAfterCrash(name); assert.deepEqual(fs.readdirSync(file(name, NUOVA)), []);
  const result = await s.host.esegui(s.plan, s.snapshot, permit(s)); assert.equal(result.state, 'APPLIED', JSON.stringify(result));
  assert.deepEqual(fs.readdirSync(file(name, NUOVA)), ['Film da guardare.md']);
});

test('TS3 create_dir: crash a meta scrittura della nota, RECOVER e retry idempotente', async () => {
  const name = 'mkdir-crash-mid', s = await mk(name), target = file(name, NUOVA + '/Film da guardare.md'); fault(name, 'after-write-chunk', 'crash');
  await assert.rejects(s.host.esegui(s.plan, s.snapshot, permit(s)), e => e.code === 73);
  await restartAfterCrash(name);
  const status = await s.host.esegui(s.plan, s.snapshot, permit(s, 'inspect'));
  assert.equal(status.state, 'INSPECTED', JSON.stringify(status)); assert.equal(status.outputs[0].state, 'RECOVERY_REQUIRED');
  const denied = await s.host.esegui(s.plan, s.snapshot, permit(s)); assert.equal(denied.state, 'FAIL');   // senza recupero esplicito non si prosegue
  const recovery = Object.fromEntries(status.outputs.map(o => [o.key, { hash: o.hash, fileId: o.fileId }]));
  const done = await s.host.esegui(s.plan, s.snapshot, permit(s, 'recover', [], recovery));
  assert.equal(done.state, 'APPLIED', JSON.stringify(done));
  const expected = prepara(s.plan, s.snapshot).spec.outputs[0].after; assert.equal(sha(fs.readFileSync(target)), expected);
  assert.equal((await s.host.esegui(s.plan, s.snapshot, permit(s))).state, 'APPLIED'); assert.equal(sha(fs.readFileSync(target)), expected);
});

test('TS3 create_dir: cartella creata da un altro processo prima dell\'APPLY: FAIL, nessuna nota scritta, cartella altrui intatta', async () => {
  const name = 'mkdir-race', s = await mk(name); fs.mkdirSync(file(name, NUOVA)); const before = tree(name);
  const result = await s.host.esegui(s.plan, s.snapshot, permit(s));
  assert.equal(result.state, 'FAIL', JSON.stringify(result)); assert.equal(result.code, 'CATALOG_NAMES_CHANGED');
  assert.deepEqual(tree(name), before); assert.deepEqual(fs.readdirSync(file(name, NUOVA)), []);
});

test('TS3 create_dir: junction al posto della cartella: FAIL e nessuna scrittura verso la destinazione esterna', async () => {
  const name = 'mkdir-junction', s = await mk(name), outside = path.join(guard.root, 'tmp', 'esterna-' + name); fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, file(name, NUOVA), 'junction'); const sourceBefore = fs.readFileSync(file(name, 'to sort/Film da guardare.md'));
  const result = await s.host.esegui(s.plan, s.snapshot, permit(s));
  assert.equal(result.state, 'FAIL', JSON.stringify(result)); assert.match(String(result.code), /REPARSE|CATALOG_NAMES_CHANGED/, JSON.stringify(result)); assert.deepEqual(fs.readdirSync(outside), []);
  assert.deepEqual(fs.readFileSync(file(name, 'to sort/Film da guardare.md')), sourceBefore);
});

test('TS3 create_dir: fallimento intermedio (disco pieno), nota annullata, cartella vuota residua, retry riuscito', async () => {
  const name = 'mkdir-fail', s = await mk(name), before = tree(name); fault(name, 'after-write-chunk', 'disk-full');
  const failed = await s.host.esegui(s.plan, s.snapshot, permit(s));
  assert.equal(failed.state, 'FAIL', JSON.stringify(failed)); assert.equal(failed.nativeCode, 112);
  assert.equal(failed.restoration[0].state, 'RESTORED', JSON.stringify(failed));
  assert.ok(fs.lstatSync(file(name, NUOVA)).isDirectory()); assert.deepEqual(fs.readdirSync(file(name, NUOVA)), []);   // cartella vuota residua, nota non lasciata a meta
  for (const [k, v] of Object.entries(before)) assert.equal(tree(name)[k], v);
  fault(name, '', 'disabled');
  const retry = await s.host.esegui(s.plan, s.snapshot, permit(s)); assert.equal(retry.state, 'APPLIED', JSON.stringify(retry));
  assert.deepEqual(fs.readdirSync(file(name, NUOVA)), ['Film da guardare.md']);
});

test('TS3 create_dir: rollback rimuove la nota, lascia la cartella vuota e non tocca le preesistenti', async () => {
  const name = 'mkdir-rollback', s = await mk(name), before = tree(name), moved = ['to sort/Film da guardare.md'];
  const applied = await s.host.esegui(s.plan, s.snapshot, permit(s, 'apply', moved)); assert.equal(applied.state, 'APPLIED', JSON.stringify(applied));
  const rolled = await s.host.esegui(s.plan, s.snapshot, permit(s, 'rollback', moved)); assert.equal(rolled.state, 'ROLLED_BACK', JSON.stringify(rolled));
  assert.ok(fs.lstatSync(file(name, NUOVA)).isDirectory()); assert.deepEqual(fs.readdirSync(file(name, NUOVA)), []);
  const after = tree(name); for (const [k, v] of Object.entries(before)) assert.equal(after[k], v, k);
});

test('TS3 create_dir: piani manomessi (cartelle in piu, traversal, catena) rifiutati prima del motore, anche con hash ricalcolato', async () => {
  const name = 'mkdir-tamper', s = await mk(name), count = native.events.length, before = tree(name);
  for (const lista of [[NUOVA, 'liste/altra'], ['../fuori'], ['liste'], [], ['liste/nuova/sotto'], [NUOVA, NUOVA]]) {
    const falso = altered(s.plan, p => { p.cartelleDaCreare = lista; });
    assert.equal(verificaPiano(falso, s.snapshot).valido, false, JSON.stringify(lista));
    assert.throws(() => prepara(falso, s.snapshot));
    await assert.rejects(s.host.esegui(falso, s.snapshot, { approved: true }));
  }
  assert.equal(native.events.length, count); assert.deepEqual(tree(name), before);
});

test('TS3 create_dir: destinazioni non autorizzate e traversal rifiutati dal reader (nessun mkdir pianificabile)', async () => {
  const name = 'mkdir-escape', info = await native.call('attributes', name), before = tree(name);
  const reparse = p => !!(info.attributes[p.toLowerCase()] & 0x400);
  for (const dir of ['liste/../fuori', '../fuori', 'to sort/nuova', 'altro/nuova', 'cervello/nuova', 'liste/.nascosta', 'C:/fuori']) {
    assert.throws(() => leggiSnapshot({ radice: root(name), autorizzati: ['liste'], creaIn: [dir], verificaReparse: reparse }), e => !!e.code, dir);
  }
  // catena di livelli mancanti: nessun CREATE e nessuna cartella da creare
  const s = await scenario(name, {}, 'liste/a/b');
  assert.notEqual(s.plan.decisioni[0].esito, 'CREATE'); assert.deepEqual(s.plan.cartelleDaCreare, []); assert.deepEqual(tree(name), before);
});

// ---- create_dir: collisione reale a FILE_CREATE e mkdirs manomessi inviati direttamente al motore ----
test('TS3 create_dir: collisione reale a FILE_CREATE (cartella creata da altri tra controllo e creazione): 183, collision nel journal, retry rifiutato, cartella altrui mai adottata', async () => {
  const name = 'mkdir-collision', s = await mk(name); fault(name, 'before-mkdir', 'pause'); const start = native.events.length;
  const first = s.host.esegui(s.plan, s.snapshot, permit(s));
  try { await checkpoint(native, name, 'before-mkdir', start); fs.mkdirSync(file(name, NUOVA)); } finally { resume(name); }
  const failed = await first;
  assert.equal(failed.state, 'FAIL', JSON.stringify(failed)); assert.equal(failed.nativeCode, 183, JSON.stringify(failed));
  fault(name, '', 'disabled');
  const retry = await s.host.esegui(s.plan, s.snapshot, permit(s));
  assert.equal(retry.state, 'FAIL', JSON.stringify(retry)); assert.equal(retry.code, 'MKDIR_COLLISION', JSON.stringify(retry));
  assert.deepEqual(fs.readdirSync(file(name, NUOVA)), []);   // la cartella altrui resta vuota: nessuna nota scritta
});

test('TS3 create_dir: mkdirs manomessi inviati direttamente al motore (con preview coerente) rifiutati prima di creare qualsiasi cartella', async () => {
  const name = 'mkdir-direct', s = await mk(name), before = tree(name), base = prepara(s.plan, s.snapshot).spec;
  const k = p => ({ path: p, key: sha(p) });
  const invia = async mkdirs => {
    const spec = { ...base, mkdirs }, preview = impronta(spec);
    return native.call('execute', name, canonico({ spec, preview, rootFileId: s.rootIdentity, action: 'apply', archive: [], recovery: {} }));
  };
  for (const mkdirs of [[k('nuova')], [k('altro/nuova')], [k('liste')], [k('LISTE/nuova2')], [k(NUOVA), k(NUOVA + '/sotto')], [k(NUOVA), k(NUOVA)], [k('liste/inutile')]]) {
    const r = await invia(mkdirs);
    assert.equal(r.state, 'FAIL', JSON.stringify(mkdirs)); assert.equal(r.code, 'MKDIR_NOT_AUTHORIZED', JSON.stringify(r));
    assert.deepEqual(tree(name), before, 'nessuna cartella creata: ' + JSON.stringify(mkdirs));
  }
});

// ---- nomi non ASCII: il canale pwsh <-> Node deve essere UTF-8 (altrimenti VERIFICA_REPARSE_INCOMPLETA sulle note Notion) ----
test('TS3 unicode: nomi non ASCII nel catalogo hanno attributi nativi completi (copertura completa) e il piano si pianifica', async () => {
  const name = 'unicode', s = await scenario(name);   // scenario() asserisce copertura.completa === true
  assert.equal(s.snapshot.catalogo.length, 4); assert.ok(s.snapshot.catalogo.some(n => n.percorso === 'liste/Rappresentazione dell’informazione – Schema.md'));
  assert.ok(s.snapshot.catalogo.some(n => n.percorso === 'liste/Proattività.md'));
  assert.equal(s.snapshot.copertura.problemi.length, 0);
  assert.equal(s.plan.decisioni[0].esito, 'CREATE');
  const before = tree(name), result = await s.host.esegui(s.plan, s.snapshot, permit(s));
  assert.equal(result.state, 'APPLIED', JSON.stringify(result));
  const after = tree(name); for (const [k, v] of Object.entries(before)) assert.equal(after[k], v, k);
});

test('TS3 unicode: cartella e nota con nome non ASCII create dal motore nativo con il percorso esatto', async () => {
  const name = 'unicode-dir', dir = 'liste/Città – nuova', s = await scenario(name, {}, dir), before = tree(name);
  assert.deepEqual(s.plan.cartelleDaCreare, [dir]);
  const result = await s.host.esegui(s.plan, s.snapshot, permit(s));
  assert.equal(result.state, 'APPLIED', JSON.stringify(result));
  assert.ok(fs.readdirSync(file(name, 'liste')).includes('Città – nuova'));
  assert.deepEqual(fs.readdirSync(file(name, dir)), ['Film da guardare.md']);
  const after = tree(name); for (const [k, v] of Object.entries(before)) assert.equal(after[k], v, k);
});
