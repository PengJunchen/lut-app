'use strict';

const { result } = require('./ipc-contract.cjs');

class AppLifecycle {
  constructor({ app, supervisor, apiClient, getWindow, operationDrainTimeoutMs = 1_000, onShutdownError = () => undefined }) {
    this.app = app;
    this.supervisor = supervisor;
    this.apiClient = apiClient;
    this.getWindow = getWindow;
    this.operationDrainTimeoutMs = operationDrainTimeoutMs;
    this.onShutdownError = onShutdownError;
    this.activeOperations = new Set();
    this.quitting = false;
    this.allowWindowClose = false;
    this.allowAppQuit = false;
    this.quitPromise = null;
  }

  track(operation) {
    if (this.quitting) return Promise.resolve(result(503, { error: '应用正在关闭' }));
    const promise = Promise.resolve().then(operation);
    this.activeOperations.add(promise);
    promise.then(
      () => this.activeOperations.delete(promise),
      () => this.activeOperations.delete(promise),
    );
    return promise;
  }

  scheduleQuit() {
    setImmediate(() => { void this.requestQuit(); });
  }

  requestQuit() {
    if (this.quitPromise) return this.quitPromise;
    this.quitting = true;
    this.quitPromise = this._finishQuit();
    return this.quitPromise;
  }

  onBeforeQuit(event) {
    if (this.allowAppQuit) return;
    event.preventDefault();
    void this.requestQuit();
  }

  onWindowClose(event) {
    if (this.allowWindowClose) return;
    event.preventDefault();
    void this.requestQuit();
  }

  async _finishQuit() {
    this.allowWindowClose = true;
    const window = this.getWindow && this.getWindow();
    if (window && !(typeof window.isDestroyed === 'function' && window.isDestroyed())) {
      try {
        if (typeof window.destroy === 'function') window.destroy();
        else window.close();
      } catch { /* Continue shutdown if Electron already destroyed the window. */ }
    }

    try {
      await this.supervisor.shutdown(this.apiClient);
    } catch (error) {
      try { await this.onShutdownError(error); } catch { /* Continue app shutdown even if diagnostics fail. */ }
    }
    await this._drainOperations();
    this.allowAppQuit = true;
    this.app.quit();
  }

  async _drainOperations() {
    if (!this.activeOperations.size) return;
    let timer;
    const allSettled = Promise.allSettled([...this.activeOperations]);
    await Promise.race([
      allSettled,
      new Promise((resolve) => { timer = setTimeout(resolve, this.operationDrainTimeoutMs); }),
    ]);
    clearTimeout(timer);
  }
}

module.exports = { AppLifecycle };
