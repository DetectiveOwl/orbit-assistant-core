param([Parameter(Mandatory=$true)][string]$Stage)
$ErrorActionPreference='Stop'
if($Stage -cne $env:SMART_INBOX_TEST_STAGE){throw 'Stage diverso dal temporaneo sintetico'}
$clock=[Diagnostics.Stopwatch]::StartNew()
while(-not [IO.File]::Exists((Join-Path $Stage 'control/job-ready'))){if($clock.ElapsedMilliseconds -gt 10000){throw 'Job non assegnato'};Start-Sleep -Milliseconds 10}
foreach($key in @('HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP')){if(-not [Environment]::GetEnvironmentVariable($key).StartsWith($Stage,[StringComparison]::OrdinalIgnoreCase)){throw 'Ambiente non sintetico'}}
if(@([Environment]::GetEnvironmentVariables().Keys | Where-Object {$_ -match 'TOKEN|SECRET|CREDENTIAL|API_KEY|ORBIT_'}).Count){throw 'Variabile operativa ereditata'}
Add-Type -LiteralPath (Join-Path $Stage 'repo/smart-inbox/windows/Handles.cs'),(Join-Path $Stage 'repo/smart-inbox/windows/Engine.cs')
Add-Type -LiteralPath (Join-Path $Stage 'repo/smart-inbox/tests/ts3-map.cs')
[SmartInboxWindows.Root]::InitializeBoundary($Stage,$null)
$vault=Join-Path $Stage 'data/vault';$outside=Join-Path $Stage 'data/outside'
[void][IO.Directory]::CreateDirectory((Join-Path $vault 'liste'))
[void][IO.Directory]::CreateDirectory($outside)
[IO.File]::WriteAllText((Join-Path $vault 'liste/Nota.md'),'SINTETICO')
[IO.File]::WriteAllText((Join-Path $outside 'Esterno.md'),'ESTERNO_SINTETICO')
New-Item -ItemType Junction -Path (Join-Path $vault 'fuga') -Target $outside | Out-Null
$passed=@();$probes=@()
function Reject([string]$Name,[scriptblock]$Action){$failed=$false;try{&$Action}catch{$failed=$true};if(-not$failed){throw ('Diniego mancante: '+$Name)};$script:passed+=$Name}
function Mutator([string]$Mode){
 $child=[Diagnostics.Process]::new()
 try{
  $child.StartInfo.FileName=$env:SMART_INBOX_TEST_RUNTIME;$child.StartInfo.UseShellExecute=$false;$child.StartInfo.CreateNoWindow=$true;$child.StartInfo.Environment.Clear()
  foreach($key in @('SystemRoot','WINDIR','PATH','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','SMART_INBOX_TEST_STAGE','SMART_INBOX_TEST_RUNTIME')){$child.StartInfo.Environment[$key]=[Environment]::GetEnvironmentVariable($key)}
  foreach($arg in @('-NoLogo','-NoProfile','-NonInteractive','-File',(Join-Path $Stage 'repo/smart-inbox/tests/ts3-mutator.ps1'),'-Stage',$Stage,'-Mode',$Mode)){$child.StartInfo.ArgumentList.Add($arg)}
  $child.StartInfo.RedirectStandardOutput=$true;$child.StartInfo.RedirectStandardError=$true;[void]$child.Start()
  $stdout=$child.StandardOutput.ReadToEndAsync();$stderr=$child.StandardError.ReadToEndAsync()
  if(-not$child.WaitForExit(15000)){throw 'CHILD_CANARY_TIMEOUT'}
  if($child.ExitCode-ne0){throw ('Canarino figlio fallito: '+$stderr.GetAwaiter().GetResult())}
  $result=$stdout.GetAwaiter().GetResult()|ConvertFrom-Json
  if($result.pid-eq$PID){throw 'Il canarino non usa un processo distinto'}
  return $result
 }finally{$child.Dispose()}
}
$root=[SmartInboxWindows.Root]::new($vault)
try {
 $f=$root.Open('liste/Nota.md',$true)
 try {
  if($f.Length -ne 9){throw 'File diverso'}
  Reject 'SCRITTURA_ESTERNA_NEGATA' { $h=[IO.File]::Open((Join-Path $vault 'liste/Nota.md'),[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite);$h.Dispose() }
  Reject 'RINOMINA_DIRECTORY_NEGATA' { [IO.Directory]::Move((Join-Path $vault 'liste'),(Join-Path $vault 'spostata')) }
  Reject 'SOSTITUZIONE_FILE_NEGATA' { [IO.File]::Move((Join-Path $vault 'liste/Nota.md'),(Join-Path $vault 'liste/Spostata.md')) }
  $probes+=Mutator 'deny';$passed+='DUE_PROCESSI_DINIEGHI_REALMENTE_VERIFICATI'
 }finally{$f.Dispose()}
 Reject 'JUNCTION_NON_SEGUITA' { $h=$root.Open('fuga/Esterno.md',$false);$h.Dispose() }
 Reject 'TRAVERSAL_NEGATO' { $h=$root.Open('../outside/Esterno.md',$false);$h.Dispose() }
 [IO.File]::WriteAllText((Join-Path $vault 'liste/Hardlink.md'),'LINK_SINTETICO')
 if([SyntheticJunction]::TryHardLink((Join-Path $vault 'liste/Hardlink.md'),(Join-Path $outside 'Hardlink.md'))-ne0){throw 'HARDLINK_FIXTURE_NOT_CREATED'}
 $reason=$null
 try{$h=$root.Open('liste/Hardlink.md',$true);$h.Dispose()}catch{$cause=$_.Exception;while($cause.InnerException){$cause=$cause.InnerException};$reason=$cause.Message}
 if($reason-cne'LINK_REPARSE_OR_NONREGULAR'){throw ('EXISTING_HARDLINK_NOT_REJECTED '+$reason)}
 $passed+='HARDLINK_GIA_PRESENTE_RIFIUTATO'
 $created=$root.Create('liste/Nuova.md');try{$b=[Text.Encoding]::UTF8.GetBytes('NUOVA_SINTETICA');$created.Write($b);$created.Flush($true)}finally{$created.Dispose()}
 Reject 'COLLISIONE_CREATE_NEGATA' { $h=$root.Create('liste/NUOVA.md');$h.Dispose() }
 $root.MakeDirectory('metadata')
 $renamed=$root.Create('metadata/iniziale.tmp',$true)
 try{$b=[Text.Encoding]::UTF8.GetBytes('RENAME_SINTETICO');$renamed.Write($b);$renamed.Flush($true);[SmartInboxWindows.Root]::RenameInPlace($renamed,'finale.json');$renamed.Flush($true)}finally{$renamed.Dispose()}
 $passed+='RENAME_RELATIVO_SOTTO_DIRECTORY_PROTETTA'
 if([IO.File]::ReadAllText((Join-Path $vault 'metadata/finale.json'))-cne'RENAME_SINTETICO'){throw 'RENAME_WRONG_BYTES'}
 $collision=$root.Create('metadata/collision.tmp',$true)
 try{
  Reject 'RENAME_TRAVERSAL_NEGATO' {[SmartInboxWindows.Root]::RenameInPlace($collision,'../fuga.json')}
  $code=$null
  try{[SmartInboxWindows.Root]::RenameInPlace($collision,'finale.json')}catch{$cause=$_.Exception;while($cause.InnerException){$cause=$cause.InnerException};if($cause-isnot[ComponentModel.Win32Exception]-or$cause.NativeErrorCode-ne183){throw};$code=$cause.NativeErrorCode}
  if($code-ne183){throw 'RENAME_REPLACED_EXISTING'}
  $passed+='RENAME_NO_REPLACE'
 }finally{$collision.Dispose()}
 $root.PermitRenameIntoNonemptyDirectory('metadata','finale.json')
 $probes+=Mutator 'technical-pin';$passed+='DESTINAZIONE_TECNICA_NON_RINOMINABILE_NON_RETARGETTABILE'
 $archive=$root.Create('liste/Archivio.input',$true)
 try{
  $b=[Text.Encoding]::UTF8.GetBytes('ARCHIVIO_SINTETICO');$archive.Write($b);$archive.Flush($true)
  [SmartInboxWindows.Root]::Move($archive,$root,'metadata/archiviato.input')
  if([SmartInboxWindows.Root]::FileIdentity($archive)-eq''){throw 'ARCHIVE_ID_MISSING'}
 }finally{$archive.Dispose()}
 if([IO.File]::Exists((Join-Path $vault 'liste/Archivio.input'))-or[IO.File]::ReadAllText((Join-Path $vault 'metadata/archiviato.input'))-cne'ARCHIVIO_SINTETICO'){throw 'ARCHIVE_NOT_MOVED'}
 $passed+='ARCHIVE_RENAME_CON_DIRECTORY_FISSATA_DA_ANCHOR'
 $mappedPath=Join-Path $vault 'liste/Mappata.md'
 [IO.File]::WriteAllText($mappedPath,'MAPPATA_SINTETICA')
 $origin=[IO.FileStream]::new($mappedPath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite)
 $map=[IO.MemoryMappedFiles.MemoryMappedFile]::CreateFromFile($origin,('Local\SmartInboxSynthetic-'+[Guid]::NewGuid().ToString('N')),0,[IO.MemoryMappedFiles.MemoryMappedFileAccess]::ReadWrite,[IO.HandleInheritability]::None,$true)
 $view=$map.CreateViewAccessor();$origin.Dispose();$handle=$null
 try {
  try{$handle=$root.Open('liste/Mappata.md',$true)}catch{
   $cause=$_.Exception;while($cause.InnerException){$cause=$cause.InnerException}
   if($cause -isnot [ComponentModel.Win32Exception]-or$cause.NativeErrorCode-ne32){throw}
   $passed+='VISTA_MAPPATA_PREESISTENTE_NEGATA'
  }
  if($handle){
   $handle.Lock(0,[long]::MaxValue)
   $view.Write(0,[byte]88);$view.Flush();$handle.Position=0;$observed=$handle.ReadByte()
   [pscustomobject]@{probe='existing-writable-mapping';exclusiveHandleOpened=$true;byteLockHeld=$true;writtenByView=88;observedThroughPinnedHandle=$observed;unsafe=($observed-eq88)} | ConvertTo-Json -Compress
   throw 'MAPPED_VIEW_NOT_EXCLUDED: protezione insufficiente; nessun Safe Writer autorizzato a operare'
  }
 }finally{if($handle){$handle.Dispose()};$view.Dispose();$map.Dispose()}
 [IO.File]::WriteAllText($mappedPath,'MAPPATA_SINTETICA')
 $onlyView=[SyntheticWritableView]::new($mappedPath);$handle=$null
 try {
  $onlyView.Write([byte]77)
  if($onlyView.Byte-ne77){throw 'Vista nativa non scrivibile'}
  $deniedCode=$null
  try{$handle=$root.Open('liste/Mappata.md',$true)}catch{
   $cause=$_.Exception;while($cause.InnerException){$cause=$cause.InnerException}
   if($cause -isnot [ComponentModel.Win32Exception]-or$cause.NativeErrorCode-notin@(32,1224)){throw}
   $deniedCode=$cause.NativeErrorCode
  }
  if($handle){$handle.Lock(0,[long]::MaxValue);$onlyView.Write([byte]88);$handle.Position=0;$observed=$handle.ReadByte()}
  $proof=[pscustomobject]@{probe='native-view-only';fileHandleClosed=$onlyView.FileHandleClosed;mappingHandleClosed=$onlyView.MappingHandleClosed;viewWritable=$true;exclusiveOpenDenied=($null-ne$deniedCode);deniedCode=$deniedCode;byteObserved=$observed}
  if($handle){$proof|ConvertTo-Json -Compress|Write-Output;throw 'VIEW_ONLY_BYPASS: precondizione non garantita; nessun writer eseguito'}
  $probes+=$proof
  $passed+='SOLA_VISTA_NATIVA_NEGATA'
 }finally{if($handle){$handle.Dispose()};$onlyView.Dispose()}
 $passed+=@('APERTURA_RELATIVA_HANDLE','CREATE_ESCLUSIVA','FLUSH_DUREVOLE')
}finally{$root.Dispose()}
$probes+=Mutator 'control';$passed+='DUE_PROCESSI_CONTROLLO_DOPO_RILASCIO'
[pscustomobject]@{model='practical-cooperative';passed=$passed;probes=$probes;excludedDiagnostics=@('hostile-concurrent-hardlink','RWH-hardlink-barrier');parentPid=$PID;rootIdentity=$root.Identity;outsideUnchanged=([IO.File]::ReadAllText((Join-Path $outside 'Esterno.md')) -ceq 'ESTERNO_SINTETICO')} | ConvertTo-Json -Depth 5
