'use strict';

const READY_PROTOCOL = 1;
const MAX_READY_LINE_BYTES = 16 * 1024;

function parseReadyLine(line) {
  if (typeof line !== 'string' || Buffer.byteLength(line, 'utf8') > MAX_READY_LINE_BYTES) {
    throw new Error('桌面服务启动协议消息无效');
  }

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    throw new Error('桌面服务未返回有效的启动协议消息');
  }
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.type !== 'ready') {
    throw new Error('桌面服务未返回就绪消息');
  }
  if (message.protocol !== READY_PROTOCOL) {
    throw new Error(`桌面服务协议版本不兼容（需要 ${READY_PROTOCOL}）`);
  }
  if (typeof message.url !== 'string' || message.url.length > 2048) {
    throw new Error('桌面服务没有提供有效的本机地址');
  }

  let readyURL;
  try {
    readyURL = new URL(message.url);
  } catch {
    throw new Error('桌面服务没有提供有效的本机地址');
  }
  if (
    readyURL.protocol !== 'http:' ||
    readyURL.hostname !== '127.0.0.1' ||
    !readyURL.port ||
    readyURL.username ||
    readyURL.password ||
    readyURL.pathname !== '/' ||
    readyURL.search !== ''
  ) {
    throw new Error('桌面服务地址必须是本机回环地址');
  }

  const fragment = readyURL.hash.startsWith('#') ? readyURL.hash.slice(1) : '';
  const params = new URLSearchParams(fragment);
  const values = params.getAll('token');
  if (
    params.size !== 1 ||
    values.length !== 1 ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(values[0])
  ) {
    throw new Error('桌面服务没有提供有效的访问凭据');
  }

  return Object.freeze({
    origin: readyURL.origin,
    token: values[0],
    loadURL: readyURL.origin,
  });
}

function sanitizeDiagnostic(input, secret = '') {
  let value = String(input ?? '');
  if (secret) value = value.split(secret).join('[已隐藏]');
  value = value
    .replace(/(#token=)[^\s"'<>]*/gi, '$1[已隐藏]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\-/]+=*/gi, '$1[已隐藏]')
    .replace(/((?:access[_-]?token|token)\s*[:=]\s*)[^\s,;"']+/gi, '$1[已隐藏]');
  return value.trim();
}

module.exports = { MAX_READY_LINE_BYTES, READY_PROTOCOL, parseReadyLine, sanitizeDiagnostic };
