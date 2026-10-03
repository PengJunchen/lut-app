'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseReadyLine, sanitizeDiagnostic } = require('../lib/protocol.cjs');

test('ready protocol extracts the main-process token and strips the fragment from the load URL', () => {
  const ready = parseReadyLine(JSON.stringify({
    type: 'ready',
    protocol: 1,
    url: 'http://127.0.0.1:48231/#token=0123456789abcdef0123456789abcdef',
  }));

  assert.equal(ready.origin, 'http://127.0.0.1:48231');
  assert.equal(ready.loadURL, 'http://127.0.0.1:48231');
  assert.equal(ready.token, '0123456789abcdef0123456789abcdef');
  assert.equal(JSON.stringify(ready).includes('#token'), false);
});

test('ready protocol rejects remote, malformed, and incompatible endpoints', () => {
  const invalid = [
    { type: 'ready', protocol: 1, url: 'https://127.0.0.1:48231/#token=0123456789abcdef0123456789abcdef' },
    { type: 'ready', protocol: 1, url: 'http://example.com:48231/#token=0123456789abcdef0123456789abcdef' },
    { type: 'ready', protocol: 2, url: 'http://127.0.0.1:48231/#token=0123456789abcdef0123456789abcdef' },
    { type: 'ready', protocol: 1, url: 'http://127.0.0.1:48231/#token=short' },
    { type: 'ready', protocol: 1, url: 'http://127.0.0.1:48231/#token=0123456789abcdef0123456789abcdef&other=value' },
  ];

  for (const message of invalid) {
    assert.throws(() => parseReadyLine(JSON.stringify(message)));
  }
});

test('startup diagnostics redact token fragments and bearer credentials', () => {
  const detail = sanitizeDiagnostic('failed http://127.0.0.1:8000/#token=secret Bearer abc123', 'secret');
  assert.equal(detail.includes('secret'), false);
  assert.equal(detail.includes('abc123'), false);
});
