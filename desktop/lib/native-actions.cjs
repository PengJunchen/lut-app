'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isPlainObject, result } = require('./ipc-contract.cjs');
const { isSupportedLanguage, translate } = require('./native-i18n.cjs');
const { sanitizeDiagnostic } = require('./protocol.cjs');

const MAX_REPORT_BYTES = 32 * 1024 * 1024;

function createNativeActions({
  dialog,
  shell,
  apiClient,
  getWindow,
  preferences = null,
  getLanguage = () => preferences && typeof preferences.getLanguage === 'function' ? preferences.getLanguage() : 'zh-CN',
  onLanguageChanged = () => undefined,
  isClosing = () => false,
  defaultInput = process.cwd(),
  fsPromises = fs.promises,
  pathModule = path,
}) {
  let dialogOpen = false;
  const text = (key, values = {}) => translate(key, getLanguage(), values);

  async function withDialog(operation) {
    if (isClosing()) return result(503, { error: text('lifecycle.quitting') });
    if (dialogOpen) return result(409, { error: text('native.dialogOpen') });
    const parent = getWindow && getWindow();
    if (!parent || (typeof parent.isDestroyed === 'function' && parent.isDestroyed())) {
      return result(503, { error: text('native.windowUnavailable') });
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
        return result(400, { error: text('native.startFolderMissing') });
      }

      let selection;
      try {
        selection = await dialog.showOpenDialog(parent, {
          title: text(target === 'input' ? 'dialog.selectInput' : 'dialog.selectOutput'),
          defaultPath,
          properties: ['openDirectory'],
        });
      } catch (error) {
        return result(500, { error: safeFileError(error, 'native.openPickerFailed', getLanguage()) });
      }
      if (isClosing()) return result(200, { path: originalPath, cancelled: true });
      if (!selection || selection.canceled || !Array.isArray(selection.filePaths) || !selection.filePaths[0]) {
        return result(200, { path: originalPath, cancelled: true });
      }

      try {
        const selectedPath = pathModule.resolve(selection.filePaths[0]);
        const stat = await fsPromises.stat(selectedPath);
        if (!stat.isDirectory()) return result(400, { error: text('native.folderNotDirectory') });
        return result(200, { path: selectedPath, cancelled: false });
      } catch (error) {
        return result(400, { error: safeFileError(error, 'native.selectedFolderUnavailable', getLanguage()) });
      }
    });
  }

  async function openOutput() {
    const stateResult = await apiClient.getState();
    if (!stateResult.ok) return stateResult;
    const state = stateResult.payload;
    if (!isPlainObject(state) || !state.finished) {
      return result(409, { error: text('native.outputNotReady') });
    }
    const outputPath = state.output_root;
    if (typeof outputPath !== 'string' || !outputPath || !pathModule.isAbsolute(outputPath)) {
      return result(409, { error: text('native.outputInvalid') });
    }

    let directory;
    try {
      directory = await fsPromises.realpath(pathModule.resolve(outputPath));
      const stat = await fsPromises.stat(directory);
      if (!stat.isDirectory()) return result(400, { error: text('native.outputNotDirectory') });
    } catch (error) {
      return result(400, { error: safeFileError(error, 'native.outputUnavailable', getLanguage()) });
    }

    if (isClosing()) return result(200, { ok: true });
    try {
      const openError = await shell.openPath(directory);
      if (isClosing()) return result(200, { ok: true });
      if (openError) return result(500, { error: safeFileError(new Error(openError), 'native.openOutputFailed', getLanguage()) });
      return result(200, { ok: true });
    } catch (error) {
      return result(500, { error: safeFileError(error, 'native.openOutputFailed', getLanguage()) });
    }
  }

  async function exportReport() {
    const stateResult = await apiClient.getState();
    if (!stateResult.ok) return stateResult;
    if (isClosing()) return result(200, { cancelled: true });
    const state = stateResult.payload;
    if (!isPlainObject(state) || !state.finished || state.running) {
      return result(409, { error: text('native.noReportYet') });
    }
    if (!isPlainObject(state.report)) return result(409, { error: text('native.noReport') });

    let reportJSON;
    try {
      reportJSON = `${JSON.stringify(state.report, null, 2)}\n`;
    } catch {
      return result(500, { error: text('native.reportJsonFailed') });
    }
    if (Buffer.byteLength(reportJSON, 'utf8') > MAX_REPORT_BYTES) {
      return result(413, { error: text('native.reportTooLarge') });
    }

    const outputPath = typeof state.output_root === 'string' && pathModule.isAbsolute(state.output_root)
      ? pathModule.resolve(state.output_root)
      : '';
    const defaultPath = outputPath ? pathModule.join(outputPath, 'dji-lut-report.json') : 'dji-lut-report.json';

    return withDialog(async (parent) => {
      let choice;
      try {
        choice = await dialog.showSaveDialog(parent, {
          title: text('dialog.exportReport'),
          defaultPath,
          filters: [{ name: text('dialog.jsonReport'), extensions: ['json'] }],
        });
      } catch (error) {
        return result(500, { error: safeFileError(error, 'native.openSaveFailed', getLanguage()) });
      }
      if (isClosing()) return result(200, { cancelled: true });
      if (!choice || choice.canceled || !choice.filePath) return result(200, { cancelled: true });

      let savePath = pathModule.resolve(choice.filePath);
      if (!pathModule.extname(savePath)) savePath += '.json';
      if (pathModule.extname(savePath).toLowerCase() !== '.json') {
        return result(400, { error: text('native.reportExtension') });
      }
      try {
        const parentStat = await fsPromises.stat(pathModule.dirname(savePath));
        if (!parentStat.isDirectory()) return result(400, { error: text('native.reportLocationUnavailable') });
        if (isClosing()) return result(200, { cancelled: true });
        await fsPromises.writeFile(savePath, reportJSON, { encoding: 'utf8', flag: 'w', mode: 0o600 });
        return result(200, { path: savePath, cancelled: false });
      } catch (error) {
        return result(500, { error: safeFileError(error, 'native.reportWriteFailed', getLanguage()) });
      }
    });
  }

  async function getDesktopPreferences() {
    return result(200, { language: preferences && typeof preferences.getLanguage === 'function' ? preferences.getLanguage() : getLanguage() });
  }

  async function setDesktopLanguage({ language } = {}) {
    if (!isSupportedLanguage(language)) {
      return result(400, { error: text('ipc.languageInvalid') });
    }
    if (!preferences || typeof preferences.setLanguage !== 'function') {
      return result(500, { error: text('preferences.saveFailed') });
    }
    try {
      await preferences.setLanguage(language);
    } catch {
      return result(500, { error: text('preferences.saveFailed') });
    }
    try { onLanguageChanged(language); } catch { /* Persisted language remains active for the renderer. */ }
    return result(200, { language });
  }

  return Object.freeze({ selectFolder, openOutput, exportReport, getDesktopPreferences, setDesktopLanguage });
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

function safeFileError(error, fallbackKey, language = 'zh-CN') {
  const message = error && typeof error.message === 'string' ? error.message : '';
  const fallback = translate(fallbackKey, language);
  const safeMessage = sanitizeDiagnostic(message, '', language);
  if (!safeMessage) return fallback;
  return language === 'zh-CN' ? `${fallback}：${safeMessage}` : `${fallback}: ${safeMessage}`;
}

module.exports = { MAX_REPORT_BYTES, createNativeActions, nearestExistingDirectory };
