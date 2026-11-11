'use strict';
// Solo forme esplicite: un caso non riconosciuto mantiene il percorso ordinario.
const COMANDO = /^(?:traduci(?: (?:questo|il seguente) (?:testo|paragrafo))?(?: in (?:inglese|italiano|francese|spagnolo|tedesco|portoghese))?|(?:correggi|riscrivi|riformula|parafrasa|riassumi|sintetizza)(?: (?:questo|il seguente) (?:testo|paragrafo))?)\s*:\s*(\S[\s\S]*)$/i;
const DIPENDENZE = /\b(file|document\w*|pdf|docx|note|appunti|vault|obsidian|cervello|progett\w*|calendario|impegni|mail|email|posta|web|internet|online|link|url|allegat\w*|font[ei]|articol\w*|libro|capitol\w*|pagin\w*|report|lettera|tabell\w*|citat\w*|riferiment\w*|discuss\w*|precedent\w*|prima|sopra|sotto|ancora|stesso|quello|quella|questo|questa|mio|mia|miei|mie|nostr\w*|tuo|tua|tuoi|tue|cerca\w*|leggi|controlla\w*|verifica\w*|confronta\w*|salva\w*|scrivi|invia\w*|cancella\w*|aggiungi\w*|aggiorna\w*|previous|above|attached|according|calendar|website|medical|medicine|drug|dosage|contract|investment|tax|payment)\b|https?:|[a-z]:[\\/]|\[\[|```|<orbit_|\.(?:md|pdf|docx)\b/i;

function testoAutonomo(testo, c) {
  if (!['transform', 'summary'].includes(c.categoria) || c.rischio !== 'low' || c.richiamaVault || c.serveStoria) return false;
  const m = String(testo).trim().match(COMANDO);
  if (!m || !/[\p{L}\p{N}]/u.test(m[1])) return false;
  // I riferimenti nel materiale possono essere letterali: nel dubbio non ottimizziamo.
  return !DIPENDENZE.test(m[1]);
}

module.exports = { testoAutonomo };
