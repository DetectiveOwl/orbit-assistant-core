'use strict';
const { nomeUtente } = require('./profilo');
// Server MCP minimo (stdio, JSON-RPC su righe) che espone la memoria a Claude Code in sola lettura.
// Nessuno strumento scrive nel vault. Su stdout passa solo il protocollo, i messaggi diagnostici vanno su stderr.
const readline = require('readline');
const memoria = require('./memoria');

const STRUMENTI = [
  {
    name: 'cerca_note',
    description: 'Cerca nelle note Markdown del vault Obsidian di ' + nomeUtente() + ' per titolo, contenuto, tag, intestazioni e metadati YAML. ' +
      'Usa lo stesso retrieval per sezioni della chat di Orbit: restituisce percorso, titolo, sezione migliore ed estratto delle note pertinenti. Supporta i filtri tag:nome e cartella:percorso nella query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Parole da cercare, in italiano. Esempio: "rouche capelli" oppure "tag:analisi serie".' },
        limite: { type: 'number', description: 'Numero massimo di risultati (predefinito 8).' },
        cartella: { type: 'string', description: 'Limita la ricerca a una cartella del vault, es. "corsi".' }
      },
      required: ['query']
    }
  },
  {
    name: 'leggi_nota',
    description: 'Legge una nota del vault dal file originale. Accetta un percorso relativo (es. scadenze/parziali.md) ' +
      'o il nome di una nota come in un wikilink. Senza altri parametri restituisce la nota INTERA (contenuto, tag, frontmatter, link uscenti risolti e backlink). ' +
      'Con sezione (titolo di una intestazione) restituisce solo quella sezione; con query solo le sezioni che contengono quelle parole.',
    inputSchema: {
      type: 'object',
      properties: {
        percorso: { type: 'string', description: 'Percorso relativo nel vault o nome della nota.' },
        sezione: { type: 'string', description: 'Facoltativo: titolo della intestazione da leggere, es. "Stato del ripasso".' },
        query: { type: 'string', description: 'Facoltativo: parole da cercare dentro la nota; restituisce solo le sezioni pertinenti.' }
      },
      required: ['percorso']
    }
  },
  {
    name: 'elenca_note',
    description: 'Elenca le note e gli allegati del vault, eventualmente solo dentro una cartella.',
    inputSchema: { type: 'object', properties: { cartella: { type: 'string' } } }
  },
  {
    name: 'stato_memoria',
    description: 'Dice se il vault e raggiungibile, quante note e allegati sono indicizzati e quando e stato aggiornato l\'indice.',
    inputSchema: { type: 'object', properties: {} }
  }
];

function esegui(nome, a = {}) {
  switch (nome) {
    case 'cerca_note': return memoria.cercaNote(String(a.query || ''), { limite: a.limite, cartella: a.cartella });
    case 'leggi_nota': return a.sezione || a.query ? memoria.leggiSezioni(String(a.percorso || ''), { sezione: a.sezione ? String(a.sezione) : null, query: a.query ? String(a.query) : null }) : memoria.leggiNota(String(a.percorso || ''));
    case 'elenca_note': return memoria.elencaNote({ cartella: a.cartella });
    case 'stato_memoria': return memoria.stato();
    default: throw new Error('Strumento sconosciuto: ' + nome);
  }
}

function invia(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

function gestisci(req) {
  const { id, method, params } = req;
  if (id === undefined || id === null) return;            // notifiche: nessuna risposta
  try {
    if (method === 'initialize') {
      return invia({ jsonrpc: '2.0', id, result: {
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'orbit-memoria', version: '1.0.0' },
        instructions: 'Memoria di Orbit: accesso in sola lettura al vault Obsidian di ' + nomeUtente() + '. Usa cerca_note e leggi_nota ' +
          'per rispondere sui suoi appunti, cita i percorsi delle note e distingui i fatti scritti nelle note dalle tue deduzioni.'
      } });
    }
    if (method === 'ping') return invia({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return invia({ jsonrpc: '2.0', id, result: { tools: STRUMENTI } });
    if (method === 'tools/call') {
      try {
        const r = esegui(params.name, params.arguments);
        return invia({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] } });
      } catch (e) {
        return invia({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Errore: ' + e.message }], isError: true } });
      }
    }
    invia({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Metodo non supportato: ' + method } });
  } catch (e) {
    invia({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
}

const s = memoria.avvia();
if (!s.ok) process.stderr.write('orbit-memoria: ' + s.errore + '\n');

readline.createInterface({ input: process.stdin }).on('line', riga => {
  if (!riga.trim()) return;
  let req;
  try { req = JSON.parse(riga); } catch (e) {
    return invia({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON non valido' } });
  }
  gestisci(req);
});
