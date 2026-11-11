using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

// Fixture nativa indipendente: nessun handle aggiuntivo trattenuto da MemoryMappedFile di .NET.
public sealed class SyntheticWritableView : IDisposable {
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileMappingW(IntPtr file,IntPtr security,uint protect,uint high,uint low,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr MapViewOfFile(IntPtr mapping,uint access,uint high,uint low,UIntPtr count);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushViewOfFile(IntPtr address,UIntPtr count);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetHandleInformation(IntPtr handle,out uint flags);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool UnmapViewOfFile(IntPtr address);
    IntPtr view;
    public bool FileHandleClosed { get; private set; }
    public bool MappingHandleClosed { get; private set; }
    public SyntheticWritableView(string file) {
        IntPtr source=CreateFileW(file,0xC0000000,3,IntPtr.Zero,3,0,IntPtr.Zero),mapping=IntPtr.Zero;
        if(source==new IntPtr(-1))throw new Win32Exception();
        try {
            mapping=CreateFileMappingW(source,IntPtr.Zero,4,0,0,null);if(mapping==IntPtr.Zero)throw new Win32Exception();
            view=MapViewOfFile(mapping,2,0,0,UIntPtr.Zero);if(view==IntPtr.Zero)throw new Win32Exception();
            if(!CloseHandle(source))throw new Win32Exception();
            uint flags;FileHandleClosed=!GetHandleInformation(source,out flags)&&Marshal.GetLastWin32Error()==6;source=IntPtr.Zero;
            if(!CloseHandle(mapping))throw new Win32Exception();
            MappingHandleClosed=!GetHandleInformation(mapping,out flags)&&Marshal.GetLastWin32Error()==6;mapping=IntPtr.Zero;
            if(!FileHandleClosed||!MappingHandleClosed)throw new Exception("MAPPING_FIXTURE_HANDLE_NOT_CLOSED");
        }catch{Dispose();throw;}finally{if(source!=IntPtr.Zero)CloseHandle(source);if(mapping!=IntPtr.Zero)CloseHandle(mapping);}
    }
    public byte Byte { get {return Marshal.ReadByte(view);} }
    public void Write(byte value) {Marshal.WriteByte(view,value);if(!FlushViewOfFile(view,UIntPtr.Zero))throw new Win32Exception();}
    public void Dispose(){if(view!=IntPtr.Zero){if(!UnmapViewOfFile(view))throw new Win32Exception();view=IntPtr.Zero;}}
}

public static class SyntheticJunction {
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateHardLinkW(string link,string existing,IntPtr security);
    public static int TryHardLink(string existing,string link) {return CreateHardLinkW(link,existing,IntPtr.Zero)?0:Marshal.GetLastWin32Error();}
    [StructLayout(LayoutKind.Sequential)] struct Status { public IntPtr Value,Information; }
    [DllImport("ntdll.dll")] static extern int NtSetInformationFile(Microsoft.Win32.SafeHandles.SafeFileHandle file,out Status status,IntPtr data,uint size,int kind);
    [DllImport("ntdll.dll")] static extern uint RtlNtStatusToDosError(int status);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool DeviceIoControl(Microsoft.Win32.SafeHandles.SafeFileHandle file,uint code,byte[] input,int inputLength,IntPtr output,int outputLength,out int returned,IntPtr overlapped);
    public static int TrySet(string directory,string target) {
        using(var file=CreateFileW(directory,0x40000000,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
            if(file.IsInvalid)throw new Win32Exception();
            byte[] substitute=System.Text.Encoding.Unicode.GetBytes(@"\??\"+target),print=System.Text.Encoding.Unicode.GetBytes(target);
            byte[] data=new byte[16+substitute.Length+2+print.Length+2];
            BitConverter.GetBytes(0xA0000003u).CopyTo(data,0);BitConverter.GetBytes(checked((ushort)(data.Length-8))).CopyTo(data,4);
            BitConverter.GetBytes(checked((ushort)substitute.Length)).CopyTo(data,10);
            BitConverter.GetBytes(checked((ushort)(substitute.Length+2))).CopyTo(data,12);BitConverter.GetBytes(checked((ushort)print.Length)).CopyTo(data,14);
            substitute.CopyTo(data,16);print.CopyTo(data,18+substitute.Length);
            int returned;return DeviceIoControl(file,0x900A4,data,data.Length,IntPtr.Zero,0,out returned,IntPtr.Zero)?0:Marshal.GetLastWin32Error();
        }
    }
    public static int TryReplacePosix(string source,string target) {
        using(var file=CreateFileW(source,0x10000,7,IntPtr.Zero,3,0,IntPtr.Zero)) {
            if(file.IsInvalid)throw new Win32Exception();
            byte[] name=System.Text.Encoding.Unicode.GetBytes(@"\??\"+target);int size=20+name.Length+2;
            IntPtr data=Marshal.AllocHGlobal(size);
            try {
                Marshal.Copy(new byte[size],0,data,size);Marshal.WriteInt32(data,0,3);Marshal.WriteInt32(data,16,name.Length);Marshal.Copy(name,0,IntPtr.Add(data,20),name.Length);
                Status status;int result=NtSetInformationFile(file,out status,data,(uint)size,65);
                return result<0?(int)RtlNtStatusToDosError(result):0;
            }finally{Marshal.FreeHGlobal(data);}
        }
    }
}
