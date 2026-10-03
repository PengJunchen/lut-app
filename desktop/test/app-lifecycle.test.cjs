'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { AppLifecycle } = require('../lib/app-lifecycle.cjs');

test('quit destroys the dialog parent, shuts down Go, and bounds unresolved IPC cleanup', async () => {
  let finishPicker;
  const order = [];
  const app = { quit() { order.push('app-quit'); } };
  const window = { isDestroyed: () => false, destroy() { order.push('window-destroy'); } };
  const supervisor = { async shutdown() { order.push('go-shutdown'); } };
  const lifecycle = new AppLifecycle({ app, supervisor, getWindow: () => window, operationDrainTimeoutMs: 15 });
  const picker = lifecycle.track(() => new Promise((resolve) => { finishPicker = resolve; }));

  const quitting = lifecycle.requestQuit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['window-destroy', 'go-shutdown']);

  await quitting;
  assert.deepEqual(order, ['window-destroy', 'go-shutdown', 'app-quit']);
  finishPicker();
  await picker;
});

test('quit cancels long Go requests before waiting for their IPC promises', async () => {
  let finishRequest;
  const order = [];
  const lifecycle = new AppLifecycle({
    app: { quit() { order.push('app-quit'); } },
    supervisor: { async shutdown() { order.push('go-shutdown'); } },
    getWindow: () => null,
  });
  const request = lifecycle.track(() => new Promise((resolve) => { finishRequest = resolve; }));

  const quitting = lifecycle.requestQuit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['go-shutdown']);
  finishRequest();
  await Promise.all([request, quitting]);
  assert.deepEqual(order, ['go-shutdown', 'app-quit']);
});
