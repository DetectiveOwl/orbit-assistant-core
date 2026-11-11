'use strict';
// Falso Piper per i test: stessa interfaccia (--json-input, --output_dir), scrive un piccolo WAV per ogni riga e stampa il percorso.
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const out = args[args.indexOf('--output_dir') + 1];
let n = 0, buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const riga = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!riga.trim()) continue;
    const { text } = JSON.parse(riga);
    if (process.env.ORBIT_FAKE_PIPER === 'muto') continue;
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.from(text)]);
    const file = path.join(out, 'f' + (++n) + '.wav');
    fs.writeFileSync(file, wav);
    process.stdout.write(file + '\n');
  }
});
