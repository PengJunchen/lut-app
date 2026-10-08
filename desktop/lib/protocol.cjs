'use strict';

const READY_PROTOCOL = 1;
const MAX_READY_LINE_BYTES = 16 * 1024;
const { translate } = require('./native-i18n.cjs');

function parseReadyLine(line, language = 'zh-CN') {
  if (typeof line !== 'string' || Buffer.byteLength(line, 'utf8') > MAX_READY_LINE_BYTES) {
    throw new Error(translate('protocol.messageInvalid', language));
  }

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    throw new Error(translate('protocol.jsonInvalid', language));
  }
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.type !== 'ready') {
    throw new Error(translate('protocol.readyMissing', language));
  }
  if (message.protocol !== READY_PROTOCOL) {
    throw new Error(translate('protocol.versionMismatch', language, { version: READY_PROTOCOL }));
  }
  if (typeof message.url !== 'string' || message.url.length > 2048) {
    throw new Error(translate('protocol.addressInvalid', language));
  }

  let readyURL;
  try {
    readyURL = new URL(message.url);
  } catch {
    throw new Error(translate('protocol.addressInvalid', language));
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
    throw new Error(translate('protocol.addressNotLoopback', language));
  }

  const fragment = readyURL.hash.startsWith('#') ? readyURL.hash.slice(1) : '';
  const params = new URLSearchParams(fragment);
  const values = params.getAll('token');
  if (
    params.size !== 1 ||
    values.length !== 1 ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(values[0])
  ) {
    throw new Error(translate('protocol.credentialsInvalid', language));
  }

  return Object.freeze({
    origin: readyURL.origin,
    token: values[0],
    loadURL: readyURL.origin,
  });
}

function sanitizeDiagnostic(input, secret = '', language = 'zh-CN') {
  let value = String(input ?? '');
  const redacted = language === 'zh-CN' ? '[已隐藏]' : '[redacted]';
  if (secret) value = value.split(secret).join(redacted);
  value = value
    .replace(/(#token=)[^\s"'<>]*/gi, `$1${redacted}`)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\-/]+=*/gi, `$1${redacted}`)
    .replace(/((?:access[_-]?token|token)\s*[:=]\s*)[^\s,;"']+/gi, `$1${redacted}`);
  return value.trim();
}

module.exports = { MAX_READY_LINE_BYTES, READY_PROTOCOL, parseReadyLine, sanitizeDiagnostic };
