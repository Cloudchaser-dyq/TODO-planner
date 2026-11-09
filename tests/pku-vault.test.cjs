'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { createVault } = require('../pku-vault.cjs');

const FAKE = Object.freeze({ username: 'fictional-vault-account', password: 'fictional-password-保密!42' });
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youxu-vault-test-'));
  t.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  return directory;
}
function injected(directory) {
  const key = randomBytes(32);
  const protect = async plain => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  };
  const unprotect = async encrypted => {
    const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12));
    decipher.setAuthTag(encrypted.subarray(12, 28));
    return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]);
  };
  return { directory, protect, unprotect };
}
function safeError(error) {
  assert.doesNotMatch(error.message, /fictional|password-|保密|SECRET|sensitive/);
  return true;
}

test('vault stores only ciphertext outside task state and supports read, presence and idempotent clear', async t => {
  const directory = await temporary(t), vault = createVault(injected(directory));
  assert.equal(await vault.has(), false); assert.equal(await vault.load(), null); await vault.clear();
  await vault.save(FAKE);
  const disk = await fs.readFile(path.join(directory, 'credentials.bin'));
  assert.match(disk.toString('ascii', 0, 15), /^YOUXU-PKU-VAULT/);
  assert.equal(disk.includes(Buffer.from(FAKE.username)), false);
  assert.equal(disk.includes(Buffer.from(FAKE.password)), false);
  assert.equal(await vault.has(), true); assert.deepEqual(await vault.load(), FAKE);
  assert.deepEqual(await fs.readdir(directory), ['credentials.bin']);
  await vault.clear(); await vault.clear();
  assert.equal(await vault.has(), false); assert.deepEqual(await fs.readdir(directory), []);
});

test('vault rejects malformed credentials without executing encryption', async t => {
  const directory = await temporary(t); let calls = 0;
  const vault = createVault({ directory, protect: async () => { calls++; throw new Error('SECRET'); } });
  const getter = {}; Object.defineProperties(getter, { username: { get() { throw new Error('SECRET'); }, enumerable: true }, password: { value: 'x', enumerable: true } });
  for (const value of [null, [], {}, { username: '', password: 'x' }, { username: ' x', password: 'x' }, { username: 'x', password: '' }, { username: 'x', password: 'x\n' }, { username: 'x', password: 'x', token: 'sensitive' }, { username: 'x', password: 'x'.repeat(4097) }, getter]) {
    await assert.rejects(vault.save(value), error => { assert.equal(error.code, 'VAULT_INVALID_CREDENTIALS'); return safeError(error); });
  }
  assert.equal(calls, 0); assert.deepEqual(await fs.readdir(directory), []);
});

test('vault serializes writes and snapshots inputs before queued work begins', async t => {
  const directory = await temporary(t), vault = createVault(injected(directory));
  const first = { username: 'first', password: 'one' }, second = { username: 'second', password: 'two' };
  const a = vault.save(first), b = vault.save(second), c = vault.load();
  first.password = 'changed'; second.password = 'changed';
  await Promise.all([a, b]); assert.deepEqual(await c, { username: 'second', password: 'two' });
  await Promise.all([vault.save(FAKE), vault.clear()]); assert.equal(await vault.has(), false);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('failed encryption preserves an existing saved vault and reports no secrets', async t => {
  const directory = await temporary(t), options = injected(directory), vault = createVault(options);
  await vault.save(FAKE); const before = await fs.readFile(path.join(directory, 'credentials.bin'));
  const broken = createVault({ ...options, protect: async () => { throw new Error('SECRET ' + FAKE.password); } });
  await assert.rejects(broken.save(FAKE), error => { assert.equal(error.code, 'VAULT_WRITE_FAILED'); return safeError(error); });
  assert.deepEqual(await fs.readFile(path.join(directory, 'credentials.bin')), before);
  assert.deepEqual(await vault.load(), FAKE); assert.deepEqual(await fs.readdir(directory), ['credentials.bin']);
});

test('vault rejects corrupt, truncated, oversized and invalid decrypted data with generic errors', async t => {
  const directory = await temporary(t), options = injected(directory), vault = createVault(options), filename = path.join(directory, 'credentials.bin');
  await vault.save(FAKE); const valid = await fs.readFile(filename);
  for (const invalid of [Buffer.from('SECRET'), valid.subarray(0, 19), Buffer.alloc(70000), Buffer.concat([valid.subarray(0, 18), Buffer.from('damaged')])]) {
    await fs.writeFile(filename, invalid);
    await assert.rejects(vault.load(), error => { assert.equal(error.code, 'VAULT_READ_FAILED'); return safeError(error); });
  }
  await fs.writeFile(filename, valid);
  for (const plain of [Buffer.from('SECRET'), Buffer.from('{"username":"x","password":"y","cookie":"sensitive"}'), Buffer.alloc(25000), Buffer.from([0xff])]) {
    const broken = createVault({ directory, protect: options.protect, unprotect: async () => Buffer.from(plain) });
    await assert.rejects(broken.load(), safeError);
  }
});

test('vault refuses directory/file substitutions without touching outside data', async t => {
  const directory = await temporary(t), outside = await temporary(t), options = injected(directory), vault = createVault(options);
  const target = path.join(outside, 'untouched'); await fs.writeFile(target, 'keep');
  await fs.mkdir(path.join(directory, 'credentials.bin'));
  await assert.rejects(vault.save(FAKE), safeError); await assert.rejects(vault.load(), safeError); await assert.rejects(vault.clear(), safeError);
  await fs.rmdir(path.join(directory, 'credentials.bin'));
  try { await fs.symlink(target, path.join(directory, 'credentials.bin')); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return; throw error; }
  await assert.rejects(vault.save(FAKE), safeError); await assert.rejects(vault.load(), safeError); await assert.rejects(vault.clear(), safeError);
  assert.equal(await fs.readFile(target, 'utf8'), 'keep');
});

test('vault requires an absolute directory and validates crypto configuration', () => {
  for (const options of [{ directory: 'relative' }, { directory: '/bad\0path' }, { protect: true }, { unprotect: 'x' }, null]) assert.throws(() => createVault(options), /本机凭据/);
});

test('non-Windows default encryption never falls back to plaintext', { skip: process.platform === 'win32' }, async t => {
  const directory = await temporary(t), vault = createVault({ directory });
  await assert.rejects(vault.save(FAKE), error => { assert.equal(error.code, 'VAULT_CRYPTO_UNAVAILABLE'); return safeError(error); });
  assert.deepEqual(await fs.readdir(directory), []);
});

test('Windows DPAPI CurrentUser roundtrip uses only fictional credentials in a temporary directory', { skip: process.platform !== 'win32' }, async t => {
  const directory = await temporary(t), vault = createVault({ directory });
  await vault.save(FAKE); assert.deepEqual(await vault.load(), FAKE);
  const stored = await fs.readFile(path.join(directory, 'credentials.bin'));
  assert.equal(stored.includes(Buffer.from(FAKE.username)), false); assert.equal(stored.includes(Buffer.from(FAKE.password)), false);
  await vault.clear(); assert.equal(await vault.has(), false);
});
