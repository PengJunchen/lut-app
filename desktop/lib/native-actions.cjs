'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isPlainObject, result } = require('./ipc-contract.cjs');

const MAX_REPORT_BYTES = 32 * 1024 * 1024;

function createNativeActions({
  dialog,
  shell,
  apiClient,
  getWindow,
  isClosing = () => false,
  defaultInput = process.cwd(),
  fsPromises = fs.promises,
  pathModule = path,
}) {
  let dialogOpen = false;

  async function withDialog(operation) {
    if (isClosing()) return result(503, { error: '应用正在关闭' });
    if (dialogOpen) return result(409, { error: '已有系统选择窗口打开' });
    const parent = getWindow && getWindow();
    if (!parent || (typeof parent.isDestroyed === 'function' && parent.isDestroyed())) {
      return result(503, { error: '应用窗口暂不可用' });
    }
    dialogOpen = true;
    try {
      return await operation(parent);
    } finally {
      dialogOpen = false;
    }
  }

  async function selectFolder({ target, path: requestedPath }) {
    const originalPath = typeof requestedPath === 'string' ? requestedPath : '';
    return withDialog(async (parent) => {
      let defaultPath;
      try {
        defaultPath = await nearestExistingDirectory(originalPath || defaultInput, { fsPromises, pathModule });
      } catch {
        return result(400, { error: '无法找到可打开的起始文件夹' });
      }

      let selection;
      try {
        selection = await dialog.showOpenDialog(parent, {
          title: target === 'input' ? '选择原片文件夹' : '选择结果保存文件夹',
          defaultPath,
          properties: ['openDirectory'],
        });
      } catch (error) {
        return result(500, { error: safeFileError(error, '打开文件夹选择器失败') });
      }
      if (isClosing()) return result(200, { path: originalPath, cancelled: true });
      if (!selection || selection.canceled || !Array.isArray(selection.filePaths) || !selection.filePaths[0]) {
        return result(200, { path: originalPath, cancelled: true });
      }

      try {
        const selectedPath = pathModule.resolve(selection.filePaths[0]);
        const stat = await fsPromises.stat(selectedPath);
        if (!stat.isDirectory()) return result(400, { error: '所选路径不是文件夹' });
        return result(200, { path: selectedPath, cancelled: false });
      } catch (error) {
        return result(400, { error: safeFileError(error, '所选文件夹不可用') });
      }
    });
  }

  async function openOutput() {
    const stateResult = await apiClient.getState();
    if (!stateResult.ok) return stateResult;
    const state = stateResult.payload;
    if (!isPlainObject(state) || !state.finished) {
      return result(409, { error: '处理尚未结束，结果文件夹还不可用' });
    }
    const outputPath = state.output_root;
    if (typeof outputPath !== 'string' || !outputPath || !pathModule.isAbsolute(outputPath)) {
      return result(409, { error: '没有有效的结果文件夹' });
    }

    let directory;
    try {
      directory = await fsPromises.realpath(pathModule.resolve(outputPath));
      const stat = await fsPromises.stat(directory);
      if (!stat.isDirectory()) return result(400, { error: '结果路径不是文件夹' });
    } catch (error) {
      return result(400, { error: safeFileError(error, '结果文件夹不可用') });
    }

    if (isClosing()) return result(200, { ok: true });
    try {
      const openError = await shell.openPath(directory);
      if (isClosing()) return result(200, { ok: true });
      if (openError) return result(500, { error: `打开结果文件夹失败：${openError}` });
      return result(200, { ok: true });
    } catch (error) {
      return result(500, { error: safeFileError(error, '打开结果文件夹失败') });
    }
  }

  async function exportReport() {
    const stateResult = await apiClient.getState();
    if (!stateResult.ok) return stateResult;
    if (isClosing()) return result(200, { cancelled: true });
    const state = stateResult.payload;
    if (!isPlainObject(state) || !state.finished || state.running) {
      return result(409, { error: '处理尚未结束，暂时没有可导出的报告' });
    }
    if (!isPlainObject(state.report)) return result(409, { error: '本批次没有可导出的处理报告' });

    let reportJSON;
    try {
      reportJSON = `${JSON.stringify(state.report, null, 2)}\n`;
    } catch {
      return result(500, { error: '处理报告无法转换为 JSON' });
    }
    if (Buffer.byteLength(reportJSON, 'utf8') > MAX_REPORT_BYTES) {
      return result(413, { error: '处理报告过大，无法导出' });
    }

    const outputPath = typeof state.output_root === 'string' && pathModule.isAbsolute(state.output_root)
      ? pathModule.resolve(state.output_root)
      : '';
    const defaultPath = outputPath ? pathModule.join(outputPath, 'dji-lut-report.json') : 'dji-lut-report.json';

    return withDialog(async (parent) => {
      let choice;
      try {
        choice = await dialog.showSaveDialog(parent, {
          title: '导出处理报告',
          defaultPath,
          filters: [{ name: 'JSON 报告', extensions: ['json'] }],
        });
      } catch (error) {
        return result(500, { error: safeFileError(error, '打开报告保存窗口失败') });
      }
      if (isClosing()) return result(200, { cancelled: true });
      if (!choice || choice.canceled || !choice.filePath) return result(200, { cancelled: true });

      let savePath = pathModule.resolve(choice.filePath);
      if (!pathModule.extname(savePath)) savePath += '.json';
      if (pathModule.extname(savePath).toLowerCase() !== '.json') {
        return result(400, { error: '处理报告只能保存为 .json 文件' });
      }
      try {
        const parentStat = await fsPromises.stat(pathModule.dirname(savePath));
        if (!parentStat.isDirectory()) return result(400, { error: '报告保存位置不可用' });
        if (isClosing()) return result(200, { cancelled: true });
        await fsPromises.writeFile(savePath, reportJSON, { encoding: 'utf8', flag: 'w', mode: 0o600 });
        return result(200, { path: savePath, cancelled: false });
      } catch (error) {
        return result(500, { error: safeFileError(error, '写入处理报告失败') });
      }
    });
  }

  return Object.freeze({ selectFolder, openOutput, exportReport });
}

async function nearestExistingDirectory(candidate, { fsPromises = fs.promises, pathModule = path } = {}) {
  if (typeof candidate !== 'string' || !candidate.trim()) throw new Error('folder path is empty');
  let current = pathModule.resolve(candidate);
  while (true) {
    try {
      const stat = await fsPromises.stat(current);
      if (stat.isDirectory()) return current;
      current = pathModule.dirname(current);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error && error.code)) throw error;
      const parent = pathModule.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function safeFileError(error, fallback) {
  const message = error && typeof error.message === 'string' ? error.message : '';
  return message ? `${fallback}：${message}` : fallback;
}

module.exports = { MAX_REPORT_BYTES, createNativeActions, nearestExistingDirectory };
