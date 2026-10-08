'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { execFile } = require('node:child_process');
const { parseReadyLine, sanitizeDiagnostic } = require('./protocol.cjs');
const { translate } = require('./native-i18n.cjs');

const DEFAULT_READY_TIMEOUT_MS = 20_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8_000;
const DEFAULT_FORCE_WAIT_MS = 1_500;
const MAX_DIAGNOSTIC_BYTES = 12 * 1024;

class EngineSupervisor extends EventEmitter {
  constructor({
    binaryPath,
    inputPath,
    getLanguage = () => 'zh-CN',
    platform = process.platform,
    spawnProcess = spawn,
    terminateTree = terminateProcessTree,
    cleanupGroup = cleanupExitedProcessGroup,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    forceWaitMs = DEFAULT_FORCE_WAIT_MS,
  }) {
    super();
    if (typeof binaryPath !== 'string' || !binaryPath) throw new Error(translate('engine.pathInvalid', getLanguage()));
    if (typeof inputPath !== 'string' || !inputPath) throw new Error(translate('engine.inputInvalid', getLanguage()));
    this.binaryPath = binaryPath;
    this.inputPath = inputPath;
    this.getLanguage = getLanguage;
    this.platform = platform;
    this.spawnProcess = spawnProcess;
    this.terminateTree = terminateTree;
    this.cleanupGroup = cleanupGroup;
    this.readyTimeoutMs = readyTimeoutMs;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.forceWaitMs = forceWaitMs;
    this.child = null;
    this.endpoint = null;
    this.state = 'idle';
    this.closing = false;
    this.closed = false;
    this.processExited = false;
    this.unexpectedExitEmitted = false;
    this.exitCode = null;
    this.exitSignal = null;
    this.diagnostic = '';
    this.shutdownPromise = null;
    this.closedPromise = null;
    this.resolveClosed = null;
    this.groupCleanupPromise = null;
  }

  async start() {
    if (this.state !== 'idle') throw new Error(translate('engine.alreadyStarted', this.getLanguage()));
    this.state = 'starting';
    this.closedPromise = new Promise((resolve) => { this.resolveClosed = resolve; });

    let child;
    try {
      child = this.spawnProcess(this.binaryPath, ['--desktop', '--input', this.inputPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: this.platform !== 'win32',
      });
    } catch (error) {
      this.state = 'failed';
      throw new Error(translate('engine.startFailed', this.getLanguage(), { detail: safeMessage(error, this.getLanguage()) }));
    }
    this.child = child;
    if (child.stdin && typeof child.stdin.on === 'function') {
      // stdin may close between checking the pipe and sending EOF during app quit.
      child.stdin.on('error', () => undefined);
    }

    let stdoutLines;
    let readySettled = false;
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const rejectStartup = (error) => {
      if (readySettled) return;
      readySettled = true;
      rejectReady(error);
    };
    const acceptReady = (endpoint) => {
      if (readySettled) return;
      readySettled = true;
      this.endpoint = endpoint;
      resolveReady(endpoint);
    };

    if (!child.stdout || !child.stderr || !child.stdin) {
      rejectStartup(new Error(translate('engine.pipesFailed', this.getLanguage())));
    } else {
      stdoutLines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      stdoutLines.on('line', (line) => {
        if (!line.trim()) return;
        try {
          acceptReady(parseReadyLine(line, this.getLanguage()));
        } catch (error) {
          rejectStartup(error);
        }
      });
      child.stderr.on('data', (chunk) => this._appendDiagnostic(chunk));
    }

    child.once('error', (error) => rejectStartup(new Error(translate('engine.startFailed', this.getLanguage(), { detail: safeMessage(error, this.getLanguage()) }))));
    child.once('exit', (code, signal) => {
      this.processExited = true;
      this.exitCode = code;
      this.exitSignal = signal;
      if (!readySettled) rejectStartup(this._startupError(translate('engine.exitedBeforeReady', this.getLanguage())));
      if (this.platform !== 'win32') {
        this.groupCleanupPromise = Promise.resolve(this.cleanupGroup(child, this.forceWaitMs)).catch(() => undefined);
      }
      if (!this.closing) {
        this.state = 'exited';
        this._emitUnexpectedExit(code, signal);
      }
    });
    child.once('close', (code, signal) => {
      this.closed = true;
      if (this.exitCode === null || this.exitCode === undefined) this.exitCode = code;
      if (!this.exitSignal) this.exitSignal = signal;
      this.state = this.closing ? 'stopped' : 'exited';
      if (this.resolveClosed) this.resolveClosed({ code, signal });
      if (!readySettled) rejectStartup(this._startupError(translate('engine.exitedBeforeReady', this.getLanguage())));
      else if (!this.closing) this._emitUnexpectedExit(code, signal);
      if (stdoutLines) stdoutLines.close();
    });

    const timeout = setTimeout(() => rejectStartup(new Error(translate('engine.readyTimeout', this.getLanguage()))), this.readyTimeoutMs);
    try {
      const endpoint = await ready;
      clearTimeout(timeout);
      if (this.closed || child.exitCode !== null || child.signalCode) {
        throw this._startupError(translate('engine.exitedAfterReady', this.getLanguage()));
      }
      this.state = 'running';
      return endpoint;
    } catch (error) {
      clearTimeout(timeout);
      this.closing = true;
      await this._stopChild({ graceful: false });
      this.state = 'failed';
      throw this._startupError(error.message || translate('engine.startupFailed', this.getLanguage()));
    }
  }

  async shutdown(apiClient) {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    this.shutdownPromise = this._shutdown(apiClient);
    return this.shutdownPromise;
  }

  async _shutdown(apiClient) {
    this.state = 'closing';
    const child = this.child;
    if (!child) {
      this.state = 'stopped';
      return;
    }
    if (this.closed) {
      if (this.groupCleanupPromise) await this.groupCleanupPromise;
      this.state = 'stopped';
      return;
    }

    let shutdownRequest;
    if (this.endpoint && apiClient && typeof apiClient.postShutdown === 'function') {
      try {
        shutdownRequest = Promise.resolve(apiClient.postShutdown()).catch(() => undefined);
      } catch {
        shutdownRequest = Promise.resolve();
      }
    }
    try { child.stdin.end(); } catch { /* The child may already have closed its pipe. */ }

    const exited = await waitForClose(this, this.shutdownTimeoutMs);
    if (!exited) await this._stopChild({ graceful: true });
    if (this.groupCleanupPromise) await this.groupCleanupPromise;
    if (shutdownRequest) await Promise.race([shutdownRequest, delay(1_000)]);
    this.state = 'stopped';
  }

  get isRunning() {
    return this.state === 'running' && !this.closed;
  }

  _appendDiagnostic(chunk) {
    const incoming = sanitizeDiagnostic(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk), this.endpoint?.token, this.getLanguage());
    const combined = `${this.diagnostic}${incoming}`;
    const bytes = Buffer.from(combined, 'utf8');
    this.diagnostic = bytes.length > MAX_DIAGNOSTIC_BYTES
      ? bytes.subarray(bytes.length - MAX_DIAGNOSTIC_BYTES).toString('utf8')
      : combined;
  }

  _startupError(message) {
    const suffix = this.diagnostic ? `\n${this.diagnostic}` : '';
    return new Error(`${sanitizeDiagnostic(message, this.endpoint?.token, this.getLanguage())}${suffix}`);
  }

  _emitUnexpectedExit(code, signal) {
    if (this.unexpectedExitEmitted) return;
    this.unexpectedExitEmitted = true;
    this.emit('unexpected-exit', { code, signal, diagnostic: this.diagnostic });
  }

  async _stopChild({ graceful }) {
    const child = this.child;
    if (!child || this.closed) return;
    try { child.stdin?.end(); } catch { /* Ignore a closed input pipe. */ }
    await this.terminateTree(child, {
      platform: this.platform,
      graceful,
      forceWaitMs: this.forceWaitMs,
      allowExited: this.processExited || child.exitCode !== null || Boolean(child.signalCode),
    });
    if (!this.closed) await waitForClose(this, this.forceWaitMs);
  }
}

function waitForClose(supervisor, timeoutMs) {
  if (supervisor.closed || !supervisor.child) return Promise.resolve(true);
  return Promise.race([
    supervisor.closedPromise.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeMessage(error, language = 'zh-CN') {
  return sanitizeDiagnostic(error && error.message ? error.message : translate('common.unknown', language), '', language);
}

async function terminateProcessTree(child, {
  platform = process.platform,
  graceful = true,
  forceWaitMs = DEFAULT_FORCE_WAIT_MS,
  allowExited = false,
} = {}) {
  if (!child || (!allowExited && (child.exitCode !== null || child.signalCode))) return;
  if (platform === 'win32') {
    await taskkill(child.pid, false);
    if (graceful) await delay(forceWaitMs);
    if (allowExited || (child.exitCode === null && !child.signalCode)) await taskkill(child.pid, true);
  } else {
    signalGroup(child, 'SIGTERM');
    if (graceful) await delay(forceWaitMs);
    if (allowExited || (child.exitCode === null && !child.signalCode)) signalGroup(child, 'SIGKILL');
  }
}

async function cleanupExitedProcessGroup(child, forceWaitMs = DEFAULT_FORCE_WAIT_MS) {
  if (!child || !child.pid) return;
  if (!processGroupExists(child.pid)) return;
  signalGroup(child, 'SIGTERM');
  await delay(forceWaitMs);
  if (processGroupExists(child.pid)) signalGroup(child, 'SIGKILL');
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function signalGroup(child, signal) {
  if (!child || !child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* The child may have exited between checks. */ }
  }
}

function taskkill(pid, force) {
  if (!pid) return Promise.resolve();
  const args = ['/PID', String(pid), '/T'];
  if (force) args.push('/F');
  return new Promise((resolve) => {
    execFile('taskkill.exe', args, { windowsHide: true }, () => resolve());
  });
}

module.exports = {
  DEFAULT_FORCE_WAIT_MS,
  DEFAULT_READY_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  EngineSupervisor,
  cleanupExitedProcessGroup,
  terminateProcessTree,
  waitForClose,
};
