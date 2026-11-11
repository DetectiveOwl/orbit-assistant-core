$ErrorActionPreference='Stop'
$env:GIT_OPTIONAL_LOCKS='0'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$manifestB6='<PERCORSO-WORKTREE>\risultati\backend-b0006\sandbox\b0006\manifest-codice-proposto.json'
$hashB6='7CAD074B2B697F2C3B2C8C8A4CB5EE6CE191398CFCC279F21CC81AA2855A9C48'
if((git -C $repo branch --show-current)-cne'codex/smart-inbox-ts1-ts2' -or (git -C $repo rev-parse main)-cne'c59927631b43cdf5095c6d30104410b622eb1eb7'){throw 'Baseline/branch inattesi'}
if((Get-FileHash -LiteralPath $manifestB6).Hash-cne$hashB6){throw 'Manifest B0006 diverso'}
$id=[Guid]::NewGuid().ToString('N')
$stage=[IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('orbit-smart-inbox-'+$id)))
$temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
if(-not$stage.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase)-or(Test-Path -LiteralPath $stage)){throw 'Stage non sicuro'}
for($p=$temp;$p;$p=[IO.Path]::GetDirectoryName($p.TrimEnd([IO.Path]::DirectorySeparatorChar))){if(([IO.File]::GetAttributes($p)-band[IO.FileAttributes]::ReparsePoint)-ne0){throw 'TEMP reindirizzato'}}
$evidence=Join-Path $repo ('risultati/ts1-ts2-'+$id)
foreach($p in @($stage,$evidence,(Join-Path $stage 'repo'),(Join-Path $stage 'control'),(Join-Path $stage 'tmp'),(Join-Path $stage 'data'),(Join-Path $stage 'home'),(Join-Path $stage 'runtime'))){[void][IO.Directory]::CreateDirectory($p)}
$files=@('smart-inbox/policy.js','smart-inbox/reader.js','smart-inbox/planner.js','memoria/analisi.js',
 'smart-inbox/tests/guard.cjs','smart-inbox/tests/fixtures.cjs','smart-inbox/tests/reader.test.js','smart-inbox/tests/planner.test.js','smart-inbox/tests/canary.cjs')
$hashes=[ordered]@{}
foreach($relative in $files){
 $source=Join-Path $repo $relative
 for($p=$source;$p;$p=[IO.Path]::GetDirectoryName($p)){if(([IO.File]::GetAttributes($p)-band[IO.FileAttributes]::ReparsePoint)-ne0){throw 'Sorgente reindirizzato'};if($p-ceq$repo){break}}
 $bytes=[IO.File]::ReadAllBytes($source);$expected=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))
 $target=Join-Path $stage ('repo/'+$relative);[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target));[IO.File]::WriteAllBytes($target,$bytes)
 if((Get-FileHash -LiteralPath $target).Hash-cne$expected){throw 'Hash sorgente diverso'};$hashes[$relative]=$expected
}
foreach($relative in $files[0..3]){
 $code=[IO.File]::ReadAllText((Join-Path $stage ('repo/'+$relative)))
 $calls=[regex]::Matches($code,'\brequire\s*\(');$literal=[regex]::Matches($code,'require\s*\(\s*[''"]([^''"]+)[''"]\s*\)')
 if($calls.Count-ne$literal.Count-or$code-match'\bprocess\.env\b|\beval\s*\(|new Function\s*\(|\bimport\s*\('){throw 'Import dinamico/ambiente non autorizzato'}
 foreach($m in $literal){if($m.Groups[1].Value-notin@('node:fs','node:path','node:crypto','../memoria/analisi','./policy')){throw ('Dipendenza fuori manifest '+$m.Groups[1].Value)}}
}
$node=Join-Path $stage 'runtime/node.exe';Copy-Item -LiteralPath (Get-Command node).Source -Destination $node
if((Get-FileHash -LiteralPath $node).Hash-cne'B3094D0B49F9AD602262A9921551737BB97637C05DD357A06AE98188D7290AA3'){throw 'Runtime non autenticato'}
$envTest=@{SystemRoot=$env:SystemRoot;WINDIR=$env:WINDIR;PATH=(Join-Path $stage 'runtime');HOME=(Join-Path $stage 'home');USERPROFILE=(Join-Path $stage 'home');
 APPDATA=(Join-Path $stage 'home');LOCALAPPDATA=(Join-Path $stage 'home');TEMP=(Join-Path $stage 'tmp');TMP=(Join-Path $stage 'tmp');
 ORBIT_ENV_FILE=(Join-Path $stage 'forbidden-operational-synthetic/.env');ORBIT_VAULT_PATH=(Join-Path $stage 'forbidden-operational-synthetic');ORBIT_DATA_DIR=(Join-Path $stage 'forbidden-operational-synthetic');ORBIT_INDEX_DIR=(Join-Path $stage 'forbidden-operational-synthetic')}
$spec=@{phase='prepare';log=(Join-Path $stage 'control/prepare-events.jsonl');sources=@($files|ForEach-Object{Join-Path $stage ('repo/'+$_)});core=@($files[0..3]|ForEach-Object{Join-Path $stage ('repo/'+$_)});attributes=@{}}
function Walk-Synthetic([string]$p,$attrs,$digest){
 $info=Get-Item -LiteralPath $p -Force;$attrs[$info.FullName.ToLowerInvariant()]=[int]$info.Attributes
 if(($info.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne0){$digest[$info.FullName]='LINK:'+[string]$info.Target;return}
 if($info.PSIsContainer){foreach($entry in @(Get-ChildItem -LiteralPath $p -Force)){Walk-Synthetic $entry.FullName $attrs $digest}}
 else{$digest[$info.FullName]=(Get-FileHash -LiteralPath $p).Hash}
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class SmartInboxJob {
 [StructLayout(LayoutKind.Sequential)] struct Basic { public long p,u; public uint flags; public UIntPtr min,max; public uint count; public UIntPtr affinity; public uint priority,scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic basic; public IO io; public UIntPtr process,job,peakProcess,peakJob; }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string b);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr h,int c,IntPtr p,uint n);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr h,IntPtr p);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr h,int c,IntPtr p,uint n,IntPtr needed);
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool inside);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr process,uint ms);
 static System.Collections.Generic.Dictionary<int,IntPtr> handles = new System.Collections.Generic.Dictionary<int,IntPtr>();
 public static void Capture(IntPtr job) {
  var buffer=Marshal.AllocHGlobal(65536);
  try {
   if(!QueryInformationJobObject(job,3,buffer,65536,IntPtr.Zero))throw new Win32Exception();
   int count=Marshal.ReadInt32(buffer,4); if(count<0 || count>4000)throw new Exception("Job troppo grande");
   for(int i=0;i<count;i++) {
    int pid=checked((int)Marshal.ReadIntPtr(buffer,8+i*IntPtr.Size).ToInt64());
    if(handles.ContainsKey(pid) && WaitForSingleObject(handles[pid],0)==258)continue;
    var h=OpenProcess(0x101000,false,pid); if(h==IntPtr.Zero)continue;
    bool inside;
    if(IsProcessInJob(h,job,out inside) && inside){if(handles.ContainsKey(pid))CloseHandle(handles[pid]);handles[pid]=h;}else CloseHandle(h);
   }
  }finally{Marshal.FreeHGlobal(buffer);}
 }
 public static string Probe(IntPtr job,int pid) {
  Capture(job); IntPtr h;
  if(!handles.TryGetValue(pid,out h))return "denied";
  uint status=WaitForSingleObject(h,0);
  return status==0 ? "exited" : status==258 ? "alive" : "denied";
 }
 public static void Release() {foreach(var h in handles.Values)CloseHandle(h);handles.Clear();}
 public static bool AllExited() {foreach(var h in handles.Values)if(WaitForSingleObject(h,0)!=0)return false;return true;}
 public static int HandleCount() {return handles.Count;}
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
 public static IntPtr Create() { var h=CreateJobObject(IntPtr.Zero,null); if(h==IntPtr.Zero)throw new Win32Exception(); var x=new Extended(); x.basic.flags=0x2000; int n=Marshal.SizeOf(x); var p=Marshal.AllocHGlobal(n); try {Marshal.StructureToPtr(x,p,false);if(!SetInformationJobObject(h,9,p,(uint)n))throw new Win32Exception();} finally{Marshal.FreeHGlobal(p);} return h; }
 public static void Assign(IntPtr h,IntPtr p) {if(!AssignProcessToJobObject(h,p))throw new Win32Exception();}
}
'@
$result=[ordered]@{stage=$stage;evidence=$evidence;files=$files;hashes=$hashes;phases=@();main='c59927631b43cdf5095c6d30104410b622eb1eb7';noCleanupRequested=$true}
function Run-Phase([string]$name,[string[]]$arguments,[bool]$preload=$true){
 $spec.phase=if($name-eq'prepare'){'prepare'}else{'readonly'};$spec.log=Join-Path $stage ('control/'+$name+'-events.jsonl');$spec.gate=Join-Path $stage ('control/gate-'+$name)
 [IO.File]::WriteAllText((Join-Path $stage 'control/spec.json'),($spec|ConvertTo-Json -Depth 8))
 $p=[Diagnostics.Process]::new();$job=[SmartInboxJob]::Create();$timer=[Diagnostics.Stopwatch]::StartNew()
 try {
  $p.StartInfo.FileName=$node;$p.StartInfo.UseShellExecute=$false;$p.StartInfo.CreateNoWindow=$true;$p.StartInfo.WorkingDirectory=Join-Path $stage 'repo'
  $p.StartInfo.Environment.Clear();foreach($k in $envTest.Keys){$p.StartInfo.Environment[$k]=[string]$envTest[$k]}
  foreach($a in @('--no-addons','--disallow-code-generation-from-strings')){$p.StartInfo.ArgumentList.Add($a)}
  if($preload){$p.StartInfo.ArgumentList.Add('--require='+(Join-Path $stage 'repo/smart-inbox/tests/guard.cjs'))}
  foreach($a in $arguments){$p.StartInfo.ArgumentList.Add($a)}
  $p.StartInfo.RedirectStandardOutput=$true;$p.StartInfo.RedirectStandardError=$true
  if(-not$p.Start()){throw 'Processo non avviato'}
  $out=$p.StandardOutput.ReadToEndAsync();$err=$p.StandardError.ReadToEndAsync()
  [SmartInboxJob]::Assign($job,$p.Handle);[SmartInboxJob]::Capture($job)
  [IO.File]::WriteAllText($spec.gate,'JOB_ASSIGNED')
  while(-not$p.WaitForExit(20)){[SmartInboxJob]::Capture($job);if($timer.ElapsedMilliseconds-gt120000){throw 'Watchdog esterno 120s'}}
  [SmartInboxJob]::Capture($job);$count=[SmartInboxJob]::HandleCount()
  [void][SmartInboxJob]::CloseHandle($job);$job=[IntPtr]::Zero
  $end=[DateTime]::UtcNow.AddSeconds(5);while(-not[SmartInboxJob]::AllExited()-and[DateTime]::UtcNow-lt$end){Start-Sleep -Milliseconds 20}
  if(-not[SmartInboxJob]::AllExited()){throw 'Cleanup dei processi non confermato'}
  $stdout=$out.GetAwaiter().GetResult();$stderr=$err.GetAwaiter().GetResult()
  [IO.File]::WriteAllText((Join-Path $evidence ($name+'.log')),$stdout+"`n"+$stderr)
  if(Test-Path -LiteralPath $spec.log){Copy-Item -LiteralPath $spec.log -Destination (Join-Path $evidence ($name+'-events.jsonl'))}
  $result.phases+=@(@{name=$name;exit=$p.ExitCode;durationMs=$timer.ElapsedMilliseconds;handlesVerifiedExited=$count})
  Write-Output ('PHASE='+$name+' EXIT='+$p.ExitCode)
  if($p.ExitCode-ne0){throw ('Arresto sulla fase '+$name+'; nessun retry automatico')}
  if($name-eq'tests'){
   $counters=@{};foreach($k in @('tests','pass','fail','skipped','cancelled')){$m=[regex]::Match($stdout,'(?m)^# '+$k+' (\d+)$');if(-not$m.Success){throw 'Riepilogo TAP finale assente'};$counters[$k]=[int]$m.Groups[1].Value}
   if($counters.fail-or$counters.skipped-or$counters.cancelled-or$counters.tests-ne$counters.pass){throw 'TAP non completamente superato'}
   $result.tests=$counters
  }
 }finally{
  if($job-ne[IntPtr]::Zero){[void][SmartInboxJob]::CloseHandle($job)}
  if(-not$p.HasExited){[void]$p.WaitForExit(5000)}
  if(-not$p.HasExited){throw 'Processo sintetico ancora vivo'}
  $p.Dispose();[SmartInboxJob]::Release()
 }
 foreach($relative in $files){if((Get-FileHash -LiteralPath (Join-Path $stage ('repo/'+$relative))).Hash-cne$hashes[$relative]){throw 'Sorgente staging modificato'}}
 if((Get-FileHash -LiteralPath $manifestB6).Hash-cne$hashB6){throw 'Manifest B0006 cambiato'}
}
try {
 for($i=0;$i-lt$files.Count;$i++){Run-Phase ('syntax-'+$i) @('--check',(Join-Path $stage ('repo/'+$files[$i]))) $false}
 Run-Phase 'prepare' @((Join-Path $stage 'repo/smart-inbox/tests/fixtures.cjs'),'--prepare',(Join-Path $stage 'data'))
 $attrs=@{};$beforeData=[ordered]@{};Walk-Synthetic (Join-Path $stage 'data') $attrs $beforeData
 for($p=$stage;$p;$p=[IO.Path]::GetDirectoryName($p)){$attrs[$p.ToLowerInvariant()]=[int][IO.File]::GetAttributes($p)}
 $spec.attributes=$attrs;$result.nativeAttributes=$attrs.Count;$result.dataHashes=$beforeData
 Run-Phase 'canary' @((Join-Path $stage 'repo/smart-inbox/tests/canary.cjs'))
 Run-Phase 'tests' @('--test','--test-isolation=none','--test-concurrency=1','--test-reporter=tap',(Join-Path $stage 'repo/smart-inbox/tests/reader.test.js'),(Join-Path $stage 'repo/smart-inbox/tests/planner.test.js'))
 $afterData=[ordered]@{};Walk-Synthetic (Join-Path $stage 'data') @{} $afterData
 if(($beforeData|ConvertTo-Json -Compress)-cne($afterData|ConvertTo-Json -Compress)){throw 'Fixture vault modificata'}
 $result.vaultUnchanged=$true;$result.sourcesUnchanged=$true;$result.manifestB6Unchanged=$true
 if((git -C $repo rev-parse main)-cne$result.main){throw 'Main cambiato durante la verifica'}
 $result.mainUnchanged=$true
 Copy-Item -LiteralPath (Join-Path $stage 'tmp/piani-sintetici.json') -Destination (Join-Path $evidence 'piani-sintetici.json')
}catch{$result.error=$_.Exception.Message;Write-Output ('STOP='+$result.error)}finally{
 [IO.File]::WriteAllText((Join-Path $evidence 'result.json'),($result|ConvertTo-Json -Depth 10));Write-Output ('EVIDENCE='+$evidence+' STAGE_PRESERVATO='+$stage)
}
if($result.error){exit 1}