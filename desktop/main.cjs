'use strict';

const { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { ApiClient } = require('./lib/api-client.cjs');
const { AppLifecycle } = require('./lib/app-lifecycle.cjs');
const { EngineSupervisor } = require('./lib/engine-supervisor.cjs');
const { defaultInputDirectory, engineBinaryPath } = require('./lib/engine-paths.cjs');
const { createNativeActions } = require('./lib/native-actions.cjs');
const { createRequestDispatcher } = require('./lib/request-dispatcher.cjs');
const { sanitizeDiagnostic } = require('./lib/protocol.cjs');

const IPC_CHANNEL = 'dji-desktop:request';
const WINDOW_TITLE = 'DJI 视频色彩还原';
const gotSingleInstanceLock = app.requestSingleInstanceLock();

let mainWindow = null;
let supervisor = null;
let apiClient = null;
let lifecycle = null;
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
    '桌面应用启动失败',
    'DJI 视频色彩还原无法启动。请重新打开应用；如果问题持续，请重新安装桌面版。',
    error,
  ));

  app.on('activate', () => {
    if (!mainWindow && lifecycle && !lifecycle.quitting) {
      void showFatalAndQuit('桌面窗口已关闭', '请重新启动 DJI 视频色彩还原。');
    }
  });
}

async function startDesktop() {
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
  });

  supervisor = new EngineSupervisor({ binaryPath, inputPath });
  lifecycle = new AppLifecycle({
    app,
    supervisor,
    getWindow: () => mainWindow,
    onShutdownError: (error) => console.error('Go 引擎关闭错误：', sanitizeDiagnostic(error.message, supervisor && supervisor.endpoint && supervisor.endpoint.token)),
  });
  process.once('SIGTERM', () => { void lifecycle.requestQuit(); });
  process.once('SIGINT', () => { void lifecycle.requestQuit(); });

  try {
    await verifyEngineFile(binaryPath);
    const ready = await supervisor.start();
    serviceOrigin = ready.origin;
    apiClient = new ApiClient({ origin: ready.origin, token: ready.token });
    lifecycle.apiClient = apiClient;
  } catch (error) {
    await showFatalAndQuit(
      'Go 引擎启动失败',
      `无法启动随应用提供的 Go 引擎。\n\n引擎位置：${binaryPath}\n\n请重新安装桌面版，并确认发行包包含此平台的引擎。`,
      error,
    );
    return;
  }

  supervisor.on('unexpected-exit', ({ code, signal, diagnostic }) => {
    const status = signal ? `终止信号：${signal}` : `退出代码：${code ?? '未知'}`;
    const details = [status, diagnostic].filter(Boolean).join('\n');
    void showFatalAndQuit(
      '本机处理服务意外退出',
      '视频处理服务已停止。请重新打开应用；如果问题持续，请重新安装桌面版。',
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
    await showFatalAndQuit('界面加载失败', '无法打开桌面应用界面。请重新打开应用。', error);
  }
}

async function verifyEngineFile(binaryPath) {
  let stat;
  try {
    stat = await fs.promises.stat(binaryPath);
  } catch (error) {
    const detail = error && error.code === 'ENOENT' ? '引擎文件不存在' : '无法读取引擎文件';
    throw new Error(`${detail}：${error && error.message ? error.message : binaryPath}`);
  }
  if (!stat.isFile()) throw new Error('Go 引擎路径不是文件');
  if (process.platform !== 'win32' && (stat.mode & 0o111) === 0) throw new Error('Go 引擎没有可执行权限');
}

function installRequestHandler() {
  const nativeActions = createNativeActions({
    dialog,
    shell,
    apiClient,
    getWindow: () => mainWindow,
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
  });
  ipcMain.handle(IPC_CHANNEL, dispatcher);
}

function createMainWindow() {
  const available = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1120, available.width);
  const height = Math.min(820, available.height);
  mainWindow = new BrowserWindow({
    title: WINDOW_TITLE,
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
      '桌面界面异常退出',
      '应用界面已停止。请重新打开应用。',
      `渲染进程状态：${details && details.reason ? details.reason : '未知'}`,
    );
  });
  contents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || lifecycle.quitting) return;
    void showFatalAndQuit('界面加载失败', '无法连接桌面应用内的本机服务。请重新打开应用。', errorDescription);
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
      '关于 DJI 视频色彩还原',
      WINDOW_TITLE,
      '根据视频元数据选择匹配的 LUT，在本机生成独立结果。原片保持不变。',
      'info',
    );
  };
  const template = [];
  if (process.platform === 'darwin') {
    template.push({
      label: WINDOW_TITLE,
      submenu: [
        { label: '关于 DJI 视频色彩还原', click: about },
        { type: 'separator' },
        { label: '退出', accelerator: 'Cmd+Q', click: () => { void lifecycle.requestQuit(); } },
      ],
    });
  }
  template.push(
    {
      label: '文件',
      submenu: process.platform === 'darwin'
        ? [{ label: '关闭窗口', accelerator: 'Cmd+W', role: 'close' }]
        : [{ label: '退出', accelerator: 'Ctrl+Q', click: () => { void lifecycle.requestQuit(); } }],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', role: 'minimize' },
        { label: '关闭窗口', role: 'close' },
      ],
    },
    {
      label: '帮助',
      submenu: [{ label: '关于 DJI 视频色彩还原', click: about }],
    },
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function showFatalAndQuit(title, message, detail) {
  if (fatalDialogOpen) return;
  fatalDialogOpen = true;
  const engineShutdown = supervisor
    ? supervisor.shutdown(apiClient).catch((error) => {
      console.error('Go 引擎关闭错误：', sanitizeDiagnostic(error.message, supervisor && supervisor.endpoint && supervisor.endpoint.token));
    })
    : Promise.resolve();
  const diagnostic = detail instanceof Error ? detail.message : String(detail || '');
  const safeDetail = sanitizeDiagnostic(diagnostic, supervisor && supervisor.endpoint && supervisor.endpoint.token).slice(-1800);
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
  const diagnostic = reason instanceof Error ? reason.message : String(reason ?? '未知错误');
  const safeDiagnostic = sanitizeDiagnostic(diagnostic, supervisor && supervisor.endpoint && supervisor.endpoint.token);
  processFailurePromise = (async () => {
    console.error('桌面主进程异常：', safeDiagnostic.slice(-1800));
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
  const options = { type, title, message, detail: sanitizeDiagnostic(detail).slice(-1800), buttons: ['好'] };
  if (mainWindow && !mainWindow.isDestroyed()) return dialog.showMessageBox(mainWindow, options);
  return dialog.showMessageBox(options);
}
