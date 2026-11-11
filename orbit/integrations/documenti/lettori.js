'use strict';
// Lettori di formato per i documenti locali. Sola lettura: nessun file viene scritto o modificato.
// Il contenuto restituito e un DATO non attendibile (puo contenere istruzioni ostili): chi lo usa non lo esegue mai come comando.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { leggiVoci, leggiVoce, ErroreZip } = require('./zip');

const MAX_BYTE_TESTO = 25 * 1024 * 1024;
const MAX_BYTE_DOCX = 25 * 1024 * 1024;
const MAX_CARATTERI = 200000;
const TIMEOUT_PDF_MS = 20000;
const FORMATI_TESTO = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.yaml', '.yml']);

class ErroreLettura extends Error { constructor(codice, msg) { super(msg); this.name = 'ErroreLettura'; this.codice = codice; } }

function trovaPdftotext() {
  const candidati = [process.env.ORBIT_PDFTOTEXT, 'C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe', 'pdftotext'].filter(Boolean);
  const winget = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
  try {
    if (winget && fs.existsSync(winget)) {
      for (const d of fs.readdirSync(winget)) {
        if (!/poppler/i.test(d)) continue;
        const stack = [path.join(winget, d)];
        for (let n = 0; stack.length && n < 200; n++) {
          const cur = stack.pop();
          let voci; try { voci = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
          for (const v of voci) { if (v.isFile() && v.name.toLowerCase() === 'pdftotext.exe') candidati.unshift(path.join(cur, v.name)); else if (v.isDirectory()) stack.push(path.join(cur, v.name)); }
        }
      }
    }
  } catch (e) { /* ricerca facoltativa */ }
  return candidati.filter(c => c === 'pdftotext' || fs.existsSync(c));
}

function tagliaTesto(t, max = MAX_CARATTERI) {
  t = String(t).replace(/\u0000/g, '').replace(/\r\n?/g, '\n');
  return t.length > max ? { testo: t.slice(0, max), troncato: true, totale: t.length } : { testo: t, troncato: false, totale: t.length };
}

function leggiTesto(file, stat) {
  if (stat.size > MAX_BYTE_TESTO) throw new ErroreLettura('FILE_TROPPO_GRANDE', 'Il file supera i 25 MB.');
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 4096).includes(0)) throw new ErroreLettura('NON_TESTO', 'Il file sembra binario, non testo.');
  let s = buf.toString('utf8');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  return tagliaTesto(s);
}

function entita(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Math.min(+n, 0x10FFFF))).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10FFFF))).replace(/&amp;/g, '&');
}

function leggiDocx(file, stat) {
  if (stat.size > MAX_BYTE_DOCX) throw new ErroreLettura('FILE_TROPPO_GRANDE', 'Il file supera i 25 MB.');
  const buf = fs.readFileSync(file);
  let xml;
  try {
    const voci = leggiVoci(buf);
    const doc = leggiVoce(buf, voci, 'word/document.xml');
    if (!doc) throw new ErroreLettura('FORMATO_NON_VALIDO', 'Non e un documento Word valido.');
    xml = doc.toString('utf8');
  } catch (e) {
    if (e instanceof ErroreLettura) throw e;
    if (e instanceof ErroreZip) throw new ErroreLettura('FILE_DANNEGGIATO', 'Documento Word non leggibile: ' + e.message);
    throw e;
  }
  const t = xml.replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<w:t[^>]*>([^<]*)<\/w:t>/g, (m, x) => '\u0001' + x + '\u0002')
    .replace(/<[^>]+>/g, '').replace(/[^\u0001\u0002\n\t]*(?=\u0001)/g, '').replace(/[\u0001\u0002]/g, '');
  return tagliaTesto(entita(t).replace(/\n{3,}/g, '\n\n').trim());
}

function eseguiPdftotext(bin, args, signal) {
  return new Promise((resolve, reject) => {
    const proc = execFile(bin, args, { timeout: TIMEOUT_PDF_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, out) => {
      if (err) return reject(err);
      resolve(out);
    });
    if (signal) { const stop = () => { try { proc.kill(); } catch (e) { /* gia chiuso */ } }; if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true }); }
  });
}

// OCR locale (Tesseract + pdftoppm, entrambi offline): solo per le pagine senza testo selezionabile, al massimo 5 per volta.
// Le immagini temporanee stanno in una cartella temporanea nuova e vengono cancellate subito dopo; nulla esce dal PC.
const MAX_PAGINE_OCR = 5, TIMEOUT_OCR_MS = 120000;
function trovaTesseract() {
  const c = [process.env.ORBIT_TESSERACT, 'C:\\Program Files\\Tesseract-OCR\\tesseract.exe', 'tesseract'].filter(Boolean);
  const dati = process.env.ORBIT_TESSDATA || path.join(process.env.LOCALAPPDATA || '', 'Orbit', 'tessdata');
  const exe = c.find(x => x === 'tesseract' || fs.existsSync(x));
  return exe && fs.existsSync(path.join(dati, 'ita.traineddata')) ? { exe, dati } : null;
}
function trovaPdftoppm(pdftotext) { const p = path.join(path.dirname(pdftotext), 'pdftoppm.exe'); return pdftotext !== 'pdftotext' && fs.existsSync(p) ? p : 'pdftoppm'; }
async function ocrPdf(file, da, fine, bins, signal) {
  const t = trovaTesseract();
  if (!t) throw new ErroreLettura('OCR_ASSENTE', 'Le pagine sono scansioni e l\'OCR locale (Tesseract con i dati italiani) non e installato.');
  const ultima = Math.min(fine, da + MAX_PAGINE_OCR - 1);
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'orbit-ocr-'));
  try {
    await eseguiPdftotext(trovaPdftoppm(bins[0]), ['-r', '200', '-f', String(da), '-l', String(ultima), '-png', file, path.join(tmp, 'p')], signal);
    const png = fs.readdirSync(tmp).filter(f => /\.png$/i.test(f)).sort();
    const testi = [];
    for (const f of png) testi.push(await new Promise((res, rej) => execFile(t.exe, [path.join(tmp, f), 'stdout', '-l', 'ita+eng', '--tessdata-dir', t.dati, '--psm', '3'],
      { timeout: TIMEOUT_OCR_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (e, out) => e ? rej(e) : res(out))));
    return { testo: testi.join('\n\n').trim(), pagine: da + '-' + ultima, ultima };
  } catch (e) {
    if (e instanceof ErroreLettura) throw e;
    throw new ErroreLettura('OCR_FALLITO', 'OCR non riuscito (' + (e && e.killed ? 'tempo scaduto' : 'immagine non leggibile') + ').');
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (x) { /* temporanea */ } }
}

// PDF: solo le pagine richieste (mai l'intero documento se non serve). Un PDF scansionato (senza testo) viene dichiarato tale, senza OCR.
async function leggiPdf(file, stat, { da = 1, a = null, signal } = {}) {
  if (stat.size > 100 * 1024 * 1024) throw new ErroreLettura('FILE_TROPPO_GRANDE', 'Il PDF supera i 100 MB.');
  const bins = trovaPdftotext();
  if (!bins.length) throw new ErroreLettura('LETTORE_ASSENTE', 'Per leggere i PDF serve pdftotext (Poppler), che non e installato.');
  const fine = a || da + 9;
  if (fine < da || fine - da > 29) throw new ErroreLettura('INTERVALLO', 'Si possono leggere al massimo 30 pagine per volta.');
  let out, ultimo;
  for (const bin of bins) {
    try { out = await eseguiPdftotext(bin, ['-f', String(da), '-l', String(fine), '-layout', '-enc', 'UTF-8', file, '-'], signal); break; } catch (e) { ultimo = e; }
  }
  if (out === undefined) throw new ErroreLettura('PDF_NON_LEGGIBILE', 'PDF non leggibile (' + (ultimo && ultimo.killed ? 'tempo scaduto' : 'file protetto o danneggiato') + ').');
  const pulito = out.replace(/\f/g, '\n\n').trim();
  if (!pulito.replace(/\s/g, '')) {
    const o = await ocrPdf(file, da, fine, bins, signal);
    if (!o.testo.replace(/\s/g, '')) throw new ErroreLettura('PDF_SENZA_TESTO', 'Le pagine ' + da + '-' + o.ultima + ' non contengono testo riconoscibile nemmeno con l\'OCR.');
    return Object.assign(tagliaTesto(o.testo), { pagine: o.pagine, ocr: true, avviso: 'Testo ottenuto con OCR: puo contenere errori di riconoscimento (formule, numeri, simboli).' + (o.ultima < fine ? ' Letto solo fino a pagina ' + o.ultima + ' (massimo ' + MAX_PAGINE_OCR + ' pagine per volta con OCR).' : '') });
  }
  return Object.assign(tagliaTesto(pulito), { pagine: da + '-' + fine });
}

module.exports = { leggiTesto, leggiDocx, leggiPdf, tagliaTesto, trovaPdftotext, ErroreLettura, FORMATI_TESTO, MAX_CARATTERI };
