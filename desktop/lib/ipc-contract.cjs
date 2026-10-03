'use strict';

const MAX_REQUEST_BYTES = 1 << 20;
const MAX_PATH_LENGTH = 32 * 1024;

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
  '/api/shutdown': Object.freeze({ method: 'POST', action: 'shutdown', body: 'empty' }),
});

const ROUTES = Object.freeze({ ...API_ROUTES, ...NATIVE_ROUTES });

function parseInvocation(route, options) {
  if (typeof route !== 'string' || route.length > 64 || !Object.hasOwn(ROUTES, route)) {
    throw new Error('不支持此桌面操作');
  }

  const spec = ROUTES[route];
  if (options === undefined || options === null) options = {};
  if (!isPlainObject(options)) throw new Error('桌面请求选项无效');
  for (const key of Object.keys(options)) {
    if (key !== 'method' && key !== 'body') throw new Error('桌面请求包含不支持的选项');
  }

  const method = options.method === undefined ? spec.method : options.method;
  if (method !== spec.method) throw new Error('桌面请求方法与接口不匹配');

  let body = {};
  if (spec.method === 'GET') {
    if (options.body !== undefined) throw new Error('读取请求不能包含请求内容');
  } else if (options.body !== undefined) {
    if (typeof options.body !== 'string') throw new Error('桌面请求内容必须是 JSON 文本');
    if (Buffer.byteLength(options.body, 'utf8') > MAX_REQUEST_BYTES) throw new Error('桌面请求内容过大');
    try {
      body = JSON.parse(options.body);
    } catch {
      throw new Error('桌面请求内容不是有效 JSON');
    }
  }
  if (!isPlainObject(body)) throw new Error('桌面请求内容必须是 JSON 对象');
  validateBody(route, spec.body, body);

  return Object.freeze({
    route,
    method: spec.method,
    kind: Object.hasOwn(API_ROUTES, route) ? 'api' : 'native',
    action: spec.action,
    body,
  });
}

function validateBody(route, bodyKind, body) {
  if (bodyKind === 'empty') {
    if (Object.keys(body).length !== 0) throw new Error('此桌面操作不接受请求内容');
    return;
  }
  if (bodyKind === 'folder') {
    rejectUnknownKeys(body, new Set(['target', 'path']));
    if (body.target !== 'input' && body.target !== 'output') throw new Error('文件夹选择目标无效');
    validateOptionalString(body.path, '文件夹路径', MAX_PATH_LENGTH);
    return;
  }
  if (bodyKind === 'options') {
    rejectUnknownKeys(body, new Set(['input', 'output', 'look', 'recursive']));
    validateOptionalString(body.input, '原片目录', MAX_PATH_LENGTH);
    validateOptionalString(body.output, '结果目录', MAX_PATH_LENGTH);
    if (body.look !== undefined && body.look !== 'standard' && body.look !== 'vivid') {
      throw new Error('LUT 风格无效');
    }
    if (body.recursive !== undefined && typeof body.recursive !== 'boolean') {
      throw new Error('扫描选项无效');
    }
    return;
  }
  throw new Error(`桌面接口配置错误：${route}`);
}

function validateOptionalString(value, label, maxLength) {
  if (value !== undefined && (typeof value !== 'string' || value.length > maxLength)) {
    throw new Error(`${label}无效`);
  }
}

function rejectUnknownKeys(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error('桌面请求包含不支持的字段');
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
