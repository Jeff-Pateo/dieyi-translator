/*
 * 双语助手 · 自检脚本
 * ------------------------------------------------------------------
 * 用 jsdom 把 content script 的三个模块真实加载起来，验证最容易出错的四件事：
 *   1) 语言检测：常见语种能否判对，是否会把中文页面误判成需要翻译
 *   2) 单元采集：<p>Hello <a>world</a></p> 必须算【一条】译文，且代码块不被采集
 *   3) 渲染与还原：三种模式渲染后能否精确还原，还原是否残留节点
 *   4) 幂等性：重复采集不应产生重复译文
 *
 * 运行：
 *   npm run test:dom
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// jsdom 故意不装在扩展目录里（否则会被打进扩展包）。
// 解析顺序与失败提示统一由 _jsdom.mjs 负责。
import { loadJsdom } from './_jsdom.mjs';

const JSDOM = loadJsdom();

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* ------------------------------------------------------------------ */
/* 断言工具                                                            */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

function ok(label, cond, detail) {
  if (cond) {
    passed++;
    console.log('  \u2713 ' + label);
  } else {
    failed++;
    console.log('  \u2717 ' + label + (detail ? '  → ' + detail : ''));
  }
}

function eq(label, actual, expected) {
  ok(label, actual === expected, '实际 ' + JSON.stringify(actual) + '，期望 ' + JSON.stringify(expected));
}

/** 数组/对象按 JSON 逐字比较。失败时把两侧都打出来，省得再猜哪一项不同 */
function eqj(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(label, a === b, '实际 ' + a + '，期望 ' + b);
}

function section(title) {
  console.log('\n' + title);
}

/* ------------------------------------------------------------------ */
/* 装配环境                                                            */
/* ------------------------------------------------------------------ */

const ARTICLE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Building Reliable Delivery Pipelines</title>
  <style>.hidden{display:none}</style>
</head>
<body>
  <header><h1>Building Reliable Delivery Pipelines</h1></header>
  <main>
    <p>Most teams do not fail because they lack talent. They fail because the process
       that turns an idea into a shipped feature has too many hidden handoffs.</p>
    <p>See the <a href="https://example.com/handbook">delivery handbook</a> for the full checklist.</p>
    <ul>
      <li>Define the definition of done before the sprint starts.</li>
      <li>Measure cycle time, not story points.</li>
    </ul>
    <pre><code>const pipeline = build({ retries: 3 });</code></pre>
    <blockquote>You cannot improve what you do not measure.</blockquote>
    <table>
      <tr><th>Metric</th><th>Target</th></tr>
      <tr><td>Cycle time</td><td>5 days</td></tr>
    </table>
    <div style="display:none"><p>This paragraph is hidden and must not be translated.</p></div>
    <div translate="no"><p>Brand name should stay as is.</p></div>
  </main>
  <footer><p>Copyright 2026 Example Inc.</p></footer>
</body>
</html>`;

/*
 * 布局夹具：专门用来验证「插入点决策」。
 * 每一种宿主的排版方式都对应 placementFor 里的一条分支 ——
 * display / flex-direction / flex-wrap 都能被 jsdom 的 getComputedStyle 解析出来，
 * 所以这些判定可以在单元测试里精确断言。
 * 至于「断言的结果在真实版式下是否成立」（宽度有没有被挤压、行盒有没有被撑高），
 * jsdom 没有布局引擎，交给 tools/bench-layout.html 在真实 Chrome 里量。
 */
const LAYOUT = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <style>
    .row      { display: flex; flex-direction: row;    flex-wrap: nowrap; }
    .rowwrap  { display: flex; flex-direction: row;    flex-wrap: wrap; }
    .col      { display: flex; flex-direction: column; flex-wrap: nowrap; }
    .grid     { display: grid; }
    .pill     { display: inline-block; }
    .plain    { display: block; }
    .abs      { position: absolute; display: block; }
  </style>
</head>
<body>
  <div id="row" class="row"><span>Engineer</span><span>Golang</span></div>
  <div id="rowwrap" class="rowwrap"><span>Engineer</span><span>Golang</span></div>
  <div id="col" class="col"><span>Engineer</span><span>Golang</span></div>
  <div id="grid" class="grid"><span>Engineer</span><span>Golang</span></div>
  <div id="pill" class="pill">Europe</div>
  <div id="plain" class="plain">Own the end to end experience of our storefront.</div>
  <div id="cardrow" class="row"><div id="card" class="plain">Keep the checkout path under one second.</div></div>
  <table><tbody><tr><td id="cell">Cycle time</td></tr></tbody></table>
  <ul><li id="item">Measure cycle time, not story points.</li></ul>
  <div style="position:relative"><div id="floating" class="abs">Floating badge label</div></div>
</body>
</html>`;

/*
 * 裁切容器夹具。
 * ------------------------------------------------------------------
 * 这里刻意用 overflow-x / overflow-y 长写而不是 `overflow` 简写 ——
 * jsdom 的 cssstyle 不会把简写展开成 overflowX / overflowY，
 * 写简写会让判定一路读到 'visible'，整组断言变成「测空气」。
 * 真实浏览器（见 tools/bench-layout.html）用简写，computed style 会自动展开，
 * 所以生产代码只读 overflowX / overflowY 是对的，不需要为 jsdom 做兼容。
 */
const CLIP = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <style>
    .clamp  { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3;
              overflow-x: hidden; overflow-y: hidden; }
    .maxh   { overflow-x: hidden; overflow-y: hidden; max-height: 44px; }
    .fold   { overflow-x: hidden; overflow-y: hidden; max-height: 0; }
    .outer  { overflow-x: hidden; overflow-y: hidden; max-height: 60px; }
    .inner  { overflow-x: hidden; overflow-y: hidden; -webkit-line-clamp: 2;
              display: -webkit-box; -webkit-box-orient: vertical; }
    .chips  { display: flex; flex-direction: row; flex-wrap: nowrap; }
    .onlyhidden { overflow-x: hidden; overflow-y: hidden; }
    td.clipcell { overflow-x: hidden; overflow-y: hidden; max-height: 20px; }
  </style>
</head>
<body>
  <div id="clamp" class="clamp"><p id="clampP">The quick brown fox jumps over the lazy dog every single morning.</p></div>
  <div id="maxh" class="maxh"><p id="maxhP">The quick brown fox jumps over the lazy dog every single morning.</p></div>
  <div id="fold" class="fold"><p id="foldP">The quick brown fox jumps over the lazy dog every single morning.</p></div>
  <div id="outer" class="outer"><div id="inner" class="inner"><p id="nestedP">The quick brown fox jumps over the lazy dog.</p></div></div>
  <div id="onlyhidden" class="onlyhidden"><p id="plainP">Own the end to end experience of our storefront.</p></div>
  <table><tbody><tr><td id="clipcell" class="clipcell"><p id="cellP">Cycle time is the only metric that matters.</p></td></tr></tbody></table>
  <div id="rowshare" class="chips">
    <div id="chipA" class="chips"><span>Engineer acme</span><span>Golang acme</span></div>
    <div id="chipB" class="chips"><span>Designer acme</span><span>Figma acme</span></div>
  </div>
</body>
</html>`;

function boot(html) {
  // runScripts: 'outside-only' 会为 jsdom 建立真正的 vm 上下文，
  // 这样我们就能用 vm.runInContext 精确模拟「多个 content script 共享同一个
  // isolated world 全局作用域」的行为 —— 这是本扩展跨文件通信的前提。
  const dom = new JSDOM(html, {
    url: 'https://example.com/article',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const ctx = dom.getInternalVMContext();

  for (const rel of ['shared/constants.js', 'content/detector.js', 'content/renderer.js']) {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(code, ctx, { filename: rel });
  }
  return { dom, w: dom.window, CT: dom.window.CT };
}

/* ================================================================== */
/* 1. 语言检测                                                         */
/* ================================================================== */

section('一、语言检测');

{
  const { CT } = boot(ARTICLE);
  const dt = CT.detector;

  eq('页面语言识别为 en', dt.detectPageLanguage().lang, 'en');

  const cases = [
    ['en', 'The quick brown fox jumps over the lazy dog. This is a test of the emergency broadcast system.'],
    ['fr', 'Le renard brun rapide saute par-dessus le chien paresseux. Ceci est un test du systeme avec les autres.'],
    ['de', 'Der schnelle braune Fuchs springt uber den faulen Hund. Das ist ein Test mit den anderen und nicht nur.'],
    ['es', 'El rapido zorro marron salta sobre el perro perezoso. Esto es una prueba para los que no tienen nada.'],
    ['ja', 'これは日本語のテストです。文章を翻訳できるかどうかを確認します。'],
    ['ru', 'Быстрая коричневая лиса прыгает через ленивую собаку. Это тест системы.'],
    ['zh', '这是一段中文文本，用来验证检测器不会把中文当成需要翻译的对象。']
  ];

  for (const [expect, text] of cases) {
    eq('识别 ' + expect, dt.detectTextLanguage(text).lang, expect);
  }

  // 目标语言为中文时，中文文本必须被判为「无需翻译」
  const zhVerdict = dt.isTranslatableText('这是一段中文文本，不应该被翻译。', 'zh-CN', 2);
  eq('中文文本判为不需翻译', zhVerdict.ok, false);
  eq('  原因标记正确', zhVerdict.reason, 'already-target');

  // 纯数字 / URL / 邮箱 / 符号串不应被送去翻译
  eq('纯数字跳过', dt.isTranslatableText('12345 6789', 'zh-CN', 2).ok, false);
  eq('URL 跳过', dt.isTranslatableText('https://example.com/docs/intro', 'zh-CN', 2).ok, false);
  eq('邮箱跳过', dt.isTranslatableText('hello@example.com', 'zh-CN', 2).ok, false);
  eq('正常英文通过', dt.isTranslatableText('Build reliable pipelines.', 'zh-CN', 2).ok, true);
}

/* ================================================================== */
/* 2. 单元采集                                                         */
/* ================================================================== */

section('二、翻译单元采集');

{
  const { w, CT } = boot(ARTICLE);
  const settings = Object.assign({}, CT.DEFAULT_SETTINGS, { targetLang: 'zh-CN' });
  const units = CT.renderer.collectUnits(w.document.body, settings);
  const texts = units.map((u) => u.text);

  ok('采集到若干单元（' + units.length + ' 条）', units.length >= 8);

  // 关键：内联链接必须和段落合并成一条
  const withLink = texts.filter((t) => t.indexOf('delivery handbook') >= 0);
  eq('内联 <a> 与段落合并为一条', withLink.length, 1);
  ok('  合并后的文本完整保留了前后文', /See the .*delivery handbook.* for the full checklist\./.test(withLink[0] || ''), withLink[0]);

  // 代码块 / hidden / translate=no 区域必须排除
  ok('代码块未被采集', !texts.some((t) => t.indexOf('const pipeline') >= 0));
  ok('translate=no 区域未被采集', !texts.some((t) => t.indexOf('Brand name') >= 0));
  ok('display:none 区域未被采集', !texts.some((t) => t.indexOf('hidden and must not') >= 0));

  // <h1> / <li> / <td> / <blockquote> 都应各自成条
  ok('<h1> 单独成条', texts.some((t) => t.indexOf('Building Reliable Delivery Pipelines') === 0));
  ok('<li> 各自成条', texts.filter((t) => /^Define the|^Measure cycle/.test(t)).length === 2);
  ok('<td> 各自成条', texts.indexOf('Cycle time') >= 0 && texts.indexOf('5 days') >= 0);
  ok('<blockquote> 成条', texts.some((t) => t.indexOf('cannot improve') >= 0));

  // 同一段落不应出现两次
  const dup = texts.filter((t) => t.indexOf('hidden handoffs') >= 0);
  eq('同一段落不重复', dup.length, 1);
}

/* ================================================================== */
/* 3. 渲染与还原                                                       */
/* ================================================================== */

section('三、渲染与还原');

for (const mode of ['below', 'replace', 'hover']) {
  const { w, CT } = boot(ARTICLE);
  const doc = w.document;
  const settings = Object.assign({}, CT.DEFAULT_SETTINGS, { targetLang: 'zh-CN', displayMode: mode });
  const before = doc.body.innerHTML;

  // 渲染会改写这些元素的文本，必须在渲染前拿到引用
  const pFirst = doc.querySelector('main > p');
  const tdCycle = Array.from(doc.querySelectorAll('td')).find((x) => x.textContent.trim() === 'Cycle time');
  // 「不改变页面原本结构」的直接断言基准：容器原有子元素的个数与顺序
  const kidsBefore = Array.from(doc.querySelector('main').children);
  const h1 = doc.querySelector('h1');

  const units = CT.renderer.collectUnits(doc.body, settings);
  let rendered = 0;
  for (const u of units) {
    if (CT.renderer.renderUnit(u.el, '【中文】' + u.text.slice(0, 12), settings, u.hash)) rendered++;
  }

  ok('[' + mode + '] 渲染成功 ' + rendered + ' 条', rendered === units.length && rendered > 0);

  if (mode === 'below') {
    const blocks = doc.querySelectorAll('.' + CT.TRANS_CLASS);
    eq('[' + mode + '] 译文块数量与单元一致', blocks.length, units.length);

    // 默认插入方式：追加到原文单元【内部末尾】，而不是插为兄弟节点
    const tail = pFirst.lastElementChild;
    ok('[' + mode + '] 译文块追加在原文单元内部末尾',
      !!tail && tail.parentElement === pFirst && tail.classList.contains(CT.TRANS_CLASS),
      'lastElementChild = ' + (tail ? tail.tagName + '.' + tail.className : 'null'));
    ok('[' + mode + '] 不在原文之后新增兄弟节点',
      !pFirst.nextElementSibling || !pFirst.nextElementSibling.classList.contains(CT.TRANS_CLASS));

    // ★ 这条是「不改变页面原本结构」的核心断言：
    //   容器的直接子元素个数与顺序原样不动 —— flex/grid 容器不会凭空多出弹性项，
    //   :nth-child 与 p + p 这类相邻兄弟选择器也不会错位。
    const kidsAfter = Array.from(doc.querySelector('main').children);
    ok('[' + mode + '] 容器原有子元素个数与顺序未被改动',
      kidsAfter.length === kidsBefore.length && kidsAfter.every((el, i) => el === kidsBefore[i]),
      kidsBefore.length + ' 个 -> ' + kidsAfter.length + ' 个');

    ok('[' + mode + '] 表格单元格译文内嵌而非插到 <tr> 里',
      !!tdCycle && tdCycle.querySelector(':scope > .' + CT.TRANS_CLASS) !== null);
    ok('[' + mode + '] 表格行内没有多出兄弟节点',
      tdCycle && tdCycle.parentElement.children.length === 2);

    // 字号：比例由设置决定，上限由【页面基准字号】决定 —— 与所在元素无关
    const style = tail.getAttribute('style') || '';
    ok('[' + mode + '] 译文块写入了字号变量', /--ct-scale:/.test(style) && /--ct-cap:/.test(style), style);
    // 期望值直接取自默认设置，避免默认值改了而断言还停在旧数字上
    const defScale = Math.round(CT.DEFAULT_SETTINGS.fontSizeScale * 100) + '%';
    ok('[' + mode + '] 字号比例应用了默认值 ' + defScale,
      new RegExp('--ct-scale:\\s*' + defScale).test(style), style);

    const capOf = (el) => {
      const n = (el.getAttribute('style') || '').match(/--ct-cap:\s*([\d.]+)px/);
      return n ? Number(n[1]) : NaN;
    };
    const capP = capOf(tail);
    ok('[' + mode + '] 字号上限是合法 px 值（11–18）',
      Number.isFinite(capP) && capP >= 11 && capP <= 18, String(capP));

    // 封顶值必须与所在元素无关：<h1> 下的译文才不会被标题字号带飞
    const h1Tail = h1.lastElementChild;
    ok('[' + mode + '] <h1> 的译文同样追加在内部',
      !!h1Tail && h1Tail.classList.contains(CT.TRANS_CLASS) && h1Tail.parentElement === h1);
    ok('[' + mode + '] <h1> 与 <p> 的字号上限完全相同（标题不放大译文）',
      capOf(h1Tail) === capP, 'h1=' + capOf(h1Tail) + ' p=' + capP);
  }

  if (mode === 'replace') {
    ok('[' + mode + '] 纯文本段落已被整体替换', pFirst.textContent.indexOf('【中文】') === 0, pFirst.textContent.slice(0, 30));

    /*
     * v1.7 的行为变更：含链接/代码的元素**不再被整体替换**。
     * ------------------------------------------------------------------
     * 旧实现一律 `el.textContent = 译文`，于是夹具里
     * 「See the <a>delivery handbook</a> for the full checklist.」那个链接
     * 被无声吃掉 —— 用户读到译文，却再也点不进那份文档。
     *
     * 新行为：这类元素改为在原文之后挂译文。所以 replace 模式下
     * **会**出现 1 个译文块，那正是降级分支走到的证据。
     * 这个数字从 0 变成 1 不是回归，是有意的。
     */
    const keepBlocks = doc.querySelectorAll('.' + CT.TRANS_CLASS);
    eq('[' + mode + '] 恰好 1 个译文块（含 <a> 的那一段降级而来）', keepBlocks.length, 1);
    ok('[' + mode + '] 该块带降级标记 ct-trans--keep',
      keepBlocks.length === 1 && keepBlocks[0].classList.contains('ct-trans--keep'),
      keepBlocks.length === 1 ? keepBlocks[0].className : '(无)');
    ok('[' + mode + '] 含链接段落的原文没被动过（链接还在且可点）',
      !!doc.querySelector('main > p a[href="https://example.com/handbook"]'));
    ok('[' + mode + '] 降级计数被记录',
      CT.renderer.getStats().replaceDegraded >= 1,
      String(CT.renderer.getStats().replaceDegraded));

    // 纯文本元素仍不产生任何译文块 —— 这条是旧断言的正确部分，保留
    const plainOnly = Array.from(doc.querySelectorAll('main > p')).every((p) => {
      if (p.querySelector('a,button,code,kbd,samp,var,abbr,time')) return true;
      return p.querySelector(':scope > .' + CT.TRANS_CLASS) === null;
    });
    ok('[' + mode + '] 纯文本段落内不残留译文块', plainOnly);
  }

  if (mode === 'hover') {
    ok('[' + mode + '] 已标记悬停类', pFirst.classList.contains('ct-hover'));
    ok('[' + mode + '] 已写入 CSS 变量', (pFirst.getAttribute('style') || '').indexOf('--ct-tip') >= 0);
    eq('[' + mode + '] 不在 DOM 里插入译文块', doc.querySelectorAll('.' + CT.TRANS_CLASS).length, 0);
  }

  // 幂等：再采集一次不应产生新单元
  const again = CT.renderer.collectUnits(doc.body, settings);
  eq('[' + mode + '] 重复采集不产生新单元', again.length, 0);

  // 还原
  CT.renderer.restoreAll();
  ok('[' + mode + '] 还原后 DOM 与原始完全一致', doc.body.innerHTML === before,
    '还原后：' + doc.body.innerHTML.slice(0, 120));
  eq('[' + mode + '] 还原后无残留译文块', doc.querySelectorAll('.' + CT.TRANS_CLASS).length, 0);
  eq('[' + mode + '] 还原后无残留标记属性', doc.querySelectorAll('[data-ct-src]').length, 0);
}

/* ================================================================== */
/* 4. 增量采集范围                                                     */
/* ================================================================== */

section('四、增量采集');

{
  const { w, CT } = boot(ARTICLE);
  const doc = w.document;
  const settings = Object.assign({}, CT.DEFAULT_SETTINGS, { targetLang: 'zh-CN' });

  const holder = doc.createElement('div');
  holder.innerHTML = '<p>Freshly injected paragraph about deployment automation.</p>';
  doc.querySelector('main').appendChild(holder);

  const units = CT.renderer.collectUnits(holder, settings);
  eq('只采集新增子树（1 条）', units.length, 1);
  ok('  采集到的是新段落', units[0].text.indexOf('Freshly injected') === 0);
}

/* ================================================================== */
/* 5. 遗留节点处理（扩展重载后的场景）                                 */
/* ================================================================== */

section('五、遗留译文块处理');

{
  const { w, CT } = boot(ARTICLE);
  const doc = w.document;
  const settings = Object.assign({}, CT.DEFAULT_SETTINGS, { targetLang: 'zh-CN' });

  // 模拟「扩展被重新加载，上一轮注入的译文块还在页面上」的情况：
  // 这些节点没有任何注册表记录，必须靠类名兜底识别与清理。
  const stale = doc.createElement('div');
  stale.className = CT.TRANS_CLASS;
  stale.textContent = '上一轮遗留的译文块';
  doc.querySelector('main').appendChild(stale);

  const units = CT.renderer.collectUnits(doc.body, settings);
  ok('遗留译文块未被当作待翻译单元', !units.some((u) => u.text.indexOf('上一轮遗留') >= 0));

  CT.renderer.restoreAll();
  eq('restoreAll 清掉了遗留译文块', doc.querySelectorAll('.' + CT.TRANS_CLASS).length, 0);
  eq('正文内容未被误删', doc.querySelectorAll('main > p').length, 2);
}

/* ================================================================== */
/* 5b. 插入方式与译文字号                                              */
/* ================================================================== */

section('五之二、插入方式与译文字号');

{
  // 默认值必须是「内部追加」——整个「不改变页面结构」的承诺挂在这一项上
  const { CT } = boot(ARTICLE);
  eq('默认插入方式为 auto（按 display 智能分流）', CT.DEFAULT_SETTINGS.insertMode, 'auto');
  eq('默认字号比例为 80%', CT.DEFAULT_SETTINGS.fontSizeScale, 0.8);
  eq('默认译文样式为 plain（不加边框与标记）', CT.DEFAULT_SETTINGS.transStyle, 'plain');
  ok('插入方式选项里有 sibling 可切回', CT.INSERT_MODES.some((m) => m.id === 'sibling'));
  ok('插入方式选项里有 auto', CT.INSERT_MODES.some((m) => m.id === 'auto'));
  ok('译文样式选项里有 plain 与 accent',
    CT.TRANS_STYLES.some((m) => m.id === 'plain') && CT.TRANS_STYLES.some((m) => m.id === 'accent'));
}

/* ================================================================== */
/* 5b-2. 页内开关的默认值与常量                                        */
/* ================================================================== */

section('五之二·补、页内开关默认值与常量');
{
  const { CT } = boot(ARTICLE);

  // 控件默认要出现：它是「装完就能看到扩展在工作」的唯一页内凭据
  eq('默认显示页内开关', CT.DEFAULT_SETTINGS.toggleVisible, true);
  // 但默认不收起 —— 收起态的语义要用户自己选，不该一上来就藏起来
  eq('默认不收起成圆点', CT.DEFAULT_SETTINGS.toggleDefaultCollapsed, false);
  // 站点记忆默认关闭：默认行为应该是「跟全局设置走」，不偷偷记用户的选择
  eq('默认不启用站点记忆', CT.DEFAULT_SETTINGS.siteMemory, false);

  eq('控件类名常量已定义', CT.TOGGLE_CLASS, 'ct-toggle');
  ok('存储键已定义且不进 settings',
    !!CT.STORAGE && CT.STORAGE.TOGGLE_UI === 'ct.toggleUI'
      && CT.STORAGE.SITE_STATE === 'ct.siteState',
    JSON.stringify(CT.STORAGE));
  ok('存储键没有被混进设置对象',
    CT.DEFAULT_SETTINGS['ct.toggleUI'] === undefined
      && CT.DEFAULT_SETTINGS.toggleUI === undefined);
  ok('open-options 消息已定义', CT.MSG.OPEN_OPTIONS === 'ct:open-options');
}

/* ================================================================== */
/* 5c. 插入点决策：按 computed display 分流                            */
/* ================================================================== */

section('五之三、插入点决策');

{
  const { w, CT } = boot(LAYOUT);
  const doc = w.document;
  const R = CT.renderer;
  const auto = { insertMode: 'auto' };
  const at = (id) => doc.getElementById(id);

  // ① 横向弹性容器：追加进去会被平分宽度 → 必须改插到容器之后
  eq('横向弹性容器 → 插到容器之后', R.placementFor(at('row'), auto).kind, 'after');
  // 容器允许换行时不需要挂到外面：独占一整行即可，归属关系还在容器内
  const planWrap = R.placementFor(at('rowwrap'), auto);
  eq('可换行弹性容器 → 内部追加', planWrap.kind, 'inside');
  eq('  并带上「独占整行」标记', planWrap.wrap, true);
  // 纵向弹性容器本来就往下加一行
  eq('纵向弹性容器 → 内部追加', R.placementFor(at('col'), auto).kind, 'inside');
  // 网格容器会自动加行，配合 CSS 的 grid-column: 1/-1 横跨整行
  eq('网格容器 → 内部追加', R.placementFor(at('grid'), auto).kind, 'inside');

  // ② 内联级宿主：块级译文会打断行盒
  eq('内联块宿主 → 内联译文', R.placementFor(at('pill'), auto).kind, 'inline');

  // ③ 普通块与结构受限容器
  eq('普通块 → 内部追加', R.placementFor(at('plain'), auto).kind, 'inside');
  eq('表格单元格 → 内部追加', R.placementFor(at('cell'), auto).kind, 'inside');
  eq('列表项 → 内部追加', R.placementFor(at('item'), auto).kind, 'inside');
  eq('绝对定位元素 → 内部追加（不影响兄弟节点）',
    R.placementFor(at('floating'), auto).kind, 'inside');
  // 卡片是弹性项，但它自身的 display 是 block —— 追加进去只是卡片自身变高，
  // 不会让同一行的其他卡片重新分配宽度，因此仍走内部追加
  eq('弹性行里的普通块卡片 → 内部追加', R.placementFor(at('card'), auto).kind, 'inside');

  // ④ 用户显式指定时完全照办
  eq('insertMode=sibling → 一律插到之后',
    R.placementFor(at('row'), { insertMode: 'sibling' }).kind, 'after');
  eq('insertMode=inside → 一律内部追加',
    R.placementFor(at('row'), { insertMode: 'inside' }).kind, 'inside');
  // 但 HTML 结构上的硬约束不能被设置绕过：<tr> 里插兄弟节点会直接坏掉
  eq('表格单元格不受 insertMode 影响（硬约束优先）',
    R.placementFor(at('cell'), { insertMode: 'sibling' }).kind, 'inside');
  eq('列表项不受 insertMode 影响',
    R.placementFor(at('item'), { insertMode: 'sibling' }).kind, 'inside');
}

{
  // --- 渲染形态：三条分支各自产出正确的节点与类名 ---
  const { w, CT } = boot(LAYOUT);
  const doc = w.document;
  const R = CT.renderer;
  const settings = Object.assign({}, CT.DEFAULT_SETTINGS, {
    targetLang: 'zh-CN', displayMode: 'below', insertMode: 'auto', transStyle: 'plain'
  });

  const units = R.collectUnits(doc.body, settings);
  for (const u of units) R.renderUnit(u.el, '【中文】', settings, u.hash, u.plan);

  const pill = doc.getElementById('pill');
  const pillNode = pill.lastElementChild;
  ok('内联宿主的译文是 <span>', !!pillNode && pillNode.tagName === 'SPAN');
  ok('  且带内联标记类', !!pillNode && pillNode.classList.contains('ct-trans--inl'));
  ok('  且不新增兄弟节点', pill.nextElementSibling === null || !pill.nextElementSibling.classList.contains(CT.TRANS_CLASS));

  const row = doc.getElementById('row');
  // 译文挂在容器【之后】，容器自身的子节点数一个都没多
  eq('横向弹性容器的子元素个数没变', row.children.length, 2);
  ok('横向弹性容器内部没有译文块', row.querySelector('.' + CT.TRANS_CLASS) === null);
  ok('译文挂在容器的下一个兄弟位置',
    !!row.nextElementSibling && row.nextElementSibling.classList.contains(CT.TRANS_CLASS),
    row.nextElementSibling ? row.nextElementSibling.className : 'null');

  // 默认（素净）样式：不加「译」标记、不加边框
  ok('素净样式带 ct-s-plain 类',
    [...doc.querySelectorAll('.' + CT.TRANS_CLASS)].every((n) => n.classList.contains('ct-s-plain')));
  ok('素净样式不带 accent 类',
    doc.querySelectorAll('.ct-s-accent').length === 0);

  // 还原干净
  R.restoreAll();
  eq('还原后无残留', doc.querySelectorAll('.' + CT.TRANS_CLASS).length, 0);
}

{
  // --- accent 样式：类名切换即可，不需要重建节点结构以外的任何东西 ---
  const { w, CT } = boot(LAYOUT);
  const doc = w.document;
  const R = CT.renderer;
  const settings = Object.assign({}, CT.DEFAULT_SETTINGS, {
    targetLang: 'zh-CN', displayMode: 'below', transStyle: 'accent'
  });
  const units = R.collectUnits(doc.body, settings);
  for (const u of units) R.renderUnit(u.el, '【中文】', settings, u.hash, u.plan);
  eq('accent 样式写入 ct-s-accent 类',
    doc.querySelectorAll('.' + CT.TRANS_CLASS + '.ct-s-accent').length, units.length);
  eq('accent 样式下不再带 plain 类', doc.querySelectorAll('.ct-s-plain').length, 0);
}

/* ================================================================== */
/* 5d. 噪声文本过滤（HTML 源码 / 序列化数据）                           */
/* ================================================================== */

section('五之四、噪声文本过滤');

{
  const { CT } = boot(ARTICLE);
  const D = CT.detector;

  const markupCases = [
    '</p></li><li><p>Move fast, build for the masses.</p></li></ol></div>',
    '<div class="job-desc"><p>Own the end to end experience.</p></div><p>Apply now</p>',
    '<li><p>Turn raw events into decisions.</p></li><li><p>Ship weekly.</p></li>'
  ];
  for (const t of markupCases) {
    ok('识别为 HTML 源码：' + t.slice(0, 30), D.looksLikeMarkup(t));
  }

  const proseCases = [
    'A ratio of 3 < 5 and 7 > 2 is common in prose with angle brackets.',
    'Use the <div> element to group related content together.',
    'Sugar < 5g per serving is the target for this product.',
    'The pointer moves left <- and right -> as you drag the slider.'
  ];
  for (const t of proseCases) {
    ok('不误判为源码：' + t.slice(0, 30), !D.looksLikeMarkup(t));
  }

  ok('识别 JSON-LD',
    D.looksLikeDataBlob('{"@type":"JobPosting","datePosted":"2026-09-11T00:00:00Z"}'));
  ok('识别普通序列化对象',
    D.looksLikeDataBlob('{"name":"Ada","role":"engineer","team":"platform","city":"Nanjing"}'));
  ok('正常含引号的英文不判为数据块',
    !D.looksLikeDataBlob('She said "hello" and later "goodbye" to the whole platform team.'));
  ok('短文本不误判', !D.looksLikeDataBlob('{"a":1}'));

  // 端到端：整块被拦在翻译之前，理由标记可用于排障
  eq('HTML 源码块不进入翻译',
    D.isTranslatableText('</p></li><li><p>Move fast, build for the masses.</p></li>', 'zh-CN', 2).reason,
    'markup');
  eq('JSON-LD 块不进入翻译',
    D.isTranslatableText('{"@type":"JobPosting","baseSalary":{"value":150000}}', 'zh-CN', 2).reason,
    'data-blob');
  eq('正常英文仍能通过', D.isTranslatableText('Build reliable pipelines.', 'zh-CN', 2).ok, true);

  // 夹具里的源码块与数据块都不得产出译文
  const { w: w2, CT: CT2 } = boot(LAYOUT);
  const doc2 = w2.document;
  const s2 = Object.assign({}, CT2.DEFAULT_SETTINGS, { targetLang: 'zh-CN' });
  const src = doc2.createElement('div');
  src.className = 'blob';
  src.textContent = '</p></li><li><p>Move fast, build for the masses.</p></li></ol>';
  doc2.body.appendChild(src);
  const units2 = CT2.renderer.collectUnits(doc2.body, s2);
  ok('源码块不在采集结果里', !units2.some((u) => u.el === src));
}

{
  // --- sibling 模式：原文元素自身盒子绝对不变，代价是容器多出兄弟节点 ---
  const { w, CT } = boot(ARTICLE);
  const doc = w.document;
  const settings = Object.assign({}, CT.DEFAULT_SETTINGS, {
    targetLang: 'zh-CN', displayMode: 'below', insertMode: 'sibling', fontSizeScale: 0.75
  });

  const pFirst = doc.querySelector('main > p');
  const mainKidsBefore = doc.querySelector('main').children.length;
  const pHTMLBefore = pFirst.innerHTML;

  const units = CT.renderer.collectUnits(doc.body, settings);
  for (const u of units) CT.renderer.renderUnit(u.el, '【中文】' + u.text.slice(0, 12), settings, u.hash);

  const sib = pFirst.nextElementSibling;
  ok('[sibling] 译文块插在原文之后', !!sib && sib.classList.contains(CT.TRANS_CLASS));
  ok('[sibling] 原文元素自身内容完全没被动过', pFirst.innerHTML === pHTMLBefore,
    '现在：' + pFirst.innerHTML.slice(0, 60));
  ok('[sibling] 原文内部没有译文块', pFirst.querySelector('.' + CT.TRANS_CLASS) === null);
  // 这正是 sibling 模式的已知代价，文档里写清楚了，这里把它钉成断言
  ok('[sibling] 容器子元素个数确实翻倍（该模式的代价）',
    doc.querySelector('main').children.length > mainKidsBefore,
    mainKidsBefore + ' -> ' + doc.querySelector('main').children.length);
  // td 不受 insertMode 影响：插兄弟会直接破坏表格结构
  const tdCycle = Array.from(doc.querySelectorAll('td')).find((x) => x.textContent.indexOf('Cycle') >= 0);
  ok('[sibling] <td> 仍然内部追加（结构强制，不随设置改变）',
    !!tdCycle && doc.querySelectorAll('tr')[1].children.length === 2);
  ok('[sibling] 字号比例跟随设置变为 75%',
    /--ct-scale:\s*75%/.test(sib.getAttribute('style') || ''), sib.getAttribute('style'));

  // 还原必须依然精确 —— 两种插入方式都不能留下痕迹
  CT.renderer.restoreAll();
  eq('[sibling] 还原后无残留译文块', doc.querySelectorAll('.' + CT.TRANS_CLASS).length, 0);
  ok('[sibling] 还原后原文元素内容原样', pFirst.innerHTML === pHTMLBefore);
}

{
  // --- 字号就地刷新：不重译，只改写译文块上的变量 ---
  const { w, CT } = boot(ARTICLE);
  const doc = w.document;
  const settings = Object.assign({}, CT.DEFAULT_SETTINGS, { targetLang: 'zh-CN', displayMode: 'below' });

  const units = CT.renderer.collectUnits(doc.body, settings);
  for (const u of units) CT.renderer.renderUnit(u.el, '【中文】' + u.text.slice(0, 12), settings, u.hash);

  const pFirst = doc.querySelector('main > p');
  const node = pFirst.lastElementChild;
  ok('刷新前为默认 ' + Math.round(CT.DEFAULT_SETTINGS.fontSizeScale * 100) + '%',
    new RegExp('--ct-scale:\\s*' + Math.round(CT.DEFAULT_SETTINGS.fontSizeScale * 100) + '%')
      .test(node.getAttribute('style') || ''));

  const next = Object.assign({}, settings, { fontSizeScale: 1.05 });
  const n = CT.renderer.refreshFontScale(next);

  eq('就地刷新覆盖了全部译文块', n, units.length);
  ok('刷新后变为 105%', /--ct-scale:\s*105%/.test(node.getAttribute('style') || ''),
    node.getAttribute('style'));
  ok('刷新后仍是同一个节点（没有重建）', pFirst.lastElementChild === node);
  ok('刷新后页面没有多出元素', doc.querySelectorAll('.' + CT.TRANS_CLASS).length === units.length);

  // 刷新后重新采集仍应是幂等的 —— 说明 extractText 正确扣掉了自家译文
  eq('刷新后重复采集不产生新单元', CT.renderer.collectUnits(doc.body, next).length, 0);
  eq('extractText 不含自家译文', CT.renderer.extractText(pFirst).indexOf('【中文】'), -1);
}

{
  // --- 字号比例越界时被钳制，不能把页面搞乱 ---
  const { w, CT } = boot(ARTICLE);
  const doc = w.document;
  const settings = Object.assign({}, CT.DEFAULT_SETTINGS, {
    targetLang: 'zh-CN', displayMode: 'below', fontSizeScale: 99
  });
  const p = doc.querySelector('main > p');
  CT.renderer.renderUnit(p, '【中文】测试', settings, 'h');
  ok('越界字号比例被钳制到 150%', /--ct-scale:\s*150%/.test(p.lastElementChild.getAttribute('style') || ''),
    p.lastElementChild.getAttribute('style'));
}

/* ================================================================== */
/* 6. 工具函数                                                         */
/* ================================================================== */

section('六、工具函数');

{
  const { CT } = boot(ARTICLE);

  eq('语言归一化 en-US → en', CT.settings.normalizeLang('en-US'), 'en');
  eq('语言归一化 zh-Hant → zh-TW', CT.settings.normalizeLang('zh-Hant'), 'zh-TW');
  eq('简繁视为同语言', CT.settings.isSameLanguage('zh-TW', 'zh-CN'), true);
  eq('en 与 zh-CN 不同语言', CT.settings.isSameLanguage('en', 'zh-CN'), false);

  eq('黑名单精确匹配', CT.settings.isBlockedHost('example.com', ['example.com']), true);
  eq('黑名单通配匹配', CT.settings.isBlockedHost('a.b.example.com', ['*.example.com']), true);
  eq('黑名单不误伤同后缀', CT.settings.isBlockedHost('notexample.com', ['example.com']), false);

  const h1 = CT.settings.hash('hello world');
  eq('哈希稳定', h1, CT.settings.hash('hello world'));
  ok('哈希区分不同输入', h1 !== CT.settings.hash('hello worlD'));

  const merged = CT.settings.merge(CT.DEFAULT_SETTINGS, { targetLang: 'zh-TW', displayMode: null });
  eq('合并覆盖已提供字段', merged.targetLang, 'zh-TW');
  eq('合并忽略 null 字段', merged.displayMode, CT.DEFAULT_SETTINGS.displayMode);
}

/* ================================================================== */
/* 7. 多语言互译                                                       */
/* ================================================================== */

section('七、多语言互译（语言表 / 简繁正字法 / 整页判据）');

{
  const { CT } = boot(ARTICLE);

  /* ---- 语言表 ---- */

  ok('语言表条目数 ≥ 40（多语言互译的下限，2 种中文显然不够）',
    CT.LANGS.length >= 40, '实际 ' + CT.LANGS.length);

  const ids = CT.LANGS.map((l) => l.id);
  eq('语言 id 无重复', new Set(ids).size, ids.length);

  const badLabel = CT.LANGS.filter((l) => !l.label || !String(l.label).trim());
  eq('每个条目都有 label', badLabel.length, 0);

  const badMark = CT.LANGS.filter((l) => !l.mark);
  eq('每个条目都有 mark（译文块左上角那个标记）', badMark.length, 0);
  // 标记要能塞进 12px 见方：中文单字、拉丁两字母、其他语种两三个字符
  const longMark = CT.LANGS.filter((l) => [...String(l.mark)].length > 3);
  eqj('mark 不超过 3 个码位', longMark.map((l) => l.id), []);

  // 源语言比目标语言多一个「自动检测」
  eq('源语言 = 自动检测 + 语言表', CT.SOURCE_LANGS.length, CT.LANGS.length + 1);
  eq('源语言第一项是 auto', CT.SOURCE_LANGS[0].id, 'auto');
  eq('目标语言与语言表同一张表', CT.TARGET_LANGS, CT.LANGS);
  eq('目标语言不含 auto（不能「翻成自动」）',
    CT.TARGET_LANGS.some((l) => l.id === 'auto'), false);

  /* ---- 语言名 / 标记 ---- */

  eq('langLabel(zh-CN)', CT.langLabel('zh-CN'), '简体中文');
  eq('langLabel(ja) 保留母语原文', CT.langLabel('ja'), '日语 日本語');
  eq('langLabel 未知 id 原样返回（不返回空串）', CT.langLabel('xx'), 'xx');
  eq('langLabel(undefined) 不抛错', CT.langLabel(undefined), '');

  eq('langMark(ja) 取目标语言首字', CT.langMark('ja'), '日');
  eq('langMark(en) 取两字母', CT.langMark('en'), 'EN');
  eq('langMark 未知 id 兜底为「译」', CT.langMark('xx'), '译');

  eq('langShort 去掉母语原文', CT.langShort('ja'), '日语');
  eq('langShort 对无空格标签原样返回', CT.langShort('zh-CN'), '简体中文');
  eq('langShort(auto) 给中文可读名', CT.langShort('auto'), '自动');
  // 统计格只有 88px 宽，「英语→简体中文」这种短名组合才放得下
  ok('langShort 比 langLabel 短或等长（弹窗统计格是窄的）',
    CT.langShort('en').length <= CT.langLabel('en').length);

  /* ---- 简繁锚点表的自洽性 ---- */
  /* 手写两条字串时最容易一侧多一个、另一侧少一个，那种失衡不报错，
     只会让判定悄悄偏向一侧。这里把四条不变量钉死。 */

  const pairs = CT.VARIANT_PAIRS;
  ok('锚点表规模够用（≥ 100 对）', pairs.length >= 100, '实际 ' + pairs.length);

  const sameForm = pairs.filter((p) => p[0] === p[1]);
  eqj('没有「简繁同形」的废对', sameForm.map((p) => p[0]), []);

  const left = pairs.map((p) => p[0]).join('');
  const right = pairs.map((p) => p[1]).join('');
  eq('左侧长度等于对数（每对恰好一个字）', left.length, pairs.length);
  eq('右侧长度等于对数', right.length, pairs.length);
  eq('左侧无重复字', new Set([...left]).size, left.length);
  eq('右侧无重复字', new Set([...right]).size, right.length);

  // 交集非空 = 某个字既被当成简体锚点又被当成繁体锚点，
  // 它投的票会同时给两边，判定被稀释成随机
  const overlap = [...new Set([...left].filter((c) => right.indexOf(c) >= 0))];
  eqj('两侧锚点无交集', overlap, []);

  /* ---- scriptVariant ---- */

  eq('繁体文本判为 hant',
    CT.settings.scriptVariant('這是一個測試，我們會說話，請確認。'), 'hant');
  eq('简体文本判为 hans',
    CT.settings.scriptVariant('这是一个测试，我们会说话，请确认。'), 'hans');
  eq('不含锚点 → unknown', CT.settings.scriptVariant('123 ABC'), 'unknown');
  eq('中英混排但无中文锚点 → unknown', CT.settings.scriptVariant('Hello 世界'), 'unknown');
  eq('空串 → unknown', CT.settings.scriptVariant(''), 'unknown');
  eq('null → unknown', CT.settings.scriptVariant(null), 'unknown');

  /* ---- targetVariant ---- */

  eq('目标 zh-CN → hans', CT.settings.targetVariant('zh-CN'), 'hans');
  eq('目标 zh-TW → hant', CT.settings.targetVariant('zh-TW'), 'hant');
  eq('目标 zh-Hant 归一化后 → hant', CT.settings.targetVariant('zh-Hant'), 'hant');
  eq('非中文目标 → 空串', CT.settings.targetVariant('en'), '');

  /* ---- isSameLanguageStrict：简繁算不同语言 ---- */

  eq('严格口径：简繁不同语言',
    CT.settings.isSameLanguageStrict('zh-CN', 'zh-TW'), false);
  eq('宽松口径：简繁同语言（逐段判定仍用这条）',
    CT.settings.isSameLanguage('zh-CN', 'zh-TW'), true);
  eq('严格口径：en 与 en 相同',
    CT.settings.isSameLanguageStrict('en-US', 'en'), true);
  eq('严格口径：auto 不参与比较',
    CT.settings.isSameLanguageStrict('auto', 'en'), false);

  /* ---- needsPageTranslation：整页「要不要翻」的总判据 ---- */

  const N = CT.settings.needsPageTranslation;
  eq('源 auto → 要翻（交给逐段判定兜住）', N('auto', 'zh-CN'), true);
  eq('en → ja：要翻', N('en', 'ja'), true);
  eq('ja → en：要翻（反向互译也要成立）', N('ja', 'en'), true);
  eq('en → en：不翻', N('en', 'en'), false);
  eq('ja → ja：不翻', N('ja', 'ja'), false);
  eq('目标 auto：不翻', N('en', 'auto'), false);
  eq('目标为空：不翻', N('en', ''), false);

  // 简繁这一格：用户把目标设成繁体中文，在简体页面上必须真的转一遍，
  // 否则「多语言互译」里的这一格是死的
  eq('简体页 + 目标繁体 → 要翻', N('zh-CN', 'zh-TW', 'hans'), true);
  eq('简体页 + 目标简体 + 页面是简体 → 不翻', N('zh-CN', 'zh-CN', 'hans'), false);
  eq('繁体页 + 目标简体 → 要翻', N('zh-TW', 'zh-CN', 'hant'), true);
  // 页面被归一化成 zh-CN、但正文其实是繁体（lang="zh" 的传统站点）：
  // 正字法这一票在这里才起作用
  eq('同标为 zh-CN 但正文是繁体 + 目标简体 → 要翻', N('zh-CN', 'zh-CN', 'hant'), true);
  eq('同标为 zh-TW 但正文是简体 + 目标繁体 → 要翻', N('zh-TW', 'zh-TW', 'hans'), true);
  // 无法判断正字法时不该硬翻，避免整页白跑一趟
  eq('正字法未知且语种相同 → 不翻', N('zh-CN', 'zh-CN', 'unknown'), false);
  eq('正字法缺失且语种相同 → 不翻', N('zh-CN', 'zh-CN', undefined), false);
}

/* ================================================================== */
/* 8. 裁切容器                                                         */
/* ================================================================== */

section('八、裁切容器：译文不能落进被裁掉的子树');

{
  const { w, CT } = boot(CLIP);
  const doc = w.document;
  const R = CT.renderer;
  const CFG = CT.settings.merge(CT.DEFAULT_SETTINGS, {
    targetLang: 'zh-CN', sourceLang: 'en', displayMode: 'below',
    insertMode: 'auto', fontSizeScale: 0.8
  });
  const L = (id) => R.layoutOf(doc.getElementById(id));
  const P = (id) => doc.getElementById(id);

  /* ---- 判定层 ---- */
  /* 「overflow:hidden」单独一条不足以说明内容会被藏起来：没有尺寸限制时
     它只是不让溢出可见，内容照样排得开。真正的隐形杀手是 line-clamp 与 max-height。 */

  eq('line-clamp 判为裁切容器', R.clipsContent(L('clamp')), true);
  eq('max-height 判为裁切容器', R.clipsContent(L('maxh')), true);
  // max-height:0 只算「折叠」，不算「裁切」—— 两条判据刻意分开：
  // 折叠是「内容此刻完全不可见，翻了也白翻」，裁切是「内容可见但会被截断，译文得挪出去」。
  // 合在一起的话，零高度折叠区会走进「挪到容器之后」这条分支，
  // 于是每个收起的摘要旁边都凭空多出一段译文。
  eq('max-height:0 不算裁切容器（只算折叠）', R.clipsContent(L('fold')), false);
  eq('只有 overflow:hidden、没有尺寸限制 → 不算裁切容器',
    R.clipsContent(L('onlyhidden')), false);
  eq('max-height:0 被判为折叠', R.collapsesContent(L('fold')), true);
  eq('max-height:44px 不算折叠', R.collapsesContent(L('maxh')), false);
  eq('只有 overflow:hidden 时不算折叠', R.collapsesContent(L('onlyhidden')), false);

  eq('clipInfo 找到最近一层裁切容器', R.clipInfo(P('clampP')).clip.id, 'clamp');
  // 套两层很常见：外层 max-height 折叠整块、内层 line-clamp 截摘要。
  // 挂在里层仍然会被外层裁掉，所以必须取【最外层】。
  eq('嵌套时取最外层裁切容器', R.clipInfo(P('nestedP')).clip.id, 'outer');
  eq('嵌套时内层不进 clip 字段', R.clipInfo(P('nestedP')).clip.id === 'inner', false);
  eq('不在裁切容器里时 clip 为 null', R.clipInfo(P('plainP')).clip, null);
  eq('零高度折叠区被标记为 collapsed', R.clipInfo(P('foldP')).collapsed, true);
  eq('普通裁切容器不标记 collapsed', R.clipInfo(P('clampP')).collapsed, false);

  /* ---- 放置决策（★ P-1 后：静态级只打标，一个字节都不动 DOM）----
   * ==================================================================
   * ★ 免检通道清零（P-1 / 2026-09-29）★
   *
   * 旧口径断言的是「line-clamp 内的单元 → after + anchor=容器 + reason=clipped」。
   * 那**正是免检通道的形状**：静态判据直接产出一次不可逆的归属搬迁，而且
   * 它不打 risk 标，第二级几何判决从不回看它。
   *
   * 新口径断言的是**不变量本身**：静态级只负责「打标」，搬不搬交给第二级。
   * 这比原来的症状断言更严 —— 原来的断言在「静态判据误报」时也是绿的。
   */
  const plan = (id) => R.placementFor(P(id), CFG);

  eq('line-clamp 内的单元：静态级不再外挪', plan('clampP').kind, 'inside');
  eq('  ↳ 打上裁切标（交由第二级几何判决）',
    plan('clampP').risk, 'ancestor-clipped');
  eq('  ↳ 静态级不再给出搬迁锚点', plan('clampP').anchor, undefined);
  eq('  ↳ 静态级不再声称「已救回」（reason 不再有 clipped）',
    plan('clampP').reason, undefined);

  eq('max-height 内的单元同样只打标', plan('maxhP').kind, 'inside');
  eq('  ↳ 同一个标', plan('maxhP').risk, 'ancestor-clipped');

  eq('嵌套裁切容器内的单元只打标', plan('nestedP').kind, 'inside');
  eq('  ↳ 同一个标', plan('nestedP').risk, 'ancestor-clipped');

  eq('零高度折叠区：就地追加 + 标记 collapsed 由调用方丢弃',
    plan('foldP').kind, 'inside');
  eq('  ↳ collapsed 标记为 true', plan('foldP').collapsed, true);

  /* <td> 收不下块级兄弟：旧实现在这里返 `clipped-degraded`。
   * P-1 之后它不再有专门分支 —— 静态级一律只打标；若它真被裁且
   * relocate 的 canPlaceAfter 判定挪不出去，由第二级计入 clipUnresolved，
   * 结果是「留在原地 + 如实上报」，与旧的就地退化为同一结果但更诚实。 */
  eq('被裁切的 <td> 里的单元也只打标（不再有 clipped-degraded 专用分支）',
    plan('cellP').kind, 'inside');
  eq('  ↳ 同一个标', plan('cellP').risk, 'ancestor-clipped');

  // 用户显式 insertMode 仍被尊重 —— 但静态级一样只打标、不外挪
  const forced = CT.settings.merge(CFG, { insertMode: 'inside' });
  eq('用户选「总是内部追加」时，静态级照样只打标',
    R.placementFor(P('clampP'), forced).kind, 'inside');
  const sib = CT.settings.merge(CFG, { insertMode: 'sibling' });
  eq('用户选「插到原文之后」时，静态级照办（但同样只打标不外挪）',
    R.placementFor(P('clampP'), sib).kind, 'after');
  eq('  ↳ 锚点是单元自身（不是容器外）',
    R.placementFor(P('clampP'), sib).anchor.id, 'clampP');
  eq('  ↳ 裁切标照旧带上', R.placementFor(P('clampP'), sib).risk, 'ancestor-clipped');

  /* ---- 采集层：零高度折叠区不翻 ---- */

  const units = R.collectUnits(doc.body, CFG);
  const ids = units.map((u) => u.el.id);
  ok('零高度折叠区里的段落不进采集结果',
    ids.indexOf('foldP') < 0, '实际采到 ' + JSON.stringify(ids));
  ok('正常段落照常被采集', ids.indexOf('clampP') >= 0);
  ok('max-height 容器里的段落照常被采集', ids.indexOf('maxhP') >= 0);

  /* ---- 渲染层：DOM 落地结果（★ P-1 后必须分两段看）----
   * ==================================================================
   * P-1 之后，「译文最终落在哪」不再由第一级决定。所以：
   *   第一段（本节）：渲染完这一瞬，译文**就地**落在容器内 —— 这是设计，不是缺陷；
   *   第二段（几何判决）：verifyBatch 用真实矩形决定搬不搬。
   *
   * ⚠️ **jsdom 复现不了第二段**：它没有布局引擎，getBoundingClientRect()
   * 恒为全零，escapeAnchor 找不到任何「几何上确实切掉了译文」的层，
   * 搬迁只会得到 unresolved —— 与真实浏览器里的结论无关。
   * 这正是 L-17 那条纪律的场景：**jsdom 测不到的呈现层，必须有静态门禁 +
   * 真实浏览器验证**。本行为的权威证据是：
   *   · tools/probe-clip-channel-ab.mjs（真实 Chromium，新旧对照）
   *   · bash tools/bench-layout.sh（真实 Chrome，布局基准）
   * 本节只钉「第一级不动 DOM」这条不变量。 */

  for (const u of units) {
    R.renderUnit(u.el, '【译文】' + u.text.slice(0, 12), CFG, u.hash, u.plan);
  }

  const transIn = (id) => P(id).querySelectorAll('.' + CT.TRANS_CLASS).length;
  eq('渲染完这一瞬：译文就地落在 line-clamp 容器内（第一级不搬）',
    transIn('clamp'), 1);
  eq('渲染完这一瞬：译文就地落在 max-height 容器内', transIn('maxh'), 1);
  eq('渲染完这一瞬：译文就地落在最外层裁切容器内', transIn('outer'), 1);
  eq('零高度折叠区一段不翻（采集层已丢弃该单元）', transIn('fold'), 0);

  // ★ P-1：rescuedFromClip 的口径已从「声明」改为「结果」——
  // 第一级跑完（渲染阶段）之后它必须仍是 0：静态判据不再声称「已救回」。
  // 它变正数必须伴随一次**复验通过的搬迁**（见 relocate）。
  eq('渲染阶段结束后 rescuedFromClip 仍为 0（计数点已移到第二级）',
    R.getStats().rescuedFromClip, 0);
  eq('  ↳ 对应地，这些单元被第一级记为「值得怀疑」（clamp/maxh/嵌套/td ≥ 4 条）',
    R.getStats().riskSuspect >= 4, true);

  /* ---- 同一锚点多条译文不能逆序 ---- */
  /* chipA / chipB 自身都是横向弹性容器，safeAnchor 会一路走到共同祖先
     #rowshare，于是两条译文共用一个锚点。若每次只插到 anchor.nextSibling，
     先 A 后 B 会得到 anchor, B, A —— 整个页面的译文顺序全部颠倒。 */

  const sibs = [];
  for (let n = P('rowshare').nextElementSibling;
    n && n.classList && n.classList.contains(CT.TRANS_CLASS);
    n = n.nextElementSibling) {
    sibs.push(n);
  }
  eq('共用锚点的两条译文都落在锚点之后', sibs.length, 2);
  ok('共用锚点时译文顺序与原文顺序一致（未逆序）',
    sibs.length === 2
    && sibs[0].textContent.indexOf('Engineer') >= 0
    && sibs[1].textContent.indexOf('Designer') >= 0,
    sibs.map((n) => n.textContent).join(' | '));

  /* ---- 换模式时裁切结论必须作废 ---- */
  /* 站点点一下「展开全文」就会把 max-height 改掉，缓存下来的结论会变成脏数据。 */
  R.resetForModeChange();
  eq('换模式后 rescuedFromClip 归零', R.getStats().rescuedFromClip, 0);

  P('clamp').style.setProperty('overflow-y', 'visible');
  P('clamp').style.setProperty('-webkit-line-clamp', 'none');
  /* ★ P-1：这里断言的是「**裁切标**消失」，不是「所有标都消失」——
   * 站点撤掉 line-clamp 之后，`#clamp` 的 `overflow-x` 仍是 hidden
   * （夹具用简写 `overflow:hidden` 写的），横轴**确实还会裁**内容，
   * 所以第一级仍旧圈它是正确的（C-27 的元教训：**修的是判决，不是圈选**）。
   * 教训：断言必须跟着**语义**走。若照字面写「risk 必须等于 undefined」，
   * 这条断言就会变成在要求「圈选收窄」—— 那是把横轴裁切整条路径删掉。 */
  eq('站点撤掉裁切后，静态级不再打「裁切标」',
    R.placementFor(P('clampP'), CFG).risk === 'ancestor-clipped', false);
  eq('  ↳ 但宽口径圈选照旧（横轴仍是 hidden，仍值得怀疑）',
    R.placementFor(P('clampP'), CFG).risk, 'ancestor-constrained');
}

/* ================================================================== */

console.log('\n' + '─'.repeat(52));
console.log(failed === 0
  ? '全部通过：' + passed + ' 项断言'
  : '失败 ' + failed + ' 项，通过 ' + passed + ' 项');
process.exit(failed === 0 ? 0 : 1);
