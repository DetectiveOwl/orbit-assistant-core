using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace SmartInboxWindows {
    // Aperture relative a directory gia aperte: nessuna seconda risoluzione di un path assoluto.
    public sealed class Root : IDisposable {
        static string testBoundary, vaultBoundary;
        // vault: null per lo stage sintetico (tutto dentro lo stage); per lo stage reale e il percorso assoluto del vault, unica radice ammessa fuori dallo stage.
        public static void InitializeBoundary(string stage, string vault) {
            if(testBoundary!=null)throw new IOException("BOUNDARY_ALREADY_INITIALIZED");
            var full=Path.GetFullPath(stage).TrimEnd('\\');
            var real=System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(full),@"^orbit-smart-inbox-real-[0-9a-f]{32}$");
            if(!real&&!System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(full),@"^orbit-smart-inbox-ts3-[0-9a-f]{32}$"))throw new IOException("SYNTHETIC_BOUNDARY_REQUIRED");
            if(real!=!String.IsNullOrEmpty(vault))throw new IOException("SYNTHETIC_BOUNDARY_REQUIRED");
            if(real){var v=Path.GetFullPath(vault).TrimEnd('\\');if(v.Length<=3||v!=vault.TrimEnd('\\'))throw new IOException("CANONICAL_ROOT_REQUIRED");vaultBoundary=v;}
            testBoundary=full;
        }
        [StructLayout(LayoutKind.Sequential)] struct Unicode { public ushort Length, MaximumLength; public IntPtr Buffer; }
        [StructLayout(LayoutKind.Sequential)] struct Attributes { public int Length; public IntPtr RootDirectory, ObjectName; public uint Flags; public IntPtr Security, Quality; }
        [StructLayout(LayoutKind.Sequential)] struct Status { public IntPtr Value, Information; }
        [StructLayout(LayoutKind.Sequential)] struct Info { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written; public uint Volume, SizeHigh, SizeLow, Links, IdHigh, IdLow; }
        [DllImport("ntdll.dll")] static extern int NtCreateFile(out IntPtr h, uint access, ref Attributes attrs, out Status status, IntPtr size, uint flags, uint share, uint disposition, uint options, IntPtr ea, uint eaLength);
        [DllImport("ntdll.dll")] static extern uint RtlNtStatusToDosError(int status);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info info);
        [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetFileType(SafeFileHandle h);
        [DllImport("ntdll.dll")] static extern int NtSetInformationFile(SafeFileHandle h, out Status status, IntPtr data, uint size, int kind);
        readonly List<SafeFileHandle> directories = new List<SafeFileHandle>();
        readonly Dictionary<string,SafeFileHandle> pinned = new Dictionary<string,SafeFileHandle>(StringComparer.OrdinalIgnoreCase);
        readonly List<FileStream> renameAnchors = new List<FileStream>();
        readonly SafeFileHandle root;
        public readonly string Identity;
        public readonly string Absolute;
        const uint Sync=0x100000, ReadAttributes=0x80, Traverse=0x20, Directory=1, NonDirectory=0x40, NoFollow=0x200000, Synchronous=0x20;
        static void Component(string name) {
            if (String.IsNullOrWhiteSpace(name) || name=="." || name==".." || name.IndexOfAny(new char[]{'\\','/',':','\0','<','>','"','|','?','*'})>=0 || name.EndsWith(".") || name.EndsWith(" ")) throw new IOException("UNSAFE_COMPONENT");
        }
        static Info Inspect(SafeFileHandle h, bool directory) {
            Info info;
            if (!GetFileInformationByHandle(h,out info)) throw new Win32Exception();
            if (GetFileType(h)!=1 || (info.Attributes & 0x400)!=0 || ((info.Attributes & 0x10)!=0)!=directory || (!directory && info.Links!=1)) throw new IOException("LINK_REPARSE_OR_NONREGULAR");
            return info;
        }
        static SafeFileHandle Relative(SafeFileHandle parent, string name, uint access, bool directory, uint disposition, uint share) {
            Component(name);
            IntPtr text=Marshal.StringToHGlobalUni(name), u=IntPtr.Zero;
            try {
                int length=checked(name.Length*2); if(length>65532)throw new IOException("NAME_TOO_LONG");
                var unicode=new Unicode{Length=(ushort)length,MaximumLength=(ushort)(length+2),Buffer=text};
                u=Marshal.AllocHGlobal(Marshal.SizeOf<Unicode>()); Marshal.StructureToPtr(unicode,u,false);
                var attrs=new Attributes{Length=Marshal.SizeOf<Attributes>(),RootDirectory=parent.DangerousGetHandle(),ObjectName=u,Flags=0x40};
                IntPtr raw; Status status;
                int result=NtCreateFile(out raw,access|ReadAttributes|Sync,ref attrs,out status,IntPtr.Zero,0,share,disposition,NoFollow|Synchronous|(directory?Directory:NonDirectory),IntPtr.Zero,0);
                if(result<0)throw new Win32Exception(checked((int)RtlNtStatusToDosError(result)));
                var h=new SafeFileHandle(raw,true);
                try { Inspect(h,directory); return h; } catch { h.Dispose(); throw; }
            } finally { if(u!=IntPtr.Zero)Marshal.FreeHGlobal(u);Marshal.FreeHGlobal(text); }
        }
        public Root(string absolute) {
            if(!OperatingSystem.IsWindows() || !System.Text.RegularExpressions.Regex.IsMatch(absolute,@"^[A-Za-z]:\\"))throw new IOException("LOCAL_WINDOWS_ROOT_REQUIRED");
            Absolute=Path.GetFullPath(absolute).TrimEnd('\\');
            if(Absolute.Length<=3 || Absolute!=absolute.TrimEnd('\\'))throw new IOException("CANONICAL_ROOT_REQUIRED");
            if(testBoundary==null||!(Absolute.StartsWith(testBoundary+"\\",StringComparison.OrdinalIgnoreCase)||(vaultBoundary!=null&&(String.Equals(Absolute,vaultBoundary,StringComparison.OrdinalIgnoreCase)||Absolute.StartsWith(vaultBoundary+"\\",StringComparison.OrdinalIgnoreCase)))))throw new IOException("OUTSIDE_SYNTHETIC_BOUNDARY");
            if(new DriveInfo(Path.GetPathRoot(Absolute)).DriveFormat!="NTFS")throw new IOException("NTFS_REQUIRED");
            try {
                var volume=CreateFileW(@"\\?\"+Absolute.Substring(0,3),ReadAttributes|Sync,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
                if(volume.IsInvalid)throw new Win32Exception();
                directories.Add(volume); Inspect(volume,true);
                var current=volume;
                foreach(string component in Absolute.Substring(3).Split('\\')) {
                    current=Relative(current,component,Traverse,true,1,1); directories.Add(current);
                }
                root=current; pinned.Add("",root);
                var info=Inspect(root,true); Identity=info.Volume.ToString("X8")+":"+info.IdHigh.ToString("X8")+info.IdLow.ToString("X8");
            } catch { Dispose(); throw; }
        }
        SafeFileHandle Parent(string relative, out string leaf) {
            if(relative.IndexOf('\\')>=0 || relative.StartsWith("/"))throw new IOException("RELATIVE_SLASH_PATH_REQUIRED");
            string[] parts=relative.Split('/');foreach(var p in parts)Component(p);
            var current=root;string key="";
            for(int i=0;i<parts.Length-1;i++) {
                key+=(key.Length==0?"":"/")+parts[i];SafeFileHandle next;
                if(!pinned.TryGetValue(key,out next)) { next=Relative(current,parts[i],Traverse,true,1,1);directories.Add(next);pinned.Add(key,next); }
                current=next;
            }
            leaf=parts[parts.Length-1];return current;
        }
        public FileStream Open(string relative, bool write, bool move = false) {
            string leaf;var parent=Parent(relative,out leaf);
            var h=Relative(parent,leaf,(write?3u:1u)|(move?0x10000u:0u),false,1,write||move?0u:1u);
            return new FileStream(h,write?FileAccess.ReadWrite:FileAccess.Read);
        }
        public void PinDirectory(string relative, string inode) {
            string leaf; var parent=Parent(relative+"/synthetic-leaf",out leaf);
            var info=Inspect(parent,true);
            if((((ulong)info.IdHigh<<32)|info.IdLow).ToString()!=inode)throw new IOException("DIRECTORY_ID_CHANGED");
        }
        public void MakeDirectory(string relative) {
            string leaf;var parent=Parent(relative,out leaf);
            var h=Relative(parent,leaf,Traverse,true,2,1);directories.Add(h);pinned.Add(relative,h);
        }
        public void EnsureTechnicalDirectory(string relative) {
            try { MakeDirectory(relative); }
            catch(Win32Exception e) { if(e.NativeErrorCode!=183)throw;string unused;Parent(relative+"/placeholder",out unused); }
        }
        public void PermitRenameIntoNonemptyDirectory(string relative,string anchorName) {
            Component(anchorName);
            if(relative.Length==0)throw new IOException("ROOT_RENAME_PERMISSION_FORBIDDEN");
            var anchor=Open(relative+"/"+anchorName,false);
            SafeFileHandle replacement=null;
            try {
                if(anchor.Length==0)throw new IOException("NONEMPTY_ANCHOR_REQUIRED");
                var previous=pinned[relative];var oldInfo=Inspect(previous,true);
                string leaf;var parent=Parent(relative,out leaf);
                replacement=Relative(parent,leaf,Traverse,true,1,3);
                var newInfo=Inspect(replacement,true);
                if(oldInfo.Volume!=newInfo.Volume||oldInfo.IdHigh!=newInfo.IdHigh||oldInfo.IdLow!=newInfo.IdLow)throw new IOException("DIRECTORY_ID_CHANGED");
                // La nota tecnica aperta senza share-write/delete mantiene non vuota la directory NTFS.
                renameAnchors.Add(anchor);anchor=null;
                pinned[relative]=replacement;directories.Add(replacement);replacement=null;
                directories.Remove(previous);previous.Dispose();
            }finally{anchor?.Dispose();replacement?.Dispose();}
        }
        public string[] Entries(string relative, bool all = false) {
            string unused;Parent(relative+"/placeholder",out unused);
            var entries=new List<string>();
            foreach(var p in System.IO.Directory.GetFileSystemEntries(Path.Combine(Absolute,relative.Replace('/','\\')))) {
                var attributes=File.GetAttributes(p);
                if((attributes&FileAttributes.ReparsePoint)!=0)throw new IOException("UNEXPECTED_REPARSE_IN_SCOPE");
                if(all || (attributes&FileAttributes.Directory)!=0 || p.EndsWith(".md",StringComparison.OrdinalIgnoreCase))entries.Add(Path.GetFileName(p));
            }
            entries.Sort(StringComparer.Ordinal);return entries.ToArray();
        }
        public Dictionary<string,int> AttributesSnapshot() {
            var result=new Dictionary<string,int>(StringComparer.OrdinalIgnoreCase);
            for(string p=Absolute;p!=null;p=Path.GetDirectoryName(p))result[p.ToLowerInvariant()]=(int)File.GetAttributes(p);
            Action<string> scan=null;
            scan=(relative)=>{
                string unused; if(relative.Length>0)Parent(relative+"/placeholder",out unused);
                string absolute=relative.Length==0?Absolute:Path.Combine(Absolute,relative.Replace('/','\\'));
                foreach(var item in System.IO.Directory.GetFileSystemEntries(absolute)) {
                    var attributes=File.GetAttributes(item);result[item.ToLowerInvariant()]=(int)attributes;
                    if((attributes&FileAttributes.Directory)!=0&&(attributes&FileAttributes.ReparsePoint)==0)scan(relative.Length==0?Path.GetFileName(item):relative+"/"+Path.GetFileName(item));
                }
            };
            scan("");return result;
        }
        public static string FileIdentity(FileStream file) {
            var info=Inspect(file.SafeFileHandle,false);
            return info.Volume.ToString("X8")+":"+info.IdHigh.ToString("X8")+info.IdLow.ToString("X8");
        }
        public static void Move(FileStream file, Root target, string relative) {
            string leaf;var parent=target.Parent(relative,out leaf);
            Rename(file,parent.DangerousGetHandle(),leaf);
        }
        public static void RenameInPlace(FileStream file,string leaf) {
            Component(leaf);
            Rename(file,IntPtr.Zero,leaf);
        }
        static void Rename(FileStream file,IntPtr parent,string leaf) {
            if(IntPtr.Size!=8)throw new IOException("X64_REQUIRED");
            byte[] name=System.Text.Encoding.Unicode.GetBytes(leaf);
            int size=checked(20+name.Length+2);var buffer=Marshal.AllocHGlobal(size);
            try {
                Marshal.Copy(new byte[size],0,buffer,size);Marshal.WriteIntPtr(buffer,8,parent);
                Marshal.WriteInt32(buffer,16,name.Length);Marshal.Copy(name,0,IntPtr.Add(buffer,20),name.Length);
                Status status;int result=NtSetInformationFile(file.SafeFileHandle,out status,buffer,(uint)size,10);
                if(result<0)throw new Win32Exception(checked((int)RtlNtStatusToDosError(result)));
            }finally{Marshal.FreeHGlobal(buffer);}
        }
        public FileStream Create(string relative, bool move = false) {
            string leaf;var parent=Parent(relative,out leaf);
            var h=Relative(parent,leaf,3|(move?0x10000u:0u),false,2,0);
            return new FileStream(h,FileAccess.ReadWrite);
        }
        public void Dispose() { foreach(var anchor in renameAnchors)anchor.Dispose();renameAnchors.Clear();for(int i=directories.Count-1;i>=0;i--)directories[i].Dispose();directories.Clear();pinned.Clear(); }
    }
}
