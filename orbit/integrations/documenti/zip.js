'use strict';
// Lettore minimo di archivi ZIP (serve per i DOCX), senza dipendenze, con protezioni contro gli zip bomb:
// limite al numero di voci, alla dimensione decompressa e al rapporto di compressione. Solo lettura, nessuna estrazione su disco.
const zlib = require('zlib');

const MAX_VOCI = 3000;
const MAX_DECOMPRESSO = 30 * 1024 * 1024;
const MAX_RAPPORTO = 300;

class ErroreZip extends Error { constructor(msg) { super(msg); this.name = 'ErroreZip'; } }

function leggiVoci(buf) {
  // Fine della directory centrale (EOCD): ultimi 22 byte + commento fino a 65535.
  let fine = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) { if (buf.readUInt32LE(i) === 0x06054b50) { fine = i; break; } }
  if (fine < 0) throw new ErroreZip('Non e un archivio ZIP valido.');
  const n = buf.readUInt16LE(fine + 10), dimDir = buf.readUInt32LE(fine + 12), offDir = buf.readUInt32LE(fine + 16);
  if (n > MAX_VOCI) throw new ErroreZip('Archivio con troppe voci.');
  if (offDir + dimDir > buf.length) throw new ErroreZip('Archivio danneggiato.');
  const voci = new Map();
  let p = offDir;
  for (let i = 0; i < n; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ErroreZip('Archivio danneggiato.');
    const metodo = buf.readUInt16LE(p + 10), dimComp = buf.readUInt32LE(p + 20), dimOrig = buf.readUInt32LE(p + 24);
    const lNome = buf.readUInt16LE(p + 28), lExtra = buf.readUInt16LE(p + 30), lComm = buf.readUInt16LE(p + 32), offLocale = buf.readUInt32LE(p + 42);
    const nome = buf.slice(p + 46, p + 46 + lNome).toString('utf8');
    voci.set(nome, { metodo, dimComp, dimOrig, offLocale });
    p += 46 + lNome + lExtra + lComm;
  }
  return voci;
}

// Restituisce il contenuto (Buffer) di una voce, oppure null se manca.
function leggiVoce(buf, voci, nome) {
  const v = voci.get(nome);
  if (!v) return null;
  if (v.dimOrig > MAX_DECOMPRESSO) throw new ErroreZip('Voce troppo grande.');
  if (v.dimComp > 0 && v.dimOrig / v.dimComp > MAX_RAPPORTO) throw new ErroreZip('Rapporto di compressione sospetto.');
  if (v.offLocale + 30 > buf.length || buf.readUInt32LE(v.offLocale) !== 0x04034b50) throw new ErroreZip('Archivio danneggiato.');
  const lNome = buf.readUInt16LE(v.offLocale + 26), lExtra = buf.readUInt16LE(v.offLocale + 28);
  const inizio = v.offLocale + 30 + lNome + lExtra;
  const dati = buf.slice(inizio, inizio + v.dimComp);
  if (v.metodo === 0) return dati;
  if (v.metodo !== 8) throw new ErroreZip('Metodo di compressione non supportato.');
  try { return zlib.inflateRawSync(dati, { maxOutputLength: MAX_DECOMPRESSO }); } catch (e) { throw new ErroreZip('Voce danneggiata.'); }
}

module.exports = { leggiVoci, leggiVoce, ErroreZip };
