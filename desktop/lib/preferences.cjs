'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isSupportedLanguage, normalizeSystemLocale } = require('./native-i18n.cjs');

function createPreferenceStore({
  filePath,
  getSystemLocale = () => '',
  fsPromises = fs.promises,
  pathModule = path,
  randomId = () => crypto.randomUUID(),
  processId = process.pid,
}) {
  let language = 'en';
  let writeQueue = Promise.resolve();

  async function load() {
    let fallback = 'en';
    try { fallback = normalizeSystemLocale(getSystemLocale()); } catch { fallback = 'en'; }
    language = fallback;
    if (typeof filePath !== 'string' || !filePath) return language;

    try {
      const content = await fsPromises.readFile(filePath, 'utf8');
      const preferences = JSON.parse(content);
      if (
        preferences &&
        typeof preferences === 'object' &&
        !Array.isArray(preferences) &&
        Object.keys(preferences).length === 1 &&
        Object.hasOwn(preferences, 'language') &&
        isSupportedLanguage(preferences.language)
      ) {
        language = preferences.language;
      }
    } catch {
      // Missing, malformed, or unreadable preferences fall back to the OS locale.
    }
    return language;
  }

  async function setLanguage(nextLanguage) {
    if (!isSupportedLanguage(nextLanguage)) throw new TypeError('Unsupported language preference');
    if (typeof filePath !== 'string' || !filePath) throw new Error('Preference file is unavailable');

    const update = writeQueue.then(async () => {
      const parentDirectory = pathModule.dirname(filePath);
      const temporaryPath = pathModule.join(parentDirectory, `.preferences-${processId}-${randomId()}.tmp`);
      const serialized = `${JSON.stringify({ language: nextLanguage }, null, 2)}\n`;
      try {
        await fsPromises.writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await fsPromises.rename(temporaryPath, filePath);
      } catch (error) {
        try { await fsPromises.unlink(temporaryPath); } catch { /* Best-effort cleanup. */ }
        throw error;
      }
      language = nextLanguage;
      return language;
    });
    writeQueue = update.then(() => undefined, () => undefined);
    return update;
  }

  return Object.freeze({ getLanguage: () => language, load, setLanguage });
}

module.exports = { createPreferenceStore };
