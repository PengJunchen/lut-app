'use strict';

const { parseInvocation, result, validateInvocationSource } = require('./ipc-contract.cjs');

function createRequestDispatcher({ getWindow, getOrigin, apiClient, nativeActions, lifecycle }) {
  return async (event, route, options) => {
    const window = getWindow && getWindow();
    const origin = getOrigin && getOrigin();
    if (!validateInvocationSource(event, window, origin)) {
      return result(403, { error: '拒绝来自非应用主窗口的请求' });
    }

    let invocation;
    try {
      invocation = parseInvocation(route, options);
    } catch (error) {
      return result(400, { error: error.message });
    }

    if (invocation.action === 'shutdown') {
      lifecycle.scheduleQuit();
      return result(202, { ok: true });
    }
    if (lifecycle.quitting) return result(503, { error: '应用正在关闭' });

    try {
      return await lifecycle.track(async () => {
        if (invocation.kind === 'api') {
          return apiClient.request(invocation.route, invocation.method, invocation.body);
        }
        const action = {
          'select-folder': nativeActions.selectFolder,
          'open-output': nativeActions.openOutput,
          'export-report': nativeActions.exportReport,
        }[invocation.action];
        if (typeof action !== 'function') return result(400, { error: '不支持此桌面操作' });
        if (invocation.action === 'select-folder') return action(invocation.body);
        return action();
      });
    } catch (error) {
      return result(500, { error: safeErrorMessage(error) });
    }
  };
}

function safeErrorMessage(error) {
  const message = error && typeof error.message === 'string' ? error.message : '';
  return message || '桌面操作失败';
}

module.exports = { createRequestDispatcher };
