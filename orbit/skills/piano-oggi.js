'use strict';
const { nomeUtente } = require('../../memoria/profilo');
// Skill "piano-oggi" nella nuova Orbit, senza la vecchia HUD.
// Le istruzioni restano quelle dell'utente, lette (in sola lettura) dal vault: .claude/skills/piano-oggi/SKILL.md.
// Orbit le esegue con la sua pipeline normale (contesto con l'estratto del piano e lo stato, router, Quality Gate) e salva il piano
// in outputs/piano-AAAA-MM-GG.md con lo strumento gia esistente crea_nota (permessi, conferme e audit dell'Integration Manager).
// Nessuna nuova capacita di scrittura: un piano gia esistente non viene mai sovrascritto ne rigenerato.
const fs = require('fs');
const path = require('path');

const FILE_SKILL = ['.claude', 'skills', 'piano-oggi', 'SKILL.md'];
const normalizza = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Si attiva solo su richiesta esplicita di preparare il piano (non su "cosa devo fare oggi?", che resta una risposta in chat):
// "piano-oggi", "/piano-oggi", "fammi / preparami / crea / genera / scrivi il piano di oggi (della giornata)".
function rileva(testo) {
  const t = normalizza(testo).trim();
  if (/(^|\s)\/?piano[- ]oggi\b/.test(t)) return true;
  if (/\b(non|senza)\b[^.]{0,20}\bpiano\b/.test(t)) return false;
  return /\b(fammi|fai|fare|prepara|preparami|crea|creami|genera|generami|scrivi|scrivimi|organizza|organizzami|imposta)\b[^.?!]{0,25}\bpiano\b[^.?!]{0,25}\b(oggi|di oggi|della giornata|giornata)\b/.test(t);
}

// Istruzioni della skill dal vault (testo dopo il frontmatter). null se il file non c'e.
function istruzioni(vaultPath) {
  try {
    const src = fs.readFileSync(path.join(vaultPath, ...FILE_SKILL), 'utf8');
    return src.replace(/^﻿/, '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim().slice(0, 8000) || null;
  } catch (e) { return null; }
}

const percorsoPiano = oggi => 'outputs/piano-' + oggi + '.md';

// Blocco da mettere in testa al messaggio per il modello.
function blocco({ testoSkill, oggi, esiste }) {
  const p = percorsoPiano(oggi);
  const adattamento = esiste
    ? 'Il piano di oggi esiste gia (' + p + ', nel contesto se e di oggi): NON rigenerarlo e NON usare il blocco <orbit_piano>. Riassumilo a ' + nomeUtente() + ' e digli che e gia salvato.'
    : 'Come funziona in Orbit: nel contesto hai gia la riga di oggi del piano, le regole, le informazioni collegate e lo stato del ripasso; non puoi aprire altri file. ' +
      'Non puoi aggiornare tu scadenze/parziali.md: se lo stato e troppo vecchio per decidere, fai la domanda breve prevista dalla skill e NON scrivere il piano in questo turno. ' +
      'Quando il piano e pronto, mettilo per intero in UN solo blocco alla fine della risposta: <orbit_piano>\n...piano in Markdown, con le due righe iniziali richieste dalla skill...\n</orbit_piano>. ' +
      'Orbit lo salva in ' + p + '. Fuori dal blocco scrivi solo una sintesi di due o tre righe. Cita solo le note che vedi nel contesto. Non usare calendario o posta.';
  return '<skill_piano_oggi data="' + oggi + '">\n' + nomeUtente() + ' ha chiesto la skill piano-oggi. ' + adattamento +
    (testoSkill ? '\n\nIstruzioni della skill (dal suo vault, .claude/skills/piano-oggi/SKILL.md):\n' + testoSkill : '\n\n(Il file della skill non e nel vault: segui comunque le regole qui sopra.)') + '\n</skill_piano_oggi>';
}

const RE_PIANO = /<orbit_piano>([\s\S]*?)<\/orbit_piano>/;
// Separa il piano dal testo per l'utente. Accetta un solo blocco; i blocchi in piu vengono tolti dal testo e ignorati.
function estraiPiano(testoModello) {
  const s = String(testoModello || '');
  const m = s.match(RE_PIANO);
  const testo = s.replace(/<orbit_piano>[\s\S]*?<\/orbit_piano>/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const piano = m ? m[1].replace(/^\s*\n/, '').replace(/\s+$/, '') : '';
  return { testo, piano: piano.trim() ? piano : null };
}

module.exports = { rileva, istruzioni, percorsoPiano, blocco, estraiPiano, FILE_SKILL };
