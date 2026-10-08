'use strict';

const { parseInvocation, result, validateInvocationSource } = require('./ipc-contract.cjs');
const { translate } = require('./native-i18n.cjs');
const { sanitizeDiagnostic } = require('./protocol.cjs');

function createRequestDispatcher({ getWindow, getOrigin, apiClient, nativeActions, lifecycle, getLanguage = () => 'zh-CN' }) {
  return async (event, route, options) => {
    let language = 'zh-CN';
    try { language = getLanguage(); } catch { /* Keep the default locale when state cannot be read. */ }
    const window = getWindow && getWindow();
    const origin = getOrigin && getOrigin();
    if (!validateInvocationSource(event, window, origin)) {
      return result(403, { error: translate('ipc.untrustedSource', language) });
    }

    let invocation;
    try {
      invocation = parseInvocation(route, options, language);
    } catch (error) {
      return result(400, { error: error.message });
    }

    if (invocation.action === 'shutdown') {
      lifecycle.scheduleQuit();
      return result(202, { ok: true });
    }
    if (lifecycle.quitting) return result(503, { error: translate('lifecycle.quitting', language) });

    try {
      return await lifecycle.track(async () => {
        if (invocation.kind === 'api') {
          return apiClient.request(invocation.route, invocation.method, invocation.body);
        }
        const action = {
          'select-folder': nativeActions.selectFolder,
          'open-output': nativeActions.openOutput,
          'export-report': nativeActions.exportReport,
          'get-desktop-preferences': nativeActions.getDesktopPreferences,
          'set-desktop-language': nativeActions.setDesktopLanguage,
        }[invocation.action];
        if (typeof action !== 'function') return result(400, { error: translate('ipc.appUnsupported', language) });
        if (invocation.action === 'select-folder' || invocation.action === 'set-desktop-language') return action(invocation.body);
        return action();
      });
    } catch (error) {
      return result(500, { error: safeErrorMessage(error, language) });
    }
  };
}

function safeErrorMessage(error, language = 'zh-CN') {
  const message = error && typeof error.message === 'string' ? error.message : '';
  return sanitizeDiagnostic(message, '', language) || translate('ipc.operationFailed', language);
}

module.exports = { createRequestDispatcher };
