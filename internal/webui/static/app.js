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
  let hasPreview = false;
  let previewSnapshot = '';
  let currentState = null;
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
    const response = await fetch(route, {...options, headers, cache:'no-store', credentials:'same-origin'});
    const body = await response.text();
    let payload = {};
    try { payload = body ? JSON.parse(body) : {}; } catch (_) { payload = {message: body}; }
    if (!response.ok) throw new Error(text(val(payload, 'error', 'message'), `请求失败 (${response.status})`));
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
  const setBusy = (busy) => {
    previewButton.disabled = busy;
    runButton.disabled = busy || !hasPreview;
    inputPath.disabled = busy;
    outputPath.disabled = busy;
    $('recursive').disabled = busy;
    document.querySelectorAll('input[name="look"]').forEach((node) => node.disabled = busy);
  };
  const invalidatePreview = () => {
    if (hasPreview && JSON.stringify(settings()) !== previewSnapshot) {
      hasPreview = false;
      runButton.disabled = true;
      showMessage('选项已改变，请重新扫描并预览。');
    }
  };
  inputPath.addEventListener('input', invalidatePreview);
  outputPath.addEventListener('input', invalidatePreview);
  $('recursive').addEventListener('change', invalidatePreview);
  document.querySelectorAll('input[name="look"]').forEach((node) => node.addEventListener('change', invalidatePreview));

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
  function renderPlan(plan) {
    const items = val(plan, 'items', 'Items') || [];
    const input = text(val(plan, 'input_root', 'inputRoot', 'InputRoot'), settings().input);
    const output = text(val(plan, 'output_root', 'outputRoot', 'OutputRoot'), settings().output || `${input}/Output`);
    const look = text(val(plan, 'look', 'Look'), settings().look);
    const recursive = Boolean(val(plan, 'recursive', 'Recursive') ?? settings().recursive);
    $('run-settings').innerHTML = `<span class="setting-chip">原片：${esc(input)}</span><span class="setting-chip">输出：${esc(output)}</span><span class="setting-chip">风格：${look === 'vivid' ? '鲜艳' : '标准'}</span><span class="setting-chip">子目录：${recursive ? '包含' : '不包含'}</span>`;
    $('preview-count').textContent = `${items.length} 个视频`;
    $('preview-rows').innerHTML = items.map((item) => itemRow(item, true)).join('');
    $('preview-empty').classList.toggle('hidden', items.length > 0);
    $('preview-rows').parentElement.classList.toggle('hidden', items.length === 0);
    $('preview-section').classList.remove('hidden');
    hasPreview = true;
    runButton.disabled = false;
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
    $('cancel-button').disabled = !running;
    setBusy(running);
    if (finished || cancelled || (!running && val(state,'error','Error'))) {
      $('complete-actions').classList.remove('hidden');
      const encodedCount = Number(val(summary,'encoded','Encoded')) || 0;
      const copiedCount = Number(val(summary,'copied','Copied')) || 0;
      const reviewCount = Number(val(summary,'needs_review','needsReview','NeedsReview')) || 0;
      const failedCount = Number(val(summary,'failed','Failed')) || 0;
      const counts = `套用 LUT ${encodedCount} 个，复制 ${copiedCount} 个，待确认 ${reviewCount} 个，失败 ${failedCount} 个。`;
      const ending = cancelled ? '任务已取消。' : failedCount ? '批次结束，部分文件失败。' : reviewCount ? '批次结束，仍有文件待确认。' : '批次处理完成。';
      $('complete-message').textContent = text(val(state,'error','Error'), `${ending}${counts}`);
      $('footer-status').textContent = cancelled ? '任务已取消' : '处理已结束';
    } else {
      $('complete-actions').classList.add('hidden');
      $('footer-status').textContent = running ? '正在处理文件…' : '本机服务已就绪';
    }
  }
  async function refreshState() {
    try {
      const state = await api('/api/state');
      if (!val(state, 'running', 'Running') && !val(state, 'finished', 'done', 'Finished', 'Done') && !val(state, 'input_root', 'inputRoot', 'InputRoot')) return;
      renderState(state);
      if (!val(state, 'running', 'Running') && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    } catch (error) {
      $('footer-status').textContent = '本机服务连接中断';
      $('connection').classList.add('disconnected');
      $('connection').innerHTML = '<i></i> 连接中断';
    }
  }

  previewButton.addEventListener('click', async () => {
    const request = settings();
    if (!request.input) { showMessage('请填写原片文件夹路径。'); inputPath.focus(); return; }
    showMessage('正在扫描和读取视频元数据…');
    setBusy(true);
    $('preview-section').classList.add('hidden');
    hasPreview = false;
    try {
      const plan = await api('/api/preview', {method:'POST', body:JSON.stringify(request)});
      renderPlan(val(plan,'plan','Plan') || plan);
      previewSnapshot = JSON.stringify(request);
      showMessage('预览已就绪，请确认每个文件的处理方式。');
    } catch (error) {
      showMessage(error.message);
      toast(error.message);
    } finally { setBusy(false); runButton.disabled = !hasPreview; }
  });

  runButton.addEventListener('click', async () => {
    if (!hasPreview) return;
    if (JSON.stringify(settings()) !== previewSnapshot) { invalidatePreview(); return; }
    setBusy(true);
    try {
      const state = await api('/api/run', {method:'POST', body:JSON.stringify(settings())});
      $('progress-section').classList.remove('hidden');
      renderState(state);
      if (!pollTimer) pollTimer = setInterval(refreshState, 900);
      $('progress-section').scrollIntoView({behavior:'smooth', block:'start'});
    } catch (error) { setBusy(false); toast(error.message); showMessage(error.message); }
  });
  $('cancel-button').addEventListener('click', async () => {
    $('cancel-button').disabled = true;
    try { await api('/api/cancel', {method:'POST', body:'{}'}); toast('已发送取消请求，正在安全停止当前文件…'); }
    catch (error) { toast(error.message); }
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
    $('close-button').disabled = true;
    $('header-close-button').disabled = true;
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
    if (!token) {
      $('connection').classList.add('disconnected');
      $('connection').innerHTML = '<i></i> 缺少访问凭据';
      $('footer-status').textContent = '请从应用自动打开的页面启动';
      showMessage('缺少本机访问凭据。请关闭本页并重新启动应用。');
      previewButton.disabled = true;
      runButton.disabled = true;
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
      $('footer-status').textContent = '本机服务已就绪';
      await refreshState();
    } catch (error) {
      $('footer-status').textContent = '本机服务连接失败';
      showMessage(error.message);
      toast(error.message);
    }
  })();
})();
