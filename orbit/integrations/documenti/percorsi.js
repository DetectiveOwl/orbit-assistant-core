'use strict';
// Guardia dei percorsi: l'unico punto che decide se un percorso puo essere letto. Principio del privilegio minimo:
//  - il percorso, DOPO la risoluzione di link simbolici, junction e nomi brevi (realpath), deve stare dentro una cartella autorizzata,
//    a sua volta risolta con realpath (le cartelle autorizzate non possono "uscire" tramite un collegamento);
//  - niente traversal (..), percorsi di rete, flussi alternativi NTFS, nomi di dispositivo, caratteri nulli;
//  - niente file o cartelle sensibili (chiavi, credenziali, profili dei browser, cartelle di sistema), anche se richiesti per nome esatto;
//  - si leggono solo file regolari.
const fs = require('fs');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const confronta = s => (IS_WIN ? s.toLowerCase() : s);

// Cartelle che non si attraversano mai (ricerca) e non si leggono mai (accesso diretto).
const CARTELLE_ESCLUSE = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.git', '.svn', '.hg', 'node_modules', '__pycache__', '.venv', 'venv',
  'appdata', 'library', 'keychains', '$recycle.bin', 'system volume information', 'windows', 'program files', 'program files (x86)', 'programdata', '.obsidian', '.trash', '.cache']);
const NOME_DISPOSITIVO = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const NOME_SENSIBILE = new RegExp([
  '^\\.env($|\\.)', '^id_(rsa|dsa|ecdsa|ed25519)', '\\.(pem|key|pfx|p12|ppk|kdbx|kdb|keystore|jks|ovpn|crt|cer|der|asc|gpg|pgp|rdp)$',
  '^(credentials?|secrets?|passwords?|passwd|shadow|known_hosts|authorized_keys|\\.npmrc|\\.netrc|\\.pypirc|\\.git-credentials|\\.htpasswd)(\\.|$)',
  'wallet', 'seed[ _.-]?phrase', 'recovery[ _.-]?(key|code)', '(^|[ _.-])(password|passwords|credenziali|segreti|chiavi)([ _.-]|$)',
  '^(cookies|login data|web data|history|ntuser\\.dat|sam|system|security)$'
].join('|'), 'i');

const ESTENSIONI_LEGGIBILI = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.yaml', '.yml', '.pdf', '.docx']);

function nomeSensibile(nome) { return NOME_SENSIBILE.test(nome) || NOME_DISPOSITIVO.test(nome); }
function cartellaEsclusa(nome) { return CARTELLE_ESCLUSE.has(nome.toLowerCase()) || nome.startsWith('$'); }

class ErroreAccesso extends Error {
  constructor(codice, messaggio) { super(messaggio); this.name = 'ErroreAccesso'; this.codice = codice; }
}

class GuardiaPercorsi {
  // radici: elenco di cartelle assolute autorizzate dall'utente (si rileggono a ogni controllo: le modifiche valgono subito).
  constructor(radici) { this.radici = typeof radici === 'function' ? radici : () => radici; }

  // Radici valide e risolte. Una radice inesistente o non cartella viene ignorata, non causa errori.
  radiciRisolte() {
    const out = [];
    for (const r of this.radici()) {
      try {
        if (typeof r !== 'string' || !path.isAbsolute(r)) continue;
        const reale = fs.realpathSync.native(r);
        if (fs.statSync(reale).isDirectory()) out.push({ configurata: r, reale });
      } catch (e) { /* cartella non raggiungibile: si salta */ }
    }
    return out;
  }

  static dentro(figlio, padre) {
    const f = confronta(path.resolve(figlio)), p = confronta(path.resolve(padre));
    return f === p || f.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
  }

  // Controllo sintattico del testo del percorso, prima di toccare il disco.
  static controllaSintassi(percorso) {
    if (typeof percorso !== 'string' || !percorso.trim()) throw new ErroreAccesso('PERCORSO_NON_VALIDO', 'Percorso mancante.');
    if (percorso.length > 1024 || percorso.includes('\u0000')) throw new ErroreAccesso('PERCORSO_NON_VALIDO', 'Percorso non valido.');
    if (IS_WIN) {
      if (/^\\\\|^\/\//.test(percorso)) throw new ErroreAccesso('PERCORSO_DI_RETE', 'I percorsi di rete non sono consentiti.');
      if (/^[a-z]:/i.test(percorso) ? percorso.slice(2).includes(':') : percorso.includes(':')) throw new ErroreAccesso('PERCORSO_NON_VALIDO', 'Percorso non valido (flusso alternativo).');
      if (/[<>"|?*]/.test(percorso)) throw new ErroreAccesso('PERCORSO_NON_VALIDO', 'Il percorso contiene caratteri non consentiti.');
    }
    if (percorso.split(/[\\/]/).some(s => s === '..')) throw new ErroreAccesso('TRAVERSAL', 'I percorsi con ".." non sono consentiti.');
  }

  // Restituisce { reale, radice, stat } per un percorso leggibile; lancia ErroreAccesso altrimenti.
  // `modo`: 'file' (deve essere un file regolare) oppure 'cartella'.
  risolvi(percorso, modo = 'file') {
    GuardiaPercorsi.controllaSintassi(percorso);
    const radici = this.radiciRisolte();
    if (!radici.length) throw new ErroreAccesso('NESSUNA_CARTELLA', 'Nessuna cartella autorizzata.');
    const assoluto = path.resolve(percorso);
    if (!path.isAbsolute(percorso)) throw new ErroreAccesso('PERCORSO_NON_VALIDO', 'Serve un percorso assoluto.');
    let reale;
    try { reale = fs.realpathSync.native(assoluto); } catch (e) { throw new ErroreAccesso('NON_TROVATO', 'File o cartella non trovati.'); }
    const radice = radici.find(r => GuardiaPercorsi.dentro(reale, r.reale));
    // Messaggio volutamente identico per "fuori dalle cartelle" e "non trovato": non si confermano percorsi che non si possono leggere.
    if (!radice) throw new ErroreAccesso('FUORI_DALLE_CARTELLE', 'Il percorso non e dentro le cartelle autorizzate.');
    const relativo = path.relative(radice.reale, reale).split(path.sep).filter(Boolean);
    const nome = path.basename(reale);
    if (relativo.slice(0, -1).some(cartellaEsclusa) || (modo === 'cartella' && relativo.length && cartellaEsclusa(nome))) throw new ErroreAccesso('CARTELLA_PROTETTA', 'La cartella e protetta e non si legge.');
    if (nomeSensibile(nome) || relativo.some(nomeSensibile)) throw new ErroreAccesso('FILE_SENSIBILE', 'Questo file puo contenere dati sensibili (chiavi, credenziali) e non si legge.');
    let st;
    try { st = fs.statSync(reale); } catch (e) { throw new ErroreAccesso('NON_LEGGIBILE', 'Impossibile leggere: ' + e.code); }
    if (modo === 'file' && !st.isFile()) throw new ErroreAccesso('NON_UN_FILE', 'Il percorso non e un file.');
    if (modo === 'cartella' && !st.isDirectory()) throw new ErroreAccesso('NON_UNA_CARTELLA', 'Il percorso non e una cartella.');
    return { reale, radice: radice.reale, stat: st };
  }

  // Verifica una voce incontrata durante una ricerca (nessuna eccezione: true se si puo mostrare).
  voceAmmessa(nome, eCartella) { return eCartella ? !cartellaEsclusa(nome) : !nomeSensibile(nome); }
}

module.exports = { GuardiaPercorsi, ErroreAccesso, ESTENSIONI_LEGGIBILI, nomeSensibile, cartellaEsclusa };
