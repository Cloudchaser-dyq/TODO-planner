'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');

const PREFIX = Buffer.from('YOUXU-PKU-VAULT\x00v1\x00', 'ascii');
const MAX_PLAIN = 20 * 1024, MAX_CIPHER = 64 * 1024;
const FILENAME = 'credentials.bin';

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function validCredentials(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes('username') || !keys.includes('password')) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some(key => !Object.hasOwn(descriptors[key], 'value'))) return false;
  const { username, password } = value;
  return typeof username === 'string' && username.length > 0 && username.length <= 200 && username === username.trim() &&
    typeof password === 'string' && password.length > 0 && password.length <= 4096 &&
    !/[\x00-\x1f\x7f]/.test(username + password);
}

// This script is constant: account data travels only through the child's pipes.
function windowsDPAPI(input, decrypt) {
  if (process.platform !== 'win32') return Promise.reject(failure('VAULT_CRYPTO_UNAVAILABLE', '保存账号需要 Windows 本机加密支持。'));
  const operation = decrypt ? 'Unprotect' : 'Protect';
  const script = '$ErrorActionPreference="Stop"; try { Add-Type -AssemblyName System.Security; ' +
    '$inputBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); ' +
    '$outputBytes=[Security.Cryptography.ProtectedData]::' + operation + '($inputBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); ' +
    '[Console]::Out.Write([Convert]::ToBase64String($outputBytes)); ' +
    '[Array]::Clear($inputBytes,0,$inputBytes.Length); [Array]::Clear($outputBytes,0,$outputBytes.Length); exit 0 } catch { exit 1 }';
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    let child, settled = false, size = 0, parts = [];
    const fail = () => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (child) child.kill();
      parts.forEach(part => part.fill(0)); parts = [];
      reject(failure('VAULT_CRYPTO_FAILED', '无法使用 Windows 本机加密，请检查当前 Windows 用户。'));
    };
    const timer = setTimeout(fail, 15000);
    try { child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { fail(); return; }
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stderr.resume();
    child.stdout.on('data', part => {
      size += part.length;
      if (size > Math.ceil(MAX_CIPHER / 3) * 4 + 16) { fail(); return; }
      if (!settled) parts.push(part);
    });
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) { fail(); return; }
      const encoded = Buffer.concat(parts).toString('ascii');
      parts.forEach(part => part.fill(0)); parts = [];
      if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) { fail(); return; }
      const output = Buffer.from(encoded, 'base64');
      if (!output.length || output.length > (decrypt ? MAX_PLAIN : MAX_CIPHER)) { output.fill(0); fail(); return; }
      settled = true; clearTimeout(timer); resolve(output);
    });
    child.stdin.end(input.toString('base64'));
  });
}

function createVault(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw failure('VAULT_OPTIONS_INVALID', '本机凭据存储配置无效。');
  let directory = options.directory;
  if (directory === undefined && process.platform === 'win32' && typeof process.env.LOCALAPPDATA === 'string') directory = path.join(process.env.LOCALAPPDATA, '有序', 'pku-sync');
  if (directory !== undefined && (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0'))) throw failure('VAULT_OPTIONS_INVALID', '本机凭据目录必须使用绝对路径。');
  if (options.protect !== undefined && typeof options.protect !== 'function' || options.unprotect !== undefined && typeof options.unprotect !== 'function') throw failure('VAULT_OPTIONS_INVALID', '本机凭据加密配置无效。');
  const protect = options.protect || (value => windowsDPAPI(value, false));
  const unprotect = options.unprotect || (value => windowsDPAPI(value, true));
  const filename = directory === undefined ? null : path.join(path.resolve(directory), FILENAME);
  let pending = Promise.resolve();
  function serial(action) {
    const next = pending.then(action);
    pending = next.catch(() => {});
    return next;
  }
  function requireDirectory() {
    if (!filename) throw failure('VAULT_CRYPTO_UNAVAILABLE', '保存账号需要 Windows 本机加密支持。');
  }
  async function checkDirectory(create) {
    requireDirectory();
    if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    let info;
    try { info = await fs.lstat(directory); } catch (error) { if (!create && error.code === 'ENOENT') return false; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid directory');
    return true;
  }
  async function readCipher() {
    if (!await checkDirectory(false)) return null;
    let handle;
    try {
      const info = await fs.lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size <= PREFIX.length || info.size > PREFIX.length + MAX_CIPHER) throw new Error('Invalid file');
      handle = await fs.open(filename, 'r');
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== info.size || opened.size > PREFIX.length + MAX_CIPHER) throw new Error('Invalid file');
      const data = Buffer.alloc(PREFIX.length + MAX_CIPHER + 1);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await handle.read(data, offset, data.length - offset, null);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset <= PREFIX.length || offset > PREFIX.length + MAX_CIPHER || !data.subarray(0, PREFIX.length).equals(PREFIX)) throw new Error('Invalid vault');
      return Buffer.from(data.subarray(PREFIX.length, offset));
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    finally { if (handle) await handle.close().catch(() => {}); }
  }
  return {
    save(value) {
      // Copy immediately, before callers can mutate credentials while queued.
      if (!validCredentials(value)) return Promise.reject(failure('VAULT_INVALID_CREDENTIALS', '账号或密码格式无效。'));
      const credentials = { username: value.username, password: value.password };
      return serial(async () => {
        let plain, encrypted, temp, handle;
        try {
          requireDirectory();
          plain = Buffer.from(JSON.stringify(credentials), 'utf8');
          if (plain.length > MAX_PLAIN) throw new Error('Oversized credentials');
          encrypted = await protect(plain);
          if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_CIPHER) throw new Error('Invalid encrypted data');
          await checkDirectory(true);
          try { const info = await fs.lstat(filename); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid file'); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          temp = path.join(directory, '.credentials-' + randomBytes(16).toString('hex') + '.tmp');
          handle = await fs.open(temp, 'wx', 0o600);
          await handle.writeFile(Buffer.concat([PREFIX, encrypted]));
          await handle.sync(); await handle.close(); handle = null;
          await fs.rename(temp, filename); temp = null;
        } catch (error) {
          if (error.code === 'VAULT_CRYPTO_UNAVAILABLE') throw error;
          throw failure('VAULT_WRITE_FAILED', '无法加密保存本机账号，请检查 Windows 用户与存储权限。');
        } finally {
          credentials.username = ''; credentials.password = '';
          if (plain) plain.fill(0);
          if (Buffer.isBuffer(encrypted)) encrypted.fill(0);
          if (handle) await handle.close().catch(() => {});
          if (temp) await fs.unlink(temp).catch(() => {});
        }
      });
    },
    load() {
      return serial(async () => {
        let plain;
        try {
          const encrypted = await readCipher();
          if (encrypted === null) return null;
          plain = await unprotect(encrypted);
          if (!Buffer.isBuffer(plain) || !plain.length || plain.length > MAX_PLAIN) throw new Error('Invalid decrypted data');
          const text = plain.toString('utf8');
          if (!Buffer.from(text, 'utf8').equals(plain)) throw new Error('Invalid UTF-8');
          const value = JSON.parse(text);
          if (!validCredentials(value)) throw new Error('Invalid credentials');
          return { username: value.username, password: value.password };
        } catch (error) {
          if (error.code === 'VAULT_CRYPTO_UNAVAILABLE') throw error;
          throw failure('VAULT_READ_FAILED', '无法读取本机保存的账号，请重新保存账号密码。');
        } finally { if (Buffer.isBuffer(plain)) plain.fill(0); }
      });
    },
    clear() {
      return serial(async () => {
        try {
          if (!await checkDirectory(false)) return;
          const info = await fs.lstat(filename);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid file');
          await fs.unlink(filename);
        } catch (error) {
          if (error.code === 'ENOENT') return;
          if (error.code === 'VAULT_CRYPTO_UNAVAILABLE') throw error;
          throw failure('VAULT_CLEAR_FAILED', '无法清除本机保存的账号，请检查存储权限。');
        }
      });
    },
    has() {
      return serial(async () => {
        try { return await readCipher() !== null; }
        catch (error) {
          if (error.code === 'VAULT_CRYPTO_UNAVAILABLE') throw error;
          throw failure('VAULT_READ_FAILED', '无法读取本机保存的账号，请重新保存账号密码。');
        }
      });
    }
  };
}

module.exports = { createVault };
