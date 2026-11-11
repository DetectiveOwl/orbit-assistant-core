using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;

namespace SmartInboxWindows {
    // Trasporto e conferma sono responsabilita dell'host fidato. Nessuna decisione semantica in questo motore.
    public sealed class Engine {
        static string Hash(byte[] b) { return Convert.ToHexString(SHA256.HashData(b)).ToLowerInvariant(); }
        static string Text(JsonElement e,string key) { return e.GetProperty(key).GetString(); }
        static byte[] Bytes(FileStream f) {
            if(f.Length>16*1024*1024)throw new IOException("FILE_LIMIT");
            f.Position=0;byte[] b=new byte[checked((int)f.Length)];int offset=0,n;
            while(offset<b.Length&&(n=f.Read(b,offset,b.Length-offset))>0)offset+=n;
            if(offset!=b.Length)throw new IOException("SHORT_READ");return b;
        }
        static FileStream Optional(Root r,string p,bool write=false,bool move=false) {
            try{return r.Open(p,write,move);}catch(Win32Exception e){if(e.NativeErrorCode==2||e.NativeErrorCode==3)return null;throw;}
        }
        sealed class Journal : IDisposable {
            readonly Root area;public readonly string Directory;readonly List<Dictionary<string,string>> records=new List<Dictionary<string,string>>();string previous;
            readonly Dictionary<string,FileStream> held=new Dictionary<string,FileStream>(StringComparer.Ordinal);
            FileStream Hold(string name) {
                FileStream file;if(held.TryGetValue(name,out file))return file;
                file=Optional(area,Directory+"/"+name);if(file!=null)held.Add(name,file);return file;
            }
            public Journal(Root area,string digest,string spec,bool inspect) {
                this.area=area;Directory="plan-"+digest;previous=Hash(Encoding.UTF8.GetBytes(spec));
                try {
                if(!inspect)area.EnsureTechnicalDirectory(Directory);
                {
                    var request=Hold("request.json");
                    if(request==null){if(inspect)return;Save("request.json",Encoding.UTF8.GetBytes(spec));}
                    else if(!Bytes(request).SequenceEqual(Encoding.UTF8.GetBytes(spec)))throw new IOException("STORED_SPEC_CHANGED");
                }
                string[] names;
                try{names=area.Entries(Directory,true);}catch(Win32Exception e){if(inspect&&(e.NativeErrorCode==2||e.NativeErrorCode==3))return;throw;}
                foreach(string name in names.Where(n=>Regex.IsMatch(n,@"^\d{6}-[0-9a-f]{64}\.json$")).OrderBy(n=>n,StringComparer.Ordinal)) {
                    {
                        var f=Hold(name);
                        byte[] b=Bytes(f);string hash=Hash(b);
                        var record=JsonSerializer.Deserialize<Dictionary<string,string>>(b);
                        if(name!=(records.Count+1).ToString("D6")+"-"+hash+".json"||record["prev"]!=previous)throw new IOException("JOURNAL_CHANGED_OR_GAP");
                        records.Add(record);previous=hash;
                    }
                }
                if(!inspect)area.PermitRenameIntoNonemptyDirectory(Directory,"request.json");
                }catch{Dispose();throw;}
            }
            void Save(string name,byte[] b) {
                string temporary=Directory+"/pending-"+Guid.NewGuid().ToString("N")+".tmp";
                using(var f=area.Create(temporary,true)) {
                    f.Write(b);f.Flush(true);if(!Bytes(f).SequenceEqual(b))throw new IOException("JOURNAL_VERIFY_FAILED");
                    Root.RenameInPlace(f,name);f.Flush(true);
                }
                if(!Bytes(Hold(name)).SequenceEqual(b))throw new IOException("JOURNAL_CHANGED_BEFORE_PIN");
            }
            public void Add(string kind,string key,string fileId="",string hash="") {
                var record=new Dictionary<string,string>{{"prev",previous},{"kind",kind},{"key",key},{"fileId",fileId},{"hash",hash}};
                byte[] b=JsonSerializer.SerializeToUtf8Bytes(record);string digest=Hash(b);
                Save((records.Count+1).ToString("D6")+"-"+digest+".json",b);records.Add(record);previous=digest;
            }
            public Dictionary<string,string> Last(string kind,string key) { return records.LastOrDefault(r=>r["kind"]==kind&&r["key"]==key); }
            public Dictionary<string,string> LastWrite(string kind,string key) {
                int reset=records.FindLastIndex(r=>(r["kind"]=="compensated"||r["kind"]=="partial-restored")&&r["key"]==key);
                var current=records.Skip(reset+1).LastOrDefault(r=>r["kind"]==kind&&r["key"]==key);
                if(current!=null)return current;
                // Un parziale ripristinato conserva solo la provenienza, mai il done del tentativo fallito.
                return reset>=0&&records[reset]["kind"]=="partial-restored"&&(kind=="write-intent"||kind=="created")?records[reset]:null;
            }
            public string Path(string name){return Directory+"/"+name;}
            public void Backup(string name,byte[] expected) {
                {
                    var existing=Hold(name);
                    if(existing!=null){if(!Bytes(existing).SequenceEqual(expected))throw new IOException("BACKUP_CHANGED");return;}
                }
                Save(name,expected);
                if(Hash(Bytes(Hold(name)))!=Hash(expected))throw new IOException("BACKUP_VERIFY_FAILED");
            }
            public byte[] BackupBytes(string name,string hash) {
                var f=Hold(name);if(f==null)throw new IOException("BACKUP_MISSING");byte[] b=Bytes(f);if(Hash(b)!=hash)throw new IOException("BACKUP_CHANGED");return b;
            }
            public void Dispose(){foreach(var f in held.Values)f.Dispose();held.Clear();}
        }
        sealed class Slot { public JsonElement Spec;public FileStream File;public byte[] Original,Prior;public string State;public string FileId;public bool Touched,CreatedNow,RecoveringPartial; }
        static List<object> RestoreAttempt(Journal journal,Root area,List<Slot> outputs) {
            var result=new List<object>();
            foreach(var o in outputs.Where(o=>o.Touched).Reverse()) {
                string path=Text(o.Spec,"path"),key=Text(o.Spec,"key");bool restored=false;
                try {
                    if(Root.FileIdentity(o.File)!=o.FileId)throw new IOException("RESTORE_IDENTITY_CHANGED");
                    byte[] current=Bytes(o.File),delta=Convert.FromBase64String(Text(o.Spec,"data"));
                    byte[] original=Text(o.Spec,"kind")=="create"?Array.Empty<byte>():journal.BackupBytes("original-out-"+key+".bak",Text(o.Spec,"before"));
                    if(!Prefix(original.Concat(delta).ToArray(),current)||!Prefix(current,o.Prior))throw new IOException("RESTORE_CONTENT_CONFLICT");
                    if(o.CreatedNow)Root.Move(o.File,area,journal.Path("failed-create-"+key+"-"+Guid.NewGuid().ToString("N")+".note"));
                    else {
                        var prior=journal.BackupBytes("before-attempt-"+key+"-"+Hash(o.Prior)+".bak",Hash(o.Prior));
                        o.File.SetLength(prior.Length);o.File.Flush(true);
                        if(!Bytes(o.File).SequenceEqual(prior))throw new IOException("RESTORE_VERIFY_FAILED");
                    }
                    restored=true;o.State="RESTORED";journal.Add(o.RecoveringPartial?"partial-restored":"compensated",key,o.FileId,Hash(o.Prior));
                    result.Add(new{path,state="RESTORED"});
                }catch(Exception e){result.Add(new{path,state=restored?"RESTORED_JOURNAL_UNCONFIRMED":"RECOVERY_REQUIRED",error=e.GetBaseException().Message});}
            }
            return result;
        }
        // create_dir: cartelle (assenti, vuote) da creare nello stesso piano e nella stessa conferma; autenticate dall'hash della preview.
        static List<JsonElement> Mkdirs(JsonElement spec){JsonElement m;return spec.TryGetProperty("mkdirs",out m)?m.EnumerateArray().ToList():new List<JsonElement>();}
        static void CheckDirectories(Root vault,JsonElement spec,List<Slot> outputs,bool scope,HashSet<string> made) {
            foreach(var d in spec.GetProperty("directories").EnumerateArray()) {
                string path=Text(d,"path");vault.PinDirectory(path,Text(d,"inode"));
                if(!scope)continue;
                var expected=d.GetProperty("children").EnumerateArray().Select(x=>x.GetString()).ToHashSet(StringComparer.Ordinal);
                foreach(var o in outputs.Where(o=>Text(o.Spec,"kind")=="create"&&o.File!=null)){
                    string dest=Text(o.Spec,"path");int slash=dest.LastIndexOf('/');if(dest.Substring(0,slash)==path)expected.Add(dest.Substring(slash+1));
                }
                var actual=vault.Entries(path);
                // Una cartella con intent nel journal (creata da noi, anche se interrotta prima del done) e un nome atteso solo se esiste davvero.
                foreach(string made1 in made){int slash=made1.LastIndexOf('/');if(slash>0&&made1.Substring(0,slash)==path&&actual.Contains(made1.Substring(slash+1)))expected.Add(made1.Substring(slash+1));}
                if(!expected.SetEquals(actual))throw new IOException("CATALOG_NAMES_CHANGED");
            }
        }
        static bool Prefix(byte[] value,byte[] prefix){return value.Length>=prefix.Length&&value.AsSpan(0,prefix.Length).SequenceEqual(prefix);}
        static void CheckRecovery(JsonElement request,Slot slot,byte[] current) {
            JsonElement grant;
            if(!request.GetProperty("recovery").TryGetProperty(Text(slot.Spec,"key"),out grant)
                ||Text(grant,"hash")!=Hash(current)||Text(grant,"fileId")!=Root.FileIdentity(slot.File))throw new IOException("RECOVERY_AUTHORIZATION_REQUIRED");
        }
        public string Execute(string vaultPath,string technicalPath,string json,Action<string> checkpoint=null) {
            var opened=new List<FileStream>();var outputs=new List<Slot>();var inputs=new List<Slot>();
            Root vault=null,area=null;Mutex mutex=null;bool owns=false;Journal journal=null;
            JsonDocument document=null;string action=null;bool archiving=false;
            try {
                if(json.Length>24*1024*1024)throw new IOException("REQUEST_LIMIT");
                document=JsonDocument.Parse(json);{
                    var request=document.RootElement;var spec=request.GetProperty("spec");action=Text(request,"action");
                    if(!new[]{"apply","inspect","recover","rollback"}.Contains(action)||spec.GetProperty("version").GetInt32()!=1)throw new IOException("REQUEST_SCHEMA");
                    string serialized=spec.GetRawText(),digest=Hash(Encoding.UTF8.GetBytes(serialized));
                    if(digest!=Text(request,"preview"))throw new IOException("PREVIEW_CHANGED");
                    vault=new Root(vaultPath);area=new Root(technicalPath);
                    if(technicalPath.StartsWith(vault.Absolute+"\\",StringComparison.OrdinalIgnoreCase)||vault.Absolute.StartsWith(area.Absolute+"\\",StringComparison.OrdinalIgnoreCase)||vault.Identity==area.Identity)throw new IOException("BACKUP_MUST_BE_OUTSIDE_VAULT");
                    if(vault.Identity.Split(':')[0]!=area.Identity.Split(':')[0])throw new IOException("SAME_VOLUME_REQUIRED");
                    if(Hash(Encoding.UTF8.GetBytes(vault.Absolute))!=Text(spec,"rootId"))throw new IOException("ROOT_CHANGED");
                    if(Text(request,"rootFileId")!=vault.Identity)throw new IOException("ROOT_FILE_ID_CHANGED");
                    mutex=new Mutex(false,@"Local\OrbitSmartInbox-"+vault.Identity.Replace(':','-'));
                    try{owns=mutex.WaitOne(0);}catch(AbandonedMutexException){owns=true;}
                    if(!owns)throw new IOException("WRITER_BUSY");
                    checkpoint?.Invoke("mutex-acquired");
                    journal=new Journal(area,Hash(Encoding.UTF8.GetBytes(vault.Identity+"\n"+serialized)),serialized,action=="inspect");
                    var requestedArchive=request.GetProperty("archive").EnumerateArray().Select(e=>e.GetString()).ToHashSet(StringComparer.Ordinal);
                    foreach(var o in spec.GetProperty("outputs").EnumerateArray()) {
                        string path=Text(o,"path"),kind=Text(o,"kind");
                        var file=Optional(vault,path,action!="inspect",action=="rollback"&&kind=="create");
                        if(file!=null)opened.Add(file);
                        outputs.Add(new Slot{Spec=o,File=file,FileId=file==null?null:Root.FileIdentity(file)});
                    }
                    var made=new HashSet<string>(StringComparer.Ordinal);
                    foreach(var m in Mkdirs(spec))if(journal.Last("mkdir-intent",Text(m,"key"))!=null)made.Add(Text(m,"path"));
                    CheckDirectories(vault,spec,outputs,action!="rollback",made);
                    foreach(var c in spec.GetProperty("catalog").EnumerateArray()) {
                        if(outputs.Any(o=>Text(o.Spec,"path")==Text(c,"path")))continue;
                        var f=vault.Open(Text(c,"path"),false);opened.Add(f);if(Hash(Bytes(f))!=Text(c,"hash"))throw new IOException("CATALOG_CONTENT_CHANGED");
                    }
                    foreach(var i in spec.GetProperty("inputs").EnumerateArray()) {
                        string key=Text(i,"key"),path=Text(i,"path");bool move=requestedArchive.Contains(path)&&action!="inspect";
                        var f=Optional(vault,path,false,move);bool archived=f==null;
                        if(archived) {
                            var intent=journal.Last("archive-intent",key);
                            f=Optional(area,journal.Path("input-"+key+".input"),false,action=="rollback"&&move);
                            if(intent==null||f==null||Root.FileIdentity(f)!=intent["fileId"])throw new IOException("SOURCE_MISSING_OR_MOVED");
                        } else if(action!="rollback"&&journal.Last("archive-done",key)!=null)throw new IOException("ARCHIVED_SOURCE_REAPPEARED");
                        opened.Add(f);byte[] original=Bytes(f);if(Hash(original)!=Text(i,"hash"))throw new IOException("SOURCE_HASH_CHANGED");
                        inputs.Add(new Slot{Spec=i,File=f,FileId=Root.FileIdentity(f),Original=original,State=archived?"ARCHIVED":"PRESENT"});
                    }
                    foreach(var o in outputs) {
                        string key=Text(o.Spec,"key"),kind=Text(o.Spec,"kind");byte[] current=o.File==null?null:Bytes(o.File);
                        var before=o.Spec.GetProperty("before");string expectedBefore=before.ValueKind==JsonValueKind.Null?null:before.GetString();
                        var intent=journal.LastWrite("write-intent",key);var created=journal.LastWrite("created",key);var done=journal.LastWrite("done",key);var rolled=journal.Last("rollback-done",key);
                        if(action=="rollback") {
                            if(rolled!=null&&((kind=="create"&&current==null)||(kind=="append"&&current!=null&&Hash(current)==expectedBefore))){o.State="ROLLED_BACK";continue;}
                            var reversing=journal.Last("rollback-intent",key);
                            if(reversing!=null&&kind=="append"&&current!=null&&Hash(current)==expectedBefore&&o.FileId==reversing["fileId"]){o.State="ROLLED_BACK";continue;}
                            if(reversing!=null&&kind=="create"&&current==null) {
                                using(var saved=Optional(area,journal.Path("rollback-"+key+".note"))) {
                                    if(saved!=null&&Root.FileIdentity(saved)==reversing["fileId"]&&Hash(Bytes(saved))==reversing["hash"]){o.State="ROLLED_BACK";continue;}
                                }
                            }
                            if(current==null||Hash(current)!=Text(o.Spec,"after")||done==null||o.FileId!=done["fileId"])throw new IOException("ROLLBACK_CONFLICT");
                            o.Original=current;o.State="ROLLBACK_PENDING";continue;
                        }
                        if(rolled!=null)throw new IOException("PLAN_ALREADY_ROLLED_BACK");
                        if(current==null) {
                            if(kind!="create"||created!=null||done!=null)throw new IOException("DESTINATION_MISSING_OR_MOVED");
                            o.State="PENDING";continue;
                        }
                        if(kind=="append"&&Hash(current)==expectedBefore) {
                            if(done!=null)throw new IOException("DESTINATION_CHANGED_AFTER_APPLY");o.Original=current;o.State="PENDING";continue;
                        }
                        bool owned=intent!=null&&intent["fileId"]==o.FileId;
                        if(kind=="create")owned=created!=null&&created["fileId"]==o.FileId;
                        if(Hash(current)==Text(o.Spec,"after")&&owned){o.State="APPLIED";continue;}
                        if(done!=null)throw new IOException("DESTINATION_CHANGED_AFTER_APPLY");
                        if(intent==null&&kind=="append")throw new IOException("DESTINATION_HASH_CHANGED");
                        byte[] delta=Convert.FromBase64String(Text(o.Spec,"data"));
                        byte[] prefix=kind=="create"?Array.Empty<byte>():journal.BackupBytes("original-out-"+key+".bak",expectedBefore);
                        byte[] expected=prefix.Concat(delta).ToArray();
                        if(!Prefix(expected,current)||!Prefix(current,prefix))throw new IOException("DESTINATION_HASH_CHANGED");
                        o.State="RECOVERY_REQUIRED";o.Original=current;
                        if(action=="recover") {
                            CheckRecovery(request,o,current);
                            if(!owned&&kind!="create")throw new IOException("RECOVERY_IDENTITY_CHANGED");
                            o.RecoveringPartial=true;
                        } else if(action!="inspect")throw new IOException("RECOVERY_REQUIRED");
                    }
                    if(action=="inspect")return JsonSerializer.Serialize(new{state="INSPECTED",outputs=outputs.Select(o=>new{key=Text(o.Spec,"key"),path=Text(o.Spec,"path"),state=o.State,fileId=o.FileId,hash=o.File==null?null:Hash(Bytes(o.File))})});
                    if(action=="rollback") {
                        foreach(var o in outputs.Where(o=>o.State=="ROLLED_BACK")) {
                            string key=Text(o.Spec,"key");
                            if(journal.Last("rollback-done",key)==null)journal.Add("rollback-done",key,journal.Last("rollback-intent",key)["fileId"]);
                        }
                        foreach(var o in outputs.Where(o=>o.State!="ROLLED_BACK")) {
                            string key=Text(o.Spec,"key");journal.Backup("rolled-forward-"+key+".bak",o.Original);journal.Add("rollback-intent",key,o.FileId,Hash(o.Original));
                        }
                        checkpoint?.Invoke("rollback-backed-up");
                        foreach(var o in outputs.Where(o=>o.State!="ROLLED_BACK")) {
                            string key=Text(o.Spec,"key");
                            if(Text(o.Spec,"kind")=="create"){Root.Move(o.File,area,journal.Path("rollback-"+key+".note"));}
                            else {
                                var original=journal.BackupBytes("original-out-"+key+".bak",Text(o.Spec,"before"));
                                if(!Prefix(Bytes(o.File),original))throw new IOException("ROLLBACK_PREFIX_CHANGED");
                                o.File.SetLength(original.Length);o.File.Flush(true);if(Hash(Bytes(o.File))!=Text(o.Spec,"before"))throw new IOException("ROLLBACK_VERIFY_FAILED");
                            }
                            checkpoint?.Invoke("after-rollback-output");journal.Add("rollback-done",key,o.FileId);o.State="ROLLED_BACK";
                        }
                        foreach(var i in inputs.Where(i=>i.State=="ARCHIVED"&&requestedArchive.Contains(Text(i.Spec,"path")))) {
                            journal.Add("source-restore-intent",Text(i.Spec,"key"),i.FileId,Text(i.Spec,"hash"));
                            using(var restored=vault.Create(Text(i.Spec,"path"),true)) {
                                try {
                                    for(int at=0;at<i.Original.Length;at+=4096){restored.Write(i.Original,at,Math.Min(4096,i.Original.Length-at));restored.Flush(true);checkpoint?.Invoke("source-restore-write");}
                                    if(Hash(Bytes(restored))!=Text(i.Spec,"hash"))throw new IOException("RESTORE_VERIFY_FAILED");
                                    journal.Add("source-restored",Text(i.Spec,"key"),Root.FileIdentity(restored),Text(i.Spec,"hash"));
                                }catch{Root.Move(restored,area,journal.Path("failed-source-restore-"+Text(i.Spec,"key")+"-"+Guid.NewGuid().ToString("N")+".input"));throw;}
                            }
                            i.State="RESTORED";
                        }
                        return JsonSerializer.Serialize(new{state="ROLLED_BACK",outputs=outputs.Select(o=>o.State),inputs=inputs.Select(i=>i.State)});
                    }
                    foreach(var i in inputs)journal.Backup("original-src-"+Text(i.Spec,"key")+".bak",i.Original);
                    foreach(var o in outputs.Where(o=>o.State=="PENDING"&&Text(o.Spec,"kind")=="append"))journal.Backup("original-out-"+Text(o.Spec,"key")+".bak",o.Original);
                    foreach(var o in outputs.Where(o=>o.State!="APPLIED")) {
                        o.Prior=o.File==null?Array.Empty<byte>():Bytes(o.File);
                        if(o.File!=null)journal.Backup("before-attempt-"+Text(o.Spec,"key")+"-"+Hash(o.Prior)+".bak",o.Prior);
                    }
                    checkpoint?.Invoke("after-backup");
                    var knownDirs=spec.GetProperty("directories").EnumerateArray().Select(x=>Text(x,"path")).ToHashSet(StringComparer.Ordinal);
                    // Difesa in profondita (la policy e in JS), prima di creare qualsiasi cartella: ognuna e unica, un solo livello sotto una directory gia fissata e
                    // verificata (confronto esatto), non esiste tra quelle note, ed e il genitore diretto di almeno una nota create di questo piano.
                    var seenDirs=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    foreach(var m in Mkdirs(spec)) {
                        string checkPath=Text(m,"path");int checkCut=checkPath.LastIndexOf('/');
                        if(checkCut<=0||!knownDirs.Contains(checkPath.Substring(0,checkCut))||knownDirs.Contains(checkPath)||!seenDirs.Add(checkPath)
                            ||!outputs.Any(o=>Text(o.Spec,"kind")=="create"&&Text(o.Spec,"path").StartsWith(checkPath+"/",StringComparison.Ordinal)&&Text(o.Spec,"path").IndexOf('/',checkPath.Length+1)<0))throw new IOException("MKDIR_NOT_AUTHORIZED");
                    }
                    foreach(var m in Mkdirs(spec)) {
                        string dirPath=Text(m,"path"),dirKey=Text(m,"key");
                        if(journal.Last("mkdir-collision",dirKey)!=null)throw new IOException("MKDIR_COLLISION");
                        if(journal.Last("mkdir-done",dirKey)==null) {
                            checkpoint?.Invoke("before-mkdir");
                            // Primo tentativo: la creazione esclusiva (FILE_CREATE) fallisce se la cartella esiste gia (collisione registrata, mai adottata). Dopo un intent interrotto
                            // (crash o errore diverso da 183) una cartella gia presente si riprende solo se e vuota e non e un collegamento.
                            if(journal.Last("mkdir-intent",dirKey)==null){
                                journal.Add("mkdir-intent",dirKey);
                                try{vault.MakeDirectory(dirPath);}
                                catch(Win32Exception ex){if(ex.NativeErrorCode==183)journal.Add("mkdir-collision",dirKey);throw;}   // esisteva gia: mai adottata, il piano non si ripete
                            }
                            else{vault.EnsureTechnicalDirectory(dirPath);if(vault.Entries(dirPath,true).Length!=0)throw new IOException("MKDIR_TARGET_NOT_EMPTY");}
                            checkpoint?.Invoke("after-mkdir");
                            journal.Add("mkdir-done",dirKey);
                        }
                        made.Add(dirPath);
                    }
                    foreach(var o in outputs) {
                        string key=Text(o.Spec,"key"),kind=Text(o.Spec,"kind");
                        if(o.State=="APPLIED"){if(journal.LastWrite("done",key)==null)journal.Add("done",key,o.FileId,Text(o.Spec,"after"));continue;}
                        checkpoint?.Invoke("before-write");
                        if(o.File==null) {
                            journal.Add("create-intent",key);o.File=vault.Create(Text(o.Spec,"path"),true);opened.Add(o.File);o.FileId=Root.FileIdentity(o.File);o.CreatedNow=true;o.Touched=true;journal.Add("created",key,o.FileId);
                        }
                        if(action=="recover"&&kind=="create"&&journal.LastWrite("created",key)==null)journal.Add("created",key,o.FileId);
                        journal.Add("write-intent",key,o.FileId,Hash(Bytes(o.File)));
                        byte[] data=Convert.FromBase64String(Text(o.Spec,"data"));
                        long baseLength=kind=="create"?0:o.Spec.GetProperty("beforeLength").GetInt64();
                        if(kind=="append"&&o.File.Length<baseLength)throw new IOException("PREFIX_LENGTH_CHANGED");
                        int skip=checked((int)(o.File.Length-baseLength));if(skip<0||skip>data.Length)throw new IOException("PARTIAL_LENGTH_INVALID");
                        o.File.Position=o.File.Length;
                        o.Touched=true;
                        for(int at=skip;at<data.Length;at+=4096){int count=Math.Min(4096,data.Length-at);o.File.Write(data,at,count);o.File.Flush(true);checkpoint?.Invoke("after-write-chunk");}
                        o.File.Flush(true);if(Hash(Bytes(o.File))!=Text(o.Spec,"after"))throw new IOException("POST_WRITE_VERIFY_FAILED");
                        journal.Add("done",key,o.FileId,Text(o.Spec,"after"));o.State="APPLIED";
                    }
                    CheckDirectories(vault,spec,outputs,true,made);
                    // Le cartelle appena create contengono esattamente le note create da questo piano.
                    foreach(string md in made) {
                        var wanted=outputs.Where(o=>Text(o.Spec,"kind")=="create"&&o.File!=null&&Text(o.Spec,"path").StartsWith(md+"/")).Select(o=>Text(o.Spec,"path").Substring(md.Length+1)).ToHashSet(StringComparer.Ordinal);
                        if(!wanted.SetEquals(vault.Entries(md,true)))throw new IOException("NEW_DIRECTORY_NAMES_CHANGED");
                    }
                    checkpoint?.Invoke("after-write-before-archive");
                    archiving=requestedArchive.Count>0;
                    foreach(var i in inputs.Where(i=>requestedArchive.Contains(Text(i.Spec,"path"))&&i.State!="ARCHIVED")) {
                        checkpoint?.Invoke("before-archive");journal.Add("archive-intent",Text(i.Spec,"key"),i.FileId,Text(i.Spec,"hash"));
                        Root.Move(i.File,area,journal.Path("input-"+Text(i.Spec,"key")+".input"));
                        if(Hash(Bytes(i.File))!=Text(i.Spec,"hash"))throw new IOException("ARCHIVE_VERIFY_FAILED");
                        journal.Add("archive-done",Text(i.Spec,"key"),i.FileId,Text(i.Spec,"hash"));i.State="ARCHIVED";
                    }
                    return JsonSerializer.Serialize(new{state="APPLIED",outputs=outputs.Select(o=>o.State),inputs=inputs.Select(i=>i.State),manifest=journal.Directory});
                }
            }catch(Exception e){
                var cause=e.GetBaseException();var restoration=new List<object>();
                if(journal!=null&&!archiving&&(action=="apply"||action=="recover"))restoration=RestoreAttempt(journal,area,outputs);
                return JsonSerializer.Serialize(new{state="FAIL",code=cause.Message,nativeCode=cause is Win32Exception w?(int?)w.NativeErrorCode:null,outputs=outputs.Select(o=>o.State),restoration,manifest=journal?.Directory});
            }
            finally{foreach(var f in opened)f.Dispose();journal?.Dispose();if(owns)mutex.ReleaseMutex();mutex?.Dispose();vault?.Dispose();area?.Dispose();document?.Dispose();}
        }
    }
}
