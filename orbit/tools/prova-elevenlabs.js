'use strict';
// Strumento manuale per ElevenLabs. La chiave si legge come in Orbit (ELEVENLABS_API_KEY nell'ambiente o nei file .env) e non viene mai stampata.
//   node orbit/tools/prova-elevenlabs.js --voci                      elenca le voci (nessun credito)
//   node orbit/tools/prova-elevenlabs.js --quota                     crediti del mese (nessun credito)
//   node orbit/tools/prova-elevenlabs.js --misura --conferma [--voce ID] [--modelli a,b]   UNA frase breve per modello, stampa la latenza.
//                                                                    CONSUMA CREDITI (circa 60 caratteri per modello): serve --conferma.
const fs = require('fs');
const path = require('path');
const os = require('os');
const profilo = require('../../memoria/profilo');
const { ElevenLabsTTS } = require('../voice/elevenlabs');

const arg = n => { const i = process.argv.indexOf(n); return i >= 0 ? (process.argv[i + 1] || '') : null; };
const ha = n => process.argv.includes(n);
const chiave = () => profilo.valore('ELEVENLABS_API_KEY');

async function main() {
  if (!chiave()) { console.error('Manca ELEVENLABS_API_KEY (vedi docs/ELEVENLABS.md).'); process.exit(1); }
  const intest = { 'xi-api-key': chiave() };
  if (ha('--voci')) {
    const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: intest });
    if (!r.ok) { console.error('Errore ' + r.status); process.exit(1); }
    for (const v of (await r.json()).voices) console.log(v.voice_id + '  ' + v.name + '  [' + (v.category || '') + '] ' + Object.values(v.labels || {}).join(', '));
  } else if (ha('--quota')) {
    const e = new ElevenLabsTTS({ chiave, voceId: 'x' }); const q = await e.aggiornaQuota(true);
    console.log(q ? q.usati + ' / ' + q.limite + ' caratteri usati questo mese' : 'Quota non leggibile.');
  } else if (ha('--misura')) {
    if (!ha('--conferma')) { console.error('Questa prova consuma crediti: aggiungi --conferma.'); process.exit(1); }
    const voce = arg('--voce') || profilo.valore('ORBIT_TTS_VOCE_ID');
    if (!voce) { console.error('Indica la voce con --voce ID (elenco: --voci).'); process.exit(1); }
    const frase = 'Ciao, sono Orbit. Oggi hai due ore di studio.';
    for (const modello of (arg('--modelli') || 'eleven_multilingual_v2,eleven_flash_v2_5,eleven_v3').split(',')) {
      const e = new ElevenLabsTTS({ chiave, voceId: voce, modello: modello.trim() });
      const t0 = Date.now();
      try {
        const mp3 = await e.sintetizza(frase);
        const file = path.join(os.tmpdir(), 'orbit-prova-' + modello.trim() + '.mp3'); fs.writeFileSync(file, mp3);   // ascolto manuale; cancellalo dopo
        console.log(modello + ': ' + (Date.now() - t0) + ' ms, ' + frase.length + ' caratteri, ' + mp3.length + ' byte -> ' + file);
      } catch (err) { console.log(modello + ': non riuscito (' + err.message + ')'); }
    }
  } else console.log('Uso: --voci | --quota | --misura --conferma');
}
main().catch(e => { console.error(e.message); process.exit(1); });
