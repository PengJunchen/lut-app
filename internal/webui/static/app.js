(() => {
  'use strict';

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
  let libraryAssets = [];
  let libraryCatalog = [];
  let catalogEntries = [];
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
  const dialogOpener = new WeakMap();

  history.replaceState(null, '', location.pathname + location.search);

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
        setConnection(reachable);
        const failure = new Error(reachable ? text(error?.message, `请求失败 (${status})`) : '无法连接本机服务，请点击“重新连接”后重试。');
        failure.cause = error;
        if (Number.isFinite(status)) failure.status = status;
        throw failure;
      }
      const status = Number(response?.status);
      const payload = response?.payload ?? {};
      const ok = Boolean(response?.ok);
      const validStatus = Number.isInteger(status) && status >= 100 && status <= 599;
      setConnection(validStatus && status !== 401 && status !== 403 && status < 500);
      if (!ok) {
        const message = text(val(payload, 'error', 'message'), `请求失败 (${validStatus ? status : '未知状态'})`);
        if (status === 401 || status === 403 || status >= 500) setConnection(false);
        const failure = new Error(message);
        if (validStatus) failure.status = status;
        throw failure;
      }
      return payload;
    }
    if (!token) throw new Error('缺少本机访问凭据，请关闭此页面后重新启动应用。');
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    let response;
    try {
      response = await fetch(route, {...options, headers, cache:'no-store', credentials:'same-origin'});
    } catch (error) {
      setConnection(false);
      const unavailable = new Error('无法连接本机服务，请点击“重新连接”后重试。');
      unavailable.cause = error;
      throw unavailable;
    }
    setConnection(response.status !== 401 && response.status !== 403 && response.status < 500);
    const body = await response.text();
    let payload = {};
    try { payload = body ? JSON.parse(body) : {}; } catch (_) { payload = {message: body}; }
    if (!response.ok) {
      const message = text(val(payload, 'error', 'message'), `请求失败 (${response.status})`);
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
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
  };
  const showMessage = (message = '') => { $('settings-message').textContent = message; };
  const operationBusy = () => Boolean(activeOperation) || processing || shuttingDown;
  const setConnection = (ready) => {
    connected = ready;
    const node = $('connection');
    node.classList.toggle('disconnected', !ready);
    node.innerHTML = `<i></i> ${ready ? (isDesktop ? '桌面应用已就绪' : '本机服务已连接') : (isDesktop ? '桌面应用连接中断' : '连接中断')}`;
    reconnectButton.classList.toggle('hidden', ready || (!isDesktop && !token));
    if (!ready) $('footer-status').textContent = isDesktop ? '桌面应用连接中断，请重新连接后继续' : '本机服务连接中断，请重新连接后继续';
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
    if (!input) return '原片文件夹/Output';
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
    $('output-destination').textContent = `最终目的地：${finalOutputDestination()}`;
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
    $('mode-toggle').textContent = guided ? '经典模式' : '分步模式';
    $('mode-toggle').setAttribute('aria-label', guided ? '切换到经典模式' : '切换到分步模式');
    $('mode-toggle').title = guided ? '切换到经典模式' : '切换到分步模式';
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
      settings: '第 1 步：选择素材',
      preview: '第 2 步：扫描预览',
      processing: '第 3 步：正在处理',
      result: '第 3 步：处理结果'
    };
    $('guided-page-status').textContent = status[guidedStep] || status.settings;

    const canReturn = (guidedStep === 'preview' && previewPageAvailable) || (guidedStep === 'result' && progressPageAvailable);
    $('guided-back-button').classList.toggle('hidden', !canReturn);
    $('guided-back-button').textContent = guidedStep === 'result'
      ? '回看预览'
      : batchLocked ? '返回处理结果' : '返回设置';
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
      $('preview-stale').classList.remove('hidden');
      showMessage('设置已改变，旧预览已失效；请重新扫描并预览。');
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
    $('catalog-count').textContent = catalogEntries.length ? `${catalogEntries.length} 个组合` : '暂不可用';
    if (!catalogEntries.length) {
      node.textContent = '当前没有可自动匹配的 Log → Rec.709 LUT。';
      $('catalog-page-status').textContent = '';
      $('catalog-pagination').classList.add('hidden');
    } else {
      const start = catalogPage * CATALOG_PAGE_SIZE;
      const visibleEntries = catalogEntries.slice(start, start + CATALOG_PAGE_SIZE);
      const end = Math.min(catalogEntries.length, start + visibleEntries.length);
      node.innerHTML = visibleEntries.join('');
      $('catalog-page-status').textContent = `第 ${catalogPage + 1} / ${catalogPageCount} 页 · ${start + 1}–${end} 项`;
      $('catalog-pagination').classList.toggle('hidden', catalogEntries.length <= CATALOG_PAGE_SIZE);
    }
    $('catalog-page-prev').disabled = catalogPage <= 0;
    $('catalog-page-next').disabled = catalogPage >= catalogPageCount - 1;
  }
  function listCatalog(catalog, library) {
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
          : '当前未提供自动匹配资源';
        const lookName = lookLabel(look);
        supported.push(`<span class="catalog-pill${item ? '' : ' unavailable'}"><b>${esc(label)} · ${esc(lookName)}${item ? ' · 可用' : ''}</b><small class="catalog-detail">${detail}</small></span>`);
      }
    }
    catalogEntries = supported;
    catalogPage = 0;
    renderCatalogPage();
  }

  function profileLabel(profile) {
    const key = text(profile).toLowerCase().replace(/[-_ ]/g, '');
    const labels = {dlog2:'D-Log2', dlogm:'D-Log M', dlog:'D-Log', rec709:'Rec.709', linear:'线性', other:'其他'};
    return labels[key] || text(profile, '未知模式');
  }
  function lookLabel(look) {
    const key = text(look).trim().toLowerCase();
    const labels = {standard:'标准', vivid:'鲜艳', gamma18:'Gamma 1.8', gamma22:'Gamma 2.2'};
    return labels[key] || text(look, '其他风格');
  }
  function cameraLabel(camera) {
    const directName = typeof camera === 'object' && camera !== null ? text(val(camera, 'name', 'Name', 'title', 'label')) : '';
    const id = cameraId(camera);
    const key = normalizedKey(id);
    const labels = {
      pocket4p:'DJI Osmo Pocket 4P', pocket3:'DJI Osmo Pocket 3', action4:'DJI Osmo Action 4',
      action5pro:'DJI Osmo Action 5 Pro', action6:'DJI Osmo Action 6', mavic3:'DJI Mavic 3',
      mavic2pro:'DJI Mavic 2 Pro', air2s:'DJI Air 2S', air3:'DJI Air 3', air3s:'DJI Air 3S', unknown:'未识别'
    };
    return directName || libraryCameraNames.get(key) || labels[key] || id || '未识别';
  }
  function outputColorLabel(value) {
    const labels = {rec709:'Rec.709', 'rec2020-hlg':'Rec.2020 HLG', srgb:'sRGB', dlog:'D-Log', unknown:'未知'};
    return labels[text(value).toLowerCase()] || '未知';
  }
  function purposeLabel(value) {
    const labels = {restore:'还原转换', creative:'创意风格', gamma_conversion:'伽马转换', monitoring:'监看', unknown:'用途待确认'};
    return labels[text(value).toLowerCase()] || '用途待确认';
  }
  function provenanceLabel(value) {
    const raw = typeof value === 'object' && value !== null ? text(val(value, 'label', 'name', 'source', 'kind')) : text(value);
    const key = raw.toLowerCase().replace(/[-_ ]/g, '');
    if (key === 'supplied' || key === 'usersupplied' || key === 'provided') return '已提供来源';
    if (key === 'official' || key === 'djiofficial' || key === 'djidownloadcenter') return 'DJI 官方来源';
    return raw;
  }
  function formatLabel(value) {
    const format = text(value).trim();
    return format ? format.toUpperCase() : '格式未知';
  }
  function gridLabel(value) {
    if (value === undefined || value === null || value === '') return '';
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? `${numeric}³` : text(value);
  }
  function assetVersionLabel(asset) {
    const version = text(val(asset, 'version', 'Version')).trim();
    return version || '官方未标版本';
  }
  function lutGridLabel(asset) {
    const rawDimension = val(asset, 'dimension', 'Dimension');
    const dimension = text(rawDimension).trim().toLowerCase();
    const type = text(val(asset, 'type', 'Type')).trim().toLowerCase();
    const isOneDimensional = dimension === '1d' || dimension === '1' || (!dimension && type === '1d');
    if (isOneDimensional) {
      const length = text(val(asset, 'lut_1d_size', 'LUT1DSize'));
      return length ? `1D · 长度 ${length}` : '1D';
    }
    const grid = gridLabel(val(asset, 'lut_3d_size', 'LUT3DSize', 'grid', 'Grid'));
    return grid ? `${grid} 网格` : '';
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
    $('library-search-count').textContent = query.length ? `显示 ${matches.length} / ${libraryAssets.length} 项` : `共 ${matches.length} 项`;
    $('library-page-status').textContent = matches.length ? `第 ${libraryPage + 1} / ${libraryPageCount} 页 · ${start + 1}–${end} 项` : '无结果';
    $('library-pagination').classList.toggle('hidden', matches.length <= LIBRARY_PAGE_SIZE);
    $('library-page-prev').disabled = libraryPage <= 0;
    $('library-page-next').disabled = libraryPage >= libraryPageCount - 1;
    empty.classList.toggle('hidden', matches.length !== 0);
    results.innerHTML = visibleMatches.map((asset) => {
      const id = text(val(asset, 'id', 'ID'));
      const file = text(val(asset, 'file', 'File'));
      const title = text(val(asset, 'title', 'Title'), file ? baseName(file) : '未命名 LUT');
      const cameras = val(asset, 'cameras', 'Cameras');
      const cameraNames = Array.isArray(cameras) ? cameras.map(cameraLabel).filter(Boolean) : [];
      const cameraText = cameraNames.length ? [...new Set(cameraNames)].join('、') : '适用相机待确认';
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
      const status = isAvailable ? '自动匹配可用' : automatic ? '未列入自动清单' : '仅供查看';
      const hash = text(val(asset, 'sha256', 'SHA256'));
      const hashLabel = hash ? `<span class="lut-hash" title="SHA-256：${esc(hash)}">SHA-256 ${esc(hash.slice(0, 12))}${hash.length > 12 ? '…' : ''}</span>` : '';
      const sourceLabel = provenance ? `<span class="lut-source">${esc(provenance)}</span>` : '';
      const autoLabel = automatic ? '可用于安全自动匹配，但需同时列入当前自动清单' : '不会参与批量自动还原';
      return `<article class="lut-card"><div class="lut-card-heading"><div><h3>${esc(title)}</h3><p>${esc(cameraText)} · ${esc(profile)} · ${esc(look)}</p></div><span class="lut-availability ${statusClass}" title="${esc(autoLabel)}">${esc(status)}</span></div><div class="lut-card-meta"><span>版本 ${esc(version)}</span><span>格式 ${esc(format)}${grid ? ` · ${esc(grid)}` : ''}</span><span>输出 ${esc(output)}</span><span>用途 ${esc(purpose)}</span></div><div class="lut-card-footer"><span class="lut-file">${esc(file ? baseName(file) : '文件名未提供')}</span>${sourceLabel}${hashLabel}</div></article>`;
    }).join('');
  }
  function listLibrary(library, catalog) {
    const assets = val(library, 'assets', 'Assets');
    hasCompleteLibrary = Array.isArray(assets);
    libraryAssets = hasCompleteLibrary ? assets : [];
    libraryCatalog = Array.isArray(catalog) ? catalog : [];
    libraryPage = 0;
    $('library-count').textContent = hasCompleteLibrary ? `${libraryAssets.length} 项` : '暂不可用';
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
      $('video-format-hint').textContent = '文件后缀只用于发现候选；即使是 AVC/HEVC、PCM 或 ProRes 流，也须由本机解码器实际读取后才可处理。无法处理或确认的素材会原样保留并标记待确认。';
      list.innerHTML = '';
      return;
    }
    $('video-format-hint').textContent = `此版本会扫描 ${supported.length} 种列出的文件后缀。后缀只用于发现候选；即使是 AVC/HEVC、PCM 或 ProRes 流，也须由本机解码器实际读取后才可处理。无法处理或确认的素材会原样保留并标记待确认。`;
    $('supported-format-count').textContent = `查看 ${supported.length} 种支持扫描的文件后缀`;
    list.innerHTML = supported.map((extension) => `<span>${esc(extension.toUpperCase())}</span>`).join('');
    details.classList.remove('hidden');
  }
  function renderBootstrapResources(bootstrap) {
    const library = val(bootstrap, 'library', 'Library');
    const catalog = val(bootstrap, 'catalog', 'Catalog') || [];
    indexLibraryCameraNames(library);
    listCatalog(catalog, library);
    listLibrary(library, catalog);
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
    return profile ? profileLabel(profile) : '未识别';
  }
  function modeClass(item) {
    const mode = modeLabel(item);
    if (mode === '未识别' || /unknown|unsupported|missing|conflict/i.test(mode)) return 'unknown';
    if (/hdr|hlg|pq/i.test(mode)) return 'hdr';
    return '';
  }
  function actionLabel(item, preview = false) {
    const action = text(val(item, 'action', 'Action')).toLowerCase();
    const status = text(val(item, 'status', 'Status')).toLowerCase();
    if (action === 'encode' || status === 'planned_encode' || status === 'encoded') return preview ? '计划套用 LUT' : '套用 LUT';
    if (action === 'copy') return status === 'copied_needs_review' ? (preview ? '原样复制 · 待确认' : '已原样复制 · 待确认') : preview ? '原样复制' : '复制原片';
    return text(val(item, 'action', 'Action'), '待确认');
  }
  function statusLabel(item) {
    const status = text(val(item, 'status', 'Status')).toLowerCase();
    if (status === 'skipped_existing') return val(item, 'needs_review') ? '已跳过 · 待确认' : '已跳过 · 已验证';
    const labels = {
      planned_encode:'待处理 · 套用 LUT', planned_copy:'待处理 · 原样复制',
      copied_nonlog:'已复制 · 普通色彩', copied_hdr:'已复制 · HDR', copied_needs_review:'已复制 · 待确认',
      encoded:'已还原', skipped_existing:'已跳过', failed:'失败', cancelled:'已取消',
      running:'正在处理', started:'正在处理', pending:'等待处理', done:'已完成'
    };
    return labels[status] || text(val(item, 'status', 'Status'), '待处理');
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
    if (/no LUT configured/i.test(reason)) return /look=vivid/i.test(reason) ? '无对应鲜艳 LUT' : '无对应标准 LUT';
    if (/vivid|鲜艳/i.test(reason) && /missing|not available|unavailable|缺少|没有|不可用/i.test(reason)) return '无对应 Vivid LUT';
    return '未使用 LUT';
  }
  function runLutName(item) {
    const name = lutDisplayName(item);
    const status = text(val(item, 'status', 'Status')).toLowerCase();
    if (status === 'encoded') return `已应用：${name || 'LUT 信息缺失'}`;
    if (status === 'skipped_existing') {
      if (val(item, 'output_verified', 'OutputVerified')) return name ? `已验证已有结果：${name}` : '已验证已有结果：未使用 LUT';
      return name ? `未验证 · 候选：${name}` : '已有输出 · LUT 未验证';
    }
    if (name) return `未应用 · 候选：${name}`;
    return '未使用 LUT';
  }
  function previewLutName(item) {
    const name = lutDisplayName(item);
    const action = text(val(item, 'action', 'Action')).toLowerCase();
    if ((action === 'encode' || text(val(item, 'status', 'Status')).toLowerCase() === 'planned_encode') && name) return `将使用：${name}`;
    if (name) return `未应用 · 候选：${name}`;
    return lutName(item);
  }
  function reasonText(item, preview = false) {
    const reason = text(val(item, 'reason', 'Reason'));
    if (!reason) return '—';
    const waiting = preview || ['pending', 'running', 'planned_copy', 'planned_encode'].includes(text(val(item, 'status', 'Status')).toLowerCase());
    const reviewOutcome = waiting ? '计划原样复制并标记待确认。' : '已原样复制并标记待确认。';
    if (/VideoToolbox failed; x265 fallback succeeded/i.test(reason)) return '硬件编码失败，已自动改用 x265 完成还原；详细原因见日志与报告。';
    if (/output exists; source and LUT\/look match the previously verified result/i.test(reason)) return '源片、LUT 配置和已有输出的哈希均通过核验，沿用已有结果。';
    if (/output exists; preserved because no matching prior report/i.test(reason)) return '已有输出缺少可核验的历史记录，已保留并标记待确认。';
    if (/output exists; preserved because source or LUT\/look configuration differs/i.test(reason)) return '已有输出与当前源片或 LUT 配置不同，已保留并标记待确认。';
    if (/output exists; preserved because its contents differ/i.test(reason)) return '已有输出内容与历史校验不一致，已保留并标记待确认。';
    if (/output exists; preserved because it could not be verified/i.test(reason)) return '已有输出无法完成核验，已保留并标记待确认。';
    if (/exact DJI gamma metadata, camera evidence, and matching LUT/i.test(reason)) return '拍摄模式、相机与对应 LUT 均已匹配。';
    if (/missing exact .*ColorGammaSxS/i.test(reason)) return `缺少明确的拍摄模式元数据；${reviewOutcome}`;
    if (/explicit Normal\/Rec\.709 allowlist/i.test(reason)) return '元数据标记为普通色彩，无需套用 LUT。';
    if (/explicitly identifies HDR/i.test(reason)) return '元数据标记为 HDR，无需套用本次 LUT。';
    if (/unsupported gamma tag/i.test(reason)) return `拍摄模式暂不支持或无法确认；${reviewOutcome}`;
    if (/conflicting .*ColorGammaSxS values/i.test(reason)) return `视频内的拍摄模式标记存在冲突；${reviewOutcome}`;
    if (/camera model and encoder metadata conflict/i.test(reason)) return `相机型号与编码器信息不一致；${reviewOutcome}`;
    if (/camera identity is unknown|camera model and encoder metadata are missing/i.test(reason)) return `无法从元数据确认相机型号；${reviewOutcome}`;
    if (/no LUT configured for camera=([^\s;]+) profile=([^\s;]+) look=([^\s;]+)/i.test(reason)) {
      const match = reason.match(/no LUT configured for camera=([^\s;]+) profile=([^\s;]+) look=([^\s;]+)/i);
      return `没有相机 ${cameraLabel(match[1])}、${profileLabel(match[2])} 的${match[3] === 'vivid' ? '鲜艳' : '标准'} LUT；${reviewOutcome}`;
    }
    if (/matching LUT is unavailable or invalid/i.test(reason)) return `对应 LUT 缺失或校验失败；${reviewOutcome}`;
    if (/ffprobe could not classify/i.test(reason)) return `无法读取视频元数据；${reviewOutcome}`;
    if (/color_(range|space).*copied for review/i.test(reason)) return `视频色彩范围或矩阵信息不完整；${reviewOutcome}`;
    return reason;
  }
  function detailButton(item, preview, index) {
    const source = preview ? 'preview' : 'progress';
    const fileName = baseName(val(item, 'input', 'Input'));
    return `<button class="row-detail-button" type="button" data-detail-source="${source}" data-detail-index="${index}" aria-haspopup="dialog" aria-label="查看 ${esc(fileName)} 的详细信息">详情</button>`;
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
      return `<tr><td>${file}</td><td>${modeCell}</td><td>${esc(camera)}</td><td><span class="lut-name">${esc(previewLutName(item))}</span></td><td>${esc(actionLabel(item, true))}</td><td title="${esc(rawReason || reason)}"><div class="row-detail-line"><span class="row-summary-reason">${esc(reason)}</span>${detailButton(item, true, index)}</div></td></tr>`;
    }
    const progressReason = text(val(item, 'error', 'Error'), reason);
    return `<tr><td>${file}</td><td>${modeCell}</td><td>${esc(camera)}</td><td><span class="lut-name">${esc(runLutName(item))}</span></td><td><span class="status-tag ${statusClass(item)}">${esc(statusLabel(item))}</span></td><td class="progress-cell"><progress class="mini-progress" max="100" value="${percent}" aria-label="${esc(baseName(input))}进度"></progress>${percent ? `${Math.round(percent)}%` : '—'}</td><td title="${esc(rawReason || progressReason)}"><div class="row-detail-line"><span class="row-summary-reason">${esc(progressReason)}</span>${detailButton(item, false, index)}</div></td></tr>`;
  }
  function detailValue(value) {
    if (Array.isArray(value)) return value.map((entry) => text(entry)).join('、');
    if (value && typeof value === 'object') return JSON.stringify(value, null, 2);
    return text(value);
  }
  function showItemDetails(item, preview, opener) {
    if (!item) return;
    const input = text(val(item, 'input', 'Input'));
    const rawReason = text(val(item, 'reason', 'Reason'));
    const reason = reasonText(item, preview);
    const details = [
      ['文件', input],
      ['相机', cameraLabel(val(item, 'camera', 'Camera'))],
      ['拍摄模式', modeLabel(item)],
      ['源 Gamma', val(item, 'source_gamma', 'SourceGamma', 'gamma', 'Gamma')],
      ['识别 Profile', val(item, 'profile', 'Profile')],
      [preview ? '计划操作' : '处理状态', preview ? actionLabel(item, true) : statusLabel(item)],
      [preview ? '计划 LUT' : 'LUT 结果 / 候选', preview ? previewLutName(item) : runLutName(item)],
      ['LUT 文件', val(item, 'lut_file', 'LUTFile')],
      ['LUT 版本', val(item, 'lut_version', 'LUTVersion')],
      ['LUT SHA-256', val(item, 'lut_sha256', 'LUTSHA256')],
      ['编码器', val(item, 'encoder', 'Encoder')],
      ['说明', reason],
      ['原始说明', rawReason && rawReason !== reason ? rawReason : undefined],
      ['错误', val(item, 'error', 'Error')],
      ['结果文件', val(item, 'output', 'Output', 'output_path', 'OutputPath')],
      ['已有结果核验', val(item, 'output_verified', 'OutputVerified') === true ? '已验证' : undefined],
      ['输入 SHA-256', val(item, 'input_sha256', 'InputSHA256')],
      ['结果 SHA-256', val(item, 'output_sha256', 'OutputSHA256')],
      ['源视频元数据', val(item, 'source_metadata', 'SourceMetadata')],
      ['当前进度', val(item, 'percent', 'Percent') === undefined ? undefined : `${Math.round(Number(val(item, 'percent', 'Percent')) || 0)}%`]
    ].filter(([, value]) => value !== undefined && value !== '');
    $('file-detail-title').textContent = baseName(input) || '视频详情';
    $('file-detail-content').innerHTML = `<dl>${details.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(detailValue(value))}</dd>`).join('')}</dl>`;
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
    $(`${prefix}-page-status`).textContent = `第 ${page + 1} / ${totalPages} 页 · ${items.length} 个视频`;
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
  function renderPlan(plan) {
    const candidateItems = val(plan, 'items', 'Items');
    const items = Array.isArray(candidateItems) ? candidateItems : [];
    const input = text(val(plan, 'input_root', 'inputRoot', 'InputRoot'), settings().input);
    const output = text(val(plan, 'output_root', 'outputRoot', 'OutputRoot'), finalOutputDestination());
    const look = text(val(plan, 'look', 'Look'), settings().look);
    const recursive = Boolean(val(plan, 'recursive', 'Recursive') ?? settings().recursive);
    const restoreCount = items.filter(willEncode).length;
    const copyCount = Math.max(0, items.length - restoreCount);
    const reviewCount = items.filter((item) => !willEncode(item) && needsReview(item)).length;
    $('run-settings').innerHTML = `<span class="setting-chip" title="原片：${esc(input)}">原片：${esc(input)}</span><span class="setting-chip" title="最终保存位置：${esc(output)}">最终保存位置：${esc(output)}</span><span class="setting-chip">风格：${look === 'vivid' ? '鲜艳' : '标准'}</span><span class="setting-chip">子目录：${recursive ? '包含' : '不包含'}</span>`;
    $('preview-count').textContent = `${items.length} 个视频`;
    $('preview-restore-count').textContent = restoreCount;
    $('preview-copy-count').textContent = copyCount;
    $('preview-review-count').textContent = reviewCount;
    previewItems = items;
    previewPage = 0;
    previewPageAvailable = true;
    renderPreviewPage();
    $('preview-stale').classList.add('hidden');
    $('preview-section').classList.remove('hidden');
    hasPreview = items.length > 0;
    previewSnapshot = JSON.stringify(settings());
    if (!hasPreview) showMessage('没有找到可处理的视频；请检查路径或扫描选项。');
    setGuidedStep('preview');
    syncControls();
    if (interfaceMode === 'classic') $('preview-section').scrollIntoView({behavior:'smooth', block:'start'});
  }

  function summaryCard(label, value, cls = '') {
    return `<div class="summary-card ${cls}"><span>${esc(label)}</span><b>${Number(value) || 0}</b></div>`;
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
    $('progress-title').textContent = running ? '正在还原' : finished ? '批次已结束' : '处理状态';
    const stateBadge = $('run-state');
    stateBadge.className = `state-badge ${running ? 'running' : cancelled ? 'cancelled' : finished ? 'complete' : 'running'}`;
    stateBadge.innerHTML = `<i></i> ${running ? '正在处理' : cancelled ? '已取消' : finished ? '已结束' : '准备中'}`;
    $('progress-caption').textContent = text(val(state, 'current_file', 'currentFile', 'CurrentFile'), running ? '正在准备任务…' : finished ? '处理已结束' : '等待处理');
    $('progress-numbers').textContent = `${completed} / ${total}`;
    $('progress-fill').value = Math.max(0, Math.min(100, currentPercent));
    $('summary-grid').innerHTML = [
      summaryCard('套用 LUT', val(summary,'encoded','Encoded')),
      summaryCard('原样复制', val(summary,'copied','Copied')),
      summaryCard('待确认', val(summary,'needs_review','needsReview','NeedsReview'), 'review'),
      summaryCard('已跳过', val(summary,'skipped','Skipped')),
      summaryCard('失败', val(summary,'failed','Failed'), 'failed')
    ].join('');
    renderProgressPage();
    const logs = val(state, 'logs', 'Logs') || [];
    $('log-list').innerHTML = logs.map((entry) => `<div class="log-entry">${esc(typeof entry === 'string' ? entry : text(val(entry,'message','Message')))}</div>`).join('');
    $('cancel-button').disabled = !running || !connected;
    if (terminal) {
      $('complete-actions').classList.remove('hidden');
      const encodedCount = Number(val(summary,'encoded','Encoded')) || 0;
      const copiedCount = Number(val(summary,'copied','Copied')) || 0;
      const reviewCount = Number(val(summary,'needs_review','needsReview','NeedsReview')) || 0;
      const failedCount = Number(val(summary,'failed','Failed')) || 0;
      const counts = `套用 LUT ${encodedCount} 个，复制 ${copiedCount} 个，待确认 ${reviewCount} 个，失败 ${failedCount} 个。`;
      const ending = cancelled ? '任务已取消。' : failedCount ? '批次结束，部分文件失败。' : reviewCount ? '批次结束，仍有文件待确认。' : '批次处理完成。';
      const completeMessage = text(stateError, `${ending}${counts}`);
      $('complete-message').textContent = completeMessage;
      if (!shuttingDown && activeOperation !== 'picker') showMessage(completeMessage);
      if (connected) $('footer-status').textContent = cancelled ? '任务已取消' : '处理已结束';
    } else {
      $('complete-actions').classList.add('hidden');
      if (running && !shuttingDown && activeOperation !== 'picker') showMessage('正在还原，请在下方查看进度。');
      if (connected) $('footer-status').textContent = running ? '正在处理文件…' : '本机服务已就绪';
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
      if (!shuttingDown && activeOperation !== 'picker') showMessage(error.message);
      if (pollTimer && !processing) { clearInterval(pollTimer); pollTimer = null; }
    }
  }

  async function chooseFolder(target) {
    if (operationBusy() || batchLocked || !connected) return;
    const path = target === 'input' ? inputPath.value.trim() : outputPath.value.trim() || outputBase();
    beginOperation('picker');
    showMessage(target === 'input' ? '正在打开原片文件夹选择器…' : '正在打开结果目录选择器…');
    try {
      const result = await api('/api/select-folder', {method:'POST', body:JSON.stringify({target, path})});
      if (shuttingDown) return;
      if (Boolean(val(result, 'cancelled', 'Cancelled'))) {
        showMessage('已取消选择，原路径保持不变。');
        return;
      }
      const chosen = text(val(result, 'path', 'Path')).trim();
      if (!chosen) throw new Error('文件夹选择器没有返回目录路径。');
      const currentPath = target === 'input' ? inputPath.value.trim() : outputPath.value.trim() || outputBase();
      if (sameDirectory(chosen, currentPath)) {
        showMessage(hasPreview ? '路径未改变，现有预览仍有效。' : '路径未改变；需要处理时请重新扫描并预览。');
        return;
      }
      if (target === 'input') inputPath.value = chosen;
      else outputPath.value = chosen;
      invalidatePreview();
      showMessage('文件夹已更新，请重新扫描并预览。');
    } catch (error) {
      if (!shuttingDown) { showMessage(error.message); toast(error.message); }
    } finally {
      endOperation('picker');
    }
  }

  async function reconnect() {
    if (operationBusy() || (!isDesktop && !token)) return;
    beginOperation('reconnect');
    showMessage('正在重新连接本机服务…');
    try {
      const boot = await api('/api/bootstrap');
      if (shuttingDown) return;
      renderBootstrapResources(boot);
      if (stateRecoveryEnabled) await refreshState({recover:true});
      if (connected && !shuttingDown) {
        $('footer-status').textContent = processing ? '正在处理文件…' : '本机服务已就绪';
        if (!batchLocked) showMessage('已重新连接，可以继续操作。');
      }
    } catch (error) {
      if (!shuttingDown) { showMessage(error.message); toast(error.message); }
    } finally {
      endOperation('reconnect');
    }
  }

  async function scanPreview() {
    if (operationBusy() || batchLocked || !connected) return;
    const request = settings();
    if (!request.input) { showMessage('请填写原片文件夹路径。'); inputPath.focus(); return; }
    stateRecoveryEnabled = false;
    hasPreview = false;
    previewSnapshot = '';
    previewItems = [];
    previewPage = 0;
    previewPageAvailable = false;
    renderPreviewPage();
    $('preview-stale').classList.add('hidden');
    $('preview-section').classList.add('hidden');
    setGuidedStep('settings');
    beginOperation('preview');
    showMessage('正在扫描和读取视频元数据…');
    try {
      const plan = await api('/api/preview', {method:'POST', body:JSON.stringify(request)});
      if (shuttingDown) return;
      renderPlan(val(plan,'plan','Plan') || plan);
      showMessage(hasPreview ? '预览已就绪，请确认每个文件的处理方式。' : '没有找到可处理的视频；请检查路径或扫描选项。');
    } catch (error) {
      if (!shuttingDown) { showMessage(error.message); toast(error.message); }
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
    showMessage('正在启动还原任务…');
    try {
      const state = await api('/api/run', {method:'POST', body:JSON.stringify(settings())});
      if (shuttingDown) return;
      renderState(state);
      if (processing) ensureStatePolling();
      if (interfaceMode === 'classic') $('progress-section').scrollIntoView({behavior:'smooth', block:'start'});
    } catch (error) {
      if (!shuttingDown && !processing && !batchLocked) setGuidedStep('preview');
      if (!shuttingDown) { showMessage(error.message); toast(error.message); }
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
    showMessage('新批次已开始；请先扫描并预览，再开始还原。');
    updateGuidedPage();
    syncControls();
    window.scrollTo({top:0, behavior:'smooth'});
  });
  $('cancel-button').addEventListener('click', async () => {
    if (!processing || cancelPending) return;
    cancelPending = true;
    syncControls();
    try { await api('/api/cancel', {method:'POST', body:'{}'}); toast('已发送取消请求，正在安全停止当前文件…'); }
    catch (error) { toast(error.message); }
    finally { cancelPending = false; syncControls(); }
  });
  $('open-output-button').addEventListener('click', async () => {
    try { await api('/api/open-output', {method:'POST', body:'{}'}); toast('已打开结果文件夹。'); }
    catch (error) { toast(error.message); }
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
    showMessage('正在导出处理报告…');
    try {
      const result = await api('/api/export-report', {method:'POST', body:'{}'});
      if (shuttingDown) return;
      if (Boolean(val(result, 'cancelled', 'Cancelled'))) {
        showMessage('已取消导出处理报告。');
        toast('已取消导出处理报告。');
        return;
      }
      const path = text(val(result, 'path', 'Path')).trim();
      const saved = path ? `处理报告已保存：${path}` : '处理报告已保存。';
      showMessage(saved);
      toast(saved);
    } catch (error) {
      if (!shuttingDown) { showMessage(error.message); toast(error.message); }
    } finally {
      exportPending = false;
      endOperation('export-report');
    }
  });
  const closeApplication = async () => {
    if (shuttingDown || exportPending) return;
    shuttingDown = true;
    activeOperation = 'shutdown';
    showMessage('正在关闭应用…');
    syncControls();
    try { await api('/api/shutdown', {method:'POST', body:'{}'}); }
    catch (error) {
      if (isDesktop) {
        shuttingDown = false;
        activeOperation = '';
        showMessage(error.message);
        toast(error.message);
        syncControls();
        return;
      }
      /* Server may close the connection immediately after accepting shutdown. */
    }
    if (isDesktop) {
      $('footer-status').textContent = '桌面应用正在关闭…';
      toast('应用正在关闭。');
      return;
    }
    try { sessionStorage.removeItem('dji-lut-access'); } catch (_) { /* No persistent data to clear. */ }
    $('footer-status').textContent = '应用已关闭，可以关闭此浏览器标签页。';
    toast('应用已关闭。');
    setTimeout(() => window.close(), 700);
  };
  if (isDesktop) {
    $('app-mode-hint').textContent = '桌面版 · 直接处理本机文件，原片保持不变';
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
  $('lut-open-button').addEventListener('click', (event) => openAppDialog(lutDialog, event.currentTarget));
  $('lut-dialog-close').addEventListener('click', () => lutDialog.close());
  $('file-detail-close').addEventListener('click', () => fileDetailDialog.close());
  for (const dialog of [lutDialog, fileDetailDialog]) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }
  updateGuidedPage();

  (async () => {
    syncControls();
    updateOutputDestination();
    if (!isDesktop && !token) {
      $('connection').classList.add('disconnected');
      $('connection').innerHTML = '<i></i> 缺少访问凭据';
      $('footer-status').textContent = '请从应用自动打开的页面启动';
      showMessage('缺少本机访问凭据。请关闭本页并重新启动应用。');
      activeOperation = '';
      syncControls();
      $('header-close-button').disabled = true;
      return;
    }
    try {
      const boot = await api('/api/bootstrap');
      const defaults = val(boot,'defaults','Defaults') || boot;
      inputPath.value = text(val(defaults,'input','input_root','Input'), '');
      outputPath.value = text(val(defaults,'output','output_root','Output'), '');
      const look = text(val(defaults,'look','Look'), 'standard');
      const choice = document.querySelector(`input[name="look"][value="${look === 'vivid' ? 'vivid' : 'standard'}"]`);
      if (choice) choice.checked = true;
      $('recursive').checked = Boolean(val(defaults,'recursive','Recursive'));
      renderBootstrapResources(boot);
      updateOutputDestination();
      $('footer-status').textContent = isDesktop ? '桌面应用已就绪' : '本机服务已就绪';
      await refreshState({recover:true});
    } catch (error) {
      if (connected) $('footer-status').textContent = isDesktop ? '桌面应用已就绪，但初始化失败' : '本机服务已连接，但初始化失败';
      showMessage(error.message);
      toast(error.message);
    } finally {
      endOperation('bootstrap');
    }
  })();
})();
