'use strict';
// Macchina a stati di Orbit Core. Funzione pura: le transizioni dipendono SOLO da eventi reali,
// cioe quelli emessi dal backend durante l'elaborazione, piu quelli locali di microfono, voce e interfaccia.
// Nessuna animazione finge un'elaborazione: se il backend non emette eventi, lo stato non cambia.
(function (root) {
  // retrieving: recupero REALE di note dal vault (evento 'contesto' con vault attivo); tools: esecuzione di uno strumento;
  // responding: la risposta e visibile nel contenitore; paused: l'utente ha messo Orbit in pausa.
  const STATI = ['idle', 'listening', 'thinking', 'retrieving', 'executing', 'tools', 'quality_checking', 'escalating', 'speaking', 'responding', 'paused', 'error'];

  const ETICHETTE = {
    idle: '', listening: 'Ti ascolto', thinking: 'Ragiono sulla richiesta', retrieving: 'Cerco nelle tue note', executing: 'Elaboro',
    tools: 'Uso uno strumento', quality_checking: 'Verifico la risposta', escalating: 'Passo a un modello piu capace',
    speaking: 'Parlo', responding: '', paused: 'In pausa', error: 'Errore'
  };

  function iniziale() { return { nome: 'idle', attiva: false, tier: null, modello: null, dettaglio: null, note: [], connessioni: [], fallimento: false, rispostaAperta: false, inPausa: false }; }

  // Soltanto metadati degli eventi reali: nessun nodo suggerisce una fonte mai consultata.
  function connetti(esistenti, nuove) {
    const m = new Map((esistenti || []).map(n => [n.id, n]));
    for (const n of nuove) { if (n && n.id && n.titolo) m.set(n.id, Object.assign({}, m.get(n.id), n)); }
    return [...m.values()].slice(0, 32);
  }
  function fontiNodi(fonti, padre) {
    return (fonti || []).filter(f => f && (f.titolo || f.percorso)).map(f => ({
      id: 'fonte:' + (f.percorso || f.titolo), titolo: String(f.titolo || f.percorso).slice(0, 90),
      tipo: /^https?:/.test(f.percorso || '') ? 'pagina' : 'nota', padre, stato: 'letta'
    }));
  }
  function strumentoNodo(nome, stato) {
    const n = String(nome || 'strumento');
    const titolo = /^google\.elenca_eventi/.test(n) ? 'Google Calendar' : /^google\./.test(n) ? 'Gmail'
      : /^web\./.test(n) ? 'Ricerca web' : /^documenti\./.test(n) ? 'Documenti locali' : /^obsidian\./.test(n) ? 'Vault Obsidian' : n.replace(/_/g, ' ');
    return { id: 'api:' + n, titolo, tipo: 'api', stato };
  }

  // Stato "di riposo": dove si torna quando microfono o voce finiscono.
  function riposo(s) { return Object.assign({}, s, { nome: s.inPausa ? 'paused' : (s.rispostaAperta ? 'responding' : 'idle') }); }

  // stato, evento -> nuovo stato. Gli eventi del backend hanno `tipo`; quelli locali iniziano con 'locale:'.
  function riduci(stato, ev) {
    const s = Object.assign({}, stato);
    switch (ev.tipo) {
      case 'locale:invio': return Object.assign(s, { nome: 'thinking', attiva: true, dettaglio: null, note: [], connessioni: [], fallimento: false, rispostaAperta: false });
      case 'avviata': case 'conversazione': case 'classificazione': case 'classificata':
        return Object.assign(s, { nome: 'thinking', attiva: true });
      case 'contesto':
        // Recupero dal vault: lo stato "retrieving" esiste SOLO se il backend sta davvero cercando nelle note.
        return ev.vault ? Object.assign(s, { nome: 'retrieving', attiva: true, note: [], connessioni: connetti(s.connessioni, [{ id: 'vault', titolo: 'Memoria Obsidian', tipo: 'api', stato: 'attiva' }]) }) : Object.assign(s, { nome: 'thinking', attiva: true });
      case 'contesto_pronto':
        return s.nome === 'retrieving' ? Object.assign(s, { note: (ev.fonti || []).map(f => f.titolo || f.percorso), connessioni: connetti(s.connessioni, [{ id: 'vault', titolo: 'Memoria Obsidian', tipo: 'api', stato: 'letta' }, ...fontiNodi(ev.fonti, 'vault')]) }) : Object.assign(s, { nome: 'thinking', attiva: true });
      case 'instradata':
        return Object.assign(s, { nome: 'thinking', attiva: true, tier: ev.tier || null, modello: ev.modello || null, dettaglio: ev.motivo || null });
      case 'tentativo': case 'esecuzione':
        return Object.assign(s, { nome: 'executing', attiva: true, fallimento: false, tier: ev.tier || s.tier, modello: ev.modello || s.modello });
      case 'strumento':
        return Object.assign(s, { nome: 'tools', attiva: true, dettaglio: ev.nome || null, connessioni: connetti(s.connessioni, [strumentoNodo(ev.nome, 'attiva')]) });
      case 'conferma_richiesta': return Object.assign(s, { nome: 'tools', attiva: true, dettaglio: 'In attesa della tua conferma' });
      case 'strumento_fine': return Object.assign(s, { dettaglio: ev.ok === false ? 'Collegamento non riuscito' : null, fallimento: ev.ok === false,
        connessioni: connetti(s.connessioni, [strumentoNodo(ev.nome, ev.ok === false ? 'errore' : 'letta'), ...fontiNodi(ev.fonti, 'api:' + ev.nome)]) });
      case 'verifica':
        return Object.assign(s, { nome: 'quality_checking', attiva: true });
      case 'esito_verifica':
        return Object.assign(s, { fallimento: ev.status === 'FAIL', dettaglio: ev.status === 'FAIL' ? 'Controllo non superato' : s.dettaglio });
      case 'escalation': case 'tentativo_mirato':
        return Object.assign(s, { nome: 'escalating', attiva: true, dettaglio: ev.motivo || null, tier: ev.a || s.tier });
      case 'ritento':
        return Object.assign(s, { dettaglio: 'Servizio occupato, riprovo (' + (ev.codice || 'errore') + ')' });
      case 'finale': return Object.assign(s, { nome: 'responding', attiva: false, fallimento: ev.verifica === 'FAIL', dettaglio: null, rispostaAperta: true });
      case 'interrotta': return Object.assign(s, { nome: s.inPausa ? 'paused' : 'idle', attiva: false, dettaglio: null, connessioni: [], fallimento: false, rispostaAperta: false });
      case 'errore': return Object.assign(s, { nome: 'error', attiva: false, fallimento: true, dettaglio: ev.messaggio || null, rispostaAperta: true });
      case 'locale:mic_avvio': return s.attiva ? s : Object.assign(s, { nome: 'listening', dettaglio: null });
      case 'locale:mic_fine': return s.nome === 'listening' ? riposo(s) : s;
      case 'locale:voce_inizio': return s.attiva ? s : Object.assign(s, { nome: 'speaking' });
      case 'locale:voce_fine': return s.nome === 'speaking' ? riposo(s) : s;
      case 'locale:chiudi_risposta': return s.attiva ? s : Object.assign(s, { nome: s.inPausa ? 'paused' : 'idle', rispostaAperta: false, dettaglio: null, connessioni: [], fallimento: false });
      case 'locale:errore_chiuso': return s.nome === 'error' ? Object.assign(s, { nome: s.inPausa ? 'paused' : 'idle', dettaglio: null, rispostaAperta: false, connessioni: [], fallimento: false }) : s;
      case 'locale:pausa': return s.attiva ? s : Object.assign(s, { nome: 'paused', inPausa: true });
      case 'locale:riprendi': return Object.assign(s, { inPausa: false }, s.nome === 'paused' ? { nome: s.rispostaAperta ? 'responding' : 'idle' } : {});
      default: return s;
    }
  }

  const api = { STATI, ETICHETTE, iniziale, riduci };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.OrbitCoreState = api;
})(typeof window !== 'undefined' ? window : globalThis);
