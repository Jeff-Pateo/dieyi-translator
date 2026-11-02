/*
 * 双语助手 · 「仅显示译文」的结构感知降级自检
 * ------------------------------------------------------------------
 * 这是 v1.7 修掉的一个静默数据损失，值得单独一套测试。
 *
 * 旧行为：replace 模式一律 `el.textContent = 译文`。
 *   「See the <a>delivery handbook</a> for the full checklist.」渲染后
 *   链接就没了 —— 用户读到了译文，却再也点不进那份文档，而且页面上
 *   没有任何提示说「这里原来有个链接」。
 *
 * 新行为：含链接/代码这类有交互或语义的行内元素时**不替换**，
 *   改为在原文之后挂译文（`ct-trans--keep`），并把这次降级计进
 *   `stats.replaceDegraded` 如实上报。
 *
 * 这套断言要钉死的两件事：
 *   1) 走降级分支的元素，原文 DOM 必须**一个字节都没变**（链接可点）；
 *   2) 走替换分支的元素，origHTML 必须能**精确还原**（不丢属性、不丢空白）。
 *   只要这两条都成立，无论以后怎么调整 INLINE_KEEP 的宽度都是安全的。
 *
 * 运行：
 *   node tools/test-replace-keep.mjs
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
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

const FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>replace 降级夹具</title></head>
<body>
  <main>
    <p id="plain">The quick brown fox jumps over the lazy dog.</p>
    <p id="styled"><strong>Deploy</strong> the <em>release candidate</em> to staging first, always.</p>
    <p id="withLink">See the <a href="https://example.com/handbook">delivery handbook</a> for the full checklist.</p>
    <p id="withCode">Run <code>npm test</code> before you push anything to main.</p>
    <p id="withKbd">Press <kbd>Ctrl</kbd> then <kbd>S</kbd> to save the current file.</p>
    <p id="withAbbr">Our <abbr title="service level agreement">SLA</abbr> is measured in hours per week.</p>
    <p id="withTime">The release ships on <time datetime="2026-03-01">March the first</time>.</p>
    <p id="withRole">Open the <span role="link">members area</span> to continue reading.</p>
  </main>
</body>
</html>`;

function boot(html) {
  const dom = new JSDOM(html, {
    url: 'https://example.com/replace',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const ctx = dom.getInternalVMContext();
  // 顺序与 manifest 一致：constants 提供 CT.TRANS_CLASS / CT.DEFAULT_SETTINGS，
  // detector 供采集层使用，shadow-walk 提供 renderUnit 里的样式注入。
  for (const rel of [
    'shared/constants.js',
    'content/detector.js',
    'content/shadow-walk.js',
    'content/renderer.js'
  ]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), ctx, { filename: rel });
  }
  return { dom, w: dom.window, CT: dom.window.CT };
}

/* ================================================================== */
/* 一、判据：hasProtectedInline / INLINE_KEEP                          */
/* ================================================================== */

section('一、受保护的类名表');

{
  const { w, CT } = boot(FIXTURE);
  const R = CT.renderer;
  const doc = w.document;

  const must = ['a', 'button', 'input', 'select', 'textarea', 'label', 'code', 'kbd', 'samp', 'var', 'abbr', 'time'];
  for (const sel of must) {
    ok('INLINE_KEEP 覆盖 ' + sel, R.INLINE_KEEP.indexOf(sel) >= 0, R.INLINE_KEEP);
  }
  ok('INLINE_KEEP 覆盖 [role="link"]', R.INLINE_KEEP.indexOf('[role="link"]') >= 0);
  ok('INLINE_KEEP 覆盖 [role="button"]', R.INLINE_KEEP.indexOf('[role="button"]') >= 0);

  eq('纯文本段落不需要保护', R.hasProtectedInline(doc.getElementById('plain')), false);
  eq('只有 strong / em 的段落不需要保护（它们是纯排版，没有交互语义）',
    R.hasProtectedInline(doc.getElementById('styled')), false);

  for (const id of ['withLink', 'withCode', 'withKbd', 'withAbbr', 'withTime', 'withRole']) {
    eq(id + ' 需要保护', R.hasProtectedInline(doc.getElementById(id)), true);
  }

  // 嵌入式表单控件也要保护：译文替换掉 <input> 等于把筛选框拆了
  const withInput = doc.createElement('p');
  withInput.innerHTML = 'Type <input value="x"> to filter the list.';
  ok('含 <input> 的段落需要保护', R.hasProtectedInline(withInput));

  // 垃圾输入不能抛错
  eq('null 返回 false', R.hasProtectedInline(null), false);
  eq('普通对象返回 false', R.hasProtectedInline({}), false);
}

/* ================================================================== */
/* 二、replace 模式：两条分支的镜像断言                                */
/* ================================================================== */

section('二、replace：替换 vs 降级');

const REPLACE_IDS = ['plain', 'styled', 'withLink', 'withCode', 'withKbd', 'withAbbr', 'withTime', 'withRole'];
const DEGRADED_IDS = ['withLink', 'withCode', 'withKbd', 'withAbbr', 'withTime', 'withRole'];
const REPLACED_IDS = ['plain', 'styled'];

{
  const { w, CT } = boot(FIXTURE);
  const R = CT.renderer;
  const doc = w.document;
  const settings = Object.assign({}, CT.DEFAULT_SETTINGS, { targetLang: 'zh-CN', displayMode: 'replace' });
  R.resetStats();

  // 渲染前把每个元素的原始 HTML 记下来 —— 这就是还原的判定基准
  const before = {};
  for (const id of REPLACE_IDS) before[id] = doc.getElementById(id).innerHTML;

  const rendered = {};
  for (const id of REPLACE_IDS) {
    rendered[id] = R.renderUnit(doc.getElementById(id), '【译文】' + id, settings, 'h-' + id);
  }

  ok('全部渲染成功', REPLACE_IDS.every((id) => rendered[id] === true),
    JSON.stringify(rendered));

  /* --- 分支 A：纯文本 → 整体替换 --- */
  for (const id of REPLACED_IDS) {
    const el = doc.getElementById(id);
    const rec = R.registry.get(el);
    eq(id + ' 登记为 replace 分支', rec && rec.mode, 'replace');
    eq(id + ' 元素内容就是译文（整体替换）', el.textContent, '【译文】' + id);
    ok(id + ' 原文已从 DOM 移除', el.innerHTML.indexOf('quick brown fox') < 0
      && el.innerHTML.indexOf('release candidate') < 0);
    eq(id + ' origHTML 精确存下（可完整还原）', rec.origHTML, before[id]);
    ok(id + ' 打上 ct-replaced 标记', el.classList.contains('ct-replaced'));
    ok(id + ' 打上 data-ct-src 指纹', el.getAttribute('data-ct-src') === 'h-' + id);
  }

  /* --- 分支 B：含受保护行内元素 → 降级为双语 --- */
  for (const id of DEGRADED_IDS) {
    const el = doc.getElementById(id);
    const rec = R.registry.get(el);
    eq(id + ' 登记为 below-keep 分支', rec && rec.mode, 'below-keep');

    // ★ 核心：原文 DOM 一个字节都没变
    eq(id + ' 原文 DOM 完全没被动过', el.innerHTML, before[id]);
    ok(id + ' 没有被打上 ct-replaced', !el.classList.contains('ct-replaced'));

    // 译文挂在元素之后（是兄弟节点，不是子节点）
    const sib = el.nextElementSibling;
    ok(id + ' 译文挂在原文之后', !!sib && sib.classList.contains(CT.TRANS_CLASS),
      sib ? sib.tagName + '.' + sib.className : 'null');
    ok(id + '  带降级标记 ct-trans--keep', !!sib && sib.classList.contains('ct-trans--keep'),
      sib ? sib.className : 'null');
    eq(id + '  译文内容正确', sib && sib.textContent, '【译文】' + id);
    ok(id + '  译文不是子节点（没有破坏原文结构）',
      el.querySelector(':scope > .' + CT.TRANS_CLASS) === null);
  }

  /* --- 具体元素的可交互性：这才是降级想保住的东西 --- */
  const withLink = doc.getElementById('withLink');
  const link = withLink.querySelector('a[href="https://example.com/handbook"]');
  ok('链接仍然存在且 href 原样', !!link && link.getAttribute('href') === 'https://example.com/handbook');
  eq('链接文字未被改动', link && link.textContent, 'delivery handbook');
  ok('代码标记仍在', !!doc.getElementById('withCode').querySelector('code'));
  ok('abbr 的 title 属性仍在（悬停解释没丢）',
    doc.getElementById('withAbbr').querySelector('abbr').getAttribute('title') === 'service level agreement');
  ok('time 的 datetime 属性仍在（机器可读语义没丢）',
    doc.getElementById('withTime').querySelector('time').getAttribute('datetime') === '2026-03-01');
  ok('role=link 仍在', !!doc.getElementById('withRole').querySelector('[role="link"]'));

  /* --- 计数上报 --- */
  const st = R.getStats();
  eq('降级计数等于降级元素数', st.replaceDegraded, DEGRADED_IDS.length);
  eq('译文总数等于两者之和', st.translated, REPLACE_IDS.length);
  eq('替换分支不产生译文块（只有降级会产生）',
    doc.querySelectorAll('.' + CT.TRANS_CLASS).length, DEGRADED_IDS.length);

  /* --- 幂等：同样的内容再渲染一次，不能多出一个译文块 --- */
  for (const id of DEGRADED_IDS) {
    R.renderUnit(doc.getElementById(id), '【译文】' + id, settings, 'h-' + id);
  }
  eq('重复渲染不产生重复译文块',
    doc.querySelectorAll('.' + CT.TRANS_CLASS).length, DEGRADED_IDS.length);
  for (const id of DEGRADED_IDS) {
    eq(id + ' 重复渲染后原文仍未被改动',
      doc.getElementById(id).innerHTML, before[id]);
  }

  /* --- clearUnit：精确移除我们插进去的那个节点 --- */
  {
    const el = doc.getElementById('withLink');
    R.clearUnit(el, true);
    // 注意：withLink 后面本来还跟着 <p id="withCode">，
    // 所以不能断言 nextElementSibling 为 null —— 要断言「紧邻的那个不再是译文块」
    const sib = el.nextElementSibling;
    ok('clearUnit 后紧邻的下一个兄弟不再是译文块',
      !sib || !sib.classList.contains(CT.TRANS_CLASS),
      sib ? sib.tagName + '.' + sib.className : 'null');
    eq('  原文依然完好', el.innerHTML, before.withLink);
    ok('  注册记录已删除', !R.registry.has(el));
    eq('  其余降级译文块不受影响',
      doc.querySelectorAll('.' + CT.TRANS_CLASS).length, DEGRADED_IDS.length - 1);
  }

  /* --- restoreAll：整体还原 --- */
  R.restoreAll();
  eq('restoreAll 后页面上不留任何译文块', doc.querySelectorAll('.' + CT.TRANS_CLASS).length, 0);
  for (const id of REPLACE_IDS) {
    eq('还原后 ' + id + ' 的 DOM 与渲染前逐字节一致',
      doc.getElementById(id).innerHTML, before[id]);
  }
  ok('还原后 ct-replaced 标记已清除',
    doc.querySelectorAll('.ct-replaced').length === 0);
  ok('还原后 data-ct-src 标记已清除',
    doc.querySelectorAll('[data-ct-src]').length === 0);
  eq('还原后注册表被清空', R.registry.size, 0);
}

/* ================================================================== */
/* 三、降级只发生在 replace 模式                                        */
/* ================================================================== */

section('三、降级的作用域');

{
  const { w, CT } = boot(FIXTURE);
  const R = CT.renderer;
  const doc = w.document;

  for (const mode of ['below', 'hover']) {
    const settings = Object.assign({}, CT.DEFAULT_SETTINGS, { targetLang: 'zh-CN', displayMode: mode });
    R.resetStats();
    for (const id of REPLACE_IDS) {
      R.renderUnit(doc.getElementById(id), '【译文】' + id, settings, 'h-' + id);
    }
    eq('[' + mode + '] 不产生降级计数', R.getStats().replaceDegraded, 0);
    // below 模式本来就是把译文挂在原文旁边，不是「降级」
    if (mode === 'below') {
      ok('[' + mode + '] 链接仍在', !!doc.getElementById('withLink').querySelector('a'));
    }
    R.restoreAll();
    R.resetForModeChange ? R.resetForModeChange() : null;
  }
}

/* ================================================================== */
/* 四、shadow root 内的译文会自动补样式                                */
/* ================================================================== */

section('四、shadow 内渲染的样式注入');

{
  const { w, CT } = boot(FIXTURE);
  const R = CT.renderer;

  // 页面级 CSS 不穿透 shadow 边界 —— 译文插进 shadow 却拿不到样式
  // （不缩小字号、没有上间距），视觉上像「翻译没生效」。
  // renderUnit 必须在渲染前把样式注入到那个 root 内部。
  const host = w.document.createElement('div');
  host.id = 'shadowHost';
  w.document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  const p = w.document.createElement('p');
  p.textContent = 'The quick brown fox jumps over the lazy dog.';
  root.appendChild(p);

  eq('注入前 shadow root 内没有我们的样式', root.querySelectorAll('style[data-ct-shadow-style]').length, 0);

  // 这里用 below 模式：replace 模式下纯文本段落是【整体替换】，
  // 根本不会产生 .ct-trans 节点，验证不到「样式注入」这件事。
  // below 模式才会真的往 shadow 里插译文块 —— 那正是「插进去但没样式」的场景。
  const settings = Object.assign({}, CT.DEFAULT_SETTINGS, { targetLang: 'zh-CN', displayMode: 'below' });
  const okRender = R.renderUnit(p, '【译文】影子里的段落', settings, 'h-shadow');

  eq('shadow 内的段落渲染成功', okRender, true);
  eq('  shadow 内出现译文块', root.querySelectorAll('.' + CT.TRANS_CLASS).length, 1);
  eq('  shadow root 内已注入一份样式',
    root.querySelectorAll('style[data-ct-shadow-style]').length, 1);
  ok('  样式内容就是 shadow-walk 的 TRANS_CSS',
    root.querySelector('style[data-ct-shadow-style]').textContent === CT.shadow.TRANS_CSS);

  // 再渲染一个段落，不能重复注入
  const p2 = w.document.createElement('p');
  p2.textContent = 'Second paragraph inside the very same shadow root.';
  root.appendChild(p2);
  R.renderUnit(p2, '【译文】第二段', settings, 'h-shadow-2');
  eq('  同一 root 不会重复注入样式',
    root.querySelectorAll('style[data-ct-shadow-style]').length, 1);

  // 译文确实落在 shadow 内部（而不是被提到 light DOM）
  eq('译文留在 shadow 内', root.querySelectorAll('.' + CT.TRANS_CLASS).length, 2);
  eq('light DOM 里没有多出译文块',
    w.document.querySelectorAll('.' + CT.TRANS_CLASS).length, 0);

  R.restoreAll();
  eq('还原后 shadow 内不留译文块', root.querySelectorAll('.' + CT.TRANS_CLASS).length, 0);
  eq('  但样式保留（下次渲染还要用）',
    root.querySelectorAll('style[data-ct-shadow-style]').length, 1);
}

/* ------------------------------------------------------------------ */

console.log('\n' + '─'.repeat(52));
if (failures.length) {
  console.log('失败 ' + failures.length + ' 项，通过 ' + passed + ' 项');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('全部通过：' + passed + ' 项断言');
