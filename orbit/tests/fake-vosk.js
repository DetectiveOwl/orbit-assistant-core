'use strict';
// Falso processo Vosk per i test (stesso protocollo di voice/vosk_parola.py): un pacchetto audio il cui primo campione vale 12345
// simula la parola "Orbit"; la fine della parola e la posizione del pacchetto nel flusso piu 0,4 s.
const parole = JSON.parse(process.argv[3] || '[]');
process.stdout.write(JSON.stringify({ pronto: true, parole }) + '\n');
let buf = Buffer.alloc(0), campioni = 0;
process.stdin.on('data', d => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 5) {
    const tipo = buf.toString('ascii', 0, 1), n = buf.readUInt32LE(1);
    if (buf.length < 5 + n) break;
    const dati = buf.subarray(5, 5 + n); buf = buf.subarray(5 + n);
    if (tipo === 'R') { campioni = 0; process.stdout.write('{"azzerato":true}\n'); continue; }
    const attiva = n >= 2 && dati.readInt16LE(0) === 12345;
    const inizio = campioni / 16000; campioni += n / 2;
    if (process.env.FAKE_VOSK_RITARDO_MS && dati.readInt16LE(0) === 1111) { setTimeout(() => process.stdout.write(JSON.stringify({ attivata: false, campioni }) + '\n'), Number(process.env.FAKE_VOSK_RITARDO_MS)); continue; }
    process.stdout.write(JSON.stringify(attiva ? { attivata: true, fine: +(inizio + 0.4).toFixed(3), campioni } : { attivata: false, campioni }) + '\n');
  }
});
process.stdin.on('end', () => process.exit(0));
