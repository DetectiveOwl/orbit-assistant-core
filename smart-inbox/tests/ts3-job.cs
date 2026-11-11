using System;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class SmartInboxTS3Job {
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