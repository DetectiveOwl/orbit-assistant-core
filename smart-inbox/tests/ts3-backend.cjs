'use strict';
const { spawn } = require('node:child_process');
const crypto = require('node:crypto'), path = require('node:path');

class NativeBackend {
  constructor(stage, runtime) {
    this.stage = stage; this.runtime = runtime; this.key = crypto.randomBytes(32); this.pending = new Map(); this.events = []; this.alive = true;
    const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'SMART_INBOX_TEST_STAGE', 'SMART_INBOX_TEST_RUNTIME'].map(k => [k, process.env[k]]));
    this.process = spawn(runtime, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(stage, 'repo/smart-inbox/tests/ts3-worker.ps1'), '-Stage', stage],
      { cwd: stage, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    this.errors = ''; let buffer = '';
    this.process.stdout.setEncoding('utf8'); this.process.stderr.setEncoding('utf8');
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.process.stderr.on('data', b => { this.errors = (this.errors + b).slice(-12000); });
    this.process.stdout.on('data', b => {
      buffer += b.toString('utf8');
      if (buffer.length > 33554432) { this.process.kill(); return; }
      let n;
      while ((n = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, n).trim(); buffer = buffer.slice(n + 1); if (!line) continue;
        let value; try { value = JSON.parse(line); } catch { this.process.kill(); continue; }
        if (value.ready) this.resolveReady();
        else if (value.event) this.events.push(value);
        else { const p = this.pending.get(value.id); if (p) { clearTimeout(p.timer); this.pending.delete(value.id); p.resolve(value.result); } }
      }
    });
    this.closed = new Promise(resolve => this.process.once('close', (code, signal) => {
      this.alive = false; const error = Object.assign(new Error('NATIVE_WORKER_CLOSED: ' + this.errors), { code, signal }); this.rejectReady(error);
      this.key.fill(0);
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); resolve({ code, signal });
    }));
    this.process.once('error', e => this.rejectReady(e));
    this.process.stdin.on('error', () => {});
    this.process.stdin.write(JSON.stringify({ key: this.key.toString('base64') }) + '\n');
  }
  async call(mode, caseId, payload = '') {
    await Promise.race([this.ready, new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('NATIVE_START_TIMEOUT')), 60000); t.unref(); })]);
    if (!this.alive) throw new Error('NATIVE_WORKER_NOT_RUNNING');
    const id = crypto.randomUUID(), data = id + '\n' + mode + '\n' + caseId + '\n' + payload;
    const packet = { id, mode, case: caseId, payload, mac: crypto.createHmac('sha256', this.key).update(data).digest('base64') };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); this.process.kill(); reject(new Error('NATIVE_REQUEST_TIMEOUT')); }, 45000);
      this.pending.set(id, { resolve, reject, timer }); this.process.stdin.write(JSON.stringify(packet) + '\n');
    });
  }
  async stop() { this.process.stdin.end(); return this.closed; }
}
module.exports = { NativeBackend };
