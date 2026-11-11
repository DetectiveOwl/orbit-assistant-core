'use strict';
// TS-6B: un piano di soli NOOP non chiede il consenso locale e non risulta APPLIED; MERGE/CREATE continuano a richiederlo. Backend finto, stage temporaneo sintetico.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { run } = require('../../smart-inbox/cli');

const ROOT_ID = '00000001:0000000000000001';
const creati = [];
test.after(() => { for (const p of creati) fs.rmSync(p, { recursive: true, force: true }); });
function fixture(target) {
  const stage = path.join(fs.realpathSync(os.tmpdir()), 'orbit-smart-inbox-ts3-' + crypto.randomBytes(16).toString('hex'));
  creati.push(stage);
  const context = { stage, vault: 'data/v', technical: 'technical/v' }, root = path.join(stage, context.vault);
  for (const d of ['to sort', 'liste']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'to sort/Film da guardare.md'), '# Film da guardare\n- Dune\n');
  fs.writeFileSync(path.join(root, 'liste/Film da vedere.md'), target);
  const calls = [];
  const backend = async () => ({
    async attributes() {
      const attributes = {};
      const walk = p => { const dir = fs.statSync(p).isDirectory(); attributes[p.toLowerCase()] = dir ? 16 : 0; if (dir) for (const n of fs.readdirSync(p)) walk(path.join(p, n)); };
      walk(root);
      for (let p = path.dirname(root); ; p = path.dirname(p)) { attributes[p.toLowerCase()] = 16; if (p === path.dirname(p)) break; }
      return { rootIdentity: ROOT_ID, attributes };
    },
    async confirm() { calls.push('confirm'); return false; },
    async execute(body) {
      const r = JSON.parse(body); calls.push(r.action);
      assert.equal(r.action, 'inspect', 'il finto backend non scrive');
      return { state: 'INSPECTED', outputs: r.spec.outputs.map(o => ({ key: o.key, path: o.path, state: 'PENDING', hash: 'a'.repeat(64), fileId: ROOT_ID })) };
    },
    async close() {}
  });
  return { context, calls, backend };
}
async function pianifica(f) {
  const input = { context: f.context, autorizzati: ['liste'], creaIn: ['liste'], creazioni: { 'to sort/Film da guardare.md': 'liste' } };
  const b = await run('prepare', input, f.backend);
  const valutazioni = b.richiesteSemantiche.map(q => ({ sorgente: { percorso: q.sorgente.percorso, sha256: q.sorgente.sha256 },
    valutazioni: q.candidati.map(n => ({ percorso: n.percorso, sha256: n.sha256, relazione: 'equivalente' })) }));
  return run('plan', { bundle: b, valutazioni }, f.backend);
}

test('NOOP: nessun consenso, solo inspect, esito NOOP e non APPLIED', async () => {
  const f = fixture('# Film da vedere\n- Dune\n'), bundle = await pianifica(f);
  assert.equal(bundle.piano.decisioni[0].esito, 'NOOP');
  f.calls.length = 0;
  const r = await run('apply', { bundle }, f.backend);
  assert.equal(r.state, 'NOOP');
  assert.deepEqual(f.calls, ['inspect']);
});

test('MERGE: il consenso resta obbligatorio (negato = nessuna esecuzione)', async () => {
  const f = fixture('# Film da vedere\n- Alien\n'), bundle = await pianifica(f);
  assert.equal(bundle.piano.decisioni[0].esito, 'MERGE');
  f.calls.length = 0;
  await assert.rejects(run('apply', { bundle }, f.backend), { code: 'CONSENSO_UMANO_NON_DISPONIBILE_O_NEGATO' });
  assert.deepEqual(f.calls, ['confirm']);
});

test('NOOP con archiviazione richiesta: il consenso resta obbligatorio', async () => {
  const f = fixture('# Film da vedere\n- Dune\n'), bundle = await pianifica(f);
  f.calls.length = 0;
  await assert.rejects(run('apply', { bundle, archivia: ['to sort/Film da guardare.md'] }, f.backend), { code: 'CONSENSO_UMANO_NON_DISPONIBILE_O_NEGATO' });
  assert.deepEqual(f.calls, ['confirm']);
});
