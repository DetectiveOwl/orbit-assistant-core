'use strict';
// Integrazione "Google" (Calendar e Gmail, SOLA LETTURA): collegamento OAuth unico, lettura eventi e lettura mail.
// Nessuno strumento puo scrivere, inviare, eliminare, archiviare, spostare o cambiare etichette: i token non hanno nemmeno quei permessi.
const { creaCalendario } = require('./calendario');
const { creaGmail } = require('./gmail');

function creaIntegrazioneGoogle({ auth, fetchFn }) {
  const cal = creaCalendario({ auth, fetchFn });
  const gmail = creaGmail({ auth, fetchFn });
  const data = { tipo: 'string', max: 10 };
  return {
    id: 'google', nome: 'Google (Calendar e Gmail, sola lettura)', descrizione: 'Legge il tuo calendario e la tua posta Google. Ambiti: calendar.readonly e gmail.readonly.',
    prerequisiti: async () => { const s = await auth.stato(); return s.collegato ? { ok: true, messaggio: s.messaggio } : { ok: false, messaggio: s.messaggio + ' (usa "Collega Google")' }; },
    strumenti: {
      elenca_eventi: {
        livello: 'lettura', descrizione: 'Elenca gli eventi dei calendari Google visibili in un intervallo di date (tutte le pagine), eventualmente solo in alcuni giorni.', timeoutMs: 45000,
        schema: { da: { tipo: 'string', richiesto: true, max: 10 }, a: { tipo: 'string', max: 10 }, giorni: { tipo: 'lista', max: 62 }, limite: { tipo: 'number', min: 1, max: 150 } },
        esegui: async (p, ctx = {}) => cal.elencaEventi(p, ctx)
      },
      cerca_mail: {
        livello: 'lettura', descrizione: 'Cerca mail per mittente, destinatario, oggetto, parole e date; puo aprire la conversazione del primo risultato.', timeoutMs: 60000,
        schema: { mittente: { tipo: 'string', max: 120 }, destinatario: { tipo: 'string', max: 120 }, oggetto: { tipo: 'string', max: 120 }, parole: { tipo: 'string', max: 200 },
          dopo: data, prima: data, cartella: { tipo: 'enum', valori: ['in arrivo', 'inviata', 'tutte'] }, nonLette: { tipo: 'boolean' }, limite: { tipo: 'number', min: 1, max: 20 }, apri_prima: { tipo: 'boolean' } },
        esegui: async (p, ctx = {}) => gmail.cerca(p, ctx)
      },
      leggi_mail: {
        livello: 'lettura', descrizione: 'Legge una mail (testo, senza scaricare allegati).', timeoutMs: 30000,
        schema: { id: { tipo: 'string', richiesto: true, max: 40 } },
        esegui: async (p, ctx = {}) => gmail.leggi(p, ctx)
      },
      leggi_conversazione: {
        livello: 'lettura', descrizione: 'Legge una conversazione di Gmail in ordine, senza le parti citate.', timeoutMs: 45000,
        schema: { id: { tipo: 'string', richiesto: true, max: 40 } },
        esegui: async (p, ctx = {}) => gmail.conversazione(p, ctx)
      }
    }
  };
}

module.exports = { creaIntegrazioneGoogle };
