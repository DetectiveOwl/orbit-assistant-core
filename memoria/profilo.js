'use strict';
// Profilo dell'utente e dei percorsi locali: nome e descrizione usati nei prompt e nei saluti, parole del corso, vault.
// Nessun dato personale sta nel codice: i valori si impostano con variabili d'ambiente o nei file .env.
//
// Precedenza (dalla piu forte): variabili d'ambiente del processo > file .env dei dati (<dati>/.env, di norma
// %LOCALAPPDATA%\Orbit\.env) > file locale privato (privato/orbit.env nel repository, escluso da Git) > predefiniti neutri.
//   ORBIT_UTENTE             nome con cui Orbit si rivolge all'utente (predefinito: "Utente")
//   ORBIT_UTENTE_PROFILO     descrizione breve usata nel prompt di sistema, es. "studente di Ingegneria" (predefinito: nessuna)
//   ORBIT_PAROLE_CORSO       sigle o nomi di corsi in piu, separati da virgola, che fanno cercare nel vault (predefinito: nessuna)
//   ORBIT_LOCAL_ENV          percorso del file locale privato, se non e privato/orbit.env
const fs = require('fs');
const os = require('os');
const path = require('path');

const RADICE_REPO = path.resolve(__dirname, '..');

// Parser minimale di .env: KEY=VALUE, commenti con #, virgolette opzionali (come orbit/config.js).
function leggiEnvFile(file) {
  const out = {};
  let testo;
  try { testo = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  for (const riga of testo.replace(/^﻿/, '').split(/\r?\n/)) {
    if (riga.trim().startsWith('#')) continue;
    const m = riga.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

function dataDirDefault(env = process.env) {
  return path.join(env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'Orbit');
}
function fileEnvDati(env = process.env) { return env.ORBIT_ENV_FILE || path.join(env.ORBIT_DATA_DIR || dataDirDefault(env), '.env'); }
// ORBIT_LOCAL_ENV definita ma vuota = "nessun file locale" (i test la usano per non dipendere dal PC su cui girano).
function fileEnvLocale(env = process.env) { return env.ORBIT_LOCAL_ENV !== undefined ? env.ORBIT_LOCAL_ENV : path.join(RADICE_REPO, 'privato', 'orbit.env'); }

// I file si leggono una volta per processo: i valori del profilo non cambiano mentre Orbit e acceso.
const cache = new Map();
function daFile(file) {
  if (!cache.has(file)) cache.set(file, leggiEnvFile(file) || {});
  return cache.get(file);
}
function azzeraCache() { cache.clear(); }

// Valore di una variabile: ambiente del processo, poi file dei dati, poi file locale privato. Una variabile del processo
// definita ma vuota vale "nessun valore" e non lascia passare i file (serve ai test e a chi vuole azzerare il profilo).
function valore(nome, env = process.env) {
  const direct = env[nome];
  if (direct !== undefined) return String(direct).trim();
  for (const file of [fileEnvDati(env), fileEnvLocale(env)]) {
    const v = daFile(file)[nome];
    if (v !== undefined && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

const NOME_PREDEFINITO = 'Utente';
const nomeConfigurato = () => valore('ORBIT_UTENTE') || null;
const nomeUtente = () => valore('ORBIT_UTENTE') || NOME_PREDEFINITO;
const descrizioneUtente = () => valore('ORBIT_UTENTE_PROFILO');
// "assistente personale di <nome>[, <descrizione>]"
const presentazioneUtente = () => nomeUtente() + (descrizioneUtente() ? ', ' + descrizioneUtente() : '');
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Sigle o nomi di corso aggiuntivi, gia pronti per essere messi in un'alternativa di espressione regolare.
function paroleCorsoRe() {
  return valore('ORBIT_PAROLE_CORSO').split(',').map(s => s.trim()).filter(s => /^[\p{L}\p{N}][\p{L}\p{N}\s]{0,30}$/u.test(s)).map(s => escapeRe(s).replace(/\s+/g, '\\s*'));
}

// Dove sta il vault. Ordine: ORBIT_VAULT_PATH (sempre per primo); poi la cartella che CONTIENE il repository, se e un vault Obsidian
// (cioe se ha una cartella .obsidian: succede quando .orbit-hud sta dentro il vault); poi le cartelle Documenti dell'utente chiamate "Orbit".
// Niente percorsi fissi: Documenti puo essere reindirizzato su OneDrive, quindi si guardano sia %USERPROFILE%\Documents sia le
// cartelle che Windows indica per OneDrive. Se nessuna sembra un vault si restituisce il primo candidato, cosi l'errore dice dove si e cercato.
function ilVault(cartella) { try { return fs.statSync(path.join(cartella, '.obsidian')).isDirectory(); } catch (e) { return false; } }
function candidatiVault(env = process.env, repo = RADICE_REPO) {
  const lista = [path.dirname(repo)];
  const docs = [];
  const home = env.USERPROFILE || env.HOME || os.homedir();
  for (const base of [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial, home].filter(Boolean)) {
    docs.push(path.join(base, 'Documents'), path.join(base, 'Documenti'));
  }
  for (const d of docs) lista.push(path.join(d, 'Orbit'));
  return [...new Set(lista.map(p => path.resolve(p)))];
}
function trovaVault(env = process.env, repo = RADICE_REPO) {
  if (env.ORBIT_VAULT_PATH) return { percorso: path.resolve(env.ORBIT_VAULT_PATH), origine: 'ORBIT_VAULT_PATH' };
  const candidati = candidatiVault(env, repo);
  const trovato = candidati.find(ilVault);
  if (trovato) return { percorso: trovato, origine: trovato === candidati[0] ? 'cartella che contiene il repository' : 'cartella Documenti dell\'utente' };
  return { percorso: candidati[0], origine: 'nessun vault Obsidian trovato: imposta ORBIT_VAULT_PATH' };
}

module.exports = { nomeUtente, nomeConfigurato, descrizioneUtente, presentazioneUtente, paroleCorsoRe, valore, trovaVault, candidatiVault, leggiEnvFile, fileEnvLocale, fileEnvDati, azzeraCache, RADICE_REPO };
