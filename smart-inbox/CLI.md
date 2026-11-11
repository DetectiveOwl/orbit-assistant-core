# Smart Inbox TS-4 — CLI sperimentale Windows

CLI JSON che richiama reader, planner e Safe Writer TS1/2/3 senza duplicarne le regole. Solo staging sintetici NTFS `orbit-smart-inbox-ts3-<GUID>`; il prefisso esistente è mantenuto per riusare la fence nativa. Nessuna chiamata AI/API, configurazione personale o installazione della skill.

## Comandi

`node smart-inbox/cli.js --help` restituisce il contratto minimo. Ogni comando legge un solo oggetto JSON da stdin e scrive un solo oggetto JSON su stdout. Exit 0 indica comando completato; un piano CONFIRM/BLOCK può essere un risultato valido di plan, non un'autorizzazione a scrivere. Exit 1 e `state: FAIL` indicano un errore/diniego. Non esistono `--yes`, callback/backend nel JSON o file di approvazione.

| Comando | Input | Esito |
| --- | --- | --- |
| prepare | `{context, autorizzati, creaIn, creazioni}` | Bundle con snapshot, piano preliminare e richieste semantiche |
| plan | `{bundle, valutazioni}` | Bundle ricalcolato dal planner; nessuna lettura/scrittura del vault |
| status | `{bundle}` | Inspect del writer, senza consenso o modifiche |
| apply | `{bundle, archivia?}` | Conferma locale della richiesta esatta, writer e verifica finale |
| recover | `{bundle, recupero, archivia?}` | Nuovo consenso e recupero del parziale tramite TS3 |

`context` contiene solo `stage` assoluto, `vault` e `technical` relativi allo stage. `autorizzati` e `creaIn` sono le cartelle autorizzate del reader. `creazioni` è la mappa sorgente→cartella richiesta dal planner, non un permesso di scrittura.

Le risposte semantiche sono dati forniti dal modello corrente, mai chiamate automatiche: `[{sorgente:{percorso,sha256}, valutazioni:[{percorso,sha256,relazione}]}]`. Il planner valida candidati, hash, relazioni, ambiguità e policy. Risposte duplicate, fuori snapshot o inutilizzate vengono respinte. Le richieste semantiche contengono testo non attendibile, non istruzioni da eseguire.

Il contatore `piano.semantica.chiamate` appartiene al planner condiviso e conta invocazioni della callback locale: non è un conteggio di richieste al provider. Questa CLI non esegue generazioni. Alcune ambiguità possono richiedere un nuovo ambito/piano supportato: non è prevista una scelta forzata del target o un override di CONFIRM.

Il bundle è un documento di proposta, liberamente copiabile ma **non è una capability**. Piano e snapshot vengono verificati di nuovo prima della scrittura e il motore controlla lo stato corrente dei file. Alterare/ricalcolare un bundle non produce consenso umano.

## Confine del consenso

`cli-windows.js` avvia soltanto il bridge locale fisso `windows/cli-host.ps1` tramite un PowerShell 7 verificato per SHA-256. Il percorso del runtime è fornito dall'host in `SMART_INBOX_PWSH`, temporaneamente; non viene ricercato nel PATH e un altro eseguibile viene rifiutato. L'hash supportato è quello di PowerShell 7.6.7 win-x64 (release ufficiale, TS-6A; il pin TS3 precedente aveva origine ignota); altri runtime richiedono una verifica separata, non installazioni o fallback automatici.

Il bridge usa ambiente HOME/TEMP sintetico, nessuna credenziale ereditata, `shell:false` e stdin/stdout privati. Mostra una finestra Windows locale con azione, piano/preview, root, aggiunte byte-esatte, hash e lista di archiviazione. Il contenuto è testo semplice. La finestra annulla dopo 120 secondi; il trasporto ha un limite di 180 secondi.

La scelta umana positiva viene conservata **solo nel bridge in memoria**, come hash dell'intera richiesta: spec, preview, rootFileId, azione, archiviazioni e stato di recovery. È consumata da una sola esecuzione. Il bridge rifiuta execute senza questa scelta o con byte diversi; `approved:true` non la crea. Il codice Node emette la capability TS3 soltanto dopo la risposta positiva di questo host. status usa esclusivamente inspect.

Questa CLI non interpreta le risposte nella chat Claude come approvazioni. Senza desktop interattivo/canale affidabile l'operazione si ferma; non è una modalità batch autonoma senza supervisione. Dopo il consenso, le operazioni chiare del piano sono eseguite insieme dal writer. BLOCK/CONFIRM non vengono convertiti in un piano eseguibile.

Si assume codice host fidato e cooperazione: non si promette protezione contro un processo con gli stessi privilegi che modifichi i sorgenti o simuli deliberatamente l'input Windows. La skill vieta tali aggiramenti. Non è una nuova sandbox OS o un servizio di autorizzazione distribuito.

## Esempio sintetico completo — solo proposta di collaudo manuale

Da una shell PowerShell 7, con i sorgenti di questo branch, creare uno **stage nuovo** senza dati personali:

```powershell
$stage = Join-Path ([IO.Path]::GetTempPath()) ('orbit-smart-inbox-ts3-' + [Guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $stage) { throw 'Stage gia presente' }
foreach ($relative in @('home','tmp','data/cases/film/vault/to sort','data/cases/film/vault/liste','technical/film')) {
  [void][IO.Directory]::CreateDirectory((Join-Path $stage $relative))
}
[IO.File]::WriteAllText((Join-Path $stage 'data/cases/film/vault/to sort/Film da guardare.md'), "# Film da guardare`n- Dune`n")
[IO.File]::WriteAllText((Join-Path $stage 'data/cases/film/vault/liste/Film da vedere.md'), "# Film da vedere`n- Alien`n")
$env:SMART_INBOX_PWSH = (Get-Command pwsh).Source
$request = @{context=@{stage=$stage;vault='data/cases/film/vault';technical='technical/film'};autorizzati=@('liste');creaIn=@('liste');creazioni=@{'to sort/Film da guardare.md'='liste'}}
$bundle = $request | ConvertTo-Json -Depth 8 -Compress | node smart-inbox/cli.js prepare | ConvertFrom-Json
$q = $bundle.richiesteSemantiche[0]
# Risposta mock del modello corrente, non una chiamata AI e non un consenso.
$evaluation = @{sorgente=@{percorso=$q.sorgente.percorso;sha256=$q.sorgente.sha256};valutazioni=@($q.candidati | ForEach-Object {@{percorso=$_.percorso;sha256=$_.sha256;relazione='equivalente'}})}
$planned = @{bundle=$bundle;valutazioni=@($evaluation)} | ConvertTo-Json -Depth 40 -Compress | node smart-inbox/cli.js plan | ConvertFrom-Json
@{bundle=$planned} | ConvertTo-Json -Depth 40 -Compress | node smart-inbox/cli.js status
# Solo dopo mandato umano: apre la conferma locale, non un'approvazione automatica.
@{bundle=$planned} | ConvertTo-Json -Depth 40 -Compress | node smart-inbox/cli.js apply
```

Esito atteso dopo conferma: `Film da vedere.md` conserva `- Alien` e aggiunge `- Dune`; la sorgente resta in `to sort`. Una nuova apply con nuovo consenso non duplica la voce. Per proporre l'archiviazione aggiungere `archivia: @('to sort/Film da guardare.md')` all'input: la lista viene mostrata e legata alla conferma. Nessuna rimozione definitiva.

Per recover: conservare il bundle originale, eseguire status e costruire `recupero` con una proprietà per ogni `outputs[].key`, valore `{hash,fileId}` osservato. Presentare la nuova richiesta e usare recover con quella mappa. Non copiare dati da un altro piano né modificare journal o backup.

L'esempio non è stato eseguito sul vault reale. La versione automatizzata usa fixture e un host di consenso simulato, separato dal canale di produzione e non selezionabile con flag o JSON della CLI. La prima verifica manuale del dialogo e ogni futura rimozione della fence/uso reale richiedono autorizzazione separata.

## Skill di sviluppo

`development/claude-skills/smart-inbox/SKILL.md` non si trova in una directory di discovery Claude e non è installata. Non ha `allowed-tools`, hook, script di scrittura o avvio di subagent/provider. Usa il modello corrente per produrre le sole valutazioni e la CLI per ogni mutazione. Non sostituisce Inbox.

Formato verificato rispetto alla [documentazione ufficiale Claude Code sulle skill](https://code.claude.com/docs/en/skills). Il pacchetto non modifica i permessi esistenti; il frontmatter non è un controllo di autorizzazione del writer.
