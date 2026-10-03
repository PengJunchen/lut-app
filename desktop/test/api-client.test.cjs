'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { ApiClient } = require('../lib/api-client.cjs');

test('API client sends only fixed loopback paths with bearer and same-origin headers', async (t) => {
  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push({ url: request.url, method: request.method, headers: request.headers });
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ running: false }));
    });
  });
  const origin = await listen(server);
  t.after(() => close(server));
  const client = new ApiClient({ origin, token: '0123456789abcdef0123456789abcdef', requestTimeoutMs: 5_000 });

  const response = await client.request('/api/state', 'GET');
  assert.equal(response.status, 200);
  assert.equal(response.ok, true);
  assert.deepEqual(response.payload, { running: false });
  assert.equal(seen[0].url, '/api/state');
  assert.equal(seen[0].headers.authorization, 'Bearer 0123456789abcdef0123456789abcdef');
  assert.equal(seen[0].headers.origin, origin);

  const denied = await client.request('/api/open-output', 'POST', {});
  assert.equal(denied.ok, false);
  assert.equal(seen.length, 1);
});

test('long metadata scans are not cut off by the ordinary request timeout', async (t) => {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => setTimeout(() => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ items: [] }));
    }, 60));
  });
  const origin = await listen(server);
  t.after(() => close(server));
  const client = new ApiClient({ origin, token: '0123456789abcdef0123456789abcdef', requestTimeoutMs: 10 });

  const response = await client.request('/api/preview', 'POST', { input: '/source', look: 'standard', recursive: false });
  assert.equal(response.status, 200);
  assert.equal(response.ok, true);
});

test('malformed JSON from a successful HTTP response is a failed proxy result', async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('not json');
  });
  const origin = await listen(server);
  t.after(() => close(server));
  const client = new ApiClient({ origin, token: '0123456789abcdef0123456789abcdef' });

  const response = await client.request('/api/state', 'GET');
  assert.equal(response.status, 502);
  assert.equal(response.ok, false);
  assert.match(response.payload.error, /无效响应/);
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
