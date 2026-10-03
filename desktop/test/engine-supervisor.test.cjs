'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const test = require('node:test');
const { EngineSupervisor } = require('../lib/engine-supervisor.cjs');

test('supervisor starts the hidden Go binary with only desktop flags and stops after shutdown plus stdin EOF', async () => {
  const child = fakeChild();
  const calls = [];
  const supervisor = new EngineSupervisor({
    binaryPath: '/app/resources/engine/engine',
    inputPath: '/media',
    platform: 'darwin',
    readyTimeoutMs: 200,
    shutdownTimeoutMs: 200,
    spawnProcess(binary, args, options) {
      calls.push({ binary, args, options });
      return child;
    },
  });

  const starting = supervisor.start();
  child.stdout.write(`${JSON.stringify({ type: 'ready', protocol: 1, url: 'http://127.0.0.1:43219/#token=0123456789abcdef0123456789abcdef' })}\n`);
  const endpoint = await starting;
  assert.equal(endpoint.origin, 'http://127.0.0.1:43219');
  assert.equal(calls[0].binary, '/app/resources/engine/engine');
  assert.deepEqual(calls[0].args, ['--desktop', '--input', '/media']);
  assert.deepEqual(calls[0].options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.detached, true);

  const order = [];
  await supervisor.shutdown({ postShutdown() { order.push('http-shutdown'); return Promise.resolve(); } });
  assert.deepEqual(order, ['http-shutdown']);
  assert.equal(supervisor.state, 'stopped');
  assert.equal(supervisor.closed, true);
});

test('startup timeout kills the process tree and returns useful diagnostics', async () => {
  const child = fakeChild({ closeOnInput: false });
  let terminated = 0;
  const supervisor = new EngineSupervisor({
    binaryPath: '/engine',
    inputPath: '/media',
    readyTimeoutMs: 10,
    forceWaitMs: 10,
    spawnProcess: () => child,
    terminateTree: async (process) => {
      terminated++;
      process.close(1, 'SIGKILL');
    },
  });

  await assert.rejects(supervisor.start(), /等待 Go 引擎就绪超时/);
  assert.equal(terminated, 1);
  assert.equal(supervisor.closed, true);
});

test('startup protocol failure never prints its token and still terminates the child', async () => {
  const child = fakeChild({ closeOnInput: false });
  const supervisor = new EngineSupervisor({
    binaryPath: '/engine',
    inputPath: '/media',
    readyTimeoutMs: 100,
    forceWaitMs: 10,
    spawnProcess: () => child,
    terminateTree: async (process) => process.close(1, 'SIGKILL'),
  });

  const starting = supervisor.start();
  child.stdout.write(`${JSON.stringify({ type: 'ready', protocol: 1, url: 'http://example.com/#token=0123456789abcdef0123456789abcdef' })}\n`);
  await assert.rejects(starting, (error) => {
    assert.match(error.message, /本机回环地址/);
    assert.equal(error.message.includes('0123456789abcdef'), false);
    return true;
  });
  assert.equal(supervisor.closed, true);
});

test('unexpected Go exit cleans up its owned Unix process group', async () => {
  const child = fakeChild({ closeOnInput: false });
  const cleanup = [];
  const supervisor = new EngineSupervisor({
    binaryPath: '/engine',
    inputPath: '/media',
    platform: 'darwin',
    readyTimeoutMs: 100,
    spawnProcess: () => child,
    cleanupGroup: async (process, waitMs) => cleanup.push({ pid: process.pid, waitMs }),
  });
  const unexpected = new Promise((resolve) => supervisor.once('unexpected-exit', resolve));
  const starting = supervisor.start();
  child.stdout.write(`${JSON.stringify({ type: 'ready', protocol: 1, url: 'http://127.0.0.1:43219/#token=0123456789abcdef0123456789abcdef' })}\n`);
  await starting;

  child.close(7, null);
  const exit = await unexpected;
  assert.equal(exit.code, 7);
  assert.deepEqual(cleanup, [{ pid: 2468, waitMs: 1_500 }]);
});

function fakeChild({ closeOnInput = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 2468;
  child.close = (code = 0, signal = null) => {
    if (child.exitCode !== null || child.signalCode) return;
    child.exitCode = code;
    child.signalCode = signal;
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', code, signal);
    child.emit('close', code, signal);
  };
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) { callback(); },
    final(callback) {
      callback();
      if (closeOnInput) process.nextTick(() => child.close(0));
    },
  });
  child.kill = (signal) => {
    child.close(1, signal);
    return true;
  };
  return child;
}
