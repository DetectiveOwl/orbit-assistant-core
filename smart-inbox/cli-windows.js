'use strict';
const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process'), { randomBytes } = require('node:crypto');
const { sha, errore } = require('./policy');
const { verificaScript, copiaVerificata, PIN_ENV } = require('./integrita');
const { verificaPerimetroFs } = require('./perimetro');

// PowerShell 7.6.7 win-x64 (release ufficiale PowerShell/PowerShell, firma Microsoft valida; pin precedente 362a356c... di origine ignota); questo adapter sperimentale non cerca eseguibili nel PATH.
const RUNTIME_SHA256 = 'fa2c8bb1e35cdd62ad15cd06a1d8f2c5961e9725a9bfa1e7cfd2c322f49e9619';
// aree: aree operative di Orbit decise dall'host (vault personale, dati, ...), che lo stage non puo toccare. Pin OBBLIGATORIO del manifest (fuori dal repo): SMART_INBOX_SCRIPT_MANIFEST_SHA256 (`node smart-inbox/integrita.js --pin`).
async function open(context, { aree = [], autoApplica = false, regole = { operazioni: ['create', 'append'], cartelle: null } } = {}) {
  if (process.platform !== 'win32') throw errore('WINDOWS_RICHIESTO');
  const runtime = process.env.SMART_INBOX_PWSH;
  if (!runtime || !/^[a-z]:\\/i.test(runtime) || !path.isAbsolute(runtime) || path.basename(runtime).toLowerCase() !== 'pwsh.exe'
    || sha(fs.readFileSync(runtime)) !== RUNTIME_SHA256) throw errore('RUNTIME_PWSH_NON_VERIFICATO');
  verificaPerimetroFs(context, { aree });
  const scripts = verificaScript({ pin: process.env[PIN_ENV] || null, obbligatorio: true });
  const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: path.dirname(runtime) };
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) env[key] = path.join(context.stage, 'home');
  for (const key of ['TEMP', 'TMP']) env[key] = path.join(context.stage, 'tmp');
  // Il bridge parte da una copia dei byte appena verificati (non dal repo): nessuna finestra tra verifica e uso.
  let copy, proc;
  try {
    copy = copiaVerificata(scripts, path.join(context.stage, 'tmp', 'bridge-' + randomBytes(8).toString('hex')));
    proc = spawn(runtime, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(copy.dir, 'cli-host.ps1'), '-Stage', context.stage, '-CsSha256', copy.hashCs, ...(autoApplica === true ? ['-AutoAdditive', '-AutoOps', regole.operazioni.join(','), ...(regole.cartelle ? ['-AutoFolders', Buffer.from(JSON.stringify(regole.cartelle)).toString('base64')] : [])] : [])],
      { env, cwd: context.stage, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch { if (copy) fs.rmSync(copy.dir, { recursive: true, force: true }); throw errore('HOST_NATIVO_NON_AVVIATO'); }
  const pending = new Map(); let buffer = '', errors = '', next = 0, ended = false;
  const closed = new Promise(resolve => proc.once('close', (code, signal) => {
    ended = true; try { fs.rmSync(copy.dir, { recursive: true, force: true }); } catch { /* resta in stage/tmp, sintetico */ }
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(errore('HOST_NATIVO_TERMINATO')); }
    pending.clear(); resolve({ code, signal });
  }));
  proc.once('error', () => { for (const p of pending.values()) p.reject(errore('HOST_NATIVO_NON_AVVIATO')); });
  proc.stdin.on('error', () => {});
  proc.stderr.on('data', text => { errors = (errors + text).slice(-4096); });
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', text => {
    buffer += text;
    if (buffer.length > 32 * 1024 * 1024) { proc.kill(); return; }
    let n;
    while ((n = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, n).trim(); buffer = buffer.slice(n + 1); if (!line) continue;
      let answer; try { answer = JSON.parse(line); } catch { proc.kill(); return; }
      const p = pending.get(answer.id); if (!p) { proc.kill(); return; }
      clearTimeout(p.timer); pending.delete(answer.id);
      if (answer.error) p.reject(errore(answer.error)); else p.resolve(answer.result);
    }
  });
  async function call(mode, payload = '') {
    if (ended) throw errore('HOST_NATIVO_TERMINATO');
    const id = ++next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { proc.kill(); reject(errore('HOST_NATIVO_TIMEOUT')); }, 180000);
      pending.set(id, { resolve, reject, timer });
      proc.stdin.write(JSON.stringify({ id, mode, vault: context.vault, technical: context.technical, payload }) + '\n');
    });
  }
  return {
    attributes: () => call('attributes'), confirm: body => call('confirm', body), execute: body => call('execute', body),
    async close() { if (!ended) proc.stdin.end(); const result = await closed; if (result.code !== 0 || errors.trim()) throw errore('HOST_NATIVO_CHIUSURA_NON_REGOLARE'); }
  };
}
module.exports = { open };
