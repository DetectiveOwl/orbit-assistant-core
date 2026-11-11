'use strict';
const fs = require('node:fs'), path = require('node:path');
const stage = process.argv.at(-1);
const cases = ['create', 'merge', 'noop', 'block', 'confirm', 'tampered', 'stale', 'source-changed', 'dest-changed', 'missing', 'moved', 'protected', 'junction',
  'case-collision', 'parallel-same', 'parallel-different', 'manual', 'p5', 'full', 'crash-backup', 'crash-written', 'crash-partial', 'repeat', 'recover',
  'rollback-user', 'rollback-create', 'rollback-merge', 'structure', 'empty', 'torn', 'auth', 'dup-noop', 'dup-ops', 'backup-tamper', 'archive-denied', 'archive-collision',
  'bytes-create', 'bytes-merge', 'windows-collision', 'root-replaced', 'recovery-user', 'ordinary-partial', 'ordinary-create', 'rollback-error', 'restore-error', 'crash-create',
  'crash-merge-retry', 'crash-merge-user', 'compensated-proof', 'nested-merge', 'nested-target', 'nested-noop', 'nested-noop-target', 'nested-ordered', 'nested-create',
  'mkdir-apply', 'mkdir-cancel', 'mkdir-crash-before', 'mkdir-crash-after', 'mkdir-crash-mid', 'mkdir-crash-created', 'mkdir-race', 'mkdir-junction', 'mkdir-fail', 'mkdir-rollback', 'mkdir-tamper', 'mkdir-escape', 'mkdir-collision', 'mkdir-direct', 'unicode', 'unicode-dir'];
const mkdirCases = cases.filter(n => n.startsWith('mkdir-'));
for (const name of cases) {
  const root = path.join(stage, 'data/cases', name, 'vault');
  for (const dir of ['to sort', 'liste']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.mkdirSync(path.join(stage, 'technical', name), { recursive: true });
  fs.writeFileSync(path.join(root, 'to sort/Film da guardare.md'), '# Film da guardare\n- Dune\n');
  if (!['create', 'rollback-create', 'empty', 'bytes-create', 'windows-collision', 'ordinary-create', 'crash-create', 'nested-create', ...mkdirCases, 'unicode', 'unicode-dir'].includes(name)) fs.writeFileSync(path.join(root, 'liste/Film da vedere.md'), '# Film da vedere\n- Alien\n');
  if (mkdirCases.includes(name)) fs.writeFileSync(path.join(root, 'liste/Altro.md'), '# Altro\n- nota preesistente\n');   // 'liste/nuova' non esiste
  if (name === 'noop') fs.writeFileSync(path.join(root, 'liste/Film da vedere.md'), '# Film da vedere\n- Dune\n');
  if (name === 'block') fs.writeFileSync(path.join(root, 'to sort/Film da guardare.md'), '[[cervello/Profilo.md]]\n');
  if (name === 'dup-noop') {
    fs.writeFileSync(path.join(root, 'liste/Film da vedere.md'), '# Film da vedere\n- Dune\n');
    fs.writeFileSync(path.join(root, 'to sort/Viaggi.md'), '# Viaggi\n- Roma\n');fs.writeFileSync(path.join(root, 'liste/Viaggi.md'), '# Viaggi\n- Roma\n');
  }
  if (name === 'dup-ops') fs.writeFileSync(path.join(root, 'to sort/Altro.md'), '# Film da guardare\n- Interstellar\n');
  if (name === 'structure') {
    fs.writeFileSync(path.join(root, 'to sort/Film da guardare.md'), '# Film da guardare\n## Fantascienza\n- Dune\n');
    fs.writeFileSync(path.join(root, 'liste/Film da vedere.md'), '# Film da vedere\n## Fantascienza\n- Alien\n');
  }
  if (['crash-partial', 'recovery-user', 'ordinary-partial', 'ordinary-create', 'crash-create', 'crash-merge-retry', 'crash-merge-user', 'compensated-proof', 'mkdir-crash-mid', 'mkdir-fail'].includes(name)) {
    const length = ['crash-merge-retry', 'crash-merge-user', 'compensated-proof'].includes(name) ? 400 : 1200;
    fs.writeFileSync(path.join(root, 'to sort/Film da guardare.md'), '# Film da guardare\n' + Array.from({ length }, (_, i) => '- Titolo sintetico ' + i).join('\n') + '\n');
  }
  if (name === 'unicode' || name === 'unicode-dir') {   // nomi non ASCII: trattino lungo, apostrofo tipografico, accento composto e scomposto
    for (const n of ['Introduzione al C – Schema.md', 'Rappresentazione dell’informazione – Schema.md', 'Proattività.md', 'Caffé.md']) fs.writeFileSync(path.join(root, 'liste', n), '# ' + n + '\n- sintetica\n');
  }
  const nested = {
    'nested-merge': ['- Saga\n  - Dune\n', '- Altri\n  - Dune\n'],
    'nested-target': ['- Saga\n', '- Altri\n  - Dune\n'],
    'nested-noop': ['- Saga\n  - Dune\n', '- Saga\n- Altri\n  - Dune\n'],
    'nested-noop-target': ['- Dune\n', '- Dune\n- Altri\n  - Alien\n'],
    'nested-ordered': ['1. Saga\n\t1. Dune\n', '1. Altri\n\t1. Dune\n'],
    'nested-create': ['- Saga\n  - Dune\n', null],
  }[name];
  if (nested) {
    fs.writeFileSync(path.join(root, 'to sort/Film da guardare.md'), '# Film da guardare\n' + nested[0]);
    if (nested[1] !== null) fs.writeFileSync(path.join(root, 'liste/Film da vedere.md'), '# Film da vedere\n' + nested[1]);
  }
  if (name === 'bytes-create') fs.writeFileSync(path.join(root, 'to sort/Film da guardare.md'), '\uFEFF---\r\ntitle: Film da guardare\r\n---\r\n# Film da guardare\r\n## Sezione\r\n- [[Film/Dune|Dune]] #cinema\r\n- [[Viaggi/東京|Tokyo]] – Caffè\r\n');
  if (name === 'bytes-merge') {
    fs.writeFileSync(path.join(root, 'to sort/Film da guardare.md'), '---\r\ntitle: Film da vedere\r\n---\r\n# Film da vedere\r\n- [[Film/Dune|Dune]] #cinema\r\n');
    fs.writeFileSync(path.join(root, 'liste/Film da vedere.md'), '---\r\ntitle: Film da vedere\r\nowner: sintetico\r\n---\r\n# Film da vedere\r\n- Alien\r\n');
  }
}
fs.writeFileSync(path.join(stage, 'control/ts3-cases.json'), JSON.stringify(cases));
