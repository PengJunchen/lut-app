'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildApplicationMenu, translate } = require('../lib/native-i18n.cjs');

test('English native application menu includes localized menus and actions', () => {
  const menu = buildApplicationMenu({ platform: 'darwin', getLanguage: () => 'en' });
  assert.equal(menu[0].label, 'DJI Video Color Restoration');
  assert.deepEqual(menu.map((entry) => entry.label), [
    'DJI Video Color Restoration', 'File', 'Edit', 'Window', 'Help',
  ]);
  assert.deepEqual(menu[0].submenu.filter((entry) => entry.label).map((entry) => entry.label), [
    'About DJI Video Color Restoration', 'Quit',
  ]);
  assert.deepEqual(menu[2].submenu.filter((entry) => entry.label).map((entry) => entry.label), [
    'Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select All',
  ]);
  assert.equal(menu[3].submenu[0].label, 'Minimize');
  assert.equal(translate('about.message', 'en').includes('Original footage stays unchanged.'), true);
});

test('rebuilding the native menu applies the currently selected language', () => {
  let language = 'zh-CN';
  const firstMenu = buildApplicationMenu({ platform: 'win32', getLanguage: () => language });
  language = 'en';
  const refreshedMenu = buildApplicationMenu({ platform: 'win32', getLanguage: () => language });

  assert.equal(firstMenu[0].label, '文件');
  assert.equal(refreshedMenu[0].label, 'File');
  assert.equal(refreshedMenu[0].submenu[0].label, 'Quit');
});

test('unknown native message keys remain diagnosable instead of returning an empty label', () => {
  assert.equal(translate('missing.translation.key', 'en'), 'missing.translation.key');
});
