/*
 * 真机集成探针 · `C-70`（`S-13` shadow 接线落点 · Option E）—— `D6`
 * ==================================================================
 * 依据：`docs/B3-行为变更单-S13-shadow接线落点-OptionD-2026-10-16.md`（`C-70`）
 *   §5 `D6`（真机集成探针 · 本轮新增）+ §6.1（正 / 正-静态页）+ §6.2（三层闭环②）
 *   + §8-6（`⚠️【签附条件 · CTO 签署语①】`「autoTranslate 关 → 手动开启 ⇒ shadow
 *   仍恒 0 译文」＝ `U-1` 未修子情形）。
 *
 * 【本探针要证什么（照 §5 `D6` 原文逐条）】
 *   1. **先 P0 前提自证**：`typeof CT.content.translateRoots === 'function'`
 *      —— 该契约由 `C-70` `D1` 新增；`D1` 未落 ⇒ 本项**必红**（这就是实证材料）。
 *   2. **再**断言：**shadow 内可见英文段落产生译文**。
 *   3. **子用例 (a)**：**纯静态页 ＋ 页面加载后无文档级变更 ＋ 仅 shadow 内英文**
 *      ⇒ 仍产生译文（钉死「消费被排定」，= CTO ④ 的直接反例）。
 *   4. **子用例 (b)**【`R1` 签附】：`autoTranslate` 关 → **手动开启** ⇒
 *      shadow 内译文数 `> 0`。
 *
 * 【运行】`NODE_PATH=<node_modules> node tools/probe-shadow-wiring.mjs`
 *   真实 Chromium（Chrome for Testing）+ 真实扩展 + **本地 mock 引擎**（不依赖外网；
 *   否则「没译文」分不清是"接线没落"还是"网络挂了"—— 探针自身的假阳性来源）。
 *
 * 【两处已注明的夹具口径偏差（如实登记，均给机制依据）】
 *   A. 夹具保留了**一句 light DOM 英文**（`<h1>Shadow wiring fixture</h1>`）：
 *      `content/content.js:2102-2110` 的**整页语言闸门** `needsPageTranslation(...)`
 *      若判定「页面语言＝目标语言」会**整页跳过**（连 `run()` 都不进）⇒ 若夹具的
 *      light DOM 一个英文都没有，本探针会因**语言闸门**而非**接线**变红 ⇒ 红灯
 *      **不可归因**。故保留该句作闸门的必要输入；**译文计数只数 shadow 根内**，
 *      故仍精确证明 shadow 路径是否被接线。
 *   B. **子用例 (b) 的红色 ≠ 接线缺陷**：`C-70 §8-6` 已把「autoTranslate 关→手动开」
 *      登记为 `U-1` **未修子情形**（本轮只登记不修；修它需另清 `shadowScanned`
 *      与 `__ctQueued` 两处闩）。⇒ **`D1`–`D3` 落码后 (b) 仍可能红**，那属**已登记边界**，
 *      不得据此判「接线未落」。
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
const EXT = ROOT;
const CHROME = process.env.CT_E2E_CHROME
  || 'C:/Users/Administrator/.workbuddy/binaries/cft/chrome-win64/chrome.exe';

/* ---------------- mock 引擎 + 夹具（同端口） ---------------- */
const SHADOW_EN = [
  'Shadow components ship their own rendering pipeline and style scope.',
  'A translated paragraph inside the shadow root proves the wiring is live.',
  'Without the bridge this text stays English no matter how long you wait.'
];
let engineBatches = 0;

function fixtureHtml() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>shadow wiring fixture</title>
<style>body{margin:0;padding:16px;font:14px/1.7 system-ui;background:#fff}</style>
</head><body>
<h1>Shadow wiring fixture</h1>
<div id="host"></div>
<script>
  /* 在**解析期**就挂上 open shadow root ⇒ 内容脚本的 observer（document_idle 才启动）
     观察不到任何"加载后"的文档级变更 ⇒ 满足子用例 (a)「无文档级变更」。 */
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
  res.end(fixtureHtml());
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = 'http://127.0.0.1:' + PORT;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? '  \u2713 ' : '  \u2717 ') + name + (detail !== undefined ? '  :: ' + detail : ''));
}

console.log('\n── C-70 · D6 真机集成探针（shadow 接线 · Option E）──');
console.log('夹具 = ' + BASE + '   引擎 = 本地 mock（batch 数=' + engineBatches + ' 起步）');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-shadowwiring-'));

/** 页面内读数：**只数 shadow 根内**的译文块（light DOM 计数作对照 sanity） */
const READ_SNIPPET = () => {
  const host = document.getElementById('host');
  const sr = host && host.shadowRoot;
  const shadowTrans = sr ? sr.querySelectorAll('.ct-trans').length : -1;
  const lightTrans = document.querySelectorAll('body > .ct-trans, body .ct-trans').length;
  const shadowHostParas = sr ? sr.querySelectorAll('p.shadow-para').length : -1;
  const shadowSample = sr
    ? Array.prototype.map.call(sr.querySelectorAll('.ct-trans'), (n) => (n.textContent || '').slice(0, 28))
    : [];
  const badge = document.querySelector('.ct-badge');
  return {
    shadowTrans,
    lightTrans,
    shadowHostParas,
    shadowSample,
    toggleCount: document.querySelectorAll('.ct-toggle').length,
    badge: badge ? (badge.textContent || '').trim() : null
  };
};

/** 经 CDP 读**内容脚本隔离世界**里的 `CT.content.translateRoots`（Playwright 的
 *  page.evaluate 只看主世界，读不到 content script 的 window.CT ⇒ 必须走 CDP
 *  逐 executionContext 求值，挑出定义了 CT 的那个世界）。 */
async function readContractInContentWorld(page) {
  const cdp = await page.context().newCDPSession(page);
  const seen = [];
  cdp.on('Runtime.executionContextCreated', (e) => { seen.push(e.context); });
  await cdp.send('Runtime.enable');
  await new Promise((r) => setTimeout(r, 400));
  let found = null;
  for (const c of seen) {
    try {
      const r = await cdp.send('Runtime.evaluate', {
        expression: "typeof CT === 'undefined' ? 'NO_CT' : ((CT && CT.content && typeof CT.content.translateRoots === 'function') ? 'HAS_CONTRACT' : 'CT_NO_CONTRACT')",
        contextId: c.id,
        returnByValue: true
      });
      const v = r && r.result && r.result.value;
      if (v === 'HAS_CONTRACT' || v === 'CT_NO_CONTRACT') {
        found = { contextId: c.id, name: c.name || '', origin: c.origin || '', value: v };
        break;
      }
    } catch (e) { /* context 可能已销毁 */ }
  }
  try { await cdp.detach(); } catch (e) { /* ignore */ }
  return { found, contextCount: seen.length };
}

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
  /* ---------- 等 service worker ---------- */
  let sw = ctx.serviceWorkers()[0];
  for (let i = 0; i < 40 && !sw; i++) {
    await new Promise((r) => setTimeout(r, 250));
    sw = ctx.serviceWorkers()[0];
  }
  if (!sw) throw new Error('未拿到扩展 service worker');
  const extId = new URL(sw.url()).host;
  console.log('扩展 id = ' + extId);

  /* ---------- 控制通道（options 页持有 chrome.*） ---------- */
  const ctl = await ctx.newPage();
  await ctl.goto('chrome-extension://' + extId + '/options/options.html', { waitUntil: 'domcontentloaded' });
  await ctl.waitForTimeout(600);

  const setSettings = (patch) => ctl.evaluate((p) => new Promise((res) => {
    chrome.runtime.sendMessage({ type: 'ct:set-settings', patch: p }, (r) => res(r || null));
  }), patch);

  const triggerTranslateNow = (exactUrl) => ctl.evaluate((u) => new Promise(async (res) => {
    const tabs = await chrome.tabs.query({ url: u });
    /*
     * 触发定向（`G-3`/A1 修正版，2026-10-17）：**只允许"恰好一个候选标签页"**。
     * 旧写法 `const [t] = …` 会**静默取 tabs[0]** —— 当同 URL 存在第二个标签页时
     * （本探针早先 (a) 页与 P0 页都未关即属此情形），命令会被发给**错的页**，而本子用例
     * 只会看到"目标页毫无变化"，表现为**假红**（`G-3` 的 (b) 自 `C-70` 起一直是假红）。
     * ⇒ ① 查询改为**精确 URL**（非通配）② 多候选**显式失败**（fail loud，并回贴候选 URL 列表）
     * ③ 配套：跑 (b) 前已 `await warm.close()` 与 `await pa.close()` ⇒ 正常路径下候选恒为 1。
     */
    if (tabs.length !== 1) {
      return res({ err: 'ambiguous-tabs:' + tabs.length, usedTab: null, resp: null, lastError: null,
        urls: tabs.map((t) => t.url) });
    }
    const t = tabs[0];
    chrome.tabs.sendMessage(t.id, { type: 'ct:cmd', cmd: { action: 'translateNow' } }, (r) => {
      res({ err: null, usedTab: t.id, resp: r, lastError: chrome.runtime.lastError ? String(chrome.runtime.lastError.message) : null });
    });
  }), exactUrl);

  const BASE_PATCH = {
    provider: 'openai',
    openaiBaseUrl: BASE + '/v1',
    openaiApiKey: 'probe',
    openaiModel: 'mock',
    toggleVisible: true,
    selectionEnabled: false,
    pdfEnabled: false,
    cacheEnabled: false,
    shadowDomEnabled: true,
    glossary: []
  };

  /* ==================================================================
   * P0 前提自证（先做，且**独立于任何译文**）
   * ================================================================== */
  await setSettings(Object.assign({}, BASE_PATCH, { autoTranslate: false }));
  const warm = await ctx.newPage();
  await warm.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await warm.waitForTimeout(1200);
  const contract = await readContractInContentWorld(warm);
  console.log('\n[P0] 内容世界 executionContext 数 = ' + contract.contextCount
    + '；命中世界 = ' + JSON.stringify(contract.found));
  check('P0 前提自证：内容脚本隔离世界里 typeof CT.content.translateRoots === "function"',
    !!(contract.found && contract.found.value === 'HAS_CONTRACT'),
    contract.found ? (contract.found.value + ' @ ' + (contract.found.name || contract.found.origin)) : '未找到定义了 CT 的内容世界');

  // 触发定向修正（2026-10-17 · 配套）：P0 用的 `warm` 页与 fixture 同 URL，用完即关，
  // 免得它成为 (b) 阶段 `chrome.tabs.query({url})` 的第二个候选（这正是当初"发错 tab"的成因之一）。
  await warm.close();

  /* ==================================================================
   * 子用例 (a)：纯静态页 + 加载后无文档级变更 + 仅 shadow 内英文 ⇒ 仍产生译文
   * ================================================================== */
  console.log('\n[子用例 (a)] 纯静态页 · autoTranslate=true · 不手动触发');
  await setSettings(Object.assign({}, BASE_PATCH, { autoTranslate: true }));
  const pa = await ctx.newPage();
  await pa.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await pa.waitForTimeout(4500);
  const ra = await pa.evaluate(READ_SNIPPET);
  console.log('  (a) 读数 = ' + JSON.stringify(ra));
  check('(a) sanity：light DOM 英文已译（证明引擎/语言闸门通路正常，红灯可归因于 shadow 接线）',
    ra.lightTrans >= 1, 'lightTrans=' + ra.lightTrans);
  check('(a) 正：shadow 根内产生译文（钉死「消费被排定」，CTO ④ 的反例）',
    ra.shadowTrans > 0, 'shadowTrans=' + ra.shadowTrans + ' / shadow 内原段落=' + ra.shadowHostParas);

  /* ==================================================================
   * 子用例 (b)【R1 签附】：autoTranslate 关 → 手动开启 ⇒ shadow 内译文 > 0
   *   ⚠ 本项 = `C-70 §8-6` 已登记的 `U-1` **未修子情形**（本轮只登记不修）
   *      ⇒ 其红色 ≠ 接线缺陷。
   * ================================================================== */
  console.log('\n[子用例 (b)] autoTranslate=false → 手动 translateNow（§8-6 已登记未修情形）');
  // 触发定向修正（2026-10-17）：先关掉 (a) 的页面 —— 它与 (b) 同 URL，留着会让
  // `tabs.query({url})` 返回 2 个候选；配合 triggerTranslateNow 的"恰好 1 个"断言，
  // 使"把 translateNow 发给 (a) 页"这一静默错路**不可能再发生**。
  await pa.close();
  await setSettings(Object.assign({}, BASE_PATCH, { autoTranslate: false }));
  const pb = await ctx.newPage();
  await pb.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await pb.waitForTimeout(1800);
  const before = await pb.evaluate(READ_SNIPPET);
  const trig = await triggerTranslateNow(BASE + '/');
  await pb.waitForTimeout(4500);
  const rb = await pb.evaluate(READ_SNIPPET);
  console.log('  (b) 触发前 = ' + JSON.stringify(before) + '\n  (b) 触发后 = ' + JSON.stringify(rb)
    + '\n  (b) translateNow 回执 = ' + JSON.stringify(trig));
  check('(b) 手动开启后 shadow 根内译文 > 0（修前恒 0）',
    rb.shadowTrans > 0, 'shadowTrans=' + rb.shadowTrans);

  /* ---------- 收尾 ---------- */
  /* ==================================================================
   * 子用例 (c)【`C-73` 签附② 新增 · **仅新增，既有判据与期望值一字未改**】
   * ------------------------------------------------------------------
   * 覆盖路径：**全局 `s.enabled = false` ＋ 用户点 `translateNow`**（= 明确的 per-page 意图）。
   * 为什么必须补：`BASE_PATCH` 不设 `enabled` ⇒ 取默认 `true` ⇒ 上两例都走不到这条路径；
   *   而 `translateNow` 的注释原文（`content/content.js:2350-2351`）写着「**即便全局总开关是关的**，
   *   用户点了这一下就是要这一页有译文」，它置 `state.pageOverride = true` 后 `applySettings(s,'manual')`
   *   ⇒ 这是一条**独立的、可达的**入口。
   * 期望：**shadow 内译文 > 0**（与 (b) 同类缺陷：首扫闩在 `next.enabled === false` 时不复位）。
   * ⚠️ 本条只加**路径**；`(b)` 与其余判据的写法、期望值保持不变。
   * ================================================================== */
  console.log('\n[子用例 (c)] 全局 enabled=false ＋ 手动 translateNow（per-page 意图）');
  await pb.close();                       // 关闭 (b) 页：同为 fixture URL，避免触发定向出现多候选
  await setSettings(Object.assign({}, BASE_PATCH, { autoTranslate: true, enabled: false }));
  const pc = await ctx.newPage();
  await pc.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await pc.waitForTimeout(1800);
  const beforeC = await pc.evaluate(READ_SNIPPET);
  const trigC = await triggerTranslateNow(BASE + '/');
  await pc.waitForTimeout(4500);
  const afterC = await pc.evaluate(READ_SNIPPET);
  console.log('  (c) 触发前 = ' + JSON.stringify(beforeC));
  console.log('  (c) 触发后 = ' + JSON.stringify(afterC));
  console.log('  (c) translateNow 回执 = ' + JSON.stringify(trigC));
  check('(c)·前置 sanity：命令确达本页（回执 err=null 且 light DOM 已译）',
    !!(trigC && trigC.err === null && afterC.lightTrans > 0),
    'err=' + JSON.stringify(trigC && trigC.err) + ' usedTab=' + JSON.stringify(trigC && trigC.usedTab)
      + ' lightTrans=' + afterC.lightTrans);
  check('(c) 正：全局 enabled=false ＋ 手动开启后，shadow 根内译文 > 0', afterC.shadowTrans > 0,
    'shadowTrans=' + afterC.shadowTrans + ' / shadow 内原段落=' + afterC.shadowHostParas);
  await pc.close();

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
