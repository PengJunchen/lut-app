'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseInvocation, validateInvocationSource } = require('../lib/ipc-contract.cjs');

test('IPC accepts only named routes with their fixed methods and bounded request fields', () => {
  assert.equal(parseInvocation('/api/state', { method: 'GET' }).kind, 'api');
  assert.deepEqual(
    parseInvocation('/api/preview', {
      method: 'POST',
      body: JSON.stringify({ input: '/source', output: '/source/Output', look: 'standard', recursive: false }),
    }).body,
    { input: '/source', output: '/source/Output', look: 'standard', recursive: false },
  );
  assert.equal(parseInvocation('/api/select-folder', {
    method: 'POST', body: JSON.stringify({ target: 'input', path: '/source' }),
  }).action, 'select-folder');

  assert.throws(() => parseInvocation('https://example.com/', { method: 'GET' }));
  assert.throws(() => parseInvocation('/api/run', { method: 'GET' }));
  assert.throws(() => parseInvocation('/api/export-report', {
    method: 'POST', body: JSON.stringify({ path: '/tmp/forged.json', report: { forged: true } }),
  }));
  assert.throws(() => parseInvocation('/api/run', {
    method: 'POST', body: JSON.stringify({ input: '/source', shell: 'open /tmp' }),
  }));
  assert.throws(() => parseInvocation('/api/select-folder', {
    method: 'POST', body: JSON.stringify({ target: 'input', path: 'x'.repeat(32 * 1024 + 1) }),
  }));
});

test('IPC accepts only the current top-level document and exact Go origin', () => {
  const frame = { url: 'http://127.0.0.1:41728/', parent: null };
  const contents = { mainFrame: frame };
  const window = { webContents: contents };

  assert.equal(validateInvocationSource({ sender: contents, senderFrame: frame }, window, 'http://127.0.0.1:41728'), true);
  assert.equal(validateInvocationSource({ sender: {}, senderFrame: frame }, window, 'http://127.0.0.1:41728'), false);
  assert.equal(validateInvocationSource({ sender: contents, senderFrame: { ...frame } }, window, 'http://127.0.0.1:41728'), false);

  frame.url = 'http://127.0.0.1:41728/';
  const childFrame = { url: 'http://127.0.0.1:41728/', parent: frame };
  assert.equal(validateInvocationSource({ sender: contents, senderFrame: childFrame }, window, 'http://127.0.0.1:41728'), false);

  frame.url = 'https://example.com/';
  assert.equal(validateInvocationSource({ sender: contents, senderFrame: frame }, window, 'http://127.0.0.1:41728'), false);
  frame.url = 'http://127.0.0.1:41728/#token=not-allowed-in-renderer';
  assert.equal(validateInvocationSource({ sender: contents, senderFrame: frame }, window, 'http://127.0.0.1:41728'), false);
});
