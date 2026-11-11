'use strict';
const fs = require('node:fs'), path = require('node:path');
const film = '# Film da guardare\n- Dune\n';
const casi = {
  film: { 'to sort/Film da guardare.md': film, 'liste/Film da vedere.md': '# Film da vedere\n- Alien\n', 'liste/Film già visti.md': '# Film già visti\n- Matrix\n' },
  noop: { 'to sort/Film da guardare.md': film, 'liste/Film da vedere.md': '# Film da vedere\n- Dune\n' },
  titolo: { 'to sort/Film da guardare.md': '', 'liste/Film da vedere.md': '# Film da vedere\n' },
  doppio: { 'to sort/Film da guardare.md': film, 'liste/A.md': '# Film da vedere\n', 'liste/B.md': '---\naliases: [Film da guardare]\n---\n# Cinema\n' },
  visto: { 'to sort/Film da guardare.md': film, 'liste/Film già visti.md': '# Film già visti\n- Alien\n' },
  protetto: { 'to sort/Appunto.md': '[[cervello/Profilo.md]]\n', 'liste/Indice.md': '# Indice\n' },
  operativo: { 'to sort/Appunto.md': '[bug](progetti/Orbit/bug.md)\n', 'liste/Indice.md': '# Indice\n' },
  assoluto: { 'to sort/Appunto.md': '[file](file:///C:/synthetic-forbidden/Profilo.md)\n' },
  directoryEsistente: { 'to sort/Ricette.md': '# Ricette\n' },
  crea: { 'to sort/Ricette.md': '# Ricette\n- Pasta\n' },
  assenza: { 'to sort/Ricette.md': '# Ricette\n- Pasta\n', 'liste/Musica.md': '# Musica\n- Jazz\n- Classica\n' },
  top: { 'to sort/Ricette.md': '# Ricette\n', 'liste/A.md': '# Musica\n', 'liste/B.md': '# Viaggi\n', 'liste/C.md': '# Sport\n' },
  checkbox: { 'to sort/Film da guardare.md': '# Film da guardare\n- [x] Dune\n', 'liste/Film da vedere.md': '# Film da vedere\n- [ ] Dune\n' },
  negazione: { 'to sort/Film da guardare.md': '# Film da guardare\n- Non guardare Dune\n', 'liste/Film da vedere.md': '# Film da vedere\n- Guardare Dune\n' },
  multipli: { 'to sort/A.md': '# Film da guardare\n- Dune\n- Dune\n', 'to sort/B.md': '# Film da guardare\n- Dune\n- Alien\n', 'liste/Film da vedere.md': '# Film da vedere\n- Moon\n' },
  nuovoDoppio: { 'to sort/a/Film.md': film, 'to sort/b/Film.md': film },
  nomeGenerico: { 'to sort/Libri.md': '# Libri da vendere\n- Dune\n', 'liste/Libri.md': '# Libri da comprare\n- Dune\n' },
  nomeGenericoMerge: { 'to sort/Libri.md': '# Libri da vendere\n- Dune\n', 'liste/Libri.md': '# Libri da comprare\n- Solaris\n' },
  aliasDiscordante: { 'to sort/A.md': '---\naliases: [Libri da comprare]\n---\n# Libri da vendere\n- Dune\n', 'liste/B.md': '# Libri da comprare\n- Solaris\n' },
  linkDiverso: { 'to sort/Ricette.md': '# Ricette\n- Pasta\n[[liste/Viaggi]]\n', 'liste/Viaggi.md': '# Viaggi\n- Roma\n' },
  nuoveIdentiche: { 'to sort/A.md': '# Ricette\n- Pasta\n', 'to sort/B.md': '# Ricette\n- Pasta\n' },
  nuoveIncerte: { 'to sort/A.md': '# Ricette\n- Pasta\n', 'to sort/B.md': '# Ricette\n- Risotto\n' },
  nuoveDistinte: { 'to sort/A.md': '# Ricette\n- Pasta\n', 'to sort/B.md': '# Viaggi\n- Roma\n' },
  nuoveUnitaComuni: { 'to sort/A.md': '# Ricette\n- Pasta\n', 'to sort/B.md': '# Cucina\n- Pasta\n- Risotto\n' },
  hashLetterale: { 'to sort/CSharp.md': '# C#', 'liste/C.md': '# C' },
  hashDiversi: { 'to sort/A.md': '# C##', 'liste/B.md': '# C#' },
  hashChiusura: { 'to sort/A.md': '# C# ###', 'liste/B.md': '# C#' },
  nuoveHash: { 'to sort/A.md': '# C', 'to sort/B.md': '# C#' },
  nuoveSenzaTitolo: { 'to sort/Da vendere.md': '- Dune\n', 'to sort/Da comprare.md': '- Dune\n' },
  fence: { 'to sort/Codice.md': '# Codice\n````md\nprima\n```\n- interno\n````\n', 'liste/Codice.md': '# Codice\n````md\nprima\n```\n- altrove\n````\n' },
  fenceNonSupportato: { 'to sort/Codice.md': '# Codice\n    ```\n    - contenuto\n    ```\n', 'liste/Codice.md': '# Codice\n' },
  lettura: { 'to sort/Nota.md': '# Nota\ncontenuto\n', 'liste/Errore.md': '# Nota\ncontenuto\n' },
  parziale: { 'to sort/Nota.md': '# Nota\ncontenuto\n', 'liste/Parziale.md': '# Nota\ncontenuto lungo\n' },
  yaml: { 'to sort/Nota.md': '# Nota\n', 'liste/Complesso.md': '---\naliases:\n  oggetto: annidato\n---\n# Nota\n' },
  utf8: { 'to sort/Nota.md': '# Nota\n', 'liste/NonUTF8.md': Buffer.from([0xff]) },
  metadati: { 'to sort/È vuota.md': '', 'liste/École.md': '---\ntitle: Scuola\naliases: [École, Scuola serale]\n---\n# Scuola\n## Programma\n- [ ] Non saltare\n[[Viaggi#Roma]]\n[testo](note/Italia.md)\n' },
  collisione: { 'to sort/Nota.md': '# Nota\n', 'liste/é.md': 'prima', 'liste/e\u0301.md': 'seconda' },
  esclusi: { 'to sort/Nota.md': '# Nota\n', 'liste/cervello/Profilo.md': 'CONTENUTO_SINTETICO_NON_LEGGERE', 'privato/Segreto.md': 'SINTETICO' },
  p5: { 'to sort/Analisi.md': '# Analisi Matematica 1\nNuova lezione sintetica\n', 'corsi/Analisi Matematica 1/Analisi Matematica 1.md': '# Analisi Matematica 1\nLezione precedente\n' }
};
function prepara(root) {
  for (const [nome, files] of Object.entries(casi)) {
    for (const dir of ['to sort', 'liste']) fs.mkdirSync(path.join(root, nome, dir), { recursive: true });
    for (const [rel, text] of Object.entries(files)) {
      const p = path.join(root, nome, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text);
    }
  }
  fs.mkdirSync(path.join(root, 'senzaInbox/liste'), { recursive: true });
  fs.mkdirSync(path.join(root, 'directoryEsistente/liste/Ricette.md'), { recursive: true });
  fs.mkdirSync(path.join(root, 'nuoveIdentiche/liste/altre'), { recursive: true });
  fs.mkdirSync(path.join(root, 'esternoSintetico'), { recursive: true });
  fs.writeFileSync(path.join(root, 'esternoSintetico/Segreto.md'), 'SOLO_FIXTURE');
  fs.mkdirSync(path.join(root, 'link/to sort'), { recursive: true }); fs.mkdirSync(path.join(root, 'link/liste'), { recursive: true });
  fs.symlinkSync(path.join(root, 'esternoSintetico'), path.join(root, 'link/to sort/fuga'), 'junction');
  fs.symlinkSync(path.join(root, 'film'), path.join(root, 'antenato'), 'junction');
}
if (process.argv.includes('--prepare')) prepara(process.argv.at(-1));
module.exports = { casi };
