'use strict';
// Cifratura dei token con Windows DPAPI (legata all'utente Windows corrente: un altro utente o un altro PC non puo decifrarli).
// Nessuna dipendenza: si usa .NET tramite PowerShell. Il segreto passa SOLO da stdin, mai dagli argomenti del processo.
const { spawn } = require('child_process');

const PS = 'powershell.exe';
const ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
const CIFRA = "Add-Type -AssemblyName System.Security; $t=[Console]::In.ReadToEnd(); $b=[Text.Encoding]::UTF8.GetBytes($t); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))";
const DECIFRA = "Add-Type -AssemblyName System.Security; $t=[Console]::In.ReadToEnd().Trim(); $b=[Convert]::FromBase64String($t); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";

function esegui(script, stdin) {
  return new Promise((resolve, reject) => {
    let out = '';
    const p = spawn(PS, ARGS.concat([script]), { windowsHide: true });
    const t = setTimeout(() => { try { p.kill(); } catch (e) { /* gia chiuso */ } reject(new Error('Cifratura scaduta.')); }, 20000);
    p.stdout.on('data', d => { out += d.toString('utf8'); });
    p.on('error', () => { clearTimeout(t); reject(new Error('PowerShell non disponibile per la cifratura.')); });
    p.on('close', code => { clearTimeout(t); code === 0 && out.trim() ? resolve(out.trim()) : reject(new Error('Cifratura o decifratura non riuscita.')); });
    p.stdin.on('error', () => { /* il processo puo chiudersi prima */ });
    p.stdin.end(stdin, 'utf8');
  });
}

const dpapi = { nome: 'Windows DPAPI', cifra: testo => esegui(CIFRA, testo), decifra: b64 => esegui(DECIFRA, b64) };

module.exports = { dpapi };
