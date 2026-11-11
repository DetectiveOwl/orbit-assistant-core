param([switch]$NativeOnly)
$ErrorActionPreference='Stop'
$env:GIT_OPTIONAL_LOCKS='0'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if((git -C $repo branch --show-current) -cne 'codex/smart-inbox-ts3' -or (git -C $repo rev-parse main) -cne 'e4a6b37bc663ba79dd9ccabdba0a5484dd9eaf5c'){throw 'Baseline TS3 diversa'}
$manifest='<PERCORSO-WORKTREE>/risultati/backend-b0006/sandbox/b0006/manifest-codice-proposto.json'
if((Get-FileHash -LiteralPath $manifest).Hash -cne '7CAD074B2B697F2C3B2C8C8A4CB5EE6CE191398CFCC279F21CC81AA2855A9C48'){throw 'Manifest B6 diverso'}
$id=[Guid]::NewGuid().ToString('N');$stage=Join-Path ([IO.Path]::GetTempPath()) ('orbit-smart-inbox-ts3-'+$id)
$evidence=Join-Path $repo ('risultati/ts3-native-'+$id)
if(Test-Path -LiteralPath $stage){throw 'Stage gia esistente'}
for($p=[IO.Path]::GetTempPath();$p;$p=[IO.Path]::GetDirectoryName($p.TrimEnd('\'))){if(([IO.File]::GetAttributes($p)-band[IO.FileAttributes]::ReparsePoint)-ne0){throw 'TEMP reindirizzato'}}
foreach($p in @($stage,$evidence,(Join-Path $stage 'control'),(Join-Path $stage 'tmp'),(Join-Path $stage 'home'))){[void][IO.Directory]::CreateDirectory($p)}
$files=@('smart-inbox/windows/Handles.cs','smart-inbox/windows/Engine.cs','smart-inbox/tests/ts3-handles.ps1','smart-inbox/tests/ts3-map.cs','smart-inbox/tests/ts3-mutator.ps1',
 'smart-inbox/tests/ts3-worker.ps1','smart-inbox/tests/ts3-backend.cjs','smart-inbox/tests/ts3-fixtures.cjs','smart-inbox/tests/ts3-writer.test.js','smart-inbox/tests/ts3-guard.cjs',
 'smart-inbox/writer.js','smart-inbox/planner.js','smart-inbox/policy.js','smart-inbox/reader.js','memoria/analisi.js',
 'smart-inbox/tests/canary.cjs','smart-inbox/tests/fixtures.cjs','smart-inbox/tests/reader.test.js','smart-inbox/tests/planner.test.js')
$hashes=[ordered]@{}
$mapped=[ordered]@{}
foreach($f in $files){
 $source=Join-Path $repo $f
 for($p=$source;$p;$p=[IO.Path]::GetDirectoryName($p)){if(([IO.File]::GetAttributes($p)-band[IO.FileAttributes]::ReparsePoint)-ne0){throw 'Sorgente reindirizzato'};if($p-ceq$repo){break}}
 $relative=if($f-eq'smart-inbox/tests/ts3-guard.cjs'){'smart-inbox/tests/guard.cjs'}else{$f}
 $dest=Join-Path $stage ('repo/'+$relative);[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($dest));$mapped[$f]=$relative
 [IO.File]::WriteAllBytes($dest,[IO.File]::ReadAllBytes($source));$hashes[$f]=(Get-FileHash -LiteralPath $source).Hash
 if((Get-FileHash -LiteralPath $dest).Hash-cne$hashes[$f]){throw 'Hash diverso'}
}
Add-Type -LiteralPath (Join-Path $PSScriptRoot 'ts3-job.cs')
$pwsh=(Get-Command pwsh).Source
$p=[Diagnostics.Process]::new();$job=[SmartInboxTS3Job]::Create();$timer=[Diagnostics.Stopwatch]::StartNew();$started=$false
$result=[ordered]@{stage=$stage;hashes=$hashes;runtime=$pwsh;runtimeSha256=(Get-FileHash -LiteralPath $pwsh).Hash;runnerSha256=(Get-FileHash -LiteralPath $PSCommandPath).Hash;jobHelperSha256=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'ts3-job.cs')).Hash;phase='native-feasibility';isolation='trusted-synthetic-canary-no-Orbit-import';externalWatchdogMs=90000}
try {
 $p.StartInfo.FileName=$pwsh;$p.StartInfo.UseShellExecute=$false;$p.StartInfo.CreateNoWindow=$true;$p.StartInfo.WorkingDirectory=$stage
 $p.StartInfo.Environment.Clear()
 $envTest=@{SystemRoot=$env:SystemRoot;WINDIR=$env:WINDIR;PATH=[IO.Path]::GetDirectoryName($pwsh);HOME=(Join-Path $stage 'home');USERPROFILE=(Join-Path $stage 'home');APPDATA=(Join-Path $stage 'home');LOCALAPPDATA=(Join-Path $stage 'home');TEMP=(Join-Path $stage 'tmp');TMP=(Join-Path $stage 'tmp');SMART_INBOX_TEST_STAGE=$stage;SMART_INBOX_TEST_RUNTIME=$pwsh}
 foreach($key in $envTest.Keys){$p.StartInfo.Environment[$key]=[string]$envTest[$key]}
 $canary='ts3-handles.ps1'
 foreach($a in @('-NoLogo','-NoProfile','-NonInteractive','-File',(Join-Path $stage ('repo/smart-inbox/tests/'+$canary)),'-Stage',$stage)){$p.StartInfo.ArgumentList.Add($a)}
 $p.StartInfo.RedirectStandardOutput=$true;$p.StartInfo.RedirectStandardError=$true
 if(-not$p.Start()){throw 'Processo non avviato'}
 $started=$true
 $out=$p.StandardOutput.ReadToEndAsync();$err=$p.StandardError.ReadToEndAsync()
 [SmartInboxTS3Job]::Assign($job,$p.Handle);[SmartInboxTS3Job]::Capture($job)
 [IO.File]::WriteAllText((Join-Path $stage 'control/job-ready'),'READY')
 while(-not$p.WaitForExit(20)){[SmartInboxTS3Job]::Capture($job);if($timer.ElapsedMilliseconds-gt90000){throw 'WATCHDOG_NATIVE_TIMEOUT'}}
 [SmartInboxTS3Job]::Capture($job);$result.exit=$p.ExitCode
 $result.stdout=$out.GetAwaiter().GetResult();$result.stderr=$err.GetAwaiter().GetResult();$result.elapsedMs=$timer.ElapsedMilliseconds
 if($p.ExitCode-ne0){throw 'Canarino nativo fallito; nessun writer eseguito'}
 $result.canary=$result.stdout|ConvertFrom-Json
}catch{$result.error=$_.Exception.Message}finally{
 [void][SmartInboxTS3Job]::CloseHandle($job)
 if($started-and-not$p.HasExited){[void]$p.WaitForExit(5000)}
 $until=[DateTime]::UtcNow.AddSeconds(5);while(-not[SmartInboxTS3Job]::AllExited()-and[DateTime]::UtcNow-lt$until){Start-Sleep -Milliseconds 20}
 $result.processesExited=(-not$started-or$p.HasExited)-and[SmartInboxTS3Job]::AllExited()
 [SmartInboxTS3Job]::Release();$p.Dispose()
 foreach($f in $files){if((Get-FileHash -LiteralPath (Join-Path $stage ('repo/'+$mapped[$f]))).Hash-cne$hashes[$f]){$result.error='Sorgente staging modificato'}}
 $result.mainUnchanged=(git -C $repo rev-parse main)-ceq'e4a6b37bc663ba79dd9ccabdba0a5484dd9eaf5c'
 $result.manifestB6Unchanged=(Get-FileHash -LiteralPath $manifest).Hash-ceq'7CAD074B2B697F2C3B2C8C8A4CB5EE6CE191398CFCC279F21CC81AA2855A9C48'
 if(-not$result.mainUnchanged-or-not$result.manifestB6Unchanged){$result.error='Baseline o manifest cambiati'}
 [IO.File]::WriteAllText((Join-Path $evidence 'result.json'),($result|ConvertTo-Json -Depth 6))
 Write-Output ('EVIDENCE='+$evidence);$result|ConvertTo-Json -Depth 6
}
if($result.error-or-not$result.processesExited){exit 1}
if($NativeOnly){exit 0}

$node=Join-Path $stage 'node.exe';[IO.File]::WriteAllBytes($node,[IO.File]::ReadAllBytes((Get-Command node).Source))
if((Get-FileHash -LiteralPath $node).Hash-cne'B3094D0B49F9AD602262A9921551737BB97637C05DD357A06AE98188D7290AA3'){throw 'Runtime Node diverso'}
$js=@($mapped.Values|Where-Object{$_-match'\.(?:js|cjs)$'})
$spec=@{phase='prepare';sources=@($js|ForEach-Object{Join-Path $stage ('repo/'+$_)});core=@(@('smart-inbox/writer.js','smart-inbox/planner.js','smart-inbox/policy.js','smart-inbox/reader.js','memoria/analisi.js')|ForEach-Object{Join-Path $stage ('repo/'+$_)});attributes=@{};runtimePwsh=$pwsh}
$application=[ordered]@{stage=$stage;hashes=$hashes;sourceDestinations=$mapped;phases=@();nodeSha256=(Get-FileHash -LiteralPath $node).Hash;newOrbitSuiteRuns=0}
function Run-Node([string]$Name,[string[]]$Arguments,[bool]$Guard=$true){
 $proc=[Diagnostics.Process]::new();$job=[SmartInboxTS3Job]::Create();$started=$false;$clock=[Diagnostics.Stopwatch]::StartNew()
 $spec.phase=if($Name.StartsWith('prepare')){'prepare'}else{'readonly'};$spec.log=Join-Path $stage ('control/'+$Name+'-events.jsonl');$spec.gate=Join-Path $stage ('control/gate-'+$Name)
 [IO.File]::WriteAllText((Join-Path $stage 'control/spec.json'),($spec|ConvertTo-Json -Depth 8))
 try{
  $proc.StartInfo.FileName=$node;$proc.StartInfo.UseShellExecute=$false;$proc.StartInfo.CreateNoWindow=$true;$proc.StartInfo.WorkingDirectory=Join-Path $stage 'repo';$proc.StartInfo.Environment.Clear()
  foreach($key in $envTest.Keys){$proc.StartInfo.Environment[$key]=[string]$envTest[$key]}
  foreach($a in @('--no-addons','--disallow-code-generation-from-strings')){$proc.StartInfo.ArgumentList.Add($a)}
  if($Guard){$proc.StartInfo.ArgumentList.Add('--require='+(Join-Path $stage 'repo/smart-inbox/tests/guard.cjs'))}
  foreach($a in $Arguments){$proc.StartInfo.ArgumentList.Add($a)}
  $proc.StartInfo.RedirectStandardOutput=$true;$proc.StartInfo.RedirectStandardError=$true
  if(-not$proc.Start()){throw 'Node non avviato'};$started=$true
  $out=$proc.StandardOutput.ReadToEndAsync();$err=$proc.StandardError.ReadToEndAsync()
  [SmartInboxTS3Job]::Assign($job,$proc.Handle);[SmartInboxTS3Job]::Capture($job);[IO.File]::WriteAllText($spec.gate,'READY')
  while(-not$proc.WaitForExit(20)){[SmartInboxTS3Job]::Capture($job);if($clock.ElapsedMilliseconds-gt600000){throw 'NODE_WATCHDOG_600S'}}
  [SmartInboxTS3Job]::Capture($job)
  $stdout=$out.GetAwaiter().GetResult();$stderr=$err.GetAwaiter().GetResult()
  [IO.File]::WriteAllText((Join-Path $evidence ($Name+'.log')),$stdout+"`n"+$stderr)
  if(Test-Path -LiteralPath $spec.log){[IO.File]::WriteAllBytes((Join-Path $evidence ($Name+'-events.jsonl')),[IO.File]::ReadAllBytes($spec.log))}
  $application.phases+=@(@{name=$Name;exit=$proc.ExitCode;durationMs=$clock.ElapsedMilliseconds})
  Write-Output ('NODE_PHASE='+$Name+' EXIT='+$proc.ExitCode)
  if($proc.ExitCode-ne0){throw ('Fase Node fallita: '+$Name)}
  if($Name-eq'ts-tests'){
   $counts=@{};foreach($label in @('tests','pass','fail','skipped','cancelled')){$match=[regex]::Match($stdout,'(?m)^# '+$label+' (\d+)$');if(-not$match.Success){throw 'TAP incompleto'};$counts[$label]=[int]$match.Groups[1].Value}
   if($counts.fail-or$counts.skipped-or$counts.cancelled-or$counts.tests-ne$counts.pass){throw 'Test incompleti'};$application.tests=$counts
  }
 }finally{
  [void][SmartInboxTS3Job]::CloseHandle($job)
  if($started-and-not$proc.HasExited){[void]$proc.WaitForExit(5000)}
  $until=[DateTime]::UtcNow.AddSeconds(5);while(-not[SmartInboxTS3Job]::AllExited()-and[DateTime]::UtcNow-lt$until){Start-Sleep -Milliseconds 20}
  if(($started-and-not$proc.HasExited)-or-not[SmartInboxTS3Job]::AllExited()){throw 'Processi sintetici residui'}
  [SmartInboxTS3Job]::Release();$proc.Dispose()
 }
 foreach($f in $files){if((Get-FileHash -LiteralPath (Join-Path $stage ('repo/'+$mapped[$f]))).Hash-cne$hashes[$f]){throw 'Sorgente modificato'}}
 if((git -C $repo rev-parse main)-cne'e4a6b37bc663ba79dd9ccabdba0a5484dd9eaf5c'){throw 'Main cambiato'}
}
try{
 foreach($f in $js){Run-Node ('syntax-'+[array]::IndexOf($js,$f)) @('--check',(Join-Path $stage ('repo/'+$f))) $false}
 Run-Node 'prepare-old' @((Join-Path $stage 'repo/smart-inbox/tests/fixtures.cjs'),'--prepare',(Join-Path $stage 'data'))
 Run-Node 'prepare-ts3' @((Join-Path $stage 'repo/smart-inbox/tests/ts3-fixtures.cjs'),'--prepare',$stage)
 $attrs=@{}
 function Attrs([string]$p){$i=Get-Item -LiteralPath $p -Force;$attrs[$i.FullName.ToLowerInvariant()]=[int]$i.Attributes;if($i.PSIsContainer-and-not($i.Attributes-band[IO.FileAttributes]::ReparsePoint)){foreach($f in @(Get-ChildItem -LiteralPath $p -Force)){Attrs $f.FullName}}}
 Attrs (Join-Path $stage 'data');for($p=$stage;$p;$p=[IO.Path]::GetDirectoryName($p)){$attrs[$p.ToLowerInvariant()]=[int][IO.File]::GetAttributes($p)};$spec.attributes=$attrs
 Run-Node 'node-canary' @((Join-Path $stage 'repo/smart-inbox/tests/canary.cjs'))
 Run-Node 'ts-tests' @('--test','--test-isolation=none','--test-concurrency=1','--test-reporter=tap',(Join-Path $stage 'repo/smart-inbox/tests/reader.test.js'),(Join-Path $stage 'repo/smart-inbox/tests/planner.test.js'),(Join-Path $stage 'repo/smart-inbox/tests/ts3-writer.test.js'))
 $application.processesExited=$true
}catch{$application.error=$_.Exception.Message}finally{
 [IO.File]::WriteAllText((Join-Path $evidence 'application.json'),($application|ConvertTo-Json -Depth 8));Write-Output ('APPLICATION_EVIDENCE='+$evidence)
}
if($application.error){Write-Output ('STOP='+$application.error);exit 1}
