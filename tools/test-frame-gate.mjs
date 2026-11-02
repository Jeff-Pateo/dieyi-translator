/*
 * 双语助手 · frame 自评 + 每页配额自检
 * ------------------------------------------------------------------
 * 为什么这两块要放在同一个文件里测：
 *   它们是同一条防线的上下两段 ——
 *     frame-gate：单个 frame 自己判断「我值不值得翻」
 *     frame-budget：后台统计「这一页我已经放行了几个」
 *   前者的输出（area）正是后者的输入。分开测容易漏掉「两者对同一个
 *   frame 的判断是否自洽」这类跨模块问题。
 *
 * 为什么不需要 jsdom：
 *   frame-gate 只读 innerWidth / innerHeight / innerText 与一次 querySelector，
 *   全部可以用一个 5 行的假 document 精确控制。用真 DOM 反而要为了
 *   「jsdom 不实现 innerText」绕路（见 tools/selftest.mjs 里 CLIP 夹具的注释）。
 *
 * 运行：
 *   node tools/test-frame-gate.mjs
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
/* frame-gate 装配：一个假 global，精确控制 isTop / 面积 / 文本 / 广告   */
/* ------------------------------------------------------------------ */

/**
 * 造一个「frame 的全局环境」并加载 frame-gate.js。
 * @param {Object} o
 *   o.top        顶层(false) / 子frame(true)，默认 true
 *   o.crossOrigin 把 top 的读取改成抛错（模拟跨域 iframe）
 *   o.width/o.height  视口尺寸
 *   o.text        body.innerText 的长度
 *   o.ad          是否让 querySelector 命中广告选择器
 *   o.hash        location.hash（控制 maybeLog 输出）
 */
function makeFrame(o) {
  o = o || {};
  const logs = [];
  const sandbox = {
    console: {
      log: function () { logs.push(Array.prototype.slice.call(arguments).join(' ')); },
      warn: function () { }
    },
    innerWidth: o.width === undefined ? 800 : o.width,
    innerHeight: o.height === undefined ? 600 : o.height,
    document: {
      body: { innerText: 'x'.repeat(o.text === undefined ? 500 : o.text) },
      querySelector: function () { return o.ad ? {} : null; }
    },
    location: { hash: o.hash || '', href: 'https://embed.example.com/widget' }
  };
  const ctx = vm.createContext(sandbox);

  // IIFE 的实参是 `typeof self !== 'undefined' ? self : this`。
  // 在 vm 里把 self 显式绑到全局，再决定 top 指向谁。
  vm.runInContext('var self = this;', ctx);
  if (o.crossOrigin) {
    // 跨域时读 top 会抛 SecurityError —— isTop 必须 try 住
    vm.runInContext(
      'Object.defineProperty(self, "top", {' +
      '  get: function () { throw new Error("Blocked a frame from accessing a cross-origin frame"); },' +
      '  configurable: true });',
      ctx
    );
  } else if (o.sub === true) {
    vm.runInContext('self.top = {};', ctx);   // 不是自己 → 子 frame
  } else {
    vm.runInContext('self.top = self;', ctx); // 自己 → 顶层
  }

  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'content/frame-gate.js'), 'utf8'),
    ctx,
    { filename: 'content/frame-gate.js' }
  );
  return { G: ctx.CT.frameGate, logs };
}

/* ================================================================== */
/* 一、顶层判定                                                        */
/* ================================================================== */

section('一、顶层判定');

{
  eq('top === self 判为顶层', makeFrame({ sub: false }).G.isTop(), true);
  eq('top !== self 判为子 frame', makeFrame({ sub: true }).G.isTop(), false);
  // 跨域读 top 抛错时不能把整个脚本带崩，只能保守地当作「不是顶层」
  eq('跨域读 top 抛错时保守判为非顶层', makeFrame({ crossOrigin: true }).G.isTop(), false);
}

/* ================================================================== */
/* 二、assess：面积 → 广告 → 文本 的判定顺序                            */
/* ================================================================== */

section('二、assess 判定链');

{
  // 顶层永远参与，且不读文本（textLength 固定 -1，省掉一次 innerText 读）
  const top = makeFrame({ sub: false, width: 10, height: 10, text: 0 }).G;
  const rTop = top.assess();
  eq('顶层即使视口极小也参与', rTop.ok, true);
  eq('  原因标记为 top', rTop.reason, 'top');
  eq('  顶层不读 innerText（textLength = -1）', rTop.textLength, -1);

  // 面积不足：MIN_AREA = 80000，用 200×300 = 60000 卡进去
  const small = makeFrame({ sub: true, width: 200, height: 300 }).G;
  const rSmall = small.assess();
  eq('面积不足 → 拒绝', rSmall.ok, false);
  eq('  原因 small-area', rSmall.reason, 'small-area');

  // 面积刚好够（350×230 = 80500 > 80000）
  const justEnough = makeFrame({ sub: true, width: 350, height: 230, text: 500 }).G;
  eq('面积刚好过线（80500）→ 参与', justEnough.assess().ok, true);

  // 差一点点（299×267 = 79833 < 80000）
  const justShort = makeFrame({ sub: true, width: 299, height: 267, text: 500 }).G;
  eq('面积差一点点（79833）→ 拒绝', justShort.assess().reason, 'small-area');

  // 广告容器：面积先过关，再看广告
  const ad = makeFrame({ sub: true, width: 800, height: 600, text: 5000, ad: true }).G;
  const rAd = ad.assess();
  eq('面积够但命中广告选择器 → 拒绝', rAd.ok, false);
  eq('  原因 ad-container', rAd.reason, 'ad-container');

  // ★ 顺序断言：面积不足 + 有广告时，必须先报 small-area。
  //   广告判定要跑 querySelector（会触发样式/选择器匹配），
  //   把它放在面积之后，绝大多数 frame 才能被零成本的面积判断挡掉。
  const smallAd = makeFrame({ sub: true, width: 100, height: 100, ad: true }).G;
  eq('面积不足时先报 small-area（广告判定在面积之后）',
    smallAd.assess().reason, 'small-area');

  // 文本不足：MIN_TEXT = 200
  const noText = makeFrame({ sub: true, width: 800, height: 600, text: 120 }).G;
  const rNoText = noText.assess();
  eq('文本不足 → 拒绝', rNoText.ok, false);
  eq('  原因 no-text', rNoText.reason, 'no-text');
  eq('  textLength 如实上报', rNoText.textLength, 120);

  // 全部过关
  const good = makeFrame({ sub: true, width: 800, height: 600, text: 3000 }).G;
  const rGood = good.assess();
  eq('面积／广告／文本都过关 → 参与', rGood.ok, true);
  eq('  原因 content', rGood.reason, 'content');
  eq('  area 如实上报', rGood.area, 800 * 600);
}

/* ================================================================== */
/* 三、常量与边界                                                      */
/* ================================================================== */

section('三、门限常量');

{
  const { G } = makeFrame({});
  eq('MIN_AREA = 80000', G.MIN_AREA, 80000);
  eq('MIN_TEXT = 200', G.MIN_TEXT, 200);
  ok('广告选择器含 adsbygoogle', G.AD_SELECTOR.indexOf('ins.adsbygoogle') >= 0);
  ok('广告选择器含 meta[name="ad.size"]', G.AD_SELECTOR.indexOf('meta[name="ad.size"]') >= 0);
  ok('广告选择器是启发式而非域名黑名单',
    G.AD_SELECTOR.indexOf('.com') < 0 && G.AD_SELECTOR.indexOf('doubleclick') < 0);

  // visibleTextLength 会 trim，前后空白不算
  const padded = makeFrame({ sub: true, text: 0 }).G;
  eq('innerText 为长度 0 时返回 0', padded.visibleTextLength(), 0);
}

/* ================================================================== */
/* 四、maybeLog 只在 #ct-debug 时输出                                   */
/* ================================================================== */

section('四、调试日志闸门');

{
  const quiet = makeFrame({ sub: true, width: 800, height: 600, text: 3000, hash: '' });
  quiet.G.maybeLog();
  eq('无 #ct-debug 时不打日志', quiet.logs.length, 0);

  const loud = makeFrame({ sub: true, width: 800, height: 600, text: 3000, hash: '#ct-debug' });
  loud.G.maybeLog();
  eq('带 #ct-debug 时打一行日志', loud.logs.length, 1);
  ok('日志里带上判定原因', loud.logs[0].indexOf('content') >= 0, loud.logs[0] || '(空)');
}

/* ================================================================== */
/* 五、frame-budget：每页配额                                          */
/* ================================================================== */

section('五、frame 配额（frame-budget）');

{
  globalThis.self = globalThis;
  vm.runInThisContext(
    fs.readFileSync(path.join(ROOT, 'background/frame-budget.js'), 'utf8'),
    { filename: 'background/frame-budget.js' }
  );
  const B = globalThis.CT.frameBudget;

  eq('MAX_FRAMES_PER_TAB = 20', B.MAX_FRAMES_PER_TAB, 20);
  B._reset();

  /* --- 永远放行的三种身份 --- */
  eq('顶层（frameId 0）永远放行', B.admit(101, 0, 1), true);
  eq('frameId undefined 放行', B.admit(101, undefined, 1), true);
  eq('frameId null 放行', B.admit(101, null, 1), true);
  eq('tabId undefined 放行', B.admit(undefined, 7, 1), true);
  eq('tabId null 放行', B.admit(null, 7, 1), true);
  // 顶层不该占用名额
  eq('顶层不计入配额（stats.total = 0）', B.stats(101).total, 0);

  /* --- 放行前 20 个 --- */
  B._reset();
  let allowed = 0;
  for (let i = 1; i <= 20; i++) {
    if (B.admit(202, i, i * 100)) allowed++;
  }
  eq('前 20 个非顶层 frame 全部放行', allowed, 20);
  eq('stats.allowed = 20', B.stats(202).allowed, 20);
  eq('stats.denied = 0', B.stats(202).denied, 0);

  /* --- 第 21 个：面积更小 → 拒绝 --- */
  eq('第 21 个面积更小（5 < 最小 100）→ 拒绝', B.admit(202, 21, 5), false);
  eq('  被拒者也进表（便于观察）', B.stats(202).total, 21);
  eq('  allowed 仍为 20', B.stats(202).allowed, 20);

  /* --- 第 22 个：面积更大 → 顶替最小的那个 --- */
  eq('第 22 个面积巨大 → 放行', B.admit(202, 22, 999999), true);
  eq('  总数 22', B.stats(202).total, 22);
  eq('  allowed 仍是 20（一进一出）', B.stats(202).allowed, 20);
  // frameId 1 的面积是 100，是被顶掉的那个；重新申请应沿用「已拒绝」结论
  eq('被顶替者（frameId 1）重新申请仍被拒', B.admit(202, 1, 100), false);
  eq('新来者（frameId 22）重新申请仍放行', B.admit(202, 22, 999999), true);

  /* --- 重复申请不重复占名额 --- */
  B._reset();
  B.admit(303, 1, 500);
  const t1 = B.stats(303).total;
  B.admit(303, 1, 500);
  B.admit(303, 1, 500);
  eq('同一 frameId 反复申请不增加 total', B.stats(303).total, t1);
  eq('  面积更新为观测到的较大值（500 → 900 仍放行）', B.admit(303, 1, 900), true);
  eq('  total 仍为 1', B.stats(303).total, 1);

  /* --- 不同标签页互不影响 --- */
  B._reset();
  for (let i = 1; i <= 20; i++) B.admit(404, i, i * 100);
  eq('标签页 404 已满', B.admit(404, 99, 1), false);
  eq('另一个标签页 405 不受影响', B.admit(405, 1, 100), true);

  /* --- reset --- */
  B._reset();
  B.admit(506, 1, 100);
  eq('reset 前有记录', B.stats(506).total, 1);
  B.reset(506);
  eq('reset 后清空', B.stats(506).total, 0);
  eq('  空标签页 stats 结构完整', JSON.stringify(B.stats(506)), JSON.stringify({ total: 0, allowed: 0, denied: 0 }));
  B.reset(99999);
  ok('reset 一个不存在的 tabId 不抛错', true);

  B._reset();
}

/* ------------------------------------------------------------------ */

console.log('\n' + '─'.repeat(52));
if (failures.length) {
  console.log('失败 ' + failures.length + ' 项，通过 ' + passed + ' 项');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('全部通过：' + passed + ' 项断言');
