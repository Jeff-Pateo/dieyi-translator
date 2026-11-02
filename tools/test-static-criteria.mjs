/*
 * 叠译 · 既有静态判据的「反例审查」 —— P-3
 * ==================================================================
 * 起因：几何判据体系连续三次犯**同族**错误 —— 拿一个「含义没想清楚的量」
 * 去做静态判断：
 *
 *   L-1  getComputedStyle().height 是**使用值**（不是声明值）
 *   L-17 CSS 级联（`overflow:hidden` 打底被长手按轴覆盖）
 *   L-19 `overflow` 两轴独立 + 零矩形两义
 *
 * 事件 4 处分给测试组定的解除条件是：
 *   「对**所有既有静态判据**做反例审查（每个判据至少一条反例）」
 *
 * ------------------------------------------------------------------
 * 【反例的严格定义】每条反例必须同时满足：
 *   1) 它是一个**真实网页会出现的写法**（圆角卡片、可滚动下拉面板、
 *      手风琴 `height:0`、Shadow DOM 里的节点……），不是理想化 fixture；
 *   2) 它**看起来该得到结论 A，实际得到结论 B** —— 断言把 B 钉死，
 *      并在标题里写明「为什么会得出 B」；
 *   3) 判据被改错（改松/改紧）时这条断言会红 —— 由 tools 之外的
 *      「变异验证」实证（见交付说明）。
 *
 * 【四类元反例结构】每个判据都要想一遍：
 *   甲 轴混淆（L-19 A）     —— overflow 两轴独立，任一轴的口径不能推给另一轴
 *   乙 零值两义（L-19 B）   —— 零矩形/零高度既可能是「还没显示」也可能是「真没了」
 *   丙 使用值 vs 声明值（L-1）—— 读 getComputedStyle 的量必须问清是哪一种
 *   丁 恒真禁令            —— 严禁 `... || true`、严禁不可能为假的断言
 *
 * 【红线】本文件里不允许出现恒真断言。每条断言都必须能被打红。
 *
 * ------------------------------------------------------------------
 * 【jsdom 的边界 —— 老实交代】
 * jsdom 不实现真实排版：它不展开 overflow 简写、不解析 min-height、
 * 不返回使用值、getBoundingClientRect 一律零矩形。因此本套件
 * **接管两个读口**（与 tools/test-clip-guard.mjs 同一手法）：
 *     getComputedStyle                 → 按元素 data-fx 返回预设布局特征
 *     getBoundingClientRect/scrollWidth → 按元素 __ctRect / __scrollWidth 取值
 * 于是被测代码读到的「世界」是确定性的，断言钉的是**判据函数本身**。
 *
 * 但有一批结论**天生不可在 jsdom 里验**（它们是浏览器排版引擎的行为，
 * 不是判据函数的行为），本文件用 probe() 如实登记，不收进 passed/failed：
 *   见文末「须 2 组真实浏览器探针」清单。
 *
 * 运行：node tools/test-static-criteria.mjs
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { loadJsdom } from './_jsdom.mjs';

const JSDOM = loadJsdom();
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
/*
 * 被测文件位置。
 * 默认**始终**是 content/renderer.js —— 回归时不要动它。
 * 可选环境变量 CT_RENDERER_PATH 只为「变异验证」而存在：把它指向 renderer.js 的
 * **一份临时副本**（在副本上植入错误），就能在不触碰产品文件的前提下证明
 * 本套件某几条断言确实有牙齿。做过变异验证的用例记在
 * docs/P-1-免检通道复查.md §7。
 */
const RENDERER = process.env.CT_RENDERER_PATH
  ? path.resolve(process.env.CT_RENDERER_PATH)
  : path.join(ROOT, 'content/renderer.js');

let passed = 0;
const failures = [];
const probes = [];

function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + label); }
  else { failures.push(label); console.log('  \u2717 ' + label + (detail ? '  → ' + detail : '')); }
}
function eq(label, actual, expected) {
  ok(label + '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）',
    actual === expected);
}
function section(t) { console.log('\n' + t); }
function note(t) { console.log('  \u2b21 ' + t); }
/** 登记一条「jsdom 不可验」的结论，不收进 passed/failed */
function probe(label, why) { probes.push({ label: label, why: why }); }

/* ==================================================================
 * 布局预设：与 tools/test-clip-guard.mjs 同一套「接管读口」手法
 * ================================================================== */

const BASE = {
  display: 'block', overflowX: 'visible', overflowY: 'visible',
  maxHeight: 'none', height: 'auto', whiteSpace: 'normal',
  textOverflow: 'clip', position: 'static',
  flexDirection: 'row', flexWrap: 'nowrap', clamp: 'none',
  contentVisibility: 'visible'
};

const PRESETS = {
  plain: Object.assign({}, BASE),

  /* 卡片标题的通行写法：单行 + 定高 + 省略号（截图现场） */
  titleFix: Object.assign({}, BASE, {
    overflowX: 'hidden', overflowY: 'hidden', height: '24px',
    whiteSpace: 'nowrap', textOverflow: 'ellipsis'
  }),
  /* 同上，但 text-overflow 取默认 clip：文字被**硬切**，不是省略号 */
  nowrapClip: Object.assign({}, BASE, {
    overflowX: 'hidden', overflowY: 'hidden', height: '24px',
    whiteSpace: 'nowrap', textOverflow: 'clip'
  }),

  /* 定高裁切容器：只是 overflow:hidden + 用了 height，没有任何声明式硬约束 */
  clipAnc: Object.assign({}, BASE, { overflowX: 'hidden', overflowY: 'hidden', height: '40px' }),
  /* 声明式硬约束容器：与 clipAnc 的几何完全一样，只差「声明」这一层 */
  capAnc: Object.assign({}, BASE, { overflowX: 'hidden', overflowY: 'hidden', maxHeight: '40px' }),

  /* C-27 现场（remoteok 地区下拉）：overflow:hidden 打底、overflow-y:scroll 按轴覆盖 */
  scrollPanel: Object.assign({}, BASE, {
    overflowX: 'hidden', overflowY: 'scroll', maxHeight: '500px'
  }),

  /* 手风琴收起态：height:0 而不是 max-height:0 */
  collapseH0: Object.assign({}, BASE, { overflowX: 'hidden', overflowY: 'hidden', height: '0px' }),

  /* 站点折叠起来的容器（下拉面板 / 抽屉 / 非活动 tab） */
  hiddenBox: Object.assign({}, BASE, { display: 'none' }),

  /* 长列表虚拟化的新写法：子树不被渲染（矩形恒为零），但 display 不是 none */
  contentVis: Object.assign({}, BASE, { contentVisibility: 'hidden' }),

  flexRow: Object.assign({}, BASE, { display: 'flex', flexDirection: 'row' }),
  flexCol: Object.assign({}, BASE, { display: 'flex', flexDirection: 'column' }),
  gridBox: Object.assign({}, BASE, { display: 'grid' }),
  tableRow: Object.assign({}, BASE, { display: 'table-row' }),
  tableCell: Object.assign({}, BASE, { display: 'table-cell' }),
  inlineSpan: Object.assign({}, BASE, { display: 'inline' })
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
    contentVisibility: p.contentVisibility,
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

/*
 * 私有判据（isItemContext / safeAnchor / rectOutOf / inHiddenSubtree / scrollsOutOf）
 * 没有出现在 CT.renderer 的正式导出里。为了能在**不修改磁盘文件**的前提下
 * 直接钉它们的反例，这里在内存里往导出对象字面量前面插一个 __testExpose。
 * 插的是**测试专用的旁路**，被测代码的每一个字节都原样执行。
 * （若将来有人把某个私有函数改名/删除，这里会在 boot() 里明确报错，不会静默变成恒真断言。）
 */
const EXPOSE_KEYS = [
  'isItemContext', 'safeAnchor', 'rectOutOf', 'inHiddenSubtree', 'scrollsOutOf',
  'canInsertAfter'   // P-1 已删除；用 typeof 兜底，回来即接管审查
];
function exposePrivate(src) {
  const NEEDLE = '  CT.renderer = {';
  if (src.indexOf(NEEDLE) < 0) {
    throw new Error('renderer.js 的导出块锚点「' + NEEDLE + '」找不到了 —— 本套件需要同步更新');
  }
  const pairs = EXPOSE_KEYS
    .map((k) => k + ': (typeof ' + k + ' === "function" ? ' + k + ' : null)')
    .join(', ');
  return src.replace(NEEDLE, NEEDLE + '\n    __testExpose: { ' + pairs + ' },');
}

const FIXTURE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>静态判据反例夹具</title></head>
<body>
  <div id="root"></div>
</body></html>`;

function boot(fixture) {
  const dom = new JSDOM(fixture || FIXTURE, {
    url: 'https://example.com/criteria',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const w = dom.window;
  // 必须在 renderer 之前接管读口：renderer 在调用时才取 window.getComputedStyle
  w.getComputedStyle = fakeComputedStyle;
  installGeom(w);

  const ctx = dom.getInternalVMContext();
  for (const rel of ['shared/constants.js', 'content/detector.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), ctx, { filename: rel });
  }
  const patched = exposePrivate(fs.readFileSync(RENDERER, 'utf8'));
  vm.runInContext(patched, ctx, { filename: 'content/renderer.js' });

  const R = w.CT.renderer;
  const P = R && R.__testExpose;
  if (!P) throw new Error('__testExpose 注入失败 —— 私有判据无法直测');
  return { dom, w, doc: w.document, R: R, P: P, CT: w.CT };
}

/*
 * 判据函数吃的是 layoutOf 的输出对象，字段是**短名**（ox/oy/mh/h/clamp/ws/te）。
 * 这里把短名翻译出来，让断言读起来像在写 CSS，而不是在猜字段缩写。
 * 注意用 pick() 而不是 `||`：本套件要刻意钉「空串」这类**读口给零值**的情形，
 * `'' || 'visible'` 会把它吃掉，等于把一条反例偷偷变成恒真。
 */
function pick(v, d) { return v === undefined ? d : v; }
const L = (over) => {
  const o = over || {};
  return {
    display: pick(o.display, 'block'),
    fd: pick(o.fd, 'row'),
    fw: pick(o.fw, 'nowrap'),
    position: pick(o.position, 'static'),
    ox: pick(o.overflowX, 'visible'),
    oy: pick(o.overflowY, 'visible'),
    mh: pick(o.maxHeight, 'none'),
    h: pick(o.height, 'auto'),
    clamp: pick(o.clamp, 'none'),
    ws: pick(o.whiteSpace, 'normal'),
    te: pick(o.textOverflow, 'clip')
  };
};

/* ================================================================== */
/* 一、hasClipContext —— 「这一层会不会裁」                             */
/* ================================================================== */

section('一、hasClipContext（是否建立裁切上下文）');
{
  const { R } = boot();

  eq('基线：两轴都 visible → false', R.hasClipContext(L({})), false);

  /* 元反例·甲（轴混淆 / L-19 陷阱 A） */
  eq('反例①【轴混淆】`overflow:hidden; overflow-y:scroll` 的地区下拉面板 → true；'
    + '直觉是「纵向能滚 ⇒ 内容丢不了 ⇒ false」，但 hasClipContext 问的不是「内容丢没丢」，'
    + '而是「这一层裁不裁」—— 横轴确实是 hidden，一条 nowrap 的译文落在里面照样被横轴吃掉。'
    + '若谁在这里补一句「纵轴可滚就放过」，这条立刻红（而那正是 C-27 修错方向的复现）',
    R.hasClipContext(L({ overflowX: 'hidden', overflowY: 'scroll' })), true);

  /* 元反例·乙（零值两义）—— 读口给空串 */
  eq('反例②【零值两义】读口把 overflowX 给成空串（computed style 没拿到该属性）→ false；'
    + '直觉是「不是 visible 就该算裁」，但判据只认 hidden/clip 两个字面值，'
    + '空串既不是 visible 也不是 hidden —— 它被悄悄归进「不裁」那一侧。'
    + '改写成 `l.ox !== "visible"` 这种「看起来更宽」的写法，这条立刻红',
    R.hasClipContext(L({ overflowX: '' })), false);

  /* 元反例·丁方向：把「能滚」当「没裁」 */
  eq('反例③【auto 的立场】`overflow:auto`（内容溢出同样被裁进滚动盒、靠滚动条找回）→ false；'
    + '名字叫 clipContext 却不含 auto，判据的立场是「滚得到就算没丢」而不是「没裁」。'
    + '若有人把 auto/scroll 补进来「让它更严谨」，这条立刻红',
    R.hasClipContext(L({ overflowX: 'auto', overflowY: 'auto' })), false);

  eq('反例④【同义关键字】`overflow:clip` 与 hidden 同类 → true（别只认 hidden）',
    R.hasClipContext(L({ overflowX: 'clip' })), true);

  eq('反例⑤【单轴也够】只有 overflow-y:hidden → true（一轴建立裁切上下文就够）',
    R.hasClipContext(L({ overflowY: 'hidden' })), true);

  eq('反例⑥【规范改写了轴】浏览器会把「一轴 visible + 另一轴非 visible」里的 visible 计算成 auto，'
    + '于是真实计算值是 ox:"auto" / oy:"hidden"；判据对这一形态仍判 true —— '
    + '单看 `ox:"auto"` 一条会以为是滚动容器，两轴合起来才是真相',
    R.hasClipContext(L({ overflowX: 'auto', overflowY: 'hidden' })), true);

  probe('「一轴 visible + 另一轴非 visible ⇒ visible 被计算成 auto」',
    '这是 CSS 规范在**浏览器排版引擎**里的改写行为；jsdom 不展开 overflow 简写、也不做这项改写。'
    + '本文件只能钉「判据拿到 ox:auto/oy:hidden 时返回 true」，'
    + '「浏览器确实会把它改写成 auto」须真实浏览器探针。');
}

/* ================================================================== */
/* 二、constrainsContent —— 「声明了把内容限制在固定范围内的属性」        */
/* ================================================================== */

section('二、constrainsContent（是否声明式硬约束）');
{
  const { R } = boot();

  /* 元反例·丙（使用值 vs 声明值 / L-1）—— 本轮最重要的一条 */
  eq('反例①【使用值 vs 声明值·L-1】卡片标题 `overflow:hidden; height:24px`（无 max-height / 无 clamp）→ false；'
    + '直觉是「定高 + hidden 必然裁内容 ⇒ true」，但 l.h 取自 getComputedStyle().height，'
    + '浏览器对已渲染元素返回的是**使用值**（没写高度的 <div> 也报 21px）—— '
    + '一旦这条判据认高度，它就恒为真、退化成 hasClipContext，'
    + '于是圆角卡片（border-radius + overflow:hidden）这种根本没裁到译文的容器会被第一级无验真地搬走',
    R.constrainsContent(L({ overflowX: 'hidden', overflowY: 'hidden', height: '24px' })), false);
  eq('  对照：同一层仍然是「有裁切上下文」，第二级照旧会去量它',
    R.hasClipContext(L({ overflowX: 'hidden', overflowY: 'hidden', height: '24px' })), true);

  /* 元反例·甲（轴混淆） */
  eq('反例②【轴混淆】`overflow:hidden; overflow-y:scroll; max-height:500px` 的下拉面板 → false；'
    + '直觉是「任一轴 hidden + 有 max-height ⇒ 裁切容器」，但 max-height 落在**能滚的纵轴**上，'
    + '259 条译文滚一滚全能看见。删掉 constrainsContent 里 `l.oy === "auto" || l.oy === "scroll"` 那一行，这条立刻红',
    R.constrainsContent(L({ overflowX: 'hidden', overflowY: 'scroll', maxHeight: '500px' })), false);

  eq('反例③【同轴原则的另一半】`overflow-x:scroll; overflow-y:hidden; max-height:80px` → true；'
    + '纵轴裁且不可滚，横轴能滚救不了纵向被切的内容 —— '
    + '若把同轴原则写成「任一轴可滚就放过」，这条会从 true 变 false（红）',
    R.constrainsContent(L({ overflowX: 'scroll', overflowY: 'hidden', maxHeight: '80px' })), true);

  /* 元反例·乙（零值两义）—— max-height:0 属于「折叠」不属于「硬约束」 */
  eq('反例④【零值两义】`overflow:hidden; max-height:0` → false；'
    + '直觉是「写了 max-height ⇒ 有约束」，但 0 不在「> 0 的硬约束」里 —— '
    + '它属于 collapsesContent（折叠）。两条判据按 0 分家。'
    + '把 `parseFloat(l.mh) > 0` 放宽成 `>= 0`，折叠区会被误当成「截断 + 展开」的裁切容器',
    R.constrainsContent(L({ overflowX: 'hidden', overflowY: 'hidden', maxHeight: '0px' })), false);
  eq('  对照组：同一元素由 collapsesContent 判「折叠」',
    R.collapsesContent(L({ overflowX: 'hidden', overflowY: 'hidden', maxHeight: '0px' })), true);

  eq('反例⑤【零值两义·clamp】`-webkit-line-clamp:0` → false（浏览器把 0 当「没有 clamp」）',
    R.constrainsContent(L({ overflowX: 'hidden', overflowY: 'hidden', clamp: '0' })), false);

  eq('对照：`overflow:hidden; max-height:80px`（两轴都裁）→ true',
    R.constrainsContent(L({ overflowX: 'hidden', overflowY: 'hidden', maxHeight: '80px' })), true);
  eq('对照：`overflow:hidden` 但 height:auto、无 max-height、无 clamp → false（纯 hidden 不是约束）',
    R.constrainsContent(L({ overflowX: 'hidden', height: 'auto' })), false);

  eq('守卫：clipsContent 与 constrainsContent 恒等（clipInfo 的第一级路径不许单边漂移）',
    R.clipsContent(L({ overflowX: 'hidden', height: '24px' })),
    R.constrainsContent(L({ overflowX: 'hidden', height: '24px' })));

  probe('「Chrome 对已渲染元素返回 getComputedStyle().height 的**使用值**（<div style="overflow:hidden"> → "21px"）」',
    '这是浏览器排版引擎行为，jsdom 不做布局、不产生使用值。'
    + '本文件钉的是「判据拿到 l.h="24px" 时返回 false」；'
    + '「真实浏览器确实会把 24px（乃至没写高度的元素）解析成使用值喂进来」须真实浏览器探针（tools/_probe-height.html）。');
  probe('「-webkit-line-clamp 真的把内容吃掉（需 display:-webkit-box + -webkit-box-orient:vertical 配合）」',
    'jsdom 不实现 line-clamp 的排版效果。本文件钉的是「判据认 clamp 字符串」，'
    + '「clamp 是否真的裁掉内容」须真实浏览器探针。');
}

/* ================================================================== */
/* 三、forcesNoWrap                                                     */
/* ================================================================== */

section('三、forcesNoWrap（是否把内容拉成不换行）');
{
  const { R } = boot();

  eq('基线：white-space:nowrap → true', R.forcesNoWrap(L({ whiteSpace: 'nowrap' })), true);
  eq('基线：white-space:pre → true', R.forcesNoWrap(L({ whiteSpace: 'pre' })), true);

  eq('反例①【pre 家族里唯一会换行的那个】`white-space:pre-wrap` → false；'
    + '直觉是「pre 开头就不换行」，但 pre-wrap 保留空白、照样折行。'
    + '若把它简化成 `l.ws.indexOf("pre") === 0`（看起来更"健壮"的写法），这条立刻红',
    R.forcesNoWrap(L({ whiteSpace: 'pre-wrap' })), false);

  eq('反例②【同类】`white-space:pre-line` → false（同样折行）',
    R.forcesNoWrap(L({ whiteSpace: 'pre-line' })), false);

  eq('反例③【新关键字】`white-space:break-spaces` → false（不是 pre 家族，也会折行）',
    R.forcesNoWrap(L({ whiteSpace: 'break-spaces' })), false);

  eq('反例④【子串陷阱】`white-space:"preserve nowrap"`（CSS Text L4 双值语法）→ false；'
    + '这条真的**不换行**，但两条 `===` 比较都不中。'
    + '把判据改成 `indexOf("nowrap") >= 0` 就会变 true —— 断言随之变红',
    R.forcesNoWrap(L({ whiteSpace: 'preserve nowrap' })), false);

  eq('反例⑤【继承属性】white-space 是继承属性：父层写 nowrap、子层没写，子层计算值就是 nowrap —— '
    + '判据读计算值，所以「子层没写」≠「子层可换行」',
    R.forcesNoWrap(L({ whiteSpace: 'nowrap' })), true);

  probe('`white-space:"preserve nowrap"` 在浏览器里的计算值**序列化形式**',
    'CSS Text L4 的双值语法是否原样序列化成 "preserve nowrap"（而不是归一成别的串）属浏览器行为。'
    + '本文件按最常见的 "preserve nowrap" 钉判据；确切的序列化形式须真实浏览器探针。');
}

/* ================================================================== */
/* 四、collapsesContent                                                 */
/* ================================================================== */

section('四、collapsesContent（是否被折叠到零高度）');
{
  const { R } = boot();

  eq('基线：`overflow:hidden; height:0`（手风琴收起态）→ true',
    R.collapsesContent(L({ overflowX: 'hidden', overflowY: 'hidden', height: '0px' })), true);
  eq('基线：`overflow:hidden; max-height:0` → true',
    R.collapsesContent(L({ overflowX: 'hidden', overflowY: 'hidden', maxHeight: '0px' })), true);

  /* 元反例·乙（零值两义）—— 高度为 0 不等于折叠 */
  eq('反例①【零值两义】`height:0` 但 `overflow:visible` → false；'
    + '直觉是「高度为 0 就是折叠」，但此时内容正**溢出在页面上**（display:flex 的零高度盒子很常见），'
    + '判成折叠会让这批译文被静默丢弃。删掉 `if (!hasClipContext(l)) return false;` 这道门，这条立刻红',
    R.collapsesContent(L({ height: '0px' })), false);
  eq('反例②【零值两义】`max-height:0` 但 `overflow:visible` → false（同理：内容只是溢出，没被折叠）',
    R.collapsesContent(L({ maxHeight: '0px' })), false);

  /* 元反例·丙（使用值 vs 声明值 / L-1） */
  eq('反例③【使用值 vs 声明值·L-1】作者写 `height:0`，但同一元素还写着 `min-height:40px`；'
    + '浏览器把两者取大后返回**使用值** "40px"，所以 layoutOf 喂进来的 l.h 是 "40px" 而不是 "0px" → false；'
    + '「声明了 height:0 ⇒ 折叠」在这个判据上永远看不到，它只能看到浏览器的解析结果',
    R.collapsesContent(L({ overflowX: 'hidden', overflowY: 'hidden', height: '40px' })), false);

  eq('反例④【别把「裁切」当「折叠」】`overflow:hidden; height:24px`（定高裁切）→ false',
    R.collapsesContent(L({ overflowX: 'hidden', overflowY: 'hidden', height: '24px' })), false);

  /* 元反例·甲（轴混淆）—— 这里**故意**不分轴 */
  eq('反例⑤【轴混淆的反向】`overflow-x:hidden; overflow-y:scroll; max-height:0` → true；'
    + 'constrainsContent 学会了「纵轴可滚就不算裁」，但 collapsesContent **故意**不跟着学：'
    + 'max-height:0 时可视高度真的是 0，滚轴无从滚起。'
    + '若谁「顺手统一」成 constrainsContent 的同轴写法，这条立刻红',
    R.collapsesContent(L({ overflowX: 'hidden', overflowY: 'scroll', maxHeight: '0px' })), true);

  probe('「min-height 顶掉 height:0 之后，getComputedStyle().height 实际返回什么」',
    '需要真实布局引擎把 min-height 与 height 取大后解析出使用值。'
    + '本文件钉的是「判据拿到 h="40px" 时返回 false」；'
    + '「浏览器确实会喂进 40px」须真实浏览器探针。');
}

/* ================================================================== */
/* 五、clipInfo —— 沿祖先链找「最外层的声明式裁切容器」                   */
/* ================================================================== */

section('五、clipInfo（沿祖先链圈定裁切层与折叠层）');
{
  const { R, doc } = boot();
  const mkDiv = (fx, tag) => {
    const d = doc.createElement(tag || 'div');
    d.setAttribute('data-fx', fx || 'plain');
    return d;
  };
  const root = doc.getElementById('root');

  /* 反例①：body 被无条件跳过 */
  doc.body.setAttribute('data-fx', 'clipAnc');
  const bWrap = mkDiv('plain');
  const bUnit = mkDiv('plain', 'p');
  bWrap.appendChild(bUnit);
  root.appendChild(bWrap);
  eq('反例①【上溯边界被当成不裁】弹窗打开时站点写 `body{overflow:hidden}` 锁页面滚动 → clip=null；'
    + '直觉是「最外层 overflow:hidden 就是 body 那一层」，但上溯在 body 处**无条件** break，'
    + 'body 从不参与判定（也就永远不会被当成搬移锚点）',
    R.clipInfo(bUnit).clip, null);
  doc.body.removeAttribute('data-fx');

  /* 反例②：C-27 可滚面板（轴混淆） */
  const panel = mkDiv('scrollPanel');
  const panelItem = mkDiv('plain');
  panel.appendChild(panelItem);
  root.appendChild(panel);
  eq('反例②【轴混淆·C-27】`overflow:hidden; overflow-y:scroll; max-height:500px` 的地区下拉面板 → clip=null；'
    + '直觉是「定高 + overflow:hidden 就是裁切容器」，但纵轴可滚 ⇒ 不满足 constrainsContent（同轴原则），'
    + 'clipInfo 因此找不到裁切层。把 constrainsContent 的同轴那一行删掉，这条立刻红',
    R.clipInfo(panelItem).clip, null);

  /* 反例③：上溯跳数上限（CLIP_HOPS = 6） */
  const chain = (outerFx, wrappers) => {
    const outerEl = mkDiv(outerFx);
    root.appendChild(outerEl);
    let cur = outerEl;
    for (let i = 0; i < wrappers; i++) { const d = mkDiv('plain'); cur.appendChild(d); cur = d; }
    return { outer: outerEl, inner: cur };
  };

  const ch7 = chain('capAnc', 6);            // 裁切层落在第 7 层
  const unit7 = mkDiv('plain', 'p');
  ch7.inner.appendChild(unit7);
  eq('反例③【跳数上限】声明式裁切容器落在第 **7** 层祖先上（卡片/面板包装 6 层以上很常见）→ clip=null；'
    + '直觉是「沿着祖先往上总能找到」，但 CLIP_HOPS=6 只检查最近 6 层，第 7 层根本没被读过。'
    + '把 CLIP_HOPS 调大，这条会红（同时提醒维护者：调大意味着更多次样式读取）',
    R.clipInfo(unit7).clip, null);

  const ch6 = chain('capAnc', 5);            // 裁切层落在第 6 层
  const unit6 = mkDiv('plain', 'p');
  ch6.inner.appendChild(unit6);
  eq('  对照：同一个容器落在第 6 层 → 找得到（说明上一条红的是「上限」而不是「判据坏了」）',
    R.clipInfo(unit6).clip === ch6.outer, true);

  /* 反例④：折叠 ≠ 裁切 */
  const colWrap = mkDiv('collapseH0');
  const colUnit = mkDiv('plain', 'p');
  colWrap.appendChild(colUnit);
  root.appendChild(colWrap);
  const ci = R.clipInfo(colUnit);
  eq('反例④【折叠 ≠ 裁切】`overflow:hidden; height:0` 的手风琴包裹层 → clip=null（它不是声明式硬约束）；'
    + '直觉是「overflow:hidden 就该出现在 clip 里」，但这一层只配 collapsed',
    ci.clip, null);
  eq('  而它确实被判成折叠（两条判据各司其职）', ci.collapsed, true);

  /* 反例⑤：最外层获胜 */
  const outer = mkDiv('capAnc');
  const inner = mkDiv('capAnc');
  const leaf = mkDiv('plain', 'p');
  outer.appendChild(inner);
  inner.appendChild(leaf);
  root.appendChild(outer);
  eq('对照：套两层声明式裁切 → clip 留下**最外层**（只挪出里层，外层继续把它裁掉）',
    R.clipInfo(leaf).clip === outer, true);

  note('clipInfo 不读矩形、不读 display，因此它不吃「零矩形两义」——'
    + '零矩形那类现场由第二级的 judgeOne/inHiddenSubtree 处理（见十一、十三节）。');
}

/* ================================================================== */
/* 六、isItemContext —— 「子元素进去就会变成弹性 / 网格项」              */
/* ================================================================== */

section('六、isItemContext（追加进去会不会改变兄弟的排布）');
{
  const { P } = boot();

  /* 元反例·甲（轴混淆）—— 弹性容器的**方向**才是关键 */
  eq('反例①【轴混淆·方向】`display:flex; flex-direction:column` → false；'
    + '直觉是「flex 容器的子元素都是 flex item ⇒ true」，但纵向容器里追加一个块级子项只是「往下加一行」，'
    + '不挤压原有项 —— 真正要躲的是**横向**（会平分宽度）的容器。'
    + '把 isRowDirection(l.fd) 去掉，这条立刻红',
    P.isItemContext(L({ display: 'flex', fd: 'column' })), false);

  eq('对照：`display:flex; flex-direction:row` → true', P.isItemContext(L({ display: 'flex', fd: 'row' })), true);
  eq('对照：`flex-direction:row-reverse` 同样算横向', P.isItemContext(L({ display: 'flex', fd: 'row-reverse' })), true);
  eq('反例②【inline-flex 同罪】`display:inline-flex; flex-direction:row` → true（内联弹性容器一样会平分宽度）',
    P.isItemContext(L({ display: 'inline-flex', fd: 'row' })), true);
  eq('反例③【网格不分方向】`display:grid`（哪怕它按列排）→ true；'
    + '网格项落位由轨道决定，追加进去会改变既有项的落点，与弹性容器同罪',
    P.isItemContext(L({ display: 'grid', fd: 'column' })), true);
  eq('反例④【表格行也算】`display:table-row` → true（往 <tr> 里塞块级元素会生成匿名单元格）',
    P.isItemContext(L({ display: 'table-row' })), true);
  eq('反例⑤【单元格不算】`display:table-cell` → false；'
    + '直觉是「表格里的东西都算 item context」，但单元格是能正常容纳块级子元素的容器，追加译文是安全的',
    P.isItemContext(L({ display: 'table-cell' })), false);
  eq('反例⑥【普通块不算】`display:block` → false（最保守的一侧：就地追加）',
    P.isItemContext(L({ display: 'block' })), false);
}

/* ================================================================== */
/* 七、safeAnchor                                                       */
/* ================================================================== */

section('七、safeAnchor（上溯到「不受弹性约束」的插入锚点）');
{
  const { P, doc } = boot();
  const root = doc.getElementById('root');
  const mk = (fx, tag) => {
    const d = doc.createElement(tag || 'div');
    d.setAttribute('data-fx', fx || 'plain');
    return d;
  };

  /* 反例①：纵向弹性容器不上溯 */
  const colWrap = mk('flexCol');
  const colKid = mk('plain', 'p');
  colWrap.appendChild(colKid);
  root.appendChild(colWrap);
  eq('反例①【轴混淆·方向】单元落在 `flex-direction:column` 容器里 → 返回**单元自身**（不上溯）；'
    + '直觉是「在弹性容器里就该往外爬一层」，但纵向容器的直接子项不是「会被平分宽度的项」，'
    + '就地插入不会挤压任何兄弟',
    P.safeAnchor(colKid) === colKid, true);

  const rowWrap = mk('flexRow');
  const rowKid = mk('plain', 'p');
  rowWrap.appendChild(rowKid);
  root.appendChild(rowWrap);
  eq('对照：`flex-direction:row` 容器里的单元 → 上溯到容器本身',
    P.safeAnchor(rowKid) === rowWrap, true);

  /* 反例②：上溯跳数上限（4 跳） */
  let cur = root;
  const rows = [];
  for (let i = 0; i < 5; i++) { const d = mk('flexRow'); cur.appendChild(d); cur = d; rows.push(d); }
  const deepest = mk('plain', 'p');
  cur.appendChild(deepest);
  eq('反例②【跳数上限】5 层嵌套横向弹性容器里的单元 → 只爬到第 4 层（rows[1]），**不是**最外层；'
    + '直觉是「一直爬到不受弹性约束的地方」，但上限是 4 跳（deepest→rows[4]→rows[3]→rows[2]→rows[1]）。'
    + '把 4 改成 5 会爬到 rows[0]，这条立刻红',
    P.safeAnchor(deepest) === rows[1], true);
  eq('  并且确实不是最外层那个容器', P.safeAnchor(deepest) === rows[0], false);
  eq('  也不是单元自身（说明它确实往上爬了，红的是上限而不是没爬）',
    P.safeAnchor(deepest) === deepest, false);

  const plainWrap = mk('plain');
  const plainKid = mk('plain', 'p');
  plainWrap.appendChild(plainKid);
  root.appendChild(plainWrap);
  eq('对照：普通块流里的单元 → 就地退化（返回自身）', P.safeAnchor(plainKid) === plainKid, true);

  const topKid = mk('plain', 'p');
  root.appendChild(topKid);
  eq('对照：root 的直接子元素 → 返回自身（上溯到 body/documentElement 即止，不会把 body 当锚点）',
    P.safeAnchor(topKid) === topKid, true);
}

/* ================================================================== */
/* 八、canInsertAfter —— ★ P-1 已把它删除，本节改为「承接者」说明 ★      */
/* ================================================================== */

section('八、canInsertAfter（★ P-1 2026-09-29 已删除★）');
{
  const { P, R, doc } = boot();
  if (typeof P.canInsertAfter !== 'function') {
    note('canInsertAfter 在 content/renderer.js 中**已不存在**（P-1 2026-09-29 删除；'
      + '原注释见 NO_BLOCK_CHILD 上方：它已无调用点，留着等于给免检通道留一段随时能被接回去的现成代码）。');
    note('  它原有的结构判据（NO_BLOCK_CHILD + 父节点收不下块级子元素）由第二级的 canPlaceAfter 承接，'
      + '两者的唯一差别是 canPlaceAfter **允许 anchor === el**。其反例在第 九 节逐条覆盖。');
    note('  因此「既有静态判据」清单里这一条已自然消失 —— 不在本次反例审查范围内。');
  } else {
    note('检测到 canInsertAfter 又被接回了 —— 本节立即接管它的反例审查。');
    const div = doc.createElement('div');
    div.setAttribute('data-fx', 'plain');
    const kid = doc.createElement('p');
    kid.setAttribute('data-fx', 'plain');
    div.appendChild(kid);
    doc.getElementById('root').appendChild(div);

    eq('反例①【与 canPlaceAfter 的唯一差别】anchor 就是单元自身 → false；'
      + 'canPlaceAfter 允许它（「放成单元的下一个块级兄弟」），canInsertAfter 必须拒绝（它会插进自身内部）',
      P.canInsertAfter(kid, kid), false);

    const table = doc.createElement('table');
    const tr = doc.createElement('tr');
    const td = doc.createElement('td');
    td.setAttribute('data-fx', 'plain');
    tr.appendChild(td);
    table.appendChild(tr);
    doc.getElementById('root').appendChild(table);
    eq('反例②【父容器收不下块级子元素】锚点是 <td>（父节点 <tr>）→ false',
      P.canInsertAfter(td, kid), false);

    eq('反例③【游离节点】未挂进文档的锚点 → false', P.canInsertAfter(doc.createElement('p'), kid), false);

    const hostEl = doc.createElement('div');
    doc.getElementById('root').appendChild(hostEl);
    const sr = hostEl.attachShadow({ mode: 'open' });
    const inShadow = doc.createElement('p');
    sr.appendChild(inShadow);
    eq('反例④【父节点不是元素】锚点是 ShadowRoot 的直接子节点（父节点 nodeType=11）→ false',
      P.canInsertAfter(inShadow, kid), false);

    eq('对照：普通块流里的锚点 → true', P.canInsertAfter(kid, div), true);
    void R;
  }
}

/* ================================================================== */
/* 九、canPlaceAfter                                                    */
/* ================================================================== */

section('九、canPlaceAfter（第二级的结构预检）');
{
  const { R, doc } = boot();
  const root = doc.getElementById('root');
  const mk = (tag, fx) => {
    const d = doc.createElement(tag);
    d.setAttribute('data-fx', fx || 'plain');
    return d;
  };

  const div = mk('div');
  const kid = mk('p');
  div.appendChild(kid);
  root.appendChild(div);
  eq('对照：普通块流里的锚点 → true', R.canPlaceAfter(kid), true);

  /* 反例①：与 canInsertAfter 的**唯一**差别 */
  eq('反例①【与 canInsertAfter 的唯一差别】anchor 就是单元自身 → true；'
    + '直觉是「不能插到自己后面」（那是 canInsertAfter 的立场），'
    + '但搬移场景下「放成单元的下一个块级兄弟」正是最自然的「下方」形态，这里必须放行',
    R.canPlaceAfter(kid), true);

  /* 反例②：父容器收不下块级子元素 */
  const table = mk('table');
  const tr = mk('tr');
  const td = mk('td');
  td.appendChild(kid.ownerDocument.createTextNode('表格单元格'));
  tr.appendChild(td);
  table.appendChild(tr);
  root.appendChild(table);
  eq('反例②【父容器收不下块级子元素】锚点是 <td>（父节点 <tr>）→ false；'
    + '直觉是「有父节点就能插」，但往 <tr> 里插 div 会被浏览器重新解析成匿名单元格，译文凭空消失',
    R.canPlaceAfter(td), false);

  /* 反例③：游离节点 */
  eq('反例③【游离节点】未挂进文档的锚点 → false', R.canPlaceAfter(doc.createElement('p')), false);

  /* 反例④：父节点不是元素（Shadow DOM 的真实形态） */
  const hostEl = mk('div');
  root.appendChild(hostEl);
  const sr = hostEl.attachShadow({ mode: 'open' });
  const inShadow = mk('p');
  sr.appendChild(inShadow);
  eq('反例④【父节点不是元素】锚点是 ShadowRoot 的直接子节点（ShadowRoot 是 DocumentFragment，nodeType=11）→ false；'
    + '直觉是「Shadow DOM 里的节点照样有父节点」，但判据要求父节点必须是**元素**（nodeType===1）',
    R.canPlaceAfter(inShadow), false);

  /* 反例⑤：<select> 家族 */
  const sel = mk('select');
  const opt = mk('option');
  sel.appendChild(opt);
  root.appendChild(sel);
  eq('反例⑤【select 家族】锚点是 <option>（父节点 <select>）→ false（<select> 里只能放 option/optgroup）',
    R.canPlaceAfter(opt), false);
}

/* ================================================================== */
/* 十、rectOutOf                                                        */
/* ================================================================== */

section('十、rectOutOf（纯几何比较：译文越出这一层了吗）');
{
  const { P } = boot();
  const box = (l, t, r, b) => ({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t });
  const host = box(0, 0, 300, 40);

  eq('对照：完全落在容器内 → false', P.rectOutOf(box(10, 10, 100, 20), host), false);
  eq('对照：越出右侧 20px → true', P.rectOutOf(box(250, 10, 320, 20), host), true);

  /* 反例①：容差 RECT_TOL = 1 */
  eq('反例①【亚像素容差】译文右边只越过 0.5px → false；'
    + '直觉是「越界了就是 true」，但真实排版里亚像素舍入是常态，容差刻意留了 1px。'
    + '把 RECT_TOL 改成 0（「更严格」看起来更安全）后，这条立刻红',
    P.rectOutOf(box(250, 10, 300.5, 20), host), false);
  eq('  对照：越过 1.5px → true（容差是 1，不是无限）',
    P.rectOutOf(box(250, 10, 301.5, 20), host), true);

  /* 元反例·乙（零值两义 / L-19 陷阱 B）在 rect 层的再现 */
  const midPage = box(100, 200, 400, 240);   // 一个不在视图原点的容器（页面中部的内容区）
  eq('反例②【零值两义·L-19 陷阱 B】全零矩形（还没布局）与一个不在原点的可见容器相比 → **true**（判成「越界」）；'
    + '「零矩形」在这里与「整体跑到容器左上角之外」无法区分 —— 判据对两者都给 true。'
    + '所以「还没显示」必须由**调用方**先排除（judgeOne 用 inHiddenSubtree，relocate 只在非零矩形时才被调到）。'
    + '若有人在 rectOutOf 里补一句「零矩形直接返回 false」，这条立刻红',
    P.rectOutOf(box(0, 0, 0, 0), midPage), true);
  eq('  注意陷阱的边界：零矩形**恰好落在原点**、容器也贴着原点时它反而「不算越界」—— '
    + '同一个零矩形在不同容器下得到相反答案，这正是「零值两义」不可当判据用力的原因',
    P.rectOutOf(box(0, 0, 0, 0), host), false);

  /* 反例③：越界的轴它不看 */
  eq('反例③【轴盲】译文只**纵向**越出（横向完全在内）→ true；'
    + 'rectOutOf 不区分哪一轴越界，「true」不等于「被裁」—— '
    + '是裁还是只是滚出去，必须由调用方的 scrollsOutOf 按轴再判一次',
    P.rectOutOf(box(10, 60, 100, 80), host), true);
  eq('  横向同理 → true', P.rectOutOf(box(350, 10, 400, 20), host), true);

  /* 反例④：接口契约 —— 只认四条边 */
  eq('反例④【接口契约】只传 {width,height} 的矩形（没有 left/right/top/bottom）→ false；'
    + 'undefined 既不 < 也不 > 任何数字，于是「越界」被静默判成「没越界」。'
    + '判据只认 left/right/top/bottom 四条边，不接受 width/height 形式的矩形（DOMRect 恰好两条都有，才一直没暴露）',
    P.rectOutOf({ width: 9999, height: 9999 }, host), false);

  probe('真实 getBoundingClientRect() 的**分数像素**取值与 RECT_TOL=1 的匹配度',
    'jsdom 的 getBoundingClientRect 恒为零矩形，本文件的矩形是手工赋值。'
    + '「真实排版里亚像素越界的实际分布是否被 1px 容差覆盖」须真实浏览器探针（2 组视口/缩放）。');
}

/* ================================================================== */
/* 十一、inHiddenSubtree                                                */
/* ================================================================== */

section('十一、inHiddenSubtree（零矩形是「还没显示」还是「真没了」）');
{
  const { P, doc } = boot();
  const root = doc.getElementById('root');
  const mk = (fx, tag) => {
    const d = doc.createElement(tag || 'div');
    d.setAttribute('data-fx', fx || 'plain');
    return d;
  };

  /* 反例①：只看祖先，不看自己 */
  const visWrap = mk('plain');
  const selfHidden = mk('hiddenBox');
  visWrap.appendChild(selfHidden);
  root.appendChild(visWrap);
  eq('反例①【只看祖先、不看自己】译文节点**自己**是 display:none、祖先都可见 → false；'
    + '直觉是「自己不可见当然算隐藏子树」，但判据从 node.parentElement 起步，从不检查 node 自身。'
    + '此时零矩形会被判 invisible 并搬走 —— 「自己不可见」是这一层唯一的盲区',
    P.inHiddenSubtree(selfHidden), false);

  const hiddenWrap = mk('hiddenBox');
  const inHidden = mk('plain');
  hiddenWrap.appendChild(inHidden);
  root.appendChild(hiddenWrap);
  eq('对照：祖先 display:none → true（这就是 C-27 要放行的现场）', P.inHiddenSubtree(inHidden), true);

  /* 反例②：跳数上限（CLIP_HOPS + 4 = 10）—— 折叠层必须在**最外**，节点在最里 */
  const hiddenDeep = mk('hiddenBox');
  root.appendChild(hiddenDeep);
  let cur = hiddenDeep;
  for (let i = 0; i < 10; i++) { const d = mk('plain'); cur.appendChild(d); cur = d; }
  const deepNode = mk('plain');
  cur.appendChild(deepNode);
  eq('反例②【跳数上限】折叠面板落在第 **11** 跳祖先上（对话框里层层 wrapper 才到那个 hidden 的 tabpanel）→ false；'
    + '直觉是「只要上面有 display:none 就能找到」，但上限是 CLIP_HOPS+4=10 跳。'
    + '把上限调大，这条会红',
    P.inHiddenSubtree(deepNode), false);

  const hiddenDeep2 = mk('hiddenBox');
  root.appendChild(hiddenDeep2);
  let cur2 = hiddenDeep2;
  for (let i = 0; i < 9; i++) { const d = mk('plain'); cur2.appendChild(d); cur2 = d; }
  const deepNode2 = mk('plain');
  cur2.appendChild(deepNode2);
  eq('对照：折叠面板落在第 10 跳 → 找得到（说明上一条红的是「上限」而不是「判据坏了」）',
    P.inHiddenSubtree(deepNode2), true);

  /* 反例③：只认 display，不认新的隐藏方式 */
  const cvWrap = mk('contentVis');
  const cvItem = mk('plain');
  cvWrap.appendChild(cvItem);
  root.appendChild(cvWrap);
  eq('反例③【零值两义·新隐藏方式】祖先 `content-visibility:hidden`（长列表虚拟化的新写法：子树不被渲染、'
    + '矩形恒为零）→ false；直觉是「子树根本没有布局 ⇒ 算隐藏」，但判据只认 `display === "none"`。'
    + '零矩形会被判 invisible 并搬走。若有人把它扩成「display:none 或 content-visibility:hidden」，这条会红 —— '
    + '那正是**必须先补真实浏览器探针再改**的地方（见文末清单第 7 条）',
    P.inHiddenSubtree(cvItem), false);

  const visHidden = mk('plain');
  const visItem = mk('plain');
  visHidden.appendChild(visItem);
  root.appendChild(visHidden);
  eq('反例④【同族盲区】`visibility:hidden` / `opacity:0` 完全不在判据里 → false；'
    + '它们保留了布局（矩形非零），所以走不到这条判据 —— 但也因此 judgeOne 会判「通过」，'
    + '看不见的译文不会被救。这是**登记在案的取舍**，不是漏改',
    P.inHiddenSubtree(visItem), false);
  probe('`visibility:hidden` / `opacity:0` 下 getBoundingClientRect 是否为非零',
    'jsdom 无布局。若真实浏览器确实返回非零矩形，则 judgeOne 对这类「看不见但占位」的译文一律放行 —— '
    + '取舍是否可接受须真实浏览器探针确认。');
}

/* ================================================================== */
/* 十二、scrollsOutOf                                                   */
/* ================================================================== */

section('十二、scrollsOutOf（越界的那一轴能不能滚回来）');
{
  const { P } = boot();
  const box = (l, t, r, b) => ({ left: l, top: t, right: r, bottom: b });
  const panel = box(0, 0, 400, 500);
  const vOnly = box(0, 600, 400, 620);     // 只纵向越界（滚动区下方）
  const hOnly = box(500, 100, 600, 120);   // 只横向越界
  const both = box(500, 600, 600, 620);    // 两轴都越界

  eq('对照：纵向越界 + 纵轴 scroll → true（滚回来就能看见）',
    P.scrollsOutOf(L({ overflowY: 'scroll' }), vOnly, panel), true);
  eq('对照：纵向越界 + 纵轴 auto → true（auto 同样会出滚动条）',
    P.scrollsOutOf(L({ overflowY: 'auto' }), vOnly, panel), true);

  /* 元反例·甲（轴混淆）—— 同轴原则的另一半 */
  eq('反例①【轴混淆·同轴原则的另一半】两轴都越界，纵轴可滚、横轴 hidden → false；'
    + '直觉是「有一轴能滚就放过」，但横轴不可滚且越界 ⇒ 那一轴的内容真的够不着。'
    + '若把最后写成 `return yScroll || xScroll`，这条立刻红',
    P.scrollsOutOf(L({ overflowX: 'hidden', overflowY: 'scroll' }), both, panel), false);
  eq('  对照：两轴都越界且两轴都可滚 → true',
    P.scrollsOutOf(L({ overflowX: 'auto', overflowY: 'auto' }), both, panel), true);

  /* 反例②：clip 不是 scroll 家族 */
  eq('反例②【同义关键字的反面】纵向越界 + `overflow-y:clip` → false；'
    + 'clip 与 hidden 同类（内容真的够不着），别把它当成 scroll 家族的一员',
    P.scrollsOutOf(L({ overflowY: 'clip' }), vOnly, panel), false);

  /* 反例③：返回值两义 */
  eq('反例③【返回值两义】完全在容器内 → false；'
    + '这个 false 与「越界了但那一轴不可滚」共用同一个返回值，调用方**不能**用它区分两者 —— '
    + 'judgeOne 里它只在 rectOutOf 已判 true 之后才被调用，靠调用顺序消歧',
    P.scrollsOutOf(L({ overflowY: 'hidden' }), box(10, 10, 100, 20), panel), false);

  /* 反例④：容差内不算越界 */
  eq('反例④【亚像素容差】纵向只越出 0.5px → false（连「越界」都不算，更谈不上放行）',
    P.scrollsOutOf(L({ overflowY: 'scroll' }), box(0, 0, 400, 500.5), panel), false);

  eq('反例⑤【只横向越界 + 横轴可滚】→ true',
    P.scrollsOutOf(L({ overflowX: 'scroll' }), hOnly, panel), true);
}

/* ================================================================== */
/* 十三、judgeOne 的四条失败原因                                        */
/* ================================================================== */

section('十三、judgeOne 的四条失败原因与「通过」');
{
  const { R, doc } = boot();
  const root = doc.getElementById('root');
  const rec = (node, placement) => ({ mode: 'below', node: node, placement: placement || 'inside', text: 'x' });

  const host = (parent, fx, tag) => {
    const d = doc.createElement(tag || 'p');
    d.setAttribute('data-fx', fx || 'plain');
    parent.appendChild(d);
    return d;
  };
  const trans = (el, rect, cls) => {
    const t = doc.createElement('div');
    t.className = cls || 'ct-trans ct-trans--in';
    const s = doc.createElement('span');
    s.textContent = '译文';
    t.appendChild(s);
    el.appendChild(t);
    t.__ctRect = rect || null;
    return t;
  };

  /* ---- 失败原因 1：invisible ---- */
  {
    const h = host(root, 'plain');
    const t = trans(h, [0, 0, 0, 0]);
    eq('invisible：祖先可见时的零矩形（译文真被吃掉了）→ "invisible"',
      R.judgeOne(h, rec(t)), 'invisible');
  }
  /* 元反例·乙（L-19 陷阱 B）零矩形两义 */
  {
    const hiddenWrap = host(root, 'hiddenBox', 'div');
    const h = host(hiddenWrap, 'plain');
    const t = trans(h, [0, 0, 0, 0]);
    eq('反例①【零值两义·L-19 陷阱 B】零矩形 + 祖先 display:none（面板关着）→ null（放行）；'
      + '直觉是「零矩形 = 被裁掉」，但「还没显示」与「真不可见」在这一层的唯一区别就是祖先的 display —— '
      + '判错会把整块关着的面板里的译文倒到页面上（remoteok 259 条地区选项实证，C-27）',
      R.judgeOne(h, rec(t)), null);
  }

  /* ---- 失败原因 2：ellipsized ---- */
  {
    const h = host(root, 'titleFix');
    h.__scrollWidth = 900;
    h.__clientWidth = 300;
    const t = trans(h, [310, 100, 400, 18], 'ct-trans ct-trans--inl');
    eq('ellipsized：宿主 nowrap + ellipsis + 内容确实溢出 → "ellipsized"',
      R.judgeOne(h, rec(t, 'inline')), 'ellipsized');
  }
  /* 反例：阈值 `> clientWidth + 1` */
  {
    const h = host(root, 'titleFix');
    h.__ctRect = [0, 100, 300, 24];
    h.__scrollWidth = 301;      // 恰好 clientWidth + 1
    h.__clientWidth = 300;
    const t = trans(h, [10, 100, 100, 18], 'ct-trans ct-trans--inl');
    eq('反例②【阈值与亚像素】宿主溢出量恰好 = clientWidth + 1 → 不判 ellipsized，走几何链后 null；'
      + '直觉是「溢出 1px 也是被吃」，阈值写的是 `> clientWidth + 1`。'
      + '把 `+ 1` 去掉（「更严格」看起来更安全）后，这条立刻红',
      R.judgeOne(h, rec(t, 'inline')), null);
  }
  /* 反例：text-overflow 不是 ellipsis（硬切） */
  {
    const h = host(root, 'nowrapClip');
    h.__ctRect = [0, 300, 300, 24];
    h.__scrollWidth = 900;
    h.__clientWidth = 300;
    const t = trans(h, [10, 300, 400, 18], 'ct-trans ct-trans--inl');
    eq('反例③【省略号判据只认 text-overflow:ellipsis】宿主 `white-space:nowrap; overflow:hidden`、'
      + '文字被**硬切**（text-overflow 取默认 clip）→ 归因是 "spills-host" 而不是 "ellipsized"；'
      + '直觉是「被吃掉了都算 ellipsized」，但两种归因指向不同的站点机制。'
      + '给省略号那一支补上 `|| hl.te === "clip"`，这条立刻红',
      R.judgeOne(h, rec(t, 'inline')), 'spills-host');
  }

  /* ---- 失败原因 3：clipped ---- */
  {
    const capWrap = host(root, 'capAnc', 'div');
    capWrap.__ctRect = [0, 0, 600, 40];
    const h = host(capWrap, 'plain');
    const t = trans(h, [0, 50, 600, 20]);
    eq('clipped：越出**声明了 max-height** 的祖先 → "clipped"', R.judgeOne(h, rec(t)), 'clipped');
  }
  /* 元反例·丙（使用值 vs 声明值）—— 定高裁切只能归到 spills-host */
  {
    const clipWrap = host(root, 'clipAnc', 'div');
    clipWrap.__ctRect = [0, 0, 600, 40];
    const h = host(clipWrap, 'plain');
    const t = trans(h, [0, 50, 600, 20]);
    eq('反例④【使用值 vs 声明值·L-1】越出一个只是 `overflow:hidden; height:40px` 的祖先 → "spills-host"'
      + '（而**不是** "clipped"）；直觉是「定高裁切 = 站点做了截断 = clipped」，'
      + '但 height 从 computed style 读出来是使用值，静态判据没法把它与声明式硬约束分开，'
      + '只能由几何链归到 spills-host。让 constrainsContent 重新认高度，这条立刻红',
      R.judgeOne(h, rec(t)), 'spills-host');
  }

  /* 元反例·甲（轴混淆）—— 可滚面板里的两种越界 */
  {
    const panel = host(root, 'scrollPanel', 'div');
    panel.__ctRect = [0, 0, 400, 500];
    const h = host(panel, 'plain');
    const t = trans(h, [0, 900, 400, 20]);
    eq('反例⑤【轴混淆】纵向可滚面板里「滚出去」的译文 → null（放行）；'
      + '直觉是「越出容器边界就是被裁」，但滚动条之下那几行滚回来就看得见',
      R.judgeOne(h, rec(t)), null);
  }
  {
    const panel = host(root, 'scrollPanel', 'div');
    panel.__ctRect = [0, 0, 400, 500];
    const h = host(panel, 'plain');
    const t = trans(h, [0, 200, 900, 20]);
    eq('反例⑥【同轴原则的另一半】同一面板里横向越界（横轴 hidden、不可滚）→ "spills-host"',
      R.judgeOne(h, rec(t)), 'spills-host');
  }

  /* 反例：不要求「越界的那层是直接父元素」 */
  {
    const clipWrap = host(root, 'clipAnc', 'div');
    clipWrap.__ctRect = [0, 0, 600, 40];
    const mid = host(clipWrap, 'plain', 'div');
    const h = host(mid, 'plain');
    const t = trans(h, [0, 60, 600, 20]);
    eq('反例⑦【不要求直接父元素】越界发生在**隔了一层**普通块的祖先上 → 照样判 "spills-host"；'
      + '直觉是「只看直接父元素」，但译文是普通流子项，越出非直接父元素是真实存在的',
      R.judgeOne(h, rec(t)), 'spills-host');
  }

  /* 反例：上溯跳数上限（CLIP_HOPS + 2 = 8） */
  {
    const mkPlain = (parent) => {
      const d = doc.createElement('div');
      d.setAttribute('data-fx', 'plain');
      parent.appendChild(d);
      return d;
    };
    const mkClipOuter = () => {
      const d = doc.createElement('div');
      d.setAttribute('data-fx', 'clipAnc');
      d.__ctRect = [0, 0, 600, 40];
      root.appendChild(d);
      return d;
    };

    const outer9 = mkClipOuter();
    let c9 = outer9;
    for (let i = 0; i < 7; i++) c9 = mkPlain(c9);      // 裁切层落在第 9 跳
    const h9 = host(c9, 'plain');
    const t9 = trans(h9, [0, 60, 600, 20]);
    eq('反例⑧【跳数上限】裁切容器落在第 **9** 跳祖先上（maxHops = CLIP_HOPS+2 = 8）→ null；'
      + '直觉是「沿祖先链总能找到」，但上溯只有 8 跳，第 9 跳根本没被读过',
      R.judgeOne(h9, rec(t9)), null);

    const outer8 = mkClipOuter();
    let c8 = outer8;
    for (let i = 0; i < 6; i++) c8 = mkPlain(c8);      // 裁切层落在第 8 跳
    const h8 = host(c8, 'plain');
    const t8 = trans(h8, [0, 60, 600, 20]);
    eq('  对照：同一容器落在第 8 跳 → 判 "spills-host"（说明上一条红的是「上限」而不是「判据坏了」）',
      R.judgeOne(h8, rec(t8)), 'spills-host');
  }

  /* ---- 通过 ---- */
  {
    const h = host(root, 'plain');
    const t = trans(h, [10, 300, 200, 20]);
    eq('通过：译文完整落在容器内 → null', R.judgeOne(h, rec(t)), null);
  }
  {
    const h = host(root, 'plain');
    const t = doc.createElement('div');
    t.className = 'ct-trans';
    eq('通过：未挂进文档的译文节点 → null（交给 pruneDisconnected）', R.judgeOne(h, rec(t)), null);
  }
}

/* ==================================================================
 * 十四、免检通道复查（P-1 之外的「不可逆 DOM 变更 + 第二级不复核」）
 * ------------------------------------------------------------------
 * P-1 把 `placementFor` 的裁切分支改成「只打 risk 标、不搬」，把不可逆搬迁
 * 收进第二级 `relocate`。本节回答的是下一个问题：
 *   **还有没有第二处「产生了不可逆 DOM 变更、但第二级从不回看」的路径？**
 *
 * 「不可逆」的口径不是「改了 DOM」，而是「改完之后，没有任何量测会去复核它」。
 * 第二级的入口是 `verifyBatch`，它的过滤是：
 *     if (!rec || rec.mode !== 'below' || !rec.risk || rec.moved) continue;
 * 于是「没有 risk 标」或「mode 不是 below」的单元，一次都不会被量。
 *
 * 本节 A 组原为「免检通道」的**特征断言（钉现状）**，钉的就是「跨父插入但不打标」。
 * ★ C-36（2026-09-29）已经把这条通道堵上 ★ —— `placementFor` 的 ③ 横向弹性行
 * 分支现在返回 `risk: 'flex-row-outside'`（落点标，**不计入** `CLIP_ENTRY_RISK`）。
 * 于是 A 组 4 条断言由「记录缺陷」翻转为「钉住修复后的契约」：
 *   · 计划里**必须**有 `risk === 'flex-row-outside'`；
 *   · registry 里 `risk === 'flex-row-outside'`；
 *   · `relocated` +1（被量、被搬）**但** `rescuedFromClip` 不 +1（不串口径）；
 *   · 判决痕迹 `verdict === 'unresolved:invisible'`。
 * 这正是本套件设计的用法：**通道被堵上时断言会红，那时同步更新断言，
 * 而不是把产品代码回退。** 每条标题里都写明了这一层意思。
 * ================================================================== */

section('十四、免检通道复查：跨父插入却永不量测 / 给站点元素加改盒模型的类');
{
  /* ---- A) placementFor 的 flex-row 分支：跨父插入 + 无 risk 标 ---- */
  {
    const { R, doc, CT } = boot();
    const S = Object.assign({}, CT.DEFAULT_SETTINGS, { displayMode: 'below' });
    const root = doc.getElementById('root');
    const mk = (fx, tag) => {
      const d = doc.createElement(tag || 'div');
      d.setAttribute('data-fx', fx || 'plain');
      return d;
    };

    const outer = mk('flexRow');            // 外层横向弹性容器
    const unitEl = mk('flexRow');           // 单元自身就是横向弹性容器
    unitEl.appendChild(mk('plain', 'a'));   // 只含内联子元素 ⇒ 是叶子块、可成单元
    outer.appendChild(unitEl);
    root.appendChild(outer);

    const plan = R.placementFor(unitEl, S);
    eq('免检①【跨父插入】横向弹性容器自身 → kind="after"（译文不进单元内部）', plan.kind, 'after');
    eq('  锚点是**外层容器**而不是单元自身 ⇒ 译文会被插到单元之外（归属已变更）',
      plan.anchor === outer, true);
    /* ★ C-36（2026-09-29）：跨父落点必须带标。
     * 这条断言**原本是「免检通道」的特征断言**（当时期望 `plan.risk === undefined`，
     * 因为它与 P-1 修掉的裁切分支是同一形状却没进整改名单）。
     * C-36 补上了 `FLEX_ROW_RISK` 之后它变红 —— **那是修好了，不是坏了**。
     * 现在它钉的是修复后的契约；若有人把这个标去掉，本条会红（那是坏了）。 */
    eq('  ★ C-36 修复后：横向弹性行的跨父落点**必须**带 risk 标 '
      + '（`flex-row-outside` 是「形态」标，不是「裁切」标）',
      plan.risk, 'flex-row-outside');

    eq('  渲染成功', R.renderUnit(unitEl, '【译】标签行', S, 'h1', plan), true);
    const node = doc.querySelector('.' + CT.TRANS_CLASS);
    ok('  译文节点落在**单元之外**（el.contains(node) === false）',
      !!node && unitEl.contains(node) === false);
    ok('  并且挂在单元的外层容器之后（跨父插入确实发生了）',
      !!node && node.parentNode === root);
    eq('  registry 里 risk 是 flex-row-outside（有标 ⇒ 第二级会复核这条通道，不再是免检）',
      R.registry.get(unitEl).risk, 'flex-row-outside');

    /* 把译文做成「不可见」：第二级**会**量它，并把它交给 relocate。
     * 本夹具的译文矩形恒为零 ⇒ relocate 搬完复验仍 invisible ⇒ 成功搬迁数 0。
     * 注意：verifyBatch 返回的是「成功搬迁数」，返回 0 **不等于**「没被复核」。 */
    node.__ctRect = [0, 0, 0, 0];
    const before = R.getStats().relocated;
    const beforeRescued = R.getStats().rescuedFromClip;
    eq('  ★★ 译文不可见 ⇒ verifyBatch 量出 invisible 并进入 relocate'
      + '（返回值 0 是「复验未通过的成功搬迁数」，不是「免检」）',
      R.verifyBatch([unitEl]), 0);
    eq('  第二级确实复核了这条通道（rec.moved === true —— relocate 已尝试搬迁）',
      R.registry.get(unitEl).moved, true);
    eq('  ★ relocated 计数 +1（有标 ⇒ 被量、被搬）', R.getStats().relocated, before + 1);
    eq('  ★★ rescuedFromClip 不 +1 —— 落点标触发的搬迁**不串进裁切口径**',
      R.getStats().rescuedFromClip, beforeRescued);
    eq('  registry 判决痕迹 = unresolved:invisible（第二级看了，只是复验没救活）',
      R.registry.get(unitEl).verdict, 'unresolved:invisible');
  }

  /* ---- B) displayMode === 'hover'：给**站点元素**加改盒模型的类 + 写行内 style ---- */
  {
    const { R, doc, CT } = boot();
    const root = doc.getElementById('root');
    const unitEl = doc.createElement('p');
    unitEl.setAttribute('data-fx', 'plain');
    unitEl.textContent = 'Hello world';
    root.appendChild(unitEl);

    const Sh = Object.assign({}, CT.DEFAULT_SETTINGS, { displayMode: 'hover' });
    eq('免检②【改站点元素的盒模型】hover 模式渲染成功',
      R.renderUnit(unitEl, '【译】你好世界', Sh, 'h2'), true);
    eq('  单元被加上 ct-hover —— content.css:190 给它加了 `border-bottom:1px dashed !important`，'
      + '改的是**站点元素自己的盒模型**（不是我们新建的节点）',
      unitEl.classList.contains('ct-hover'), true);
    ok('  同时给站点元素写了行内 style（--ct-tip）',
      (unitEl.getAttribute('style') || '').indexOf('--ct-tip') >= 0,
      JSON.stringify(unitEl.getAttribute('style')));
    eq('  registry 记录 mode="hover" ⇒ verifyBatch 的 `rec.mode !== "below"` 直接跳过',
      R.registry.get(unitEl).mode, 'hover');
    eq('  verifyBatch 对 hover 单元返回 0', R.verifyBatch([unitEl]), 0);
    eq('  auditVisibility 也不收它（只收 below / below-keep）', R.auditVisibility().length, 0);
    note('hover 的 1px border-bottom 究竟会不会推动站点布局、推多少，jsdom 不解析 content.css、不算布局 ——'
      + '须真实浏览器探针（夹具与期望值见 docs/P-1-免检通道复查.md）。');
  }

  /* ---- C) 站点元素属性写入 data-ct-src（判定：无关，但登记） ---- */
  {
    const { R, doc, CT } = boot();
    const root = doc.getElementById('root');
    const unitEl = doc.createElement('p');
    unitEl.setAttribute('data-fx', 'plain');
    unitEl.textContent = 'Plain paragraph.';
    root.appendChild(unitEl);

    const S = Object.assign({}, CT.DEFAULT_SETTINGS, { displayMode: 'below' });
    R.renderUnit(unitEl, '【译】普通段落', S, 'h3');
    eq('登记：渲染后站点单元被写上 data-ct-src（content.css 里没有它的任何选择器 ⇒ 不改变布局）',
      unitEl.hasAttribute('data-ct-src'), true);
    R.clearUnit(unitEl, true);
    eq('  且 clearUnit 会把它摘掉（可逆，不残留）', unitEl.hasAttribute('data-ct-src'), false);
  }

  /* ---- D) 已知通道对照：mode === 'replace' 含受保护行内元素（team-lead 已登记，仅作对照） ---- */
  {
    const { R, doc, CT } = boot();
    const root = doc.getElementById('root');
    const unitEl = doc.createElement('p');
    unitEl.setAttribute('data-fx', 'plain');
    const link = doc.createElement('a');
    link.textContent = 'the docs';
    unitEl.appendChild(doc.createTextNode('Read '));
    unitEl.appendChild(link);
    unitEl.appendChild(doc.createTextNode(' now'));
    root.appendChild(unitEl);

    const Sr = Object.assign({}, CT.DEFAULT_SETTINGS, { displayMode: 'replace' });
    eq('对照（已知免检）replace 模式 + 含 <a> → 渲染成功',
      R.renderUnit(unitEl, '【译】阅读文档', Sr, 'h4'), true);
    eq('  译文被落到单元之外（ct-trans--keep 兄弟节点）——与免检①同一形状',
      root.querySelectorAll('.ct-trans--keep').length, 1);
    eq('  记录 mode="below-keep" ⇒ 同样被 verifyBatch 的 mode 过滤排除',
      R.registry.get(unitEl).mode, 'below-keep');
    eq('  verifyBatch 返回 0（P-1 未覆盖此通道，已知并已登记）', R.verifyBatch([unitEl]), 0);
  }
}

/* ==================================================================
 * 元反例结构覆盖表（人工核对用，不是断言）
 * ------------------------------------------------------------------
 * 判据                       甲轴混淆  乙零值两义  丙使用值/声明值  丁恒真
 * hasClipContext               ●①②      ●②空串        ●⑥规范改写      —
 * constrainsContent            ●②③      ●④⑤          ●①              —
 * forcesNoWrap                 —         —            ●④(双值语法)    ●子串陷阱
 * collapsesContent             ●⑤反向    ●①②          ●③              —
 * clipInfo                     ●②        ●③(跳数)      ●②(同 L-1)      —
 * isItemContext                ●①        —            —               —
 * safeAnchor                   ●①        ●②(跳数)      —               —
 * canPlaceAfter                —         —            —               ●①与 canInsertAfter 的差别
 * rectOutOf                    ●③轴盲    ●②零矩形      ●①亚像素         —
 * inHiddenSubtree              —         ●①②③         —               —
 * scrollsOutOf                 ●①②       ●③返回值两义   ●④亚像素         —
 * judgeOne(四原因)             ●⑤⑥       ●①            ●②③④⑦         —
 * ================================================================== */

/* ================================================================== */

console.log('\n' + '\u2500'.repeat(58));
if (probes.length) {
  console.log('须 2 组真实浏览器探针（jsdom 不可验 —— 这些是**排版引擎**的行为，不是判据函数的行为）');
  probes.forEach((p, i) => {
    console.log('  [' + (i + 1) + '] ' + p.label);
    console.log('      ' + p.why);
  });
  console.log('');
}
if (failures.length) {
  console.log('失败 ' + failures.length + ' 项，通过 ' + passed + ' 项');
  failures.forEach((f) => console.log('  \u2717 ' + f));
  process.exit(1);
}
console.log('全部通过：' + passed + ' 项断言');
