'use strict';
// Comportamento esecutivo di Orbit: regole deterministiche (nessuna chiamata AI) usate da orchestrator, registry e config.
// I permessi veri restano nel Permission Manager: qui si classifica, non si concede nulla.
//
// Autonomia in tre categorie, ricavata dal livello dello strumento e dalla decisione del Permission Manager:
//   A  esecuzione autonoma    lettura e bozza, senza conferma
//   B  autonomia circoscritta creazione nell'area bozze autorizzata (o permesso dato apposta dall'utente per quel livello)
//   C  conferma obbligatoria  tutto il resto; una decisione "nega" blocca comunque
const { segmentiNota } = require('../integrations/obsidian/scrittura');

function categoriaAutonomia(livello, decisione, inArea = false) {
  if (decisione !== 'consenti') return 'C';
  if (inArea) return 'B';
  return livello === 'lettura' || livello === 'bozza' ? 'A' : 'B';
}

// Area bozze: cartella del vault (percorso relativo) dove Orbit puo creare note nuove senza chiedere conferma. Vuota = spenta.
// Lancia ErroreNota se il valore non e una cartella valida (punti, "..", percorsi assoluti...).
function areaBozze(valore) {
  const v = String(valore || '').trim().replace(/[\\/]+$/, '');
  return v ? segmentiNota(v + '/x').slice(0, -1) : null;
}

// shortcut: confronto senza distinzione di maiuscole anche su file system che la distinguono, la scelta e solo piu restrittiva su Windows.
function dentroArea(percorso, area) {
  if (!area) return false;
  let s;
  try { s = segmentiNota(percorso); } catch (e) { return false; }
  return s.length > area.length && area.every((a, i) => a.toLowerCase() === s[i].toLowerCase());
}

// Messaggio per l'utente: mai codici di uscita, testo grezzo del processo o stack trace (restano nel log e negli eventi diagnostici).
function erroreUtente(codice, messaggio) {
  const m = String(messaggio || '');
  if (codice === 'BAD_RESPONSE') return 'Claude Code non ha risposto correttamente. Riprova tra poco: i dettagli sono nel diario di Orbit.';
  if (codice === 'INTERNAL' || /^Errore interno nella chiamata AI/.test(m)) return 'Errore interno di Orbit. I dettagli sono nel log del server.';
  if (codice === 'LIMITE_ABBONAMENTO') return m.replace(/\s*\([^)]*\)\s*$/, '');
  return m.split(/\r?\n\s*at /)[0];
}

const SENZA_VALORE = new Set('cosa dimmi quali quale sono nelle nella della delle degli sulle sulla miei mie tutte tutti trova trovami cerca cercami nota note appunti vault dove come quando'.split(' '));
const norm = s => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// Formulazione alternativa per una ricerca senza risultati: solo le due parole piu significative (una ricerca con meno termini
// trova di piu). Restituisce null se non c'e niente di diverso da provare.
function queryAlternativa(query) {
  // vincoli espliciti (#tag, tag:x, cartella:x) restano com'erano: li interpreta il retrieval
  const vincoli = String(query || '').split(/\s+/).filter(t => /^#\S+$|^(?:tag|cartella):\S+$/i.test(t));
  const liberi = String(query || '').split(/\s+/).filter(t => !vincoli.includes(t)).join(' ');
  const parole = (norm(liberi).match(/[\p{L}\p{N}]{4,}/gu) || []).filter(p => !SENZA_VALORE.has(p));
  const uniche = [...new Set(parole)];
  if (uniche.length < 2) return null;
  const scelte = new Set([...uniche].sort((a, b) => b.length - a.length).slice(0, 2));
  const alt = uniche.filter(p => scelte.has(p)).join(' ');
  return alt === uniche.join(' ') ? null : [alt, ...vincoli].join(' ');
}

// Stile della risposta per i compiti operativi (cerca, crea, salva...): esito in una o due frasi. Le richieste di spiegazioni,
// documenti, elenchi o confronti, e le semplici domande, non ricevono alcun vincolo di brevita.
const RE_AZIONE = /^(?:(?:per favore|per piacere|ora|adesso|poi)\s+)?(?:(?:puoi|potresti|riesci a)\s+)?(?:cerca\w*|trova\w*|crea\w*|salva\w*|aggiung\w*|annota\w*|segna\w*|apri\w*|controlla\w*|leggi\w*|prepara\w*|abbozza\w*|registra\w*|ricorda\w*)\b/;
const RE_ESTESO = /\b(spieg\w*|approfond\w*|dettagli\w*|nel dettaglio|passo passo|passaggi|confront\w*|document\w*|report|elenc\w*|riepilog\w*|riassun\w*|riassum\w*|piano|schema|analizz\w*|descriv\w*|perche|tutt[ei])\b/;
const ISTRUZIONE_ESECUTIVA = 'Compito operativo: svolgilo con gli strumenti e le informazioni disponibili invece di spiegare come si farebbe. A compito concluso rispondi in una o due frasi con l\'esito e il riferimento principale ' +
  '(per esempio nome e cartella della nota), senza preamboli, senza ripetere la richiesta, senza elencare strumenti o passaggi interni. Se qualcosa non e riuscito o serve un\'autorizzazione, dillo in modo specifico con l\'alternativa pratica; log e dettagli tecnici restano nel diario di Orbit.';

function istruzioniEsecutive(messaggio) {
  const t = norm(messaggio).trim().split(/:|```/)[0];
  return RE_AZIONE.test(t) && !RE_ESTESO.test(t) ? ISTRUZIONE_ESECUTIVA : '';
}

// Frasi con cui il modello dichiara di aver scritto qualcosa nel vault. Servono solo a toglierle quando nel turno non e stata
// eseguita nessuna scrittura (il modello risponde prima di sapere l'esito).
const RE_DICHIARA = /\b(?:ho|abbiamo)\s+(?:gia\s+)?(?:creat[oa]|salvat[oa]|scritt[oa]|aggiunt[oa]|annotat[oa]|registrat[oa]|memorizzat[oa]|preparat[oa]|inserit[oa])\b[^.!?\n]{0,60}\b(?:nota|note|bozz[ae]|appunt\w*|vault|cervello|obsidian|cartella|file)\b|\b(?:nota|bozza|appunti)\s+(?:e\s+stata\s+)?(?:creat[oa]|salvat[oa]|scritt[oa])\b/;

// Si lavora riga per riga e frase per frase, cosi il corpo di un testo che segue "ecco la bozza:" resta; le frasi negate non si toccano.
function togliDichiarazioniScrittura(testo) {
  let rimosse = false;
  const righe = String(testo || '').split('\n').map(riga => riga.split(/(?<=[.!?])\s+/).filter(f => {
    const n = norm(f);
    const toglila = RE_DICHIARA.test(n) && !/\b(non|mai|senza)\b/.test(n);
    if (toglila) rimosse = true;
    return !toglila;
  }).join(' '));
  return { testo: righe.join('\n').replace(/\n{3,}/g, '\n\n').trim(), rimosse };
}

module.exports = { categoriaAutonomia, areaBozze, dentroArea, erroreUtente, queryAlternativa, istruzioniEsecutive, togliDichiarazioniScrittura, ISTRUZIONE_ESECUTIVA };
