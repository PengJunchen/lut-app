'use strict';

const messages = Object.freeze({
  'app.title': ['DJI 视频色彩还原', 'DJI Video Color Restoration'],
  'about.title': ['关于 DJI 视频色彩还原', 'About DJI Video Color Restoration'],
  'about.message': [
    '根据视频元数据选择匹配的 LUT，在本机生成独立结果。原片保持不变。',
    'Choose a matching LUT from video metadata and create separate results on this computer. Original footage stays unchanged.',
  ],
  'menu.quit': ['退出', 'Quit'],
  'menu.file': ['文件', 'File'],
  'menu.closeWindow': ['关闭窗口', 'Close Window'],
  'menu.edit': ['编辑', 'Edit'],
  'menu.undo': ['撤销', 'Undo'],
  'menu.redo': ['重做', 'Redo'],
  'menu.cut': ['剪切', 'Cut'],
  'menu.copy': ['复制', 'Copy'],
  'menu.paste': ['粘贴', 'Paste'],
  'menu.selectAll': ['全选', 'Select All'],
  'menu.window': ['窗口', 'Window'],
  'menu.minimize': ['最小化', 'Minimize'],
  'menu.help': ['帮助', 'Help'],
  'dialog.ok': ['好', 'OK'],
  'dialog.selectInput': ['选择原片文件夹', 'Choose source folder'],
  'dialog.selectOutput': ['选择结果保存文件夹', 'Choose output folder'],
  'dialog.exportReport': ['导出处理报告', 'Export processing report'],
  'dialog.jsonReport': ['JSON 报告', 'JSON report'],
  'fatal.startupTitle': ['桌面应用启动失败', 'Desktop app failed to start'],
  'fatal.startupMessage': [
    'DJI 视频色彩还原无法启动。请重新打开应用；如果问题持续，请重新安装桌面版。',
    'DJI Video Color Restoration could not start. Reopen the app. If the problem continues, reinstall the desktop app.',
  ],
  'fatal.windowClosedTitle': ['桌面窗口已关闭', 'Desktop window closed'],
  'fatal.windowClosedMessage': ['请重新启动 DJI 视频色彩还原。', 'Restart DJI Video Color Restoration.'],
  'fatal.engineTitle': ['Go 引擎启动失败', 'Go engine failed to start'],
  'fatal.engineMessage': [
    '无法启动随应用提供的 Go 引擎。\n\n引擎位置：{path}\n\n请重新安装桌面版，并确认发行包包含此平台的引擎。',
    'The Go engine included with the app could not start.\n\nEngine location: {path}\n\nReinstall the desktop app and confirm the package includes the engine for this platform.',
  ],
  'fatal.unexpectedExitTitle': ['本机处理服务意外退出', 'Local processing service stopped unexpectedly'],
  'fatal.unexpectedExitMessage': [
    '视频处理服务已停止。请重新打开应用；如果问题持续，请重新安装桌面版。',
    'The video processing service stopped. Reopen the app. If the problem continues, reinstall the desktop app.',
  ],
  'fatal.renderTitle': ['桌面界面异常退出', 'Desktop interface stopped unexpectedly'],
  'fatal.renderMessage': ['应用界面已停止。请重新打开应用。', 'The app interface stopped. Reopen the app.'],
  'fatal.loadTitle': ['界面加载失败', 'Interface failed to load'],
  'fatal.loadMessage': ['无法打开桌面应用界面。请重新打开应用。', 'The desktop app interface could not open. Reopen the app.'],
  'fatal.connectMessage': ['无法连接桌面应用内的本机服务。请重新打开应用。', 'Could not connect to the local service. Reopen the app.'],
  'fatal.rendererStatus': ['渲染进程状态：{status}', 'Renderer process status: {status}'],
  'fatal.exitSignal': ['终止信号：{signal}', 'Terminated by signal: {signal}'],
  'fatal.exitCode': ['退出代码：{code}', 'Exit code: {code}'],
  'common.unknown': ['未知', 'Unknown'],
  'engine.fileMissing': ['引擎文件不存在', 'Engine file is missing'],
  'engine.fileUnreadable': ['无法读取引擎文件', 'Engine file could not be read'],
  'engine.pathNotFile': ['Go 引擎路径不是文件', 'The Go engine path is not a file'],
  'engine.notExecutable': ['Go 引擎没有可执行权限', 'The Go engine is not executable'],
  'engine.shutdownError': ['Go 引擎关闭错误：', 'Go engine shutdown error: '],
  'engine.processError': ['桌面主进程异常：', 'Desktop main process error: '],
  'engine.verifyMissing': ['应用资源目录不可用', 'App resources directory is unavailable'],
  'engine.sourceMissing': ['应用源码目录不可用', 'App source directory is unavailable'],
  'engine.platformMissing': ['此平台没有 Go 引擎：{platform}', 'No Go engine is available for this platform: {platform}'],
  'engine.pathInvalid': ['Go 引擎路径无效', 'Go engine path is invalid'],
  'engine.inputInvalid': ['默认原片目录无效', 'Default source folder is invalid'],
  'engine.alreadyStarted': ['Go 引擎已经启动', 'Go engine has already started'],
  'engine.startFailed': ['无法启动 Go 引擎：{detail}', 'Could not start the Go engine: {detail}'],
  'engine.pipesFailed': ['Go 引擎未能创建标准输入输出管道', 'The Go engine could not create its input and output pipes'],
  'engine.exitedBeforeReady': ['Go 引擎在就绪前退出', 'The Go engine exited before becoming ready'],
  'engine.readyTimeout': ['等待 Go 引擎就绪超时', 'Timed out waiting for the Go engine'],
  'engine.exitedAfterReady': ['Go 引擎在就绪后立即退出', 'The Go engine exited immediately after becoming ready'],
  'engine.startupFailed': ['Go 引擎启动失败', 'Go engine failed to start'],
  'protocol.messageInvalid': ['桌面服务启动协议消息无效', 'Desktop service startup message is invalid'],
  'protocol.jsonInvalid': ['桌面服务未返回有效的启动协议消息', 'Desktop service did not return a valid startup message'],
  'protocol.readyMissing': ['桌面服务未返回就绪消息', 'Desktop service did not return a ready message'],
  'protocol.versionMismatch': ['桌面服务协议版本不兼容（需要 {version}）', 'Desktop service protocol version is incompatible (expected {version})'],
  'protocol.addressInvalid': ['桌面服务没有提供有效的本机地址', 'Desktop service did not provide a valid local address'],
  'protocol.addressNotLoopback': ['桌面服务地址必须是本机回环地址', 'Desktop service address must use the local loopback address'],
  'protocol.credentialsInvalid': ['桌面服务没有提供有效的访问凭据', 'Desktop service did not provide valid access credentials'],
  'lifecycle.quitting': ['应用正在关闭', 'The app is shutting down'],
  'ipc.unsupportedOperation': ['不支持此桌面操作', 'This desktop operation is not supported'],
  'ipc.optionsInvalid': ['桌面请求选项无效', 'Desktop request options are invalid'],
  'ipc.optionUnsupported': ['桌面请求包含不支持的选项', 'Desktop request contains an unsupported option'],
  'ipc.methodMismatch': ['桌面请求方法与接口不匹配', 'Request method does not match the desktop route'],
  'ipc.getHasBody': ['读取请求不能包含请求内容', 'Read requests cannot include a body'],
  'ipc.bodyText': ['桌面请求内容必须是 JSON 文本', 'Desktop request body must be JSON text'],
  'ipc.bodyTooLarge': ['桌面请求内容过大', 'Desktop request body is too large'],
  'ipc.bodyJsonInvalid': ['桌面请求内容不是有效 JSON', 'Desktop request body is not valid JSON'],
  'ipc.bodyObject': ['桌面请求内容必须是 JSON 对象', 'Desktop request body must be a JSON object'],
  'ipc.bodyNotAccepted': ['此桌面操作不接受请求内容', 'This desktop operation does not accept a body'],
  'ipc.bodyUnsupportedField': ['桌面请求包含不支持的字段', 'Desktop request contains an unsupported field'],
  'ipc.interfaceMisconfigured': ['桌面接口配置错误：{route}', 'Desktop route is misconfigured: {route}'],
  'ipc.sourceFolderInvalid': ['原片目录无效', 'Source folder is invalid'],
  'ipc.outputFolderInvalid': ['结果目录无效', 'Output folder is invalid'],
  'ipc.lookInvalid': ['LUT 风格无效', 'LUT style is invalid'],
  'ipc.scanInvalid': ['扫描选项无效', 'Scan option is invalid'],
  'ipc.folderTargetInvalid': ['文件夹选择目标无效', 'Folder selection target is invalid'],
  'ipc.folderPathInvalid': ['文件夹路径无效', 'Folder path is invalid'],
  'ipc.languageInvalid': ['界面语言无效', 'Interface language is invalid'],
  'ipc.untrustedSource': ['拒绝来自非应用主窗口的请求', 'Request rejected because it did not come from the app main window'],
  'ipc.appUnsupported': ['不支持此桌面操作', 'This desktop operation is not supported'],
  'ipc.operationFailed': ['桌面操作失败', 'Desktop operation failed'],
  'preferences.saveFailed': ['语言设置暂时无法保存', 'Language preference could not be saved'],
  'native.dialogOpen': ['已有系统选择窗口打开', 'A system dialog is already open'],
  'native.windowUnavailable': ['应用窗口暂不可用', 'The app window is not available'],
  'native.startFolderMissing': ['无法找到可打开的起始文件夹', 'Could not find a starting folder to open'],
  'native.openPickerFailed': ['打开文件夹选择器失败', 'Could not open the folder picker'],
  'native.folderNotDirectory': ['所选路径不是文件夹', 'The selected path is not a folder'],
  'native.selectedFolderUnavailable': ['所选文件夹不可用', 'The selected folder is unavailable'],
  'native.outputNotReady': ['处理尚未结束，结果文件夹还不可用', 'Processing has not finished, so the output folder is not available yet'],
  'native.outputInvalid': ['没有有效的结果文件夹', 'There is no valid output folder'],
  'native.outputNotDirectory': ['结果路径不是文件夹', 'The output path is not a folder'],
  'native.outputUnavailable': ['结果文件夹不可用', 'The output folder is unavailable'],
  'native.openOutputFailed': ['打开结果文件夹失败', 'Could not open the output folder'],
  'native.noReportYet': ['处理尚未结束，暂时没有可导出的报告', 'Processing has not finished, so there is no report to export yet'],
  'native.noReport': ['本批次没有可导出的处理报告', 'This batch has no processing report to export'],
  'native.reportJsonFailed': ['处理报告无法转换为 JSON', 'The processing report could not be converted to JSON'],
  'native.reportTooLarge': ['处理报告过大，无法导出', 'The processing report is too large to export'],
  'native.openSaveFailed': ['打开报告保存窗口失败', 'Could not open the report save dialog'],
  'native.reportExtension': ['处理报告只能保存为 .json 文件', 'Processing reports can only be saved as .json files'],
  'native.reportLocationUnavailable': ['报告保存位置不可用', 'The report save location is unavailable'],
  'native.reportWriteFailed': ['写入处理报告失败', 'Could not write the processing report'],
});

function isSupportedLanguage(language) {
  return language === 'zh-CN' || language === 'en';
}

function normalizeSystemLocale(locale) {
  return typeof locale === 'string' && /^zh(?:-|$)/i.test(locale.trim()) ? 'zh-CN' : 'en';
}

function translate(key, language = 'zh-CN', values = {}) {
  const choices = messages[key];
  if (!choices) return key;
  const template = choices[isSupportedLanguage(language) && language === 'zh-CN' ? 0 : 1];
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_match, name) => String(values[name] ?? ''));
}

function buildApplicationMenu({ platform, getLanguage = () => 'zh-CN', onAbout = () => undefined, onQuit = () => undefined }) {
  const language = getLanguage();
  const label = (key) => translate(key, language);
  const template = [];
  if (platform === 'darwin') {
    template.push({
      label: label('app.title'),
      submenu: [
        { label: label('about.title'), click: onAbout },
        { type: 'separator' },
        { label: label('menu.quit'), accelerator: 'Cmd+Q', click: onQuit },
      ],
    });
  }
  template.push(
    {
      label: label('menu.file'),
      submenu: platform === 'darwin'
        ? [{ label: label('menu.closeWindow'), accelerator: 'Cmd+W', role: 'close' }]
        : [{ label: label('menu.quit'), accelerator: 'Ctrl+Q', click: onQuit }],
    },
    {
      label: label('menu.edit'),
      submenu: [
        { label: label('menu.undo'), role: 'undo' },
        { label: label('menu.redo'), role: 'redo' },
        { type: 'separator' },
        { label: label('menu.cut'), role: 'cut' },
        { label: label('menu.copy'), role: 'copy' },
        { label: label('menu.paste'), role: 'paste' },
        { label: label('menu.selectAll'), role: 'selectAll' },
      ],
    },
    {
      label: label('menu.window'),
      submenu: [
        { label: label('menu.minimize'), role: 'minimize' },
        { label: label('menu.closeWindow'), role: 'close' },
      ],
    },
    { label: label('menu.help'), submenu: [{ label: label('about.title'), click: onAbout }] },
  );
  return template;
}

module.exports = { buildApplicationMenu, isSupportedLanguage, normalizeSystemLocale, translate };
