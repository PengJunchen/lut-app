(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const fragmentToken = new URLSearchParams(location.hash.replace(/^#/, '')).get('token') || '';
  let token = fragmentToken;
  try {
    if (fragmentToken) sessionStorage.setItem('dji-lut-access', fragmentToken);
    else token = sessionStorage.getItem('dji-lut-access') || '';
  } catch (_) { /* Fragment access still works when session storage is unavailable. */ }
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
  let batchLocked = false;
  let shuttingDown = false;
  let batchVersion = 0;
  let stateRecoveryEnabled = true;
  let pollTimer = null;
  let toastTimer = null;

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
    node.innerHTML = `<i></i> ${ready ? '本机服务已连接' : '连接中断'}`;
    reconnectButton.classList.toggle('hidden', ready || !token);
    if (!ready) $('footer-status').textContent = '本机服务连接中断，请重新连接后继续';
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
    $('new-batch-button').disabled = busy;
    $('header-close-button').disabled = shuttingDown;
    $('close-button').disabled = shuttingDown;
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
  const invalidatePreview = () => {
    updateOutputDestination();
    if (previewSnapshot && JSON.stringify(settings()) !== previewSnapshot) {
      hasPreview = false;
      previewSnapshot = '';
      $('preview-stale').classList.remove('hidden');
      showMessage('设置已改变，旧预览已失效；请重新扫描并预览。');
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

  function listCatalog(catalog) {
    const node = $('catalog-list');
    if (!Array.isArray(catalog) || catalog.length === 0) {
      node.textContent = '没有读取到 LUT 清单；需确认应用包内容。';
      return;
    }
    const keys = new Set(catalog.map((item) => `${text(val(item,'camera'))}|${text(val(item,'profile'))}|${text(val(item,'look'))}`));
    const cameras = [...new Set(catalog.map((item) => text(val(item,'camera'), '相机')))].sort();
    const supported = [];
    for (const camera of cameras) {
      const profiles = [...new Set(catalog.filter((item) => text(val(item,'camera')) === camera).map((item) => text(val(item,'profile'))))].sort();
      for (const profile of profiles) {
        const label = `${cameraLabel(camera)} · ${profileLabel(profile)}`;
        for (const look of ['standard', 'vivid']) {
          const exists = keys.has(`${camera}|${profile}|${look}`);
          supported.push(`<span class="catalog-pill${exists ? '' : ' unavailable'}">${esc(label)} · ${look === 'standard' ? `标准${exists ? '' : '不可用'}` : `鲜艳${exists ? '' : '不可用'}`}</span>`);
        }
      }
    }
    node.innerHTML = supported.join('');
  }

  function profileLabel(profile) {
    const key = text(profile).toLowerCase().replace(/[-_ ]/g, '');
    return key === 'dlog2' ? 'D-Log2' : key === 'dlogm' ? 'D-Log M' : key === 'dlog' ? 'D-Log' : text(profile, '未知模式');
  }
  function cameraLabel(camera) {
    const key = text(camera).toLowerCase().replace(/[-_ ]/g, '');
    const labels = {
      pocket4p:'DJI Osmo Pocket 4P', pocket3:'DJI Osmo Pocket 3', action4:'DJI Osmo Action 4',
      action5pro:'DJI Osmo Action 5 Pro', action6:'DJI Osmo Action 6', mavic3:'DJI Mavic 3',
      mavic2pro:'DJI Mavic 2 Pro', air2s:'DJI Air 2S', air3:'DJI Air 3', air3s:'DJI Air 3S', unknown:'未识别'
    };
    return labels[key] || text(camera, '未识别');
  }
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
  function lutName(item) {
    const name = text(val(item, 'lut_file', 'lutFile', 'LUTFile'));
    if (name) return baseName(name);
    const reason = text(val(item, 'reason', 'Reason'));
    if (/no LUT configured/i.test(reason)) return /look=vivid/i.test(reason) ? '无对应鲜艳 LUT' : '无对应标准 LUT';
    if (/vivid|鲜艳/i.test(reason) && /missing|not available|unavailable|缺少|没有|不可用/i.test(reason)) return '无对应 Vivid LUT';
    return '未使用 LUT';
  }
  function runLutName(item) {
    const name = text(val(item, 'lut_file', 'lutFile', 'LUTFile'));
    const status = text(val(item, 'status', 'Status')).toLowerCase();
    if (status === 'encoded') return `已应用：${name ? baseName(name) : 'LUT 信息缺失'}`;
    if (status === 'skipped_existing') {
      if (val(item, 'output_verified', 'OutputVerified')) return name ? `已验证已有结果：${baseName(name)}` : '已验证已有结果：未使用 LUT';
      return name ? `未验证 · 候选：${baseName(name)}` : '已有输出 · LUT 未验证';
    }
    if (name) return `未应用 · 候选：${baseName(name)}`;
    return '未使用 LUT';
  }
  function previewLutName(item) {
    const name = text(val(item, 'lut_file', 'lutFile', 'LUTFile'));
    const action = text(val(item, 'action', 'Action')).toLowerCase();
    if ((action === 'encode' || text(val(item, 'status', 'Status')).toLowerCase() === 'planned_encode') && name) return `将使用：${baseName(name)}`;
    if (name) return `未应用 · 候选：${baseName(name)}`;
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
  function itemRow(item, preview) {
    const input = text(val(item, 'input', 'Input'));
    const mode = modeLabel(item);
    const camera = cameraLabel(val(item, 'camera', 'Camera'));
    const rawReason = text(val(item, 'reason', 'Reason'));
    const reason = reasonText(item, preview);
    const percent = Math.max(0, Math.min(100, Number(val(item, 'percent', 'Percent')) || 0));
    const file = `<span class="file-name">${esc(baseName(input))}</span><span class="path-sub">${esc(input)}</span>`;
    const modeCell = `<span class="mode-tag ${modeClass(item)}">${esc(mode)}</span>`;
    if (preview) {
      return `<tr><td>${file}</td><td>${modeCell}</td><td>${esc(camera)}</td><td><span class="lut-name">${esc(previewLutName(item))}</span></td><td>${esc(actionLabel(item, true))}</td><td title="${esc(rawReason)}">${esc(reason)}</td></tr>`;
    }
    return `<tr><td>${file}</td><td>${modeCell}</td><td>${esc(camera)}</td><td><span class="lut-name">${esc(runLutName(item))}</span></td><td><span class="status-tag ${statusClass(item)}">${esc(statusLabel(item))}</span></td><td class="progress-cell"><progress class="mini-progress" max="100" value="${percent}" aria-label="${esc(baseName(input))}进度"></progress>${percent ? `${Math.round(percent)}%` : '—'}</td><td title="${esc(rawReason)}">${esc(text(val(item,'error','Error'), reason))}</td></tr>`;
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
  function renderPlan(plan) {
    const items = val(plan, 'items', 'Items') || [];
    const input = text(val(plan, 'input_root', 'inputRoot', 'InputRoot'), settings().input);
    const output = text(val(plan, 'output_root', 'outputRoot', 'OutputRoot'), finalOutputDestination());
    const look = text(val(plan, 'look', 'Look'), settings().look);
    const recursive = Boolean(val(plan, 'recursive', 'Recursive') ?? settings().recursive);
    const restoreCount = items.filter(willEncode).length;
    const copyCount = Math.max(0, items.length - restoreCount);
    const reviewCount = items.filter((item) => !willEncode(item) && needsReview(item)).length;
    $('run-settings').innerHTML = `<span class="setting-chip">原片：${esc(input)}</span><span class="setting-chip">最终保存位置：${esc(output)}</span><span class="setting-chip">风格：${look === 'vivid' ? '鲜艳' : '标准'}</span><span class="setting-chip">子目录：${recursive ? '包含' : '不包含'}</span>`;
    $('preview-count').textContent = `${items.length} 个视频`;
    $('preview-restore-count').textContent = restoreCount;
    $('preview-copy-count').textContent = copyCount;
    $('preview-review-count').textContent = reviewCount;
    $('preview-rows').innerHTML = items.map((item) => itemRow(item, true)).join('');
    $('preview-empty').classList.toggle('hidden', items.length > 0);
    $('preview-rows').parentElement.classList.toggle('hidden', items.length === 0);
    $('preview-stale').classList.add('hidden');
    $('preview-section').classList.remove('hidden');
    hasPreview = items.length > 0;
    previewSnapshot = JSON.stringify(settings());
    if (!hasPreview) showMessage('没有找到可处理的视频；请检查路径或扫描选项。');
    syncControls();
    $('preview-section').scrollIntoView({behavior:'smooth', block:'start'});
  }

  function summaryCard(label, value, cls = '') {
    return `<div class="summary-card ${cls}"><span>${esc(label)}</span><b>${Number(value) || 0}</b></div>`;
  }
  function renderState(state) {
    currentState = state;
    const running = Boolean(val(state, 'running', 'Running'));
    const finished = Boolean(val(state, 'finished', 'done', 'Finished', 'Done'));
    const cancelled = Boolean(val(state, 'cancelled', 'Cancelled'));
    processing = running;
    batchLocked = !running && (finished || cancelled || Boolean(val(state,'error','Error')));
    const summary = val(state, 'summary', 'Summary') || {};
    const items = val(state, 'items', 'Items') || [];
    const completed = Number(val(state, 'completed', 'Completed')) || 0;
    const total = Number(val(state, 'total', 'Total')) || items.length;
    const currentPercent = Number(val(state, 'percent', 'Percent', 'overall_percent', 'overallPercent')) || (total ? completed / total * 100 : 0);
    $('progress-section').classList.remove('hidden');
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
    $('progress-rows').innerHTML = items.map((item) => itemRow(item, false)).join('');
    if (!items.length && val(state, 'plan', 'Plan')) $('progress-rows').innerHTML = (val(val(state,'plan','Plan'),'items','Items') || []).map((item) => itemRow(item,false)).join('');
    const logs = val(state, 'logs', 'Logs') || [];
    $('log-list').innerHTML = logs.map((entry) => `<div class="log-entry">${esc(typeof entry === 'string' ? entry : text(val(entry,'message','Message')))}</div>`).join('');
    $('cancel-button').disabled = !running || !connected;
    if (finished || cancelled || (!running && val(state,'error','Error'))) {
      $('complete-actions').classList.remove('hidden');
      const encodedCount = Number(val(summary,'encoded','Encoded')) || 0;
      const copiedCount = Number(val(summary,'copied','Copied')) || 0;
      const reviewCount = Number(val(summary,'needs_review','needsReview','NeedsReview')) || 0;
      const failedCount = Number(val(summary,'failed','Failed')) || 0;
      const counts = `套用 LUT ${encodedCount} 个，复制 ${copiedCount} 个，待确认 ${reviewCount} 个，失败 ${failedCount} 个。`;
      const ending = cancelled ? '任务已取消。' : failedCount ? '批次结束，部分文件失败。' : reviewCount ? '批次结束，仍有文件待确认。' : '批次处理完成。';
      const completeMessage = text(val(state,'error','Error'), `${ending}${counts}`);
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
      if (!running && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
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
    if (operationBusy() || !token) return;
    beginOperation('reconnect');
    showMessage('正在重新连接本机服务…');
    try {
      const boot = await api('/api/bootstrap');
      if (shuttingDown) return;
      listCatalog(val(boot,'catalog','Catalog') || []);
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
    $('preview-stale').classList.add('hidden');
    $('preview-section').classList.add('hidden');
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
    stateRecoveryEnabled = true;
    showMessage('正在启动还原任务…');
    try {
      const state = await api('/api/run', {method:'POST', body:JSON.stringify(settings())});
      if (shuttingDown) return;
      $('progress-section').classList.remove('hidden');
      renderState(state);
      if (!pollTimer && processing) pollTimer = setInterval(refreshState, 900);
      $('progress-section').scrollIntoView({behavior:'smooth', block:'start'});
    } catch (error) {
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
    $('preview-section').classList.add('hidden');
    $('progress-section').classList.add('hidden');
    $('complete-actions').classList.add('hidden');
    $('preview-stale').classList.add('hidden');
    $('preview-rows').innerHTML = '';
    $('progress-rows').innerHTML = '';
    $('summary-grid').innerHTML = '';
    $('log-list').innerHTML = '';
    showMessage('新批次已开始；请先扫描并预览，再开始还原。');
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
  $('report-button').addEventListener('click', () => {
    const report = val(currentState, 'report', 'Report') || currentState;
    const blob = new Blob([JSON.stringify(report, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'lut-app-report.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const closeApplication = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    activeOperation = 'shutdown';
    showMessage('正在关闭应用…');
    syncControls();
    try { await api('/api/shutdown', {method:'POST', body:'{}'}); }
    catch (_) { /* Server may close the connection immediately after accepting shutdown. */ }
    try { sessionStorage.removeItem('dji-lut-access'); } catch (_) { /* No persistent data to clear. */ }
    $('footer-status').textContent = '应用已关闭，可以关闭此浏览器标签页。';
    toast('应用已关闭。');
    setTimeout(() => window.close(), 700);
  };
  $('close-button').addEventListener('click', closeApplication);
  $('header-close-button').addEventListener('click', closeApplication);

  (async () => {
    syncControls();
    updateOutputDestination();
    if (!token) {
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
      listCatalog(val(boot,'catalog','Catalog') || []);
      updateOutputDestination();
      $('footer-status').textContent = '本机服务已就绪';
      await refreshState({recover:true});
    } catch (error) {
      if (connected) $('footer-status').textContent = '本机服务已连接，但初始化失败';
      showMessage(error.message);
      toast(error.message);
    } finally {
      endOperation('bootstrap');
    }
  })();
})();
