'use strict';

const http = require('node:http');
const { API_ROUTES, isPlainObject, parseInvocation, result } = require('./ipc-contract.cjs');

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

class ApiClient {
  constructor({ origin, token, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, httpModule = http }) {
    let parsedOrigin;
    try {
      parsedOrigin = new URL(origin);
    } catch {
      throw new Error('本机服务地址无效');
    }
    if (
      parsedOrigin.protocol !== 'http:' ||
      parsedOrigin.hostname !== '127.0.0.1' ||
      !parsedOrigin.port ||
      parsedOrigin.username ||
      parsedOrigin.password ||
      parsedOrigin.pathname !== '/' ||
      parsedOrigin.search ||
      parsedOrigin.hash
    ) {
      throw new Error('本机服务地址无效');
    }
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
      throw new Error('本机服务访问凭据无效');
    }

    this.origin = parsedOrigin.origin;
    this.port = Number(parsedOrigin.port);
    this.token = token;
    this.requestTimeoutMs = requestTimeoutMs;
    this.httpModule = httpModule;
  }

  request(route, method, body = {}) {
    const spec = API_ROUTES[route];
    if (!spec || method !== spec.method) return Promise.resolve(result(400, { error: '不支持此本机接口' }));

    let serialized = '';
    if (method === 'POST') {
      if (!isPlainObject(body)) return Promise.resolve(result(400, { error: '本机请求内容无效' }));
      try {
        const parsed = parseInvocation(route, { method, body: JSON.stringify(body) });
        serialized = JSON.stringify(parsed.body);
      } catch (error) {
        return Promise.resolve(result(400, { error: error.message }));
      }
    }

    return this._send({
      method,
      path: spec.path,
      body: serialized,
      // Scanning video metadata can take much longer than a regular request.
      // App shutdown cancels Go's context and closes this request cleanly.
      timeoutMs: route === '/api/preview' ? 0 : this.requestTimeoutMs,
    });
  }

  getState() {
    return this.request('/api/state', 'GET');
  }

  postShutdown() {
    return this._send({
      method: 'POST',
      path: '/api/shutdown',
      body: '',
      timeoutMs: Math.min(this.requestTimeoutMs, 5_000),
      internalShutdown: true,
    });
  }

  _send({ method, path, body, timeoutMs, internalShutdown = false }) {
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.token}`,
      Origin: this.origin,
      Connection: 'close',
    };
    if (method === 'POST' && body !== '') {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body, 'utf8');
    } else if (internalShutdown) {
      headers['Content-Length'] = '0';
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      let request;
      try {
        request = this.httpModule.request({
          hostname: '127.0.0.1',
          port: this.port,
          method,
          path,
          headers,
          agent: false,
        }, (response) => {
          const chunks = [];
          let length = 0;
          response.on('data', (chunk) => {
            length += chunk.length;
            if (length > MAX_RESPONSE_BYTES) {
              response.destroy();
              finish(result(502, { error: '本机服务响应内容过大' }));
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
          response.on('end', () => {
            const status = Number(response.statusCode) || 502;
            const text = Buffer.concat(chunks).toString('utf8');
            let payload = {};
            try {
              payload = text ? JSON.parse(text) : {};
            } catch {
              finish(result(502, { error: '本机服务返回了无效响应' }));
              return;
            }
            finish(result(status, payload));
          });
          response.on('error', () => finish(result(502, { error: '读取本机服务响应失败' })));
        });
      } catch {
        finish(result(0, { error: '无法连接本机服务' }));
        return;
      }

      if (timeoutMs > 0) request.setTimeout(timeoutMs, () => request.destroy(new Error('timeout')));
      request.on('error', () => finish(result(0, { error: '无法连接本机服务' })));
      request.end(body || undefined);
    });
  }
}

module.exports = { ApiClient, DEFAULT_REQUEST_TIMEOUT_MS, MAX_RESPONSE_BYTES };
