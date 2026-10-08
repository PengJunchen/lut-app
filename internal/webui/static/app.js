(() => {
  'use strict';

  const i18nApi = window.DJILUTI18n;
  let languageStorage;
  try { languageStorage = window.localStorage; }
  catch (_) { /* Browser language selection must work when storage is blocked. */ }
  const initialLanguage = i18nApi.preferredBrowserLanguage(languageStorage, window.navigator);
  const i18n = i18nApi.createI18n(initialLanguage);
  const t = (key, values) => i18n.t(key, values);
  i18n.apply(document);

  const $ = (id) => document.getElementById(id);
  const desktopBridge = window.djiDesktop;
  const isDesktop = Boolean(desktopBridge && typeof desktopBridge.request === 'function');
  const fragmentToken = isDesktop ? '' : new URLSearchParams(location.hash.replace(/^#/, '')).get('token') || '';
  let token = fragmentToken;
  if (!isDesktop) {
    try {
      if (fragmentToken) sessionStorage.setItem('dji-lut-access', fragmentToken);
      else token = sessionStorage.getItem('dji-lut-access') || '';
    } catch (_) { /* Fragment access still works when session storage is unavailable. */ }
  }
  const inputPath = $('input-path');
  const outputPath = $('output-path');
  const previewButton = $('preview-button');
  const runButton = $('run-button');
  const reconnectButton = $('reconnect-button');
  let hasPreview = false;
  let previewSnapshot = '';
  let currentState = null;
  let connected = false;
  let activeOperation = 'bootstrap';
  let processing = false;
  let cancelPending = false;
  let exportPending = false;
  let batchLocked = false;
  let shuttingDown = false;
  let batchVersion = 0;
  let stateRecoveryEnabled = true;
  let pollTimer = null;
  let toastTimer = null;
  let lastMessage = '';
  let lastMessageTranslationKey = '';
  let lastToastMessage = '';
  let libraryAssets = [];
  let libraryCatalog = [];
  let catalogEntries = [];
  let latestBootstrap = null;
  let currentPlan = null;
  let desktopPreferenceReady = !isDesktop;
  let hasCompleteLibrary = false;
  let libraryCameraNames = new Map();
  const ROW_PAGE_SIZE = 5;
  const LIBRARY_PAGE_SIZE = 4;
  const CATALOG_PAGE_SIZE = 12;
  const MODE_PREFERENCE_KEY = 'dji-lut-interface-mode';
  let interfaceMode = (() => {
    try { return window.localStorage.getItem(MODE_PREFERENCE_KEY) === 'classic' ? 'classic' : 'guided'; }
    catch (_) { return 'guided'; }
  })();
  let guidedStep = 'settings';
  let previewPageAvailable = false;
  let progressPageAvailable = false;
  let previewItems = [];
  let progressItems = [];
  let previewPage = 0;
  let progressPage = 0;
  let libraryPage = 0;
  let catalogPage = 0;
  let previewPageCount = 1;
  let progressPageCount = 1;
  let libraryPageCount = 1;
  let catalogPageCount = 1;
  let terminalResultPresented = false;
  let currentDetail = null;
  const dialogOpener = new WeakMap();

  history.replaceState(null, '', location.pathname + location.search);

  $('language-select').value = i18n.language;
  $('language-select').disabled = isDesktop;

  const val = (obj, ...keys) => {
    if (!obj) return undefined;
    for (const key of keys) if (obj[key] !== undefined && obj[key] !== null) return obj[key];
    return undefined;
  };
  const text = (value, fallback = '') => value === undefined || value === null || value === '' ? fallback : String(value);
  const esc = (value) => text(value).replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const baseName = (path) => text(path).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || text(path);
  const selectedLook = () => document.querySelector('input[name="look"]:checked')?.value || 'standard';
  const settings = () => ({input: inputPath.value.trim(), output: outputPath.value.trim(), look: selectedLook(), recursive: $('recursive').checked});
  const api = async (route, options = {}) => {
    if (isDesktop) {
      const languagePreferenceWrite = route === '/api/desktop-language' && (options.method || 'GET') === 'POST';
      let response;
      try {
        response = await desktopBridge.request(route, {
          method: options.method || 'GET',
          ...(options.body === undefined ? {} : {body: options.body})
        });
      } catch (error) {
        const status = Number(error?.status);
        const validStatus = Number.isInteger(status) && status >= 100 && status <= 599;
        const reachable = validStatus && status < 500 && status !== 401 && status !== 403;
        const preserveConnection = languagePreferenceWrite && validStatus && status !== 401 && status !== 403;
        if (!preserveConnection) setConnection(reachable);
        const fallback = preserveConnection || reachable ? t('api.requestFailed', {status}) : t('api.unavailable');
        const failure = new Error(text(error?.message, fallback));
        failure.cause = error;
        if (Number.isFinite(status)) failure.status = status;
        throw failure;
      }
      const status = Number(response?.status);
      const payload = response?.payload ?? {};
      const ok = Boolean(response?.ok);
      const validStatus = Number.isInteger(status) && status >= 100 && status <= 599;
      const preserveConnection = languagePreferenceWrite && validStatus && status !== 401 && status !== 403;
      if (!preserveConnection || status === 401 || status === 403 || !validStatus) {
        setConnection(validStatus && status !== 401 && status !== 403 && status < 500);
      }
      if (!validStatus) throw new Error(t('api.unavailable'));
      if (!ok || status < 200 || status >= 300) {
        const message = text(val(payload, 'error', 'message'), t('api.requestFailed', {status: validStatus ? status : t('api.unknownStatus')}));
        if (status === 401 || status === 403 || (status >= 500 && !preserveConnection)) setConnection(false);
        const failure = new Error(message);
        if (validStatus) failure.status = status;
        throw failure;
      }
      return payload;
    }
    if (!token) throw new Error(t('api.missingCredential'));
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    let response;
    try {
      response = await fetch(route, {...options, headers, cache:'no-store', credentials:'same-origin'});
    } catch (error) {
      setConnection(false);
      const unavailable = new Error(t('api.unavailable'));
      unavailable.cause = error;
      throw unavailable;
    }
    setConnection(response.status !== 401 && response.status !== 403 && response.status < 500);
    const body = await response.text();
    let payload = {};
    try { payload = body ? JSON.parse(body) : {}; } catch (_) { payload = {message: body}; }
    if (!response.ok) {
      const message = text(val(payload, 'error', 'message'), t('api.requestFailed', {status: response.status}));
      if (response.status === 401 || response.status === 403) setConnection(false);
      if (response.status >= 500) setConnection(false);
      const failure = new Error(message);
      failure.status = response.status;
      throw failure;
    }
    return payload;
  };
  const toast = (message) => {
    const node = $('toast');
    lastToastMessage = message;
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
  };
  const showMessage = (message = '') => {
    lastMessage = message;
    lastMessageTranslationKey = message
      ? Object.entries(i18nApi.messages[i18n.language]).find(([, translated]) => translated === message)?.[0] || ''
      : '';
    $('settings-message').textContent = message;
  };
  function localizedError(error) {
    const raw = text(error?.message, t('generic.error'));
    return i18n.translateKnownMessage(raw) || t('api.technicalDetails', {details: raw});
  }
  const nativeLanguageController = isDesktop ? i18nApi.createNativeLanguageController({
    initialLanguage: i18n.language,
    save: (language) => api('/api/desktop-language', {method:'POST', body:JSON.stringify({language})}),
    onLanguage: (language) => {
      if (i18n.language !== language) {
        i18n.setLanguage(language);
        renderLocalizedContent();
      }
    },
    onError: (error) => {
      const known = i18n.translateKnownMessage(error?.message);
      const message = known || t('api.languageSaveFailed', {details: localizedError(error)});
      showMessage(message);
      toast(message);
    }
  }) : null;
  function renderLocalizedContent() {
    const previousView = {
      guidedStep,
      previewPage,
      progressPage,
      libraryPage,
      catalogPage,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      elementScroll: [...document.querySelectorAll('*')].map((element) => [element, element.scrollTop, element.scrollLeft])
    };
    i18n.apply(document);
    setConnection(connected);
    document.title = t('app.title');
    $('language-select').value = i18n.language;
    $('language-select').disabled = isDesktop && !desktopPreferenceReady;
    $('app-mode-hint').textContent = t(isDesktop ? 'app.desktopHint' : 'app.localHint');
    updateGuidedPage();
    updateOutputDestination();
    if (latestBootstrap) renderBootstrapResources(latestBootstrap, true);
    if (currentPlan) renderPlan(currentPlan, true, true);
    if (currentState) renderState(currentState);
    else if (connected) $('footer-status').textContent = t(isDesktop ? 'connection.desktopReady' : 'state.localReady');
    if (currentDetail && $('file-detail-dialog').open) renderItemDetails(currentDetail.item, currentDetail.preview);
    if (lastMessage) {
      const translated = lastMessageTranslationKey ? t(lastMessageTranslationKey) : i18n.translateKnownMessage(lastMessage);
      if (translated) showMessage(translated);
    }
    const toastNode = $('toast');
    if (toastNode.classList.contains('show') && lastToastMessage) {
      const translated = i18n.translateKnownMessage(lastToastMessage);
      if (translated) {
        lastToastMessage = translated;
        toastNode.textContent = translated;
      }
    }
    guidedStep = previousView.guidedStep;
    previewPage = previousView.previewPage;
    progressPage = previousView.progressPage;
    libraryPage = previousView.libraryPage;
    catalogPage = previousView.catalogPage;
    updateGuidedPage();
    for (const [element, top, left] of previousView.elementScroll) {
      if (element.isConnected) {
        element.scrollTop = top;
        element.scrollLeft = left;
      }
    }
    window.scrollTo(previousView.scrollX, previousView.scrollY);
    syncControls();
  }
  async function changeLanguage(value) {
    const next = i18nApi.normalizeLanguage(value);
    if (!next || next === i18n.language) return;
    if (isDesktop) {
      if (desktopPreferenceReady) nativeLanguageController.select(next);
      return;
    }
    i18n.setLanguage(next);
    try { window.localStorage.setItem('dji-lut-language', next); }
    catch (_) { /* Language switching remains available without persistent storage. */ }
    renderLocalizedContent();
  }
  const operationBusy = () => Boolean(activeOperation) || processing || shuttingDown;
  const setConnection = (ready) => {
    connected = ready;
    const node = $('connection');
    node.classList.toggle('disconnected', !ready);
    node.innerHTML = `<i></i> ${ready ? t(isDesktop ? 'connection.desktopReady' : 'connection.localReady') : t(isDesktop ? 'connection.desktopLost' : 'connection.localLost')}`;
    node.setAttribute('aria-label', ready ? t(isDesktop ? 'connection.desktopReady' : 'connection.localReady') : t(isDesktop ? 'connection.desktopLost' : 'connection.localLost'));
    reconnectButton.classList.toggle('hidden', ready || (!isDesktop && !token));
    if (!ready) $('footer-status').textContent = t(isDesktop ? 'connection.desktopLostHint' : 'connection.localLostHint');
    syncControls();
  };
  const syncControls = () => {
    const busy = operationBusy();
    const locked = busy || batchLocked;
    const unavailable = !connected;
    for (const id of ['input-path', 'output-path', 'input-select-button', 'output-select-button', 'output-reset-button', 'recursive']) {
      $(id).disabled = locked || unavailable;
    }
    document.querySelectorAll('input[name="look"]').forEach((node) => node.disabled = locked || unavailable);
    previewButton.disabled = locked || unavailable || !inputPath.value.trim();
    runButton.disabled = locked || unavailable || !hasPreview;
    reconnectButton.disabled = Boolean(activeOperation) || shuttingDown;
    $('cancel-button').disabled = !processing || unavailable || cancelPending || shuttingDown;
    $('open-output-button').disabled = unavailable || shuttingDown;
    $('report-button').disabled = shuttingDown || exportPending || (isDesktop && unavailable);
    $('new-batch-button').disabled = busy;
    $('header-close-button').disabled = shuttingDown || exportPending;
    $('close-button').disabled = shuttingDown || exportPending;
    $('mode-toggle').disabled = shuttingDown;
    $('lut-open-button').disabled = shuttingDown;
    $('guided-back-button').disabled = processing || Boolean(activeOperation) || shuttingDown || (guidedStep === 'result' && !previewPageAvailable);
    $('guided-continue-preview-button').disabled = processing || Boolean(activeOperation) || batchLocked || !hasReusablePreview();
    $('preview-page-prev').disabled = previewPage <= 0;
    $('preview-page-next').disabled = previewPage >= previewPageCount - 1;
    $('progress-page-prev').disabled = progressPage <= 0;
    $('progress-page-next').disabled = progressPage >= progressPageCount - 1;
    $('library-page-prev').disabled = libraryPage <= 0;
    $('library-page-next').disabled = libraryPage >= libraryPageCount - 1;
    $('catalog-page-prev').disabled = catalogPage <= 0;
    $('catalog-page-next').disabled = catalogPage >= catalogPageCount - 1;
  };
  const beginOperation = (name) => {
    activeOperation = name;
    syncControls();
  };
  const endOperation = (name) => {
    if (activeOperation === name) activeOperation = '';
    syncControls();
  };
  const outputBase = () => {
    const selected = outputPath.value.trim();
    if (selected) return selected;
    const input = inputPath.value.trim();
    if (!input) return t('output.inputDefault');
    const separator = /^[A-Za-z]:\\/.test(input) || input.includes('\\') ? '\\' : '/';
    return `${input.replace(/[\\/]+$/, '')}${separator}Output`;
  };
  const finalOutputDestination = (look = selectedLook()) => {
    const base = outputBase();
    const separator = /^[A-Za-z]:\\/.test(base) || base.includes('\\') ? '\\' : '/';
    return `${base.replace(/[\\/]+$/, '')}${separator}${look === 'vivid' ? 'Vivid' : 'Standard'}`;
  };
  const sameDirectory = (left, right) => {
    const normalize = (path) => {
      const value = text(path).trim();
      const clean = value.replace(/[\\/]+$/, '') || (value.startsWith('/') ? '/' : value);
      return /^[A-Za-z]:[\\/]|^\\\\/.test(value) ? clean.toLowerCase() : clean;
    };
    return normalize(left) === normalize(right);
  };
  const updateOutputDestination = () => {
    $('output-destination').textContent = t('output.destination', {path: finalOutputDestination()});
  };
  function pageCount(items, size) {
    return Math.max(1, Math.ceil((items || []).length / size));
  }
  function hasReusablePreview() {
    return Boolean(previewSnapshot) && JSON.stringify(settings()) === previewSnapshot;
  }
  function saveInterfaceMode() {
    try { window.localStorage.setItem(MODE_PREFERENCE_KEY, interfaceMode); }
    catch (_) { /* Interface mode is an optional preference. */ }
  }
  function updateGuidedPage() {
    const guided = interfaceMode === 'guided';
    const nav = $('guided-nav');
    const settingsSection = $('settings-section');
    const previewSection = $('preview-section');
    const progressSection = $('progress-section');
    const primaryActionRow = $('primary-action-row');

    document.body.classList.toggle('guided-mode', guided);
    document.body.dataset.interfaceMode = interfaceMode;
    $('mode-toggle').textContent = t(guided ? 'mode.classic' : 'mode.guided');
    $('mode-toggle').setAttribute('aria-label', t(guided ? 'mode.switchClassic' : 'mode.switchGuided'));
    $('mode-toggle').title = t(guided ? 'mode.switchClassic' : 'mode.switchGuided');
    nav.classList.toggle('hidden', !guided);

    if (!guided) {
      settingsSection.classList.remove('hidden');
      previewSection.classList.toggle('hidden', !previewPageAvailable);
      progressSection.classList.toggle('hidden', !progressPageAvailable);
      $('settings-action-host').appendChild(primaryActionRow);
      $('run-button').classList.remove('guided-hidden');
      return;
    }

    settingsSection.classList.toggle('hidden', guidedStep !== 'settings');
    previewSection.classList.toggle('hidden', guidedStep !== 'preview' || !previewPageAvailable);
    progressSection.classList.toggle('hidden', !['processing', 'result'].includes(guidedStep) || !progressPageAvailable);
    if (guidedStep === 'preview' && previewPageAvailable) $('preview-action-host').appendChild(primaryActionRow);
    else $('settings-action-host').appendChild(primaryActionRow);

    const stepKey = guidedStep === 'settings' ? 'settings' : guidedStep === 'preview' ? 'preview' : 'processing';
    for (const step of document.querySelectorAll('[data-guided-step]')) {
      if (step.dataset.guidedStep === stepKey) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
    }
    const status = {
      settings: t('step.oneSettings'),
      preview: t('step.twoPreview'),
      processing: t('step.threeProcessing'),
      result: t('step.threeResult')
    };
    $('guided-page-status').textContent = status[guidedStep] || status.settings;

    const canReturn = (guidedStep === 'preview' && previewPageAvailable) || (guidedStep === 'result' && progressPageAvailable);
    $('guided-back-button').classList.toggle('hidden', !canReturn);
    $('guided-back-button').textContent = guidedStep === 'result'
      ? t('step.backToPreview')
      : batchLocked ? t('step.backToResults') : t('step.backToSettings');
    const canResumePreview = guidedStep === 'settings' && !batchLocked && hasReusablePreview();
    $('guided-continue-preview-button').classList.toggle('hidden', !canResumePreview);
    $('run-button').classList.toggle('guided-hidden', guidedStep !== 'preview');
  }
  function setGuidedStep(step) {
    if (guidedStep === step) return;
    guidedStep = step;
    updateGuidedPage();
  }
  function openAppDialog(dialog, opener = document.activeElement) {
    if (!dialog) return;
    dialogOpener.set(dialog, opener);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    const closeButton = dialog.querySelector('.dialog-close-button');
    if (closeButton) closeButton.focus();
  }
  function restoreDialogFocus(dialog, fallback) {
    dialog.addEventListener('close', () => {
      const opener = dialogOpener.get(dialog);
      dialogOpener.delete(dialog);
      if (opener && opener.isConnected && !opener.disabled) opener.focus();
      else fallback.focus();
    });
  }
  const invalidatePreview = () => {
    updateOutputDestination();
    if (previewSnapshot && JSON.stringify(settings()) !== previewSnapshot) {
      hasPreview = false;
      previewSnapshot = '';
      currentPlan = null;
      $('preview-stale').classList.remove('hidden');
      showMessage(t('preview.stale'));
      if (guidedStep === 'preview') guidedStep = 'settings';
      updateGuidedPage();
      syncControls();
    }
  };
  inputPath.addEventListener('input', () => { invalidatePreview(); syncControls(); });
  outputPath.addEventListener('input', () => { invalidatePreview(); syncControls(); });
  $('recursive').addEventListener('change', invalidatePreview);
  document.querySelectorAll('input[name="look"]').forEach((node) => node.addEventListener('change', invalidatePreview));
  $('input-select-button').addEventListener('click', () => chooseFolder('input'));
  $('output-select-button').addEventListener('click', () => chooseFolder('output'));
  $('output-reset-button').addEventListener('click', () => {
    outputPath.value = '';
    invalidatePreview();
  });
  reconnectButton.addEventListener('click', reconnect);

  function normalizedKey(value) {
    return text(value).trim().toLowerCase().replace(/[-_ ]/g, '');
  }
  function cameraId(camera) {
    return typeof camera === 'object' && camera !== null ? text(val(camera, 'id', 'ID', 'camera', 'Camera')) : text(camera);
  }
  function indexLibraryCameraNames(library) {
    libraryCameraNames = new Map();
    const assets = val(library, 'assets', 'Assets');
    if (!Array.isArray(assets)) return;
    for (const asset of assets) {
      const cameras = val(asset, 'cameras', 'Cameras');
      if (!Array.isArray(cameras)) continue;
      for (const camera of cameras) {
        const id = cameraId(camera);
        const name = typeof camera === 'object' && camera !== null ? text(val(camera, 'name', 'Name', 'title', 'label')) : '';
        if (id && name) libraryCameraNames.set(normalizedKey(id), name);
      }
    }
  }
  function renderCatalogPage() {
    const node = $('catalog-list');
    catalogPageCount = pageCount(catalogEntries, CATALOG_PAGE_SIZE);
    catalogPage = Math.max(0, Math.min(catalogPage, catalogPageCount - 1));
    $('catalog-count').textContent = catalogEntries.length ? t('lut.catalogCombinations', {count: catalogEntries.length}) : t('lut.unavailable');
    if (!catalogEntries.length) {
      node.textContent = t('lut.catalogEmpty');
      $('catalog-page-status').textContent = '';
      $('catalog-pagination').classList.add('hidden');
    } else {
      const start = catalogPage * CATALOG_PAGE_SIZE;
      const visibleEntries = catalogEntries.slice(start, start + CATALOG_PAGE_SIZE);
      const end = Math.min(catalogEntries.length, start + visibleEntries.length);
      node.innerHTML = visibleEntries.join('');
      $('catalog-page-status').textContent = t('catalog.pageStatus', {page: catalogPage + 1, pages: catalogPageCount, start: start + 1, end});
      $('catalog-pagination').classList.toggle('hidden', catalogEntries.length <= CATALOG_PAGE_SIZE);
    }
    $('catalog-page-prev').disabled = catalogPage <= 0;
    $('catalog-page-next').disabled = catalogPage >= catalogPageCount - 1;
  }
  function listCatalog(catalog, library, preservePage = false) {
    const previousPage = catalogPage;
    const entries = Array.isArray(catalog) ? catalog : [];
    const assets = val(library, 'assets', 'Assets');
    const assetById = new Map((Array.isArray(assets) ? assets : []).map((asset) => [text(val(asset, 'id', 'ID')), asset]).filter(([id]) => id));
    const combos = new Map();
    const entryByKey = new Map();
    const addCombo = (camera, profile) => {
      const cameraKey = text(camera).trim();
      const profileKey = text(profile).trim();
      if (!cameraKey || !profileKey) return;
      combos.set(`${cameraKey}|${profileKey}`, {camera:cameraKey, profile:profileKey});
    };
    const keyFor = (camera, profile, look) => `${text(camera).trim()}|${text(profile).trim()}|${text(look).trim()}`;
    for (const item of entries) {
      const camera = cameraId(val(item, 'camera', 'Camera'));
      const profile = text(val(item, 'profile', 'Profile'));
      const look = text(val(item, 'look', 'Look'));
      addCombo(camera, profile);
      if (camera && profile && look && !entryByKey.has(keyFor(camera, profile, look))) entryByKey.set(keyFor(camera, profile, look), item);
    }
    if (Array.isArray(assets)) {
      for (const asset of assets) {
        if (val(asset, 'automatic', 'Automatic') !== true) continue;
        const profile = text(val(asset, 'profile', 'Profile'));
        const cameras = val(asset, 'cameras', 'Cameras');
        if (!Array.isArray(cameras)) continue;
        for (const camera of cameras) addCombo(cameraId(camera), profile);
      }
    }
    if (combos.size === 0) {
      catalogEntries = [];
      catalogPage = 0;
      renderCatalogPage();
      return;
    }
    const supported = [];
    for (const {camera, profile} of [...combos.values()].sort((a, b) => `${cameraLabel(a.camera)} ${a.profile}`.localeCompare(`${cameraLabel(b.camera)} ${b.profile}`, 'zh-CN'))) {
      const label = `${cameraLabel(camera)} · ${profileLabel(profile)}`;
      for (const look of ['standard', 'vivid']) {
        const item = entryByKey.get(keyFor(camera, profile, look));
        const asset = item ? assetById.get(text(val(item, 'library_id', 'LibraryID'))) : null;
        const version = text(val(item, 'version', 'Version')).trim() || (asset ? assetVersionLabel(asset) : '');
        const file = text(val(item, 'file', 'File', 'lut_file', 'lutFile') || val(asset, 'file', 'File'));
        const title = text(val(item, 'lut_name', 'LUTName', 'title', 'Title') || val(asset, 'title', 'Title'));
        const resourceName = title || (file ? baseName(file) : 'LUT');
        const detail = item
          ? `${esc(resourceName)}${version ? ` · ${esc(version)}` : ''}`
          : t('catalog.unavailableResource');
        const lookName = lookLabel(look);
        supported.push(`<span class="catalog-pill${item ? '' : ' unavailable'}"><b>${esc(label)} · ${esc(lookName)}${item ? esc(t('catalog.availableSuffix')) : ''}</b><small class="catalog-detail">${detail}</small></span>`);
      }
    }
    catalogEntries = supported;
    catalogPage = preservePage ? previousPage : 0;
    renderCatalogPage();
  }

  function profileLabel(profile) {
    const key = text(profile).toLowerCase().replace(/[-_ ]/g, '');
    const labels = {dlog2:'D-Log2', dlogm:'D-Log M', dlog:'D-Log', rec709:'Rec.709', linear:t('look.linear'), other:t('lut.otherProfile')};
    return labels[key] || text(profile, t('lut.unknownProfile'));
  }
  function lookLabel(look) {
    const key = text(look).trim().toLowerCase();
    const labels = {standard:t('look.standardLabel'), vivid:t('look.vividLabel'), gamma18:t('look.gamma18'), gamma22:t('look.gamma22')};
    return labels[key] || text(look, t('lut.otherLook'));
  }
  function cameraLabel(camera) {
    const directName = typeof camera === 'object' && camera !== null ? text(val(camera, 'name', 'Name', 'title', 'label')) : '';
    const id = cameraId(camera);
    const key = normalizedKey(id);
    const labels = {
      pocket4p:'DJI Osmo Pocket 4P', pocket3:'DJI Osmo Pocket 3', action4:'DJI Osmo Action 4',
      action5pro:'DJI Osmo Action 5 Pro', action6:'DJI Osmo Action 6', mavic3:'DJI Mavic 3',
      mavic2pro:'DJI Mavic 2 Pro', air2s:'DJI Air 2S', air3:'DJI Air 3', air3s:'DJI Air 3S'
    };
    return directName || libraryCameraNames.get(key) || labels[key] || id || t('lut.unrecognized');
  }
  function outputColorLabel(value) {
    const labels = {rec709:'Rec.709', 'rec2020-hlg':'Rec.2020 HLG', srgb:'sRGB', dlog:'D-Log'};
    return labels[text(value).toLowerCase()] || t('lut.unknownColor');
  }
  function purposeLabel(value) {
    const labels = {restore:t('lut.restore'), creative:t('lut.creative'), gamma_conversion:t('lut.gammaConversion'), monitoring:t('lut.monitoring')};
    return labels[text(value).toLowerCase()] || t('lut.unknownPurpose');
  }
  function provenanceLabel(value) {
    const raw = typeof value === 'object' && value !== null ? text(val(value, 'label', 'name', 'source', 'kind')) : text(value);
    const key = raw.toLowerCase().replace(/[-_ ]/g, '');
    if (key === 'supplied' || key === 'usersupplied' || key === 'provided') return t('lut.suppliedSource');
    if (key === 'official' || key === 'djiofficial' || key === 'djidownloadcenter') return t('lut.officialSource');
    return raw;
  }
  function formatLabel(value) {
    const format = text(value).trim();
    return format ? format.toUpperCase() : t('lut.unknownFormat');
  }
  function gridLabel(value) {
    if (value === undefined || value === null || value === '') return '';
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? `${numeric}³` : text(value);
  }
  function assetVersionLabel(asset) {
    const version = text(val(asset, 'version', 'Version')).trim();
    return version || t('lut.officialNoVersion');
  }
  function lutGridLabel(asset) {
    const rawDimension = val(asset, 'dimension', 'Dimension');
    const dimension = text(rawDimension).trim().toLowerCase();
    const type = text(val(asset, 'type', 'Type')).trim().toLowerCase();
    const isOneDimensional = dimension === '1d' || dimension === '1' || (!dimension && type === '1d');
    if (isOneDimensional) {
      const length = text(val(asset, 'lut_1d_size', 'LUT1DSize'));
      return length ? `1D · ${t('lut.length', {length})}` : '1D';
    }
    const grid = gridLabel(val(asset, 'lut_3d_size', 'LUT3DSize', 'grid', 'Grid'));
    return grid ? t('lut.grid', {grid}) : '';
  }
  function lutAssetText(asset) {
    const file = text(val(asset, 'file', 'File'));
    const searchableFile = /^sha256-[a-f0-9]{64}\.cube$/i.test(baseName(file)) ? '' : file;
    const cameras = val(asset, 'cameras', 'Cameras');
    const cameraNames = Array.isArray(cameras) ? cameras.map(cameraLabel) : [];
    const fields = [
      val(asset, 'id', 'ID'), val(asset, 'title', 'Title'), ...cameraNames,
      ...(Array.isArray(cameras) ? cameras.map(cameraId) : []),
      val(asset, 'profile', 'Profile'), profileLabel(val(asset, 'profile', 'Profile')),
      val(asset, 'look', 'Look'), lookLabel(val(asset, 'look', 'Look')),
      assetVersionLabel(asset), searchableFile, baseName(searchableFile), val(asset, 'format', 'Format'),
      val(asset, 'dimension', 'Dimension'), val(asset, 'type', 'Type'), lutGridLabel(asset),
      val(asset, 'lut_1d_size', 'LUT1DSize'), val(asset, 'lut_3d_size', 'LUT3DSize'), val(asset, 'grid', 'Grid'),
      val(asset, 'output_color_space', 'OutputColorSpace'), outputColorLabel(val(asset, 'output_color_space', 'OutputColorSpace')),
      val(asset, 'purpose', 'Purpose'), purposeLabel(val(asset, 'purpose', 'Purpose')),
      provenanceLabel(val(asset, 'provenance', 'Provenance'))
    ];
    return fields.map((field) => text(field)).join(' ').toLocaleLowerCase();
  }
  function renderLibraryResults() {
    const results = $('library-results');
    const empty = $('library-no-results');
    if (!hasCompleteLibrary || libraryAssets.length === 0) {
      results.innerHTML = '';
      empty.classList.add('hidden');
      $('library-search-count').textContent = '';
      $('library-pagination').classList.add('hidden');
      $('library-page-status').textContent = '';
      libraryPage = 0;
      libraryPageCount = 1;
      return;
    }
    const query = text($('library-search').value).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matches = libraryAssets.filter((asset) => {
      const searchable = lutAssetText(asset);
      return query.every((term) => searchable.includes(term));
    });
    libraryPageCount = pageCount(matches, LIBRARY_PAGE_SIZE);
    libraryPage = Math.max(0, Math.min(libraryPage, libraryPageCount - 1));
    const start = libraryPage * LIBRARY_PAGE_SIZE;
    const visibleMatches = matches.slice(start, start + LIBRARY_PAGE_SIZE);
    const end = Math.min(matches.length, start + visibleMatches.length);
    $('library-search-count').textContent = query.length
      ? t('library.searchMatches', {matches: matches.length, total: libraryAssets.length})
      : t('library.searchTotal', {count: matches.length});
    $('library-page-status').textContent = matches.length
      ? t('library.pageStatus', {page: libraryPage + 1, pages: libraryPageCount, start: start + 1, end})
      : t('catalog.emptyResult');
    $('library-pagination').classList.toggle('hidden', matches.length <= LIBRARY_PAGE_SIZE);
    $('library-page-prev').disabled = libraryPage <= 0;
    $('library-page-next').disabled = libraryPage >= libraryPageCount - 1;
    empty.classList.toggle('hidden', matches.length !== 0);
    results.innerHTML = visibleMatches.map((asset) => {
      const id = text(val(asset, 'id', 'ID'));
      const file = text(val(asset, 'file', 'File'));
      const title = text(val(asset, 'title', 'Title'), file ? baseName(file) : t('lut.noName'));
      const cameras = val(asset, 'cameras', 'Cameras');
      const cameraNames = Array.isArray(cameras) ? cameras.map(cameraLabel).filter(Boolean) : [];
      const cameraText = cameraNames.length ? [...new Set(cameraNames)].join(i18n.language === 'en' ? ', ' : '、') : t('lut.cameraPending');
      const profile = profileLabel(val(asset, 'profile', 'Profile'));
      const look = lookLabel(val(asset, 'look', 'Look'));
      const version = assetVersionLabel(asset);
      const format = formatLabel(val(asset, 'format', 'Format'));
      const grid = lutGridLabel(asset);
      const output = outputColorLabel(val(asset, 'output_color_space', 'OutputColorSpace'));
      const purpose = purposeLabel(val(asset, 'purpose', 'Purpose'));
      const provenance = provenanceLabel(val(asset, 'provenance', 'Provenance'));
      const linked = Boolean(id) && libraryCatalog.some((entry) => text(val(entry, 'library_id', 'LibraryID')) === id);
      const automatic = val(asset, 'automatic', 'Automatic') === true;
      const isAvailable = automatic && linked;
      const statusClass = isAvailable ? 'available' : automatic ? 'unlisted' : 'reference';
      const status = isAvailable ? t('lut.autoAvailable') : automatic ? t('lut.notAutoListed') : t('lut.reference');
      const hash = text(val(asset, 'sha256', 'SHA256'));
      const hashLabel = hash ? `<span class="lut-hash" title="${esc(t('lut.shaTitle', {hash}))}">SHA-256 ${esc(hash.slice(0, 12))}${hash.length > 12 ? '…' : ''}</span>` : '';
      const sourceLabel = provenance ? `<span class="lut-source">${esc(provenance)}</span>` : '';
      const autoLabel = automatic ? t('lut.safeAutoHint') : t('lut.notInBatch');
      return `<article class="lut-card"><div class="lut-card-heading"><div><h3>${esc(title)}</h3><p>${esc(cameraText)} · ${esc(profile)} · ${esc(look)}</p></div><span class="lut-availability ${statusClass}" title="${esc(autoLabel)}">${esc(status)}</span></div><div class="lut-card-meta"><span>${esc(t('lut.version', {value: version}))}</span><span>${esc(t('lut.format', {value: format}))}${grid ? ` · ${esc(grid)}` : ''}</span><span>${esc(t('lut.output', {value: output}))}</span><span>${esc(t('lut.purpose', {value: purpose}))}</span></div><div class="lut-card-footer"><span class="lut-file">${esc(file ? baseName(file) : t('lut.fileNotProvided'))}</span>${sourceLabel}${hashLabel}</div></article>`;
    }).join('');
  }
  function listLibrary(library, catalog, preservePage = false) {
    const previousPage = libraryPage;
    const assets = val(library, 'assets', 'Assets');
    hasCompleteLibrary = Array.isArray(assets);
    libraryAssets = hasCompleteLibrary ? assets : [];
    libraryCatalog = Array.isArray(catalog) ? catalog : [];
    libraryPage = preservePage ? previousPage : 0;
    $('library-count').textContent = hasCompleteLibrary ? t('lut.countItems', {count: libraryAssets.length}) : t('lut.libraryUnavailable');
    $('library-fallback').classList.toggle('hidden', hasCompleteLibrary);
    $('library-empty').classList.toggle('hidden', !hasCompleteLibrary || libraryAssets.length > 0);
    $('library-search').disabled = !hasCompleteLibrary || libraryAssets.length === 0;
    renderLibraryResults();
  }
  function renderSupportedFormats(extensions) {
    const details = $('supported-format-details');
    const list = $('supported-format-list');
    const supported = Array.isArray(extensions) ? [...new Set(extensions.map((extension) => text(extension).trim()).filter(Boolean))] : [];
    if (supported.length === 0) {
      details.classList.add('hidden');
      $('video-format-hint').textContent = t('input.formatHint');
      list.innerHTML = '';
      return;
    }
    $('video-format-hint').textContent = t('input.formatHintCount', {count: supported.length});
    $('supported-format-count').textContent = t('input.formatCount', {count: supported.length});
    list.innerHTML = supported.map((extension) => `<span>${esc(extension.toUpperCase())}</span>`).join('');
    details.classList.remove('hidden');
  }
  function renderBootstrapResources(bootstrap, preservePages = false) {
    const library = val(bootstrap, 'library', 'Library');
    const catalog = val(bootstrap, 'catalog', 'Catalog') || [];
    indexLibraryCameraNames(library);
    listCatalog(catalog, library, preservePages);
    listLibrary(library, catalog, preservePages);
    renderSupportedFormats(val(bootstrap, 'supported_video_extensions', 'SupportedVideoExtensions'));
  }
  $('library-search').addEventListener('input', () => {
    libraryPage = 0;
    renderLibraryResults();
  });
  function modeLabel(item) {
    const gamma = text(val(item, 'source_gamma', 'gamma', 'Gamma')).trim();
    if (/d[- ]?log\s*m/i.test(gamma)) return 'D-Log M';
    if (/d[- ]?log\s*2/i.test(gamma)) return 'D-Log2';
    if (/^d[- ]?log$/i.test(gamma)) return 'D-Log';
    if (gamma) return gamma;
    const profile = val(item, 'profile', 'Profile');
    return profile ? profileLabel(profile) : t('lut.unrecognized');
  }
  function modeClass(item) {
    const mode = modeLabel(item);
    if (/unrecognized|未识别|unknown|unsupported|missing|conflict/i.test(mode)) return 'unknown';
    if (/hdr|hlg|pq/i.test(mode)) return 'hdr';
    return '';
  }
  function actionLabel(item, preview = false) {
    const action = text(val(item, 'action', 'Action')).toLowerCase();
    const status = text(val(item, 'status', 'Status')).toLowerCase();
    if (action === 'encode' || status === 'planned_encode' || status === 'encoded') return preview ? t('action.planApplyLut') : t('action.applyLut');
    if (action === 'copy') return status === 'copied_needs_review' ? (preview ? t('action.copyReview') : t('action.copiedReview')) : preview ? t('action.copy') : t('action.copySource');
    return text(val(item, 'action', 'Action'), t('action.review'));
  }
  function statusLabel(item) {
    const status = text(val(item, 'status', 'Status')).toLowerCase();
    if (status === 'skipped_existing') return val(item, 'needs_review') ? t('status.skippedReview') : t('status.skippedVerified');
    const labels = {
      planned_encode:t('status.plannedEncode'), planned_copy:t('status.plannedCopy'),
      copied_nonlog:t('status.copiedNonLog'), copied_hdr:t('status.copiedHdr'), copied_needs_review:t('status.copiedReview'),
      encoded:t('status.restored'), skipped_existing:t('status.skipped'), failed:t('status.failed'), cancelled:t('status.cancelled'),
      running:t('status.running'), started:t('status.running'), pending:t('progress.waiting'), done:t('status.complete')
    };
    return labels[status] || text(val(item, 'status', 'Status'), t('status.pending'));
  }
  function statusClass(item) {
    const status = text(val(item, 'status', 'Status')).toLowerCase();
    if (status.includes('fail')) return 'failed';
    if (val(item, 'needs_review')) return 'review';
    if (status.includes('review')) return 'review';
    if (status.includes('copy') || status.includes('skip')) return 'copy';
    if (status.includes('run') || status === 'started') return 'running';
    return 'done';
  }
  function lutDisplayName(item) {
    const title = text(val(item, 'lut_name', 'lutName', 'LUTName'));
    const file = text(val(item, 'lut_file', 'lutFile', 'LUTFile', 'file', 'File'));
    const name = title || (file ? baseName(file) : '');
    const version = text(val(item, 'lut_version', 'lutVersion', 'LUTVersion', 'version', 'Version'));
    if (name && version) return `${name} · ${version}`;
    return name || version;
  }
  function lutName(item) {
    const name = lutDisplayName(item);
    if (name) return name;
    const reason = text(val(item, 'reason', 'Reason'));
    if (/no LUT configured/i.test(reason)) return /look=vivid/i.test(reason) ? t('lut.noVivid') : t('lut.noStandard');
    if (/vivid|鲜艳/i.test(reason) && /missing|not available|unavailable|缺少|没有|不可用/i.test(reason)) return t('lut.noVivid');
    return t('lut.none');
  }
  function runLutName(item) {
    const name = lutDisplayName(item);
    const status = text(val(item, 'status', 'Status')).toLowerCase();
    if (status === 'encoded') return t('lut.applied', {name: name || t('lut.missingInfo')});
    if (status === 'skipped_existing') {
      if (val(item, 'output_verified', 'OutputVerified')) return name ? t('lut.verifiedExisting', {name}) : t('lut.verifiedExistingNoLut');
      return name ? t('lut.unverifiedCandidate', {name}) : t('lut.outputNotVerified');
    }
    if (name) return t('lut.notAppliedCandidate', {name});
    return t('lut.none');
  }
  function previewLutName(item) {
    const name = lutDisplayName(item);
    const action = text(val(item, 'action', 'Action')).toLowerCase();
    if ((action === 'encode' || text(val(item, 'status', 'Status')).toLowerCase() === 'planned_encode') && name) return t('lut.willUse', {name});
    if (name) return t('lut.notAppliedCandidate', {name});
    return lutName(item);
  }
  function reasonText(item, preview = false) {
    const reason = text(val(item, 'reason', 'Reason'));
    if (!reason) return t('generic.dash');
    const waiting = preview || ['pending', 'running', 'planned_copy', 'planned_encode'].includes(text(val(item, 'status', 'Status')).toLowerCase());
    const reviewOutcome = waiting ? t('reason.reviewPlanned') : t('reason.reviewCopied');
    if (/VideoToolbox failed; x265 fallback succeeded/i.test(reason)) return t('reason.hardwareFallback');
    if (/output exists; source and LUT\/look match the previously verified result/i.test(reason)) return t('reason.verifiedExisting');
    if (/output exists; preserved because no matching prior report/i.test(reason)) return t('reason.noPriorReport');
    if (/output exists; preserved because source or LUT\/look configuration differs/i.test(reason)) return t('reason.configDiffers');
    if (/output exists; preserved because its contents differ/i.test(reason)) return t('reason.outputDiffers');
    if (/output exists; preserved because it could not be verified/i.test(reason)) return t('reason.outputUnverified');
    if (/exact DJI gamma metadata, camera evidence, and matching LUT/i.test(reason)) return t('reason.matchFound');
    if (/missing exact .*ColorGammaSxS/i.test(reason)) return t('reason.missingMetadata', {outcome: reviewOutcome});
    if (/explicit Normal\/Rec\.709 allowlist/i.test(reason)) return t('reason.normal');
    if (/explicitly identifies HDR/i.test(reason)) return t('reason.hdr');
    if (/unsupported gamma tag/i.test(reason)) return t('reason.unsupportedGamma', {outcome: reviewOutcome});
    if (/conflicting .*ColorGammaSxS values/i.test(reason)) return t('reason.conflictingGamma', {outcome: reviewOutcome});
    if (/camera model and encoder metadata conflict/i.test(reason)) return t('reason.cameraConflict', {outcome: reviewOutcome});
    if (/camera identity is unknown|camera model and encoder metadata are missing/i.test(reason)) return t('reason.unknownCamera', {outcome: reviewOutcome});
    if (/no LUT configured for camera=([^\s;]+) profile=([^\s;]+) look=([^\s;]+)/i.test(reason)) {
      const match = reason.match(/no LUT configured for camera=([^\s;]+) profile=([^\s;]+) look=([^\s;]+)/i);
      return t('reason.noLut', {camera: cameraLabel(match[1]), profile: profileLabel(match[2]), look: match[3] === 'vivid' ? t('reason.vivid') : t('reason.standard'), outcome: reviewOutcome});
    }
    if (/matching LUT is unavailable or invalid/i.test(reason)) return t('reason.lutInvalid', {outcome: reviewOutcome});
    if (/ffprobe could not classify/i.test(reason)) return t('reason.probeFailed', {outcome: reviewOutcome});
    if (/color_(range|space).*copied for review/i.test(reason)) return t('reason.colorMetadata', {outcome: reviewOutcome});
    return t('api.technicalDetails', {details: reason});
  }
  function detailButton(item, preview, index) {
    const source = preview ? 'preview' : 'progress';
    const fileName = baseName(val(item, 'input', 'Input'));
    return `<button class="row-detail-button" type="button" data-detail-source="${source}" data-detail-index="${index}" aria-haspopup="dialog" aria-label="${esc(t('detail.lookupDetails', {file: fileName}))}">${esc(t('action.details'))}</button>`;
  }
  function itemRow(item, preview, index) {
    const input = text(val(item, 'input', 'Input'));
    const mode = modeLabel(item);
    const camera = cameraLabel(val(item, 'camera', 'Camera'));
    const rawReason = text(val(item, 'reason', 'Reason'));
    const reason = reasonText(item, preview);
    const percent = Math.max(0, Math.min(100, Number(val(item, 'percent', 'Percent')) || 0));
    const file = `<span class="file-name" title="${esc(baseName(input))}">${esc(baseName(input))}</span><span class="path-sub" title="${esc(input)}">${esc(input)}</span>`;
    const modeCell = `<span class="mode-tag ${modeClass(item)}">${esc(mode)}</span>`;
    if (preview) {
      const title = rawReason ? localizedError({message: rawReason}) : reason;
      return `<tr><td>${file}</td><td>${modeCell}</td><td>${esc(camera)}</td><td><span class="lut-name">${esc(previewLutName(item))}</span></td><td>${esc(actionLabel(item, true))}</td><td title="${esc(title)}"><div class="row-detail-line"><span class="row-summary-reason">${esc(reason)}</span>${detailButton(item, true, index)}</div></td></tr>`;
    }
    const rawProgressReason = text(val(item, 'error', 'Error'));
    const progressReason = rawProgressReason ? localizedError({message: rawProgressReason}) : reason;
    const rawTitle = rawReason || rawProgressReason;
    const title = rawTitle ? localizedError({message: rawTitle}) : reason;
    return `<tr><td>${file}</td><td>${modeCell}</td><td>${esc(camera)}</td><td><span class="lut-name">${esc(runLutName(item))}</span></td><td><span class="status-tag ${statusClass(item)}">${esc(statusLabel(item))}</span></td><td class="progress-cell"><progress class="mini-progress" max="100" value="${percent}" aria-label="${esc(t('progress.percent', {file: baseName(input)}))}"></progress>${percent ? `${Math.round(percent)}%` : t('generic.dash')}</td><td title="${esc(title)}"><div class="row-detail-line"><span class="row-summary-reason">${esc(progressReason)}</span>${detailButton(item, false, index)}</div></td></tr>`;
  }
  function detailValue(value) {
    if (Array.isArray(value)) return value.map((entry) => text(entry)).join(i18n.language === 'en' ? ', ' : '、');
    if (value && typeof value === 'object') return JSON.stringify(value, null, 2);
    return text(value);
  }
  function renderItemDetails(item, preview) {
    if (!item) return;
    const input = text(val(item, 'input', 'Input'));
    const rawReason = text(val(item, 'reason', 'Reason'));
    const reason = reasonText(item, preview);
    const details = [
      [t('detail.file'), input],
      [t('detail.camera'), cameraLabel(val(item, 'camera', 'Camera'))],
      [t('detail.mode'), modeLabel(item)],
      [t('detail.sourceGamma'), val(item, 'source_gamma', 'SourceGamma', 'gamma', 'Gamma')],
      [t('detail.profile'), val(item, 'profile', 'Profile')],
      [preview ? t('detail.planAction') : t('detail.status'), preview ? actionLabel(item, true) : statusLabel(item)],
      [preview ? t('detail.planLut') : t('detail.lutResult'), preview ? previewLutName(item) : runLutName(item)],
      [t('detail.lutFile'), val(item, 'lut_file', 'LUTFile')],
      [t('detail.lutVersion'), val(item, 'lut_version', 'LUTVersion')],
      ['LUT SHA-256', val(item, 'lut_sha256', 'LUTSHA256')],
      [t('detail.encoder'), val(item, 'encoder', 'Encoder')],
      [t('detail.description'), reason],
      [t('detail.rawDescription'), rawReason && rawReason !== reason ? localizedError({message: rawReason}) : undefined],
      [t('detail.error'), val(item, 'error', 'Error') ? localizedError({message: val(item, 'error', 'Error')}) : undefined],
      [t('detail.outputFile'), val(item, 'output', 'Output', 'output_path', 'OutputPath')],
      [t('detail.outputVerified'), val(item, 'output_verified', 'OutputVerified') === true ? t('detail.verified') : undefined],
      [t('detail.inputHash'), val(item, 'input_sha256', 'InputSHA256')],
      [t('detail.outputHash'), val(item, 'output_sha256', 'OutputSHA256')],
      [t('detail.sourceMetadata'), val(item, 'source_metadata', 'SourceMetadata')],
      [t('detail.currentProgress'), val(item, 'percent', 'Percent') === undefined ? undefined : `${Math.round(Number(val(item, 'percent', 'Percent')) || 0)}%`]
    ].filter(([, value]) => value !== undefined && value !== '');
    $('file-detail-title').textContent = baseName(input) || t('detail.video');
    $('file-detail-content').innerHTML = `<dl>${details.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(detailValue(value))}</dd>`).join('')}</dl>`;
  }
  function showItemDetails(item, preview, opener) {
    if (!item) return;
    currentDetail = {item, preview};
    renderItemDetails(item, preview);
    openAppDialog($('file-detail-dialog'), opener);
  }
  function willEncode(item) {
    const action = text(val(item, 'action', 'Action')).toLowerCase();
    const status = text(val(item, 'status', 'Status')).toLowerCase();
    return action === 'encode' || status === 'planned_encode';
  }
  function needsReview(item) {
    const status = text(val(item, 'status', 'Status')).toLowerCase();
    return Boolean(val(item, 'needs_review', 'NeedsReview')) || status.includes('review');
  }
  function updateVideoPager(prefix, items, page, totalPages) {
    $(`${prefix}-page-status`).textContent = t('progress.page', {page: page + 1, pages: totalPages, count: items.length});
    $(`${prefix}-pagination`).classList.toggle('hidden', items.length <= ROW_PAGE_SIZE);
    $(`${prefix}-page-prev`).disabled = page <= 0;
    $(`${prefix}-page-next`).disabled = page >= totalPages - 1;
  }
  function renderPreviewPage() {
    previewPageCount = pageCount(previewItems, ROW_PAGE_SIZE);
    previewPage = Math.max(0, Math.min(previewPage, previewPageCount - 1));
    const start = previewPage * ROW_PAGE_SIZE;
    $('preview-rows').innerHTML = previewItems.slice(start, start + ROW_PAGE_SIZE)
      .map((item, offset) => itemRow(item, true, start + offset)).join('');
    $('preview-table-wrap').classList.toggle('hidden', previewItems.length === 0);
    $('preview-empty').classList.toggle('hidden', previewItems.length > 0);
    updateVideoPager('preview', previewItems, previewPage, previewPageCount);
  }
  function renderProgressPage() {
    progressPageCount = pageCount(progressItems, ROW_PAGE_SIZE);
    progressPage = Math.max(0, Math.min(progressPage, progressPageCount - 1));
    const start = progressPage * ROW_PAGE_SIZE;
    $('progress-rows').innerHTML = progressItems.slice(start, start + ROW_PAGE_SIZE)
      .map((item, offset) => itemRow(item, false, start + offset)).join('');
    $('progress-table-wrap').classList.toggle('hidden', progressItems.length === 0);
    $('progress-empty').classList.toggle('hidden', progressItems.length > 0);
    updateVideoPager('progress', progressItems, progressPage, progressPageCount);
  }
  function renderPlan(plan, preservePage = false, preserveView = false) {
    const candidateItems = val(plan, 'items', 'Items');
    const items = Array.isArray(candidateItems) ? candidateItems : [];
    const input = text(val(plan, 'input_root', 'inputRoot', 'InputRoot'), settings().input);
    const output = text(val(plan, 'output_root', 'outputRoot', 'OutputRoot'), finalOutputDestination());
    const look = text(val(plan, 'look', 'Look'), settings().look);
    const recursive = Boolean(val(plan, 'recursive', 'Recursive') ?? settings().recursive);
    const restoreCount = items.filter(willEncode).length;
    const copyCount = Math.max(0, items.length - restoreCount);
    const reviewCount = items.filter((item) => !willEncode(item) && needsReview(item)).length;
    $('run-settings').innerHTML = `<span class="setting-chip" title="${esc(t('preview.inputPath', {path: input}))}">${esc(t('preview.inputPath', {path: input}))}</span><span class="setting-chip" title="${esc(t('preview.outputPath', {path: output}))}">${esc(t('preview.outputPath', {path: output}))}</span><span class="setting-chip">${esc(t('preview.look', {look: look === 'vivid' ? lookLabel('vivid') : lookLabel('standard')}))}</span><span class="setting-chip">${esc(t('preview.subfolders', {value: recursive ? t('preview.includes') : t('preview.excludes')}))}</span>`;
    $('preview-count').textContent = t('video.count', {count: items.length});
    $('preview-restore-count').textContent = restoreCount;
    $('preview-copy-count').textContent = copyCount;
    $('preview-review-count').textContent = reviewCount;
    previewItems = items;
    currentPlan = plan;
    if (!preservePage) previewPage = 0;
    previewPageAvailable = true;
    renderPreviewPage();
    $('preview-stale').classList.add('hidden');
    $('preview-section').classList.remove('hidden');
    hasPreview = items.length > 0;
    previewSnapshot = JSON.stringify(settings());
    if (!hasPreview && !preserveView) showMessage(t('state.fileNotFound'));
    if (!preserveView) setGuidedStep('preview');
    syncControls();
    if (!preserveView && interfaceMode === 'classic') $('preview-section').scrollIntoView({behavior:'smooth', block:'start'});
  }

  function summaryCard(label, value, cls = '') {
    return `<div class="summary-card ${cls}"><span>${esc(label)}</span><b>${Number(value) || 0}</b></div>`;
  }
  function localizeLog(value) {
    const line = text(value).trim();
    const fixed = new Map([
      ['已取消批量处理。', 'log.batchCancelled'],
      ['处理完成。', 'log.processingComplete'],
      ['开始批量处理。', 'log.batchStarting'],
      ['正在停止批量处理。', 'log.batchStopping'],
      ['批量处理完成。', 'log.batchComplete'],
      ['还原完成', 'log.restored'],
      ['复制完成', 'log.copied'],
      ['待确认素材已复制', 'log.reviewCopied'],
      ['跳过已有文件', 'log.skipped'],
      ['处理失败', 'log.failed'],
      ['Scanning complete; processing files', 'engineLog.scanning'],
      ['Scanning cancelled', 'engineLog.scanCancelled'],
      ['No videos found', 'engineLog.noVideos'],
      ['Processing cancelled', 'engineLog.processingCancelled'],
      ['Processing complete', 'engineLog.processingComplete'],
      ['Encoding and validation complete', 'engineLog.encodingComplete']
    ]);
    const exactKey = fixed.get(line);
    if (exactKey) return t(exactKey);
    let match = line.match(/^扫描完成：(.+)，共发现 (\d+) 个视频。$/);
    if (match) return t('log.scanComplete', {path: match[1], count: match[2]});
    match = line.match(/^开始处理 (\d+) 个视频，输出到 (.+)。$/);
    if (match) return t('log.batchStarted', {count: match[1], path: match[2]});
    match = line.match(/^批量处理失败：(.+)$/s);
    if (match) return t('log.batchFailed', {details: localizeErrorText(match[1])});
    match = line.match(/^正在处理：(.+)$/);
    if (match) return t('log.processing', {path: match[1]});
    match = line.match(/^文件处理结束：(.+)$/);
    if (match) return t('log.fileFinished', {path: match[1]});
    match = line.match(/^(.+?)：(.+)（(.*)）$/);
    if (match) {
      const labels = {
        '还原完成': t('log.restored'), '复制完成': t('log.copied'),
        '待确认素材已复制': t('log.reviewCopied'), '跳过已有文件': t('log.skipped'),
        '处理失败': t('log.failed')
      };
      if (labels[match[1]]) return t('log.fileStatus', {status: labels[match[1]], path: match[2], lut: localizeLogLut(match[3])});
    }
    const known = i18n.translateKnownMessage(line);
    if (known) return known;
    return line ? t('api.technicalDetails', {details: line}) : '';
  }
  function localizeLogLut(value) {
    const name = text(value).trim();
    if (name === '未使用 LUT' || name === 'No LUT used') return t('lut.none');
    return value;
  }
  function localizeErrorText(value) {
    const known = i18n.translateKnownMessage(value);
    return known || t('api.technicalDetails', {details: value});
  }
  function renderState(state) {
    const running = Boolean(val(state, 'running', 'Running'));
    const finished = Boolean(val(state, 'finished', 'done', 'Finished', 'Done'));
    const cancelled = Boolean(val(state, 'cancelled', 'Cancelled'));
    const stateError = val(state, 'error', 'Error');
    const terminal = !running && (finished || cancelled || Boolean(stateError));
    if (batchLocked && running) return;
    currentState = state;
    processing = running;
    batchLocked = terminal;
    if (running) setGuidedStep('processing');
    else if (terminal && !terminalResultPresented) {
      terminalResultPresented = true;
      setGuidedStep('result');
    }
    const summary = val(state, 'summary', 'Summary') || {};
    const stateItems = val(state, 'items', 'Items');
    const plan = val(state, 'plan', 'Plan') || {};
    const planItems = val(plan, 'items', 'Items');
    const currentItems = Array.isArray(stateItems) ? stateItems : [];
    const items = currentItems.length || !Array.isArray(planItems) ? currentItems : planItems;
    progressItems = items;
    progressPage = Math.max(0, Math.min(progressPage, pageCount(progressItems, ROW_PAGE_SIZE) - 1));
    progressPageAvailable = true;
    updateGuidedPage();
    const completed = Number(val(state, 'completed', 'Completed')) || 0;
    const total = Number(val(state, 'total', 'Total')) || items.length;
    const currentPercent = Number(val(state, 'percent', 'Percent', 'overall_percent', 'overallPercent')) || (total ? completed / total * 100 : 0);
    $('progress-title').textContent = running ? t('section.runningTitle') : finished ? t('status.batchEnded') : t('section.progressTitle');
    const stateBadge = $('run-state');
    stateBadge.className = `state-badge ${running ? 'running' : cancelled ? 'cancelled' : finished ? 'complete' : 'running'}`;
    stateBadge.innerHTML = `<i></i> ${running ? t('status.running') : cancelled ? t('status.cancelled') : finished ? t('status.finished') : t('progress.preparing')}`;
    $('progress-caption').textContent = text(val(state, 'current_file', 'currentFile', 'CurrentFile'), running ? t('progress.preparingTask') : finished ? t('progress.finished') : t('progress.waiting'));
    $('progress-numbers').textContent = t('progress.current', {completed, total});
    $('progress-fill').value = Math.max(0, Math.min(100, currentPercent));
    $('summary-grid').innerHTML = [
      summaryCard(t('summary.restoreLut'), val(summary,'encoded','Encoded')),
      summaryCard(t('summary.copy'), val(summary,'copied','Copied')),
      summaryCard(t('summary.needsReview'), val(summary,'needs_review','needsReview','NeedsReview'), 'review'),
      summaryCard(t('summary.skipped'), val(summary,'skipped','Skipped')),
      summaryCard(t('summary.failed'), val(summary,'failed','Failed'), 'failed')
    ].join('');
    renderProgressPage();
    const logs = val(state, 'logs', 'Logs') || [];
    $('log-list').innerHTML = logs.map((entry) => `<div class="log-entry">${esc(localizeLog(typeof entry === 'string' ? entry : text(val(entry,'message','Message'))))}</div>`).join('');
    $('cancel-button').disabled = !running || !connected;
    if (terminal) {
      $('complete-actions').classList.remove('hidden');
      const encodedCount = Number(val(summary,'encoded','Encoded')) || 0;
      const copiedCount = Number(val(summary,'copied','Copied')) || 0;
      const reviewCount = Number(val(summary,'needs_review','needsReview','NeedsReview')) || 0;
      const failedCount = Number(val(summary,'failed','Failed')) || 0;
      const counts = t('status.batchCounts', {encoded: encodedCount, copied: copiedCount, review: reviewCount, failed: failedCount});
      const ending = cancelled ? t('complete.batchCancelled') : failedCount ? t('complete.batchFailed') : reviewCount ? t('complete.needsReview') : t('complete.success');
      const completeMessage = text(stateError, `${ending}${counts}`);
      const displayedCompleteMessage = stateError ? localizedError({message: stateError}) : completeMessage;
      $('complete-message').textContent = displayedCompleteMessage;
      if (!shuttingDown && activeOperation !== 'picker') showMessage(displayedCompleteMessage);
      if (connected) $('footer-status').textContent = cancelled ? t('status.taskCancelled') : t('progress.finished');
    } else {
      $('complete-actions').classList.add('hidden');
      if (running && !shuttingDown && activeOperation !== 'picker') showMessage(t('status.processingHint'));
      if (connected) $('footer-status').textContent = running ? t('status.processingFiles') : t('state.localReady');
    }
    syncControls();
  }
  function ensureStatePolling() {
    if (!pollTimer) pollTimer = setInterval(refreshState, 900);
  }
  async function refreshState({recover = false} = {}) {
    const version = batchVersion;
    try {
      const state = await api('/api/state');
      if (version !== batchVersion || (activeOperation && !recover) || (!stateRecoveryEnabled && recover)) return;
      const running = Boolean(val(state, 'running', 'Running'));
      const finished = Boolean(val(state, 'finished', 'done', 'Finished', 'Done'));
      const terminal = Boolean(val(state, 'cancelled', 'Cancelled')) || Boolean(val(state, 'error', 'Error'));
      if (!running && !finished && !terminal) return;
      renderState(state);
      if (running && !batchLocked) ensureStatePolling();
      else if (!running && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    } catch (error) {
      if (!shuttingDown && activeOperation !== 'picker') showMessage(localizedError(error));
      if (pollTimer && !processing) { clearInterval(pollTimer); pollTimer = null; }
    }
  }

  async function chooseFolder(target) {
    if (operationBusy() || batchLocked || !connected) return;
    const path = target === 'input' ? inputPath.value.trim() : outputPath.value.trim() || outputBase();
    beginOperation('picker');
    showMessage(target === 'input' ? t('state.folderPickerInput') : t('state.folderPickerOutput'));
    try {
      const request = {target, path, ...(!isDesktop ? {language: i18n.language} : {})};
      const result = await api('/api/select-folder', {method:'POST', body:JSON.stringify(request)});
      if (shuttingDown) return;
      if (Boolean(val(result, 'cancelled', 'Cancelled'))) {
        showMessage(t('state.selectionCancelled'));
        return;
      }
      const chosen = text(val(result, 'path', 'Path')).trim();
      if (!chosen) throw new Error(t('errors.folderNotSelected'));
      const currentPath = target === 'input' ? inputPath.value.trim() : outputPath.value.trim() || outputBase();
      if (sameDirectory(chosen, currentPath)) {
        showMessage(t(hasPreview ? 'state.pathUnchangedPreview' : 'state.pathUnchangedRescan'));
        return;
      }
      if (target === 'input') inputPath.value = chosen;
      else outputPath.value = chosen;
      invalidatePreview();
      showMessage(t('state.folderUpdated'));
    } catch (error) {
      if (!shuttingDown) { const message = localizedError(error); showMessage(message); toast(message); }
    } finally {
      endOperation('picker');
    }
  }

  async function reconnect() {
    if (operationBusy() || (!isDesktop && !token)) return;
    beginOperation('reconnect');
    showMessage(t('state.reconnecting'));
    try {
      const boot = await api('/api/bootstrap');
      if (shuttingDown) return;
      latestBootstrap = boot;
      renderBootstrapResources(boot);
      if (stateRecoveryEnabled) await refreshState({recover:true});
      if (connected && !shuttingDown) {
        $('footer-status').textContent = processing ? t('status.processingFiles') : t(isDesktop ? 'connection.desktopReady' : 'state.localReady');
        if (!batchLocked) showMessage(t('state.reconnected'));
      }
    } catch (error) {
      if (!shuttingDown) { const message = localizedError(error); showMessage(message); toast(message); }
    } finally {
      endOperation('reconnect');
    }
  }

  async function scanPreview() {
    if (operationBusy() || batchLocked || !connected) return;
    const request = settings();
    if (!request.input) { showMessage(t('state.inputRequired')); inputPath.focus(); return; }
    stateRecoveryEnabled = false;
    hasPreview = false;
    previewSnapshot = '';
    currentPlan = null;
    previewItems = [];
    previewPage = 0;
    previewPageAvailable = false;
    renderPreviewPage();
    $('preview-stale').classList.add('hidden');
    $('preview-section').classList.add('hidden');
    setGuidedStep('settings');
    beginOperation('preview');
    showMessage(t('state.scanning'));
    try {
      const plan = await api('/api/preview', {method:'POST', body:JSON.stringify(request)});
      if (shuttingDown) return;
      renderPlan(val(plan,'plan','Plan') || plan);
      showMessage(t(hasPreview ? 'state.previewReady' : 'state.fileNotFound'));
    } catch (error) {
      if (!shuttingDown) { const message = localizedError(error); showMessage(message); toast(message); }
    } finally {
      endOperation('preview');
    }
  }
  previewButton.addEventListener('click', scanPreview);

  runButton.addEventListener('click', async () => {
    if (operationBusy() || batchLocked || !connected || !hasPreview) return;
    if (JSON.stringify(settings()) !== previewSnapshot) { invalidatePreview(); return; }
    beginOperation('starting');
    terminalResultPresented = false;
    stateRecoveryEnabled = true;
    showMessage(t('state.startingRun'));
    try {
      const state = await api('/api/run', {method:'POST', body:JSON.stringify(settings())});
      if (shuttingDown) return;
      renderState(state);
      if (processing) ensureStatePolling();
      if (interfaceMode === 'classic') $('progress-section').scrollIntoView({behavior:'smooth', block:'start'});
    } catch (error) {
      if (!shuttingDown && !processing && !batchLocked) setGuidedStep('preview');
      if (!shuttingDown) { const message = localizedError(error); showMessage(message); toast(message); }
    } finally {
      endOperation('starting');
    }
  });

  $('new-batch-button').addEventListener('click', () => {
    if (operationBusy()) return;
    batchVersion++;
    stateRecoveryEnabled = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    currentState = null;
    currentPlan = null;
    processing = false;
    batchLocked = false;
    hasPreview = false;
    previewSnapshot = '';
    previewItems = [];
    progressItems = [];
    previewPage = 0;
    progressPage = 0;
    previewPageAvailable = false;
    progressPageAvailable = false;
    terminalResultPresented = false;
    guidedStep = 'settings';
    $('preview-section').classList.add('hidden');
    $('progress-section').classList.add('hidden');
    $('complete-actions').classList.add('hidden');
    $('preview-stale').classList.add('hidden');
    $('preview-rows').innerHTML = '';
    $('progress-rows').innerHTML = '';
    $('summary-grid').innerHTML = '';
    $('log-list').innerHTML = '';
    renderPreviewPage();
    renderProgressPage();
    showMessage(t('state.newBatch'));
    updateGuidedPage();
    syncControls();
    window.scrollTo({top:0, behavior:'smooth'});
  });
  $('cancel-button').addEventListener('click', async () => {
    if (!processing || cancelPending) return;
    cancelPending = true;
    syncControls();
    try { await api('/api/cancel', {method:'POST', body:'{}'}); toast(t('state.cancelRequested')); }
    catch (error) { toast(localizedError(error)); }
    finally { cancelPending = false; syncControls(); }
  });
  $('open-output-button').addEventListener('click', async () => {
    try { await api('/api/open-output', {method:'POST', body:'{}'}); toast(t('state.outputOpened')); }
    catch (error) { toast(localizedError(error)); }
  });
  $('report-button').addEventListener('click', async () => {
    if (!isDesktop) {
      const report = val(currentState, 'report', 'Report') || currentState;
      const blob = new Blob([JSON.stringify(report, null, 2)], {type:'application/json'});
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'lut-app-report.json';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }
    if (operationBusy() || !connected || exportPending) return;
    exportPending = true;
    beginOperation('export-report');
    showMessage(t('state.exporting'));
    try {
      const result = await api('/api/export-report', {method:'POST', body:'{}'});
      if (shuttingDown) return;
      if (Boolean(val(result, 'cancelled', 'Cancelled'))) {
        showMessage(t('state.exportCancelled'));
        toast(t('state.exportCancelled'));
        return;
      }
      const path = text(val(result, 'path', 'Path')).trim();
      const saved = path ? t('state.reportSavedPath', {path}) : t('state.reportSaved');
      showMessage(saved);
      toast(saved);
    } catch (error) {
      if (!shuttingDown) { const message = localizedError(error); showMessage(message); toast(message); }
    } finally {
      exportPending = false;
      endOperation('export-report');
    }
  });
  const closeApplication = async () => {
    if (shuttingDown || exportPending) return;
    shuttingDown = true;
    activeOperation = 'shutdown';
    showMessage(t('state.closing'));
    syncControls();
    try { await api('/api/shutdown', {method:'POST', body:'{}'}); }
    catch (error) {
      if (isDesktop) {
        shuttingDown = false;
        activeOperation = '';
        showMessage(localizedError(error));
        toast(localizedError(error));
        syncControls();
        return;
      }
      /* Server may close the connection immediately after accepting shutdown. */
    }
    if (isDesktop) {
      $('footer-status').textContent = t('connection.desktopClosing');
      toast(t('state.appClosing'));
      return;
    }
    try { sessionStorage.removeItem('dji-lut-access'); } catch (_) { /* No persistent data to clear. */ }
    $('footer-status').textContent = t('state.appClosedBrowser');
    toast(t('state.appClosed'));
    setTimeout(() => window.close(), 700);
  };
  if (isDesktop) {
    $('app-mode-hint').textContent = t('app.desktopHint');
  }
  $('close-button').addEventListener('click', closeApplication);
  $('header-close-button').addEventListener('click', closeApplication);

  $('mode-toggle').addEventListener('click', () => {
    interfaceMode = interfaceMode === 'guided' ? 'classic' : 'guided';
    saveInterfaceMode();
    updateGuidedPage();
    syncControls();
  });
  $('guided-back-button').addEventListener('click', () => {
    if (processing || activeOperation || shuttingDown) return;
    if (guidedStep === 'result' && previewPageAvailable) setGuidedStep('preview');
    else if (guidedStep === 'preview') setGuidedStep(batchLocked ? 'result' : 'settings');
  });
  $('guided-continue-preview-button').addEventListener('click', () => {
    if (processing || activeOperation || batchLocked || !hasReusablePreview()) return;
    setGuidedStep('preview');
    $('preview-section').scrollTop = 0;
  });
  $('preview-page-prev').addEventListener('click', () => { previewPage--; renderPreviewPage(); syncControls(); });
  $('preview-page-next').addEventListener('click', () => { previewPage++; renderPreviewPage(); syncControls(); });
  $('progress-page-prev').addEventListener('click', () => { progressPage--; renderProgressPage(); syncControls(); });
  $('progress-page-next').addEventListener('click', () => { progressPage++; renderProgressPage(); syncControls(); });
  $('library-page-prev').addEventListener('click', () => { libraryPage--; renderLibraryResults(); syncControls(); });
  $('library-page-next').addEventListener('click', () => { libraryPage++; renderLibraryResults(); syncControls(); });
  $('catalog-page-prev').addEventListener('click', () => { catalogPage--; renderCatalogPage(); syncControls(); });
  $('catalog-page-next').addEventListener('click', () => { catalogPage++; renderCatalogPage(); syncControls(); });
  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-detail-source][data-detail-index]');
    if (!button) return;
    const index = Number(button.dataset.detailIndex);
    const preview = button.dataset.detailSource === 'preview';
    showItemDetails((preview ? previewItems : progressItems)[index], preview, button);
  });
  const lutDialog = $('lut-dialog');
  const fileDetailDialog = $('file-detail-dialog');
  restoreDialogFocus(lutDialog, $('mode-toggle'));
  restoreDialogFocus(fileDetailDialog, $('mode-toggle'));
  fileDetailDialog.addEventListener('close', () => { currentDetail = null; });
  $('lut-open-button').addEventListener('click', (event) => openAppDialog(lutDialog, event.currentTarget));
  $('lut-dialog-close').addEventListener('click', () => lutDialog.close());
  $('file-detail-close').addEventListener('click', () => fileDetailDialog.close());
  for (const dialog of [lutDialog, fileDetailDialog]) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }
  $('language-select').addEventListener('change', (event) => { void changeLanguage(event.currentTarget.value); });
  updateGuidedPage();

  (async () => {
    syncControls();
    updateOutputDestination();
    if (!isDesktop && !token) {
      $('connection').classList.add('disconnected');
      $('connection').innerHTML = `<i></i> ${t('connection.noCredential')}`;
      $('connection').setAttribute('aria-label', t('connection.noCredential'));
      $('footer-status').textContent = t('state.noCredentialPage');
      showMessage(t('state.noCredentialHint'));
      activeOperation = '';
      syncControls();
      $('header-close-button').disabled = true;
      return;
    }
    try {
      if (isDesktop) {
        try {
          const preference = await api('/api/desktop-preferences');
          const preferred = i18nApi.normalizeLanguage(val(preference, 'language', 'Language'));
          if (preferred) nativeLanguageController.setConfirmed(preferred);
        } catch (_) { /* Older or restarting desktop bridges can use the browser fallback. */ }
        desktopPreferenceReady = true;
        $('language-select').disabled = false;
      }
      const boot = await api('/api/bootstrap');
      const defaults = val(boot,'defaults','Defaults') || boot;
      inputPath.value = text(val(defaults,'input','input_root','Input'), '');
      outputPath.value = text(val(defaults,'output','output_root','Output'), '');
      const look = text(val(defaults,'look','Look'), 'standard');
      const choice = document.querySelector(`input[name="look"][value="${look === 'vivid' ? 'vivid' : 'standard'}"]`);
      if (choice) choice.checked = true;
      $('recursive').checked = Boolean(val(defaults,'recursive','Recursive'));
      latestBootstrap = boot;
      renderBootstrapResources(boot);
      updateOutputDestination();
      $('footer-status').textContent = t(isDesktop ? 'connection.desktopReady' : 'state.localReady');
      await refreshState({recover:true});
    } catch (error) {
      if (connected) $('footer-status').textContent = t(isDesktop ? 'state.desktopInitFailed' : 'state.localInitFailed');
      showMessage(localizedError(error));
      toast(localizedError(error));
    } finally {
      endOperation('bootstrap');
    }
  })();
})();
