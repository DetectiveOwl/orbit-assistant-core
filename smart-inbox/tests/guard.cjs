'use strict';
// Guardia per test fidati, caricata prima della libreria; non e una sandbox per codice ostile.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { fileURLToPath } = require('node:url');
const assert = require('node:assert/strict');
require('node:test'); void process.stdout; void process.stderr;
const root = path.resolve(__dirname, '../../..');
const raw = Object.fromEntries(Object.keys(fs).filter(k => typeof fs[k] === 'function').map(k => [k, fs[k].bind(fs)]));
raw.native = fs.realpathSync.native;
const spec = JSON.parse(raw.readFileSync(path.join(root, 'control/spec.json'), 'utf8'));
const logFd = raw.openSync(spec.log, 'a');
const start = Date.now();
while (!raw.existsSync(spec.gate)) {
  if (Date.now() - start > 10000) throw new Error('Job Object non assegnato');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
let expected = 0, expectedHits = 0, unexpected = 0;
const reads = [], fdPaths = new Map();
const log = (type, data = {}) => raw.writeSync(logFd, JSON.stringify({ type, ...data }) + '\n');
function deny(why) { if (expected) expectedHits++; else unexpected++; log('denied', { why, expected: expected > 0 }); throw Object.assign(new Error('TEST_ACCESS_DENIED'), { code: 'EACCES' }); }
const inside = (p, r = root) => { const v = path.relative(r, p); return !v || v !== '..' && !v.startsWith('..' + path.sep) && !path.isAbsolute(v); };
const normalize = p => path.resolve(p instanceof URL ? fileURLToPath(p) : Buffer.isBuffer(p) ? p.toString() : p);
function check(p, metadata = false, noFollowLast = false, depth = 0) {
  const abs = normalize(p);
  if (!inside(abs)) { if (metadata && inside(root, abs)) return abs; return deny('outside-staging'); }
  if (depth > 10) return deny('link-cycle');
  let current = root;
  for (const part of path.relative(root, abs).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let st; try { st = raw.lstatSync(current); } catch (e) { if (e.code === 'ENOENT') break; throw e; }
    if (st.isSymbolicLink() && !(noFollowLast && current === abs)) {
      const target = path.resolve(path.dirname(current), raw.readlinkSync(current));
      if (!inside(target)) return deny('link-outside-staging');
      check(target, false, false, depth + 1);
    }
  }
  return abs;
}
function writable(p) {
  const abs = check(p);
  if (inside(abs, path.join(root, 'tmp')) || spec.phase === 'prepare' && inside(abs, path.join(root, 'data'))) return abs;
  return deny('read-only-source-or-vault');
}
function descriptor(fd) { if (!fdPaths.has(fd)) return deny('unknown-descriptor'); return fdPaths.get(fd); }
function readPath(p) {
  const abs = typeof p === 'number' ? descriptor(p) : check(p);
  if (inside(abs, path.join(root, 'data'))) {
    reads.push(path.relative(root, abs));
    if (path.relative(root, abs).replace(/\\/g, '/') === 'data/lettura/liste/Errore.md') {
      log('synthetic-read-fault'); throw Object.assign(new Error('SYNTHETIC_EACCES'), { code: 'EACCES' });
    }
  }
  return abs;
}
fs.openSync = function(p, flags, ...rest) {
  const write = typeof flags === 'number' ? !!(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC)) : /[wa+]/.test(flags);
  const abs = write ? writable(p) : readPath(p);
  const fd = raw.openSync(abs, flags, ...rest); fdPaths.set(fd, abs); return fd;
};
fs.closeSync = fd => { descriptor(fd); const r = raw.closeSync(fd); fdPaths.delete(fd); return r; };
fs.fstatSync = (fd, ...args) => { descriptor(fd); return raw.fstatSync(fd, ...args); };
fs.readSync = (fd, ...args) => {
  const abs = descriptor(fd);
  if (path.relative(root, abs).replace(/\\/g, '/') === 'data/parziale/liste/Parziale.md') { log('synthetic-short-read'); return 0; }
  return raw.readSync(fd, ...args);
};
fs.writeSync = (fd, ...args) => { if (![1, 2].includes(fd)) writable(descriptor(fd)); return raw.writeSync(fd, ...args); };
fs.readFileSync = (p, ...args) => { readPath(p); return raw.readFileSync(p, ...args); };
for (const name of ['lstatSync', 'statSync', 'existsSync', 'readlinkSync']) fs[name] = (p, ...args) => {
  check(p, ['lstatSync', 'statSync', 'existsSync'].includes(name), ['lstatSync', 'readlinkSync'].includes(name)); return raw[name](p, ...args);
};
fs.realpathSync = (p, ...args) => { check(p, true); return raw.realpathSync(p, ...args); };
fs.realpathSync.native = (p, ...args) => { check(p, true); return raw.native(p, ...args); };
fs.readdirSync = (p, ...args) => { check(p); return raw.readdirSync(p, ...args); };
for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'truncateSync', 'chmodSync', 'utimesSync']) fs[name] = (p, ...args) => {
  writable(p); return raw[name](p, ...args);
};
fs.symlinkSync = (target, p, ...args) => {
  if (spec.phase !== 'prepare') return deny('link-creation-disabled');
  writable(p); check(target); return raw.symlinkSync(target, p, ...args);
};
for (const name of ['unlinkSync', 'rmSync', 'rmdirSync', 'renameSync', 'copyFileSync', 'cpSync', 'linkSync', 'ftruncateSync', 'fchmodSync',
  'readFile', 'writeFile', 'open', 'opendir', 'readdir', 'createReadStream', 'createWriteStream', 'watch', 'watchFile']) fs[name] = () => deny('unsupported-filesystem-api');
Object.defineProperty(fs, 'promises', { configurable: false, get: () => deny('async-filesystem-disabled') });
const safeBuiltins = new Set(['fs', 'path', 'crypto', 'util', 'os', 'test', 'assert', 'assert/strict', 'url', 'buffer', 'events', 'stream', 'timers', 'timers/promises', 'async_hooks']);
const load = Module._load;
Module._load = function(request, parent, ...rest) {
  const builtin = request.replace(/^node:/, '');
  if (Module.builtinModules.includes(builtin) || request.startsWith('node:')) {
    if (!safeBuiltins.has(builtin)) return deny('module-disabled:' + builtin);
  } else {
    const resolved = path.resolve(parent?.filename ? path.dirname(parent.filename) : process.cwd(), request);
    const candidates = [resolved, resolved + '.js', resolved + '.cjs'];
    if (!candidates.some(p => spec.sources.includes(p))) return deny('module-not-in-manifest');
    if (parent?.filename && spec.core.includes(parent.filename) && candidates.some(p => p.endsWith('guard.cjs'))) return deny('core-cannot-import-test-guard');
  }
  return Reflect.apply(load, this, [request, parent, ...rest]);
};
const getBuiltin = process.getBuiltinModule;
if (getBuiltin) process.getBuiltinModule = request => require(request.startsWith('node:') ? request : 'node:' + request);
process.binding = () => deny('native-binding-disabled'); process.dlopen = () => deny('native-addon-disabled');
process.kill = () => deny('process-control-disabled');
global.fetch = () => deny('network-disabled'); global.WebSocket = class { constructor() { deny('network-disabled'); } };
process.once('beforeExit', () => { log('summary', { unexpected, expectedHits, reads: reads.length }); raw.closeSync(logFd); if (unexpected) process.exitCode = 91; });
module.exports = {
  root,
  verificaReparse(p) {
    const key = normalize(p).toLowerCase(), attrs = spec.attributes[key];
    if (!Number.isInteger(attrs)) throw Object.assign(new Error('NATIVE_ATTRIBUTES_NOT_SNAPSHOTTED'), { code: 'VERIFICA_REPARSE_INCOMPLETA' });
    return !!(attrs & 0x400);
  },
  accessiDati: () => reads.length,
  letture: () => [...reads],
  attendiDiniego(fn) { const n = expectedHits; expected++; try { assert.throws(fn, { code: 'EACCES' }); } finally { expected--; } assert.ok(expectedHits > n); }
};
