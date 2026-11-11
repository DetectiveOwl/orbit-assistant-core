'use strict';
// Rendering Markdown sicuro e minimale: il testo viene prima escapato, poi si riconosce solo una sintassi ristretta.
// Nessun HTML del modello arriva al DOM e i link ammessi sono solo http(s).
(function (root) {
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function inline(s) {
    return s
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)"<>]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  function render(src) {
    const righe = esc(src).split('\n');
    let html = '', lista = null, para = [], codice = null;
    const chiudiPara = () => { if (para.length) { html += '<p>' + para.map(inline).join('<br>') + '</p>'; para = []; } };
    const chiudiLista = () => { if (lista) { html += '</' + lista + '>'; lista = null; } };
    for (const raw of righe) {
      const l = raw.replace(/\s+$/, '');
      if (codice !== null) {
        if (/^```/.test(l)) { html += '<pre><code>' + codice.join('\n') + '</code></pre>'; codice = null; } else codice.push(raw);
        continue;
      }
      if (/^```/.test(l)) { chiudiPara(); chiudiLista(); codice = []; continue; }
      if (!l.trim()) { chiudiPara(); chiudiLista(); continue; }
      let m;
      if ((m = l.match(/^#{1,4}\s+(.*)$/))) { chiudiPara(); chiudiLista(); html += '<h4>' + inline(m[1]) + '</h4>'; continue; }
      if ((m = l.match(/^\s*[-*]\s+(.*)$/))) { chiudiPara(); if (lista !== 'ul') { chiudiLista(); html += '<ul>'; lista = 'ul'; } html += '<li>' + inline(m[1]) + '</li>'; continue; }
      if ((m = l.match(/^\s*\d+[.)]\s+(.*)$/))) { chiudiPara(); if (lista !== 'ol') { chiudiLista(); html += '<ol>'; lista = 'ol'; } html += '<li>' + inline(m[1]) + '</li>'; continue; }
      if ((m = l.match(/^&gt;\s?(.*)$/))) { chiudiPara(); chiudiLista(); html += '<blockquote>' + inline(m[1]) + '</blockquote>'; continue; }
      if (/^---+$/.test(l.trim())) { chiudiPara(); chiudiLista(); html += '<hr>'; continue; }
      chiudiLista(); para.push(l);
    }
    if (codice !== null) html += '<pre><code>' + codice.join('\n') + '</code></pre>';
    chiudiPara(); chiudiLista();
    return html;
  }

  // Testo adatto alla sintesi vocale: niente simboli markdown, niente blocchi di codice.
  function perVoce(src) {
    const numero = String(src).trim().match(/^(-?)(\d{1,9})(?:,(\d{1,6}))?\.$/);
    if (numero) {
      const t = (numero[1] ? 'meno ' : '') + numeroInLettere(Number(numero[2])) +
        (numero[3] ? ' virgola ' + [...numero[3]].map(n => numeroInLettere(Number(n))).join(' ') : '');
      return t[0].toUpperCase() + t.slice(1) + '.';
    }
    return normalizzaPerVoce(String(src)
      .replace(/^\s*(note usate|note consultate|fonti)\s*:.*$/gim, '')             // l'elenco delle fonti si vede a schermo, non si legge
      .replace(/^\s*(?:\d+[.)]|[-*•])\s+/gm, '')                     // via i numeri e i puntini degli elenchi
      .replace(/([^.!?:;\n])\s*\n+(?=\S)/g, '$1. ')                  // a capo senza punto: pausa
      .replace(/\b[\w./-]+\.md\b/g, 'le tue note')).replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_#>|~]/g, ' ').replace(/\s+/g, ' ').replace(/\s+([.,:;!?])/g, '$1').trim();
  }

  function numeroInLettere(n) {
    const unita = ['zero', 'uno', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove', 'dieci', 'undici', 'dodici', 'tredici', 'quattordici', 'quindici', 'sedici', 'diciassette', 'diciotto', 'diciannove'];
    if (n < 20) return unita[n];
    if (n < 100) {
      const decine = ['', '', 'venti', 'trenta', 'quaranta', 'cinquanta', 'sessanta', 'settanta', 'ottanta', 'novanta'];
      const u = n % 10, d = decine[Math.floor(n / 10)];
      return (u === 1 || u === 8 ? d.slice(0, -1) : d) + (u ? u === 3 ? 'tré' : unita[u] : '');
    }
    if (n < 1000) {
      const r = n % 100, c = (n < 200 ? '' : unita[Math.floor(n / 100)]) + 'cento';
      return (r === 8 || r >= 80 && r < 90 ? c.slice(0, -1) : c) + (r === 3 ? 'tré' : r ? numeroInLettere(r) : '');
    }
    if (n < 1000000) return (n < 2000 ? 'mille' : numeroInLettere(Math.floor(n / 1000)).replace(/é$/, 'e') + 'mila') + (n % 1000 === 3 ? 'tré' : n % 1000 ? numeroInLettere(n % 1000) : '');
    return (n < 2000000 ? 'un milione' : numeroInLettere(Math.floor(n / 1000000)) + ' milioni') + (n % 1000000 ? ' ' + numeroInLettere(n % 1000000) : '');
  }

  // Il sintetizzatore legge male sigle e numeri compatti: li si scrive come si pronunciano.
  function normalizzaPerVoce(t) {
    return t
      .replace(/\b(\d{1,2})h(\d{2})\b/g, (_, o, mn) => o + (o === '1' ? ' ora e ' : ' ore e ') + Number(mn))
      .replace(/\b(\d{1,2})h\b/g, (_, o) => o + (o === '1' ? ' ora' : ' ore'))
      .replace(/\b(\d+)\s?min\b/g, '$1 minuti')
      .replace(/(\d+)\s?%/g, '$1 per cento')
      .replace(/\bPDF\b/g, 'pi di effe')
      .replace(/\bpp\.\s?/g, 'pagine ')
      .replace(/\bes\.\s/g, 'esempio ')
      .replace(/→|->/g, ' poi ')
      .replace(/\b([A-Z]{1,2})(\d)\b/g, '$1 $2');
  }

  const api = { render, perVoce, esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.OrbitMarkdown = api;
})(typeof window !== 'undefined' ? window : globalThis);
