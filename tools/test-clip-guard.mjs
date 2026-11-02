/*
 * 双语助手 · 译文可见性（遮挡）判据自检 —— v1.7.1
 * ==================================================================
 * 现场：招聘卡片标题旁的译文被截成 `高级成长产…`。
 *
 * 但**一张截图不足以唯一归因**：译文与原文同行，可能是
 *   M1 内联级宿主 + white-space:nowrap（译文被拉着永不换行）
 *   M2 单元自身 overflow:hidden + 定高（旧判据从 parentElement 起步，从不看自身）
 *   M3 祖先 overflow:hidden + 定高（旧判据只认 max-height 与 line-clamp）
 * 三条路径都会产生同一个画面。
 *
 * 所以 v1.7.1 的设计是「判据圈选 + 几何验真」：
 *   静态判据只回答「值得怀疑吗」，第二级用真实矩形判决「真的被裁了吗」。
 *
 * 这套断言钉的就是这个两级设计的两侧：
 *   一~三节 静态判据的判据表与圈选阶梯（必须能命中，也必须能不命中）
 *   四~六节 几何判决的四类失败、搬移的正确性、审计口径
 *
 * 【为什么必须测「不命中」】
 * 把三条判据补齐之后，假阳性会变得极高 —— 头像容器、清浮动的老代码都写着
 * overflow:hidden；能自由变宽的药丸写着 nowrap。若静态阶段就搬走，
 * 会用「拆散药丸行」换掉「标题被截断」—— 用旧缺陷换新缺陷。
 * 因此「A4 放得下就保持内联」这条不命中，与命中同样重要。
 *
 * 运行：
 *   npm run test:clip
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

/* ==================================================================
 * 布局预设
 * ------------------------------------------------------------------
 * jsdom 不实现真实的 CSS 计算：它既不展开 overflow 简写，也把
 * getBoundingClientRect 一律返回零矩形。所以这里**接管两处读口**：
 *
 *   getComputedStyle   → 按元素的 data-fx 返回预设布局特征
 *   getBoundingClientRect / scrollWidth / clientWidth → 按元素上的 __ctRect 等取值
 *
 * 这样每个断言都变成确定性的，而不是在跟 jsdom 的实现细节搏斗。
 * 被测代码读的就是这两个口子，因此这不算「绕过」—— 算把外部世界钉成常量。
 * ================================================================== */

const BASE = {
  display: 'block', overflowX: 'visible', overflowY: 'visible',
  maxHeight: 'none', height: 'auto', whiteSpace: 'normal',
  textOverflow: 'clip', position: 'static',
  flexDirection: 'row', flexWrap: 'nowrap', clamp: 'none'
};

const PRESETS = {
  plain: Object.assign({}, BASE),
  // 卡片标题的通行写法：单行 + 定高 + 省略号（截图现场）
  titleFix: Object.assign({}, BASE, {
    overflowX: 'hidden', overflowY: 'hidden', height: '24px',
    whiteSpace: 'nowrap', textOverflow: 'ellipsis'
  }),
  // 定高裁切容器，**不含** max-height、**不含** line-clamp（旧判据的盲区）
  clipAnc: Object.assign({}, BASE, {
    overflowX: 'hidden', overflowY: 'hidden', height: '40px'
  }),
  // 声明式硬约束容器（max-height）—— 与 clipAnc 的区别只在「声明」这一层，
  // 几何上完全一样。两者会被判成不同的 reason（clipped / spills-host），
  // 因为「站点在这条链上做了截断」与「译文自己没排下」对排障的价值不同。
  capAnc: Object.assign({}, BASE, {
    overflowX: 'hidden', overflowY: 'hidden', maxHeight: '40px'
  }),
  // line-clamp 摘要：v1.7.0 的既有分支，本轮行为必须**完全不变**
  clamp3: Object.assign({}, BASE, {
    overflowX: 'hidden', overflowY: 'hidden', maxHeight: '60px', clamp: '3'
  }),
  // 手风琴收起态，用 height:0 而不是 max-height:0
  collapsedByHeight: Object.assign({}, BASE, {
    overflowX: 'hidden', overflowY: 'hidden', height: '0px'
  }),
  collapsedByMaxHeight: Object.assign({}, BASE, {
    overflowX: 'hidden', overflowY: 'hidden', maxHeight: '0px'
  }),
  // 药丸：nowrap 但**没有**任何裁切 —— 能自由变宽，不该圈选
  pillFree: Object.assign({}, BASE, { display: 'inline-block', whiteSpace: 'nowrap' }),
  // 药丸：nowrap + 裁切 —— 会圈选，但仍由第二级量测判决
  pillClipped: Object.assign({}, BASE, {
    display: 'inline-block', whiteSpace: 'nowrap',
    overflowX: 'hidden', overflowY: 'hidden'
  }),
  inlineSpan: Object.assign({}, BASE, { display: 'inline' }),
  flexRow: Object.assign({}, BASE, { display: 'flex', flexWrap: 'nowrap' }),
  boxed: Object.assign({}, BASE, { display: '-webkit-box', overflowX: 'hidden', overflowY: 'hidden' }),

  /* ★ v1.7.6 C-27 现场（remoteok.com 的地区筛选下拉）★
   * 站点原样式：overflow:hidden 打底，再用 overflow-y:scroll 覆盖纵轴，
   * 配 max-height:500px —— 计算值是 overflow-x:hidden / overflow-y:scroll。
   * 259 个国家选项滚一滚全能看见，没有任何内容被裁掉。
   * 但「任一轴 hidden + 有 max-height」在旧判据里就等于裁切容器，
   * 于是 259 条译文被第一级无验真地搬到面板之外（reason: clipped），
   * 成为 .container 里紧跟 banner 的第一批常规流内容 ——
   * 一条 259 行、每行约 22px 的中文竖排列表把筛选栏与职位表整体顶下去。 */
  scrollPanel: Object.assign({}, BASE, {
    overflowX: 'hidden', overflowY: 'scroll', maxHeight: '500px'
  }),
  // 面板里的条目：站点写着 white-space:nowrap + text-overflow:ellipsis，
  // 自身没有任何 overflow —— 所以第一级只会给 self-nowrap 标，不该外挪
  panelItem: Object.assign({}, BASE, {
    whiteSpace: 'nowrap', textOverflow: 'ellipsis'
  }),
  // 站点折叠起来的容器（下拉面板 / 抽屉 / 非活动 tab）
  hiddenBox: Object.assign({}, BASE, { display: 'none' }),

  /* ★ 2026-09-29 新缺陷现场：用 CSS **模拟**表格 ★
   * 站点不写 <table>，而是把表格布局写在 div 上。tagName 全是 DIV，
   * 而 canPlaceAfter 过去只查 parent.tagName —— 于是对这类结构完全不拦。
   * 实测（真实 Chromium）：在 display:table-row 里插一个块级兄弟，
   * 浏览器会把它包成**匿名表格单元** → 译文与原单元**同一行、在右侧**，
   * 变成该行的第二列，而不是「下方」。
   *   div[display:table-row]  >  div[display:table-cell]  >  原文
   *   div[display:table-row]  >  div[display:table-cell]  >  译文   ← 成了第二列 */
  cssTableRow: Object.assign({}, BASE, { display: 'table-row' }),
  // 父是 table-cell 则**相反**：块级子元素落在单元格里是纵向堆叠，形态正确，
  // 不能一起拦 —— 否则会砍掉合法路径。下面那张对称断言就钉住这一条。
  cssTableCell: Object.assign({}, BASE, { display: 'table-cell' })
};

function fakeComputedStyle(el) {
  const fx = (el && el.getAttribute && el.getAttribute('data-fx')) || 'plain';
  const p = PRESETS[fx] || PRESETS.plain;
  return {
    display: p.display,
    flexDirection: p.flexDirection,
    flexWrap: p.flexWrap,
    position: p.position,
    overflowX: p.overflowX,
    overflowY: p.overflowY,
    maxHeight: p.maxHeight,
    height: p.height,
    whiteSpace: p.whiteSpace,
    textOverflow: p.textOverflow,
    getPropertyValue(k) { return k === '-webkit-line-clamp' ? p.clamp : ''; }
  };
}

/** 把矩形与溢出量接成「可被夹具赋值」的形式 */
function installGeom(w) {
  w.Element.prototype.getBoundingClientRect = function () {
    let r = this.__ctRect;
    if (typeof r === 'function') r = r(this);
    if (!r) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
    return {
      left: r[0], top: r[1], right: r[0] + r[2], bottom: r[1] + r[3],
      width: r[2], height: r[3], x: r[0], y: r[1]
    };
  };
  for (const prop of ['scrollWidth', 'clientWidth', 'scrollHeight', 'clientHeight']) {
    Object.defineProperty(w.Element.prototype, prop, {
      configurable: true,
      get() { return this['__' + prop] || 0; }
    });
  }
}

const FIXTURE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>遮挡判据夹具</title></head>
<body>
  <main id="root">
    <div id="plainHost" data-fx="plain"><p id="pPlain" data-fx="plain">Plain paragraph in plain block flow.</p></div>

    <div id="title" data-fx="titleFix"><span id="titleInner" data-fx="inlineSpan">Senior Growth Product Manager AI Native</span></div>

    <div id="clipWrap" data-fx="clipAnc">
      <div id="clipMid" data-fx="plain"><p id="pClip" data-fx="plain">Paragraph inside a fixed-height clipping ancestor.</p></div>
    </div>

    <div id="capWrap" data-fx="capAnc">
      <div id="capMid" data-fx="plain"><p id="pCap" data-fx="plain">Paragraph inside a max-height clipping ancestor.</p></div>
    </div>

    <div id="clampWrap" data-fx="clamp3"><p id="pClamp" data-fx="plain">Summary truncated by line clamp.</p></div>

    <div id="collapseWrap" data-fx="collapsedByHeight"><p id="pCollapse" data-fx="plain">Accordion collapsed via height zero.</p></div>

    <div id="pillRow" data-fx="flexRow">
      <span id="pillFree" data-fx="pillFree">Product Manager</span>
      <span id="pillClipped" data-fx="pillClipped">Marketing</span>
    </div>

    <div id="nowrapWrap" data-fx="pillFree"><p id="pNowrap" data-fx="plain">Paragraph under a nowrap ancestor with no clipping.</p></div>

    <!-- C-27 现场：定高 + 纵向可滚的下拉面板（内容滚得到，没有被裁） -->
    <div id="scrollPanel" data-fx="scrollPanel">
      <div id="spItem" data-fx="panelItem">Worldwide</div>
      <div id="spItemPlain" data-fx="plain">North America</div>
    </div>

    <!-- C-27 现场：站点折叠起来的容器（矩形恒为零，但「还没显示」≠「被裁掉」） -->
    <div id="hiddenWrap" data-fx="hiddenBox">
      <div id="hiddenItem" data-fx="panelItem">Hidden dropdown item</div>
    </div>

    <!-- C-27 现场·端到端：折叠着的下拉面板 —— remoteok 的真实时序是
         「面板关着的时候译文就被注入了」，此时所有矩形都是零。
         旧版判 invisible 并把 259 条译文全搬出面板；C-27 之后一条都不搬。
         刻意与 #hiddenWrap 分开：这条要跑完整的 placementFor→renderUnit
         →verifyBatch 链路，上面的 hiddenWrap 只做 judgeOne 单元级断言。 -->
    <div id="foldPanel" data-fx="hiddenBox">
      <div id="foldItem" data-fx="panelItem">Worldwide</div>
    </div>

    <table><tbody><tr><td id="cell" data-fx="titleFix">Table cell with fixed height.</td></tr></tbody></table>
  </main>
</body></html>`;

function boot() {
  const dom = new JSDOM(FIXTURE, {
    url: 'https://example.com/clip',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const ctx = dom.getInternalVMContext();
  const w = dom.window;
  // 必须在 renderer 之前接管读口：renderer 在调用时才取 window.getComputedStyle
  w.getComputedStyle = fakeComputedStyle;
  installGeom(w);

  for (const rel of [
    'shared/constants.js',
    'content/detector.js',
    'content/renderer.js'
  ]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), ctx, { filename: rel });
  }
  return { dom, w, CT: w.CT, R: w.CT.renderer, doc: w.document };
}

/*
 * 判据函数吃的是 layoutOf 的输出对象，字段是**短名**
 * （ox / oy / mh / h / clamp / ws / te）—— 这是刻意的内部约定：
 * 它每次都要在采集阶段被构造上百次，短名省的是构造与属性访问的开销。
 * 这里把短名翻译出来，好让断言读起来像在写 CSS，而不是在猜字段缩写。
 */
const L = (over) => {
  const o = over || {};
  return {
    display: o.display || 'block',
    fd: o.fd || 'row',
    fw: o.fw || 'nowrap',
    position: o.position || 'static',
    ox: o.overflowX || 'visible',
    oy: o.overflowY || 'visible',
    mh: o.maxHeight || 'none',
    h: o.height || 'auto',
    clamp: o.clamp || 'none',
    ws: o.whiteSpace || 'normal',
    te: o.textOverflow || 'clip'
  };
};

/* ================================================================== */
/* 一、判据表：constrainsContent / forcesNoWrap / collapsesContent      */
/* ================================================================== */

section('一、判据表（纯函数，用字面量布局对象喂）');
{
  const { R, doc } = boot();

  /* --- hasClipContext --- */
  eq('overflow visible → 无裁切上下文', R.hasClipContext(L({ overflowX: 'visible', overflowY: 'visible' })), false);
  eq('overflow-x hidden → 有裁切上下文', R.hasClipContext(L({ overflowX: 'hidden' })), true);
  eq('overflow-y clip → 有裁切上下文', R.hasClipContext(L({ overflowY: 'clip' })), true);
  eq('overflow auto → 不算（会出滚动条，内容没丢）',
    R.hasClipContext(L({ overflowX: 'auto', overflowY: 'auto' })), false);
  eq('overflow scroll → 不算', R.hasClipContext(L({ overflowX: 'scroll' })), false);

  /* --- constrainsContent：只认**声明式**硬约束 ---
   *
   * ★ 这一节是 v1.7.1 的一处修正留下的证据，别把第一条改回 true。
   *
   * 第一版把「定高」也算进 constrainsContent：
   *   `l.h !== 'auto' && parseFloat(l.h) > 0`
   * 结果它实际等价于 hasClipContext —— 因为 `l.h` 来自
   * getComputedStyle(el).height，而**浏览器对已渲染元素返回的是使用值**：
   *
   *     <div style="overflow:hidden">   → height: "21px"   ← 根本没写高度
   *     <div style="overflow:visible">  → height: "21px"   ← 完全不裁也一样
   *
   * 实测见 tools/_probe-height.html。后果不只是「圈选变宽」（那可以接受），
   * 而是 clipInfo / clipsContent 也一起变宽 —— 那条路径是**第一级直接搬走、
   * 没有验真**的，圆角卡片上极常见的 `border-radius + overflow:hidden`
   * 会让译文被搬到卡片外面。那是相对 v1.7.0 的净退化。
   * 修法：静态判据退回声明式；「定高裁切」交给圈选 + 几何量测那条新路径。
   */
  eq('overflow:hidden + height:24px → 【不】算声明式硬约束（浏览器把 height 解析成使用值，判不出来）',
    R.constrainsContent(L({ overflowX: 'hidden', height: '24px' })), false);

  /* --- C-27：约束与「还滚不滚得到」必须**同轴**判断 ---
   *
   * 上面那段注释早写着「auto / scroll 不算：它们会出滚动条，内容没丢」，
   * 但那句话是**按轴**成立的，旧判据却把两轴混着看：
   * 只要「任一轴 hidden/clip」+「有 max-height」就是裁切容器，
   * 完全不管 max-height 所在的**纵轴其实可以滚**。
   *
   * ★ 别把下面第一条改回 true ★ —— 改回去就等于把 remoteok 的
   * 259 条地区译文重新倒到页面上（那条竖排列表顶掉整个职位表）。 */
  eq('overflow-x:hidden + overflow-y:scroll + max-height → 【不】算裁切容器（纵轴滚得到）',
    R.constrainsContent(L({ overflowX: 'hidden', overflowY: 'scroll', maxHeight: '500px' })), false);
  eq('  但仍是「有裁切上下文」，第二级照旧会去量它',
    R.hasClipContext(L({ overflowX: 'hidden', overflowY: 'scroll' })), true);
  eq('line-clamp + 纵轴可滚 → 【不】算裁切容器',
    R.constrainsContent(L({ overflowX: 'hidden', overflowY: 'auto', clamp: '3' })), false);
  eq('两轴都 hidden + max-height → 仍是裁切容器（行为一字不变）',
    R.constrainsContent(L({ overflowX: 'hidden', overflowY: 'hidden', maxHeight: '500px' })), true);
  eq('line-clamp + 两轴 hidden → 仍是裁切容器（v1.7.0 既有分支）',
    R.constrainsContent(L({ overflowX: 'hidden', overflowY: 'hidden', maxHeight: '60px', clamp: '3' })), true);
  eq('  但它仍然是「会裁」的盒子 → 圈选阶段照样被圈中（交给第二级量测）',
    R.hasClipContext(L({ overflowX: 'hidden', height: '24px' })), true);
  eq('overflow:hidden + height:auto + 无 max-height + 无 clamp → 不约束',
    R.constrainsContent(L({ overflowX: 'hidden', height: 'auto' })), false);
  eq('overflow:hidden + max-height:80px → 约束（v1.7.0 已有）',
    R.constrainsContent(L({ overflowX: 'hidden', maxHeight: '80px' })), true);
  eq('overflow:hidden + line-clamp:3 → 约束（v1.7.0 已有）',
    R.constrainsContent(L({ overflowX: 'hidden', clamp: '3' })), true);
  eq('height:24px 但 overflow visible → 不约束（内容只是溢出，没被切）',
    R.constrainsContent(L({ height: '24px' })), false);
  eq('height:0 且 overflow hidden → 不算「约束内容」（是折叠，另判）',
    R.constrainsContent(L({ overflowX: 'hidden', height: '0px' })), false);
  eq('max-height:0 且 overflow hidden → 同上',
    R.constrainsContent(L({ overflowX: 'hidden', maxHeight: '0px' })), false);
  eq('clamp 为 "none" 不触发', R.constrainsContent(L({ overflowX: 'hidden', clamp: 'none' })), false);
  eq('clamp 为 "0" 不触发（浏览器把 0 当无 clamp）',
    R.constrainsContent(L({ overflowX: 'hidden', clamp: '0' })), false);

  /* --- clipsContent 是 constrainsContent 的别名：clipInfo 靠它决定第一级搬走，
   *     因此这里额外钉一条「别再把它改宽」的守卫。 --- */
  eq('clipsContent 与 constrainsContent 同步（clipInfo 的第一级行为不许漂移）',
    R.clipsContent(L({ overflowX: 'hidden', height: '24px' })),
    R.constrainsContent(L({ overflowX: 'hidden', height: '24px' })));
  eq('  因此 clipInfo 不会因为「任何 overflow:hidden 祖先」就把译文搬出卡片',
    R.clipInfo(doc.getElementById('titleInner')).clip, null);

  /* --- forcesNoWrap --- */
  eq('white-space:nowrap → 不换行', R.forcesNoWrap(L({ whiteSpace: 'nowrap' })), true);
  eq('white-space:pre → 不换行', R.forcesNoWrap(L({ whiteSpace: 'pre' })), true);
  eq('white-space:normal → 可换行', R.forcesNoWrap(L({ whiteSpace: 'normal' })), false);
  eq('white-space:pre-wrap → 可换行（pre 家族里唯一会换的那个）',
    R.forcesNoWrap(L({ whiteSpace: 'pre-wrap' })), false);
  eq('white-space:pre-line → 可换行', R.forcesNoWrap(L({ whiteSpace: 'pre-line' })), false);

  /* --- collapsesContent：v1.7.1 补的 height:0 --- */
  eq('overflow:hidden + height:0 → 折叠（★ 本轮新增）',
    R.collapsesContent(L({ overflowX: 'hidden', height: '0px' })), true);
  eq('overflow:hidden + max-height:0 → 折叠（v1.7.0 已有）',
    R.collapsesContent(L({ overflowX: 'hidden', maxHeight: '0px' })), true);
  eq('height:0 但 overflow visible → 不算折叠（内容还在，只是没占位）',
    R.collapsesContent(L({ height: '0px' })), false);
  eq('height:24px → 不是折叠', R.collapsesContent(L({ overflowX: 'hidden', height: '24px' })), false);
}

/* ================================================================== */
/* 二、第一级圈选：suspectRisk 的四级阶梯与两条不命中                    */
/* ================================================================== */

section('二、suspectRisk 圈选阶梯');
{
  const { R, doc } = boot();
  const g = (id) => doc.getElementById(id);

  eq('① 单元自身定高+省略号 → self-constrained',
    R.suspectRisk(g('title')), 'self-constrained');
  eq('② 单元自身 nowrap（无裁切）→ self-nowrap',
    R.suspectRisk(g('pillFree')), 'self-nowrap');
  eq('③ 祖先定高裁切 → ancestor-constrained',
    R.suspectRisk(g('pClip')), 'ancestor-constrained');
  eq('④ 祖先 nowrap、链上无约束 → ancestor-nowrap',
    R.suspectRisk(g('pNowrap')), 'ancestor-nowrap');

  /* --- 必须不命中的两例 --- */
  eq('普通块流里的段落不圈选（保 v1.7.0 行为）',
    R.suspectRisk(g('pPlain')), null);

  /* 一个真正「干净」的内联宿主：自身与祖先都没有约束 → 不圈选 */
  const cleanWrap = doc.createElement('div');
  cleanWrap.setAttribute('data-fx', 'plain');
  const cleanSpan = doc.createElement('span');
  cleanSpan.setAttribute('data-fx', 'inlineSpan');
  cleanSpan.textContent = 'A plain inline label';
  cleanWrap.appendChild(cleanSpan);
  doc.getElementById('root').appendChild(cleanWrap);
  eq('干净的内联宿主不圈选（保留 v1.5 起「宿主自然变宽」的取舍）',
    R.suspectRisk(cleanSpan), null);

  /* 而 #titleInner 在定高标题里 —— 它**必须**被圈选：
   * 祖先的省略号照样会吃掉它，这不是误判。 */
  eq('定高标题里的 <span> → ancestor-constrained（确实会被祖先吃掉）',
    R.suspectRisk(g('titleInner')), 'ancestor-constrained');

  /* --- 「能自由变宽的 nowrap 药丸」与「被裁的 nowrap 药丸」都进第二级 ---
   * 两者的静态判据相同，区分交给几何量测 ——
   * 这正是两级设计的价值：静态不必猜准，只需别漏。
   *
   * 注意 pillClipped 报的是 self-constrained 而不是 self-nowrap：
   * 圈选用的是 hasClipContext（**会裁**），它 overflow:hidden 就先命中，
   * nowrap 是第二顺位。这个先后顺序是刻意的 ——
   * 「会裁」比「不换行」更具解释力，也更容易被第二级量出来。 */
  eq('nowrap 药丸（无裁切）也圈选，交由量测判决',
    R.suspectRisk(g('pillFree')), 'self-nowrap');
  eq('nowrap 药丸（有裁切）同样圈选（先报「会裁」）',
    R.suspectRisk(g('pillClipped')), 'self-constrained');

  /* --- 自身优先于祖先：命中最具体的那条 --- */
  const nested = doc.createElement('p');
  nested.setAttribute('data-fx', 'titleFix');
  g('clipWrap').appendChild(nested);
  eq('自身与祖先都命中时，报更具体的「自身」',
    R.suspectRisk(nested), 'self-constrained');

  /* --- 垃圾输入不得抛错 --- */
  let threw = false;
  try { R.suspectRisk(doc.body); } catch (e) { threw = true; }
  eq('对 body 调用不抛错', threw, false);
}

/* ================================================================== */
/* 三、placementFor：既有五条优先级一个都不能变                          */
/* ================================================================== */

section('三、placementFor 的既有优先级与打标');
{
  const { R, doc, CT } = boot();
  const g = (id) => doc.getElementById(id);
  const S = Object.assign({}, CT.DEFAULT_SETTINGS, { displayMode: 'below' });

  /* ① 硬约束最优先：<td> 就地追加，且**不打标**
   *    （表格单元格插不了兄弟节点，圈选它没有意义，只会浪费一次量测） */
  const cellPlan = R.placementFor(g('cell'), S);
  eq('<td> → inside（硬约束优先）', cellPlan.kind, 'inside');
  eq('  <td> 不打标（挪不出去，圈选无意义）', cellPlan.risk, undefined);

  /* ② 折叠区直接丢弃 */
  const colPlan = R.placementFor(g('pCollapse'), S);
  eq('零高度折叠区 → collapsed', colPlan.collapsed, true);

  /* ③ line-clamp 祖先 → ★ P-1（2026-09-29）免检通道清零 ★
   * ------------------------------------------------------------------
   * 旧期望「after + reason=clipped」**正是免检通道的形状**：静态判据直接
   * 产出一次不可逆的归属搬迁；而它不打 risk 标 → verifyBatch 的
   * `!rec.risk → continue` 把它整条跳过 —— 第二级从不回看。
   *
   * 新期望断言的是**不变量本身**（比旧断言更严：旧断言在静态判据误报时
   * 也是绿的）。它的强度由「静态门禁 · 免检通道清零」（第八节）兜底：
   * 只要有人把搬迁决策写回静态级，那节就直接红。
   * 最终落点由真实浏览器验证：tools/probe-clip-channel-ab.mjs。 */
  const clampPlan = R.placementFor(g('pClamp'), S);
  eq('line-clamp 祖先 → inside（静态级不再外挪）', clampPlan.kind, 'inside');
  eq('  打裁切标 ancestor-clipped（交由第二级判决）',
    clampPlan.risk, 'ancestor-clipped');
  eq('  静态级不再给出搬迁锚点', clampPlan.anchor, undefined);
  eq('  静态级不再声称 reason=clipped', clampPlan.reason, undefined);

  /* ④ 定高裁切祖先 → 静态级**只打标不搬动**，判决交给第二级
   * ------------------------------------------------------------------
   * 这一轮把期望从「after + clipped」改成「inside + risk」，不是放松 ——
   * 是修掉一个真 bug 后的语义收敛：
   *
   * 第一版把「定高」加进了 constrainsContent，让这类祖先在静态级
   * 直接走 clipped 分支外挪。但 Chrome 的 getComputedStyle().height
   * 返回的是**使用值**（没写高度的 div 也报 "21px"，见 _probe-height.html），
   * 于是那条判据恒为真，constrainsContent 退化成 hasClipContext ——
   * 圆角卡片（border-radius + overflow:hidden，根本没裁到译文）也会被
   * 第一级无验真地搬出卡片，归属错乱。
   *
   * 修正后的分工：静态级分不出「声明的定高」，所以只标
   * ancestor-constrained；「译文是否真的越出了这层」由第二级
   * judgeOne 用真实矩形量（见第四节 2) spills-host）。
   * 越界 → relocate 搬走；没越界（圆角卡片）→ 一个字节都不动。 */
  const clipPlan = R.placementFor(g('pClip'), S);
  eq('定高裁切祖先 → inside 但必须打标（静态级不猜，交给量测）',
    clipPlan.kind, 'inside');
  eq('  risk = ancestor-constrained', clipPlan.risk, 'ancestor-constrained');

  /* ⑤ 内联级宿主 → inline，但 v1.7.1 起**同样打标**。
   * 这一条是修完实现才补上的断言：内联分支在 v1.7.0 里直接 return，
   * 从不经过第 ⑤ 步的圈选 —— 而截图现场恰好走的就是这条路径
   * （<span>/<a> 标题 + nowrap），等于把 M1 整条留在盲区里。 */
  const inlPlan0 = R.placementFor(g('pillFree'), S);
  eq('nowrap 内联药丸 → inline（形态不变）', inlPlan0.kind, 'inline');
  eq('  ★ 但必须打标，否则内联路径永远不进第二级', inlPlan0.risk, 'self-nowrap');

  const cleanSpan = doc.createElement('span');
  cleanSpan.setAttribute('data-fx', 'inlineSpan');
  cleanSpan.textContent = 'Plain inline label';
  g('plainHost').appendChild(cleanSpan);
  const cleanPlan = R.placementFor(cleanSpan, S);
  eq('干净内联宿主 → inline', cleanPlan.kind, 'inline');
  eq('  不打标（放得下，不该量）', cleanPlan.risk, undefined);

  /* ⑥ 横向弹性容器自身（flex-row）→ after，且必须打**落点标**（C-36） */
  const rowPlan = R.placementFor(g('pillRow'), S);
  eq('弹性行容器自身 → after', rowPlan.kind, 'after');
  eq('  reason = flex-row', rowPlan.reason, 'flex-row');
  /* ★ C-36（2026-09-29）★ 这里原本写的是 `rowPlan.risk === undefined`
   * （断言名：`已有外挪路径的分支不叠加新标`）。
   *
   * 它的**本意是对的** —— 这条分支不是裁切路径，不该被贴上
   * `ancestor-clipped`，否则 rescuedFromClip 会把「为了不挤坏弹性行才挪的」
   * 也当成「从裁切容器里救回来的」。
   *
   * 但它**表达式选错了**：`undefined` 把「不该贴裁切标」写成了「一个标都不许有」，
   * 于是它顺手把**这条分支不进行第二级复核**这件事钉成了契约 ——
   * 一条本来用来防「贴错标」的断言，反过来成了免检通道的看门人。
   * 这是 L-2「断言没有牙齿」的**反向形态**：不是恒真，而是**恒假地防错了方向**。
   *
   * 正确的表达式是**成对**的：① 必须有标（否则第二级不看）；② 必须不是裁切标
   * （否则口径被污染）。两条缺一不可，只写一条都会把错误方向钉死。
   * 见 docs/P-1-免检通道复查.md 免检 A、tools/criteria-audit.mjs 的标集合核对。 */
  eq('  ★ 必须有落点标（否则这条跨父插入的第二级从不回看）',
    typeof rowPlan.risk === 'string' && rowPlan.risk.length > 0, true);
  eq('  ★ 但它**不是**裁切标（不得污染 rescuedFromClip 的口径）',
    rowPlan.risk, 'flex-row-outside');
  /* 上面两条就是这条分支的**全部**契约（必须有标 + 必须是「落点标」而不是
   * 「裁切标」），**故意不再补第三条**：再写一条 `risk !== 'ancestor-clipped'`
   * 只是第二条的等价变形，补进去就是给断言堆数量、没有新牙齿（L-2）。
   * 「两个标在统计口径上必须互不串味」这条更硬的断言在别处 ——
   * 见 tools/test-static-criteria.mjs 第十四节的 relocated/rescuedFromClip 计数对。 */

  /* ⑦ 打标分支：普通块 + 值得怀疑 */
  const titlePlan = R.placementFor(g('title'), S);
  eq('定高标题 → 仍是 inside（只打标不搬动）', titlePlan.kind, 'inside');
  eq('  带 risk = self-constrained', titlePlan.risk, 'self-constrained');

  /* ⑧ 不值得怀疑的普通块：一条字节都不变 */
  const plainPlan = R.placementFor(g('pPlain'), S);
  eq('普通段落 → inside', plainPlan.kind, 'inside');
  eq('  不带任何标', plainPlan.risk, undefined);

  /* ⑦b ★ C-27 现场回归 ★ 定高 + 纵向可滚的下拉面板
   * ------------------------------------------------------------------
   * 面板里的条目**必须留在面板内部**（kind=inside）。
   * 旧实现返回 { kind:'after', reason:'clipped' } —— 译文被搬到面板之外，
   * 落在 .container 的常规流里，把整页内容顶下去。
   * 这条断言就是那个缺陷的钉子：只要它变红，用户截图里的
   * 「竖排中文列表 + 右侧整片空白」就回来了。 */
  const spPlan = R.placementFor(g('spItem'), S);
  eq('定高 + 纵向可滚面板里的条目 → inside（必须留在面板内）', spPlan.kind, 'inside');
  eq('  不再是 clipped 外挪', spPlan.reason, undefined);
  eq('  条目自身 nowrap → 只打 self-nowrap 标（还没证明被裁）', spPlan.risk, 'self-nowrap');

  const spPlan2 = R.placementFor(g('spItemPlain'), S);
  eq('  面板内不带 nowrap 的条目同样 inside', spPlan2.kind, 'inside');
  eq('  也不再外挪（reason 缺省）', spPlan2.reason, undefined);
  /* 静态级仍会给它一个 ancestor-constrained 标 —— 这是**设计使然**，不是漏改：
   *   第一级圈选用的是 `hasClipContext`（任一轴 hidden/clip 都算「会裁」），
   *   `#scrollPanel` 的 overflow-x 确实是 hidden，横轴真的会裁内容
   *   （`nowrap` 的译文在横轴上就会被吃成省略号 —— 那条路径必须留在圈选里）。
   *   这一级只回答「值得怀疑吗」，判决交给第二级几何量：
   *   judgeOne 走到这一层时，纵轴越界会被 `scrollsOutOf` 放行（第七节 2 已验证），
   *   横轴真越界则照旧判失败。**修的是判决，不是圈选** ——
   *   把这条判据也在静态级收窄，等于把横轴裁切整条漏掉。 */
  eq('  静态级仍打 ancestor-constrained 标（只圈不算，交第二级清）',
    spPlan2.risk, 'ancestor-constrained');

  /* ⑨ 内联宿主落在定高祖先里 → inline 形态保留 + 打标，同 ④ 的语义
   * ------------------------------------------------------------------
   * 旧期望「after」依赖 constrainsContent 认得定高 —— 那条判据已被
   * 使用值陷阱推翻（见 ④ 的注释）。现在的分工：
   *   静态级：保住 inline 形态（A4），只打 ancestor-constrained 标；
   *   第二级：宿主省略号真的在吃内容 → ellipsized → relocate 搬走
   *           （第四节 3) 已验证）；没在吃 → 一个字节都不动。 */
  const inlPlan = R.placementFor(g('titleInner'), S);
  eq('定高标题里的 <span> → inline（形态保住，静态不搬）', inlPlan.kind, 'inline');
  eq('  risk = ancestor-constrained（交给量测判决）', inlPlan.risk, 'ancestor-constrained');
}

/* ================================================================== */
/* 四、第二级：judgeOne 的四类失败与「通过」                             */
/* ================================================================== */

section('四、几何判决：judgeOne');

function rec(node, placement) {
  return { mode: 'below', node: node, placement: placement || 'inside', text: 'x' };
}

{
  const { R, doc, w } = boot();
  const doc2 = doc;

  /* 造一个宿主 + 一个译文节点，手工挂进 DOM，再直接调 judgeOne */
  function host(id, fx, parentId) {
    const el = doc2.createElement('p');
    el.id = id;
    el.setAttribute('data-fx', fx);
    (parentId ? doc2.getElementById(parentId) : doc2.body).appendChild(el);
    return el;
  }
  function transInto(el, rect) {
    const t = doc2.createElement('div');
    t.className = 'ct-trans ct-trans--in';
    if (rect) {
      const sl = doc2.createElement('span');
      sl.textContent = '译文';
      t.appendChild(sl);
    }
    el.appendChild(t);
    t.__ctRect = rect || null;
    return t;
  }

  /* --- 1) invisible：零矩形 --- */
  {
    const el = host('j1', 'plain');
    const t = transInto(el, [0, 0, 0, 0]);
    eq('零尺寸矩形 → invisible', R.judgeOne(el, rec(t)), 'invisible');
  }

  /* --- 2) spills-host：越出一个只是 overflow:hidden（按声明判不出定高）的祖先 ---
   * clipAnc 是「overflow:hidden + height:40px」。浏览器把 height 解析成使用值，
   * 所以静态判据分不出它是不是「声明的定高」—— 但几何量测分得出
   * 「译文有没有越出这个盒子」，那才是真正决定可见性的东西。 */
  {
    const el = host('j2', 'plain', 'clipWrap');
    // 祖先 #clipWrap 矩形 [0,0,600,40]；译文在 y=50 处 → 越界
    doc2.getElementById('clipWrap').__ctRect = [0, 0, 600, 40];
    const t = transInto(el, [0, 50, 600, 20]);
    eq('越出「只是 overflow:hidden」的祖先 → spills-host', R.judgeOne(el, rec(t)), 'spills-host');
  }

  /* --- 2b) clipped：越出一个**声明了** max-height 的祖先 ---
   * 几何条件与 2) 完全一样，只差在祖先声明上是 max-height 而不是 height。
   * 走的是站点的「截断 + 展开全文」机制，所以给更具体的 clipped。 */
  {
    const el = host('j2b', 'plain', 'capWrap');
    doc2.getElementById('capWrap').__ctRect = [0, 0, 600, 40];
    const t = transInto(el, [0, 50, 600, 20]);
    eq('越出声明了 max-height 的祖先 → clipped', R.judgeOne(el, rec(t)), 'clipped');
  }

  /* --- 2c) 非直接父元素的裁切祖先也要判 ---
   * 中间隔了一层普通块流（#clipMid）。旧实现要求「越界的那一层必须是直接父元素」，
   * 于是这种形态漏判 —— 而译文是普通流子项，越出非直接父元素是真实存在的。 */
  {
    const el = host('j2c', 'plain', 'clipWrap');
    doc2.getElementById('clipWrap').__ctRect = [0, 0, 600, 40];
    const t = transInto(el, [0, 60, 600, 20]);
    eq('隔着普通块流祖先也一样判（不要求直接父元素）',
      R.judgeOne(el, rec(t)), 'spills-host');
  }

  /* --- 3) ellipsized：宿主 nowrap + ellipsis 且内容确实溢出 --- */
  {
    const el = host('j3', 'titleFix');
    el.__scrollWidth = 900;
    el.__clientWidth = 300;
    const t = transInto(el, [310, 100, 400, 18]);
    t.className = 'ct-trans ct-trans--inl';
    eq('宿主省略号正在吃内容 → ellipsized', R.judgeOne(el, rec(t, 'inline')), 'ellipsized');
  }

  /* --- 3b) 三个条件缺一不可 --- */
  {
    const el = host('j3b', 'titleFix');
    el.__ctRect = [0, 100, 300, 24];   // 宿主自己的盒
    el.__scrollWidth = 300;            // 没有溢出
    el.__clientWidth = 300;
    const t = transInto(el, [10, 100, 100, 18]);
    t.className = 'ct-trans ct-trans--inl';
    eq('宿主没溢出 → 不判 ellipsized（三件套缺一不可）',
      R.judgeOne(el, rec(t, 'inline')), null);
  }

  /* --- 3c) nowrap 药丸放得下 → 必须通过 ---
   * 这是 A4：保留 v1.5 起「宿主只因为内容变长而自然变宽」的取舍。
   * 静态判据把它圈进来了（self-nowrap），但量测判它通过，因此一个字节都不动。 */
  {
    const el = host('j3c', 'pillFree');
    el.__ctRect = [0, 400, 300, 24];
    el.__scrollWidth = 300;
    el.__clientWidth = 300;
    const t = transInto(el, [10, 400, 200, 24]);
    t.className = 'ct-trans ct-trans--inl';
    eq('能自由变宽的 nowrap 药丸：量测判通过（内联形态保住）',
      R.judgeOne(el, rec(t, 'inline')), null);
  }

  /* --- 4) spills-host：父元素在裁切但没定高 → 越界即失败 --- */
  {
    const el = host('j4', 'pillClipped');
    const t = transInto(el, [0, 200, 900, 20]);
    eq('越出裁切中的直接父元素 → spills-host', R.judgeOne(el, rec(t)), 'spills-host');
  }

  /* --- 5) 通过：一切都在里面 --- */
  {
    const el = host('j5', 'plain');
    const t = transInto(el, [10, 300, 200, 20]);
    eq('译文完整落在容器内 → 通过（null）', R.judgeOne(el, rec(t)), null);
  }

  /* --- 6) 节点已脱离文档 → 不判（交给 pruneDisconnected） --- */
  {
    const el = host('j6', 'plain');
    const t = doc2.createElement('div');
    t.className = 'ct-trans';
    t.__ctRect = [0, 0, 0, 0];
    eq('游离节点不参与判决', R.judgeOne(el, rec(t)), null);
  }
}

/* ================================================================== */
/* 五、批末验真与搬移                                                    */
/* ================================================================== */

section('五、verifyBatch 与 relocate');
{
  const { R, doc, CT } = boot();
  const S = Object.assign({}, CT.DEFAULT_SETTINGS, { displayMode: 'below' });

  /* 靶单元放在**普通块流**里，但自身是「定高 + 省略号」的标题形态。
   * 这样 placementFor 会给出 inside + risk（自身命中），译文先落在单元内部 ——
   * 正是要验真的那种布局：站点自己的省略号随时可能把它吃掉。 */
  const wrap = doc.getElementById('plainHost');
  const u = doc.createElement('p');
  u.id = 'target';
  u.setAttribute('data-fx', 'titleFix');
  wrap.appendChild(u);

  const plan = R.placementFor(u, S);
  eq('靶单元被打标', plan.risk, 'self-constrained');
  eq('  形态仍是 inside（第一级只打标不搬动）', plan.kind, 'inside');

  const okRender = R.renderUnit(u, '【译文】被裁切容器里的段落', S, 'h1', plan);
  eq('渲染成功', okRender, true);
  eq('  打标计数 +1', R.getStats().riskSuspect, 1);

  const node = u.querySelector('.' + CT.TRANS_CLASS);
  ok('译文确实先落在单元内部', !!node && node.parentNode === u);

  /* 第一次读矩形返回坏值（零尺寸 → invisible），搬移后复验返回好值。
   * 用函数式矩形正是为了在一个节点上模拟「搬前坏、搬后好」。 */
  let reads = 0;
  node.__ctRect = () => {
    reads++;
    return reads === 1 ? [0, 0, 0, 0] : [10, 100, 500, 22];
  };

  const moved = R.verifyBatch([u]);
  eq('搬走了 1 条', moved, 1);
  eq('  搬移原因计入 relocatedInvisible', R.getStats().relocatedInvisible, 1);
  eq('  未出现「搬了也没救回来」', R.getStats().clipUnresolved, 0);

  ok('译文已不在原单元内', node.parentNode !== u);
  ok('  落到了原单元之后（同级兄弟）', node.parentNode === wrap && node.previousSibling === u);
  ok('  带上了 --moved 标记', node.classList.contains('ct-trans--moved'));
  ok('  换成了 --out 形态', node.classList.contains('ct-trans--out'));
  ok('  丢掉了 --in', !node.classList.contains('ct-trans--in'));
  ok('  丢掉了 --inl', !node.classList.contains('ct-trans--inl'));
  eq('  注册表记录同步更新为 after', R.registry.get(u).placement, 'after');
  eq('  记录里保留归因', R.registry.get(u).reason, 'relocated:invisible');
  eq('  判决结果为 moved', R.registry.get(u).verdict, 'moved');

  /* 再跑一次不得重复搬（moved 标记必须生效） */
  eq('已搬过的单元不重复量测', R.verifyBatch([u]), 0);

  /* 没打标的单元永远不量 —— 这是「零额外量测开销」的保证 */
  const plain = doc.getElementById('pPlain');
  const plainPlan = R.placementFor(plain, S);
  R.renderUnit(plain, '【译文】普通段落', S, 'h2', plainPlan);
  const before = R.getStats().relocated;
  R.verifyBatch([plain]);
  eq('未打标的单元不进入量测（relocated 不变）', R.getStats().relocated, before);

  /* escapeAnchor：必须越过**最外层**约束容器，而不是只迈出里层一跳。
   * 套两层裁切（外层折叠整块、内层定高截摘要）时，只挪出里层会被外层继续裁。 */
  const inner = doc.createElement('p');
  inner.setAttribute('data-fx', 'plain');
  doc.getElementById('clipMid').appendChild(inner);
  eq('escapeAnchor 取到最外层裁切容器之后的位置',
    R.escapeAnchor(inner) === doc.getElementById('clipWrap'), true);
  eq('  内层容器不是答案 —— 它上面还有一层',
    R.escapeAnchor(inner) === doc.getElementById('clipMid'), false);

  /* canPlaceAfter：允许 anchor === el（搬移后最常见的形态），
   * 但必须拒绝 <tr> 这类收不下块级子元素的父容器 */
  ok('canPlaceAfter 允许锚点就是单元自身', R.canPlaceAfter(u));
  ok('canPlaceAfter 拒绝 <tr> 的子元素', !R.canPlaceAfter(doc.getElementById('cell')));
  ok('canPlaceAfter 拒绝游离节点', !R.canPlaceAfter(doc.createElement('p')));

  /* ★ 2026-09-29 新增：标签名黑名单挡不住「用 CSS 模拟表格」 ★
   * ------------------------------------------------------------------
   * 上面的 `<tr>` 判据是按 **tagName** 判的。站点完全可以把同一套布局写在
   * div 上（`<div style="display:table-row">`），tagName 仍是 DIV → 旧判据放行。
   *
   * 夹具按**真实调用形态**搭：`relocate` 调的是 `canPlaceAfter(锚点)`，锚点
   * 常就是单元自身，所以「父」才是布局角色所在的那一层：
   *
   *   锚点(单元) = div[display:table-cell]  父 = div[display:table-row]
   *
   * 实测（真实 Chromium，模拟 relocate 的 kind:'after' 插一个块级 div）：
   *   · 父是 div[display:table-row] → 译文 x=92 / y=30，原文 x=30 / y=30 / w=62
   *       → 译文落在原文**右侧同一行** = 被包成匿名表格单元、成了**第二列**
   *   · 父是普通块流容器           → 译文 y=143，原文底边 142 → 落在**下方**（正确）
   * 即：同一动作在两种容器里得到**相反**的形态；而结构上 `<tr>` 与
   * `div[display:table-row]` 等价 —— 结论必须一致。
   *
   * 只在**这一侧**加断言还不够（把判据往一边推，收紧时没人会发现），
   * 所以下面**成对**：行角色必须拒、单元角色必须允许。二者互为反例。
   * 两类夹具都同时设 `data-fx`（本套件的假 getComputedStyle 读它）与内联
   * `style.display`（供「读内联样式」的实现），这样无论判据读哪一处都成立。 */
  const cssRow = doc.createElement('div');
  cssRow.setAttribute('data-fx', 'cssTableRow');
  cssRow.style.display = 'table-row';
  const cssCellUnit = doc.createElement('p');   // 单元自身 = 搬移时的锚点
  cssCellUnit.setAttribute('data-fx', 'cssTableCell');
  cssCellUnit.style.display = 'table-cell';
  cssRow.appendChild(cssCellUnit);
  doc.body.appendChild(cssRow);
  ok('canPlaceAfter 拒绝「父是 CSS 表格行」的锚点 —— 否则译文会被插成该行的第二列',
    !R.canPlaceAfter(cssCellUnit));

  const cssCellHost = doc.createElement('div');
  cssCellHost.setAttribute('data-fx', 'cssTableCell');
  cssCellHost.style.display = 'table-cell';
  const cssCellChild = doc.createElement('p');
  cssCellHost.appendChild(cssCellChild);
  doc.body.appendChild(cssCellHost);
  ok('canPlaceAfter 允许「父是 CSS 表格单元」的锚点 —— 单元格内纵向堆叠形态正确，不许误拦',
    R.canPlaceAfter(cssCellChild));
}

section('五·补 挪不出去时要如实上报，不能静默');
{
  const { R, doc, CT } = boot();
  const S = Object.assign({}, CT.DEFAULT_SETTINGS, { displayMode: 'below' });
  // <td> 里插不了块级兄弟节点：canPlaceAfter 会拒绝
  const cell = doc.getElementById('cell');
  const plan = R.placementFor(cell, S);
  R.renderUnit(cell, '【译文】表格单元格', S, 'h3', plan);
  const node = cell.querySelector('.' + CT.TRANS_CLASS);
  node.__ctRect = [0, 0, 0, 0];

  const rec3 = R.registry.get(cell);
  const before = R.getStats().clipUnresolved;
  R.relocate(cell, rec3, 'invisible');
  eq('结构上挪不出去 → clipUnresolved +1（不静默）',
    R.getStats().clipUnresolved, before + 1);
  eq('  判决留痕', R.registry.get(cell).verdict, 'unresolved:invisible');
  ok('  译文仍留在原地（没有凭空消失）', cell.contains(node));
}

/* ================================================================== */
/* 六、审计：auditVisibility / auditSummary                             */
/* ================================================================== */

section('六、可见性审计（可执行证据）');
{
  const { R, doc, CT } = boot();
  const S = Object.assign({}, CT.DEFAULT_SETTINGS, { displayMode: 'below' });
  const wrap = doc.getElementById('plainHost');

  /* 两条同形态的单元（定高 + 省略号的标题），一条给好矩形、一条给零矩形。
   * 之所以要**同形态**：审计与第二级共用同一个 judgeOne，
   * 只有让两个单元的静态判据完全相同，异常条数的差异才只能归因于几何量测。 */
  function mkUnit(id, label, hostRect) {
    const el = doc.createElement('p');
    el.id = id;
    el.setAttribute('data-fx', 'titleFix');
    el.textContent = label;
    wrap.appendChild(el);
    const plan = R.placementFor(el, S);
    R.renderUnit(el, '【译文】' + label, S, id, plan);
    el.__ctRect = hostRect;
    const node = el.querySelector('.' + CT.TRANS_CLASS);
    ok(label + '：译文落在单元内部（审计才有对象）', !!node && node.parentNode === el);
    return node;
  }

  const goodNode = mkUnit('auditGood', '可见的那条', [0, 0, 300, 24]);
  const badNode = mkUnit('auditBad', '看不见的那条', [0, 60, 300, 24]);
  goodNode.__ctRect = [10, 0, 200, 20];     // 完整落在宿主盒内 → 通过
  badNode.__ctRect = [0, 0, 0, 0];          // 零矩形 → 被吃掉

  const list = R.auditVisibility();
  eq('审计发现 1 条异常（只有那一条零矩形）', list.length, 1);
  eq('  原因是 invisible', list[0] && list[0].reason, 'invisible');
  ok('  带上译文片段便于定位', list[0] && list[0].text.indexOf('看不见') >= 0, JSON.stringify(list[0]));
  eq('  带上形态线索', list[0] && list[0].placement, 'inside');
  eq('  带上第一级打标结果（闭合归因链）', list[0] && list[0].risk, 'self-constrained');
  ok('  带上矩形读数', list[0] && typeof list[0].rect.width === 'number', JSON.stringify(list[0] && list[0].rect));

  const sum = R.auditSummary();
  eq('摘要总数一致', sum.total, 1);
  eq('摘要按原因聚合', sum.byReason.invisible, 1);

  /* scope 参数：限定范围后不该看到范围外的单元 */
  const scoped = R.auditVisibility(doc.getElementById('clampWrap'));
  eq('scope 限定后范围外的异常不计入', scoped.length, 0);
  eq('  同一范围的正常单元也从审计结果里排除',
    R.auditVisibility(doc.getElementById('plainHost')).length, 1);

  /* 把坏的修好（放进宿主盒内），审计应归零 */
  badNode.__ctRect = [10, 60, 200, 20];
  eq('修好后审计归零', R.auditVisibility().length, 0);
}

/* ================================================================== */

/* ==================================================================
 * v1.7.4（C-12 Q1a）：位置线索升级为「页题 › 外层区块标题 › 内层区块标题」
 * ------------------------------------------------------------------
 * 短标签的取义常常需要更外层的语境（导航里的 Home 需要页题，
 * 面包屑下的 Overview 需要两层区块标题）。这里钉住链路的三条性质：
 * 能串起来、无标题时只剩页题、超长页题被截断到 30 字符。
 * ================================================================== */
/* ================================================================== */
/* 七、C-27：零矩形要分辨「还没显示」与「真被裁掉」；可滚轴上的越界不算被裁 */
/* ================================================================== */

section('七、几何判决 · 可滚轴与隐藏子树（C-27）');
{
  const { R, doc } = boot();

  function hostAt(parentId, id, fx) {
    const el = doc.createElement('div');
    el.id = id;
    el.setAttribute('data-fx', fx || 'panelItem');
    (parentId ? doc.getElementById(parentId) : doc.body).appendChild(el);
    return el;
  }
  function transInto(el, rect) {
    const t = doc.createElement('div');
    t.className = 'ct-trans ct-trans--in';
    const sl = doc.createElement('span');
    sl.textContent = '译文';
    t.appendChild(sl);
    el.appendChild(t);
    t.__ctRect = rect || null;
    return t;
  }
  const R_ = (node) => ({ mode: 'below', node: node, placement: 'inside', text: 'x' });

  /* 1) display:none 子树里的零矩形 —— 必须放行，不许搬 */
  {
    const el = hostAt('hiddenWrap', 'h1');
    const t = transInto(el, [0, 0, 0, 0]);
    eq('折叠面板（display:none）里的译文 → 放行（还没显示 ≠ 被裁掉）',
      R.judgeOne(el, R_(t)), null);

    /* 对照组：同样的零矩形，但祖先不是 display:none → 仍判 invisible。
     * 这一对断言把「隐藏」与「真被吃掉」钉成了两个不同的结论。 */
    const el2 = hostAt('root', 'h2');
    const t2 = transInto(el2, [0, 0, 0, 0]);
    eq('  对照组：祖先可见时的零矩形 → 仍是 invisible',
      R.judgeOne(el2, R_(t2)), 'invisible');
  }

  /* 2) 可滚祖先里的越界 —— 只是滚出视口，不算被裁 */
  {
    const panel = doc.getElementById('scrollPanel');
    panel.__ctRect = [0, 0, 400, 500];            // 定高 500 的滚动面板
    const el = hostAt('scrollPanel', 's1');
    const t = transInto(el, [0, 900, 400, 20]);   // 译文在可视区之下（要滚动才看得到）
    eq('纵轴可滚的祖先里越界 → 放行（滚回来就能看见，不是被裁）',
      R.judgeOne(el, R_(t)), null);

    const t2 = transInto(el, [0, 200, 900, 20]);  // 横向越界，而横轴不可滚（hidden）
    eq('  同一层横向越界且横轴不可滚 → 照旧判失败（同轴原则的另一半）',
      R.judgeOne(el, R_(t2)), 'spills-host');
  }

  /* 3) 端到端：面板里的条目渲染后不该被搬走
   * ------------------------------------------------------------------
   * 这条是用户截图缺陷的完整钉子。分两段，因为折叠有两种极易混淆的情形：
   *
   *   3a「面板打开、条目可见」—— 矩形都是真的，判决必须一条都不搬；
   *   3b「面板折叠（display:none）」—— 所有矩形恒为零，这正是 remoteok
   *      的真实时序（译文是在面板关着的时候注入的）。
   *
   * 为什么 3b 必须用**真的 display:none**、而不是「把矩形写成零」：
   *   「零矩形 + 祖先可见」确实是 invisible（译文真的被吃掉了），
   *   判失败、搬走是**对的**；而「零矩形 + 祖先 display:none」是
   *   「还没显示」，一个字节都不该动。两类现场的唯一区别就是祖先的
   *   display，夹具必须如实还原，否则这条断言会去锁住一个错误行为。 */
  {
    const { R: R2, doc: d2, CT } = boot();
    const S = Object.assign({}, CT.DEFAULT_SETTINGS, { displayMode: 'below' });

    /* 3a) 面板打开、条目可见 —— 给真实的矩形 */
    const item = d2.getElementById('spItem');
    d2.getElementById('scrollPanel').__ctRect = [0, 0, 400, 500];
    item.__ctRect = [0, 10, 400, 40];
    const plan = R2.placementFor(item, S);
    eq('  可滚面板里的条目 → inside + self-nowrap 标（不是 clipped 外挪）',
      plan.kind + '/' + (plan.risk || '-'), 'inside/self-nowrap');
    R2.renderUnit(item, '【译】全球', S, 'h1', plan);
    const node = item.querySelector('.' + CT.TRANS_CLASS);
    ok('译文落在条目内部（不是被搬到面板外）', !!node && item.contains(node));
    eq('  形态类仍是 --in（没有变成 --out/--moved）',
      node.className.indexOf('ct-trans--in') >= 0
        && node.className.indexOf('ct-trans--moved') < 0, true);

    node.__ctRect = [0, 30, 400, 20];
    const before = R2.getStats().relocated;
    R2.verifyBatch([item]);
    eq('  面板打开且条目可见 → verifyBatch 不搬任何东西',
      R2.getStats().relocated, before);
    ok('  译文仍在条目内部', item.contains(node));

    /* 3b) 面板折叠（display:none）—— 矩形全零，但这不是「被裁掉」 */
    const fold = d2.getElementById('foldItem');
    const foldPlan = R2.placementFor(fold, S);
    eq('  折叠面板里的条目 → 仍是 inside（形态决策与面板开关状态无关）',
      foldPlan.kind, 'inside');
    R2.renderUnit(fold, '【译】全球', S, 'h1', foldPlan);
    const foldNode = fold.querySelector('.' + CT.TRANS_CLASS);
    ok('  折叠面板里的译文同样落在条目内部', !!foldNode && fold.contains(foldNode));

    const before2 = R2.getStats().relocated;
    R2.verifyBatch([fold]);
    eq('  折叠状态下 verifyBatch 不搬任何东西', R2.getStats().relocated, before2);
    ok('  译文仍在条目内部', fold.contains(foldNode));
  }
}

section('八、位置线索标题链（C-12 Q1a）');
{
  const FIXTURE2 = `<!DOCTYPE html>
  <html lang="en"><head><meta charset="utf-8"><title>Remote Jobs</title></head>
  <body><main>
    <section>
      <h2>Engineering</h2>
      <article>
        <h3>Rust Engineer</h3>
        <div><span id="ctxDeep">Back</span></div>
      </article>
    </section>
    <p><span id="ctxOrphan">Home</span></p>
  </main></body></html>`;

  const dom2 = new JSDOM(FIXTURE2, { url: 'https://example.com/jobs', runScripts: 'outside-only', pretendToBeVisual: true });
  const w2 = dom2.window;
  w2.getComputedStyle = fakeComputedStyle;
  installGeom(w2);
  const ctx2 = dom2.getInternalVMContext();
  for (const rel of ['shared/constants.js', 'content/detector.js', 'content/renderer.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), ctx2, { filename: rel });
  }
  const R2 = w2.CT.renderer;
  const doc2 = w2.document;

  const deep = R2.contextFor(doc2.getElementById('ctxDeep'));
  eq('两级区块标题 + 页题串成链', deep, 'Remote Jobs › Rust Engineer › Engineering');

  const orphan = R2.contextFor(doc2.getElementById('ctxOrphan'));
  eq('无区块标题时退化为页题', orphan, 'Remote Jobs');

  /* 超长页题截断 */
  const dom3 = new JSDOM(FIXTURE2.replace('<title>Remote Jobs</title>',
    '<title>The Very Long Website Title That Keeps Going Past Thirty Characters</title>'),
    { url: 'https://example.com/jobs', runScripts: 'outside-only', pretendToBeVisual: true });
  const w3 = dom3.window;
  w3.getComputedStyle = fakeComputedStyle;
  installGeom(w3);
  const ctx3 = dom3.getInternalVMContext();
  for (const rel of ['shared/constants.js', 'content/detector.js', 'content/renderer.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), ctx3, { filename: rel });
  }
  const orphan3 = w3.CT.renderer.contextFor(
    w3.document.getElementById('ctxOrphan'));
  ok('长页题截到 30 字符并以 › 截断', orphan3.length <= 60
    && orphan3.indexOf('The Very Long Website Title Th') === 0, JSON.stringify(orphan3));
}

/* ================================================================== */
/* 九、静态门禁 · 免检通道清零（P-1 / 2026-09-29）                        */
/* ================================================================== */
/*
 * 为什么必须有这一节
 * ------------------------------------------------------------------
 * 「免检通道」的定义：**静态判据直接产生不可逆的 DOM 变更**
 * （把译文搬到某个容器之外），而第二级几何判决**从不回看**它。
 *
 * 它为什么危险：在一个自称「两级验真」的体系里只要留一条免检路径，
 * 整套防线的可信度就等于那条最粗的静态判据。C-27 的 remoteok 事故
 * 就是这么发生的 —— 259 条译文被静态搬出面板，把整页内容顶下去
 * （见《考核处分登记-2026-09-28》§七「架构不对称」）。
 *
 * 为什么**行为断言不够**，必须另有一道结构性门禁：
 * 搬迁的最终落点依赖真实矩形，而 jsdom 没有布局引擎
 * （getBoundingClientRect() 恒为全零），在这里量不出任何差异 ——
 * 也就是说这类缺陷在 jsdom 里**根本不可复现**。
 * 这正是 L-17 那条纪律的场景：**jsdom 测不到的呈现层，必须有静态门禁**。
 * 行为侧的权威证据是 tools/probe-clip-channel-ab.mjs（真实 Chromium）。
 *
 * 【门禁只盯「代码形状」，不盯「注释措辞」】
 * 下面所有检查都在**去掉注释**后的源码上做 —— 因为注释里会正当地讨论
 * 这些禁词（比如解释「为什么不能再这么写」）。盯注释会逼着后人删掉
 * 解释，那是把文档变成牺牲品换绿灯。
 */
section('九、静态门禁 · 免检通道清零（P-1）');
{
  /* 【为什么用行级过滤，而不是写一个词法剥离器】
   * 手写剥离要同时正确处理字符串、模板串、**正则字面量**三者。而本文件里
   * 恰好有一个带引号的正则 —— `normalizeText` 附近的 `.replace(/"/g, '\\"')`
   * —— 朴素剥离器会在那里误入「字符串」状态并从此全篇错位，**而且不报错**：
   * 它会安静地把后面的注释当成代码，把本该红的门禁变成绿灯。
   * 行级过滤对「注释里的引号 / 花括号」完全免疫；代价是看不见行内注释，
   * 而本文件的注释一律独占行 —— 这个代价为零。
   * （这条本身就是 L-2「断言没有牙齿」的一个具体形态：门禁工具自己写错，
   *   比没有门禁更危险。） */
  const RAW = fs.readFileSync(path.join(ROOT, 'content/renderer.js'), 'utf8');

  /* 【为什么用行级过滤，而不是写一个词法剥离器】
   * 手写剥离要同时正确处理字符串、模板串、**正则字面量**三者。而本文件里
   * 恰好有一个带引号的正则 —— `normalizeText` 附近的 `.replace(/"/g, '\\"')`
   * —— 朴素剥离器会在那里误入「字符串」状态并从此全篇错位，**而且不报错**：
   * 它会安静地把后面的注释当成代码，把本该红的门禁变成绿灯。
   *
   * 【为什么不能只判「行首是不是注释符」】
   * 本文件里有**块注释与代码同行**的写法（如 `/* … *​/  var WALK_FILTER = {`），
   * 一刀切掉整行会悄悄少一个花括号，而下面的 bodyOf 会因此取错范围、
   * 门禁全部「看起来是绿的」。所以同行闭合的块注释要**只削掉注释那一段**，
   * 保留后面的代码。
   *
   * 这两条都是 L-2「断言没有牙齿」的具体形态：**门禁工具自己写错，
   * 比没有门禁更危险**。所以下面紧跟一条花括号配平自检兜住它。 */
  function codeOf(raw) {
    return raw.split('\n').map((ln) => {
      let t = ln.trim();
      if (!t || t.startsWith('//') || t.startsWith('*')) return null;
      if (t.startsWith('/*')) {
        // 多行块注释的起始行（本行没有闭合）
        if (t.indexOf('*/') < 0) return null;
        // 同行闭合：注释之后可能还跟着代码
        t = t.replace(/\/\*[\s\S]*?\*\//, ' ').trim();
        return t || null;
      }
      // 代码行里嵌的完整块注释一并去掉（如 `} catch (e) { /* … */ }`）
      t = t.replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
      return t || null;
    }).filter((x) => x !== null).join('\n');
  }

  const SRC = codeOf(RAW);

  /* 过滤后必须仍配平 —— 否则 bodyOf 会取错范围，而下面的门禁会「看起来全绿」。
   * 这是整个门禁里最要紧的一条自检：它曾经当场抓到过一次误过滤
   * （`/* … *​/  var WALK_FILTER = {` 那一行）。 */
  ok('门禁自检：去注释后源码花括号仍配平（否则提取器会静默错位）',
    (SRC.match(/\{/g) || []).length === (SRC.match(/\}/g) || []).length,
    '左 ' + (SRC.match(/\{/g) || []).length
      + ' / 右 ' + (SRC.match(/\}/g) || []).length);

  /** 按花括号配平取出函数体（在去注释后的源码上，配平是准的） */
  function bodyOf(sig) {
    const i = SRC.indexOf(sig);
    if (i < 0) return null;
    const open = SRC.indexOf('{', i);
    if (open < 0) return null;
    let depth = 0;
    for (let k = open; k < SRC.length; k++) {
      if (SRC[k] === '{') depth++;
      else if (SRC[k] === '}') { depth--; if (depth === 0) return SRC.slice(open, k + 1); }
    }
    return null;
  }

  const pf = bodyOf('function placementFor(el, settings)');
  const vb = bodyOf('function verifyBatch(els)');
  const rl = bodyOf('function relocate(el, rec, reason)');
  const ru = bodyOf('function renderUnit(el, translation, settings, srcHash, plan, srcText)');

  /* --- 门禁自检：取不到函数体时必须先红，否则下面全是假绿灯 --- */
  ok('门禁自检：四个关键函数体都取得到（取不到说明提取器坏了）',
    !!pf && !!vb && !!rl && !!ru,
    'pf=' + !!pf + ' vb=' + !!vb + ' rl=' + !!rl + ' ru=' + !!ru);
  ok("门禁自检：placementFor 确实是判据本体（含 kind: 'inside'）",
    !!pf && pf.indexOf("kind: 'inside'") >= 0);

  /* --- 门禁 1~4：静态级不得持有「不可逆搬迁」的任何零件 --- */
  ok('门禁1：placementFor 里不得出现裁切容器锚点（safeAnchor(clip…)）',
    !!pf && !/safeAnchor\(\s*clip/.test(pf));
  ok("门禁2：placementFor 里不得产出免检通道的招牌 reason='clipped'",
    !!pf && !/reason:\s*['"]clipped/.test(pf));
  ok('门禁3：placementFor 里不得调用 relocate（不可逆搬迁只许第二级做）',
    !!pf && pf.indexOf('relocate(') < 0);
  ok('门禁4：placementFor 里不得调用 escapeAnchor（它只认几何证据，属第二级）',
    !!pf && pf.indexOf('escapeAnchor(') < 0);

  /* --- 门禁 5~6：把它接回去的「现成零件」必须不存在 --- */
  ok('门禁5：placementFor 的裁切分支必须打 CLIP_RISK 标（否则第二级不会回看）',
    !!pf && pf.indexOf('risk: CLIP_RISK') >= 0);
  ok('门禁6：canInsertAfter 不得复活（它是旧免检通道的结构预检零件）',
    SRC.indexOf('canInsertAfter(') < 0);

  /* --- 门禁 7~9：第二级的入口与出口纪律 --- */
  ok('门禁7：verifyBatch 的入场条件必须要求「打过标」（rec.risk）',
    !!vb && vb.indexOf('rec.risk') >= 0);
  ok('门禁8：escapeAnchor 的调用点只在第二级（relocate）内',
    !!rl && rl.indexOf('escapeAnchor(') >= 0
      && (SRC.match(/escapeAnchor\(/g) || []).length === 2,
    '全库调用点 ' + (SRC.match(/escapeAnchor\(/g) || []).length + ' 处（应为 2：定义 + relocate 内一次）');
  ok('门禁9：relocate 的调用点只在 verifyBatch 内（定义 1 + 调用 1）',
    !!vb && vb.indexOf('relocate(') >= 0
      && (SRC.match(/relocate\(/g) || []).length === 2,
    '全库调用点 ' + (SRC.match(/relocate\(/g) || []).length + ' 处');

  /* --- 门禁 10：rescuedFromClip 的计数点必须在第二级、且必须在复验通过之后 --- */
  ok('门禁10：rescuedFromClip 不在 renderUnit（第一级）里计数',
    !!ru && ru.indexOf('rescuedFromClip') < 0);
  ok('门禁11：rescuedFromClip 在 relocate 内、且排在复验之后',
    !!rl && rl.indexOf('rescuedFromClip') > rl.indexOf('var again = judgeOne('),
    'relocate 内 rescuedFromClip 出现位置必须晚于复验调用');

  /* --- 门禁 12（C-34）：表布局 display 集合必须**恰好**是那 6 个 ---
   * canPlaceAfter 对「CSS 模拟表格」的拦截全靠这张集合表。集合里少一个值，
   * 那种容器就被放行 → 在它里面插块级兄弟会被浏览器包成**匿名表格单元**
   * → 译文变成该行的第二列（真实 Chromium 实测：原文 x=30/y=30/w=62、
   * 译文 x=92/y=30，同一行）。而它是**不可逆搬迁前唯一的结构预检**，
   * 漏一个值就是一个 C-26/C-27 同族的静默反转。
   *
   * 【为什么不写成 5 条「XX 容器必须 false」】
   * 那是同一条断言的 5 个实例：失败信息完全相同、指向同一行代码、
   * 将来改集合要改 5 处。而真正要防的是「集合被删了一个值」——
   * 这件事**一条**集合断言就能全覆盖（增值 / 删值 / 改名全红），
   * 而且钉的是集合本身，不是某个值的某一次行为，方向性更硬。
   * 这也顺带避开了 L-2 的坑：5 条同构断言删掉 4 条不会有人发现，
   * 一条集合断言删掉了会立刻红。 */
  const TLD_EXPECTED = [
    'table', 'inline-table', 'table-row',
    'table-row-group', 'table-header-group', 'table-footer-group'
  ].sort();
  const tldBody = bodyOf('var TABLE_LAYOUT_DISPLAY');
  const tldKeys = tldBody
    ? [...new Set([...tldBody.matchAll(/['"]([a-z-]+)['"]\s*:/g)].map((m) => m[1]))].sort()
    : null;
  ok('门禁12：TABLE_LAYOUT_DISPLAY 的键集合恰好是 6 个表布局 display 值',
    !!tldKeys && JSON.stringify(tldKeys) === JSON.stringify(TLD_EXPECTED),
    '实际 ' + JSON.stringify(tldKeys) + ' / 期望 ' + JSON.stringify(TLD_EXPECTED));
}

/* ==================================================================
 * 十、D-6（C-08）：标签串接边界重建 `joinChildTexts`（补 `U-3` 的零断言空洞）
 * ==================================================================
 * 【这一节为什么必须存在】
 *   台账 `U-3` / `F-1`：护栏清单把 D-6 的复跑方式指到本套件，而本套件
 *   对 `joinChildTexts` 曾经**一条断言都没有**。变异验证 #3 实测：把
 *   `joinChildTexts` 首行改成 `return null`（边界重建整体失效），本套件
 *   **仍 154 项全绿** —— 「看起来在守、实际不守」的护栏比没有护栏更危险。
 *
 * 【钉的是什么】
 *   D-6 = `td.tags` 这类标签行整行被当成一个单元送出：子元素全是内联，
 *   `extractText` 走 `textContent` 快路径 ⇒ 送翻的是
 *   `ExecutiveSys AdminDocker` 这样一串**没有边界**的文本 ⇒ 译文糊成一坨
 *   （现场截图：`执行设计系统管理员Docker技术客户支持…`）。
 *   修法 = `joinChildTexts(el, text)` 识别「标签串接形态」并用 `' / '`
 *   重建边界；判据不满足则返回 `null`，调用方沿用原文本
 *   （**检测失败永远安全**）。
 *
 * 【断言为什么是这一组，而不是照抄「四种形态」】
 *   ① **正向 + 反向成对**：只钉正向（标签行必须有边界）会被另一种改法骗过
 *      —— 比如把所有元素都插上边界（正文也被切碎）；
 *      只钉反向（正文必须 `null`）会被 `return null` 一整行骗过。
 *      所以每条形态判据都配一条**只差一个变量**的对照件。
 *   ② **反向件必须「隔离」**：一条 `null` 可能同时被两条判据拦下，
 *      那样它证明不了任何一条判据还在。故每个反向件都构造成
 *      **只可能踩一条判据**（配合紧邻的对照件把其余判据全部喂饱）。
 *   ③ **端到端**：另有一条断言走**真实公共入口** `collectUnits`
 *      （`collectUnits → maybePush → joinChildTexts → unit.text`），
 *      用来钉「调用点被摘掉」—— 单元级断言看不见调用点。
 *      ⇒ 全程**不手工调用被测函数去伪造现场**（避免 `F-3`/`U-1` 记过的
 *      「自注入桩」反模式），只喂真 DOM、读真返回值。
 *   ④ **纯行内文档**：`joinChildTexts` 的终判要「子元素拼回的文本 == 整体文本」，
 *      而 `extractText` 对「子元素全为无子节点的内联」走 `textContent` 快路径
 *      （不插分隔）。所以下面的标签行夹具**在源里保留标签之间的空白**
 *      —— 这正是 CMS 产出、也是 remoteok 的真实形态。
 *      （**无空白**的平铺形态是已登记的边界 `U-2`「平铺 `<a>` 标签行边界丢失」，
 *       台账明确不计为线上已确证缺陷 ⇒ **本节不钉它**，免得把边界当契约。
 *       它一旦被修好，本节断言不受影响。）
 * ================================================================== */
section('十、D-6（C-08）：标签串接边界重建 joinChildTexts');
{
  const { R, CT, doc } = boot();

  /* D6-0 · 前置：契约还在
   * 若把导出摘掉，下面的调用会以 `TypeError` 炸掉整节 —— 那是一条**不可归因**的红。
   * 先钉一条前置，红灯才能指向原因。 */
  ok('D6-0 前置：CT.renderer.joinChildTexts 仍被导出（否则本节全部不可归因）',
    typeof R.joinChildTexts === 'function', '实际 ' + typeof R.joinChildTexts);

  /* ---- 夹具 ----------------------------------------------------------
   * 标签行一律写「源里带空白」的形态（见 §十 ④ 的说明）。
   * `<a>` 在 detector 里是 `INLINE_TAGS` ⇒ 容器被当作叶子块，整个被收成一个单元
   * —— 这正是 D-6 的现场。 */
  const tagN = (n) => Array.from({ length: n },
    (_, i) => '<a>Tag' + String(i + 1).padStart(2, '0') + '</a>').join('\n        ');
  /** 43 字符的真实英文片段（供「段长上限」与「总长上限」两族对照件使用） */
  const WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel';
  const wordsN = (n) => Array.from({ length: n },
    () => '<a>' + WORDS + '</a>').join('\n        ');

  doc.body.insertAdjacentHTML('beforeend', `
    <table><tbody><tr>
      <td id="d6Flat">
        <a>Executive</a>
        <a>Sys Admin</a>
        <a>Docker</a>
      </td>
      <td id="d6Nested">
        <a><div class="tag"><h3>Executive</h3></div></a>
        <a><div class="tag"><h3>Sys Admin</h3></div></a>
        <a><div class="tag"><h3>Docker</h3></div></a>
      </td>
      <td id="d6SkipOwn">
        <a>Executive</a>
        <a>Sys Admin</a>
        <div class="ct-trans">译文块</div>
      </td>
      <td id="d6Sent">
        <a>First one ends here.</a>
        <a>Second tag</a>
      </td>
      <td id="d6SentCtl">
        <a>First one ends here</a>
        <a>Second tag</a>
      </td>
      <td id="d6Long">
        <a>Executive management overview and strategy planning for the region</a>
        <a>Second tag</a>
      </td>
      <td id="d6LongCtl">
        <a>Executive management overview and strateg</a>
        <a>Second tag</a>
      </td>
      <td id="d6Single"><a>Executive</a></td>
      <td id="d6Outside">
        <a>Alpha</a>
        MIDDLE WORD
        <a>Beta</a>
      </td>
      <td id="d6Many31">
        ${tagN(31)}
      </td>
      <td id="d6Many30">
        ${tagN(30)}
      </td>
      <td id="d6TotalOver">
        ${wordsN(8)}
      </td>
      <td id="d6TotalUnder">
        ${wordsN(6)}
      </td>
    </tr></tbody></table>
    <p id="d6Plain">Plain paragraph text with a normal sentence here.</p>
    <p id="d6PlainInline">Body text that is long enough <b>emph</b></p>
  `);

  const H = (id) => doc.getElementById(id);
  /** 走真实形态：`knownText` 就是 `extractText` 的结果（与 `maybePush` 一致） */
  const J = (id) => R.joinChildTexts(H(id), R.extractText(H(id)));
  const frags = (s) => (s === null ? null : s.split(' / ').length);

  /* ---- 正向：标签串接形态必须真的重建出 `' / '` 边界 ------------------ */
  eq('D6-1 平铺标签行 → 用 " / " 重建边界', J('d6Flat'), 'Executive / Sys Admin / Docker');
  eq('D6-2 平铺：片段数 == 子元素数（3）', frags(J('d6Flat')), 3);
  eq('D6-3 嵌套标签行（remoteok 真实形态）→ 同样重建边界',
    J('d6Nested'), 'Executive / Sys Admin / Docker');
  eq('D6-4 嵌套：片段数 == 子元素数（3）', frags(J('d6Nested')), 3);

  /* 分隔符本身要钉死：`' / '` 不是 `'、'`、也不是 `' '`。
   * 换成 `'、'` 会让「任何语言的引擎都吞不掉」这条设计依据失效；
   * 换成 `' '` 则等于什么都没重建（与不插边界的旧行为等价）。 */
  {
    const flat = J('d6Flat');
    ok('D6-5 分隔符恰为 " / "（不是 " "，也不是 "、"）',
      !!flat && flat.indexOf(' / ') >= 0 && flat.indexOf('、') < 0
        && flat !== 'Executive Sys Admin Docker',
      JSON.stringify(flat));
  }

  /* 自身译文节点必须被跳过：它进了 parts 就会把译文当标签送去再翻一遍 */
  eq('D6-6 自身译文节点（.ct-trans）被跳过：片段数 2 且不含译文文本',
    J('d6SkipOwn'), 'Executive / Sys Admin');
  eq('D6-7 自身译文节点被跳过：片段数 == 非跳过子元素数（2）', frags(J('d6SkipOwn')), 2);

  /* ---- 反向：非标签形态必须 `null`（沿用原文本） --------------------- */
  eq('D6-8 正文（无元素子节点）→ null', J('d6Plain'), null);
  eq('D6-9 只有 1 个元素子节点 → null（不是标签串接）', J('d6Single'), null);
  eq('D6-10 含块级强调的正文（子元素拼不出整体文本）→ null', J('d6PlainInline'), null);

  /* ---- 判据②·句读守卫（隔离件与对照件只差一个句末句点） -------------- */
  eq('D6-11 段尾带句末标点 → null（有句读说明是句子，不是标签）', J('d6Sent'), null);
  eq('D6-12 对照：去掉那个句末句点 → 必须重新产出边界',
    J('d6SentCtl'), 'First one ends here / Second tag');

  /* ---- 判据②·段长上限 60（隔离件 66 字符 / 对照件 43 字符） ---------- */
  eq('D6-13 单段 >60 字符 → null', J('d6Long'), null);
  eq('D6-14 对照：单段 43 字符 → 必须重新产出边界',
    J('d6LongCtl'), 'Executive management overview and strateg / Second tag');

  /* ---- 判据③·片段数上限 30（31 枚 → null；30 枚 → 有边界） ---------- */
  eq('D6-15 片段数 31（>30）→ null', J('d6Many31'), null);
  eq('D6-16 对照：片段数 30（边界值）→ 有边界且片段数 == 30',
    frags(J('d6Many30')), 30);

  /* ---- 判据③·总长上限 300（8×43=344 → null；6×43=258 → 有边界） ----- */
  eq('D6-17 总长 344（>300）→ null', J('d6TotalOver'), null);
  eq('D6-18 对照：总长 258（≤300）→ 有边界且片段数 == 6', frags(J('d6TotalUnder')), 6);

  /* ---- 判据④·终判「拼回的片段 == 整体文本」 -------------------------- */
  eq('D6-19 容器里混入子元素之外的游离文本 → null（终判不符）', J('d6Outside'), null);
  eq('D6-20 传入与整体文本不符的 knownText → null（终判不信调用方）',
    R.joinChildTexts(H('d6Flat'), 'totally different text'), null);

  /* ---- 不变式：任何非 null 返回都必须是「带 ' / ' 边界的串接」 -------
   * 这一条专门兜「整支被改写成 return extractText(el) / return knownText /
   * parts.join(' ')」这类把边界整体丢掉的改法 —— 它们能骗过上面每一条
   * 单独的期望值断言（因为那些断言各有自己的形态），却过不了这条。 */
  {
    const ALL = ['d6Flat', 'd6Nested', 'd6SkipOwn', 'd6Sent', 'd6SentCtl', 'd6Long',
      'd6LongCtl', 'd6Single', 'd6Outside', 'd6Many31', 'd6Many30',
      'd6TotalOver', 'd6TotalUnder', 'd6Plain', 'd6PlainInline'];
    const bad = [];
    for (const id of ALL) {
      const j = J(id);
      const whole = R.extractText(H(id));
      if (j === null) continue;
      if (j.indexOf(' / ') < 0 || j === whole) bad.push(id + '→' + JSON.stringify(j));
    }
    ok('D6-21 不变式：凡非 null 的返回都必须带 " / " 边界，且不等于原文本',
      bad.length === 0, bad.length ? '违例 ' + JSON.stringify(bad) : '0 违例 / 共 ' + ALL.length + ' 件');
  }

  /* ---- 端到端：走真实公共入口 `collectUnits`，钉住**调用点** ---------
   * 单元级断言只证明 `joinChildTexts` 自己还对；它证明不了 `maybePush`
   * 是否还把它**用上**。这里喂真 DOM、读真 `unit.text`。 */
  {
    const S = Object.assign({}, CT.DEFAULT_SETTINGS, { targetLang: 'zh-CN', sourceLang: 'auto' });
    const units = R.collectUnits(H('d6Flat'), S);
    eq('D6-22 端到端：collectUnits 产出的单元文本已带边界（调用点仍在用 joined）',
      units.length === 1 ? units[0].text : '(单元数 ' + units.length + ')',
      'Executive / Sys Admin / Docker');
  }
}

console.log('\n' + '─'.repeat(52));
if (failures.length) {
  console.log('失败 ' + failures.length + ' 项，通过 ' + passed + ' 项');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('全部通过：' + passed + ' 项断言');
