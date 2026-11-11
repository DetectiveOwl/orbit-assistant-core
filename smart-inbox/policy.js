'use strict';
const crypto = require('node:crypto');

const VERSIONE = 'smart-inbox/1';
const chiave = s => String(s).normalize('NFC').toLowerCase();
const tecniche = new Set(['scadenze', 'orbit', 'memoria', 'smart-inbox', 'skills', 'skill', 'config',
  'configurazioni', 'node_modules', 'sandbox', 'risultati', 'outputs', 'src', 'bin', 'dist', 'build', 'public', 'tests',
  'privato', 'profili', 'configuration', 'configurations', 'settings', 'logs', 'indici', 'database', 'backups', 'tts', 'stt']);

function errore(code) { return Object.assign(new Error(code), { code }); }
function relativo(value) {
  if (typeof value !== 'string' || !value || /^[\\/]/.test(value) || /[\x00-\x1f\x7f:<>"|?*]/.test(value)
    || /%[0-9a-f]{2}/i.test(value)) throw errore('PERCORSO_NON_SICURO');
  const parts = value.replace(/\\/g, '/').split('/');
  for (const p of parts) {
    if (!p || p === '.' || p === '..' || /^[ .]|[ .]$/.test(p)
      || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p)) throw errore('PERCORSO_NON_SICURO');
  }
  return parts.join('/');
}
function protetto(value) {
  let p;
  try { p = relativo(value); } catch { return 'PERCORSO_NON_SICURO'; }
  const parts = chiave(p).split('/');
  if (parts.some(x => x.startsWith('.') || tecniche.has(x)) || /(?:^|\/)progetti\/orbit(?:\/|$)/i.test(p)
    || /(?:^|\/)(?:credentials|client_secret[^/]*|token[^/]*|secrets?)(?:\.|$)/i.test(p)
    || /\.(?:sqlite(?:-wal|-shm)?|db|pem|key|pfx|js|cjs|mjs|py|exe|bat|cmd|ps1|json|ya?ml|env)$/i.test(p)) return 'DESTINAZIONE_PROTETTA';
  return null;
}
function sotto(p, root) { return chiave(p) === chiave(root) || chiave(p).startsWith(chiave(root) + '/'); }
function destinazione(p, snapshot, nuova = false) {
  if (protetto(p) || !/\.md$/i.test(p) || sotto(p, 'to sort')) return false;
  if (!snapshot.autorizzati.some(a => sotto(p, a))) return false;
  const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  return !nuova || snapshot.creaIn.includes(dir) && (snapshot.cartelle.some(d => d.percorso === dir) || cartellaDaCreare(dir, snapshot));
}
// create_dir: solo una cartella di creaIn assente il cui genitore esiste gia nello snapshot (un livello, mai un percorso inventato).
function cartellaDaCreare(dir, snapshot) {
  // Confronto senza maiuscole (NTFS): 'liste/Nuova' esiste gia se c'e 'liste/nuova'.
  return dir.includes('/') && snapshot.creaIn.includes(dir) && !snapshot.cartelle.some(d => chiave(d.percorso) === chiave(dir))
    && snapshot.cartelle.some(d => d.percorso === dir.slice(0, dir.lastIndexOf('/')));
}
function canonico(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonico).join(',') + ']';
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw errore('DATI_NON_JSON');
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonico(value[k])).join(',') + '}';
}
function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function impronta(value) { return sha(canonico(value)); }
function congela(value) {
  if (value && typeof value === 'object' && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)) {
    for (const v of Object.values(value)) congela(v); Object.freeze(value);
  }
  return value;
}

// Note lette ma con parsing parziale: restano nel catalogo per confronto, ma non sono bersagli sicuri di append.
const PARSING_LIMITATO = ['YAML_PARZIALMENTE_SUPPORTATO', 'MARKDOWN_PARZIALMENTE_SUPPORTATO'];
// Problemi di scansione che NON rendono inaffidabile il catalogo: nota con parsing parziale (solo non bersaglio sicuro), cartella di creazione assente,
// area riservata di Orbit (progetti/Orbit): mai note da organizzare ne duplicati rilevanti. Le cartelle nascoste (componente con '.') sono PERCORSO_NON_SICURO e restano bloccanti.
// Le altre cartelle protette per nome tecnico (database, public, src...) o i .md protetti per nome (token, secret...) possono contenere note vere: restano bloccanti.
const NON_BLOCCANTI = [...PARSING_LIMITATO, 'CARTELLA_CREAZIONE_ASSENTE'];
const esclusoPerPolicy = percorso => /^progetti\/orbit(?:\/|$)/i.test(percorso);   // solo l'area riservata alla radice del vault
function bloccante(p, creaIn = []) {
  if (NON_BLOCCANTI.includes(p.code) || (p.code === 'ENOENT' && creaIn.includes(p.percorso))) return false;
  return !(p.code === 'DESTINAZIONE_PROTETTA' && !sotto(p.percorso, 'to sort') && esclusoPerPolicy(p.percorso));
}
module.exports = { bloccante, cartellaDaCreare, PARSING_LIMITATO, VERSIONE, chiave, relativo, protetto, sotto, destinazione, canonico, sha, impronta, congela, errore };
