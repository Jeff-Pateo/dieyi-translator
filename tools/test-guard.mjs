/*
 * 双语助手 · 重复注入守卫自检
 * ------------------------------------------------------------------
 * 守卫是本次改动里风险最高、又最难在真实环境回放的一环：
 * 「扩展从旧版更新到新版后，已经打开的标签页不刷新也能继续工作」——
 * 这个场景在真实 Chrome 上只能靠手动装卸两次来复现，无法进 CI。
 *
 * 所以把判定逻辑做成纯函数（content/guard.js），在这里把六条分支
 * 逐条钉死。任何一条写反，症状都是「更新后页面永久卡死」，
 * 而且是静默的 —— 没有报错、没有日志，只有用户觉得扩展坏了。
 *
 * 运行：
 *   npm run test:guard
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
/* 装配：guard.js 是 UMD 风格普通脚本，在全局上下文里执行                */
/* ------------------------------------------------------------------ */

globalThis.self = globalThis;

let manifestVersion = '1.6.0';
let manifestThrows = false;
globalThis.chrome = {
  runtime: {
    getManifest() {
      if (manifestThrows) throw new Error('Extension context invalidated.');
      return { version: manifestVersion };
    },
    lastError: null
  }
};

vm.runInThisContext(
  fs.readFileSync(path.join(ROOT, 'content/guard.js'), 'utf8'),
  { filename: 'content/guard.js' }
);

const G = globalThis.CT.guard;

/* ================================================================== */
/* 一、版本读取                                                        */
/* ================================================================== */

section('一、版本读取');
{
  manifestThrows = false;
  eq('读到 manifest 版本', G.readVersion(), '1.6.0');

  manifestVersion = '2.0.0';
  eq('版本变化能被读到', G.readVersion(), '2.0.0');

  // 旧实例被判「已失活」的信号之一，就是它的 chrome.* 全部抛错
  manifestThrows = true;
  eq('扩展上下文失效时退化为 unknown（而不是抛错）', G.readVersion(), 'unknown');
  manifestThrows = false;
  manifestVersion = '1.6.0';
}

/* ================================================================== */
/* 二、判定矩阵                                                        */
/* ================================================================== */

section('二、判定矩阵');
{
  eq('页面上没有任何标记 → fresh',
    G.decide(undefined, '1.6.0'), 'fresh');

  eq('标记是 null → fresh',
    G.decide(null, '1.6.0'), 'fresh');

  // ★ 这一条就是「从 1.4 升到 1.5」的真实场景：
  //   旧版写的是裸布尔 true，拿不到版本信息 → 必须接管，不能跳过
  eq('旧版裸布尔 true → takeover（升级后不刷新也不能死页）',
    G.decide(true, '1.6.0'), 'takeover');

  eq('标记是非对象值（字符串）→ takeover',
    G.decide('yes', '1.6.0'), 'takeover');

  eq('同版本 + 存活 → skip（真正的重复注入）',
    G.decide({ version: '1.6.0', alive: true }, '1.6.0'), 'skip');

  eq('同版本 + 已失活 → takeover',
    G.decide({ version: '1.6.0', alive: false }, '1.6.0'), 'takeover');

  eq('同版本 + 缺 alive 字段 → takeover（只有明确存活才允许跳过）',
    G.decide({ version: '1.6.0' }, '1.6.0'), 'takeover');

  eq('版本不同 + 存活 → takeover（扩展刚更新）',
    G.decide({ version: '1.4.0', alive: true }, '1.6.0'), 'takeover');

  eq('版本不同 + 已失活 → takeover',
    G.decide({ version: '1.4.0', alive: false }, '1.6.0'), 'takeover');

  // 版本号约定是字符串。万一标记里存了别的类型（不该发生），
  // 也不做隐式转换去「凑相等」—— 保守接管，宁可多初始化一次，
  // 也不要因为一次宽松比较而让页面卡在旧版本上
  eq('版本号类型异常 → 保守 takeover',
    G.decide({ version: 1.5, alive: true }, '1.5'), 'takeover');
}

/* ================================================================== */
/* 三、标记读写                                                        */
/* ================================================================== */

section('三、标记读写');
{
  const win = {};

  G.markBooted(win, '1.6.0');
  eq('markBooted 写入版本号', win.__CT_BOOTED__.version, '1.6.0');
  eq('markBooted 默认视为存活', win.__CT_BOOTED__.alive, true);
  eq('isAlive 读到 true', G.isAlive(win), true);
  eq('同一版本再注入 → skip', G.decide(win.__CT_BOOTED__, '1.6.0'), 'skip');

  G.markAlive(win, false);
  eq('markAlive(false) 后存活位为 false', G.isAlive(win), false);
  eq('失活后同一版本再注入 → takeover', G.decide(win.__CT_BOOTED__, '1.6.0'), 'takeover');

  eq('对没有标记的 window 调 markAlive 返回 false', G.markAlive({}, true), false);

  // 退场钩子的往返
  const fn = () => {};
  G.setTeardown(win, fn);
  eq('setTeardown / takeTeardown 往返一致', G.takeTeardown(win), fn);
  G.setTeardown(win, null);
  eq('钩子被清空后返回 null', G.takeTeardown(win), null);
  eq('非函数值的钩子视为不存在', (() => {
    win.__CT_TEARDOWN__ = 'not-a-function';
    return G.takeTeardown(win);
  })(), null);
}

/* ================================================================== */
/* 四、孤儿清理                                                        */
/* ================================================================== */

section('四、孤儿清理');
{
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body>'
    + '<main><p>Hello <span class="ct-trans">你好</span></p>'
    + '<p>World <span class="ct-trans">世界</span></p></main>'
    + '<div class="ct-badge">翻译中 3 / 9</div>'
    + '<div class="ct-badge ct-badge--on">已译</div>'
    + '<div class="ct-tip">悬停浮层</div>'
    /* ★ C-28：页内开关的宿主也必须被当作孤儿清掉。
     *   它在正常路径上由 teardown() 摘除，但 teardown 抛错 / fresh 分支下
     *   会留下来；而 toggle 的冲突避让用 elementFromPoint 取样、命中自身一律
     *   视为「角落空闲」，所以孤儿胶囊会**精确叠在**新胶囊上面 —— 视觉上还是
     *   一颗，DOM 里却在累积、事件监听是双份。这类重叠重复实例最难目视发现，
     *   只能靠类名兜底。 */
    + '<div class="ct-toggle" data-status="off">孤儿胶囊</div>'
    + '</body></html>',
    { url: 'https://example.com/' }
  );
  const doc = dom.window.document;

  const before = doc.querySelectorAll('.ct-trans').length;
  const removed = G.clearOrphans(doc);

  eq('移除了徽标 / 悬停浮层 / 孤儿胶囊 共 4 个', removed, 4);
  eq('徽标被清干净', doc.querySelectorAll('.ct-badge').length, 0);
  eq('悬停浮层被清干净', doc.querySelectorAll('.ct-tip').length, 0);
  /* ★ C-28：孤儿胶囊必须一并清掉 —— 否则它会被新实例的胶囊盖住，
   *   用户看不见「多了」，但 DOM 里在累积、事件监听是双份。 */
  eq('孤儿页内开关被清干净（C-28）', doc.querySelectorAll('.ct-toggle').length, 0);
  ok('ORPHAN_SELECTOR 已包含 .ct-toggle',
    String(G.ORPHAN_SELECTOR).indexOf('.ct-toggle') >= 0, G.ORPHAN_SELECTOR);

  // ★ 这是刻意的取舍：译文块不清。
  //   它们是页面上的有效内容，清掉会让用户先看到一次「译文消失 → 再出现」的闪回。
  eq('译文块【不】被清理', doc.querySelectorAll('.ct-trans').length, before);
  ok('译文块内容保持原样',
    doc.querySelector('.ct-trans').textContent === '你好');

  eq('没有孤儿时返回 0', G.clearOrphans(doc), 0);
}

/* ================================================================== */
/* 五、端到端：同一页面被注入两次                                       */
/* ================================================================== */

section('五、端到端：模拟「装旧版 → 升级到新版」');
{
  // 第一次注入（旧版）：写裸布尔，并留下一堆产物
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><main><p>Hello world</p></main></body></html>',
    { url: 'https://example.com/', runScripts: 'outside-only' }
  );
  const win = dom.window;
  const doc = win.document;

  win.__CT_BOOTED__ = true;                       // 旧版的标记
  doc.body.appendChild(doc.createElement('div')).className = 'ct-badge';

  // 第二次注入（新版）：走完整判定
  const d1 = G.decide(win.__CT_BOOTED__, '1.6.0');
  eq('旧标记被判定为 takeover', d1, 'takeover');

  G.clearOrphans(doc);
  G.markBooted(win, '1.6.0');
  G.setTeardown(win, () => {});

  eq('接管后标记升级为带版本号的对象', win.__CT_BOOTED__.version, '1.6.0');
  eq('接管后旧徽标被清掉', doc.querySelectorAll('.ct-badge').length, 0);

  // 第三次注入（同版本重入）：应当被幂等地挡回去
  eq('再注入同版本 → skip', G.decide(win.__CT_BOOTED__, '1.6.0'), 'skip');
}

console.log('\n' + '─'.repeat(52));
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  · ' + f);
  console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
  process.exit(1);
}
console.log('全部通过：' + passed + ' 项断言');
