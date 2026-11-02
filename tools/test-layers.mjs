/*
 * 双语助手 · 浮层仲裁自检
 * ------------------------------------------------------------------
 * 为什么这一层值得单独测：
 * 页面上现在有五类浮层（页内开关的菜单 / 引导气泡 / 黑名单确认 / 划词气泡 /
 * 图片菜单），它们分散在三个模块里。仲裁写错的症状是「某个浮层再也打不开」，
 * 而且只在特定操作顺序下出现 —— 手工点是点不出来的。
 *
 * 运行：
 *   node tools/test-layers.mjs
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

/* ------------------------------------------------------------------ */
/* 装配：layers.js 是 UMD 风格普通脚本                                  */
/* ------------------------------------------------------------------ */

globalThis.self = globalThis;
vm.runInThisContext(
  fs.readFileSync(path.join(ROOT, 'content/layers.js'), 'utf8'),
  { filename: 'content/layers.js' }
);

const L = globalThis.CT.layers;

/* ================================================================== */
/* 一、优先级表                                                        */
/* ================================================================== */

section('一、优先级表');

{
  const ids = ['guide', 'menu', 'confirm', 'tip', 'selection', 'imageMenu'];
  for (const id of ids) {
    ok('优先级表覆盖 ' + id, typeof L.PRIORITY[id] === 'number');
  }

  // 这三条是「为什么这么排」的可执行表达，不是随手写的数字
  ok('引导最低（任何东西都能把它挤掉）', L.PRIORITY.guide < L.PRIORITY.menu);
  ok('确认条高于菜单（拉黑站点的决定必须能压过随手点开的菜单）',
    L.PRIORITY.confirm > L.PRIORITY.menu);
  ok('划词气泡高于菜单（用户刚做的动作优先被看到）',
    L.PRIORITY.selection > L.PRIORITY.menu);
}

/* ================================================================== */
/* 二、基本语义                                                        */
/* ================================================================== */

section('二、基本语义');

{
  L._reset();
  eq('初始没有持有者', L.current(), null);

  ok('acquire 成功返回 true', L.acquire('menu') === true);
  eq('持有者变成 menu', L.current(), 'menu');
  eq('isOpen 认可当前持有者', L.isOpen('menu'), true);
  eq('isOpen 否认其它 id', L.isOpen('guide'), false);

  // 同一浮层重复申请必须幂等 —— 否则「重开同一个菜单」会先通知关闭再通知打开
  let notifications = 0;
  L.onChange(() => { notifications++; });
  ok('重复 acquire 同一 id 仍返回 true', L.acquire('menu') === true);
  eq('重复 acquire 不触发通知', notifications, 0);

  L.release('menu');
  eq('release 后无持有者', L.current(), null);
  eq('release 触发一次通知', notifications, 1);

  L._reset();
  // 只有持有者能释放自己 —— 否则 A 模块能把 B 模块的浮层关掉
  L.acquire('selection');
  L.release('menu');
  eq('非持有者 release 无效', L.current(), 'selection');
}

/* ================================================================== */
/* 三、冲突：拒绝而不是抢占                                            */
/* ================================================================== */

section('三、冲突处理');

{
  L._reset();
  L.acquire('selection');
  // 这是本模块最核心的一条：高优先级在用时，低优先级申请**被拒绝**，
  // 而不是把对方挤掉。用户正在读划词译文时点一下 ⋯，气泡不该消失。
  eq('低优先级申请被拒绝', L.acquire('menu'), false);
  eq('原持有者不变', L.current(), 'selection');

  // 反过来：高优先级可以把低优先级挤掉，并且会调用它的 onClose
  L._reset();
  let closed = 0;
  L.acquire('guide', () => { closed++; });
  eq('高优先级申请成功', L.acquire('selection'), true);
  eq('低优先级被挤掉', L.current(), 'selection');
  eq('被挤掉者的 onClose 被调用一次', closed, 1);

  // onClose 抛异常不能破坏仲裁器 —— 否则一个模块的 bug 会让所有浮层卡死
  L._reset();
  L.acquire('guide', () => { throw new Error('boom'); });
  let afterThrow = null;
  try { afterThrow = L.acquire('menu'); } catch (e) { afterThrow = 'threw'; }
  eq('onClose 抛异常不影响新浮层展开', afterThrow, true);
  eq('持有者仍正确', L.current(), 'menu');
}

/* ================================================================== */
/* 四、closeAll                                                        */
/* ================================================================== */

section('四、批量收起');

{
  L._reset();
  let closed = 0;
  L.acquire('menu', () => { closed++; });

  L.closeAll('menu');
  eq('closeAll(except=持有者) 不关闭它', L.current(), 'menu');
  eq('  onClose 未被调用', closed, 0);

  L.closeAll();
  eq('closeAll() 关闭一切', L.current(), null);
  eq('  onClose 被调用一次', closed, 1);

  // 无持有者时 closeAll 必须是安全的空操作（滚动 / Esc 会频繁调用它）
  let threw = false;
  try { L.closeAll(); L.closeAll(null); } catch (e) { threw = true; }
  eq('空状态下 closeAll 不抛错', threw, false);
}

/* ================================================================== */
/* 五、订阅者隔离                                                      */
/* ================================================================== */

section('五、订阅者');

{
  L._reset();
  let good = 0;
  L.onChange(() => { throw new Error('bad subscriber'); });
  L.onChange(() => { good++; });

  L.acquire('tip');
  eq('前面的订阅者抛错不影响后面的订阅者', good, 1);

  // 非函数参数不应被登记（否则 notify 时会 TypeError）
  L.onChange(null);
  L.onChange('not a function');
  let threw = false;
  try { L.release('tip'); } catch (e) { threw = true; }
  eq('登记非法订阅者后再通知不抛错', threw, false);
  eq('  合法订阅者仍收到通知', good, 2);
}

/* ================================================================== */
/* 六、与 toggle 的契约                                                */
/* ------------------------------------------------------------------ */
/* toggle.js 会调用 release('menu' | 'guide' | 'confirm') 来收起自己，
 * 而不关心当前持有者是谁。这里钉住「release 不会误伤别人」这条契约。 */
/* ================================================================== */

section('六、与页内开关的契约');

{
  L._reset();
  L.acquire('selection');
  L.release('menu');
  L.release('guide');
  L.release('confirm');
  eq('toggle 连 release 三个 id 后，划词气泡仍持有', L.current(), 'selection');

  // closeAll 是 toggle 之外的通用入口（content.js 在整页翻译开始 / Esc 时调）
  L.closeAll();
  eq('closeAll 能收掉划词气泡', L.current(), null);
}

/* ------------------------------------------------------------------ */

console.log('\n' + '─'.repeat(52));
if (failures.length) {
  console.log('失败 ' + failures.length + ' 项，通过 ' + passed + ' 项');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('全部通过：' + passed + ' 项断言');
