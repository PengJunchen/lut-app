'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const i18n = require('../../internal/webui/static/i18n.js');

const appSource = fs.readFileSync(path.join(__dirname, '../../internal/webui/static/app.js'), 'utf8');

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.textContent = '';
    this.innerHTML = '';
    this.title = '';
    this.open = false;
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.isConnected = true;
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = [];
    this.classList = new FakeClassList();
  }
  addEventListener(type, callback) {
    const list = this.listeners.get(type) || [];
    list.push(callback);
    this.listeners.set(type, list);
  }
  async dispatch(type, event = {}) {
    let result;
    for (const callback of this.listeners.get(type) || []) {
      result = callback({target: this, currentTarget: this, ...event});
    }
    await result;
    return result;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  querySelector() { return new FakeElement(); }
  focus() {}
  scrollIntoView() {}
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch('close'); }
  click() { return this.dispatch('click'); }
}

class FakeClassList {
  constructor() { this.classes = new Set(); }
  add(name) { this.classes.add(name); }
  remove(name) { this.classes.delete(name); }
  contains(name) { return this.classes.has(name); }
  toggle(name, force) {
    const shouldAdd = force === undefined ? !this.classes.has(name) : Boolean(force);
    if (shouldAdd) this.classes.add(name); else this.classes.delete(name);
    return shouldAdd;
  }
}

function makeHarness({desktop = true, language = 'zh-CN', failPreviewAt = 0, failLanguageSave = false, languageSaveResponse, runState} = {}) {
  const elements = new Map();
  const radios = ['standard', 'vivid'].map((value) => {
    const radio = new FakeElement(`look-${value}`);
    radio.value = value;
    radio.checked = value === 'standard';
    return radio;
  });
  const guidedSteps = ['settings', 'preview', 'processing'].map((value) => {
    const step = new FakeElement(`step-${value}`);
    step.dataset.guidedStep = value;
    return step;
  });
  const listeners = new Map();
  const document = {
    nodeType: 9,
    title: '',
    documentElement: new FakeElement('documentElement'),
    body: new FakeElement('body'),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement(id));
      return elements.get(id);
    },
    querySelector(selector) {
      if (selector === 'input[name="look"]:checked') return radios.find((radio) => radio.checked);
      const match = selector.match(/input\[name="look"\]\[value="(standard|vivid)"\]/);
      return match ? radios.find((radio) => radio.value === match[1]) : null;
    },
    querySelectorAll(selector) {
      if (selector === 'input[name="look"]') return radios;
      if (selector === '[data-guided-step]') return guidedSteps;
      if (selector === '*') return [...elements.values(), ...radios, ...guidedSteps, document.body, document.documentElement];
      return [];
    },
    addEventListener(type, callback) {
      const list = listeners.get(type) || [];
      list.push(callback);
      listeners.set(type, list);
    },
    createTreeWalker() { return {nextNode: () => null}; },
    createElement(tag) { return new FakeElement(tag); }
  };
  document.body.dataset = {};
  document.body.classList = new FakeClassList();
  const calls = [];
  let previewCount = 0;
  const failBootstrap = {value:false};
  const makePlan = () => ({
    input_root: '/input', output_root: '/output/Standard', look: 'standard', recursive: false,
    items: Array.from({length: 6}, (_, index) => ({
      input: `/input/clip-${index + 1}.mp4`, camera: 'Pocket 4 Pro', profile: 'd-log2',
      source_gamma: 'D-Log2', action: 'encode', status: 'planned_encode',
      reason: 'exact DJI gamma metadata, camera evidence, and matching LUT',
      lut_name: 'D-Log2 to Rec.709', lut_file: 'pocket4pro.cube', lut_version: '1.0',
      source_metadata: ['ColorGammaSxS=D-Log2']
    }))
  });
  const bridge = {
    async request(route, options = {}) {
      calls.push({route, method: options.method || 'GET', body: options.body});
      if (route === '/api/desktop-preferences') return {ok:true, status:200, payload:{language}};
      if (route === '/api/bootstrap' && failBootstrap.value) return {ok:false, status:500, payload:{error:'bootstrap unavailable'}};
      if (route === '/api/bootstrap') return {ok:true, status:200, payload:{
        defaults:{input:'/input', output:'', look:'standard', recursive:false},
        library:{assets:[]}, catalog:[], supported_video_extensions:['MP4']
      }};
      if (route === '/api/state') return {ok:true, status:200, payload:{running:false, finished:false}};
      if (route === '/api/preview') {
        previewCount += 1;
        if (previewCount === failPreviewAt) return {ok:false, status:400, payload:{error:'scan failed'}};
        return {ok:true, status:200, payload:{plan:makePlan()}};
      }
      if (route === '/api/run') return {ok:true, status:200, payload:runState || {
        running:true, finished:false, total:6, completed:0, percent:0, plan:makePlan(), items:makePlan().items
      }};
      if (route === '/api/desktop-language') {
        if (languageSaveResponse) return languageSaveResponse;
        if (failLanguageSave) return {ok:false, status:500, payload:{error:'语言设置暂时无法保存'}};
        return {ok:true, status:200, payload:{language:JSON.parse(options.body).language}};
      }
      return {ok:true, status:200, payload:{}};
    }
  };
  const browserFetch = async (route, options = {}) => {
    calls.push({route, method:options.method || 'GET', body:options.body});
    let status = 200;
    let payload = {};
    if (route === '/api/bootstrap' && failBootstrap.value) {
      status = 500;
      payload = {error:'bootstrap unavailable'};
    } else if (route === '/api/bootstrap') {
      payload = {defaults:{input:'/input', output:'', look:'standard', recursive:false}, library:{assets:[]}, catalog:[], supported_video_extensions:['MP4']};
    } else if (route === '/api/state') {
      payload = {running:false, finished:false};
    } else if (route === '/api/preview') {
      previewCount += 1;
      if (previewCount === failPreviewAt) {
        status = 400;
        payload = {error:'scan failed'};
      } else payload = {plan:makePlan()};
    } else if (route === '/api/run') {
      payload = runState || {running:true, finished:false, total:6, completed:0, percent:0, plan:makePlan(), items:makePlan().items};
    }
    return {status, ok:status >= 200 && status < 300, text:async () => JSON.stringify(payload)};
  };
  const location = {hash:desktop ? '' : '#token=test-token', pathname:'/', search:''};
  const sessionStorage = {getItem:() => null, setItem() {}};
  const window = {
    DJILUTI18n: i18n,
    ...(desktop ? {djiDesktop:bridge} : {}),
    localStorage:{getItem:() => null, setItem:() => {}},
    navigator:{language, languages:[language]},
    scrollX:0,
    scrollY:0,
    scrollTo(x, y) {
      if (typeof x === 'object') { this.scrollX = x.left || 0; this.scrollY = x.top || 0; }
      else { this.scrollX = x; this.scrollY = y; }
    },
    close() {}
  };
  const context = vm.createContext({
    window, document, location,
    sessionStorage,
    fetch:browserFetch,
    history:{replaceState() {}},
    URLSearchParams,
    Headers,
    setTimeout:() => 1,
    clearTimeout() {},
    setInterval:() => 1,
    clearInterval() {},
    setImmediate,
    console
  });
  vm.runInContext(appSource, context, {filename:'app.js'});

  const element = (id) => document.getElementById(id);
  const flush = async () => {
    for (let index = 0; index < 5; index++) await new Promise((resolve) => setImmediate(resolve));
  };
  const booted = flush();
  return {
    document, element, calls, window, listeners, flush, booted,
    async click(id) { await element(id).dispatch('click'); await flush(); },
    async setLanguage(language) {
      const select = element('language-select');
      select.value = language;
      await select.dispatch('change', {currentTarget:select});
      await flush();
    },
    async documentClick(target) {
      for (const callback of listeners.get('click') || []) await callback({target});
      await flush();
    },
    previewCount:() => calls.filter((call) => call.route === '/api/preview').length,
    runCount:() => calls.filter((call) => call.route === '/api/run').length,
    languageWriteCount:() => calls.filter((call) => call.route === '/api/desktop-language').length,
    setBootstrapFailure(value) { failBootstrap.value = value; }
  };
}

test('desktop and browser connection labels and preview status render and switch correctly in both locales', async () => {
  const labels = {
    'zh-CN': {
      desktopReady:'桌面服务已连接', desktopLost:'桌面服务已断开', desktopLostHint:'桌面应用无法连接处理服务，请点击“重新连接”后重试。',
      localReady:'本机服务已连接', localLost:'本机服务已断开', localLostHint:'无法连接本机服务，请点击“重新连接”后重试。',
      localFooter:'本机服务已就绪', previewReady:'扫描完成，预览已就绪，可以开始还原。'
    },
    en: {
      desktopReady:'Desktop service connected', desktopLost:'Desktop service disconnected', desktopLostHint:'The desktop app cannot reach the processing service. Click Reconnect to try again.',
      localReady:'Local service connected', localLost:'Local service disconnected', localLostHint:'The local service is unavailable. Click Reconnect to try again.',
      localFooter:'Local service ready', previewReady:'Scan complete. The preview is ready for restoration.'
    }
  };

  for (const desktop of [true, false]) {
    for (const language of ['zh-CN', 'en']) {
      const app = makeHarness({desktop, language});
      await app.booted;
      const readyLanguage = labels[language];
      const readyLabel = desktop ? readyLanguage.desktopReady : readyLanguage.localReady;
      const readyFooter = desktop ? readyLabel : readyLanguage.localFooter;
      assert.equal(app.element('connection').getAttribute('aria-label'), readyLabel);
      assert.equal(app.element('connection').innerHTML, `<i></i> ${readyLabel}`);
      assert.equal(app.element('footer-status').textContent, readyFooter);

      await app.click('preview-button');
      assert.equal(app.element('settings-message').textContent, readyLanguage.previewReady);

      const nextLanguage = language === 'en' ? 'zh-CN' : 'en';
      const next = labels[nextLanguage];
      await app.setLanguage(nextLanguage);
      const nextReadyLabel = desktop ? next.desktopReady : next.localReady;
      assert.equal(app.element('connection').getAttribute('aria-label'), nextReadyLabel);
      assert.equal(app.element('connection').innerHTML, `<i></i> ${nextReadyLabel}`);
      assert.equal(app.element('footer-status').textContent, desktop ? nextReadyLabel : next.localFooter);
      assert.equal(app.element('settings-message').textContent, next.previewReady);

      app.setBootstrapFailure(true);
      await app.click('reconnect-button');
      const lostLabel = desktop ? next.desktopLost : next.localLost;
      const lostHint = desktop ? next.desktopLostHint : next.localLostHint;
      assert.equal(app.element('connection').getAttribute('aria-label'), lostLabel);
      assert.equal(app.element('connection').innerHTML, `<i></i> ${lostLabel}`);
      assert.equal(app.element('footer-status').textContent, lostHint);
    }
  }
});

test('language switch preserves a preview page, settings page, pagination, and an open details dialog', async () => {
  const app = makeHarness();
  await app.booted;
  await app.click('preview-button');
  app.element('preview-page-next').scrollTop = 0;
  await app.click('preview-page-next');
  assert.match(app.element('preview-page-status').textContent, /2 \/ 2/);
  app.element('preview-table-wrap').scrollLeft = 31;
  app.window.scrollTo(0, 45);

  await app.click('guided-back-button');
  assert.equal(app.element('settings-section').classList.contains('hidden'), false);
  assert.equal(app.element('preview-section').classList.contains('hidden'), true);
  await app.setLanguage('en');
  assert.equal(app.element('settings-section').classList.contains('hidden'), false);
  assert.equal(app.element('preview-section').classList.contains('hidden'), true);
  assert.equal(app.element('input-path').value, '/input');
  assert.equal(app.element('preview-page-status').textContent, 'Page 2 / 2 · 6 videos');
  assert.equal(app.element('preview-table-wrap').scrollLeft, 31);
  assert.equal(app.window.scrollY, 45);
  assert.equal(app.previewCount(), 1);
  assert.equal(app.runCount(), 0);

  await app.click('guided-continue-preview-button');
  const detailButton = new FakeElement('detail-button');
  detailButton.dataset.detailSource = 'preview';
  detailButton.dataset.detailIndex = '5';
  await app.documentClick({closest:() => detailButton});
  assert.equal(app.element('file-detail-dialog').open, true);
  assert.match(app.element('file-detail-content').innerHTML, /File/);
  await app.setLanguage('zh-CN');
  assert.equal(app.element('file-detail-dialog').open, true);
  assert.match(app.element('file-detail-content').innerHTML, /文件/);
  assert.equal(app.previewCount(), 1);
  assert.equal(app.runCount(), 0);
});

test('failed rescan followed by language switch cannot restore a stale preview or enable Run', async () => {
  const app = makeHarness({failPreviewAt:2});
  await app.booted;
  await app.click('preview-button');
  assert.equal(app.element('run-button').disabled, false);
  app.element('input-path').value = '/changed';
  await app.element('input-path').dispatch('input');
  await app.click('preview-button');
  assert.equal(app.element('run-button').disabled, true);
  await app.setLanguage('en');
  assert.equal(app.element('run-button').disabled, true);
  assert.equal(app.element('preview-section').classList.contains('hidden'), true);
  assert.equal(app.previewCount(), 2);
  assert.equal(app.runCount(), 0);
});

test('classic-mode preview stays visible and does not rerun when the locale changes', async () => {
  const app = makeHarness();
  await app.booted;
  await app.click('mode-toggle');
  assert.equal(app.document.body.dataset.interfaceMode, 'classic');
  await app.click('preview-button');
  assert.equal(app.element('preview-section').classList.contains('hidden'), false);
  assert.equal(app.element('run-button').disabled, false);

  await app.setLanguage('en');

  assert.equal(app.document.body.dataset.interfaceMode, 'classic');
  assert.equal(app.element('preview-section').classList.contains('hidden'), false);
  assert.equal(app.element('preview-page-status').textContent, 'Page 1 / 2 · 6 videos');
  assert.equal(app.element('run-button').disabled, false);
  assert.equal(app.previewCount(), 1);
  assert.equal(app.runCount(), 0);
});

test('new batch and language switch cannot resurrect the previous preview', async () => {
  const app = makeHarness();
  await app.booted;
  await app.click('preview-button');
  assert.equal(app.element('run-button').disabled, false);
  await app.click('new-batch-button');
  assert.equal(app.element('run-button').disabled, true);
  await app.setLanguage('en');
  assert.equal(app.element('run-button').disabled, true);
  assert.equal(app.element('preview-section').classList.contains('hidden'), true);
  assert.equal(app.previewCount(), 1);
  assert.equal(app.runCount(), 0);
});

test('language switch during a run preserves the active batch without another scan or run', async () => {
  const app = makeHarness();
  await app.booted;
  await app.click('preview-button');
  await app.click('run-button');
  assert.equal(app.runCount(), 1);
  const languageSelect = app.element('language-select');
  const writes = app.languageWriteCount();
  await app.setLanguage('en');
  assert.equal(app.element('progress-title').textContent, 'Restoring');
  assert.equal(app.element('cancel-button').disabled, false);
  assert.equal(app.previewCount(), 1);
  assert.equal(app.runCount(), 1);
  assert.equal(app.languageWriteCount(), writes + 1);
  assert.equal(languageSelect.value, 'en');
});

test('HTTP 500 language-save failure restores locale and preserves connection and active batch state', async () => {
  const app = makeHarness({failLanguageSave:true});
  await app.booted;
  await app.click('preview-button');
  await app.click('run-button');
  assert.equal(app.element('connection').classList.contains('disconnected'), false);
  assert.equal(app.element('cancel-button').disabled, false);
  assert.equal(app.element('progress-section').classList.contains('hidden'), false);

  await app.setLanguage('en');

  assert.equal(app.element('language-select').value, 'zh-CN');
  assert.equal(app.document.documentElement.lang, 'zh-CN');
  assert.equal(app.element('connection').classList.contains('disconnected'), false, 'preference HTTP 500 leaves the processing service connected');
  assert.equal(app.element('cancel-button').disabled, false, 'the active batch remains cancellable');
  assert.equal(app.element('progress-section').classList.contains('hidden'), false, 'the current batch view stays visible');
  assert.equal(app.element('progress-title').textContent, '正在还原');
  assert.equal(app.element('settings-message').textContent, '语言设置暂时无法保存');
  assert.equal(app.previewCount(), 1);
  assert.equal(app.runCount(), 1);
  assert.equal(app.languageWriteCount(), 1);
});

test('unauthorized and malformed language-save bridge responses fail closed', async () => {
  for (const languageSaveResponse of [
    {ok:false, status:401, payload:{error:'unauthorized'}},
    {ok:false, status:403, payload:{error:'forbidden'}},
    {ok:true, status:'invalid', payload:{language:'en'}}
  ]) {
    const app = makeHarness({languageSaveResponse});
    await app.booted;
    await app.click('preview-button');
    await app.setLanguage('en');

    assert.equal(app.element('language-select').value, 'zh-CN');
    assert.equal(app.element('connection').classList.contains('disconnected'), true);
    assert.equal(app.element('input-path').disabled, true);
    assert.equal(app.element('run-button').disabled, true);
    assert.equal(app.previewCount(), 1);
    assert.equal(app.runCount(), 0);
  }
});

test('switching locale on a finished result keeps the result page and translates its summary', async () => {
  const app = makeHarness({runState:{
    running:false, finished:true, total:6, completed:6, percent:100,
    summary:{encoded:3, copied:2, needs_review:1, failed:0},
    plan:{items:Array.from({length:6}, (_, index) => ({input:`/input/clip-${index + 1}.mp4`, action:'encode', status:'encoded'}))},
    items:Array.from({length:6}, (_, index) => ({input:`/input/clip-${index + 1}.mp4`, action:'encode', status:'encoded'})), logs:[]
  }});
  await app.booted;
  await app.click('preview-button');
  await app.click('run-button');
  assert.equal(app.element('progress-section').classList.contains('hidden'), false);
  await app.setLanguage('en');
  assert.equal(app.element('settings-section').classList.contains('hidden'), true);
  assert.equal(app.element('progress-section').classList.contains('hidden'), false);
  assert.match(app.element('complete-message').textContent, /Processing finished|Processing complete/);
  assert.equal(app.previewCount(), 1);
  assert.equal(app.runCount(), 1);
});

test('replayed batch logs translate only the no-LUT sentinel in both locales', async () => {
  const items = [
    {input:'log-m.mov', action:'copy', status:'copied_needs_review', needs_review:true, reason:'unknown profile'},
    {input:'normal.mov', action:'copy', status:'copied_nonlog', needs_review:false, reason:'normal footage'},
    {input:'unknown.mov', action:'copy', status:'copied_needs_review', needs_review:true, reason:'unknown profile'}
  ];
  const app = makeHarness({language:'en', runState:{
    running:false, finished:true, total:3, completed:3, percent:100,
    summary:{encoded:0, copied:3, needs_review:2, failed:0},
    plan:{items}, items,
    logs:[
      '待确认素材已复制：log-m.mov（未使用 LUT）',
      '复制完成：normal.mov（未使用 LUT）',
      '待确认素材已复制：unknown.mov（未使用 LUT）'
    ]
  }});
  await app.booted;
  app.element('look-vivid').checked = true;
  await app.click('preview-button');
  await app.click('run-button');

  const englishLogs = app.element('log-list').innerHTML;
  assert.match(englishLogs, /Review footage copied: log-m\.mov \(No LUT used\)/);
  assert.match(englishLogs, /Copied unchanged: normal\.mov \(No LUT used\)/);
  assert.match(englishLogs, /Review footage copied: unknown\.mov \(No LUT used\)/);
  assert.doesNotMatch(englishLogs, /未使用 LUT/);

  await app.setLanguage('zh-CN');
  const chineseLogs = app.element('log-list').innerHTML;
  assert.match(chineseLogs, /待确认素材已复制：log-m\.mov（未使用 LUT）/);
  assert.match(chineseLogs, /原样复制：normal\.mov（未使用 LUT）/);
  assert.match(chineseLogs, /待确认素材已复制：unknown\.mov（未使用 LUT）/);

  await app.setLanguage('en');
  const replayedEnglishLogs = app.element('log-list').innerHTML;
  assert.match(replayedEnglishLogs, /Review footage copied: log-m\.mov \(No LUT used\)/);
  assert.match(replayedEnglishLogs, /Copied unchanged: normal\.mov \(No LUT used\)/);
  assert.match(replayedEnglishLogs, /Review footage copied: unknown\.mov \(No LUT used\)/);
  assert.doesNotMatch(replayedEnglishLogs, /未使用 LUT/);
  assert.equal(app.runCount(), 1);
});
