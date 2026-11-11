'use strict';
// Strumento da riga di comando per controllare la memoria senza avviare la chat.
//   node cli.js stato
//   node cli.js cerca "rouche capelli"      (stesso retrieval per sezioni della chat; supporta anche tag:nome e cartella:corsi)
//   node cli.js sezioni scadenze/parziali.md "Stato del ripasso"   (solo una sezione di una nota)
//   node cli.js leggi scadenze/parziali.md
//   node cli.js elenca [cartella]
//   node cli.js ricostruisci                (cancella l'indice e lo rifa dal vault)
const memoria = require('./memoria');

const [comando = 'stato', ...resto] = process.argv.slice(2);
const arg = resto.join(' ');
const stampa = x => console.log(JSON.stringify(x, null, 2));

try {
  const s = memoria.avvia();
  if (comando === 'stato') stampa(s);
  else if (!s.ok) { console.error('Errore: ' + s.errore); process.exitCode = 1; }
  else if (comando === 'cerca') stampa(memoria.cercaNote(arg, { limite: 10 }));
  else if (comando === 'sezioni') stampa(memoria.leggiSezioni(resto[0], { sezione: resto.slice(1).join(' ') || null }));
  else if (comando === 'leggi') stampa(memoria.leggiNota(arg));
  else if (comando === 'elenca') stampa(memoria.elencaNote({ cartella: arg || null }));
  else if (comando === 'contesto') { const c = memoria.contestoPerDomanda(arg); console.log(c.testo); stampa(c.fonti); }
  else if (comando === 'ricostruisci') stampa(memoria.ricostruisci());
  else { console.error('Comando sconosciuto: ' + comando); process.exitCode = 1; }
} catch (e) {
  console.error('Errore: ' + e.message);
  process.exitCode = 1;
}
