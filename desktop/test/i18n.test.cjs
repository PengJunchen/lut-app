'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const i18n = require('../../internal/webui/static/i18n.js');

const appSource = fs.readFileSync(path.join(__dirname, '../../internal/webui/static/app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, '../../internal/webui/static/index.html'), 'utf8');

test('locale dictionaries stay in parity and English contains no untranslated Chinese', () => {
  const chineseKeys = Object.keys(i18n.messages['zh-CN']).sort();
  const englishKeys = Object.keys(i18n.messages.en).sort();
  assert.deepEqual(englishKeys, chineseKeys);
  for (const [key, value] of Object.entries(i18n.messages.en)) {
    assert.doesNotMatch(value, /[\u3400-\u9fff]/, `English value ${key} contains Chinese`);
    const placeholders = (template) => [...template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]).sort();
    assert.deepEqual(placeholders(value), placeholders(i18n.messages['zh-CN'][key]), `placeholder mismatch for ${key}`);
  }
});

test('every literal renderer translation key exists in both locales', () => {
  const keys = [...new Set([...appSource.matchAll(/\bt\(\s*'([^']+)'/g)].map((match) => match[1]))];
  for (const language of ['zh-CN', 'en']) {
    for (const key of keys) assert.ok(i18n.messages[language][key], `${language} is missing ${key}`);
    for (const key of Object.values(i18n.staticTextKeys)) assert.ok(i18n.messages[language][key], `${language} is missing static text ${key}`);
    for (const key of Object.values(i18n.staticAttributeKeys)) assert.ok(i18n.messages[language][key], `${language} is missing static attribute ${key}`);
  }
});

test('static HTML Chinese text and accessibility attributes have translation keys', () => {
  const nativeLanguageNames = new Set(['中文']);
  const textNodes = [...htmlSource.matchAll(/>([^<>]+)</g)].map((match) => match[1].trim());
  for (const value of textNodes) {
    if (/[\u3400-\u9fff]/.test(value) && !nativeLanguageNames.has(value)) {
      assert.ok(i18n.staticTextKeys[value], `static text is missing a translation key: ${value}`);
    }
  }
  for (const [, value] of htmlSource.matchAll(/(?:aria-label|title|placeholder)="([^"]+)"/g)) {
    if (/[\u3400-\u9fff]/.test(value)) assert.ok(i18n.staticAttributeKeys[value], `static attribute is missing a translation key: ${value}`);
  }
});

test('browser preference safely falls back through saved value, navigator, and default', () => {
  assert.equal(i18n.preferredBrowserLanguage({getItem: () => 'en'}, {language: 'zh-CN'}), 'en');
  assert.equal(i18n.preferredBrowserLanguage({getItem: () => 'invalid'}, {language: 'en-GB'}), 'en');
  assert.equal(i18n.preferredBrowserLanguage({getItem: () => 'invalid'}, {language: 'fr-FR', languages: ['zh-Hans-CN']}), 'zh-CN');
  assert.equal(i18n.preferredBrowserLanguage({getItem: () => { throw new Error('blocked'); }}, {language: 'en-US'}), 'en');
  assert.equal(i18n.preferredBrowserLanguage(null, null), 'zh-CN');
});

test('known backend messages localize exactly in both directions, including wrapped details', () => {
  const zh = i18n.createI18n('zh-CN');
  const en = i18n.createI18n('en');
  assert.equal(zh.translateKnownMessage('界面语言必须是 zh-CN 或 en'), '界面语言必须是 zh-CN 或 en');
  assert.equal(en.translateKnownMessage('界面语言必须是 zh-CN 或 en'), 'The language must be zh-CN or en.');
  assert.equal(en.translateKnownMessage('读取扫描选项失败：permission denied'), 'The scan options could not be read: permission denied');
  assert.equal(zh.translateKnownMessage('The scan options could not be read: permission denied'), '读取扫描选项失败：permission denied');
  assert.equal(en.translateKnownMessage('语言设置暂时无法保存'), 'Language preference could not be saved');
  assert.equal(zh.translateKnownMessage('Language preference could not be saved'), '语言设置暂时无法保存');
  assert.equal(en.translateKnownMessage('unrecognized external diagnostic'), null);
});

test('renderer title matches the native English desktop title and obsolete static attribute is absent', () => {
  assert.equal(i18n.messages.en['app.title'], 'DJI Video Color Restoration');
  assert.equal(i18n.staticAttributeKeys['选择到经典模式'], undefined);
});

test('desktop preference writes serialize rapid choices and roll back a failed latest save', async () => {
  const pending = [];
  const saves = [];
  const displayed = [];
  const failures = [];
  const controller = i18n.createNativeLanguageController({
    initialLanguage: 'zh-CN',
    save: (language) => {
      saves.push(language);
      return new Promise((resolve, reject) => pending.push({resolve, reject}));
    },
    onLanguage: (language) => displayed.push(language),
    onError: (error) => failures.push(error.message)
  });

  controller.select('en');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(saves, ['en']);
  controller.select('zh-CN');
  assert.deepEqual(saves, ['en'], 'a second write waits for the in-flight native preference save');
  pending[0].resolve({language: 'en'});
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(saves, ['en', 'zh-CN']);
  pending[1].reject(new Error('disk unavailable'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.confirmed, 'en');
  assert.equal(controller.desired, 'en');
  assert.equal(displayed.at(-1), 'en', 'failed save restores the last confirmed native language');
  assert.deepEqual(failures, ['disk unavailable']);
});

test('language rerender remains read-only with respect to scan and run operations', () => {
  const start = appSource.indexOf('function renderLocalizedContent()');
  const end = appSource.indexOf('\n  async function changeLanguage', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const rerender = appSource.slice(start, end);
  assert.doesNotMatch(rerender, /api\(['"]\/api\/(?:preview|run)['"]|scanPreview\(|runButton\.click/);
  assert.match(appSource, /save: \(language\) => api\('\/api\/desktop-language', \{method:'POST', body:JSON\.stringify\(\{language\}\)\}\)/);
  assert.match(htmlSource, /<select id="language-select"[\s\S]*?<option value="zh-CN">中文<\/option>[\s\S]*?<option value="en">English<\/option>/);
});
