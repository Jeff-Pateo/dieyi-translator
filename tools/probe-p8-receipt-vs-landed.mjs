/*
 * 真机集成探针 · `P-8`（「回执译文数 ≠ 实际落屏数」）
 * ==========================================================================
 * 依据：`docs/历史缺陷回归护栏清单.md` §四 `P-8` 行（登记现象原文）
 *   > 子用例 **(b) 路径下，连 light DOM 的 `<h1>` 也未落屏** —— 回执
 *   > **`translated:1` 但 `lightTrans=0`**；而同页 (a) 路径 **`lightTrans=1`**
 *   > ⇒ **回执译文数 ≠ 实际落屏数**（可能与 `U-1` 同族；未证实）。
 *   > **现状：尚写不出一条会变红的断言。**
 *
 * 【本探针要回答的两个问题，分两节】
 *
 *   §A **`P-8` 登记现象是否成立 · 与 `G-3` 是否同源**
 *      · 在 (b) 路径（`autoTranslate` 关 → 手动 `translateNow`）下，把
 *        `CT.renderer.renderUnit` / `clearUnit` / `restoreAll` / `resetStats` /
 *        `resetForModeChange` / `collectUnits` 全部包上观测钩（内容脚本隔离世界），
 *        逐次记录 **自增点**（`Δstats.translated`）与 **落屏点**（译文节点是否
 *        当场连在文档、属于哪棵树）。
 *      · 断言：
 *        `A-0` 回执必须来自**被断言的那一页**（靶向确定性 · fail loud）；
 *        `A-1` (b) 路径下 light DOM 必须落屏（**直接反驳**「连 `<h1>` 也未落屏」）；
 *        `A-2` 每一次 `renderUnit` 返回 true ⇒ **同一同步块内** `Δtranslated === 1`
 *              且译文节点**当场已连**（光 DOM 或 shadow 内皆属合法落点）
 *              ⇒ 自增点与落屏点**未被**早返回切开；
 *        `A-3` 稳态下 `stats.translated === 全树 .ct-trans 计数`；
 *        `A-4` **(b) 路径上的「计数 vs 落屏」**：`CT.shadow.stats().scanned > 0`
 *              ⇒ `#host` 内必须有译文落屏。
 *              【实测沿革 · 必须按树对号】这条在 **`G-3` 修前树**上是**红**的：
 *              `content/content.js = 2187dcec…` · `content/shadow-walk.js = 68c34115…`
 *              时，(b) 路径 `scanned = 1` 而 `#host` 内落屏 **0** 条 —— `boot()` 早返回前
 *              已把 root 递给 `translateRoots`，内容被丢，但 `shadow-walk.js:244` 的
 *              `scanned++` 照样执行 ⇒ **虚假成功计数**（与 `C-70 D3` 自述契约
 *              「`scanned++` 只在"真实执行之后"」相悖）。
 *              `G-3` 落码后（`content.js` → `fadf6c87…` · `shadow-walk.js` → `e1b041b4…`）
 *              该 root 会在手动开启后重投并真的翻译 ⇒ 同一条断言**转绿**
 *              （实测 `scanned = 2` / `#host` 内落屏 **3** 条）。
 *              ⇒ `A-4` 是**在缺陷上红、在修复后绿**的真护栏，不是恒真。
 *
 *   §B **「回执数 ≠ 落屏数」不变式（这条是真缺陷 · 现在红）**
 *      真实管线**重译**同一条单元（页面改了正文 → `MutationObserver` → `run('mutation')`
 *      → `maybePush` 原文指纹变了 → `renderUnit` 重渲染）。实测：`renderUnit` 开头
 *      `clearUnit(el,false)` **摘掉旧译文节点**（`renderer.js:623`），随后再插一个新节点并
 *      `stats.translated++` ⇒ **同一个元素把 `translated` 加了两次，屏上只有一条**。
 *      `translated` 被 `popup/popup.js:208` 当作「本页已翻译段数」直接展示，
 *      也被 `background/service-worker.js:1417` 当作 `translate_round.translated` 上报
 *      ⇒ 这是**用户可见 + 数据面可见**的「回执译文数 ≠ 实际落屏数」。
 *      · `B-1` 前置：初次翻译确实落屏 1 条；
 *      · `B-2` 前置：文本变更后**确实**发生了对**同一元素**的重渲染（真实管线驱动）；
 *      · `B-3`（主 · **会变红**）稳态 `stats.translated === 全树 .ct-trans 计数`。
 *
 * 【为什么 §B 不是「自注入桩」】
 *   §B **不手工调用** `renderUnit`（那正是本项目 `F-3`/`U-1` 记过的「自注入桩」反模式）。
 *   触发链全部由**页面自己的 `textContent` 赋值**经**真实 `MutationObserver`** 走完
 *   `collectUnits → maybePush → renderUnit`；探针只**读**结果。
 *
 * 【运行】
 *   `NODE_PATH=C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules \
 *     node tools/probe-p8-receipt-vs-landed.mjs`
 *   真实 Chromium（Chrome for Testing）+ 真实扩展 + **本地 mock 引擎**（不依赖外网 ⇒
 *   「没落屏」不会被网络问题混淆）。
 *
 * 【靶向确定性（这条是 `P-8` 登记现象的**测量学来源**，已坐实）】
 *   既有 `tools/probe-shadow-wiring.mjs`（`P-8` 登记现象的产地）用
 *   `chrome.tabs.query({ url: BASE + '/*' })[0]` 取标签页；而它跑 (b) 之前
 *   P0 页与 (a) 页**都还开着、且三页同 URL 段** ⇒ 命令可能发给**另一页**，回执读的是
 *   那一页的 `R.getStats()`，而被断言的这一页**从未收到命令**、`lightTrans` 恒 0
 *   ⇒ 产出「`translated:1` 但 `lightTrans=0`」的**假红**。
 *   本探针因此：① 两页**不同路径**；② 触发时**只允许恰好 1 个候选**，否则**显式失败**；
 *   ③ 回贴命中的 tab（可审计）。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
/* `CT_EXT_DIR` 只用于**变异验证**：把整份扩展复制到临时目录、改坏/修好某一处后，
 * 用 `CT_EXT_DIR=<副本> node tools/probe-p8-receipt-vs-landed.mjs` 跑同一个探针。
 * 默认 = 本仓自身 ⇒ 真仓零改动。 */
const EXT = process.env.CT_EXT_DIR || ROOT;
const CHROME = process.env.CT_E2E_CHROME
  || 'C:/Users/Administrator/.workbuddy/binaries/cft/chrome-win64/chrome.exe';

/* ---------------- mock 引擎 + 夹具（同端口） ---------------- */
const SHADOW_EN = [
  'Shadow components ship their own rendering pipeline and style scope.',
  'A translated paragraph inside the shadow root proves the wiring is live.',
  'Without the bridge this text stays English no matter how long you wait.'
];
/** §B 的正文，够长以过 `minTextLength` 与可译判定 */
const RE_TEXT_A = 'The quarterly planning document explains how product teams align on goals and metrics across regions.';
/** §B 变更后的正文（与 A **不同** ⇒ 指纹变 ⇒ 触发重译） */
const RE_TEXT_B = 'An amended quarterly planning memo restates how product teams align on goals and metrics across regions.';

let engineBatches = 0;

function shadowFixture() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>shadow wiring fixture</title>
<style>body{margin:0;padding:16px;font:14px/1.7 system-ui;background:#fff}</style>
</head><body>
<h1>Shadow wiring fixture</h1>
<div id="host"></div>
<script>
  (function () {
    var host = document.getElementById('host');
    var sr = host.attachShadow({ mode: 'open' });
    var body = ${JSON.stringify(SHADOW_EN)};
    for (var i = 0; i < body.length; i++) {
      var p = document.createElement('p');
      p.className = 'shadow-para';
      p.textContent = body[i];
      sr.appendChild(p);
    }
  })();
</script>
</body></html>`;
}

/** §B 夹具：**唯一**一段正文（初始为 A），供后续由页面自身改文本触发重译 */
function rerenderFixture() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>rerender fixture</title>
<style>body{margin:0;padding:16px;font:14px/1.7 system-ui;background:#fff}</style>
</head><body>
<p id="t">${RE_TEXT_A}</p>
<script>
  window.__ctSetTextB = function () { document.getElementById('t').textContent = ${JSON.stringify(RE_TEXT_B)}; };
</script>
</body></html>`;
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const user = payload.messages[payload.messages.length - 1].content;
        const texts = JSON.parse(user).map((x) => (typeof x === 'string' ? x : x.s));
        engineBatches++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'mock', object: 'chat.completion', created: 1, model: 'mock',
          choices: [{
            index: 0, finish_reason: 'stop',
            message: { role: 'assistant', content: JSON.stringify({ t: texts.map((s) => '【译】' + s) }) }
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0 }
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(e) } }));
      }
    });
    return;
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(url === '/re' ? rerenderFixture() : shadowFixture());
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = 'http://127.0.0.1:' + PORT;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? '  \u2713 ' : '  \u2717 ') + name + (detail !== undefined ? '  :: ' + detail : ''));
}

console.log('\n── P-8 · 真机断言批（回执译文数 vs 实际落屏数）──');
console.log('夹具 = ' + BASE + '   引擎 = 本地 mock（不依赖外网）');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-p8-'));

/**
 * 内容脚本隔离世界的**固定**求值通道。
 * ------------------------------------------------------------------
 * Playwright 的 `page.evaluate` 只看主世界；内容脚本在隔离世界 ⇒ 必须走 CDP
 * 逐 executionContext 求值。
 *
 * ⚠️ 这里踩过一个真坑并已修正：不要「取第一个能求出值的 context」——主世界会把
 * `typeof CT === 'undefined' ? 'NO_CT' : …` 求成 `'NO_CT'`，而
 * `executionContextCreated` 事件的**到达次序不稳定** ⇒ 同一个页面里「装钩」与
 * 「读日志」两次调用可能落到**不同 context**，表现为「装钩返回 HOOKED、日志却恒空」
 * 的**假阴性**。故：**建一次会话 → 显式解析出「有 `CT.renderer` 的那个 contextId」
 * → 全程只用它**。
 */
async function makeContentChannel(page) {
  const cdp = await page.context().newCDPSession(page);
  const seen = [];
  cdp.on('Runtime.executionContextCreated', (e) => { seen.push(e.context); });
  await cdp.send('Runtime.enable');
  await new Promise((r) => setTimeout(r, 400));

  let contextId = null;
  const census = [];
  for (const c of seen) {
    try {
      const r = await cdp.send('Runtime.evaluate', {
        expression: "(typeof CT === 'undefined' || !CT.renderer) ? 'NOT_CT' : 'IS_CT'",
        contextId: c.id, returnByValue: true
      });
      const v = r && r.result && r.result.value;
      census.push({ id: c.id, name: c.name || '', origin: c.origin || '', v: v });
      if (v === 'IS_CT' && contextId === null) contextId = c.id;
    } catch (e) { census.push({ id: c.id, err: String(e).slice(0, 60) }); }
  }
  if (contextId === null) {
    try { await cdp.detach(); } catch (e) { /* ignore */ }
    throw new Error('未在内容脚本隔离世界里找到 CT.renderer；context 普查 = ' + JSON.stringify(census));
  }
  return {
    contextId, census,
    async eval(expression) {
      const r = await cdp.send('Runtime.evaluate', { expression, contextId, returnByValue: true });
      if (r && r.exceptionDetails) {
        return { ok: false, err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description)
          || r.exceptionDetails.text };
      }
      return { ok: true, value: r && r.result ? r.result.value : null };
    },
    async close() { try { await cdp.detach(); } catch (e) { /* ignore */ } }
  };
}

/**
 * 观测钩（装进内容世界）。只**观测**，不改行为。
 * 关键点：`renderUnit` / `clearUnit` **成对**记录，才能判「自增点与落屏点是否同块」。
 */
const HOOK_SOURCE = `
  (function () {
    if (typeof CT === 'undefined' || !CT.renderer) return 'NO_CT';
    var R = CT.renderer;
    if (R.__p8) return 'ALREADY';
    var log = [];
    var t0 = Date.now();
    R.__p8 = { log: log, t0: t0 };
    function kindOfTree(n) {
      if (!n) return 'null';
      var rn = (typeof n.getRootNode === 'function') ? n.getRootNode() : null;
      if (!rn) return 'no-root';
      if (rn.nodeType === 9) return 'document';
      if (rn.host) return 'shadow-of:' + rn.host.tagName + '.' + String(rn.host.className || '');
      return 'other:' + rn.nodeType;
    }
    function stackOf() {
      try {
        return String(new Error().stack || '').split('\\n').slice(1, 5)
          .map(function (x) { return x.trim().replace(/^at\\s+/, ''); });
      } catch (e) { return []; }
    }
    var origRender = R.renderUnit;
    R.renderUnit = function (el /*, translation, settings, srcHash, plan, srcText */) {
      var before = R.getStats().translated;
      var regBefore = R.registry.get(el);
      var nodeBefore = regBefore && regBefore.node ? regBefore.node : null;
      var out = origRender.apply(this, arguments);
      var after = R.getStats().translated;
      var rec = R.registry.get(el);
      var node = rec && rec.node ? rec.node : null;
      log.push({
        t: Date.now() - t0, fn: 'renderUnit', el: el && el.tagName,
        elId: el && el.id ? el.id : '',
        elText: el ? String(el.textContent || '').slice(0, 20) : '',
        returned: !!out, dTranslated: after - before,
        mode: rec ? rec.mode : null,
        oldNodeStillConnected: !!(nodeBefore && nodeBefore.isConnected),
        nodeTag: node ? node.tagName : null,
        nodeConnected: node ? node.isConnected : null,
        nodeTree: node ? kindOfTree(node) : null
      });
      return out;
    };
    var origClear = R.clearUnit;
    R.clearUnit = function (el, drop) {
      var rec = R.registry.get(el);
      var node = rec && rec.node ? rec.node : null;
      var willDetach = !!(node && node.parentNode);
      var out = origClear.apply(this, arguments);
      log.push({
        t: Date.now() - t0, fn: 'clearUnit', el: el && el.tagName,
        elId: el && el.id ? el.id : '',
        dropRecord: drop === undefined ? true : !!drop,
        detachRegisteredNode: willDetach
      });
      return out;
    };
    var origRestore = R.restoreAll;
    R.restoreAll = function () {
      var before = R.getStats().translated;
      var out = origRestore.apply(this, arguments);
      log.push({ t: Date.now() - t0, fn: 'restoreAll', translatedBefore: before, stack: stackOf() });
      return out;
    };
    var origModeReset = R.resetForModeChange;
    R.resetForModeChange = function () {
      log.push({ t: Date.now() - t0, fn: 'resetForModeChange', stack: stackOf() });
      return origModeReset.apply(this, arguments);
    };
    var origResetStats = R.resetStats;
    R.resetStats = function () {
      log.push({ t: Date.now() - t0, fn: 'resetStats', stack: stackOf() });
      return origResetStats.apply(this, arguments);
    };
    var origCollect = R.collectUnits;
    R.collectUnits = function (root) {
      var out = origCollect.apply(this, arguments);
      log.push({
        t: Date.now() - t0, fn: 'collectUnits',
        root: root && (root.tagName || ('#' + (root.id || '')) || ('node' + root.nodeType)),
        units: out ? out.length : -1
      });
      return out;
    };
    return 'HOOKED';
  })()
`;

/* ---------- 主世界：全树普查（光 DOM ∪ 全部 open shadow root） ---------- */
const CENSUS = () => {
  function walkShadow(node, out, hostPath) {
    var els;
    try { els = node.querySelectorAll('*'); } catch (e) { return; }
    for (var i = 0; i < els.length; i++) {
      var sr = els[i].shadowRoot;
      if (sr) {
        var cls = (els[i].className && String(els[i].className)) || '';
        var rp = hostPath + '>' + els[i].tagName + (cls ? '.' + cls.split(/\s+/).join('.') : '');
        out.push({
          path: rp,
          total: sr.querySelectorAll('.ct-trans').length,
          src: sr.querySelectorAll('[data-ct-src]').length,
          mark: sr.querySelectorAll('[data-ct-mark]').length
        });
        walkShadow(sr, out, rp);
      }
    }
  }
  var byRoot = [];
  var lightTrans = document.querySelectorAll('body .ct-trans').length;
  byRoot.push({
    path: 'document',
    total: lightTrans,
    src: document.querySelectorAll('body [data-ct-src]').length,
    mark: document.querySelectorAll('body [data-ct-mark]').length
  });
  walkShadow(document, byRoot, 'document');
  var total = 0;
  for (var k = 0; k < byRoot.length; k++) total += byRoot[k].total;
  return {
    lightTrans: lightTrans,
    total: total,
    byRoot: byRoot,
    hostParas: (function () {
      var h = document.getElementById('host');
      return h && h.shadowRoot ? h.shadowRoot.querySelectorAll('p.shadow-para').length : -1;
    })(),
    /** `#host`（页面自有 open shadow）内部**实际落屏**的译文数 —— A-4 的落屏口径 */
    hostShadowTrans: (function () {
      var h = document.getElementById('host');
      return h && h.shadowRoot ? h.shadowRoot.querySelectorAll('.ct-trans').length : -1;
    })(),
    toggles: document.querySelectorAll('.ct-toggle').length
  };
};

const CT_STATS_EXPR = "JSON.stringify({stats: CT.renderer.getStats(), shadow: (CT.shadow && CT.shadow.stats) ? CT.shadow.stats() : null})";

const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  executablePath: CHROME,
  viewport: { width: 1200, height: 900 },
  args: [
    '--disable-extensions-except=' + EXT,
    '--load-extension=' + EXT,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1200,900'
  ]
});

try {
  let sw = ctx.serviceWorkers()[0];
  for (let i = 0; i < 40 && !sw; i++) { await new Promise((r) => setTimeout(r, 250)); sw = ctx.serviceWorkers()[0]; }
  if (!sw) throw new Error('未拿到扩展 service worker');
  const extId = new URL(sw.url()).host;
  console.log('扩展 id = ' + extId);

  const ctl = await ctx.newPage();
  await ctl.goto('chrome-extension://' + extId + '/options/options.html', { waitUntil: 'domcontentloaded' });
  await ctl.waitForTimeout(600);

  const setSettings = (patch) => ctl.evaluate((p) => new Promise((res) => {
    chrome.runtime.sendMessage({ type: 'ct:set-settings', patch: p }, (r) => res(r || null));
  }), patch);

  /** 触发「立即翻译本页」：**只允许恰好 1 个候选标签页**，否则显式失败（防跨页假红）。 */
  const triggerTranslateNow = (exactUrl) => ctl.evaluate((u) => new Promise(async (res) => {
    const tabs = await chrome.tabs.query({ url: u });
    if (tabs.length !== 1) {
      return res({ err: 'ambiguous-tabs:' + tabs.length, targetTab: null, urls: tabs.map((t) => t.url), resp: null });
    }
    const t = tabs[0];
    chrome.tabs.sendMessage(t.id, { type: 'ct:cmd', cmd: { action: 'translateNow' } }, (r) => {
      res({
        err: null,
        targetTab: { id: t.id, url: t.url, active: t.active },
        candidateCount: tabs.length,
        resp: r,
        lastError: chrome.runtime.lastError ? String(chrome.runtime.lastError.message) : null
      });
    });
  }), exactUrl);

  const BASE_PATCH = {
    provider: 'openai', openaiBaseUrl: BASE + '/v1', openaiApiKey: 'probe', openaiModel: 'mock',
    targetLang: 'zh-CN', sourceLang: 'auto',
    toggleVisible: true, selectionEnabled: false, pdfEnabled: false, cacheEnabled: false,
    shadowDomEnabled: true, glossary: []
  };

  /* ==================================================================
   * §A —— (b) 路径：自增点 / 落屏点 关系
   * ================================================================== */
  console.log('\n════ §A (b) 路径：自增点 / 落屏点 关系 ════');

  /* A 前置：先跑一遍 (a) 建立批内状态（复刻 P-8 登记现象的产地次序），
     跑完**立即关闭**该页 —— 保证 (b) 触发时候选标签页恒为 1。 */
  console.log('\n[§A 前置] (a) 页：autoTranslate=true · 不手动触发（跑完即关，保证靶向唯一）');
  await setSettings(Object.assign({}, BASE_PATCH, { autoTranslate: true }));
  const pa = await ctx.newPage();
  await pa.goto(BASE + '/a', { waitUntil: 'domcontentloaded' });
  await pa.waitForTimeout(4500);
  const ra = await pa.evaluate(CENSUS);
  console.log('  (a) 读数 = ' + JSON.stringify(ra));
  check('(a) 前置 sanity：light DOM 已译且 shadow 内已译（批内状态已建立）',
    ra.lightTrans >= 1 && ra.total >= 4, 'lightTrans=' + ra.lightTrans + ' census.total=' + ra.total);

  /* (a) 路径的 `scanned` 对照读数 —— A-4 的配对件要用它：
   * 同一夹具、(a) 路径下 `scanned` 与 shadow 内落屏数**一致**（都非 0）。 */
  const chanA = await makeContentChannel(pa);
  const statsA = await chanA.eval(CT_STATS_EXPR);
  let stA = null; try { stA = JSON.parse(statsA.value); } catch (e) { /* ignore */ }
  console.log('  (a) shadow 计数读数 = ' + JSON.stringify(stA && stA.shadow)
    + ' / #host 内实际落屏 = ' + ra.hostShadowTrans + ' 条');
  await chanA.close();
  await pa.close();

  console.log('\n[§A 主体] (b) 页：autoTranslate=false → 手动 translateNow');
  await setSettings(Object.assign({}, BASE_PATCH, { autoTranslate: false }));
  const pb = await ctx.newPage();
  await pb.goto(BASE + '/b', { waitUntil: 'domcontentloaded' });
  await pb.waitForTimeout(1800);

  const chan = await makeContentChannel(pb);
  console.log('  内容世界 contextId = ' + chan.contextId + ' ；context 普查 = ' + JSON.stringify(chan.census));
  const installed = await chan.eval(HOOK_SOURCE);
  const readback = await chan.eval("(CT.renderer && CT.renderer.__p8) ? 'HOOKED' : 'MISS'");
  check('A·前置：观测钩已装进内容世界，且**同一通道**能读回（否则因果链不可归因）',
    installed.value === 'HOOKED' && readback.value === 'HOOKED',
    'install=' + JSON.stringify(installed) + ' readback=' + JSON.stringify(readback));

  const preStats = await chan.eval(CT_STATS_EXPR);
  console.log('  (b) 触发前 stats = ' + preStats.value);

  const trig = await triggerTranslateNow(BASE + '/b');
  check('A-0 回执**来自被断言的那一页**（候选标签页恰 1 个；否则回执与落屏不同页、不可比）',
    !!(trig && trig.err === null && trig.candidateCount === 1)
      && !!(trig.targetTab && trig.targetTab.url.indexOf('/b') >= 0),
    JSON.stringify({ err: trig && trig.err, candidateCount: trig && trig.candidateCount, targetTab: trig && trig.targetTab }));
  const receiptStats = (trig && trig.resp && trig.resp.stats) || null;
  console.log('  (b) 回执 = ' + JSON.stringify(trig && trig.resp && trig.resp.stats));

  const atReceiptCensus = await pb.evaluate(CENSUS);
  console.log('  (b) 回执同刻 census.total = ' + atReceiptCensus.total + ' lightTrans = ' + atReceiptCensus.lightTrans);

  let lastCensus = null, lastStats = null;
  for (const ms of [300, 1200, 3000]) {
    await pb.waitForTimeout(ms === 300 ? 300 : 900);
    lastCensus = await pb.evaluate(CENSUS);
    lastStats = await chan.eval(CT_STATS_EXPR);
    console.log('  (b) +' + ms + 'ms：census.total=' + lastCensus.total
      + ' lightTrans=' + lastCensus.lightTrans + ' | ' + lastStats.value);
  }

  const logA = await chan.eval("JSON.stringify(CT.renderer.__p8.log)");
  let hookLogA = [];
  try { hookLogA = JSON.parse(logA.value); } catch (e) { /* ignore */ }
  console.log('\n  (b) 观测钩日志（' + hookLogA.length + ' 条）:');
  for (const e of hookLogA) console.log('    ' + JSON.stringify(e));

  let steadyStatsA = null;
  try { steadyStatsA = JSON.parse(lastStats.value).stats; } catch (e) { /* ignore */ }

  console.log('');
  check('A-1 (b) 路径下 light DOM **必须落屏**（直接反驳「连 `<h1>` 也未落屏」）',
    lastCensus.lightTrans >= 1, 'lightTrans=' + lastCensus.lightTrans + ' byRoot=' + JSON.stringify(lastCensus.byRoot));

  const renderCallsA = hookLogA.filter((e) => e.fn === 'renderUnit');
  const renderOkA = renderCallsA.filter((e) => e.returned);
  /* 不变式口径（**与落屏位置无关**）：
   *   每次重放 renderUnit 返回 true ⇒ `Δstats.translated === 1` 且译文节点**当场已连**
   *   （`nodeConnected === true`）。「已连」才是「落屏」的判据 —— 它同时覆盖
   *   **光 DOM** 与 **shadow root 内**两种合法落点。
   *   ⚠️ 本断言**曾经**多要一条 `nodeTree === 'document'`。那是本探针在 `G-3` 修前
   *   树上写的：当时 (b) 路径 shadow 内容全丢，落点只可能是光 DOM。`G-3` 落码后
   *   （`content/content.js` 2187dcec→fadf6c87 · `content/shadow-walk.js` 68c34115→e1b041b4）
   *   shadow 内也正常落屏 ⇒ 那条 `nodeTree` 约束会变成**本探针自己造的假红**。
   *   故改为：只钉「计数即落屏」+「属本文档」，落点树只作**证据**打印。 */
  check('A-2 自增点与落屏点**同一同步块**：每次 renderUnit 返回 true ⇒ Δtranslated===1 且译文节点当场已连（光 DOM 或 shadow 内皆可）',
    renderOkA.length >= 1 && renderOkA.every((e) => e.dTranslated === 1 && e.nodeConnected === true),
    'renderUnit 调用=' + renderCallsA.length + ' 返回 true=' + renderOkA.length + ' 明细='
      + JSON.stringify(renderOkA.map((e) => ({ el: e.el, dTranslated: e.dTranslated, nodeConnected: e.nodeConnected, nodeTree: e.nodeTree }))));

  check('A-3 稳态：`stats.translated` === 全树 `.ct-trans` 计数（回执数 == 落屏数）',
    !!steadyStatsA && steadyStatsA.translated === lastCensus.total,
    'stats.translated=' + (steadyStatsA && steadyStatsA.translated) + ' / census.total=' + lastCensus.total);

  /* ---- A-4（**(b) 路径上的「计数 vs 落屏」· 现在红**）--------------------------
   * 口径依据（引 `content/shadow-walk.js` 自己的契约，不是我自定的）：
   *   · `enqueue` 顶部注释（`C-70 D3`）：「`scanned++` **只在"真实执行之后"**（旧写法把它
   *     放在 `if` 之外 ⇒ 契约缺失也 +1，制造"虚假成功计数"，即 `U-1` 的现象）」；
   *   · `pump()` 内 `C-72`「宿主标记」分支的【硬约束】：「跳过路径**只 `continue`**，
   *     **绝不触碰 `scanned`** —— 否则重演 `C-70 D3` 刚消除的「虚假成功计数」」。
   *   ⇒ `scanned` 的**自述语义 = 「这个 root 真的被处理了」**，不是「我把引用递出去了」。
   *
   * (b) 路径实测：`boot()` 在「autoTranslate 关」早返回**之前**就 `ensureShadowScan()`
   * ⇒ `#host` 入队 ⇒ idle 回调 `translateRoots(kids)` → `run('mutation', kids)` →
   * `content.js:941` 早返回（`state.enabled === false`）⇒ **内容全丢**；
   * 但 `shadow-walk.js:244` 的 `scanned++` **照样执行**。手动开启后
   * `ensureShadowScan()` 因 `shadowScanned === true` 直接返回，该 root **永不重投**。
   * ⇒ 稳态 `scanned = 1`（自称处理过 1 个 root）而 `#host` 内**落屏 0 条** —— 计数与落屏脱节。
   * 对照：`(a)` 路径同夹具 `scanned = 1` 且 shadow 内落屏 3 条 ⇒ 计数与落屏一致
   *（本探针 §A 前置已实测 (a) `census.total = 4`，其中 shadow 内 3 条）。
   */
  let shadowStatsA = null;
  try { shadowStatsA = JSON.parse(lastStats.value).shadow; } catch (e) { /* ignore */ }
  console.log('\n  (b) shadow 计数读数 = ' + JSON.stringify(shadowStatsA)
    + ' / #host 内实际落屏 = ' + lastCensus.hostShadowTrans + ' 条（页面共有 '
    + lastCensus.hostParas + ' 个可译 shadow 段落）');
  const a4bad = !!(shadowStatsA && shadowStatsA.scanned > 0 && lastCensus.hostShadowTrans === 0);
  check('A-4（(b) 路径上的「计数 vs 落屏」· 会变红）：shadow 消费计数 `scanned > 0` ⇒ shadow 内必须有译文落屏',
    !a4bad,
    'scanned=' + (shadowStatsA && shadowStatsA.scanned)
      + ' / #host 内落屏=' + lastCensus.hostShadowTrans
      + ' / skippedOwn=' + (shadowStatsA && shadowStatsA.skippedOwn)
      + (a4bad
        ? ' —— scanned 自称「处理过 ' + shadowStatsA.scanned + ' 个 root」，而屏上一条都没有'
        : ' —— 计数与落屏一致')
      + '（同夹具 (a) 路径对照：scanned=' + (stA && stA.shadow && stA.shadow.scanned)
      + ' 且落屏 ' + ra.hostShadowTrans + '）');

  /* ==================================================================
   * §B —— 「回执数 ≠ 落屏数」不变式（真实重译路径 · 现在红）
   * ================================================================== */
  console.log('\n════ §B 回执数 ≠ 落屏数 不变式（真实管线重译） ════');
  console.log('  说明：页面自身改正文 ⇒ MutationObserver ⇒ run(\'mutation\') ⇒ maybePush 指纹变 ⇒ renderUnit 重渲染。');
  console.log('        探针**不调用** renderUnit（避免自注入桩），只**读**结果。');
  console.log('  历史注：`clearUnit(el,false)` 摘旧节点 + 新插入 = 同一元素把 translated 加两次（renderer.js:623）。');

  await setSettings(Object.assign({}, BASE_PATCH, { autoTranslate: true }));
  const pr = await ctx.newPage();
  await pr.goto(BASE + '/re', { waitUntil: 'domcontentloaded' });
  await pr.waitForTimeout(3500);

  const chanR = await makeContentChannel(pr);
  const installedR = await chanR.eval(HOOK_SOURCE);
  check('B·前置：观测钩已装进内容世界（重译页）', installedR.value === 'HOOKED', JSON.stringify(installedR));

  const census1 = await pr.evaluate(CENSUS);
  const stats1 = await chanR.eval(CT_STATS_EXPR);
  let st1 = null; try { st1 = JSON.parse(stats1.value).stats; } catch (e) { /* ignore */ }
  console.log('  初次翻译后：census.total=' + census1.total + ' lightTrans=' + census1.lightTrans + ' | ' + stats1.value);
  check('B-1 前置：初次翻译确实落屏 1 条（否则后面无从谈重译）',
    census1.total === 1 && !!st1 && st1.translated === 1,
    'census.total=' + census1.total + ' stats.translated=' + (st1 && st1.translated));

  // 真实变更：页面自己的 textContent 赋值（不是探针调 renderUnit）
  await pr.evaluate(() => window.__ctSetTextB());
  await pr.waitForTimeout(3000);   // observer 700ms 防抖 + 往返 + 渲染

  const census2 = await pr.evaluate(CENSUS);
  const stats2 = await chanR.eval(CT_STATS_EXPR);
  let st2 = null; try { st2 = JSON.parse(stats2.value).stats; } catch (e) { /* ignore */ }
  const logR = await chanR.eval("JSON.stringify(CT.renderer.__p8.log)");
  let hookLogR = [];
  try { hookLogR = JSON.parse(logR.value); } catch (e) { /* ignore */ }
  console.log('  文本变更后：census.total=' + census2.total + ' lightTrans=' + census2.lightTrans + ' | ' + stats2.value);
  console.log('  观测钩日志（' + hookLogR.length + ' 条）:');
  for (const e of hookLogR) console.log('    ' + JSON.stringify(e));

  const rendersB = hookLogR.filter((e) => e.fn === 'renderUnit');
  const collectsB = hookLogR.filter((e) => e.fn === 'collectUnits');
  // 屏上此刻：`#t` 名下（子树内 ＋ 紧随兄弟）的译文节点数 + 全文
  const tInsp = await pr.evaluate(() => {
    const t = document.getElementById('t');
    const texts = Array.prototype.map.call(
      document.querySelectorAll('body .ct-trans'), (n) => (n.textContent || '').slice(0, 44)
    );
    let sibCount = 0;
    let sib = t.nextElementSibling;
    while (sib && sib.classList && sib.classList.contains('ct-trans')) { sibCount++; sib = sib.nextElementSibling; }
    return {
      insideT: t.querySelectorAll('.ct-trans').length,
      siblingsAfterT: sibCount,
      own: t.querySelectorAll('.ct-trans').length + sibCount,
      bodyTrans: document.querySelectorAll('body .ct-trans').length,
      texts: texts
    };
  });
  console.log('  #t 名下译文节点 = ' + JSON.stringify(tInsp));

  check('B-2 前置：变更后**确实**经真实管线（collectUnits → renderUnit）重渲染了同一元素，且其屏上仍只 1 条',
    collectsB.length >= 1 && rendersB.length >= 1
      && rendersB.every((e) => e.elId === 't')
      && tInsp.own === 1 && tInsp.bodyTrans === 1,
    'collectUnits=' + collectsB.length + ' renderUnit=' + rendersB.length
      + ' 明细=' + JSON.stringify(rendersB.map((e) => ({ el: e.el, elId: e.elId, dTranslated: e.dTranslated })))
      + ' / #t 名下译文=' + tInsp.own + ' bodyTrans=' + tInsp.bodyTrans + ' 屏上译文=' + JSON.stringify(tInsp.texts));

  console.log('');
  check('B-3（主 · 会变红）稳态：`stats.translated` === 全树 `.ct-trans` 计数（回执数 == 落屏数）',
    !!st2 && st2.translated === census2.total,
    'stats.translated=' + (st2 && st2.translated) + ' / census.total=' + census2.total
      + '（差 ' + (st2 ? (st2.translated - census2.total) : 'n/a') + ' 条）'
      + ' / registry.size=' + (st2 && st2.units) + ' byRoot=' + JSON.stringify(census2.byRoot));

  await pr.close();
  await chanR.close();

  const pass = results.every((r) => r.ok);
  console.log('\n结论：' + (pass ? 'PASS' : 'FAIL') + '（'
    + results.filter((r) => r.ok).length + '/' + results.length + '）');
  console.log('引擎 batch 总数 = ' + engineBatches);
  process.exitCode = pass ? 0 : 1;
} finally {
  await ctx.close().catch(() => {});
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
