'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createNativeActions } = require('../lib/native-actions.cjs');
const { createRequestDispatcher } = require('../lib/request-dispatcher.cjs');

test('dispatcher reaches native folder, output, report, and shutdown handlers', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dji-lut-dispatch-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const frame = { url: 'http://127.0.0.1:43109/', parent: null };
  const contents = { mainFrame: frame };
  const window = { webContents: contents, isDestroyed: () => false };
  const openedPaths = [];
  const dialogCalls = [];
  let scheduleCount = 0;
  const apiClient = {
    async getState() {
      return { status: 200, ok: true, payload: { finished: true, running: false, output_root: root, report: { summary: {} } } };
    },
    async request(route, method) { return { status: 200, ok: true, payload: { route, method } }; },
  };
  const nativeActions = createNativeActions({
    dialog: {
      async showOpenDialog(parent, options) {
        dialogCalls.push({ kind: 'open', parent, options });
        return { canceled: true, filePaths: [] };
      },
      async showSaveDialog(parent, options) {
        dialogCalls.push({ kind: 'save', parent, options });
        return { canceled: true, filePath: '' };
      },
    },
    shell: { async openPath(value) { openedPaths.push(value); return ''; } },
    apiClient,
    getWindow: () => window,
    defaultInput: root,
  });
  const lifecycle = { quitting: false, track: (operation) => operation(), scheduleQuit: () => { scheduleCount++; } };
  const dispatch = createRequestDispatcher({
    getWindow: () => window,
    getOrigin: () => 'http://127.0.0.1:43109',
    apiClient,
    nativeActions,
    lifecycle,
  });
  const event = { sender: contents, senderFrame: frame };

  const selected = await dispatch(event, '/api/select-folder', {
    method: 'POST', body: JSON.stringify({ target: 'input', path: root }),
  });
  assert.equal(selected.status, 200);
  assert.equal(selected.payload.cancelled, true);
  assert.equal(dialogCalls[0].kind, 'open');
  assert.equal(dialogCalls[0].parent, window);

  const opened = await dispatch(event, '/api/open-output', { method: 'POST', body: '{}' });
  assert.equal(opened.status, 200);
  assert.deepEqual(openedPaths, [await fs.promises.realpath(root)]);

  const report = await dispatch(event, '/api/export-report', { method: 'POST', body: '{}' });
  assert.equal(report.status, 200);
  assert.equal(report.payload.cancelled, true);
  assert.equal(dialogCalls[1].kind, 'save');

  const shutdown = await dispatch(event, '/api/shutdown', { method: 'POST', body: '{}' });
  assert.equal(shutdown.status, 202);
  assert.equal(scheduleCount, 1);
});

test('desktop language routes require the authenticated current main frame', async () => {
  const frame = { url: 'http://127.0.0.1:43110/', parent: null };
  const contents = { mainFrame: frame };
  const window = { webContents: contents };
  let language = 'zh-CN';
  let setCount = 0;
  const dispatcher = createRequestDispatcher({
    getWindow: () => window,
    getOrigin: () => 'http://127.0.0.1:43110',
    apiClient: {},
    nativeActions: {
      async getDesktopPreferences() { return { status: 200, ok: true, payload: { language } }; },
      async setDesktopLanguage({ language: nextLanguage }) {
        setCount++;
        language = nextLanguage;
        return { status: 200, ok: true, payload: { language } };
      },
    },
    lifecycle: { quitting: false, track: (operation) => operation(), scheduleQuit() {} },
    getLanguage: () => language,
  });
  const mainFrameEvent = { sender: contents, senderFrame: frame };

  const read = await dispatcher(mainFrameEvent, '/api/desktop-preferences', { method: 'GET' });
  assert.deepEqual(read.payload, { language: 'zh-CN' });
  const update = await dispatcher(mainFrameEvent, '/api/desktop-language', {
    method: 'POST', body: JSON.stringify({ language: 'en' }),
  });
  assert.deepEqual(update.payload, { language: 'en' });
  assert.equal(setCount, 1);

  const childFrame = { url: frame.url, parent: frame };
  const childRequest = await dispatcher({ sender: contents, senderFrame: childFrame }, '/api/desktop-language', {
    method: 'POST', body: JSON.stringify({ language: 'zh-CN' }),
  });
  const otherOrigin = await dispatcher({ sender: contents, senderFrame: { url: 'https://example.com/', parent: null } }, '/api/desktop-language', {
    method: 'POST', body: JSON.stringify({ language: 'zh-CN' }),
  });
  const otherSender = await dispatcher({ sender: {}, senderFrame: frame }, '/api/desktop-preferences', { method: 'GET' });
  assert.equal(childRequest.status, 403);
  assert.equal(otherOrigin.status, 403);
  assert.equal(otherSender.status, 403);
  assert.equal(setCount, 1);
  assert.equal(language, 'en');
});
