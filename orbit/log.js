'use strict';
// Log minimale su console. Non scrive mai contenuti delle conversazioni e oscura le chiavi.
const ORDINE = { error: 0, warn: 1, info: 2, debug: 3 };
let livello = 'info';

function ripulisci(v) {
  return String(v).replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***').replace(/(x-api-key["':\s=]+)[^\s"',}]+/gi, '$1***');
}
function scrivi(l, args) {
  if (ORDINE[l] > ORDINE[livello]) return;
  const testo = args.map(a => ripulisci(a instanceof Error ? a.message : (typeof a === 'string' ? a : JSON.stringify(a)))).join(' ');
  (l === 'error' || l === 'warn' ? console.error : console.log)('[' + new Date().toISOString() + '] ' + l.toUpperCase() + ' ' + testo);
}
module.exports = {
  imposta(l) { if (ORDINE[l] !== undefined) livello = l; },
  ripulisci,
  error: (...a) => scrivi('error', a), warn: (...a) => scrivi('warn', a),
  info: (...a) => scrivi('info', a), debug: (...a) => scrivi('debug', a)
};
