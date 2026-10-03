'use strict';

const path = require('node:path');

function engineBinaryPath({ isPackaged, resourcesPath, appPath, platform = process.platform, arch = process.arch, pathModule = path }) {
  const target = targetLabel(platform, arch);
  const executable = platform === 'win32' ? 'engine.exe' : 'engine';
  if (isPackaged) {
    if (typeof resourcesPath !== 'string' || !resourcesPath) throw new Error('应用资源目录不可用');
    return pathModule.join(resourcesPath, 'engine', executable);
  }
  if (typeof appPath !== 'string' || !appPath) throw new Error('应用源码目录不可用');
  return pathModule.join(appPath, 'desktop', '.generated', target, executable);
}

function targetLabel(platform, arch) {
  const os = platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'windows' : '';
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'amd64' : '';
  if (!os || !cpu || (platform === 'win32' && arch !== 'x64')) {
    throw new Error(`此平台没有 Go 引擎：${platform}/${arch}`);
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
