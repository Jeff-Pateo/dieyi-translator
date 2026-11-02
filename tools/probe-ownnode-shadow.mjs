/*
 * 真机集成探针 · `C-72`（shadow 路径整根跳过扩展自身 UI）—— `P1` / `P2-a` / `P2-b` / `P2-c` / `P3`
 * ==================================================================
 * 依据：`docs/` 内 `C-72` 单 `§5`（「必含 4 项 + 1 变异」）。逐条实现：
 *   · **P1（正 · 主）**：**目标语言 = 非中文** ＋ 打开页内开关与 `guide` / `menu`
 *     ⇒ **扩展自身 UI 子树内 `[data-ct-src]` / `.ct-trans` / `[data-ct-mark]` 全 = 0**。
 *   · **P2-a（负-a · 防跳太多）**：页面自有 open shadow · 宿主**无标记** ⇒ **必须被翻译**。
 *   · **P2-b（负-b · 与光 DOM 对齐）**：页面自有 open shadow · 宿主带 `translate="no"` ⇒ **不翻译**。
 *   · **P2-c（负-c · OR 第三支）**：页面自有 open shadow · 宿主带 `data-ct-skip` ⇒ **不翻译**。
 *   · **P3（对照）**：读 `CT.shadow.stats()` ⇒ **`skippedOwn ≥ 1`** 且 **`scanned === 0`**
 *     （该根不得自增 `scanned` ⇒ 不污染「真实成功计数」）。
 * 引擎 = **本地 mock**（不依赖外网）⇒「没译文」不会被网络问题混淆。
 * 运行：`NODE_PATH=<node_modules> node tools/probe-ownnode-shadow.mjs`
 *
 * 【两处已注明的口径取舍（如实登记，不迁就）】
 * 1) **判据选择器**：`.ct-trans` / `[data-ct-src]` 在 `tools/` 有先例；**`[data-ct-mark]` 无先例**
 *    （已全仓核实）⇒ 本探针**自建该判据**并给理由：`data-ct-mark` 由 `renderer.js:715` 设于译文
 *    节点，与 `.ct-trans`（类名）/ `[data-ct-src]`（源指纹属性）属**不同维度**的标记 ⇒ 三条并用
 *    可防"改名而留属性"的漏判。**不是**把无先例当成有效证据，而是**显式自建 + 三重冗余**。
 * 2) **`confirm` 面板为何未在 P1 中打开**（`C-72 §5` 原文要求"打开 guide / confirm"）：
 *    实读 `content/content.js:827-830` —— `state.toggleConfirm = 'blocked'` **只在
 *    `CT.settings.isBlockedHost(hostname(), s.blocklist)` 为真时**置位；而站点被拉黑 ⇒
 *    `effectiveEnabled()` 为假 ⇒ `run()` 在 `content.js:927` **早返回** ⇒ **管线不跑**。
 *    二者**结构性互斥**：`confirm` 能被打开时，本页根本没有译文本可谈（P1 会变成**空转绿**）。
 *    又：`onMore('never')`（= 菜单里最接近 confirm 的入口，`content.js:579`）会**直接拉黑并
 *    销毁控件**（`onUnblockRequestReverse()` → `state.toggle.destroy()`）⇒ 也不可达。
 *    ⇒ 本探针**以 `guide` ＋ `menu` 打开态**做 P1（二者与 `confirm` **同处同一棵 shadow root**，
 *    故"整根跳过"这一判据所作用的对象完全一致），并**如实报出该偏离**（见回报）。
 * 3) **附段 = `P-13` 多层 shadow「已知边界见证」**（**预期红** · **单列 · 不计入主判据与退出码**）：
 *    外层宿主带标记、内层宿主不带标记 ⇒ `findRoots(document)` **独立发现**内层 root ⇒ 内层内容
 *    仍被翻译 ⇒ 如实暴露 `C-72` 单内已登记的边界；**它是见证断言、不是回归断言**，修它属方案 B
 *    （**未实施**）。⇒ **主判据口径仍为 19/19**；附段另计（见回报中的「口径需更新为 X/Y」）。
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

const EN = 'The quarterly planning document explains how product teams align on goals and metrics. ';
const SHADOW_EN = 'A paragraph owned by the page shadow root must still be translated.';

let engineBatches = 0;

/** 夹具：`/` 无页面自有 shadow；`/own*` 带页面自有 open shadow（宿主标记不同） */
function pageHtml(kind) {
  const light = '<h1>Own-node isolation fixture</h1><p>' + EN.repeat(4) + '</p>';
  if (kind === 'plain') {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>own-node fixture</title>`
      + `<style>body{margin:0;padding:16px;font:14px/1.7 system-ui;background:#fff}</style></head>`
      + `<body>${light}</body></html>`;
  }
  const attr = kind === 'no' ? ' translate="no"' : (kind === 'skip' ? ' data-ct-skip="page"' : '');
  if (kind === 'multi') {
    // P-13 夹具：**外层宿主带标记、内层宿主不带任何标记**，各套一层 open shadow。
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>multi-layer fixture</title>`
      + `<style>body{margin:0;padding:16px;font:14px/1.7 system-ui;background:#fff}</style></head>`
      + `<body>${light}<div id="outer" data-ct-skip="page"></div>`
      + `<script>(function(){`
      + `var o=document.getElementById('outer');var osr=o.attachShadow({mode:'open'});`
      + `var inner=document.createElement('div');inner.id='inner';osr.appendChild(inner);`
      + `var isr=inner.attachShadow({mode:'open'});`
      + `var p=document.createElement('p');p.textContent=${JSON.stringify(SHADOW_EN)};isr.appendChild(p);`
      + `})();</script></body></html>`;
  }
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>own-node fixture</title>`
    + `<style>body{margin:0;padding:16px;font:14px/1.7 system-ui;background:#fff}</style></head>`
    + `<body>${light}<div id="host"${attr}></div>`
    + `<script>(function(){var h=document.getElementById('host');var sr=h.attachShadow({mode:'open'});`
    + `var p=document.createElement('p');p.textContent=${JSON.stringify(SHADOW_EN)};sr.appendChild(p);})();</script>`
    + `</body></html>`;
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const texts = JSON.parse(payload.messages[payload.messages.length - 1].content)
          .map((x) => (typeof x === 'string' ? x : x.s));
        engineBatches++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'mock', object: 'chat.completion', created: 1, model: 'mock',
          choices: [{ index: 0, finish_reason: 'stop',
            message: { role: 'assistant', content: JSON.stringify({ t: texts.map((s) => '【訳】' + s) }) } }],
          usage: { prompt_tokens: 0, completion_tokens: 0 }
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(e) } }));
      }
    });
    return;
  }
  const kind = url === '/own' ? 'own' : url === '/own-no' ? 'no' : url === '/own-skip' ? 'skip' : url === '/multi' ? 'multi' : 'plain';
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(pageHtml(kind));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:' + server.address().port;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? '  \u2713 ' : '  \u2717 ') + name + (detail !== undefined ? '  :: ' + detail : ''));
}

console.log('\n── C-72 · 真机断言批（shadow 路径整根跳过扩展自身 UI）──');
console.log('夹具 = ' + BASE);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-ownnode-'));

/** 在**内容脚本隔离世界**里求值（Playwright 的 page.evaluate 只看主世界）。 */
async function evalInContentWorld(page, expression) {
  const cdp = await page.context().newCDPSession(page);
  const seen = [];
  cdp.on('Runtime.executionContextCreated', (e) => { seen.push(e.context); });
  await cdp.send('Runtime.enable');
  await new Promise((r) => setTimeout(r, 350));
  let out = { found: false, value: null };
  for (const c of seen) {
    try {
      const r = await cdp.send('Runtime.evaluate', { expression, contextId: c.id, returnByValue: true });
      const v = r && r.result && r.result.value;
      if (v !== undefined && v !== null && String(v).indexOf('NO_CT') !== 0) { out = { found: true, value: v }; break; }
      if (String(v).indexOf('NO_CT') === 0) { out = { found: true, value: v }; break; }
    } catch (e) { /* context 可能已销毁 */ }
  }
  try { await cdp.detach(); } catch (e) { /* ignore */ }
  return out;
}

const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  executablePath: CHROME,
  viewport: { width: 1200, height: 900 },
  args: [
    '--disable-extensions-except=' + EXT,
    '--load-extension=' + EXT,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-first-run', '--no-default-browser-check', '--window-size=1200,900'
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

  // ★ 目标语言 = **非中文**（'ja'）：英文夹具仍需翻译（en→ja），而扩展自身 UI 的中文文案
  //   若泄漏进管线，也会被判为"外文"而产出译文 ⇒ 泄漏**可见**（P1 因此非空转）。
  const cfg = await setSettings({
    provider: 'openai', openaiBaseUrl: BASE + '/v1', openaiApiKey: 'probe', openaiModel: 'mock',
    targetLang: 'ja', sourceLang: 'auto', autoTranslate: true,
    toggleVisible: true, selectionEnabled: false, pdfEnabled: false, cacheEnabled: false,
    shadowDomEnabled: true, siteMemory: false, glossary: []
  });
  check('控制通道可用（设置已下发 · targetLang=ja）', !!(cfg && cfg.ok), JSON.stringify(cfg && cfg.ok));

  /* ================= 主夹具（无页面自有 shadow）：P1 + P3 ================= */
  const p1 = await ctx.newPage();
  await p1.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await p1.waitForTimeout(3400);
  const sanity = await p1.evaluate(() => ({
    lightTrans: document.querySelectorAll('body .ct-trans').length,
    toggles: document.querySelectorAll('.ct-toggle').length,
    hasShadow: !!(document.querySelector('.ct-toggle') && document.querySelector('.ct-toggle').shadowRoot)
  }));
  check('P1·前置 sanity：页面 light DOM 已产生译文（否则 P1 是空转绿）',
    sanity.lightTrans > 0, JSON.stringify(sanity));
  check('P1·前置：页内开关已挂载且其 shadow root 可读（open）',
    sanity.toggles === 1 && sanity.hasShadow, JSON.stringify(sanity));

  /* ---- P1-a：**guide 打开态**快照 ----------------------------------------------------
   * `guide` 与 `menu` 在控件内**互斥**（`content/toggle.js:937`：`closeOverlays('menu')`
   * ⇒ `release('guide'); st.guideOpen = false`）⇒ 二者**不能同时可见**。
   * 故 P1 分两次快照：先量 guide 打开态（首次挂载自动弹出，不点掉），再开 menu 量第二态。
   * 两次快照作用在**同一棵 shadow root**上 ⇒ 与"整根跳过"这一判据的对象完全一致。 */
  const MEASURE = () => {
    const host = document.querySelector('.ct-toggle');
    const sr = host && host.shadowRoot;
    if (!sr) return { err: 'no-shadow' };
    return {
      trans: sr.querySelectorAll('.ct-trans').length,
      src: sr.querySelectorAll('[data-ct-src]').length,
      mark: sr.querySelectorAll('[data-ct-mark]').length,
      panelState: {
        box: !!sr.querySelector('.box'),
        menu: !!sr.querySelector('.menu') && !sr.querySelector('.menu').hidden,
        guide: !!sr.querySelector('.guide') && !sr.querySelector('.guide').hidden,
        confirm: !!sr.querySelector('.confirm') && !sr.querySelector('.confirm').hidden
      },
      hostAttrs: { cls: host.className, skip: host.getAttribute('data-ct-skip') },
      textLen: (sr.textContent || '').length
    };
  };
  const p1g = await p1.evaluate(MEASURE);
  console.log('  P1-a（guide 打开态）观测 = ' + JSON.stringify(p1g));
  check('P1·前置：`guide` 面板此刻**可见**（否则本快照空转）',
    !!(p1g.panelState && p1g.panelState.guide), JSON.stringify(p1g.panelState));
  check('P1-a 正：guide 打开态下，自身 UI 子树内 `.ct-trans` = 0', p1g.trans === 0, 'trans=' + p1g.trans);
  check('P1-a 正：… `[data-ct-src]` = 0', p1g.src === 0, 'src=' + p1g.src);
  check('P1-a 正：… `[data-ct-mark]` = 0（自建判据，见文件头取舍①）', p1g.mark === 0, 'mark=' + p1g.mark);

  // 打开 guide 之外的第二块面板：`.tool--more` → 菜单（此操作会关闭 guide，见上）
  let menuErr = null;
  try { await p1.locator('.ct-toggle .tool--more').click({ timeout: 5000 }); }
  catch (e) { menuErr = String(e).slice(0, 120); }
  await p1.waitForTimeout(1200);

  const p1m = await p1.evaluate(MEASURE);
  console.log('  P1-b（menu 打开态）观测 = ' + JSON.stringify(p1m) + (menuErr ? '  菜单点击异常=' + menuErr : ''));
  check('P1·前置：`menu` 面板确有打开（断言非空转）',
    !!(p1m.panelState && p1m.panelState.menu),
    JSON.stringify(p1m.panelState));
  check('P1-b 正（主）：扩展自身 UI 子树内 `.ct-trans` = 0', p1m.trans === 0, 'trans=' + p1m.trans);
  check('P1-b 正（主）：扩展自身 UI 子树内 `[data-ct-src]` = 0', p1m.src === 0, 'src=' + p1m.src);
  check('P1-b 正（主）：扩展自身 UI 子树内 `[data-ct-mark]` = 0（自建判据，见文件头取舍①）',
    p1m.mark === 0, 'mark=' + p1m.mark);

  const stats = await evalInContentWorld(p1,
    "typeof CT === 'undefined' ? 'NO_CT' : (CT.shadow && CT.shadow.stats ? JSON.stringify(CT.shadow.stats()) : 'NO_STATS')");
  console.log('  P3 读数 = ' + JSON.stringify(stats));
  let st = null;
  try { st = JSON.parse(stats.value); } catch (e) { /* not json */ }
  check('P3 对照：`CT.shadow.stats().skippedOwn ≥ 1`（确有自身 root 被整根跳过）',
    !!st && typeof st.skippedOwn === 'number' && st.skippedOwn >= 1, JSON.stringify(st));
  check('P3 对照：`scanned === 0`（该根**未**自增真实成功计数 —— 不污染 `scanned`）',
    !!st && st.scanned === 0, JSON.stringify(st));
  await p1.close();

  /* ================= P2-a / P2-b / P2-c：页面自有 open shadow ================= */
  const CASES = [
    { key: 'P2-a', url: '/own', expect: 'be-translated', desc: '宿主无标记 ⇒ 必须被翻译（防跳太多）' },
    { key: 'P2-b', url: '/own-no', expect: 'not-translated', desc: '宿主 translate="no" ⇒ 必须不被翻译' },
    { key: 'P2-c', url: '/own-skip', expect: 'not-translated', desc: '宿主 data-ct-skip ⇒ 必须不被翻译' }
  ];
  for (const c of CASES) {
    const pg = await ctx.newPage();
    await pg.goto(BASE + c.url, { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(3400);
    const m = await pg.evaluate(() => {
      const host = document.getElementById('host');
      const sr = host && host.shadowRoot;
      return {
        lightTrans: document.querySelectorAll('body .ct-trans').length,
        shadowTrans: sr ? sr.querySelectorAll('.ct-trans').length : -1,
        shadowSrc: sr ? sr.querySelectorAll('[data-ct-src]').length : -1,
        shadowParas: sr ? sr.querySelectorAll('p').length : -1
      };
    });
    console.log('  ' + c.key + '（' + c.desc + '）观测 = ' + JSON.stringify(m));
    check(c.key + '·前置 sanity：light DOM 已译（管线在跑）', m.lightTrans > 0, 'lightTrans=' + m.lightTrans);
    if (c.expect === 'be-translated') {
      check(c.key + ' 负-a：页面自有 open shadow **必须被翻译**（译文 > 0）', m.shadowTrans > 0,
        'shadowTrans=' + m.shadowTrans + ' / shadow 内段落=' + m.shadowParas);
    } else {
      check(c.key + ' 负（' + c.desc + '）：shadow 内译文 **必须 = 0**', m.shadowTrans === 0, 'shadowTrans=' + m.shadowTrans);
    }
    await pg.close();
  }

  /* ==================================================================
   * 附 · `P-13` 多层 shadow **已知边界见证**（**预期为红** · 单列 · **不计入主判据与退出码**）
   * ==================================================================
   * 边界（`C-72` 单内已登记、**方案 B 未实施**）：`C-72` 的宿主判据只作用于**被处理的那个
   * root 的宿主**。而 `findRoots(document)` 会**独立发现并入队「内层」root**（它自己就是一个
   * open shadow root）⇒ 内层宿主若**不带任何标记** ⇒ 处理它时**不会命中跳过判据** ⇒
   * 「**外层**宿主写 `translate="no"` / `data-ct-skip`」**屏蔽不了其 shadow 内的内层 shadow 内容**。
   * ⇒ 本段**如实暴露**该边界：**断言内层译文 = 0**，**当前预期为红**（= 漏洞存在）。
   * 【它是见证断言、不是回归断言】底色是"已知边界存在"，**不得**因它红而改产品；
   *   修它需要"判据上溯 `r.host.getRootNode().host`"（**方案 B**）—— 主理人已选"**先只加夹具
   *   断言**"，故本探针**不实施**方案 B。
   * 【口径】本段**不并进 `results`** ⇒ **主判据口径保持 19/19、退出码不变**；本段另计并单列打印。
   * ================================================================== */
  const WITNESS = [];
  function wcheck(name, ok, detail) {
    WITNESS.push({ name, ok: !!ok });
    console.log((ok ? '  \u2713 ' : '  \u2717 ') + name + (detail !== undefined ? '  :: ' + detail : ''));
  }
  console.log('\n附 · P-13 多层 shadow 已知边界见证（**预期红** · 单列 · 不计入主判据与退出码）');
  {
    const pm = await ctx.newPage();
    await pm.goto(BASE + '/multi', { waitUntil: 'domcontentloaded' });
    await pm.waitForTimeout(3400);
    const m = await pm.evaluate(() => {
      const outer = document.getElementById('outer');
      const osr = outer && outer.shadowRoot;
      const inner = osr && osr.getElementById('inner');
      const isr = inner && inner.shadowRoot;
      return {
        lightTrans: document.querySelectorAll('body .ct-trans').length,
        outerTrans: osr ? osr.querySelectorAll('.ct-trans').length : -1,
        innerTrans: isr ? isr.querySelectorAll('.ct-trans').length : -1,
        innerParas: isr ? isr.querySelectorAll('p').length : -1,
        outerSkipAttr: outer ? outer.getAttribute('data-ct-skip') : null,
        innerSkipAttr: inner ? inner.getAttribute('data-ct-skip') : null
      };
    });
    console.log('  P-13 观测 = ' + JSON.stringify(m));
    wcheck('P-13·前置 sanity：light DOM 已译（管线在跑，非空转）', m.lightTrans > 0, 'lightTrans=' + m.lightTrans);
    wcheck('P-13·前置：外层确实带标记、内层**不带任何标记**（夹具口径在位）',
      m.outerSkipAttr === 'page' && m.innerSkipAttr === null,
      'outer=' + JSON.stringify(m.outerSkipAttr) + ' inner=' + JSON.stringify(m.innerSkipAttr));
    wcheck('P-13 见证：外层带标记时**内层**（无标记）shadow 内容**仍被翻译** ⇒ 已知边界存在（**预期红**）',
      m.innerTrans === 0,
      'innerTrans=' + m.innerTrans + ' / 内层段落=' + m.innerParas
        + ' / 外层 shadow 内译文=' + m.outerTrans + '（外层应被跳过 ⇒ 期望 0）');
    wcheck('P-13 伴证：**外层** shadow 自身内容确被跳过（译文 = 0 ⇒ C-72 判据在外层生效）',
      m.outerTrans === 0, 'outerTrans=' + m.outerTrans);
    await pm.close();
  }

  const pass = results.every((r) => r.ok);
  console.log('\n主判据：' + (pass ? 'PASS' : 'FAIL') + '（'
    + results.filter((r) => r.ok).length + '/' + results.length + '）');
  console.log('附·P-13 见证段（**不计入主判据与退出码**）：'
    + WITNESS.filter((w) => w.ok).length + '/' + WITNESS.length
    + ' —— 其中"预期红"项为**已知边界存在**的证据，非回归');
  console.log('引擎 batch 总数 = ' + engineBatches);
  process.exitCode = pass ? 0 : 1;
} finally {
  await ctx.close().catch(() => {});
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
