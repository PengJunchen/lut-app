'use strict';

const path = require('node:path');
const { translate } = require('./native-i18n.cjs');

function engineBinaryPath({ isPackaged, resourcesPath, appPath, platform = process.platform, arch = process.arch, pathModule = path, language = 'zh-CN' }) {
  const target = targetLabel(platform, arch, language);
  const executable = platform === 'win32' ? 'engine.exe' : 'engine';
  if (isPackaged) {
    if (typeof resourcesPath !== 'string' || !resourcesPath) throw new Error(translate('engine.verifyMissing', language));
    return pathModule.join(resourcesPath, 'engine', executable);
  }
  if (typeof appPath !== 'string' || !appPath) throw new Error(translate('engine.sourceMissing', language));
  return pathModule.join(appPath, 'desktop', '.generated', target, executable);
}

function targetLabel(platform, arch, language = 'zh-CN') {
  const os = platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'windows' : '';
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'amd64' : '';
  if (!os || !cpu || (platform === 'win32' && arch !== 'x64')) {
    throw new Error(translate('engine.platformMissing', language, { platform: `${platform}/${arch}` }));
  }
  return `${os}-${cpu}`;
}

function defaultInputDirectory({ isPackaged, platform = process.platform, execPath = process.execPath, cwd = process.cwd(), pathModule = path }) {
  if (!isPackaged) return pathModule.resolve(cwd);
  const executable = pathModule.resolve(execPath);
  if (platform !== 'darwin') return pathModule.dirname(executable);

  let current = pathModule.dirname(executable);
  while (true) {
    if (pathModule.extname(current).toLowerCase() === '.app') return pathModule.dirname(current);
    const parent = pathModule.dirname(current);
    if (parent === current) return pathModule.dirname(executable);
    current = parent;
  }
}

module.exports = { defaultInputDirectory, engineBinaryPath, targetLabel };
