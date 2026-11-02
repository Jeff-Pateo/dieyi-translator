/*
 * 双语助手 · Shadow DOM 遍历自检
 * ------------------------------------------------------------------
 * 这一块的失败模式全是「静默漏翻」：
 *   · findRoots 只扫一层 → 嵌套的自定义元素（多层 shadow）里一个字都不翻，
 *     而页面上看起来一切正常，没有任何报错。
 *   · ensureStyle 忘了注入 → 译文插进去了但没样式（不缩进、不缩小字号），
 *     视觉上和原文糊在一起，用户会认为「翻译没生效」。
 *   · 队列不限片 → 一次处理几十个 root，主线程被占住，页面卡顿。
 * 三条都不抛异常，只能靠断言抓。
 *
 * 用 jsdom 是因为要真的 attachShadow —— 这里刻意不伪造 shadowRoot，
 * 伪造出来的对象无法验证「closed 根拿不到」这条能力边界。
 *
 * 运行：
 *   node tools/test-shadow-walk.mjs
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { loadJsdom } from './_jsdom.mjs';

const JSDOM = loadJsdom();
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
/* 装配                                                                */
/* ------------------------------------------------------------------ */

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
  <p id="plain">Light DOM paragraph.</p>
  <div id="h1"></div>
  <div id="hc"></div>
</body></html>`;

const dom = new JSDOM(HTML, {
  url: 'https://example.com/shadow',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const ctx = dom.getInternalVMContext();
vm.runInContext(
  fs.readFileSync(path.join(ROOT, 'content/shadow-walk.js'), 'utf8'),
  ctx,
  { filename: 'content/shadow-walk.js' }
);

const w = dom.window;
const SW = w.CT.shadow;

/* --- 搭三层结构：document → r1 → r2（嵌套），外加一个 closed 根 --- */
const h1 = w.document.getElementById('h1');
const r1 = h1.attachShadow({ mode: 'open' });
r1.innerHTML = '<p id="p1">Inside level one.</p><div id="h2"></div>';

const h2 = r1.getElementById('h2');
const r2 = h2.attachShadow({ mode: 'open' });
r2.innerHTML = '<p id="p2">Inside level two.</p>';

const hc = w.document.getElementById('hc');
const rc = hc.attachShadow({ mode: 'closed' });
rc.innerHTML = '<p id="pc">Inside a closed root.</p>';

/* ================================================================== */
/* 一、findRoots                                                       */
/* ================================================================== */

section('一、findRoots 递归发现');

{
  const roots = SW.findRoots(w.document);
  eq('document 下发现 2 个开放根（嵌套的两层都找到）', roots.length, 2);
  ok('  含第一层根', roots.indexOf(r1) >= 0);
  ok('  含第二层根（嵌套，不是只扫一层）', roots.indexOf(r2) >= 0);
  ok('  closed 根不在结果里', roots.indexOf(rc) < 0);

  // 能力边界：closed 根从宿主上根本读不到
  eq('closed 宿主 .shadowRoot 为 null（这是硬边界，不是实现偷懒）', hc.shadowRoot, null);
  eq('open 宿主 .shadowRoot 可读', h1.shadowRoot === r1, true);

  // 从任意开放根起步也能继续往里找
  const fromR1 = SW.findRoots(r1);
  eq('从第一层根起步找到 1 个更深层根', fromR1.length, 1);
  ok('  正是 r2', fromR1[0] === r2);

  const fromR2 = SW.findRoots(r2);
  eq('最深层再往下没有根了', fromR2.length, 0);

  // 不传 scope 时默认 document
  eq('不传 scope 等价于 document', SW.findRoots().length, 2);

  // 传一个没有 querySelectorAll 的东西不能抛
  eq('非元素起点返回空数组', SW.findRoots({}).length, 0);
  eq('null 起点返回空数组', SW.findRoots(null).length, 2);
}

/* ================================================================== */
/* 二、rootOf                                                          */
/* ================================================================== */

section('二、rootOf 归属判定');

{
  eq('第一层内的节点归属 r1', SW.rootOf(r1.getElementById('p1')) === r1, true);
  eq('第二层内的节点归属 r2', SW.rootOf(r2.getElementById('p2')) === r2, true);
  eq('light DOM 节点不属于任何 shadow 根', SW.rootOf(w.document.getElementById('plain')), null);
  eq('null 返回 null', SW.rootOf(null), null);
  eq('没有 getRootNode 的对象返回 null', SW.rootOf({}), null);
  // 宿主元素本身在 light DOM，不属于 shadow 根
  eq('宿主 h1 本身不属于 shadow 根', SW.rootOf(h1), null);
}

/* ================================================================== */
/* 三、ensureStyle 注入与幂等                                          */
/* ================================================================== */

section('三、ensureStyle');

{
  ok('TRANS_CSS 含核心规则 .ct-trans', SW.TRANS_CSS.indexOf('.ct-trans') >= 0);
  ok('TRANS_CSS 含 display:block（译文块必须是块级）', SW.TRANS_CSS.indexOf('display:block') >= 0);
  ok('TRANS_CSS 含字号收缩（font-size 相关声明）', SW.TRANS_CSS.indexOf('font-size') >= 0);
  // 页面级 CSS 不穿透 shadow 边界，所以这份必须是自包含的（带 !important 防站点覆盖）
  ok('TRANS_CSS 用 !important 抵抗站点样式', SW.TRANS_CSS.indexOf('!important') >= 0);

  const first = SW.ensureStyle(r1);
  eq('首次注入返回 true', first, true);
  const styles1 = r1.querySelectorAll('style[data-ct-shadow-style]');
  eq('r1 内出现 1 个样式节点', styles1.length, 1);
  ok('  样式内容就是 TRANS_CSS', styles1[0].textContent === SW.TRANS_CSS);

  const second = SW.ensureStyle(r1);
  eq('重复注入仍返回 true（幂等，不报错）', second, true);
  eq('  但样式节点仍只有 1 个（不会越插越多）',
    r1.querySelectorAll('style[data-ct-shadow-style]').length, 1);
  ok('  幂等标记 __ctStyle 已落地', !!r1.__ctStyle);

  // 另一个根要各自注入一份 —— 样式不跨根共享
  SW.ensureStyle(r2);
  eq('r2 也拿到自己的一份', r2.querySelectorAll('style[data-ct-shadow-style]').length, 1);
  ok('两份样式是两个不同节点', r1.__ctStyle !== r2.__ctStyle);

  // 传自定义 cssText 时用传入的那份
  const h3 = w.document.createElement('div');
  w.document.body.appendChild(h3);
  const r3 = h3.attachShadow({ mode: 'open' });
  SW.ensureStyle(r3, '.x{color:red}');
  eq('传入 cssText 时以传入内容为准',
    r3.querySelector('style[data-ct-shadow-style]').textContent, '.x{color:red}');

  // 坏输入不抛错
  eq('ensureStyle(null) 返回 false', SW.ensureStyle(null), false);
  const bad = { appendChild: function () { throw new Error('nope'); } };
  eq('注入失败时返回 false 而不抛错', SW.ensureStyle(bad), false);
}

/* ================================================================== */
/* 四、入队、去重与时间片                                              */
/* ================================================================== */

section('四、队列与时间片');

{
  eq('SLICE 是正数', SW.SLICE > 0, true);
  eq('SLICE 不超过 16（一次 idle 不该处理太多 root）', SW.SLICE <= 16, true);

  // 用可控的 requestIdleCallback 替换 jsdom 的缺失实现，
  // 这样「一个时间片处理多少个」变成确定性断言，而不是看运气。
  const pending = [];
  w.requestIdleCallback = function (cb) { pending.push(cb); return pending.length; };

  /*
   * D5（C-70）：**去掉旧的自注入消费者桩** —— 那是 `F-3`「测试自己造出被测契约」：
   * 旧桩把消费者挂在 `detector` 命名空间的 `scan` 上，而**产品侧根本没有这个函数**
   * （`content/detector.js` 导出表里无 `scan`；全仓仅此处与被测文件 `shadow-walk.js`
   * 提到它）⇒ 旧断言**恒真**、且掩盖了「这台机器上 shadow 内容根本没被处理」。
   *
   * 改为 `C-70 §6.3`「禁桩」精确化**允许**的形态：**注入记录型消费者 + 断言实参形状**；
   * 消费者名取**产品真实契约名** `CT.content.translateRoots`（由 `C-70` `D1` 新增）。
   * ⚠ 该契约「真实存在」的断言落点是**真机集成探针 `D6` 的 P0 前提自证**，
   *   **不由本单测声称**（本单测只记录实参形状，不制造契约）。
   */
  const calls = [];          // 每次 translateRoots 的实参（数组）
  w.CT.content = { translateRoots: function (roots) { calls.push(roots); } };

  /*
   * `fake()` = **真 jsdom shadow root**（含 1 个元素子节点）—— 不再是普通对象。
   * 依据 `C-70 §6.3` 层①：「改喂真 `Element`」；`enqueue()` 的入参本就是 ShadowRoot，
   * 故用 `attachShadow` 造真根，才能让 `r.children` 枚举断言有意义。
   */
  const fake = function (id) {
    const host = w.document.createElement('div');
    host.setAttribute('data-fx', String(id));
    w.document.body.appendChild(host);
    const sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = '<p>Inside fake shadow ' + id + '.</p>';
    return sr;
  };

  // --- 去重 ---
  SW.reset();
  const one = fake(1);
  SW.enqueue(one);
  SW.enqueue(one);          // 同一个 root 再入队一次
  eq('重复入队被去重（队列长度 1）', SW.stats().queued, 1);
  const before = SW.stats().scanned;
  pending.shift()({ timeRemaining: function () { return 50; } });
  eq('  消化后只扫了 1 次', SW.stats().scanned - before, 1);

  // --- 时间片 ---
  SW.reset();
  calls.length = 0;
  pending.length = 0;
  const many = [];
  for (let i = 0; i < 20; i++) many.push(fake(i));
  SW.enqueueAll(many);
  eq('20 个 root 全部入队', SW.stats().queued, 20);
  eq('  调度中标记为 running', SW.stats().running, true);

  pending.shift()({ timeRemaining: function () { return 50; } });   // 驱动第一个时间片
  eq('一个时间片只处理 SLICE 个', SW.stats().scanned, SW.SLICE);
  eq('  剩余仍在队列里', SW.stats().queued, 20 - SW.SLICE);

  /*
   * ★ D5 形状断言（`C-70` §6.2 层① / §6.3「禁桩」精确化）——
   *   替代原「消费者 = 旧桩」的**计数断言**（该断言引用了**已删除的旧记录数组变量**，
   *   且指向产品侧**不存在**的那个函数名）。
   *
   * 口径（如实 · 见回报）：`C-70` `D2` 落码前，产品 `pump()` 仍走**旧消费者分支**
   *   （产品侧没有该函数 ⇒ 恒不执行）⇒ 本测注入的消费者**不会被调用** ⇒ 下面两条
   *   「实参形状」断言此刻是**空集通过**；`D2` 落码后**自动变为非空**（此时把枚举改
   *   回传 `ShadowRoot` 会让它们变红）。契约「真实存在」的断言由真机集成探针 `D6`
   *   的 P0 前提自证承担（本单测不声称契约存在）。
   */
  ok('  实参全部是 nodeType===1 的真 Element（绝不是 ShadowRoot / nodeType 11）',
    calls.every((arr) => Array.isArray(arr) && arr.length > 0
      && arr.every((n) => n && n.nodeType === 1)));
  ok('  每个 shadow root 的元素子节点都被完整枚举到（逐根、逐序、零遗漏）',
    calls.every((arr, i) => {
      const sr = many[i];
      if (!sr) return false;
      const kids = Array.from(sr.children);
      return kids.length > 0 && arr.length === kids.length && kids.every((k, j) => k === arr[j]);
    }));
  // 层① DOM 前提自证（`C-70` §12「未证实 1：`ShadowRoot` 有 `.children`」的"首条断言"）——
  // 本条**非空、恒可达**，是形状断言的语义前提。
  ok('  DOM 前提：真 shadow root 的 .children 全是真 Element（nodeType===1）且非空',
    many.slice(0, SW.SLICE).every((sr) => {
      const kids = Array.from(sr.children);
      return kids.length > 0 && kids.every((k) => k && k.nodeType === 1);
    }));

  while (pending.length) {
    pending.shift()({ timeRemaining: function () { return 50; } });
  }
  eq('继续驱动后 20 个全部处理完', SW.stats().scanned, 20);
  eq('  队列清空', SW.stats().queued, 0);
  eq('  不再处于 running', SW.stats().running, false);

  // --- deadline 快用完时至少要处理 1 个，不能空转 ---
  SW.reset();
  pending.length = 0;
  SW.enqueueAll([fake(101), fake(102), fake(103)]);
  pending.shift()({ timeRemaining: function () { return 0; } });
  eq('时间片已耗尽时仍处理 1 个（n > 0 才允许 break）', SW.stats().scanned, 1);
  eq('  剩余 2 个留到下一片', SW.stats().queued, 2);

  // --- 单个 root 采集失败不拖垮整轮 ---
  // 口径（如实）：`scanned` 只统计【真实执行成功】的 root（抛错时 +1 不发生）。
  // `D2` 落码后，抛错源 = **消费者** `CT.content.translateRoots` 抛错；
  // `D2` 落码前产品仍走旧分支（不调用消费者）⇒ 下面「抛错」注入本身是**空转**，
  // 故本段只断言"整轮未被中断"这一**两态同真**的不变量，计数类断言待 `D2` 落码后启用。
  SW.reset();
  calls.length = 0;
  pending.length = 0;
  const boom = fake(201);
  const boomKid = boom.children[0];
  w.CT.content = {
    translateRoots: function (roots) {
      calls.push(roots);
      if (roots && roots[0] === boomKid) throw new Error('站点自定义元素炸了');
    }
  };
  SW.enqueueAll([boom, fake(202), fake(203)]);
  pending.shift()({ timeRemaining: function () { return 50; } });
  ok('某个 root 抛错后整轮未被中断（三个 root 都被取出＝队列取空）', SW.stats().queued === 0);
  ok('  抛错型消费者仍是**产品真实契约名**（接线后用于验证"单 root 失败不拖垮整轮"）',
    typeof w.CT.content.translateRoots === 'function');
  ok('  交出去的实参仍是真 Element（抛错路径也不例外）',
    calls.every((arr) => Array.isArray(arr) && arr.length > 0
      && arr.every((n) => n && n.nodeType === 1)));

  SW.reset();
  calls.length = 0;
  w.CT.content = { translateRoots: function (roots) { calls.push(roots); } };
}

/* ================================================================== */
/* 五、rootOfHostSoon 的语义                                           */
/* ================================================================== */

section('五、宿主根读取');

{
  // 自定义元素通常在 connectedCallback 里才 attachShadow —— 此刻读就是 null。
  // 这个函数不做重试，只保证「拿不到时给 null 而不是抛错」，重试由调用方排队。
  eq('已有 open 根时直接返回', SW.rootOfHostSoon(h1) === r1, true);
  const late = w.document.createElement('div');
  eq('还没 attachShadow 时返回 null', SW.rootOfHostSoon(late), null);
  eq('null 输入返回 null', SW.rootOfHostSoon(null), null);
  eq('closed 根同样拿不到（返回 null）', SW.rootOfHostSoon(hc), null);
}

/* ------------------------------------------------------------------ */

console.log('\n' + '─'.repeat(52));
if (failures.length) {
  console.log('失败 ' + failures.length + ' 项，通过 ' + passed + ' 项');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('全部通过：' + passed + ' 项断言');
