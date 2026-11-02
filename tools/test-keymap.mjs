/*
 * 双语助手 · 页内快捷键自检
 * ------------------------------------------------------------------
 * comboOf / match / withoutReserved 都是纯函数，可以直接穷举。
 * 这一层最容易出的错是「修饰键顺序不一致」：
 * 同一个 Alt+Shift+T 若因为生成顺序不同而得到两条不同字符串，
 * 匹配就会静默失效 —— 用户按下去毫无反应，而代码看起来是对的。
 *
 * 运行：
 *   node tools/test-keymap.mjs
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let passed = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + label); }
  else { failures.push(label); console.log('  \u2717 ' + label + (detail ? '  → ' + detail : '')); }
}
function eq(label, actual, expected) {
  ok(label + '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）',
    actual === expected);
}
function section(t) { console.log('\n' + t); }

globalThis.self = globalThis;
vm.runInThisContext(
  fs.readFileSync(path.join(ROOT, 'shared/constants.js'), 'utf8'),
  { filename: 'shared/constants.js' }
);
vm.runInThisContext(
  fs.readFileSync(path.join(ROOT, 'content/keymap.js'), 'utf8'),
  { filename: 'content/keymap.js' }
);

const K = globalThis.CT.keymap;
const CT = globalThis.CT;

/* ================================================================== */
/* 一、comboOf                                                         */
/* ================================================================== */

section('一、组合键归一化');

{
  eq('Alt+Shift+T', K.comboOf({ key: 't', altKey: true, shiftKey: true }), 'Alt+Shift+T');
  eq('单字符自动大写', K.comboOf({ key: 't', altKey: true, shiftKey: true }),
    K.comboOf({ key: 'T', altKey: true, shiftKey: true }));

  // 修饰键顺序固定为 Ctrl → Alt → Shift → Meta。
  // 顺序不定的话，同一次按键会生成两条不同字符串，匹配静默失效。
  eq('顺序固定：Ctrl+Alt',
    K.comboOf({ key: 'k', ctrlKey: true, altKey: true }), 'Ctrl+Alt+K');
  eq('顺序固定：Alt+Shift',
    K.comboOf({ key: 'k', altKey: true, shiftKey: true }), 'Alt+Shift+K');
  eq('四个修饰键齐全',
    K.comboOf({ key: 'k', ctrlKey: true, altKey: true, shiftKey: true, metaKey: true }),
    'Ctrl+Alt+Shift+Meta+K');

  // 纯修饰键自己不算一个组合 —— 否则用户单独按一下 Alt 就被当成快捷键
  for (const k of ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock']) {
    eq('纯修饰键 ' + k + ' 返回空串', K.comboOf({ key: k, altKey: true }), '');
  }

  eq('无 key 返回空串', K.comboOf({}), '');
  eq('null 输入返回空串', K.comboOf(null), '');

  // 无修饰键的单键也应当能表达（用户可能就想绑 F2）
  eq('功能键可以单独绑定', K.comboOf({ key: 'F2' }), 'F2');
  eq('方向键可以单独绑定', K.comboOf({ key: 'ArrowUp' }), 'ArrowUp');
}

/* ================================================================== */
/* 二、match                                                           */
/* ================================================================== */

section('二、绑定匹配');

{
  const bindings = { toggle: 'Alt+Shift+T', mode: 'Alt+Shift+Y', selection: 'Alt+Shift+S' };

  eq('命中 toggle', K.match(bindings, 'Alt+Shift+T'), 'toggle');
  eq('命中 mode', K.match(bindings, 'Alt+Shift+Y'), 'mode');
  eq('未命中返回 null', K.match(bindings, 'Ctrl+Shift+Z'), null);
  eq('空组合返回 null', K.match(bindings, ''), null);
  eq('空绑定表返回 null', K.match({}, 'Alt+Shift+T'), null);
  eq('undefined 绑定表返回 null', K.match(undefined, 'Alt+Shift+T'), null);

  // 空值的绑定项不该被匹配上（设置页里清空某一项会留下空串）
  eq('空串绑定不参与匹配', K.match({ toggle: '' }, ''), null);
  eq('null 绑定不参与匹配', K.match({ toggle: null }, 'Alt+Shift+T'), null);
}

/* ================================================================== */
/* 三、与全局键去重                                                    */
/* ------------------------------------------------------------------ */
/* 这一条不做的话，用户按下 Alt+Shift+T 会同时触发
 * chrome.commands 的全局动作与页内动作 —— 表现为「按一下翻两次」。 */
/* ================================================================== */

section('三、与全局快捷键去重');

{
  const reserved = CT.RESERVED_COMBOS;
  ok('constants 里声明了保留组合', Array.isArray(reserved) && reserved.length >= 2);

  const bindings = { toggle: 'Alt+Shift+T', mode: 'Alt+Shift+Y', selection: 'Alt+Shift+S' };
  const filtered = K.withoutReserved(bindings, reserved);

  eq('被占用的 toggle 被剔除', filtered.toggle, undefined);
  eq('被占用的 mode 被剔除', filtered.mode, undefined);
  eq('未占用的 selection 保留', filtered.selection, 'Alt+Shift+S');

  // 无保留列表时不应剔除任何东西
  eq('无保留列表则全保留',
    Object.keys(K.withoutReserved(bindings, [])).length, 3);
  eq('保留列表为空数组时不报错',
    Object.keys(K.withoutReserved(bindings, undefined)).length, 3);

  // manifest 里声明的两个全局键必须与常量一一对应，
  // 否则「去重」会去错东西 —— 这是一个跨文件一致性断言
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const cmds = manifest.commands || {};
  const declared = Object.keys(cmds)
    .map((k) => (cmds[k].suggested_key || {}).default)
    .filter(Boolean);
  for (const combo of declared) {
    ok('manifest 的全局键 ' + combo + ' 出现在 RESERVED_COMBOS 里',
      reserved.indexOf(combo) >= 0);
  }
  eq('RESERVED_COMBOS 数量与 manifest 一致', reserved.length, declared.length);
}

/* ================================================================== */
/* 四、输入框豁免                                                      */
/* ================================================================== */

section('四、可编辑区域豁免');

{
  eq('INPUT 豁免', K.inEditable({ tagName: 'INPUT' }), true);
  eq('TEXTAREA 豁免', K.inEditable({ tagName: 'TEXTAREA' }), true);
  eq('SELECT 豁免', K.inEditable({ tagName: 'SELECT' }), true);
  eq('contenteditable 豁免', K.inEditable({ tagName: 'DIV', isContentEditable: true }), true);
  eq('普通 DIV 不豁免', K.inEditable({ tagName: 'DIV' }), false);
  eq('null 不豁免', K.inEditable(null), false);

  // 在输入框里打字时不能劫持按键 —— 否则用户没法输入含 Alt 的字符
  ok('输入框判定不依赖 key，只依赖焦点元素', K.inEditable({ tagName: 'INPUT', key: 'a' }) === true);
}

/* ------------------------------------------------------------------ */

console.log('\n' + '─'.repeat(52));
if (failures.length) {
  console.log('失败 ' + failures.length + ' 项，通过 ' + passed + ' 项');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('全部通过：' + passed + ' 项断言');
