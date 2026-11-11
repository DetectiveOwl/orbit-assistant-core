'use strict';
// Integrazione "Obsidian": lettura e ricerca (tramite il modulo memoria, di sola lettura) e scrittura controllata (scrittura.js).
//  lettura  cerca_note, leggi_nota, elenca_note
//  crea     crea_nota          nuove note in qualsiasi cartella del vault tranne quelle tecniche (.obsidian...), mai sovrascrive
//  amplia   amplia_nota        aggiunge testo, sezioni, wikilink alle note esistenti, dopo backup, senza toccare il testo gia presente
//  modifica riscrivi_nota      riscrittura completa: conferma SEMPRE, con backup
//  irreversibile elimina_nota  conferma SEMPRE; la nota va nel cestino di Orbit, non viene distrutta
const { Vault, ErroreNota } = require('./scrittura');
const { areaBozze: segmentiArea, dentroArea } = require('../../ai/autonomia');

const anteprima = (t, n = 240) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '...' : s; };

function creaIntegrazioneObsidian({ memoria, datiDir, orologio, areaBozze = '' }) {
  // Area bozze (config dell'host, mai del modello): le note NUOVE al suo interno si creano senza conferma (livello bozza). Valore non valido = spenta.
  let area = null; try { area = segmentiArea(areaBozze); } catch (e) { area = null; }
  // Verifica sul disco, al momento dell'operazione: junction e symlink non portano fuori dall'area; se non si riesce a verificare vale la conferma.
  const sulDisco = percorso => { try { return v().dentroAreaReale(percorso, area); } catch (e) { return false; } };
  let vault = null, errore = null;
  const v = () => {
    if (vault) return vault;
    if (!memoria || !memoria.config) throw new ErroreNota('NON_CONFIGURATA', 'La memoria Obsidian non e disponibile.');
    try { vault = new Vault({ vaultPath: memoria.config.vaultPath, datiDir, orologio }); errore = null; } catch (e) { errore = e.message; throw new ErroreNota('NON_CONFIGURATA', e.message); }
    return vault;
  };
  // Dopo ogni scrittura riuscita la memoria aggiorna subito SOLO la nota toccata (niente risultati vecchi alla domanda successiva).
  const avvisa = r => { try { if (r && r.percorso && memoria && typeof memoria.notificaModifica === 'function') memoria.notificaModifica([r.percorso]); } catch (e) { /* la scansione incrementale la vedra comunque */ } return r; };
  const leggibile = () => { try { const s = memoria && memoria.stato && memoria.stato(); return !!(s && s.ok); } catch (e) { return false; } };

  return {
    id: 'obsidian', nome: 'Obsidian (vault)', descrizione: 'Legge e cerca nelle note; crea note nuove e aggiunge a quelle esistenti, con backup e senza mai cancellare.',
    prerequisiti: async () => leggibile() ? { ok: true, messaggio: 'vault raggiungibile' } : { ok: false, messaggio: 'vault non raggiungibile o memoria non avviata' },
    get areaBozze() { return area ? area.join('/') : ''; },
    get vault() { try { return v(); } catch (e) { return null; } },
    strumenti: {
      cerca_note: {
        livello: 'lettura', descrizione: 'Cerca nelle note del vault (stesso retrieval per sezioni della chat).', timeoutMs: 15000,
        schema: { query: { tipo: 'string', richiesto: true, max: 300 }, limite: { tipo: 'number', min: 1, max: 20 }, cartella: { tipo: 'string', max: 300 } },
        esegui: async ({ query, limite, cartella }) => ({ risultati: memoria.cercaNote(query, { limite: limite || 8, cartella }).map(r => ({ percorso: r.percorso, titolo: r.titolo, sezione: r.sezione || null, punteggio: r.punteggio, estratto: anteprima(r.estratto || r.snippet, 200) })) })
      },
      leggi_nota: {
        livello: 'lettura', descrizione: 'Legge una nota (percorso o nome come in un wikilink): intera, oppure solo una sezione o le sezioni pertinenti a una query.', timeoutMs: 15000,
        schema: { percorso: { tipo: 'string', richiesto: true, max: 300 }, sezione: { tipo: 'string', max: 200 }, query: { tipo: 'string', max: 300 } },
        esegui: async ({ percorso, sezione, query }) => {
          if (sezione || query) return memoria.leggiSezioni(percorso, { sezione, query });
          const n = memoria.leggiNota(percorso);
          return { percorso: n.percorso, titolo: n.titolo, tag: n.tag, intera: true, linkUscenti: n.linkUscenti.map(l => l.link), backlink: n.backlink, contenuto: n.contenuto.slice(0, 60000), troncata: n.contenuto.length > 60000 };
        }
      },
      elenca_note: {
        livello: 'lettura', descrizione: 'Elenca le note di una cartella del vault.', timeoutMs: 15000,
        schema: { cartella: { tipo: 'string', max: 300 } },
        esegui: async ({ cartella }) => { const r = memoria.elencaNote({ cartella }); return { note: r.note.slice(0, 200).map(n => ({ percorso: n.percorso, titolo: n.titolo })), totale: r.note.length }; }
      },
      crea_nota: {
        livello: 'crea', livelloPer: p => dentroArea(p.percorso, area) && sulDisco(p.percorso) ? 'bozza' : 'crea', descrizione: 'Crea una nota nuova nel vault (non sovrascrive).', timeoutMs: 20000,
        schema: { percorso: { tipo: 'string', richiesto: true, max: 240 }, contenuto: { tipo: 'string', richiesto: true, max: 200000 }, tag: { tipo: 'lista', max: 12 } },
        descriviConferma: p => ({ descrizione: 'Creare la nota "' + p.percorso + '"', destinazione: 'Vault Obsidian: ' + p.percorso, conseguenze: 'Compare un nuovo file nel vault (Obsidian Sync lo sincronizza). Anteprima: ' + anteprima(p.contenuto) }),
        esegui: async p => avvisa(v().crea(p))
      },
      amplia_nota: {
        livello: 'amplia', descrizione: 'Aggiunge testo, una sezione o wikilink a una nota esistente senza alterare il testo presente (copia di backup prima).', timeoutMs: 20000,
        schema: { percorso: { tipo: 'string', richiesto: true, max: 240 }, testo: { tipo: 'string', max: 60000 }, sezione: { tipo: 'string', max: 120 }, collegamenti: { tipo: 'lista', max: 20 }, seNonPresente: { tipo: 'boolean' } },
        descriviConferma: p => ({ descrizione: 'Aggiungere a "' + p.percorso + '"' + (p.sezione ? ' (sezione "' + p.sezione + '")' : ''), destinazione: 'Vault Obsidian: ' + p.percorso, conseguenze: 'Il testo esistente non cambia; prima ne faccio una copia di backup. Aggiungo: ' + anteprima((p.testo || '') + ' ' + (p.collegamenti || []).map(l => '[[' + l + ']]').join(' ')) }),
        esegui: async p => avvisa(v().amplia(p))
      },
      riscrivi_nota: {
        livello: 'modifica', descrizione: 'Riscrive per intero una nota esistente (conferma sempre).', timeoutMs: 20000,
        schema: { percorso: { tipo: 'string', richiesto: true, max: 240 }, contenuto: { tipo: 'string', richiesto: true, max: 200000 } },
        descriviConferma: p => ({ descrizione: 'RISCRIVERE per intero "' + p.percorso + '"', destinazione: 'Vault Obsidian: ' + p.percorso, conseguenze: 'Il contenuto attuale viene sostituito. Ne tengo una copia di backup fuori dal vault. Nuovo inizio: ' + anteprima(p.contenuto) }),
        esegui: async p => avvisa(v().riscrivi(p))
      },
      elimina_nota: {
        livello: 'irreversibile', descrizione: 'Elimina una nota (finisce nel cestino di Orbit; conferma sempre).', timeoutMs: 20000,
        schema: { percorso: { tipo: 'string', richiesto: true, max: 240 } },
        descriviConferma: p => ({ descrizione: 'ELIMINARE la nota "' + p.percorso + '"', destinazione: 'Vault Obsidian: ' + p.percorso, conseguenze: 'La nota sparisce dal vault e da Obsidian Sync. Ne resta una copia nel cestino di Orbit (%LOCALAPPDATA%\\Orbit\\cestino).' }),
        esegui: async p => avvisa(v().elimina(p))
      }
    }
  };
}

module.exports = { creaIntegrazioneObsidian };
