param([string]$Stage)
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
if($Stage-cne$env:SMART_INBOX_TEST_STAGE){throw 'STAGE_MISMATCH'}
foreach($key in @('HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP')){if(-not[Environment]::GetEnvironmentVariable($key).StartsWith($Stage,[StringComparison]::OrdinalIgnoreCase)){throw 'ENV_NOT_SYNTHETIC'}}
if(@([Environment]::GetEnvironmentVariables().Keys | Where-Object {$_-match'TOKEN|SECRET|CREDENTIAL|API_KEY|ORBIT_'}).Count){throw 'INHERITED_SECRET'}
Add-Type -LiteralPath (Join-Path $Stage 'repo/smart-inbox/windows/Handles.cs'),(Join-Path $Stage 'repo/smart-inbox/windows/Engine.cs')
[SmartInboxWindows.Root]::InitializeBoundary($Stage,$null)
$allowed=Get-Content -LiteralPath (Join-Path $Stage 'control/ts3-cases.json') -Raw|ConvertFrom-Json
$bootstrap=[Console]::ReadLine()|ConvertFrom-Json
$key=[Convert]::FromBase64String($bootstrap.key)
if($key.Length-ne32){throw 'INVALID_SESSION_KEY'}
$hmac=[Security.Cryptography.HMACSHA256]::new($key)
[Console]::WriteLine('{"ready":true}')
while($null-ne($line=[Console]::ReadLine())){
 $id=$null
 try{
  if($line.Length-gt33554432){throw 'REQUEST_LIMIT'}
  $packet=$line|ConvertFrom-Json;$id=$packet.id
  $bytes=[Text.Encoding]::UTF8.GetBytes($packet.id+"`n"+$packet.mode+"`n"+$packet.case+"`n"+$packet.payload)
  if(-not[Security.Cryptography.CryptographicOperations]::FixedTimeEquals($hmac.ComputeHash($bytes),[Convert]::FromBase64String($packet.mac))){throw 'AUTHENTICATION_FAILED'}
  if($packet.case-notmatch'^[a-z0-9-]+$'-or$packet.case-notin$allowed){throw 'CASE_NOT_AUTHORIZED'}
  $vault=Join-Path $Stage ('data/cases/'+$packet.case+'/vault');$tech=Join-Path $Stage ('technical/'+$packet.case)
  if($packet.mode-eq'attributes'){
   $root=[SmartInboxWindows.Root]::new($vault);try{$answer=@{attributes=$root.AttributesSnapshot();rootIdentity=$root.Identity}}finally{$root.Dispose()}
  }elseif($packet.mode-eq'execute'){
   $engine=[SmartInboxWindows.Engine]::new()
   $checkpoint=[Action[string]]{
    param($name)
    [Console]::WriteLine((@{event='checkpoint';case=$packet.case;name=$name;request=$id;pid=$PID}|ConvertTo-Json -Compress))
    $faultFile=Join-Path $Stage ('control/fault-'+$packet.case+'.json')
    if([IO.File]::Exists($faultFile)){
     $fault=[IO.File]::ReadAllText($faultFile)|ConvertFrom-Json
     if($fault.at-ceq$name){
      switch($fault.kind){
       'disk-full'{throw [ComponentModel.Win32Exception]::new(112)}
       'crash'{[Environment]::Exit(73)}
       'pause'{
        $gate=Join-Path $Stage ('control/resume-'+$packet.case)
        $clock=[Diagnostics.Stopwatch]::StartNew()
        while(-not[IO.File]::Exists($gate)){if($clock.ElapsedMilliseconds-gt20000){throw 'FAULT_PAUSE_TIMEOUT'};Start-Sleep -Milliseconds 10}
       }
       default{throw 'UNKNOWN_TEST_FAULT'}
      }
     }
    }
   }
   $answer=$engine.Execute($vault,$tech,[string]$packet.payload,$checkpoint)|ConvertFrom-Json
  }else{throw 'MODE_NOT_AUTHORIZED'}
  [Console]::WriteLine((@{id=$id;result=$answer}|ConvertTo-Json -Depth 12 -Compress))
 }catch{[Console]::WriteLine((@{id=$id;result=@{state='FAIL';code=$_.Exception.Message}}|ConvertTo-Json -Depth 5 -Compress))}
}
$hmac.Dispose()
