/*
 * 双语助手 · 编排层增量更新自检
 * ------------------------------------------------------------------
 * content.js 是唯一没有自动化测试覆盖的部分，而本次性能优化改动最大的
 * 恰好是它 —— 把「变更 → 重扫范围」的映射从「变更节点的父元素」改为
 * 「最近的已登记翻译单元」。这个改动同时修了一个漏翻缺陷，风险也最高：
 * 映射错了就是漏翻或重复翻译，属于静默错误。
 *
 * 因此这里把 content.js 真正跑起来（jsdom + chrome 桩），并给
 * CT.renderer.collectUnits 挂一个探针，直接观察「实际被扫描的根节点是谁」——
 * 这比只看最终译文更能定位问题。
 *
 * 运行：
 *   npm run test:scope
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

let passed = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + label); }
  else { failures.push(label); console.log('  \u2717 ' + label + (detail ? '  → ' + detail : '')); }
}
function eq(label, actual, expected) {
  ok(label + '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）', actual === expected);
}
function section(t) { console.log('\n' + t); }

/* ------------------------------------------------------------------ */
/* 页面：12 个段落，每段都含一个行内 <a>                                 */
/* ------------------------------------------------------------------ */

const PARAS = 12;
let body = '';
for (let i = 0; i < PARAS; i++) {
  body += '<p>Sentence number ' + i + ' with <a href="#">inner link ' + i + '</a> and trailing words.</p>';
}
const PAGE = '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body><div id="app">' + body + '</div></body></html>';

/* ------------------------------------------------------------------ */
/* 装配：content.js 是普通脚本，在 jsdom 的 vm 上下文里真实执行         */
/* ------------------------------------------------------------------ */

const dom = new JSDOM(PAGE, {
  url: 'https://example.com/article',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const ctx = dom.getInternalVMContext();
const doc = dom.window.document;

// 先加载 content.js 依赖的全部模块：常量、注入守卫、检测、渲染、页内开关。
// 加载顺序与 manifest 的 content_scripts 保持一致，任何一处漂移都会在这里
// 立刻变成 TypeError，而不是等到真实浏览器里才发现某个 CT.* 是 undefined。
for (const rel of [
  'shared/constants.js',
  // v1.7.1 新增：术语基座。页面侧不消费它（掩码在后台做），
  // 但它出现在 manifest 的 js 列表里，这份清单就必须跟着同步 ——
  // 清单一旦漂移，这条测试的「三处逐项一致」断言就会失效。
  'shared/terminology.js',
  // v1.7.2 新增：场景识别。与 manifest 的 content_scripts.js 清单保持一致
  'shared/scene.js',
  'content/guard.js',
  // v1.7 新增，顺序与 manifest.json 的 content_scripts.js 保持一致
  'content/frame-gate.js',
  'content/layers.js',
  'content/keymap.js',
  'content/shadow-walk.js',
  'content/selection.js',
  'content/detector.js',
  'content/renderer.js',
  'content/toggle.js'
]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), ctx, { filename: rel });
}

const SETTINGS = Object.assign({}, ctx.CT.DEFAULT_SETTINGS, {
  enabled: true,
  autoTranslate: true,
  sourceLang: 'en',
  targetLang: 'zh-CN',
  displayMode: 'below',
  provider: 'google-free',
  cacheEnabled: false
});

/** 记录所有发往后台的翻译请求 */
const translateCalls = [];
/** 探针：记录每次 collectUnits 的根节点 */
const scanRoots = [];

ctx.chrome = {
  runtime: {
    lastError: null,
    // 注入守卫要读版本号：桩成固定版本，让「同版本 + 存活 → 跳过」这条
    // 幂等路径可断言（见 tools/test-guard.mjs）
    getManifest: () => ({ version: 'test' }),
    sendMessage(msg, cb) {
      let res = { ok: true };
      if (msg.type === 'ct:get-settings') res = { ok: true, settings: SETTINGS };
      else if (msg.type === 'ct:translate') {
        translateCalls.push(msg.items.map((i) => i.text));
        res = { ok: true, provider: 'stub', translations: msg.items.map((i) => '〔' + i.text + '〕') };
      } else if (msg.type === 'ct:set-settings') {
        res = { ok: true, settings: Object.assign({}, SETTINGS, msg.patch) };
      } else if (msg.type === 'ct:open-options') {
        res = { ok: true };
      }
      // 同步回调：content.js 的 send() 依赖回调形式
      cb(res);
    },
    onMessage: { addListener() {} }
  },
  storage: {
    // 页内开关的位置记忆与站点记忆都走 local；这里给一个空实现，
    // 让控件在「没有历史位置」的情况下落到默认位
    local: {
      get(k, cb) { if (cb) cb({}); },
      set(o, cb) { void o; if (cb) cb(); }
    },
    onChanged: { addListener() {} }
  }
};

// 最后加载编排层，此时 chrome 桩与设置都已就绪
vm.runInContext(
  fs.readFileSync(path.join(ROOT, 'content/content.js'), 'utf8'),
  ctx,
  { filename: 'content/content.js' }
);

/* 探针必须挂在 CT.renderer 上：content.js 每次都是通过该对象的属性调用，
 * 因此替换属性即可拦截，无需改动被测代码。 */
const ORIG_COLLECT = ctx.CT.renderer.collectUnits;
ctx.CT.renderer.collectUnits = function (root, settings) {
  scanRoots.push(root === doc.body ? '#BODY' : (root.id ? '#' + root.id : root.tagName));
  return ORIG_COLLECT.call(this, root, settings);
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const countTrans = () => doc.querySelectorAll('.ct-trans').length;

section('一、首屏采集');
{
  await wait(120);
  eq('12 个段落各生成一个译文块', countTrans(), PARAS);
  ok('首屏是整页采集（根为 body）', scanRoots.indexOf('#BODY') >= 0, JSON.stringify(scanRoots));
  ok('译文内容正确',
    doc.querySelector('#app p > .ct-trans').textContent === '〔Sentence number 0 with inner link 0 and trailing words.〕',
    doc.querySelector('#app p > .ct-trans').textContent);

  // ★「不改变页面原本结构」的端到端断言。
  //   走完真实 content.js 之后，容器 #app 的直接子元素必须仍是那 12 个 <p>：
  //   个数不变、顺序不变、彼此仍是相邻兄弟。任何一条不成立，站点自己的
  //   `#app > p + p` 间距规则、`:nth-child` 样式、flex/grid 布局都会跟着错位。
  const appKids = Array.from(doc.getElementById('app').children);
  eq('容器 #app 的直接子元素个数不变', appKids.length, PARAS);
  ok('容器下没有多出译文兄弟节点（仍全是 <p>）',
    appKids.every((el) => el.tagName === 'P'),
    appKids.map((el) => el.tagName).join(','));
  eq('译文块全部挂在 <p> 内部',
    appKids.filter((el) => el.querySelector(':scope > .ct-trans')).length, PARAS);
  eq('相邻兄弟选择器 #app > p + p 仍然匹配到 11 组',
    doc.querySelectorAll('#app > p + p').length, PARAS - 1);
  eq('第二个 <p> 的上一个兄弟仍是 <p>',
    doc.querySelectorAll('#app > p')[1].previousElementSibling.tagName, 'P');
}

section('二、行内子节点内容变更（旧实现的漏翻场景）');
{
  /*
   * C-71 落码批补充（与本批断言同轮）：**先等 boot 期那一轮尾随 flush 落定**，再清零观测数组。
   * 原因（**既有问题、非 C-71 引入** —— 已用 `C-71` 改前副本对拍，3/3 次稳定复现**同一值**
   * `STYLE,DIV,DIV,DIV,DIV,P`）：boot 期页内控件的 `<style>` 与宿主 div 会被 observer 当
   * 「页面新增内容」入队一次（`isOwnNode` 覆盖 `.ct-trans/.ct-tip/.ct-badge/.ct-toggle/
   * .ct-learn-card/.ct-cap-note`，**未覆盖 `<style>`**）；其 700ms 尾随 flush 若晚于本节清零
   * 动作，就把那些根混进本节的 `scanRoots`，使 `重扫根是段落本身` **误红**。
   * ⇒ 等一拍让观测面只剩本节自身那一次变更。**断言口径不变**（仍要求恰好是 `P`）。
   */
  await wait(900);
  scanRoots.length = 0;
  translateCalls.length = 0;

  // 改动 <p> 内部 <a> 的文本。旧实现会把重扫范围定为 <a> 本身，
  // 而 <a> 是内联元素、不会产出单元 → 该段落译文永远停在旧内容上。
  doc.querySelectorAll('#app a')[3].firstChild.nodeValue = 'CHANGED link 3';
  await wait(950);

  eq('重新提交了 1 段', translateCalls.length, 1, JSON.stringify(translateCalls));
  ok('重新翻译的是被影响的段落（而不是无结果的内联节点）',
    translateCalls[0] && translateCalls[0][0] === 'Sentence number 3 with CHANGED link 3 and trailing words.',
    JSON.stringify(translateCalls[0]));
  eq('重扫根是段落本身，不是整页', scanRoots.join(','), 'P');
  eq('译文块总数不变（旧译文被替换而非叠加）', countTrans(), PARAS);
  ok('该段译文已更新',
    doc.querySelectorAll('#app p > .ct-trans')[3].textContent.indexOf('CHANGED link 3') > 0,
    doc.querySelectorAll('#app p > .ct-trans')[3].textContent);
}

section('三、多处并发变更只扫各自受影响的范围');
{
  scanRoots.length = 0;
  translateCalls.length = 0;

  const as = doc.querySelectorAll('#app a');
  for (let i = 0; i < 5; i++) as[i].firstChild.nodeValue = 'BULK ' + i;
  await wait(950);

  eq('一个批次内提交 5 段', translateCalls.length, 1, '批次形态由 700ms 合并窗口决定');
  eq('提交条目数正好是 5', translateCalls[0].length, 5, JSON.stringify(translateCalls[0]));
  ok('未退化为整页重扫', scanRoots.indexOf('#BODY') < 0, JSON.stringify(scanRoots));
  eq('每个重扫根都是段落', scanRoots.join(','), 'P,P,P,P,P');
  eq('译文块总数仍为 12', countTrans(), PARAS);
}

section('四、新增子树');
{
  scanRoots.length = 0;
  translateCalls.length = 0;

  const p = doc.createElement('p');
  p.textContent = 'A brand new paragraph added by the page.';
  doc.getElementById('app').appendChild(p);
  await wait(950);

  eq('新增段落被翻译', translateCalls.length, 1);
  eq('只提交了新增的那一条', translateCalls[0].length, 1, JSON.stringify(translateCalls[0]));
  ok('重扫根是新增节点本身', scanRoots.join(',') === 'P', JSON.stringify(scanRoots));
  eq('译文块总数 +1', countTrans(), PARAS + 1);
}

section('五、幂等：内容未变不得重复翻译');
{
  scanRoots.length = 0;
  translateCalls.length = 0;
  // 触碰一个外层容器，但内部文本完全没变
  doc.getElementById('app').setAttribute('data-touch', '1');
  doc.getElementById('app').appendChild(doc.createComment('note'));
  await wait(950);
  eq('没有产生任何翻译请求', translateCalls.length, 0, JSON.stringify(translateCalls));
  eq('译文块数量不变', countTrans(), PARAS + 1);
}

section('六、还原');
{
  ok('还原前确有译文块', countTrans() > 0);
  ctx.CT.renderer.restoreAll();
  eq('还原后译文块全部消失', countTrans(), 0);
  eq('登记的单元记录已清空', ctx.CT.renderer.registrySize(), 0);
  ok('原文完整保留', doc.getElementById('app').textContent.indexOf('Sentence number 0') >= 0);
}

/* ================================================================== */
/* 七、页内控件的「要不要在场」（C-28）                                */
/* ==================================================================
 * 【为什么这一段必须跑真正的 content.js】
 * 用户截图：中文页面右下角常驻一颗写着「无需翻译」的胶囊，点了没反应，
 * 「隐藏这个按钮」刷新后又回来 —— 用户的原话是「为什么重复出现这个」。
 *
 * 根因在**编排层的挂载决策**：syncToggle() 的挂载条件里只有
 * 「设置开关 && 本页没被手动隐藏」，**完全没有「本页需不需要翻译」这一维**。
 *
 * 而既有的 test-toggle.mjs 只测 toggle.js 自己（给什么状态渲染什么），
 * 编排层的挂载决策在自动化里**一行断言都没有** —— 这正是缺陷得以长期存在的
 * 原因：单元测试全绿，装配起来是错的。所以这里补齐。
 * ================================================================== */

const MODULE_LIST = [
  'shared/constants.js', 'shared/terminology.js', 'shared/scene.js',
  'content/guard.js', 'content/frame-gate.js', 'content/layers.js',
  'content/keymap.js', 'content/shadow-walk.js', 'content/selection.js',
  'content/detector.js', 'content/renderer.js', 'content/toggle.js',
  'content/content.js'
];

/** 起一个干净页面，把内容脚本全套真实跑起来 */
async function bootPage(html, url, over) {
  const d2 = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const c2 = d2.getInternalVMContext();
  const settings = Object.assign({}, ctx.CT.DEFAULT_SETTINGS, {
    enabled: true, autoTranslate: true, displayMode: 'below',
    cacheEnabled: false, targetLang: 'zh-CN'
  }, over || {});
  c2.chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: 'test' }),
      sendMessage(msg, cb) {
        let res = { ok: true };
        if (msg.type === 'ct:get-settings') res = { ok: true, settings };
        else if (msg.type === 'ct:set-settings') res = { ok: true, settings: Object.assign({}, settings, msg.patch) };
        else if (msg.type === 'ct:translate') res = { ok: true, provider: 'stub', translations: msg.items.map((i) => '〔' + i.text + '〕') };
        cb(res);
      },
      onMessage: { addListener() {} }
    },
    storage: {
      local: { get(k, cb) { if (cb) cb({}); }, set(o, cb) { void o; if (cb) cb(); } },
      onChanged: { addListener() {} }
    }
  };
  for (const rel of MODULE_LIST) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), c2, { filename: rel });
  }
  await wait(160);
  return { dom: d2, ctx: c2, doc: d2.window.document, win: d2.window };
}

const zhBody = ('这是一篇中文正文，用来验证扩展在本来就不需要翻译的页面上'
  + '会不会继续把页内开关常驻在屏幕右下角。它应该自己收起来，'
  + '而不是留一个点了没有任何反应的按钮挡在那里。').repeat(6);
const ZH_PAGE = '<!DOCTYPE html><html lang="zh-CN"><head><title>中文页</title></head><body>'
  + '<div id="app"><p>' + zhBody + '</p></div></body></html>';
const EN_PAGE = '<!DOCTYPE html><html lang="en"><head><title>English</title></head><body>'
  + '<div id="app"><p>' + 'This English paragraph exists so the detector can tell the page language apart. '.repeat(6)
  + '</p></div></body></html>';

section('七、页内控件「要不要在场」（C-28）');
{
  // ① 中文页（本来无需翻译）→ 不该常驻
  const a = await bootPage(ZH_PAGE, 'https://zh.example.com/post');
  eq('中文页：页内控件不挂载（不占屏幕）', a.doc.querySelectorAll('.ct-toggle').length, 0);
  ok('  中文页：装饰性节点也没有残留（body 干净）',
    a.doc.body.querySelectorAll('div[data-ct-skip]').length === 0,
    'skip 节点=' + a.doc.body.querySelectorAll('div[data-ct-skip]').length);

  // ② 英文页（需要翻译）→ 必须挂载（防止「一改就全隐藏」的反向回归）
  const b = await bootPage(EN_PAGE, 'https://en.example.com/post');
  eq('英文页：页内控件正常挂载', b.doc.querySelectorAll('.ct-toggle').length, 1);
  eq('  英文页：状态不是 unavailable',
    b.doc.querySelector('.ct-toggle').getAttribute('data-status') !== 'unavailable', true);

  // ③ 中文页 **但站点在用户黑名单里** → 必须保留控件
  //    （否则用户在页面上就再也没有「撤销拉黑」的入口 —— 这是 F1 的边界条件）
  const c = await bootPage(ZH_PAGE, 'https://blocked.example.com/post',
    { blocklist: ['blocked.example.com'] });
  eq('中文页 + 本站在黑名单：控件仍必须在场（保留撤销入口）',
    c.doc.querySelectorAll('.ct-toggle').length, 1);
  eq('  且状态为 unavailable（文案「无需翻译」，点开菜单可撤销）',
    c.doc.querySelector('.ct-toggle').getAttribute('data-status'), 'unavailable');
}

/* ================================================================== */
/* 八、`attr` 分桶与抖动守卫两桶（C-71 · S-16a，已签）                  */
/* ==================================================================
 * 【本节的纪律（C-71 §5 注解 · L-22 家族）】
 *   · **不锚 `JITTER_ATTR_LIMIT` 的数值** —— 次数一律用**区间**（跨阈值两侧），
 *     阈值被调整（20→30）时本节的"行为差异"结论不变、不会误红；
 *   · **不锚 `attributes` 字面**；
 *   · **只用同一个元素引用**观测（`M2-d`）—— 不用 `querySelector` 从外层重新解析，
 *     否则"记到别的键上"会被掩盖；
 *   · 每轮之间**间隔 > 700ms 防抖窗口**（750ms），保证一轮变更对应一次 flush。
 * 【为什么必须有本节】`C-71` 的核心行为差异是「`attr` 型超限**不再永久拉黑**」，
 *   而旧断言（`正/负/对照`）在 `attr` 未分桶时**也会全绿** ⇒ 必须成对钉住。
 * ================================================================== */

const C71_PAGE = '<!DOCTYPE html><html lang="en"><head><title>jitter buckets</title></head><body>'
  + '<div id="app">'
  + '<p id="u1">' + 'Alpha paragraph used for the attribute bucket checks. '.repeat(6) + '</p>'
  + '<p id="u2">' + 'Bravo paragraph used for the mixed bucket checks. '.repeat(6) + '</p>'
  + '<p id="u3">' + 'Charlie paragraph used for the content bucket checks. '.repeat(6) + '</p>'
  + '</div></body></html>';

/** 给某个 page 装 `collectUnits` 探针（记录"被扫描的根"）；返回记录数组 */
function probeRootsOf(c2) {
  const orig = c2.CT.renderer.collectUnits;
  const seen = [];
  c2.CT.renderer.collectUnits = function (root, settings) {
    seen.push(root === c2.document.body ? '#BODY' : (root.id ? '#' + root.id : root.tagName));
    return orig.call(this, root, settings);
  };
  return seen;
}

/** 驱动 n 轮：每轮执行 fn(i)，然后安静 >700ms（确保恰好一次尾随 flush） */
async function rounds(n, fn) {
  for (let i = 0; i < n; i++) { fn(i); await wait(750); }
}

section('八、`attr` 分桶与抖动守卫两桶（C-71）');
{
  /* ---------------- 正-a / 正-b / 正-c(M1/M2-e)：同元素 `class` 开合（`attr` 型） ------------- */
  const A = await bootPage(C71_PAGE, 'https://c71-attr.example.com/p');
  await wait(900);                       // 等 boot 期尾随 flush 落定（同 §二 的理由）
  const seenA = probeRootsOf(A.ctx);
  const u1 = A.doc.getElementById('u1');  // ★ M2-d：全程同一个元素引用，绝不重新 querySelector

  eq('八·前置：u1 是已登记的翻译单元（有译文块）',
    u1.querySelector(':scope > .ct-trans') ? 1 : 0, 1);

  await rounds(6, () => { u1.classList.toggle('fx'); });
  const seenA1 = seenA.filter((x) => x === '#u1').length;
  ok('正-a（6 次 `class` 开合 · 阈值下方）：不得出现 `data-ct-skip`',
    u1.hasAttribute('data-ct-skip') === false, 'attr=' + u1.getAttribute('data-ct-skip'));
  ok('  正-a：这 6 轮**确实进了采集**（否则本断言是空转）', seenA1 >= 6, '采集轮数=' + seenA1);

  await rounds(15, () => { u1.classList.toggle('fx'); });   // 累计 21 次 ⇒ 跨过阈值上方
  const seenA2 = seenA.filter((x) => x === '#u1').length;
  ok('正-b（累计 ≥21 次 · **阈值上方**）：仍不得出现 `data-ct-skip`（`attr` 超限只跳本轮）',
    u1.hasAttribute('data-ct-skip') === false, 'attr=' + u1.getAttribute('data-ct-skip'));
  ok('  正-b：确有"被跳"的轮（采集轮数 < 开合次数 21 —— 证明真的越过了阈值）',
    seenA2 < 21, '采集轮数=' + seenA2);

  await rounds(1, () => { u1.classList.toggle('fx'); });
  const seenA3 = seenA.filter((x) => x === '#u1').length;
  ok('正-c / M1（"只跳本轮"可恢复）＋ M2-e（跨轮不串味）：下一轮重新进入采集，且始终无 `data-ct-skip`',
    seenA3 > seenA2 && u1.hasAttribute('data-ct-skip') === false,
    'before=' + seenA2 + ' after=' + seenA3);
  A.dom.window.close();

  /* ---------------- M2-a：同键多类型（`attr` → `content` 序）⇒ 不得拉黑 ---------------- */
  const B = await bootPage(C71_PAGE, 'https://c71-m2a.example.com/p');
  await wait(900);
  const seenB = probeRootsOf(B.ctx);
  const uB = B.doc.getElementById('u2');
  await rounds(6, (i) => {
    uB.classList.toggle('fx');                                   // attributes → KIND_ATTR
    uB.firstChild.nodeValue = 'Bravo variant ' + i + ' ' + uB.firstChild.nodeValue.slice(20); // characterData → KIND_CONTENT
  });
  const seenB1 = seenB.filter((x) => x === '#u2').length;
  ok('M2-a（同键多类型 · `attr`→`content` 序 · 6 轮 > 内容阈值）：**不得**出现 `data-ct-skip`',
    uB.hasAttribute('data-ct-skip') === false, 'attr=' + uB.getAttribute('data-ct-skip'));
  ok('  M2-a：6 轮都进了采集', seenB1 >= 6, '采集轮数=' + seenB1);
  B.dom.window.close();

  /* ---------------- M2-b：反向序（`content` → `attr`）⇒ 结论与最后写入无关 ---------------- */
  const C = await bootPage(C71_PAGE, 'https://c71-m2b.example.com/p');
  await wait(900);
  const seenC = probeRootsOf(C.ctx);
  const uC = C.doc.getElementById('u2');
  await rounds(6, (i) => {
    uC.firstChild.nodeValue = 'Bravo variant ' + i + ' ' + uC.firstChild.nodeValue.slice(20); // content 先
    uC.classList.toggle('fx');                                   // attr 后
  });
  ok('M2-b（反向序 · `content`→`attr`）：同样**不得**出现 `data-ct-skip`（结果与"最后一次写入"无关）',
    uC.hasAttribute('data-ct-skip') === false, 'attr=' + uC.getAttribute('data-ct-skip'));
  C.dom.window.close();

  /* ---------------- 负 / M2-c：纯 `characterData` ×≥6 ⇒ 必须永久拉黑（行为等价） ---------------- */
  const D = await bootPage(C71_PAGE, 'https://c71-content.example.com/p');
  await wait(900);
  const uD = D.doc.getElementById('u3');
  await rounds(6, (i) => { uD.firstChild.nodeValue = 'Charlie variant ' + i + ' ' + uD.firstChild.nodeValue.slice(20); });
  eq('负 / M2-c（纯 `characterData` ×≥6 · 内容型）：**必须** `data-ct-skip="jitter"`',
    uD.getAttribute('data-ct-skip'), 'jitter');
  await rounds(2, (i) => { uD.firstChild.nodeValue = 'Charlie later ' + i + ' ' + uD.firstChild.nodeValue.slice(20); });
  eq('M4（`content` 桶行为等价）：拉黑是**永久**的（后续轮次不复活）', uD.getAttribute('data-ct-skip'), 'jitter');
  D.dom.window.close();

  /* ---------------- M3：`content` 桶的 `childList` 路径（原只测 `characterData`） ---------------- */
  const E = await bootPage(C71_PAGE, 'https://c71-childlist.example.com/p');
  await wait(900);
  const uE = E.doc.getElementById('u3');
  await rounds(6, (i) => { const s = E.doc.createElement('span'); s.textContent = 'child ' + i; uE.appendChild(s); });
  eq('M3（`content` 桶 `childList` 路径 ×≥6）：**必须** `data-ct-skip="jitter"`',
    uE.getAttribute('data-ct-skip'), 'jitter');
  E.dom.window.close();

  /* ---------------- M5：两单交互（交叉引用登记）—— shadow 路径不经抖动守卫 ---------------- */
  const cSrc = fs.readFileSync(path.join(ROOT, 'content/content.js'), 'utf8');
  const swSrc = fs.readFileSync(path.join(ROOT, 'content/shadow-walk.js'), 'utf8');
  eq('M5（两单交互 · 交叉引用单① §6.2-N3）：`noteChange` 在 content.js 中恰好 2 处（定义 + flush 唯一调用）',
    (cSrc.match(/noteChange\(/g) || []).length, 2);
  eq('  M5：shadow-walk.js 完全不出现 `noteChange` ⇒ shadow 路径**不经**抖动守卫'
    + '（与 `C-70 §8-7` 的反证一致：接线下 shadow 内元素不会被 `attr` 桶误伤）',
    (swSrc.match(/noteChange/g) || []).length, 0);

  /* ---------------- 口径自检（§5 注解 · L-22 家族）----------------
   * 口径只约束**断言代码**，不约束注释/文档里对该常量的说明 —— 故先**剥注释**再计数；
   * 探针名用**运行时拼接**，否则自检这一行的字面会把计数顶成 1（自己命中自己）。
   */
  const selfSrc = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const selfCode = selfSrc
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, '');
  const needleAttrLimit = 'JITTER_' + 'ATTR_LIMIT';
  eq('口径自检：本文件**代码**（剥注释）不锚 ' + needleAttrLimit + ' 数值（次数一律用区间）',
    selfCode.split(needleAttrLimit).length - 1, 0);
  eq('口径自检：本文件不锚 `attributes` 字面',
    (selfSrc.match(/['"]attributes['"]/g) || []).length, 0);
}

/* ================================================================== */
/* 九、扩展自身节点不得进入扫描面（`C-72` 已落码 · **期望绿**） */
/* ==================================================================
 * 【与 §二 的分工（两处断言各管一件事，互不替代）】
 *   · §二 原断言 = 「**不是整页**」（重扫根恰好是那个段落，不能退化成 `body`）；
 *   · 本 节断言 = 「**不含自身节点**」（扩展注入的节点不得被当成页面内容采走）。
 *   · §二 顶部那句 `await wait(900)` 的作用是**隔离**（把 boot 期那一轮让出 §二 的观测
 *     窗口），**不是掩盖** —— 观测窗口一旦让开，就必须由**本节**把它接回来：
 *     本节**故意**把那一轮纳入窗口，正是为了钉住它。
 * 【机制（实读 + 副本诊断确认 · 本节首版曾误判为 `isOwnNode` 漏 `<style>`，已更正）】
 *   泄漏的那 5 个根 = **页内开关 UI 的 shadow 子节点**：
 *     `content/toggle.js:686` `host.attachShadow({mode:'open'})`，随后在 shadow 内造
 *     `style`（`:689`）与 `div.box`（`:693`）/ `div.menu`（`:724`）/ `div.guide`（`:752`）/
 *     `div.confirm`（`:769`）。
 *   `shadow-walk.findRoots(document)` 会把这个 **open shadow root** 找到，经 `C-70` 的
 *   **Option E**：`CT.content.translateRoots(r.children)` ⇒ `run('mutation', kids)` ⇒
 *   `collectUnits(div.box)` … ⇒ 它们就成了"重扫根"。
 *   **关键**：`isOwnNode` **只守卫 observer 三支**（`content.js` 的 childList /
 *   characterData / attributes），**不在 shadow 这条路径上** ⇒ 把 `isOwnNode` 扩到覆盖
 *   `<style>`/`.box` **不能**消除本项（副本实测：扩了仍红）。
 * 【`C-72` 已落码 ⇒ 本节**期望转绿**】
 *   `content/shadow-walk.js` 的 `pump()` 已在 `QUEUE.shift()` 之后、`try` 之前插入
 *   **宿主判据**（`r.host` 命中 `data-ct-skip` ／ `translate="no"` ／ `CT.TOGGLE_CLASS`
 *   任一 ⇒ **整根跳过**，且**不触碰 `scanned`**）⇒ 开关那棵 shadow 不再进采集面。
 *   **若本节再变红** ⇒ 说明"整根跳过"被绕过（例如经 `findRoots(document)` **独立入队**的
 *   内层 root —— 该边界已在 `C-72` 单内登记，方案 B 最小形态亦已登记，本批不实施）。
 * 【jsdom 放大注记（**必读**：本节旧观测含放大成分，真机判据见下一批）】
 *   本节先前观测到的"违规 5"含**无布局放大**成分：jsdom 下 `document.documentElement` 的
 *   `getClientRects()` 为空 ⇒ `renderer.engineHasLayout()`（`renderer.js:406/410`）恒 `false`
 *   ⇒ `renderedOut()`（`renderer.js:415/416`）**直接 `return false`（不跳）** ⇒ 真实浏览器里
 *   本会被"布局外"判据跳过的节点，在这里仍会进采集 ⇒ 本节的"根"集合**比真机更宽**。
 *   ⇒ **本节只钉"管线入口不被自身 root 污染"这一层**；**真机面的判据另见真机断言（`C-72`
 *   下一批）**，不得以本节绿替代真机结论。
 * 【判据独立性】本节"是否属扩展自身"**不复用** `isOwnNode`（否则自证自明），用**并集判据**：
 *   `STYLE` ／ class 含 `ct-` ／ 落在已知自身容器内 ／ **provenance**（签名不在原始页面 HTML 里）。
 * ================================================================== */
section('九、扩展自身节点不得进入扫描面（`C-72` 已落码 · **期望绿**）');
{
  /* 关键时序：**必须在 boot 完成之前**就装上 `collectUnits` 探针 —— 主夹具（模块顶部那份）
   * 就是这么装的，它才看得见 boot 期那一轮尾随 flush。`bootPage()` 内部已 `wait(160)`，
   * 装上时首轮已过 ⇒ 用它观测会**看不到**该轮（首次试跑的"零采集"就是这么来的）。 */
  const dF = new JSDOM(C71_PAGE, { url: 'https://c71-ownnode.example.com/p', runScripts: 'outside-only', pretendToBeVisual: true });
  const cF = dF.getInternalVMContext();
  const settingsF = Object.assign({}, ctx.CT.DEFAULT_SETTINGS, {
    enabled: true, autoTranslate: true, displayMode: 'below', cacheEnabled: false, targetLang: 'zh-CN'
  });
  cF.chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: 'test' }),
      sendMessage(msg, cb) {
        let res = { ok: true };
        if (msg.type === 'ct:get-settings') res = { ok: true, settings: settingsF };
        else if (msg.type === 'ct:set-settings') res = { ok: true, settings: Object.assign({}, settingsF, msg.patch) };
        else if (msg.type === 'ct:translate') res = { ok: true, provider: 'stub', translations: msg.items.map((i) => '〔' + i.text + '〕') };
        cb(res);
      },
      onMessage: { addListener() {} }
    },
    storage: {
      local: { get(k, cb) { if (cb) cb({}); }, set(o, cb) { void o; if (cb) cb(); } },
      onChanged: { addListener() {} }
    }
  };
  const rootsF = [];
  for (const rel of MODULE_LIST) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), cF, { filename: rel });
    if (rel === 'content/renderer.js') {           // 装探针：仍在 boot 之前（boot 由 content.js 末尾触发）
      const origF = cF.CT.renderer.collectUnits;
      cF.CT.renderer.collectUnits = function (root) {
        rootsF.push(root);
        return origF.apply(this, arguments);
      };
    }
  }
  const docF = dF.window.document;
  // ★ 故意把 boot 期（含扩展自身控件注入）的尾随 flush 纳入观测窗口
  await wait(2000);

  const OWN_SELECTOR = '.ct-trans, .ct-tip, .ct-badge, .ct-toggle, .ct-learn-card, .ct-cap-note';
  const pristine = new JSDOM(C71_PAGE);                    // 原始页面（未跑扩展）——provenance 基准
  const pristineSig = new Set();
  pristine.window.document.querySelectorAll('*').forEach((el) => {
    pristineSig.add(el.tagName + '.' + String(el.className || '').trim().replace(/\s+/g, '.'));
  });
  const sigOf = (el) => el.tagName + '.' + String(el.className || '').trim().replace(/\s+/g, '.');
  /*
   * 「是否属扩展自身节点」= **并集**判据（**不复用** `isOwnNode`，否则自证自明）：
   *   ① `<style>`（扩展注入样式）；
   *   ② class 含 `ct-` 前缀（既有自身类族）；
   *   ③ 落在已知自身容器内（`.ct-trans/.ct-tip/.ct-badge/.ct-toggle/.ct-learn-card/.ct-cap-note`）；
   *   ④ **provenance**：其 `TAG.class` 签名**不在原始页面 HTML 里** ⇒ 只可能是扩展造出来的
   *      （这条覆盖 `toggle.js:693/724/752/769` 注入的 `div.box / div.menu / div.guide / div.confirm`，
   *       它们既无 `ct-` 类、也不在已知容器内 ⇒ ①②③ 都会漏）。
   */
  const isOwnRoot = (el) => {
    if (!el || el === docF.body || el.nodeType !== 1) return false;
    if (el.tagName === 'STYLE') return true;
    if (/(^|\s)ct-/.test(String(el.className || ''))) return true;
    if (el.closest && el.closest(OWN_SELECTOR)) return true;
    return !pristineSig.has(sigOf(el));
  };
  const desc = (el) => (el && el.nodeType === 1)
    ? (el.tagName
      + (el.id ? '#' + el.id : '')
      + (el.className ? '.' + String(el.className).trim().replace(/\s+/g, '.') : '')
      + (el.hasAttribute && el.hasAttribute('data-ct-shadow-style') ? '[data-ct-shadow-style]' : ''))
    : String(el);
  const offenders = rootsF.filter(isOwnRoot);

  ok('九·前置：本窗口确有采集发生（否则本断言是空转）', rootsF.length > 0, '采集次数=' + rootsF.length);
  ok('九 扩展自身节点不得进入 `scanRoots`（期望 0；`C-72` 落码后应绿）',
    offenders.length === 0,
    '违规=' + offenders.length + ' :: ' + JSON.stringify(offenders.map(desc))
      + '  ｜ 窗口内全部根=' + JSON.stringify(rootsF.map(desc)));
  dF.window.close();
}

console.log('\n────────────────────────────────────────────────────');
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  · ' + f);
  console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
  process.exit(1);
}
console.log('全部通过：' + passed + ' 项断言');
