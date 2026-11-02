/*
 * 双语助手 · 划词翻译自检
 * ------------------------------------------------------------------
 * 划词这一块的失败模式分两类：
 *
 *   A. 定位（computePosition）—— 竞品公开的弱点是「气泡跑到屏幕外」。
 *      这个问题在开发机上永远复现不了（谁会在大屏上把窗口拖到 600px 宽？），
 *      但用户实际会。所以这里把视口四边的极端位置穷举成断言。
 *
 *   B. 误触发（isOwnNode / shouldTrigger）—— 用户划到自己页面里的【译文】
 *      会再弹一个气泡出来（译文套译文）；划到空白处会弹一个空气泡。
 *      这两条只在特定 DOM 结构下出现，手工测很难穷举。
 *
 * 特别值得注意的是 isOwnNode 的 shadow 穿越：shadow root 内的译文节点，
 * parentElement 链在边界处就断了，只有 getRootNode().host 能接上。
 * 不处理这条，自定义元素（很多设计系统都用）里的译文会被当成页面内容。
 *
 * 运行：
 *   node tools/test-selection.mjs
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
function eqj(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(label + (a === b ? '' : '（期望 ' + b + '，实际 ' + a + '）'), a === b);
}
function section(t) { console.log('\n' + t); }

/* ------------------------------------------------------------------ */
/* 装配：constants → layers → selection，共享同一个 isolated world     */
/* ------------------------------------------------------------------ */

const dom = new JSDOM('<!DOCTYPE html><html><body><p id="host">Body text.</p></body></html>', {
  url: 'https://example.com/read',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const ctx = dom.getInternalVMContext();
for (const rel of ['shared/constants.js', 'content/layers.js', 'content/selection.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), ctx, { filename: rel });
}
const w = dom.window;
const S = w.CT.selection;

/* ================================================================== */
/* 一、气泡定位：视口四边的极端情况                                     */
/* ================================================================== */

section('一、computePosition 不越界');

{
  const V = { width: 1000, height: 600 };
  const SIZE = { width: 300, height: 120 };

  // 常规情形：与选区左对齐、放在下方
  eqj('常规（左上方选区）',
    S.computePosition({ left: 100, top: 100, right: 200, bottom: 120 }, SIZE, V),
    { left: 100, top: 128, flipped: false });

  // 右下角：水平要右对齐，垂直要翻到上方
  eqj('右下角（水平右对齐 + 垂直翻转）',
    S.computePosition({ left: 900, top: 520, right: 980, bottom: 560 }, SIZE, V),
    { left: 680, top: 392, flipped: true });

  // 右上角：只有水平需要让步
  eqj('右上角（只水平让步，不翻转）',
    S.computePosition({ left: 900, top: 20, right: 980, bottom: 50 }, SIZE, V),
    { left: 680, top: 58, flipped: false });

  // 左下角：水平贴左边界，且下方容不下 → 垂直翻转
  eqj('左下角（贴左边界 + 垂直翻转）',
    S.computePosition({ left: 2, top: 450, right: 120, bottom: 480 }, SIZE, V),
    { left: 12, top: 322, flipped: true });

  // 底部中央：垂直翻转
  eqj('底部中央（垂直翻转）',
    S.computePosition({ left: 400, top: 560, right: 600, bottom: 590 }, SIZE, V),
    { left: 400, top: 432, flipped: true });

  // 顶部中央 + 气泡高于可用空间：上下都放不下时选空间大的一侧，并夹在边内
  const tall = { width: 1000, height: 300 };
  const tallSize = { width: 300, height: 280 };
  eqj('上下都放不下时贴边并保持完整可见',
    S.computePosition({ left: 400, top: 100, right: 600, bottom: 120 }, tallSize, tall),
    { left: 400, top: 12, flipped: false });

  // 气泡比视口还宽（长文本）：只能贴左边，此时左边界胜出
  const narrow = { width: 400, height: 600 };
  eqj('气泡宽于视口时贴左边界',
    S.computePosition({ left: 50, top: 50, right: 150, bottom: 70 }, { width: 500, height: 100 }, narrow),
    { left: 12, top: 78, flipped: false });

  // 自定义 gap / edge 生效
  eqj('自定义 gap / edge 生效',
    S.computePosition({ left: 100, top: 100, right: 200, bottom: 120 }, SIZE, V, { gap: 20, edge: 30 }),
    { left: 100, top: 140, flipped: false });

  /* --- 不变量：只要气泡装得下、且选区在视口内，气泡就必须完整可见 --- */
  const EDGE = 12;
  const GAP = 8;
  let worst = 0;
  let checked = 0;
  let bad = null;
  let belowChecked = 0;
  let belowBad = null;
  for (let vw of [360, 480, 800, 1024]) {
    for (let vh of [320, 480, 600, 900]) {
      for (let bw of [180, 300, 420]) {
        for (let bh of [60, 120, 240]) {
          if (bw + EDGE * 2 > vw || bh + EDGE * 2 > vh) continue;   // 气泡装不下，跳过
          // 锚点必须整个落在视口内 —— 选区跨到视口外（滚动内容）时
          // 气泡的贴边策略会主动放弃「完整可见」，那是另一条分支
          for (let x = 0; x + 60 <= vw; x += 37) {
            for (let y = 0; y + 20 <= vh; y += 41) {
              const a = { left: x, top: y, right: x + 60, bottom: y + 20 };
              const p = S.computePosition(a, { width: bw, height: bh }, { width: vw, height: vh });
              checked++;
              const over = Math.max(
                EDGE - p.left,
                (p.left + bw) - (vw - EDGE),
                EDGE - p.top,
                (p.top + bh) - (vh - EDGE),
                0
              );
              if (over > worst) { worst = over; }
              if (over > 0 && !bad) bad = { vw, vh, bw, bh, x, y, p, over };

              // 下方放得下时，必须放在下方且与选区保持 GAP 间距
              if (a.bottom + GAP + bh + EDGE <= vh) {
                belowChecked++;
                if (p.flipped || p.top !== a.bottom + GAP) {
                  if (!belowBad) belowBad = { vw, vh, bw, bh, x, y, p };
                }
              }
            }
          }
        }
      }
    }
  }
  ok('穷举 ' + checked + ' 种视口/气泡/锚点组合，全部完整落在视口内',
    worst === 0 && !bad,
    bad ? JSON.stringify(bad) : '最大越界 ' + worst);
  ok('  下方放得下的 ' + belowChecked + ' 种情形都放在下方且保持间距',
    belowBad === null,
    belowBad ? JSON.stringify(belowBad) : '');
}

/* ================================================================== */
/* 二、rectFromRange：锚点取自首行左/顶与末行右/底                      */
/* ================================================================== */

section('二、rectFromRange');

{
  eq('null 输入返回 null', S.rectFromRange(null), null);

  eq('无矩形返回 null',
    S.rectFromRange({ getClientRects: function () { return []; }, toString: function () { return 'x'; } }), null);

  eq('全是零尺寸矩形返回 null',
    S.rectFromRange({
      getClientRects: function () { return [{ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }]; },
      toString: function () { return 'x'; }
    }), null);

  eq('getClientRects 抛错返回 null',
    S.rectFromRange({ getClientRects: function () { throw new Error('boom'); }, toString: function () { return 'x'; } }), null);

  eq('toString 抛错返回 null',
    S.rectFromRange({
      getClientRects: function () { return [{ left: 1, top: 2, right: 3, bottom: 4, width: 2, height: 2 }]; },
      toString: function () { throw new Error('boom'); }
    }), null);

  // 跨两行的选区：左/顶取第一行，右/底取最后一行
  const twoLines = S.rectFromRange({
    getClientRects: function () {
      return [
        { left: 10, top: 20, right: 100, bottom: 40, width: 90, height: 20 },
        { left: 10, top: 40, right: 60, bottom: 60, width: 50, height: 20 }
      ];
    },
    toString: function () { return 'hello world'; }
  });
  eqj('跨行选区：左/顶取首行、右/底取末行', twoLines.anchor, { left: 10, top: 20, right: 60, bottom: 60 });
  eq('  文本原样带出', twoLines.text, 'hello world');

  // 末尾混入零尺寸伪矩形（换行处会产生）→ 必须被过滤掉，否则气泡会贴到假位置
  const withGhost = S.rectFromRange({
    getClientRects: function () {
      return [
        { left: 10, top: 20, right: 100, bottom: 40, width: 90, height: 20 },
        { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
      ];
    },
    toString: function () { return 'one line'; }
  });
  eqj('零尺寸伪矩形被过滤，锚点落在真实矩形上', withGhost.anchor, { left: 10, top: 20, right: 100, bottom: 40 });

  // 空文本：不应抛错（是否弹气泡交给 shouldTrigger 判断）
  const empty = S.rectFromRange({
    getClientRects: function () { return [{ left: 1, top: 2, right: 3, bottom: 4, width: 2, height: 2 }]; },
    toString: function () { return ''; }
  });
  eq('空文本不抛错，text 为空串', empty.text, '');
}

/* ================================================================== */
/* 三、shouldTrigger：什么时候不该弹                                    */
/* ================================================================== */

section('三、shouldTrigger');

{
  const base = { text: 'Hello world', settings: { selectionMinLen: 2, selectionMaxLen: 1200 }, anchorValid: true };

  eq('正常选区 → 触发', S.shouldTrigger(base).ok, true);
  eq('  原因 ok', S.shouldTrigger(base).reason, 'ok');

  eq('划到自家 DOM → 拒绝', S.shouldTrigger(Object.assign({}, base, { ownNode: true })).reason, 'own-dom');
  eq('空文本 → 拒绝', S.shouldTrigger(Object.assign({}, base, { text: '' })).reason, 'empty');
  eq('纯空白 → 拒绝（trim 后为空）', S.shouldTrigger(Object.assign({}, base, { text: '   \n\t ' })).reason, 'empty');
  eq('拿不到矩形 → 拒绝', S.shouldTrigger(Object.assign({}, base, { anchorValid: false })).reason, 'no-rect');
  eq('太短 → 拒绝', S.shouldTrigger(Object.assign({}, base, { text: 'a' })).reason, 'too-short');
  eq('纯数字 → 拒绝（没有翻译价值）', S.shouldTrigger(Object.assign({}, base, { text: '2024 2025' })).reason, 'no-letter');
  eq('纯符号 → 拒绝', S.shouldTrigger(Object.assign({}, base, { text: '--- ///' })).reason, 'no-letter');
  eq('超长 → 拒绝', S.shouldTrigger(Object.assign({}, base, { text: 'word '.repeat(300) })).reason, 'too-long');

  // 判定优先级：自家 DOM 压过一切
  eq('own-dom 优先于 empty',
    S.shouldTrigger({ text: '', settings: {}, ownNode: true, anchorValid: false }).reason, 'own-dom');
  eq('empty 优先于 no-rect',
    S.shouldTrigger({ text: '', settings: {}, anchorValid: false }).reason, 'empty');
  eq('no-rect 优先于 too-short',
    S.shouldTrigger({ text: 'a', settings: {}, anchorValid: false }).reason, 'no-rect');

  // 默认阈值：不传 settings 时用 selectionMinLen=2 / selectionMaxLen=1200
  eq('不传 settings 时默认最小长度 2（单字符被拒）',
    S.shouldTrigger({ text: 'a', anchorValid: true }).reason, 'too-short');
  eq('不传 settings 时两字符通过',
    S.shouldTrigger({ text: 'ab', anchorValid: true }).ok, true);
  eq('不传 settings 时 1200 字符通过',
    S.shouldTrigger({ text: 'a'.repeat(1200), anchorValid: true }).ok, true);
  eq('不传 settings 时 1201 字符被拒',
    S.shouldTrigger({ text: 'a'.repeat(1201), anchorValid: true }).reason, 'too-long');

  // 自定义阈值
  eq('自定义 selectionMinLen=5 时 4 字符被拒',
    S.shouldTrigger(Object.assign({}, base, { text: 'abcd', settings: { selectionMinLen: 5 } })).reason, 'too-short');
  eq('自定义 selectionMinLen=0 时单字符也通过',
    S.shouldTrigger(Object.assign({}, base, { text: 'a', settings: { selectionMinLen: 0 } })).ok, true);
  eq('自定义 selectionMaxLen=10 时 11 字符被拒',
    S.shouldTrigger(Object.assign({}, base, { text: 'hello world', settings: { selectionMaxLen: 10 } })).reason, 'too-long');

  // 中日韩文字与带重音的拉丁字母都算「有字母」
  eq('中文选区通过', S.shouldTrigger(Object.assign({}, base, { text: '你好世界' })).ok, true);
  eq('日文选区通过', S.shouldTrigger(Object.assign({}, base, { text: 'こんにちは' })).ok, true);
  eq('带重音的拉丁字母通过', S.shouldTrigger(Object.assign({}, base, { text: 'café' })).ok, true);
  eq('西里尔字母通过', S.shouldTrigger(Object.assign({}, base, { text: 'Привет' })).ok, true);
}

/* ================================================================== */
/* 四、isOwnNode：识别自家 DOM（含 shadow 穿越）                        */
/* ================================================================== */

section('四、isOwnNode');

{
  const doc = w.document;

  // 1) 普通页面节点
  const plain = doc.createElement('p');
  plain.textContent = 'ordinary page text';
  doc.body.appendChild(plain);
  eq('普通段落不是自家 DOM', S.isOwnNode(plain), false);
  eq('  其文本节点也不是', S.isOwnNode(plain.firstChild), false);

  // 2) 译文块内部的节点
  const trans = doc.createElement('div');
  trans.className = 'ct-trans ct-s-plain';
  const inner = doc.createElement('span');
  inner.textContent = '译文片段';
  trans.appendChild(inner);
  doc.body.appendChild(trans);
  eq('译文块本身是自家 DOM', S.isOwnNode(trans), true);
  eq('  译文块内的深层节点也是', S.isOwnNode(inner), true);
  eq('  译文块内的文本节点也是', S.isOwnNode(inner.firstChild), true);

  // 3) 页内开关与气泡宿主
  const toggle = doc.createElement('div');
  toggle.className = 'ct-toggle';
  doc.body.appendChild(toggle);
  eq('页内开关是自家 DOM', S.isOwnNode(toggle), true);

  const bubbleHost = doc.createElement('div');
  bubbleHost.className = 'ct-sel';
  doc.body.appendChild(bubbleHost);
  eq('划词气泡宿主是自家 DOM', S.isOwnNode(bubbleHost), true);

  // 4) 属性标记（有些节点靠属性而非类名识别）
  const skip = doc.createElement('div');
  skip.setAttribute('data-ct-skip', '');
  doc.body.appendChild(skip);
  eq('data-ct-skip 标记的节点是自家 DOM', S.isOwnNode(skip), true);

  const marked = doc.createElement('div');
  marked.setAttribute('data-ct-bubble', '');
  doc.body.appendChild(marked);
  eq('data-ct-bubble 标记的节点是自家 DOM', S.isOwnNode(marked), true);

  // 5) ★ shadow 穿越：open 根内的节点，只有 getRootNode().host 能接回宿主
  const shost = doc.createElement('div');
  shost.className = 'ct-sel';           // 真实的气泡宿主就是这个类名
  shost.setAttribute('data-ct-bubble', '');
  doc.body.appendChild(shost);
  const sroot = shost.attachShadow({ mode: 'open' });
  const sinner = doc.createElement('span');
  sinner.textContent = 'shadow 内的译文';
  sroot.appendChild(sinner);
  eq('open shadow 内的节点能穿过边界被认出（宿主是自家 DOM）', S.isOwnNode(sinner), true);
  // 这条是「必须走 getRootNode」的直接证据：ShadowRoot 是 DocumentFragment 不是
  // Element，所以父元素指针在边界处就是 null —— 靠 parentElement 上溯必然走丢。
  eq('shadow 内节点的 parentElement 为 null（parentElement 链在边界断掉）',
    sinner.parentElement, null);
  eq('  但 getRootNode() 能拿到 shadow 根', sinner.getRootNode() === sroot, true);

  // 6) 直接挂在 shadow root 上的文本节点（没有 parentElement）
  const shost2 = doc.createElement('div');
  shost2.className = 'ct-sel';
  doc.body.appendChild(shost2);
  const sroot2 = shost2.attachShadow({ mode: 'open' });
  const bare = doc.createTextNode('裸文本节点');
  sroot2.appendChild(bare);
  eq('挂在 shadow root 上的裸文本节点：走 getRootNode().host 兜底', S.isOwnNode(bare), true);

  // 7) 非自家的 shadow 内节点不应被误判
  const foreign = doc.createElement('div');
  doc.body.appendChild(foreign);
  const froot = foreign.attachShadow({ mode: 'open' });
  const finner = doc.createElement('span');
  froot.appendChild(finner);
  eq('别人家的 shadow 内节点不被误判', S.isOwnNode(finner), false);

  // 8) 自定义类名表
  const custom = doc.createElement('div');
  custom.className = 'my-own';
  doc.body.appendChild(custom);
  eq('传入自定义类名表时按自定义表判定', S.isOwnNode(custom, ['my-own']), true);
  eq('  默认类名表下不再是自家 DOM', S.isOwnNode(custom), false);

  // 9) 垃圾输入不抛错
  eq('null 返回 false', S.isOwnNode(null), false);
  eq('普通对象返回 false', S.isOwnNode({}), false);
}

/* ================================================================== */
/* 五、与浮层仲裁的衔接                                                */
/* ================================================================== */

section('五、与浮层仲裁的衔接');

{
  const L = w.CT.layers;
  // 划词气泡与图片菜单同优先级（都是 5），高于菜单/确认/引导
  eq('selection 与 imageMenu 同优先级', L.PRIORITY.selection, L.PRIORITY.imageMenu);
  ok('selection 高于 menu', L.PRIORITY.selection > L.PRIORITY.menu);
  ok('selection 高于 confirm', L.PRIORITY.selection > L.PRIORITY.confirm);

  // 划词气泡占用时，页内开关菜单申请被拒 —— 用户刚做的动作优先被看到
  L._reset();
  eq('气泡先占用成功', L.acquire('selection', function () { }), true);
  eq('  此时菜单申请被拒（不抢占）', L.acquire('menu', function () { }), false);
  eq('  当前持有者仍是 selection', L.current(), 'selection');
  L.release('selection');
  eq('气泡释放后菜单可占用', L.acquire('menu', function () { }), true);
  L.closeAll();
  eq('closeAll 后无持有者', L.current(), null);

  // 初始状态
  eq('初始为 idle', S.state(), 'idle');
  eq('初始未固定', S.isPinned(), false);
  eq('初始无当前文本', S.currentText(), null);
  eq('初始无摆放结果', S.placed(), null);
}

/* ------------------------------------------------------------------ */

console.log('\n' + '─'.repeat(52));
if (failures.length) {
  console.log('失败 ' + failures.length + ' 项，通过 ' + passed + ' 项');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('全部通过：' + passed + ' 项断言');
