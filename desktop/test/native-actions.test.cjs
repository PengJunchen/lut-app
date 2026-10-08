'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createNativeActions, nearestExistingDirectory } = require('../lib/native-actions.cjs');
const { parseInvocation } = require('../lib/ipc-contract.cjs');

test('folder picker starts at the closest existing parent and preserves the original path on cancel', async (t) => {
  const root = await makeTempDirectory(t);
  const original = path.join(root, 'missing', 'nested');
  const parent = { isDestroyed: () => false };
  let openedWith;
  const actions = createNativeActions({
    dialog: {
      async showOpenDialog(window, options) {
        openedWith = { window, options };
        return { canceled: true, filePaths: [] };
      },
    },
    shell: {},
    apiClient: {},
    getWindow: () => parent,
    defaultInput: root,
  });

  const response = await actions.selectFolder({ target: 'input', path: original });
  assert.equal(response.status, 200);
  assert.deepEqual(response.payload, { path: original, cancelled: true });
  assert.equal(openedWith.window, parent);
  assert.equal(openedWith.options.defaultPath, root);
  assert.deepEqual(openedWith.options.properties, ['openDirectory']);
  assert.equal(await nearestExistingDirectory(original), root);
});

test('a folder selection that returns after quit is treated as cancelled', async (t) => {
  const root = await makeTempDirectory(t);
  let finishDialog;
  let closing = false;
  const actions = createNativeActions({
    dialog: {
      showOpenDialog() { return new Promise((resolve) => { finishDialog = resolve; }); },
    },
    shell: {},
    apiClient: {},
    getWindow: () => ({ isDestroyed: () => false }),
    isClosing: () => closing,
    defaultInput: root,
  });

  const pending = actions.selectFolder({ target: 'input', path: root });
  await waitUntil(() => typeof finishDialog === 'function');
  closing = true;
  finishDialog({ canceled: false, filePaths: [root] });
  const response = await pending;
  assert.deepEqual(response.payload, { path: root, cancelled: true });
});

test('open-output checks Go finished state and validates the directory before opening it', async (t) => {
  const root = await makeTempDirectory(t);
  const opened = [];
  let state = { finished: false, output_root: root };
  const actions = createNativeActions({
    dialog: {},
    shell: { async openPath(value) { opened.push(value); return ''; } },
    apiClient: { async getState() { return { status: 200, ok: true, payload: state }; } },
    getWindow: () => ({ isDestroyed: () => false }),
  });

  const early = await actions.openOutput();
  assert.equal(early.status, 409);
  assert.deepEqual(opened, []);

  state = { finished: true, output_root: root };
  const done = await actions.openOutput();
  assert.equal(done.status, 200);
  assert.equal(opened[0], await fs.promises.realpath(root));

  state = { finished: true, output_root: path.join(root, 'missing') };
  const missing = await actions.openOutput();
  assert.equal(missing.status, 400);
  assert.equal(opened.length, 1);
});

test('export-report writes only the finished Go report selected through the save dialog', async (t) => {
  const root = await makeTempDirectory(t);
  const target = path.join(root, 'saved-report');
  const report = { summary: { total: 1 }, items: [{ input: '/media/clip.mp4', status: 'encoded' }] };
  let savedOptions;
  const actions = createNativeActions({
    dialog: {
      async showSaveDialog(window, options) {
        savedOptions = { window, options };
        return { canceled: false, filePath: target };
      },
    },
    shell: {},
    apiClient: { async getState() { return { status: 200, ok: true, payload: { finished: true, running: false, output_root: root, report } }; } },
    getWindow: () => ({ isDestroyed: () => false }),
  });

  const result = await actions.exportReport();
  assert.equal(result.status, 200);
  assert.equal(result.payload.path, `${target}.json`);
  assert.equal(savedOptions.options.defaultPath, path.join(root, 'dji-lut-report.json'));
  assert.deepEqual(JSON.parse(await fs.promises.readFile(result.payload.path, 'utf8')), report);

  assert.throws(() => parseInvocation('/api/export-report', {
    method: 'POST', body: JSON.stringify({ path: '/arbitrary/path.json', report: { attacker: true } }),
  }));
});

test('report dialog returning after quit cannot create a file', async (t) => {
  const root = await makeTempDirectory(t);
  const target = path.join(root, 'late-report.json');
  let finishDialog;
  let closing = false;
  const actions = createNativeActions({
    dialog: { showSaveDialog() { return new Promise((resolve) => { finishDialog = resolve; }); } },
    shell: {},
    apiClient: { async getState() { return { status: 200, ok: true, payload: { finished: true, report: { summary: {} }, output_root: root } }; } },
    getWindow: () => ({ isDestroyed: () => false }),
    isClosing: () => closing,
  });

  const pending = actions.exportReport();
  await waitUntil(() => typeof finishDialog === 'function');
  closing = true;
  finishDialog({ canceled: false, filePath: target });
  const response = await pending;
  assert.deepEqual(response.payload, { cancelled: true });
  await assert.rejects(fs.promises.stat(target), { code: 'ENOENT' });
});

test('native folder and report dialogs use the latest selected language', async (t) => {
  const root = await makeTempDirectory(t);
  const dialogCalls = [];
  let language = 'en';
  const actions = createNativeActions({
    dialog: {
      async showOpenDialog(_window, options) {
        dialogCalls.push(options);
        return { canceled: true, filePaths: [] };
      },
      async showSaveDialog(_window, options) {
        dialogCalls.push(options);
        return { canceled: true, filePath: '' };
      },
    },
    shell: {},
    apiClient: {
      async getState() {
        return { status: 200, ok: true, payload: { finished: true, running: false, output_root: root, report: { summary: {} } } };
      },
    },
    getWindow: () => ({ isDestroyed: () => false }),
    getLanguage: () => language,
    defaultInput: root,
  });

  await actions.selectFolder({ target: 'input', path: root });
  language = 'zh-CN';
  await actions.selectFolder({ target: 'output', path: root });
  language = 'en';
  await actions.exportReport();

  assert.equal(dialogCalls[0].title, 'Choose source folder');
  assert.equal(dialogCalls[1].title, '选择结果保存文件夹');
  assert.equal(dialogCalls[2].title, 'Export processing report');
  assert.equal(dialogCalls[2].filters[0].name, 'JSON report');
});

test('language preference action persists before reporting acceptance and refreshes native UI', async () => {
  let language = 'zh-CN';
  let changedTo = '';
  let shouldFail = false;
  const preferences = {
    getLanguage: () => language,
    async setLanguage(nextLanguage) {
      if (shouldFail) throw new Error('filesystem detail');
      language = nextLanguage;
    },
  };
  const actions = createNativeActions({
    dialog: {},
    shell: {},
    apiClient: {},
    getWindow: () => ({ isDestroyed: () => false }),
    preferences,
    getLanguage: () => language,
    onLanguageChanged: (nextLanguage) => { changedTo = nextLanguage; },
  });

  assert.deepEqual(await actions.getDesktopPreferences(), { status: 200, ok: true, payload: { language: 'zh-CN' } });
  assert.deepEqual(await actions.setDesktopLanguage({ language: 'en' }), { status: 200, ok: true, payload: { language: 'en' } });
  assert.equal(changedTo, 'en');
  shouldFail = true;
  const failed = await actions.setDesktopLanguage({ language: 'zh-CN' });
  assert.equal(failed.status, 500);
  assert.equal(failed.payload.error, 'Language preference could not be saved');
  assert.equal(language, 'en');
});

test('language preference reports unavailable storage without claiming an invalid locale', async () => {
  const actions = createNativeActions({
    dialog: {},
    shell: {},
    apiClient: {},
    getWindow: () => ({ isDestroyed: () => false }),
    getLanguage: () => 'en',
  });
  const response = await actions.setDesktopLanguage({ language: 'en' });
  assert.equal(response.status, 500);
  assert.equal(response.payload.error, 'Language preference could not be saved');
});

async function makeTempDirectory(t) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dji-lut-desktop-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(predicate(), true, 'expected native dialog to open');
}
