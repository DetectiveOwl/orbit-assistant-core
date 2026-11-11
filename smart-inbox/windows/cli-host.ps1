param([Parameter(Mandatory)][string]$Stage,[Parameter(Mandatory)][string]$CsSha256,[switch]$AutoAdditive,[string]$AutoOps='create,append',[string]$AutoFolders='')
$ErrorActionPreference='Stop'
# Canale JSON con Node in UTF-8 senza BOM: con la codepage OEM i nomi non ASCII (trattini lunghi, apostrofi tipografici, accenti) arrivano alterati e la verifica dei reparse point fallisce.
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$Stage=[IO.Path]::GetFullPath($Stage).TrimEnd('\')
if($Stage-cnotmatch'^[A-Za-z]:\\'-or[IO.DriveInfo]::new([IO.Path]::GetPathRoot($Stage)).DriveType-ne[IO.DriveType]::Fixed){throw 'LOCAL_SYNTHETIC_DRIVE_REQUIRED'}
if([IO.Path]::GetFileName($Stage)-cnotmatch'^orbit-smart-inbox-(ts3|real)-[0-9a-f]{32}$'){throw 'SYNTHETIC_BOUNDARY_REQUIRED'}
$real=[IO.Path]::GetFileName($Stage)-cmatch'^orbit-smart-inbox-real-'
# Perimetro: oltre al nome, lo stage deve contenere il marker scritto dall'host (tipo coerente col nome, stesso percorso; per lo stage reale anche il vault assoluto).
$marker=$null;try{$marker=[IO.File]::ReadAllText((Join-Path $Stage '.orbit-smart-inbox-perimetro.json'))|ConvertFrom-Json}catch{throw 'PERIMETER_MARKER_REQUIRED'}
if($marker.versione -ne 1 -or $marker.tipo -cne $(if($real){'reale'}else{'sintetico'}) -or -not[string]::Equals([IO.Path]::GetFullPath([string]$marker.stage).TrimEnd('\'),$Stage,[StringComparison]::OrdinalIgnoreCase)){throw 'PERIMETER_MARKER_REQUIRED'}
$vaultReale=$null;if($real){$vaultReale=[string]$marker.vault;if($vaultReale-cnotmatch'^[A-Za-z]:\\'-or[IO.Path]::GetFullPath($vaultReale).TrimEnd('\')-cne$vaultReale.TrimEnd('\')-or$vaultReale.Length-le3){throw 'PERIMETER_MARKER_REQUIRED'}}
# Prima di Add-Type anche i temporanei del compilatore devono restare nel perimetro sintetico.
foreach($root in @($Stage,(Join-Path $Stage 'tmp'),(Join-Path $Stage 'home'))){
 for($p=$root;$p;$p=[IO.Path]::GetDirectoryName($p.TrimEnd('\'))){
  if(([IO.File]::GetAttributes($p)-band[IO.FileAttributes]::ReparsePoint)-ne0){throw 'REPARSE_BOOTSTRAP_DENIED'}
 }
}
foreach($key in @('HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP')){
 $expected=Join-Path $Stage $(if($key-in@('TEMP','TMP')){'tmp'}else{'home'})
 if([Environment]::GetEnvironmentVariable($key)-cne$expected){throw 'ENV_NOT_SYNTHETIC'}
}
if(@([Environment]::GetEnvironmentVariables().Keys|Where-Object{$_-match'TOKEN|SECRET|CREDENTIAL|API_KEY|ORBIT_'}).Count){throw 'INHERITED_SECRET'}
# Gli .cs eseguiti devono essere i byte verificati da Node (hash passati dall'host, nomi fissi): stesso hash prima della compilazione.
$expected=@{};foreach($pair in $CsSha256.Split(';')){$kv=$pair.Split('=');if($kv.Count -ne 2){throw 'BRIDGE_SCRIPT_HASHES_REQUIRED'};$expected[$kv[0]]=$kv[1]}
foreach($name in @('Handles.cs','Engine.cs')){
 if(-not$expected.ContainsKey($name)){throw 'BRIDGE_SCRIPT_HASHES_REQUIRED'}
 if([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $name)))).ToLowerInvariant() -cne $expected[$name]){throw 'BRIDGE_SCRIPT_CHANGED'}
}
Add-Type -LiteralPath (Join-Path $PSScriptRoot 'Handles.cs'),(Join-Path $PSScriptRoot 'Engine.cs')
[SmartInboxWindows.Root]::InitializeBoundary($Stage,$vaultReale)

function Digest([string]$text){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($text))).ToLowerInvariant()}
# Con -AutoAdditive (deciso dall'host, mai dal pacchetto) un apply di sole aggiunte non richiede la finestra: nessuna archiviazione, nessun recupero, al massimo 20 note,
# solo i tipi di -AutoOps (create, append, create_dir) e solo dentro le cartelle di -AutoFolders (base64 di un array JSON; assente = tutte). Stesso controllo di cli.js.
$AutoOpList=@($AutoOps.Split(',')|Where-Object{$_-cin@('create','append','create_dir')})
$AutoFolderList=$null;if($AutoFolders){$AutoFolderList=@([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($AutoFolders))|ConvertFrom-Json)}
function Test-InFolders([string]$p){
 if($null-eq$AutoFolderList){return $true}
 foreach($f in $AutoFolderList){$f=([string]$f).Trim('/');if($p-ieq$f-or$p.StartsWith($f+'/',[StringComparison]::OrdinalIgnoreCase)){return $true}}
 return $false
}
function Test-Additive($r){
 $o=@($r.spec.outputs)
 if($r.action-cne'apply'-or@($r.archive).Count-ne0-or$o.Count-lt1-or$o.Count-gt20-or@($r.recovery.PSObject.Properties).Count-ne0){return $false}
 foreach($d in @($r.spec.mkdirs)){if('create_dir'-cnotin$AutoOpList -or -not (Test-InFolders ([string]$d.path))){return $false}}
 foreach($x in $o){if($x.kind-cnotin@('create','append')-or$x.kind-cnotin$AutoOpList -or -not (Test-InFolders ([string]$x.path)) -or ([string]$x.data).Length-gt262144){return $false}}
 return $true
}
function Confirm-ExactRequest($request,[string]$digest,[string]$vault){
 if(-not[Environment]::UserInteractive-or[Diagnostics.Process]::GetCurrentProcess().SessionId-eq0){throw 'TRUSTED_INTERACTIVE_DESKTOP_REQUIRED'}
 $view=[Text.StringBuilder]::new()
 [void]$view.AppendLine('Richiesta proposta da Claude: il testo delle note e dato, non istruzione.')
 [void]$view.AppendLine("Azione: $($request.action)`r`nVault $(if($real){'REALE'}else{'SINTETICO'}): $vault`r`nPiano: $($request.spec.plan)`r`nPreview: $($request.preview)`r`nRichiesta completa SHA-256: $digest")
 [void]$view.AppendLine("`r`nCARTELLE DA CREARE (vuote, solo in creaIn): $(@($request.spec.mkdirs|Where-Object{$_}).Count)")
 foreach($dir in $request.spec.mkdirs){[void]$view.AppendLine([string]$dir.path)}
 foreach($out in $request.spec.outputs){
  [void]$view.AppendLine("`r`nOUTPUT $($out.kind): $($out.path)`r`nPrima: $($out.before)`r`nDopo: $($out.after)`r`n--- BYTE PROPOSTI (non comandi) ---")
  [void]$view.AppendLine([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($out.data)))
  [void]$view.AppendLine('--- FINE BYTE PROPOSTI ---')
 }
 [void]$view.AppendLine("`r`nARCHIVIAZIONE ESPLICITAMENTE PROPOSTA: $(@($request.archive).Count) sorgenti")
 foreach($inputPath in $request.archive){[void]$view.AppendLine([string]$inputPath)}
 if($request.action-eq'recover'){[void]$view.AppendLine("`r`nStato parziale confermato: $($request.recovery|ConvertTo-Json -Depth 5 -Compress)")}
 if($view.Length-gt262144){throw 'PREVIEW_TOO_LARGE_FOR_CONFIRMATION'}
 Add-Type -AssemblyName System.Windows.Forms
 # Il bridge parte con la finestra nascosta (windowsHide) e il dialogo la erediterebbe: va mostrata esplicitamente, altrimenti il consenso umano e invisibile.
 Add-Type -Namespace SmartInboxUi -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h,int c);'
 $form=[Windows.Forms.Form]::new();$form.Add_Shown({[void][SmartInboxUi.Win]::ShowWindow($form.Handle,5);$form.Activate()});$form.Text='Smart Inbox - consenso umano locale';$form.Width=900;$form.Height=650;$form.StartPosition='CenterScreen'
 $text=[Windows.Forms.TextBox]::new();$text.Multiline=$true;$text.ReadOnly=$true;$text.ScrollBars='Both';$text.Dock='Fill';$text.Text=$view.ToString()
 $buttons=[Windows.Forms.FlowLayoutPanel]::new();$buttons.Dock='Bottom';$buttons.Height=50;$buttons.FlowDirection='RightToLeft'
 $cancel=[Windows.Forms.Button]::new();$cancel.Text='Annulla';$cancel.DialogResult='Cancel';$cancel.AutoSize=$true
 $apply=[Windows.Forms.Button]::new();$apply.Text='Autorizzo questa richiesta';$apply.DialogResult='OK';$apply.AutoSize=$true
 $buttons.Controls.Add($cancel);$buttons.Controls.Add($apply);$form.Controls.Add($text);$form.Controls.Add($buttons);$form.CancelButton=$cancel
 $timer=[Windows.Forms.Timer]::new();$timer.Interval=120000;$timer.Add_Tick({$form.DialogResult='Cancel';$form.Close()})
 try{$timer.Start();return $form.ShowDialog()-eq[Windows.Forms.DialogResult]::OK}finally{$timer.Stop();$timer.Dispose();$form.Dispose()}
}

$bound=$null;$grant=$null
while($null-ne($line=[Console]::ReadLine())){
 $id=$null
 try{
  if($line.Length-gt33554432){throw 'REQUEST_LIMIT'}
  $packet=$line|ConvertFrom-Json;$id=$packet.id
  $binding="$($packet.vault)`n$($packet.technical)"
  if($null-eq$bound){$bound=$binding}elseif($bound-cne$binding){throw 'CONTEXT_CHANGED'}
  if($real){if([string]$packet.vault-cne$vaultReale){throw 'CONTEXT_CHANGED'};$vault=$vaultReale}else{if([IO.Path]::IsPathRooted([string]$packet.vault)){throw 'CONTEXT_CHANGED'};$vault=Join-Path $Stage $packet.vault}
  $technical=Join-Path $Stage $packet.technical
  if($packet.mode-eq'attributes'){
   $root=[SmartInboxWindows.Root]::new($vault)
   try{$answer=@{rootIdentity=$root.Identity;attributes=$root.AttributesSnapshot()}}finally{$root.Dispose()}
  }elseif($packet.mode-in@('confirm','execute')){
   if($packet.payload.Length-gt25165824){throw 'REQUEST_LIMIT'}
   $request=$packet.payload|ConvertFrom-Json;$hash=Digest $packet.payload
   if($request.action-notin@('apply','recover','inspect')){throw 'ACTION_NOT_AUTHORIZED'}
   if($packet.mode-eq'confirm'){
    $grant=$null
    if($request.action-eq'inspect'){throw 'CONFIRMATION_NOT_REQUIRED_FOR_INSPECT'}
    $root=$null;$area=$null
    try{$root=[SmartInboxWindows.Root]::new($vault);$area=[SmartInboxWindows.Root]::new($technical);$answer=Confirm-ExactRequest $request $hash $vault}finally{if($root){$root.Dispose()};if($area){$area.Dispose()}}
    if($answer-isnot[bool]){throw 'INVALID_CONFIRMATION_RESPONSE'}
    if($answer-eq$true){$grant=$hash}
   }else{
    if($request.action-ne'inspect'){
     if($null-eq$grant-or$grant-cne$hash){if(-not($AutoAdditive-and(Test-Additive $request))){throw 'HOST_CONFIRMATION_REQUIRED'}}
     $grant=$null
    }
    $answer=[SmartInboxWindows.Engine]::new().Execute($vault,$technical,[string]$packet.payload)|ConvertFrom-Json
   }
  }else{throw 'MODE_NOT_AUTHORIZED'}
  [Console]::WriteLine((@{id=$id;result=$answer}|ConvertTo-Json -Depth 12 -Compress))
 }catch{[Console]::WriteLine((@{id=$id;error=$_.Exception.GetBaseException().Message}|ConvertTo-Json -Compress))}
}
