'use strict';

const { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { ApiClient } = require('./lib/api-client.cjs');
const { AppLifecycle } = require('./lib/app-lifecycle.cjs');
const { EngineSupervisor } = require('./lib/engine-supervisor.cjs');
const { defaultInputDirectory, engineBinaryPath } = require('./lib/engine-paths.cjs');
const { createNativeActions } = require('./lib/native-actions.cjs');
const { createPreferenceStore } = require('./lib/preferences.cjs');
const { createRequestDispatcher } = require('./lib/request-dispatcher.cjs');
const { buildApplicationMenu, normalizeSystemLocale, translate } = require('./lib/native-i18n.cjs');
const { sanitizeDiagnostic } = require('./lib/protocol.cjs');

const IPC_CHANNEL = 'dji-desktop:request';
const gotSingleInstanceLock = app.requestSingleInstanceLock();

let mainWindow = null;
let supervisor = null;
let apiClient = null;
let lifecycle = null;
let preferences = null;
let serviceOrigin = '';
let fatalDialogOpen = false;
let processFailurePromise = null;

process.on('uncaughtException', (error) => { void handleProcessFailure(error); });
process.on('unhandledRejection', (reason) => { void handleProcessFailure(reason); });

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('before-quit', (event) => {
    if (lifecycle) lifecycle.onBeforeQuit(event);
  });

  app.whenReady().then(startDesktop).catch((error) => showFatalAndQuit(
    text('fatal.startupTitle'),
    text('fatal.startupMessage'),
    error,
  ));

  app.on('activate', () => {
    if (!mainWindow && lifecycle && !lifecycle.quitting) {
      void showFatalAndQuit(text('fatal.windowClosedTitle'), text('fatal.windowClosedMessage'));
    }
  });
}

async function startDesktop() {
  let preferencePath = '';
  try { preferencePath = path.join(app.getPath('userData'), 'preferences.json'); } catch { /* Use the OS locale if the profile path is unavailable. */ }
  preferences = createPreferenceStore({ filePath: preferencePath, getSystemLocale: () => app.getLocale() });
  await preferences.load();

  const inputPath = defaultInputDirectory({
    isPackaged: app.isPackaged,
    platform: process.platform,
    execPath: process.execPath,
    cwd: process.cwd(),
  });
  const binaryPath = engineBinaryPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    platform: process.platform,
    arch: process.arch,
    language: getLanguage(),
  });

  supervisor = new EngineSupervisor({ binaryPath, inputPath, getLanguage });
  lifecycle = new AppLifecycle({
    app,
    supervisor,
    getWindow: () => mainWindow,
    getLanguage,
    onShutdownError: (error) => console.error(
      text('engine.shutdownError'),
      sanitizeDiagnostic(error.message, supervisor && supervisor.endpoint && supervisor.endpoint.token, getLanguage()),
    ),
  });
  process.once('SIGTERM', () => { void lifecycle.requestQuit(); });
  process.once('SIGINT', () => { void lifecycle.requestQuit(); });

  try {
    await verifyEngineFile(binaryPath, getLanguage);
    const ready = await supervisor.start();
    serviceOrigin = ready.origin;
    apiClient = new ApiClient({ origin: ready.origin, token: ready.token });
    lifecycle.apiClient = apiClient;
  } catch (error) {
    await showFatalAndQuit(
      text('fatal.engineTitle'),
      text('fatal.engineMessage', { path: binaryPath }),
      error,
    );
    return;
  }

  supervisor.on('unexpected-exit', ({ code, signal, diagnostic }) => {
    const status = signal
      ? text('fatal.exitSignal', { signal })
      : text('fatal.exitCode', { code: code ?? text('common.unknown') });
    const details = [status, diagnostic].filter(Boolean).join('\n');
    void showFatalAndQuit(
      text('fatal.unexpectedExitTitle'),
      text('fatal.unexpectedExitMessage'),
      details,
    );
  });

  installRequestHandler();
  installApplicationMenu();
  createMainWindow();
  try {
    await mainWindow.loadURL(serviceOrigin);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  } catch (error) {
    await showFatalAndQuit(text('fatal.loadTitle'), text('fatal.loadMessage'), error);
  }
}

async function verifyEngineFile(binaryPath, getLocale = () => 'zh-CN') {
  let stat;
  try {
    stat = await fs.promises.stat(binaryPath);
  } catch (error) {
    const detail = error && error.code === 'ENOENT'
      ? translate('engine.fileMissing', getLocale())
      : translate('engine.fileUnreadable', getLocale());
    const diagnostic = sanitizeDiagnostic(error && error.message ? error.message : binaryPath, '', getLocale());
    throw new Error(getLocale() === 'zh-CN' ? `${detail}：${diagnostic}` : `${detail}: ${diagnostic}`);
  }
  if (!stat.isFile()) throw new Error(translate('engine.pathNotFile', getLocale()));
  if (process.platform !== 'win32' && (stat.mode & 0o111) === 0) throw new Error(translate('engine.notExecutable', getLocale()));
}

function installRequestHandler() {
  const nativeActions = createNativeActions({
    dialog,
    shell,
    apiClient,
    getWindow: () => mainWindow,
    preferences,
    getLanguage,
    onLanguageChanged: () => refreshNativeLocale(),
    isClosing: () => lifecycle.quitting,
    defaultInput: defaultInputDirectory({
      isPackaged: app.isPackaged,
      platform: process.platform,
      execPath: process.execPath,
      cwd: process.cwd(),
    }),
  });
  const dispatcher = createRequestDispatcher({
    getWindow: () => mainWindow,
    getOrigin: () => serviceOrigin,
    apiClient,
    nativeActions,
    lifecycle,
    getLanguage,
  });
  ipcMain.handle(IPC_CHANNEL, dispatcher);
}

function createMainWindow() {
  const available = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1120, available.width);
  const height = Math.min(820, available.height);
  mainWindow = new BrowserWindow({
    title: text('app.title'),
    width,
    height,
    minWidth: Math.min(960, width),
    minHeight: Math.min(680, height),
    show: false,
    backgroundColor: '#f4f7fb',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.on('close', (event) => lifecycle.onWindowClose(event));
  mainWindow.on('closed', () => { mainWindow = null; });

  const contents = mainWindow.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if (!isAllowedOrigin(url)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!isAllowedOrigin(url)) event.preventDefault();
  });
  contents.on('will-frame-navigate', (event, url) => {
    if (!isAllowedOrigin(url)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('render-process-gone', (_event, details) => {
    if (lifecycle.quitting) return;
    void showFatalAndQuit(
      text('fatal.renderTitle'),
      text('fatal.renderMessage'),
      text('fatal.rendererStatus', { status: details && details.reason ? details.reason : text('common.unknown') }),
    );
  });
  contents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || lifecycle.quitting) return;
    void showFatalAndQuit(text('fatal.loadTitle'), text('fatal.connectMessage'), errorDescription);
  });

  const permissions = contents.session;
  permissions.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  if (typeof permissions.setPermissionCheckHandler === 'function') {
    permissions.setPermissionCheckHandler(() => false);
  }
}

function isAllowedOrigin(candidate) {
  try {
    return new URL(candidate).origin === serviceOrigin;
  } catch {
    return false;
  }
}

function installApplicationMenu() {
  const about = () => {
    void showMessageBox(
      text('about.title'),
      text('app.title'),
      text('about.message'),
      'info',
    );
  };
  const template = buildApplicationMenu({
    platform: process.platform,
    getLanguage,
    onAbout: about,
    onQuit: () => { void lifecycle.requestQuit(); },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function refreshNativeLocale() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(text('app.title'));
  installApplicationMenu();
}

async function showFatalAndQuit(title, message, detail) {
  if (fatalDialogOpen) return;
  fatalDialogOpen = true;
  const engineShutdown = supervisor
    ? supervisor.shutdown(apiClient).catch((error) => {
      console.error(text('engine.shutdownError'), sanitizeDiagnostic(error.message, supervisor && supervisor.endpoint && supervisor.endpoint.token, getLanguage()));
    })
    : Promise.resolve();
  const diagnostic = detail instanceof Error ? detail.message : String(detail || '');
  const safeDetail = sanitizeDiagnostic(diagnostic, supervisor && supervisor.endpoint && supervisor.endpoint.token, getLanguage()).slice(-1800);
  try {
    await showMessageBox(title, message, safeDetail, 'error');
  } catch {
    // Continue shutdown if Electron cannot display a native error dialog.
  }
  await engineShutdown;
  if (lifecycle) await lifecycle.requestQuit();
  else app.exit(1);
}

function handleProcessFailure(reason) {
  if (processFailurePromise) return processFailurePromise;
  const diagnostic = reason instanceof Error ? reason.message : String(reason ?? text('common.unknown'));
  const safeDiagnostic = sanitizeDiagnostic(diagnostic, supervisor && supervisor.endpoint && supervisor.endpoint.token, getLanguage());
  processFailurePromise = (async () => {
    console.error(text('engine.processError'), safeDiagnostic.slice(-1800));
    const cleanup = lifecycle
      ? lifecycle.requestQuit()
      : supervisor ? supervisor.shutdown(apiClient) : Promise.resolve();
    let timer;
    await Promise.race([
      Promise.resolve(cleanup).catch(() => undefined),
      new Promise((resolve) => { timer = setTimeout(resolve, 12_000); }),
    ]);
    clearTimeout(timer);
    app.exit(1);
  })();
  return processFailurePromise;
}

function showMessageBox(title, message, detail = '', type = 'info') {
  const options = { type, title, message, detail: sanitizeDiagnostic(detail, '', getLanguage()).slice(-1800), buttons: [text('dialog.ok')] };
  if (mainWindow && !mainWindow.isDestroyed()) return dialog.showMessageBox(mainWindow, options);
  return dialog.showMessageBox(options);
}

function getLanguage() {
  if (preferences) return preferences.getLanguage();
  try { return normalizeSystemLocale(app.getLocale()); } catch { return 'en'; }
}

function text(key, values) {
  return translate(key, getLanguage(), values);
}
