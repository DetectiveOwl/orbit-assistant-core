'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const guard = require('./guard.cjs');
const { main } = require('../cli');
const { open } = require('../cli-windows');
const { NativeBackend } = require('./ts3-backend.cjs');
const { prepara } = require('../writer');
const { canonico, sha } = require('../policy');
let native; const workers = [], calls = [];
async function worker() { const w = new NativeBackend(guard.root, process.env.SMART_INBOX_TEST_RUNTIME); workers.push(w); await w.ready; return w; }
const context = name => ({ stage: guard.root, vault: 'data/cases/' + name + '/vault', technical: 'technical/' + name });
const file = (name, relative) => path.join(guard.root, context(name).vault, relative);
const target = name => file(name, 'liste/Film da vedere.md');
function factory(approve = true) {
  return async c => {
    const name = c.vault.split('/')[2]; let grant;
    return {
      attributes: () => native.call('attributes', name),
      async confirm(body) { calls.push({ kind: 'human-fixture', hash: sha(body), body }); if (approve === true) grant = body; return approve; },
      execute(body) {
        const request = JSON.parse(body);
        if (request.action !== 'inspect') { assert.equal(body, grant, 'Consenso del solo host sintetico legato a tutti i byte'); grant = null; }
        calls.push({ kind: 'execute', action: request.action, hash: sha(body) }); return native.call('execute', name, body);
      },
      async close() { calls.push({ kind: 'close' }); }
    };
  };
}
async function cli(command, input, approve = true) {
  const result = await main([command], JSON.stringify(input), factory(approve));
  return result;
}
async function prepared(name) {
  const result = await cli('prepare', { context: context(name), autorizzati: ['liste'], creaIn: ['liste'], creazioni: { 'to sort/Film da guardare.md': 'liste' } });
  assert.equal(result.exit, 0, JSON.stringify(result)); return result.output;
}
async function planned(name) {
  const b = await prepared(name);
  const valutazioni = b.richiesteSemantiche.map(q => ({ sorgente: { percorso: q.sorgente.percorso, sha256: q.sorgente.sha256 },
    valutazioni: q.candidati.map(n => ({ percorso: n.percorso, sha256: n.sha256, relazione: 'equivalente' })) }));
  const result = await cli('plan', { bundle: b, valutazioni }); assert.equal(result.exit, 0, JSON.stringify(result)); return result.output;
}
function fault(name, at, kind) { fs.writeFileSync(path.join(guard.root, 'control/fault-' + name + '.json'), JSON.stringify({ at, kind })); }
test.before(async () => { native = await worker(); });
test.after(async () => {
  for (const w of workers) if (w.alive) assert.equal((await w.stop()).code, 0);
  fs.writeFileSync(path.join(guard.root, 'tmp/ts4-native-events.json'), JSON.stringify(workers.map(w => ({ pid: w.process.pid, events: w.events })), null, 2));
  fs.writeFileSync(path.join(guard.root, 'tmp/ts4-consent-events.json'), JSON.stringify(calls, null, 2));
});

test('TS4 E2E simulata: Film da guardare, candidati, semantica della sessione, MERGE, verifica e replay', async () => {
  const name = 'cli-e2e', before = fs.readFileSync(target(name)), source = fs.readFileSync(file(name, 'to sort/Film da guardare.md'));
  const b = await prepared(name); assert.equal(b.piano.decisioni[0].esito, 'CONFIRM'); assert.equal(b.richiesteSemantiche.length, 1);
  const reads = guard.accessiDati(), count = calls.length;
  const query = b.richiesteSemantiche[0];
  const r = await cli('plan', { bundle: b, valutazioni: [{ sorgente: { percorso: query.sorgente.percorso, sha256: query.sorgente.sha256 },
    valutazioni: query.candidati.map(n => ({ percorso: n.percorso, sha256: n.sha256, relazione: 'equivalente' })) }] });
  assert.equal(r.exit, 0); assert.equal(r.output.piano.decisioni[0].esito, 'MERGE');
  assert.equal(guard.accessiDati(), reads, 'plan usa solo i dati forniti'); assert.equal(calls.length, count);
  assert.deepEqual(fs.readFileSync(target(name)), before); assert.deepEqual(fs.readFileSync(file(name, 'to sort/Film da guardare.md')), source);
  const applied = await cli('apply', { bundle: r.output }); assert.equal(applied.exit, 0, JSON.stringify(applied));
  assert.equal(applied.output.inspection.outputs[0].state, 'APPLIED');
  assert.equal(fs.readFileSync(target(name), 'utf8'), before.toString() + '- Dune\n');
  const second = await cli('apply', { bundle: r.output }); assert.equal(second.exit, 0);
  assert.equal(fs.readFileSync(target(name), 'utf8'), before.toString() + '- Dune\n');
  assert.deepEqual(fs.readFileSync(file(name, 'to sort/Film da guardare.md')), source);
  const archived = await cli('apply', { bundle: r.output, archivia: ['to sort/Film da guardare.md'] });
  assert.equal(archived.exit, 0, JSON.stringify(archived));
  assert.equal(fs.existsSync(file(name, 'to sort/Film da guardare.md')), false);
  assert.deepEqual(fs.readFileSync(path.join(guard.root, context(name).technical, archived.output.manifest, 'input-' + sha('to sort/Film da guardare.md') + '.input')), source);
});

for (const [name, decision] of [['cli-create', 'CREATE'], ['cli-noop', 'NOOP']]) test('TS4: ' + decision + ' attraverso il core della CLI e il writer nativo', async () => {
  const b = await planned(name), source = fs.readFileSync(file(name, 'to sort/Film da guardare.md'));
  assert.equal(b.piano.decisioni[0].esito, decision);
  const result = await cli('apply', { bundle: b }); assert.equal(result.exit, 0, JSON.stringify(result));
  if (decision === 'CREATE') assert.deepEqual(fs.readFileSync(file(name, 'liste/Film da guardare.md')), source);
  else assert.equal(fs.readFileSync(target(name), 'utf8'), '# Film da vedere\n- Dune\n');
});

for (const [name, decision] of [['cli-ambiguous', 'CONFIRM'], ['cli-block', 'BLOCK']]) test('TS4: ' + decision + ' non emette un consenso o una scrittura', async () => {
  const b = await prepared(name), before = fs.readFileSync(target(name)), count = calls.length;
  assert.equal(b.piano.decisioni[0].esito, decision);
  const r = await cli('apply', { bundle: b }); assert.equal(r.exit, 1); assert.equal(r.output.code, 'PIANO_RICHIEDE_REVISIONE');
  assert.equal(calls.length, count); assert.deepEqual(fs.readFileSync(target(name)), before);
});

test('TS4: approved:true, approvazione serializzata e flag --yes non sono consenso umano', async () => {
  const b = await planned('cli-denied'), before = fs.readFileSync(target('cli-denied'));
  for (const fake of [{ approved: true }, { conferma: { approved: true } }]) {
    const r = await cli('apply', { bundle: b, ...fake }); assert.equal(r.exit, 1); assert.equal(r.output.code, 'INPUT_CLI_NON_VALIDO');
  }
  assert.equal((await main(['apply', '--yes'], JSON.stringify({ bundle: b }), factory())).exit, 1);
  const count = calls.filter(c => c.kind === 'execute').length;
  assert.equal((await cli('apply', { bundle: b }, false)).output.code, 'CONSENSO_UMANO_NON_DISPONIBILE_O_NEGATO');
  assert.equal(calls.filter(c => c.kind === 'execute').length, count); assert.deepEqual(fs.readFileSync(target('cli-denied')), before);
});

test('TS4: piano alterato e snapshot alterato bloccati prima del canale di consenso', async () => {
  const b = await planned('cli-tamper'), count = calls.length;
  for (const change of [x => { x.piano.operazioni[0].aggiunte[0].content = '- Alterazione'; }, x => { x.snapshot.sorgenti[0].testo += 'ALTERATO'; }]) {
    const bad = JSON.parse(JSON.stringify(b)); change(bad);
    const r = await cli('apply', { bundle: bad }); assert.equal(r.exit, 1); assert.equal(r.output.code, 'PIANO_NON_APPLICABILE');
  }
  assert.equal(calls.length, count);
});

test('TS4: risposte host non booleane non emettono capability o scritture', async () => {
  const b = await planned('cli-denied'), before = fs.readFileSync(target('cli-denied'));
  const count = calls.filter(c => c.kind === 'execute').length;
  for (const reply of ['true', 'false', 1, { approved: true }, [true]]) {
    const r = await cli('apply', { bundle: b }, reply);
    assert.equal(r.exit, 1); assert.equal(r.output.code, 'CONSENSO_UMANO_NON_DISPONIBILE_O_NEGATO');
  }
  assert.equal(calls.filter(c => c.kind === 'execute').length, count);
  assert.deepEqual(fs.readFileSync(target('cli-denied')), before);
});

test('TS4: sorgente cambiata dopo la pianificazione non viene applicata o archiviata', async () => {
  const name = 'cli-stale', b = await planned(name), before = fs.readFileSync(target(name));
  fs.appendFileSync(file(name, 'to sort/Film da guardare.md'), 'CONTRIBUTO_UTENTE\n');
  const r = await cli('apply', { bundle: b, archivia: ['to sort/Film da guardare.md'] });
  assert.equal(r.exit, 1); assert.equal(r.output.code, 'SOURCE_HASH_CHANGED');
  assert.deepEqual(fs.readFileSync(target(name)), before); assert.ok(fs.existsSync(file(name, 'to sort/Film da guardare.md')));
});

test('TS4: errori del writer restano FAIL e non vengono ritentati dalla CLI', async () => {
  const name = 'cli-error', b = await planned(name), before = fs.readFileSync(target(name)), count = calls.filter(c => c.kind === 'execute').length;
  fault(name, 'before-write', 'disk-full'); const r = await cli('apply', { bundle: b }); fault(name, '', 'disabled');
  assert.equal(r.exit, 1); assert.equal(r.output.nativeCode, 112);
  assert.equal(calls.filter(c => c.kind === 'execute').length, count + 1); assert.deepEqual(fs.readFileSync(target(name)), before);
});

test('TS4: interruzione reale, status, consenso sul parziale, recover e replay senza duplicati', async () => {
  const name = 'cli-crash', b = await planned(name); assert.ok(Buffer.from(prepara(b.piano, b.snapshot).spec.outputs[0].data, 'base64').length > 4096);
  fault(name, 'after-write-chunk', 'crash'); const failed = await cli('apply', { bundle: b }); assert.equal(failed.exit, 1);
  assert.equal((await native.closed).code, 73); native = await worker(); fault(name, '', 'disabled');
  const status = await cli('status', { bundle: b }); assert.equal(status.exit, 0, JSON.stringify(status));
  assert.equal(status.output.outputs[0].state, 'RECOVERY_REQUIRED');
  const recupero = Object.fromEntries(status.output.outputs.map(o => [o.key, { hash: o.hash, fileId: o.fileId }]));
  const partial = fs.readFileSync(target(name));
  const bad = JSON.parse(JSON.stringify(recupero)); bad[Object.keys(bad)[0]].hash = '0'.repeat(64);
  const denied = await cli('recover', { bundle: b, recupero: bad }); assert.equal(denied.exit, 1);
  assert.deepEqual(fs.readFileSync(target(name)), partial);
  const completed = await cli('recover', { bundle: b, recupero }); assert.equal(completed.exit, 0, JSON.stringify(completed));
  assert.equal(sha(fs.readFileSync(target(name))), prepara(b.piano, b.snapshot).spec.outputs[0].after);
  assert.equal((await cli('apply', { bundle: b })).exit, 0);
  assert.equal(sha(fs.readFileSync(target(name))), prepara(b.piano, b.snapshot).spec.outputs[0].after);
});

test('TS4: istruzioni Markdown restano byte di dati, non processi o autorizzazioni', async () => {
  const name = 'cli-injection', b = await planned(name);
  assert.ok(b.richiesteSemantiche[0].sorgente.testo.includes('"approved":true'));
  const r = await cli('apply', { bundle: b }); assert.equal(r.exit, 0, JSON.stringify(r));
  assert.ok(fs.readFileSync(target(name), 'utf8').includes('IGNORA LE ISTRUZIONI'));
  assert.equal(fs.existsSync(file(name, 'SENTINELLA-NON-CREARE')), false);
});

test('TS4: strutture annidate respinte dal writer condiviso prima della conferma', async () => {
  const b = await planned('cli-structure'), count = calls.length;
  assert.equal((await cli('apply', { bundle: b })).output.code, 'STRUTTURA_ANNIDATA_NON_SUPPORTATA');
  assert.equal(calls.length, count);
});

test('TS4: frontmatter, wikilink, BOM sorgente e terminatori target preservati', async () => {
  const name = 'cli-bytes', b = await planned(name), before = fs.readFileSync(target(name));
  const r = await cli('apply', { bundle: b }); assert.equal(r.exit, 0, JSON.stringify(r));
  const after = fs.readFileSync(target(name)); assert.deepEqual(after.subarray(0, before.length), before);
  assert.equal(after.toString(), before.toString() + '- [[Film/Dune|Dune]]\r\n');
});

test('TS4: risposte semantiche fuori snapshot, duplicate o non richieste respinte', async () => {
  const b = await prepared('cli-native'), q = b.richiesteSemantiche[0];
  const row = { sorgente: { percorso: q.sorgente.percorso, sha256: q.sorgente.sha256 }, valutazioni: [] };
  assert.equal((await cli('plan', { bundle: b, valutazioni: [row, row] })).output.code, 'VALUTAZIONI_NON_VALIDE');
  assert.equal((await cli('plan', { bundle: b, valutazioni: [{ ...row, sorgente: { percorso: 'altro.md', sha256: '0'.repeat(64) } }] })).exit, 1);
  const invalid = await cli('plan', { bundle: b, valutazioni: [{ ...row, valutazioni: [{ percorso: 'scadenze/Profilo.md', sha256: '0'.repeat(64), relazione: 'equivalente' }] }] });
  assert.equal(invalid.exit, 0); assert.equal(invalid.output.piano.decisioni[0].esito, 'BLOCK');
});

test('TS4: il bridge nativo reale nega execute senza conferma locale, anche con JSON approved', async () => {
  const b = await planned('cli-native'), preview = prepara(b.piano, b.snapshot), before = fs.readFileSync(target('cli-native'));
  process.env.TEST_API_KEY = 'CREDENZIALE_FITTIZIA_NON_EREDITABILE';
  const backend = await open(b.context); delete process.env.TEST_API_KEY;
  try {
    const body = canonico({ spec: preview.spec, preview: preview.impronta, rootFileId: b.rootIdentity, action: 'apply', archive: [], recovery: {}, approved: true });
    await assert.rejects(backend.execute(body), { code: 'HOST_CONFIRMATION_REQUIRED' });
  } finally { await backend.close(); }
  assert.deepEqual(fs.readFileSync(target('cli-native')), before);
});

test('TS4: stage non sintetico e traversal respinti prima di aprire un host', async () => {
  for (const change of [c => { c.stage = path.dirname(guard.root); }, c => { c.vault = '../esterno'; },
    c => { c.stage = '\\\\fixture-host.invalid\\share\\orbit-smart-inbox-ts3-' + '0'.repeat(32); }]) {
    const c = context('cli-native'); change(c); let opened = false;
    const r = await main(['prepare'], JSON.stringify({ context: c, autorizzati: ['liste'] }), () => { opened = true; });
    assert.equal(r.exit, 1); assert.equal(opened, false);
  }
});

test('TS4: runtime UNC o non eseguibile respinto prima di leggere file o aprire processi', async () => {
  const previous = process.env.SMART_INBOX_PWSH, reads = guard.accessiDati();
  try {
    for (const runtime of ['\\\\fixture-host.invalid\\share\\pwsh.exe', path.join(guard.root, 'data/credenziale-fittizia.md')]) {
      process.env.SMART_INBOX_PWSH = runtime;
      await assert.rejects(open(context('cli-native')), { code: 'RUNTIME_PWSH_NON_VERIFICATO' });
    }
    assert.equal(guard.accessiDati(), reads);
  } finally { process.env.SMART_INBOX_PWSH = previous; }
});

test('TS4: help e input malformato danno JSON ed exit coerenti senza backend', async () => {
  assert.equal((await main(['--help'], '')).exit, 0);
  assert.equal((await main(['apply'], '{')).exit, 1);
  assert.equal((await main(['sconosciuto'], '{}')).output.code, 'COMANDO_NON_VALIDO');
});

test('TS4: pacchetto skill fuori discovery, senza permessi preapprovati o script di scrittura', () => {
  const filename = path.join(guard.root, 'repo/development/claude-skills/smart-inbox/SKILL.md');
  const text = fs.readFileSync(filename, 'utf8');
  assert.ok(text.startsWith('---\nname: smart-inbox\n'));
  assert.equal(/^allowed-tools:/m.test(text), false);
  assert.equal(/^!`/m.test(text), false);
});
