'use strict';
// Unico punto in cui si decide dove sta il vault e dove sta l'indice.
// Il vault si cambia con la variabile ORBIT_VAULT_PATH, l'indice con ORBIT_INDEX_DIR.
const fs = require('fs');
const os = require('os');
const path = require('path');

// ORBIT_VAULT_PATH ha sempre la precedenza; altrimenti si usa la cartella che contiene il repository (se e un vault Obsidian)
// o la cartella DocumentiOrbit dell'utente: vedi trovaVault in profilo.js. Nessun percorso personale e scritto nel codice.
const { trovaVault } = require('./profilo');
const vault = trovaVault(process.env);
const vaultPath = vault.percorso;

// L'indice sta fuori dal vault: e' un file tecnico, ricostruibile, e non deve finire in Obsidian Sync.
const indexDir = path.resolve(process.env.ORBIT_INDEX_DIR ||
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'Orbit'));
const indexFile = path.join(indexDir, 'indice.sqlite');

// Cartelle mai indicizzate: tutte quelle che iniziano col punto (.obsidian, .trash, .claude, .orbit-hud...).
function cartellaEsclusa(nome) {
  return nome.startsWith('.') || nome === 'node_modules';
}

// Documenti del progetto che stanno nel vault ma NON sono memoria personale (istruzioni per agenti di sviluppo, storia tecnica di Orbit):
// non entrano nell'indice, quindi ne nel retrieval automatico ne nelle risposte. I file restano dove sono e chiunque li puo leggere.
// ORBIT_MEMORIA_ESCLUDI: percorsi relativi al vault separati da virgola, confrontati per INTERO (una nota omonima in un'altra cartella
// resta indicizzata); ORBIT_MEMORIA_ESCLUDI="" non esclude nulla. Come le altre variabili della memoria, si legge dall'ambiente del processo.
const ESCLUSI_DEFAULT = 'AGENTS.md,CONTESTO-ORBIT.md';
const normaRel = s => String(s || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
const esclusi = new Set(String(process.env.ORBIT_MEMORIA_ESCLUDI !== undefined ? process.env.ORBIT_MEMORIA_ESCLUDI : ESCLUSI_DEFAULT).split(',').map(normaRel).filter(Boolean));
function fileEscluso(rel) { return esclusi.has(normaRel(rel)); }

// Controlla che il vault esista, sia leggibile e assomigli a un vault Obsidian.
// Non lancia mai eccezioni: restituisce { ok, errore }.
function verificaVault() {
  let st;
  try { st = fs.statSync(vaultPath); } catch (e) {
    return { ok: false, errore: 'Il vault non esiste o non e raggiungibile: ' + vaultPath + '. Controlla ORBIT_VAULT_PATH.' };
  }
  if (!st.isDirectory()) return { ok: false, errore: 'Il percorso del vault non e una cartella: ' + vaultPath };
  try { fs.accessSync(vaultPath, fs.constants.R_OK); fs.readdirSync(vaultPath); } catch (e) {
    return { ok: false, errore: 'Non ho i permessi per leggere il vault: ' + vaultPath };
  }
  let obs;
  try { obs = fs.statSync(path.join(vaultPath, '.obsidian')); } catch (e) { obs = null; }
  if (!obs || !obs.isDirectory()) {
    return { ok: false, errore: 'La cartella ' + vaultPath + ' non sembra un vault Obsidian (manca .obsidian).' };
  }
  return { ok: true, errore: null };
}

module.exports = { vaultPath, vaultOrigine: vault.origine, indexDir, indexFile, cartellaEsclusa, fileEscluso, esclusi: [...esclusi], verificaVault };
