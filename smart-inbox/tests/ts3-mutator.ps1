param([string]$Stage,[ValidateSet('deny','control','technical-pin')][string]$Mode)
$ErrorActionPreference='Stop'
if($Stage-cne$env:SMART_INBOX_TEST_STAGE){throw 'Stage inatteso'}
$vault=Join-Path $Stage 'data/vault';$note=Join-Path $vault 'liste/Nota.md';$cases=@()
if($Mode-eq'technical-pin'){
 $clock=[Diagnostics.Stopwatch]::StartNew()
 function Probe([string]$step){[IO.File]::AppendAllText((Join-Path $Stage 'control/technical-pin.log'),($clock.ElapsedMilliseconds.ToString()+' '+$step+"`n"))}
 Probe 'compile-start'
 Add-Type -LiteralPath (Join-Path $Stage 'repo/smart-inbox/tests/ts3-map.cs')
 Probe 'compile-end'
 foreach($op in @('delete-anchor','rename-pinned-directory')){
  $code=$null
  try{if($op-eq'delete-anchor'){[IO.File]::Delete((Join-Path $vault 'metadata/finale.json'))}else{[IO.Directory]::Move((Join-Path $vault 'metadata'),(Join-Path $vault 'metadata-moved'))}}catch{$cause=$_.Exception;while($cause.InnerException){$cause=$cause.InnerException};$code=$cause.HResult-band65535}
  if($code-ne32){throw ('TECHNICAL_PIN_FAILED '+$op+' '+$code)};$cases+=@{name=$op;errorCode=$code}
  Probe ($op+'-end')
 }
 $replacement=Join-Path $vault 'metadata/posix-replacement.tmp';[IO.File]::WriteAllText($replacement,'REPLACEMENT_SYNTHETIC')
 $code=[SyntheticJunction]::TryReplacePosix($replacement,(Join-Path $vault 'metadata/finale.json'))
 Probe ('posix-replace-anchor-code-'+$code)
 if($code-notin@(5,32)){throw ('POSIX_REPLACED_PINNED_ANCHOR '+$code)}
 $cases+=@{name='posix-replace-anchor';errorCode=$code}
 # Modello pratico: il probe ostile hardlink durante il pin e classificato nel report, non ripetuto o dichiarato PASS.
 Probe 'retarget-start'
 $code=[SyntheticJunction]::TrySet((Join-Path $vault 'metadata'),(Join-Path $Stage 'data/outside'))
 Probe ('retarget-end-code-'+$code)
 if($code-ne145){throw ('NONEMPTY_DIRECTORY_REPARSE_GUARD_FAILED '+$code)}
 $cases+=@{name='retarget-pinned-nonempty-directory';errorCode=$code}
 $control=Join-Path $Stage 'tmp/junction-control';[void][IO.Directory]::CreateDirectory($control)
 $code=[SyntheticJunction]::TrySet($control,(Join-Path $Stage 'data/outside'))
 Probe ('control-retarget-end-code-'+$code)
 if($code-ne0-or([IO.File]::GetAttributes($control)-band[IO.FileAttributes]::ReparsePoint)-eq0){throw 'JUNCTION_CONTROL_NOT_EFFECTIVE'}
 $cases+=@{name='same-retarget-on-unprotected-empty-control';errorCode=0}
 $controlSource=Join-Path $Stage 'tmp/posix-source.tmp';$controlTarget=Join-Path $Stage 'tmp/posix-target.tmp'
 [IO.File]::WriteAllText($controlSource,'NEW');[IO.File]::WriteAllText($controlTarget,'OLD')
 $code=[SyntheticJunction]::TryReplacePosix($controlSource,$controlTarget)
 if($code-ne0-or[IO.File]::ReadAllText($controlTarget)-cne'NEW'){throw ('POSIX_CONTROL_NOT_EFFECTIVE '+$code)}
 $cases+=@{name='posix-replace-unprotected-control';errorCode=0}
}elseif($Mode-eq'deny'){
 foreach($case in @('write','rename-directory','rename-file')){
  $code=$null
  try{
   switch($case){
    'write'{$f=[IO.File]::Open($note,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite);$f.Dispose()}
    'rename-directory'{[IO.Directory]::Move((Join-Path $vault 'liste'),(Join-Path $vault 'spostata'))}
    'rename-file'{[IO.File]::Move($note,(Join-Path $vault 'liste/Spostata.md'))}
   }
  }catch{$cause=$_.Exception;while($cause.InnerException){$cause=$cause.InnerException};$code=$cause.HResult-band65535}
  if($code-ne32){throw ('Expected sharing violation, case='+$case+' actual='+$code)}
  $cases+=@{name=$case;errorCode=$code}
 }
}else{
 $f=[IO.File]::Open($note,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite)
 try{$f.WriteByte(88);$f.Flush($true)}finally{$f.Dispose()}
 [IO.Directory]::Move((Join-Path $vault 'liste'),(Join-Path $vault 'spostata'))
 [IO.Directory]::Move((Join-Path $vault 'spostata'),(Join-Path $vault 'liste'))
 $cases+=@{name='write-and-rename-after-release';succeeded=$true}
}
if($Mode-eq'technical-pin'){Probe 'before-json'}
$json=[pscustomobject]@{pid=$PID;mode=$Mode;cases=$cases} | ConvertTo-Json -Depth 4 -Compress
if($Mode-eq'technical-pin'){Probe 'after-json'}
[Console]::WriteLine($json)
if($Mode-eq'technical-pin'){Probe 'script-ended'}
