'use strict';

const MAX_REQUEST_BYTES = 1 << 20;
const MAX_PATH_LENGTH = 32 * 1024;
const { isSupportedLanguage, translate } = require('./native-i18n.cjs');

const API_ROUTES = Object.freeze({
  '/api/bootstrap': Object.freeze({ method: 'GET', path: '/api/bootstrap', body: 'empty' }),
  '/api/state': Object.freeze({ method: 'GET', path: '/api/state', body: 'empty' }),
  '/api/preview': Object.freeze({ method: 'POST', path: '/api/preview', body: 'options' }),
  '/api/run': Object.freeze({ method: 'POST', path: '/api/run', body: 'options' }),
  '/api/cancel': Object.freeze({ method: 'POST', path: '/api/cancel', body: 'empty' }),
});

const NATIVE_ROUTES = Object.freeze({
  '/api/select-folder': Object.freeze({ method: 'POST', action: 'select-folder', body: 'folder' }),
  '/api/open-output': Object.freeze({ method: 'POST', action: 'open-output', body: 'empty' }),
  '/api/export-report': Object.freeze({ method: 'POST', action: 'export-report', body: 'empty' }),
  '/api/desktop-preferences': Object.freeze({ method: 'GET', action: 'get-desktop-preferences', body: 'empty' }),
  '/api/desktop-language': Object.freeze({ method: 'POST', action: 'set-desktop-language', body: 'language' }),
  '/api/shutdown': Object.freeze({ method: 'POST', action: 'shutdown', body: 'empty' }),
});

const ROUTES = Object.freeze({ ...API_ROUTES, ...NATIVE_ROUTES });

function parseInvocation(route, options, language = 'zh-CN') {
  if (typeof route !== 'string' || route.length > 64 || !Object.hasOwn(ROUTES, route)) {
    throw new Error(translate('ipc.unsupportedOperation', language));
  }

  const spec = ROUTES[route];
  if (options === undefined || options === null) options = {};
  if (!isPlainObject(options)) throw new Error(translate('ipc.optionsInvalid', language));
  for (const key of Object.keys(options)) {
    if (key !== 'method' && key !== 'body') throw new Error(translate('ipc.optionUnsupported', language));
  }

  const method = options.method === undefined ? spec.method : options.method;
  if (method !== spec.method) throw new Error(translate('ipc.methodMismatch', language));

  let body = {};
  if (spec.method === 'GET') {
    if (options.body !== undefined) throw new Error(translate('ipc.getHasBody', language));
  } else if (options.body !== undefined) {
    if (typeof options.body !== 'string') throw new Error(translate('ipc.bodyText', language));
    if (Buffer.byteLength(options.body, 'utf8') > MAX_REQUEST_BYTES) throw new Error(translate('ipc.bodyTooLarge', language));
    try {
      body = JSON.parse(options.body);
    } catch {
      throw new Error(translate('ipc.bodyJsonInvalid', language));
    }
  }
  if (!isPlainObject(body)) throw new Error(translate('ipc.bodyObject', language));
  validateBody(route, spec.body, body, language);

  return Object.freeze({
    route,
    method: spec.method,
    kind: Object.hasOwn(API_ROUTES, route) ? 'api' : 'native',
    action: spec.action,
    body,
  });
}

function validateBody(route, bodyKind, body, language) {
  if (bodyKind === 'empty') {
    if (Object.keys(body).length !== 0) throw new Error(translate('ipc.bodyNotAccepted', language));
    return;
  }
  if (bodyKind === 'folder') {
    rejectUnknownKeys(body, new Set(['target', 'path']), language);
    if (body.target !== 'input' && body.target !== 'output') throw new Error(translate('ipc.folderTargetInvalid', language));
    validateOptionalString(body.path, 'ipc.folderPathInvalid', MAX_PATH_LENGTH, language);
    return;
  }
  if (bodyKind === 'options') {
    rejectUnknownKeys(body, new Set(['input', 'output', 'look', 'recursive']), language);
    validateOptionalString(body.input, 'ipc.sourceFolderInvalid', MAX_PATH_LENGTH, language);
    validateOptionalString(body.output, 'ipc.outputFolderInvalid', MAX_PATH_LENGTH, language);
    if (body.look !== undefined && body.look !== 'standard' && body.look !== 'vivid') {
      throw new Error(translate('ipc.lookInvalid', language));
    }
    if (body.recursive !== undefined && typeof body.recursive !== 'boolean') {
      throw new Error(translate('ipc.scanInvalid', language));
    }
    return;
  }
  if (bodyKind === 'language') {
    rejectUnknownKeys(body, new Set(['language']), language);
    if (!isSupportedLanguage(body.language)) throw new Error(translate('ipc.languageInvalid', language));
    return;
  }
  throw new Error(translate('ipc.interfaceMisconfigured', language, { route }));
}

function validateOptionalString(value, labelKey, maxLength, language) {
  if (value !== undefined && (typeof value !== 'string' || value.length > maxLength)) {
    throw new Error(translate(labelKey, language));
  }
}

function rejectUnknownKeys(value, allowed, language = 'zh-CN') {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(translate('ipc.bodyUnsupportedField', language));
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateInvocationSource(event, mainWindow, origin) {
  if (!event || !mainWindow || !mainWindow.webContents || event.sender !== mainWindow.webContents) return false;
  const frame = event.senderFrame;
  if (!frame) return false;
  let mainFrame;
  try {
    mainFrame = mainWindow.webContents.mainFrame;
  } catch {
    return false;
  }
  if (!mainFrame || frame !== mainFrame) return false;
  try {
    const frameURL = new URL(frame.url);
    return frameURL.origin === origin && frameURL.pathname === '/' && frameURL.search === '' && frameURL.hash === '';
  } catch {
    return false;
  }
}

function result(status, payload = {}) {
  return { status, ok: status >= 200 && status < 300, payload };
}

module.exports = {
  API_ROUTES,
  MAX_PATH_LENGTH,
  MAX_REQUEST_BYTES,
  NATIVE_ROUTES,
  ROUTES,
  isPlainObject,
  parseInvocation,
  result,
  validateInvocationSource,
};
