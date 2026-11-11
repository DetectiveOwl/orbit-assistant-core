'use strict';
// Scrittura controllata nel vault Obsidian. Il modulo `memoria` resta di SOLA LETTURA: tutte le scritture passano da qui,
// e da qui si arriva solo tramite l'Integration Manager (abilitazione, permessi, conferme, audit).
//
// Garanzie (verificate dai test):
//  - il percorso resta dentro il vault anche dopo la risoluzione di link e junction (realpath dell'antenato esistente);
//  - mai dentro cartelle che iniziano con il punto (.obsidian, .trash, .git, .orbit-hud...), mai fuori da note .md;
//  - creare non sovrascrive mai (creazione esclusiva); ampliare aggiunge soltanto e verifica che l'originale sia intatto;
//  - prima di toccare una nota esistente se ne fa una copia in %LOCALAPPDATA%\Orbit\backup (fuori dal vault, quindi fuori da Obsidian Sync);
//  - eliminare non cancella: sposta nel cestino di Orbit (recuperabile);
//  - niente segreti nel vault: chiavi, token e password nel testo bloccano l'operazione;
//  - se la nota cambia mentre la si sta elaborando (per esempio la stai scrivendo in Obsidian) l'operazione si ferma.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_NOTA = 200 * 1024, MAX_INSERITO = 60 * 1024, MAX_NOTA_ESISTENTE = 2 * 1024 * 1024;
const IS_WIN = process.platform === 'win32';
const confronta = s => (IS_WIN ? s.toLowerCase() : s);

class ErroreNota extends Error { constructor(codice, msg) { super(msg); this.name = 'ErroreNota'; this.codice = codice; } }

const SEGRETI = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/, 'una chiave API Anthropic'], [/\bsk-[A-Za-z0-9]{20,}/, 'una chiave API'], [/\bghp_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/, 'un token GitHub'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'una chiave AWS'], [/\bAIza[0-9A-Za-z_-]{30,}/, 'una chiave Google'], [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'un token Slack'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'una chiave privata'], [/\bbearer\s+[A-Za-z0-9._-]{20,}/i, 'un token Bearer'],
  [/\b(?:password|passwd|pwd|secret|api[_ -]?key|token|client_secret)\s*[:=]\s*["']?[^\s"']{6,}/i, 'una password o un token'],
  [/\b(?:\d[ -]?){15}\d\b/, 'un numero che sembra una carta di pagamento']
];
function cercaSegreti(testo) { for (const [re, nome] of SEGRETI) if (re.test(testo)) return nome; return null; }

// Nucleo di una riga per riconoscere lo STESSO fatto: senza punto elenco, senza il marcatore di provenienza di Orbit in coda,
// senza accenti, maiuscole e punteggiatura. Solo l'uguaglianza esatta del nucleo conta come doppione: fatti simili ma diversi restano.
const MARCATORE_ORBIT = /\s*\((?:Orbit|imparato da Orbit)\b[^()]*\)\s*$/i;
function nucleoRiga(r) {
  return String(r).replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '').replace(MARCATORE_ORBIT, '')
    .normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function ripulisciNome(s) { return s.replace(/[<>:"|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, ''); }
const RISERVATI = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

// Normalizza un percorso relativo al vault ("corsi/Fisica/matrice") in segmenti sicuri; aggiunge .md.
function segmentiNota(rel) {
  if (typeof rel !== 'string' || !rel.trim() || rel.length > 240 || rel.includes('\u0000')) throw new ErroreNota('PERCORSO', 'Percorso della nota non valido.');
  if (/^(\\\\|\/\/)/.test(rel.trim())) throw new ErroreNota('PERCORSO', 'I percorsi di rete non sono consentiti.');
  let r = rel.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (/^[a-z]:/i.test(r) || r.startsWith('//')) throw new ErroreNota('PERCORSO', 'Serve un percorso relativo al vault.');
  const seg = r.split('/').filter(s => s !== '');
  if (!seg.length || seg.length > 7) throw new ErroreNota('PERCORSO', 'Percorso troppo profondo o vuoto.');
  if (seg.some(s => s === '..' || s === '.')) throw new ErroreNota('TRAVERSAL', 'I percorsi con ".." non sono consentiti.');
  const out = seg.map((s, i) => {
    if (s.startsWith('.')) throw new ErroreNota('CARTELLA_PROTETTA', 'Le cartelle e i file che iniziano con il punto (.obsidian, .trash...) non si toccano.');
    if (/[<>:"|?*\u0000-\u001f]/.test(s)) throw new ErroreNota('PERCORSO', 'Il nome contiene caratteri non consentiti: ' + s);
    const p = ripulisciNome(s);
    if (!p || p.length > 100 || RISERVATI.test(p)) throw new ErroreNota('PERCORSO', 'Nome non valido: ' + s);
    return i === seg.length - 1 && !/\.md$/i.test(p) ? p + '.md' : p;
  });
  if (/\.md$/i.test(out[out.length - 1]) === false) throw new ErroreNota('PERCORSO', 'Solo note .md.');
  if (out.slice(0, -1).some(s => /\.md$/i.test(s))) throw new ErroreNota('PERCORSO', 'Una cartella non puo chiamarsi come una nota.');
  return out;
}

function dentro(figlio, padre) { const f = confronta(path.resolve(figlio)), p = confronta(path.resolve(padre)); return f === p || f.startsWith(p.endsWith(path.sep) ? p : p + path.sep); }

class Vault {
  constructor({ vaultPath, datiDir, orologio = () => new Date() }) {
    if (!vaultPath || !datiDir) throw new Error('Vault o cartella dati mancanti.');
    this.vault = fs.realpathSync.native(path.resolve(vaultPath));
    this.datiDir = path.resolve(datiDir);
    if (dentro(this.datiDir, this.vault)) throw new Error('La cartella dei dati di Orbit non puo stare dentro il vault.');
    this.backupDir = path.join(this.datiDir, 'backup'); this.cestinoDir = path.join(this.datiDir, 'cestino');
    this.ora = orologio;
  }

  // Risolve il percorso senza seguire collegamenti fuori dal vault. Per i file che non esistono ancora controlla l'antenato esistente piu vicino.
  risolvi(rel, { esiste }) {
    const seg = segmentiNota(rel);
    const abs = path.join(this.vault, ...seg);
    if (!dentro(abs, this.vault)) throw new ErroreNota('FUORI_DAL_VAULT', 'Percorso fuori dal vault.');
    let probe = abs;
    while (!fs.existsSync(probe)) { const su = path.dirname(probe); if (su === probe) throw new ErroreNota('FUORI_DAL_VAULT', 'Percorso non valido.'); probe = su; }
    const reale = fs.realpathSync.native(probe);
    if (!dentro(reale, this.vault)) throw new ErroreNota('FUORI_DAL_VAULT', 'Il percorso esce dal vault tramite un collegamento.');
    const relOut = seg.join('/');
    if (esiste === true && !fs.existsSync(abs)) throw new ErroreNota('NON_TROVATA', 'Nota non trovata: ' + relOut);
    if (esiste === true && !fs.statSync(abs).isFile()) throw new ErroreNota('NON_UNA_NOTA', 'Non e una nota: ' + relOut);
    if (esiste === false && fs.existsSync(abs)) throw new ErroreNota('ESISTE_GIA', 'Esiste gia una nota con questo nome: ' + relOut + ' (non la sovrascrivo).');
    return { abs, rel: relOut };
  }

  // Percorso canonico effettivo: realpath dell'antenato piu vicino che esiste (anche un collegamento, e solo se risolvibile) piu i componenti
  // ancora da creare. Restituisce null se non si puo verificare con sicurezza.
  canonico(abs) {
    let probe = abs; const resto = [];
    for (;;) {
      try { fs.lstatSync(probe); break; } catch (e) { if (e.code !== 'ENOENT') return null; }
      const su = path.dirname(probe); if (su === probe) return null;
      resto.unshift(path.basename(probe)); probe = su;
    }
    try { return path.join(fs.realpathSync.native(probe), ...resto); } catch (e) { return null; }
  }
  // Il percorso di destinazione cade DAVVERO dentro la cartella "area" (segmenti relativi al vault), anche passando da junction e symlink.
  dentroAreaReale(rel, areaSegmenti) {
    try {
      const c = this.canonico(path.join(this.vault, ...segmentiNota(rel))), a = this.canonico(path.join(this.vault, ...areaSegmenti));
      // l'area stessa non deve essere un collegamento: il suo percorso reale deve coincidere con quello dichiarato
      return !!c && !!a && confronta(a) === confronta(path.join(fs.realpathSync.native(this.vault), ...areaSegmenti)) && confronta(c) !== confronta(a) && dentro(c, a);
    } catch (e) { return false; }
  }

  _marca() { return this.ora().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-'); }
  _backup(abs, rel) {
    fs.mkdirSync(this.backupDir, { recursive: true });
    const nome = this._marca() + '_' + crypto.randomBytes(3).toString('hex') + '_' + rel.replace(/[\\/]/g, '__');
    const dest = path.join(this.backupDir, nome);
    fs.copyFileSync(abs, dest, fs.constants.COPYFILE_EXCL);
    return dest;
  }

  // ---------- creare ----------
  crea({ percorso, contenuto, tag = [], titolo }) {
    const { abs, rel } = this.risolvi(percorso, { esiste: false });
    if (typeof contenuto !== 'string' || !contenuto.trim()) throw new ErroreNota('VUOTA', 'La nota e vuota.');
    if (contenuto.length > MAX_NOTA) throw new ErroreNota('TROPPO_GRANDE', 'La nota supera i ' + (MAX_NOTA / 1024) + ' KB.');
    const segreto = cercaSegreti(contenuto); if (segreto) throw new ErroreNota('SEGRETO', 'Il testo contiene ' + segreto + ': nel vault non devono finire segreti.');
    let corpo = contenuto.replace(/\r\n?/g, '\n').trimEnd() + '\n';
    if (!/^---\n[\s\S]*?\n---\n/.test(corpo)) {
      const tags = [...new Set((tag || []).map(t => String(t).replace(/^#/, '').toLowerCase().replace(/[^a-z0-9_\/à-öø-ÿ-]/g, '')).filter(Boolean))].slice(0, 12);
      const fm = ['---'];
      if (tags.length) fm.push('tags: [' + tags.join(', ') + ']');
      fm.push('creata: ' + this.ora().toISOString().slice(0, 10), 'origine: Orbit', '---', '');
      corpo = fm.join('\n') + '\n' + corpo;
    }
    const cartelle = path.dirname(abs);
    const nuove = []; for (let p = cartelle; !fs.existsSync(p); p = path.dirname(p)) nuove.push(p);
    fs.mkdirSync(cartelle, { recursive: true });
    try { fs.writeFileSync(abs, corpo, { flag: 'wx', encoding: 'utf8' }); }
    catch (e) { for (const d of nuove) { try { fs.rmdirSync(d); } catch (x) { /* non vuota */ } } throw new ErroreNota('SCRITTURA', 'Scrittura non riuscita: ' + e.code); }
    const letta = fs.readFileSync(abs, 'utf8');
    if (letta !== corpo) throw new ErroreNota('VERIFICA', 'La nota scritta non coincide con quella prevista.');
    return { percorso: rel, caratteri: corpo.length, nuovaCartella: nuove.length > 0, linkNonRisolti: [] };
  }

  // ---------- ampliare (solo aggiunte) ----------
  // seNonPresente: se OGNI riga da aggiungere c'e gia nella nota (stesso nucleo), non scrive nulla e restituisce giaPresente.
  // Il controllo e la scrittura avvengono nella stessa funzione sincrona: due richieste dello stesso processo non possono
  // aggiungere entrambe lo stesso fatto; una modifica esterna nel frattempo ferma l'operazione (controllo CAMBIATA qui sotto).
  amplia({ percorso, testo, sezione, collegamenti = [], seNonPresente = false }) {
    const { abs, rel } = this.risolvi(percorso, { esiste: true });
    const st = fs.statSync(abs);
    if (st.size > MAX_NOTA_ESISTENTE) throw new ErroreNota('TROPPO_GRANDE', 'La nota e troppo grande per essere ampliata (oltre 2 MB).');
    const originale = fs.readFileSync(abs, 'utf8');
    if (seNonPresente && (testo || '').trim() && !(collegamenti || []).length) {
      const presenti = new Set(originale.split(/\r?\n/).map(nucleoRiga).filter(Boolean));
      const nuove = (testo || '').split(/\r?\n/).map(nucleoRiga).filter(Boolean);
      if (nuove.length && nuove.every(n => presenti.has(n))) return { percorso: rel, aggiunti: 0, giaPresente: true, collegamentiAggiunti: [] };
    }
    const crlf = /\r\n/.test(originale);
    const lf = s => s.replace(/\r\n?/g, '\n');
    const nuoviLink = [...new Set((collegamenti || []).map(l => String(l).trim().replace(/^\[\[|\]\]$/g, '').trim()).filter(Boolean))]
      .filter(l => l.length <= 200 && !/[\[\]|\n\r^\\]/.test(l)).filter(l => !originale.includes('[[' + l));
    const daAggiungere = (testo || '').trim();
    if (!daAggiungere && !nuoviLink.length) throw new ErroreNota('VUOTA', 'Non c\'e nulla da aggiungere' + ((collegamenti || []).length ? ' (i collegamenti indicati ci sono gia).' : '.'));
    if (daAggiungere.length > MAX_INSERITO) throw new ErroreNota('TROPPO_GRANDE', 'Il testo da aggiungere supera i ' + (MAX_INSERITO / 1024) + ' KB.');
    const segreto = cercaSegreti(daAggiungere + '\n' + nuoviLink.join('\n')); if (segreto) throw new ErroreNota('SEGRETO', 'Il testo contiene ' + segreto + ': nel vault non devono finire segreti.');

    let testoNuovo = lf(originale);
    const inserimenti = [];
    const inserisci = (indice, s) => { testoNuovo = testoNuovo.slice(0, indice) + s + testoNuovo.slice(indice); inserimenti.push([indice, s.length]); };
    const fineSezione = titolo => {   // indice di inserimento alla fine della sezione `titolo` (prima della prossima intestazione di pari o maggior livello), oppure -1
      const righe = testoNuovo.split('\n'); let pos = 0, inizio = -1, livello = 0;
      for (let i = 0; i < righe.length; i++) {
        const m = righe[i].match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
        if (inizio < 0 && m && m[2].trim().toLowerCase() === titolo.trim().toLowerCase()) { inizio = i; livello = m[1].length; }
        else if (inizio >= 0 && m && m[1].length <= livello) { return pos; }
        pos += righe[i].length + 1;
      }
      return inizio >= 0 ? testoNuovo.length : -1;
    };
    const aggiungiInSezione = (titolo, blocco) => {
      let idx = fineSezione(titolo);
      if (idx < 0) { const base = testoNuovo.endsWith('\n') ? '' : '\n'; inserisci(testoNuovo.length, base + '\n## ' + titolo.trim() + '\n\n' + lf(blocco).trimEnd() + '\n'); return; }
      const prima = testoNuovo.slice(0, idx);
      // l'inserimento va prima delle righe vuote finali della sezione, cosi la spaziatura dell'originale resta com'e
      const code = prima.match(/\n*$/)[0].length; const punto = idx - code;
      // in coda a un elenco puntato si continua l'elenco (a capo semplice), altrimenti si lascia una riga vuota
      const ultimaRiga = prima.slice(0, punto).split('\n').pop();
      const elenco = /^\s*[-*+] /.test(ultimaRiga) && /^\s*[-*+] /.test(lf(blocco));
      inserisci(punto, (elenco ? '\n' : '\n\n') + lf(blocco).trimEnd());
    };
    if (daAggiungere) {
      if (sezione && sezione.trim()) aggiungiInSezione(sezione, daAggiungere);
      else inserisci(testoNuovo.length, (testoNuovo.endsWith('\n') ? '\n' : '\n\n') + lf(daAggiungere) + '\n');
    }
    if (nuoviLink.length) aggiungiInSezione('Collegamenti', nuoviLink.map(l => '- [[' + l + ']]').join('\n'));

    // Verifica: togliendo gli inserimenti (dall'ultimo al primo) si deve riavere ESATTAMENTE l'originale.
    let prova = testoNuovo;
    for (const [i, n] of inserimenti.slice().reverse()) prova = prova.slice(0, i) + prova.slice(i + n);
    if (prova !== lf(originale)) throw new ErroreNota('VERIFICA', 'L\'aggiunta avrebbe alterato il testo esistente: operazione annullata.');
    const finale = crlf ? testoNuovo.replace(/\n/g, '\r\n') : testoNuovo;

    const backup = this._backup(abs, rel);
    const ora = fs.readFileSync(abs, 'utf8');
    if (ora !== originale) throw new ErroreNota('CAMBIATA', 'La nota e cambiata mentre la elaboravo (la stai modificando?): non scrivo nulla.');
    try {
      fs.writeFileSync(abs, finale, 'utf8');
      if (fs.readFileSync(abs, 'utf8') !== finale) throw new Error('verifica fallita');
    } catch (e) {
      try { fs.copyFileSync(backup, abs); } catch (x) { /* il backup resta comunque */ }
      throw new ErroreNota('SCRITTURA', 'Scrittura non riuscita, nota ripristinata dal backup.');
    }
    return { percorso: rel, aggiunti: finale.length - originale.length, backup, collegamentiAggiunti: nuoviLink };
  }

  // ---------- riscrivere per intero (sempre con conferma) ----------
  riscrivi({ percorso, contenuto }) {
    const { abs, rel } = this.risolvi(percorso, { esiste: true });
    if (typeof contenuto !== 'string' || !contenuto.trim() || contenuto.length > MAX_NOTA) throw new ErroreNota('VUOTA', 'Contenuto non valido.');
    const segreto = cercaSegreti(contenuto); if (segreto) throw new ErroreNota('SEGRETO', 'Il testo contiene ' + segreto + ': nel vault non devono finire segreti.');
    const backup = this._backup(abs, rel);
    const nuovo = contenuto.replace(/\r\n?/g, '\n').trimEnd() + '\n';
    try { fs.writeFileSync(abs, nuovo, 'utf8'); if (fs.readFileSync(abs, 'utf8') !== nuovo) throw new Error('verifica fallita'); }
    catch (e) { try { fs.copyFileSync(backup, abs); } catch (x) { /* resta il backup */ } throw new ErroreNota('SCRITTURA', 'Scrittura non riuscita, nota ripristinata dal backup.'); }
    return { percorso: rel, backup };
  }

  // ---------- eliminare = spostare nel cestino di Orbit (sempre con conferma) ----------
  elimina({ percorso }) {
    const { abs, rel } = this.risolvi(percorso, { esiste: true });
    fs.mkdirSync(this.cestinoDir, { recursive: true });
    const dest = path.join(this.cestinoDir, this._marca() + '_' + crypto.randomBytes(3).toString('hex') + '_' + rel.replace(/[\\/]/g, '__'));
    fs.copyFileSync(abs, dest, fs.constants.COPYFILE_EXCL);
    fs.unlinkSync(abs);
    return { percorso: rel, cestino: dest };
  }
}

module.exports = { Vault, ErroreNota, cercaSegreti, segmentiNota, nucleoRiga };

