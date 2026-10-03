'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { defaultInputDirectory, engineBinaryPath } = require('../lib/engine-paths.cjs');

test('packaged Go binaries resolve from resources and development binaries from the repository', () => {
  assert.equal(engineBinaryPath({
    isPackaged: true, resourcesPath: '/Applications/DJI.app/Contents/Resources',
    platform: 'darwin', arch: 'arm64',
  }), '/Applications/DJI.app/Contents/Resources/engine/engine');
  assert.equal(engineBinaryPath({
    isPackaged: false, appPath: '/repo/lut-app',
    platform: 'win32', arch: 'x64',
  }), '/repo/lut-app/desktop/.generated/windows-amd64/engine.exe');
});

test('initial input folder follows packaged app location and development working directory', () => {
  assert.equal(defaultInputDirectory({
    isPackaged: true,
    platform: 'darwin',
    execPath: '/Applications/Tools/DJI.app/Contents/MacOS/DJI',
  }), '/Applications/Tools');
  assert.equal(defaultInputDirectory({ isPackaged: false, cwd: '/repo/lut-app' }), '/repo/lut-app');
  assert.equal(defaultInputDirectory({
    isPackaged: true,
    platform: 'win32',
    execPath: 'C:\\Program Files\\DJI\\DJI.exe',
    pathModule: path.win32,
  }), 'C:\\Program Files\\DJI');
});
