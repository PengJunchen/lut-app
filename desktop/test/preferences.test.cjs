'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createPreferenceStore } = require('../lib/preferences.cjs');
const { normalizeSystemLocale } = require('../lib/native-i18n.cjs');

test('OS locale normalization maps Chinese variants to simplified Chinese and all others to English', () => {
  assert.equal(normalizeSystemLocale('zh'), 'zh-CN');
  assert.equal(normalizeSystemLocale('zh-Hant-TW'), 'zh-CN');
  assert.equal(normalizeSystemLocale('ZH-hans-CN'), 'zh-CN');
  assert.equal(normalizeSystemLocale('en-US'), 'en');
  assert.equal(normalizeSystemLocale('fr-FR'), 'en');
  assert.equal(normalizeSystemLocale(undefined), 'en');
});

test('valid language preference overrides OS locale and writes only the whitelisted language', async (t) => {
  const directory = await makeTempDirectory(t);
  const filePath = path.join(directory, 'preferences.json');
  await fs.promises.writeFile(filePath, '{"language":"en"}', 'utf8');
  const store = createPreferenceStore({ filePath, getSystemLocale: () => 'zh-TW' });

  assert.equal(await store.load(), 'en');
  assert.equal(await store.setLanguage('zh-CN'), 'zh-CN');
  assert.equal(store.getLanguage(), 'zh-CN');
  assert.deepEqual(JSON.parse(await fs.promises.readFile(filePath, 'utf8')), { language: 'zh-CN' });
  assert.deepEqual(await fs.promises.readdir(directory), ['preferences.json']);
  if (process.platform !== 'win32') assert.equal((await fs.promises.stat(filePath)).mode & 0o077, 0);
});

test('missing, malformed, invalid, and extended preference files safely fall back to OS locale', async (t) => {
  const directory = await makeTempDirectory(t);
  const filePath = path.join(directory, 'preferences.json');
  const store = createPreferenceStore({ filePath, getSystemLocale: () => 'zh-Hans-CN' });

  assert.equal(await store.load(), 'zh-CN');
  await fs.promises.writeFile(filePath, '{', 'utf8');
  assert.equal(await store.load(), 'zh-CN');
  await fs.promises.writeFile(filePath, JSON.stringify({ language: 'fr' }), 'utf8');
  assert.equal(await store.load(), 'zh-CN');
  await fs.promises.writeFile(filePath, JSON.stringify({ language: 'en', theme: 'dark' }), 'utf8');
  assert.equal(await store.load(), 'zh-CN');
});

test('failed writes and invalid values leave the active language unchanged', async (t) => {
  const directory = await makeTempDirectory(t);
  const missingFile = path.join(directory, 'missing', 'preferences.json');
  const store = createPreferenceStore({ filePath: missingFile, getSystemLocale: () => 'en-GB' });
  await store.load();

  await assert.rejects(store.setLanguage('fr'));
  await assert.rejects(store.setLanguage('zh-CN'), { code: 'ENOENT' });
  assert.equal(store.getLanguage(), 'en');
});

test('unreadable preference files use the normalized OS locale', async (t) => {
  const directory = await makeTempDirectory(t);
  const filePath = path.join(directory, 'preferences.json');
  const store = createPreferenceStore({
    filePath,
    getSystemLocale: () => 'en-CA',
    fsPromises: { async readFile() { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); } },
  });
  assert.equal(await store.load(), 'en');
});

test('concurrent locale writes run in request order and persist the last requested language', async () => {
  const firstWrite = deferred();
  const state = createFakeFileState({
    async beforeWrite() {
      if (state.writes.length === 1) await firstWrite.promise;
    },
  });
  const store = createPreferenceStore({
    filePath: '/profile/preferences.json',
    getSystemLocale: () => 'zh-CN',
    fsPromises: state.fsPromises,
    randomId: (() => { let id = 0; return () => `id-${++id}`; })(),
  });
  await store.load();

  const first = store.setLanguage('en');
  await waitUntil(() => state.writes.length === 1);
  const second = store.setLanguage('zh-CN');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.writes.map((write) => write.language), ['en']);

  firstWrite.resolve();
  assert.deepEqual(await Promise.all([first, second]), ['en', 'zh-CN']);
  assert.deepEqual(state.writes.map((write) => write.language), ['en', 'zh-CN']);
  assert.deepEqual(JSON.parse(state.persisted), { language: 'zh-CN' });
  assert.equal(store.getLanguage(), 'zh-CN');
});

test('a failed queued locale write does not block a later successful selection', async () => {
  const firstWrite = deferred();
  const state = createFakeFileState({
    async beforeWrite(writeNumber) {
      if (writeNumber === 1) {
        await firstWrite.promise;
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }
    },
  });
  const store = createPreferenceStore({
    filePath: '/profile/preferences.json',
    getSystemLocale: () => 'zh-CN',
    fsPromises: state.fsPromises,
    randomId: (() => { let id = 0; return () => `failure-${++id}`; })(),
  });
  await store.load();

  const failed = store.setLanguage('en');
  await waitUntil(() => state.writes.length === 1);
  const succeeding = store.setLanguage('zh-CN');
  await new Promise((resolve) => setImmediate(resolve));
  firstWrite.resolve();

  await assert.rejects(failed, { code: 'ENOSPC' });
  assert.equal(await succeeding, 'zh-CN');
  assert.deepEqual(state.writes.map((write) => write.language), ['en', 'zh-CN']);
  assert.deepEqual(JSON.parse(state.persisted), { language: 'zh-CN' });
  assert.equal(store.getLanguage(), 'zh-CN');
  assert.equal(state.unlinked.length, 1);
});

function createFakeFileState({ beforeWrite = async () => undefined } = {}) {
  const temporaryFiles = new Map();
  const writes = [];
  const unlinked = [];
  let persisted = '';
  const fsPromises = {
    async readFile() { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); },
    async writeFile(filePath, contents, options) {
      const write = { filePath, language: JSON.parse(contents).language, options };
      writes.push(write);
      await beforeWrite(writes.length);
      temporaryFiles.set(filePath, contents);
    },
    async rename(temporaryPath, destinationPath) {
      assert.equal(destinationPath, '/profile/preferences.json');
      persisted = temporaryFiles.get(temporaryPath);
      assert.equal(typeof persisted, 'string');
      temporaryFiles.delete(temporaryPath);
    },
    async unlink(filePath) {
      unlinked.push(filePath);
      temporaryFiles.delete(filePath);
    },
  };
  return {
    fsPromises,
    writes,
    unlinked,
    get persisted() { return persisted; },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(predicate(), true, 'expected preference write to start');
}

async function makeTempDirectory(t) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dji-lut-prefs-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  return directory;
}
