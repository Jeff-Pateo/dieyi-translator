/*
 * 取证探针 · 「无需翻译」悬浮开关在页面上出现多次（C-28 归因）
 * ==================================================================
 * 用户截图：同一屏里出现 5–6 个「[中] 无需翻译」胶囊，纵向堆叠、x 位置一致。
 * 三个候选机制，一次探针全部量出来：
 *
 *   T1  frame 泄漏   —— manifest 是 all_frames:true，每个 iframe 都会跑 content.js。
 *                       如果 isTop() 判错，每个 iframe 都会挂一颗胶囊。
 *                       夹具：6 个同源 iframe 纵向堆叠（每个都有足够正文）。
 *   T2  重复注入     —— 同一 frame 被注入两次（右键兜底 / 更新补注入 / popup 兜底）。
 *                       守卫应为「同版本且存活 → skip」，DOM 里应恒为 1 颗。
 *                       做法：从 service worker 用 chrome.scripting.executeScript
 *                       把 manifest 的 js 列表原样再注入一遍。
 *   T3  多实例外观   —— 若真出现多颗胶囊，它们是**重叠**（看起来像一颗）还是
 *                       **错位堆叠**（看起来像截图那样一串）？
 *                       avoidClash() 在角落被占时会 +56px 上移，所以这个问题的
 *                       答案决定截图能不能由「多实例」解释。
 *                       做法：在主世界反复加载 toggle.js 并 mount，量每颗的 y。
 *
 * 运行：NODE_PATH=<node_modules> node tools/probe-toggle-dup.mjs
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

const FILLER = ('The quick brown fox jumps over the lazy dog. ' +
  'Remote work has changed how teams collaborate across time zones, ' +
  'and product managers now spend more time writing than meeting. ').repeat(3);

const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const CS_FILES = manifest.content_scripts[0].js;

/* ---------------- 夹具站（本地 HTTP：matches 生效 + 同源 iframe） ---------------- */
/* 中文页 —— 用于验证「无需翻译」态是否照样把控件常驻在页面上 */
const ZH_TEXT = ('这是一篇中文文章，用来验证扩展在「本来就不需要翻译」的页面上'
  + '会怎么处理页内开关。它应该自己收起来，而不是在角落里常驻一个点了没反应的按钮。').repeat(6);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (url.pathname === '/frame') {
    res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>frame</title>
<style>body{margin:0;padding:12px;font:14px/1.6 system-ui;background:#fff}</style></head>
<body><h3>Embedded section</h3><p>${FILLER}</p></body></html>`);
    return;
  }
  if (url.pathname === '/zh') {
    res.end(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>中文页面</title>
<style>body{margin:0;padding:16px;font:14px/1.8 system-ui;background:#fff}</style></head>
<body><h1>无需翻译的页面</h1><p>${ZH_TEXT}</p></body></html>`);
    return;
  }
  const frames = Array.from({ length: 6 }, (_, i) =>
    `<iframe src="/frame" width="360" height="300" style="display:block;border:1px solid #ddd"></iframe>`
  ).join('\n');
  res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>multi-frame fixture</title>
<style>body{margin:0;padding:16px;font:14px/1.6 system-ui;background:#fff}
iframe{margin-bottom:8px}</style></head>
<body><h1>Frame leak fixture</h1><p>${FILLER}</p>${frames}</body></html>`);
});

await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:' + server.address().port;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-dup-'));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' :: ' + detail : ''));
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
  /* 等 service worker 起来（拿 tabId 用） */
  let sw = ctx.serviceWorkers()[0];
  for (let i = 0; i < 40 && !sw; i++) {
    await new Promise(r => setTimeout(r, 250));
    sw = ctx.serviceWorkers()[0];
  }
  if (!sw) throw new Error('未拿到扩展 service worker');
  const extId = new URL(sw.url()).host;

  const page = await ctx.newPage();
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.waitForSelector('.ct-toggle', { timeout: 15000 }).catch(() => {});

  /** 数清「每个 frame 里有几颗胶囊」，并回读它是否自认顶层 */
  async function survey(tag) {
    const rows = [];
    for (const f of page.frames()) {
      const info = await f.evaluate(() => {
        const hosts = Array.from(document.querySelectorAll('.ct-toggle'));
        let top = null;
        try { top = (window.top === window); } catch (e) { top = 'throw'; }
        return {
          href: location.href,
          isTop: top,
          count: hosts.length,
          // 每颗的视口坐标，用来判断「重叠」还是「堆叠」
          tops: hosts.map(h => Math.round(h.getBoundingClientRect().top)),
          lefts: hosts.map(h => Math.round(h.getBoundingClientRect().left)),
          label: (function () {
            const h = hosts[0];
            if (!h || !h.shadowRoot) return null;
            const lb = h.shadowRoot.querySelector('.label');
            return lb ? lb.textContent : null;
          })()
        };
      }).catch(() => null);
      if (info) rows.push(info);
    }
    console.log('\n  [' + tag + '] frame 巡检（共 ' + rows.length + ' 个 frame）');
    for (const r of rows) {
      const short = r.href.replace(BASE, '');
      console.log('    ' + (r.isTop === true ? 'TOP ' : 'sub ') + short
        + '  胶囊=' + r.count + '  y=[' + r.tops.join(',') + ']  x=[' + r.lefts.join(',') + ']'
        + (r.label ? '  文案=' + r.label : ''));
    }
    return rows;
  }

  /* ================= T1：frame 泄漏 ================= */
  console.log('\n━━━ T1 · frame 泄漏（all_frames:true + isTop 护栏）');
  const t1 = await survey('T1 初始');
  const subWithToggle = t1.filter(r => r.isTop !== true && r.count > 0);
  const topWithToggle = t1.filter(r => r.isTop === true && r.count > 0);
  console.log('  → 顶层有胶囊的 frame 数 = ' + topWithToggle.length
    + '；非顶层有胶囊的 frame 数 = ' + subWithToggle.length);

  /* ================= T2：重复注入幂等 ================= */
  console.log('\n━━━ T2 · 重复注入幂等（从 SW 用 chrome.scripting 再注入一遍）');
  const tabId = await sw.evaluate(async () => {
    const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
    return t ? t.id : null;
  });
  console.log('  tabId = ' + tabId);
  const injectRes = await sw.evaluate(async ({ files, tabId }) => {
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files });
      return { ok: true };
    } catch (e) { return { ok: false, err: String(e) }; }
  }, { files: CS_FILES, tabId });
  console.log('  再注入结果：' + JSON.stringify(injectRes));
  await page.waitForTimeout(1800);
  const t2 = await survey('T2 再注入后');

  /* ================= T3：多实例是重叠还是堆叠 ================= */
  console.log('\n━━━ T3 · 多实例外观（主世界反复挂载，量真实坐标）');
  await page.addScriptTag({ path: path.join(EXT, 'shared/constants.js') });
  const positions = [];
  for (let i = 0; i < 3; i++) {
    await page.addScriptTag({ path: path.join(EXT, 'content/toggle.js') });
    const pos = await page.evaluate(() => {
      try {
        const h = window.CT.toggle.mount({ mark: '中' });
        const r = h.host.getBoundingClientRect();
        return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) };
      } catch (e) { return { err: String(e) }; }
    });
    positions.push(pos);
    console.log('    第 ' + (i + 1) + ' 次 mount → ' + JSON.stringify(pos));
  }
  const t3count = await page.evaluate(() => document.querySelectorAll('.ct-toggle').length);
  console.log('  页面上 .ct-toggle 总数 = ' + t3count);

  /* ================= T4：「隐藏这个按钮」是否持久 ================= */
  console.log('\n━━━ T4 · 「隐藏这个按钮」的持久性（点完隐藏，刷新后会不会又回来）');
  /* 用**全新页面**跑，避免 T3 在主世界挂的那几颗污染断言（strict mode 会命中多个） */
  const p4 = await ctx.newPage();
  await p4.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await p4.waitForTimeout(2800);
  await p4.waitForSelector('.ct-toggle', { timeout: 15000 }).catch(() => {});
  // 首次引导气泡会挡住点击，先点掉
  await p4.locator('.ct-toggle .cbtn--ok').click({ timeout: 3000 }).catch(() => {});
  await p4.waitForTimeout(400);

  const beforeHide = await p4.evaluate(() => document.querySelectorAll('.ct-toggle').length);
  let hideErr = null;
  try {
    await p4.locator('.ct-toggle .tool--more').click({ timeout: 5000 });
    await p4.locator('.ct-toggle .menu__i--hide').click({ timeout: 5000 });
  } catch (e) { hideErr = String(e).slice(0, 140); }
  await p4.waitForTimeout(800);
  const afterHide = await p4.evaluate(() => document.querySelectorAll('.ct-toggle').length);
  console.log('  点「隐藏这个按钮（本页）」：' + beforeHide + ' 颗 → ' + afterHide + ' 颗'
    + (hideErr ? '  （点击异常：' + hideErr + '）' : ''));

  await p4.reload({ waitUntil: 'domcontentloaded' });
  await p4.waitForTimeout(2800);
  const reloadInfo = await p4.evaluate(() => {
    const hosts = Array.from(document.querySelectorAll('.ct-toggle'));
    const h = hosts[0];
    const lb = h && h.shadowRoot && h.shadowRoot.querySelector('.label');
    return { count: hosts.length, status: h ? h.getAttribute('data-status') : null,
      label: lb ? lb.textContent : null };
  });
  console.log('  刷新页面后：' + reloadInfo.count + ' 颗  data-status='
    + reloadInfo.status + '  文案=' + JSON.stringify(reloadInfo.label));

  /* ---- T4b：持久出口「所有网站都不显示」---- */
  const p4b = await ctx.newPage();
  await p4b.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await p4b.waitForTimeout(2800);
  await p4b.waitForSelector('.ct-toggle', { timeout: 15000 }).catch(() => {});
  await p4b.locator('.ct-toggle .cbtn--ok').click({ timeout: 3000 }).catch(() => {});
  await p4b.waitForTimeout(300);
  let hideAllErr = null;
  try {
    await p4b.locator('.ct-toggle .tool--more').click({ timeout: 5000 });
    await p4b.locator('.ct-toggle .menu__i--hideAll').click({ timeout: 5000 });
  } catch (e) { hideAllErr = String(e).slice(0, 140); }
  await p4b.waitForTimeout(1200);
  const hideAllNow = await p4b.evaluate(() => document.querySelectorAll('.ct-toggle').length);
  await p4b.reload({ waitUntil: 'domcontentloaded' });
  await p4b.waitForTimeout(3000);
  const hideAllAfterReload = await p4b.evaluate(() => document.querySelectorAll('.ct-toggle').length);
  const persisted = await p4b.evaluate(async () => {
    const o = await new Promise(r => { try { chrome.storage.local.get('ctSettings', r); } catch (e) { r({}); } });
    return null;   // 隔离世界里读不到，仅用于不抛错
  }).catch(() => null);
  console.log('  点「所有网站都不显示」：' + hideAllNow + ' 颗；刷新后 ' + hideAllAfterReload + ' 颗'
    + (hideAllErr ? '  （点击异常：' + hideAllErr + '）' : ''));
  void persisted;

  /* ================= T5：「无需翻译」页面上控件是否仍常驻 ================= */
  console.log('\n━━━ T5 · 「无需翻译」的页面上，控件是否仍然常驻（用户截图里的那种）');
  const zh = await ctx.newPage();
  await zh.setViewportSize({ width: 240, height: 480 });   // 贴近截图的窄视口
  await zh.goto(BASE + '/zh', { waitUntil: 'domcontentloaded' });
  await zh.waitForTimeout(3000);
  const zhInfo = await zh.evaluate(() => {
    const hosts = Array.from(document.querySelectorAll('.ct-toggle'));
    const hadSkipNode = !!document.body.querySelector('div[data-ct-skip]');
    const h = hosts[0];
    if (!h) return { count: 0, hadSkipNode };
    const b = h.getBoundingClientRect();
    const lb = h.shadowRoot && h.shadowRoot.querySelector('.label');
    return {
      count: hosts.length,
      hadSkipNode,
      status: h.getAttribute('data-status'),
      label: lb ? lb.textContent : null,
      box: { top: Math.round(b.top), left: Math.round(b.left),
        w: Math.round(b.width), h: Math.round(b.height) },
      relRight: Math.round(window.innerWidth - b.right),
      relBottom: Math.round(window.innerHeight - b.bottom),
      vw: window.innerWidth, vh: window.innerHeight
    };
  });
  console.log('  中文页（240×480）：胶囊数=' + zhInfo.count
    + '  data-status=' + zhInfo.status
    + '  文案=' + JSON.stringify(zhInfo.label));
  console.log('  胶囊矩形=' + JSON.stringify(zhInfo.box)
    + '  距右 ' + zhInfo.relRight + 'px 距底 ' + zhInfo.relBottom + 'px');

  /* ================= 判定 ================= */
  console.log('\n────────────────────────────────────────────────────');
  const t1Max = Math.max(0, ...t1.map(r => r.count));
  check('T1：单个 frame 内胶囊数不超过 1（挂载点幂等）', t1Max <= 1, '最大 ' + t1Max);
  check('T1：非顶层 frame 一律不挂胶囊（isTop 护栏有效）',
    subWithToggle.length === 0,
    subWithToggle.length ? JSON.stringify(subWithToggle.map(r => r.href)) : '0 个');
  check('T1：顶层恰好 1 颗胶囊', topWithToggle.length === 1 && topWithToggle[0].count === 1,
    topWithToggle.length ? 'count=' + topWithToggle[0].count : '无');

  const t2Max = Math.max(0, ...t2.map(r => r.count));
  check('T2：再注入后胶囊数不变（守卫 skip 生效）', t2Max <= 1, '最大 ' + t2Max);
  const t2Total = t2.reduce((a, r) => a + r.count, 0);
  check('T2：全页胶囊总数仍为 1', t2Total === 1, '总数 ' + t2Total);

  const okPos = positions.filter(p => !p.err);
  check('T3：多实例可被真实挂载（若这里挂不上，则重复出现另有来源）',
    okPos.length === 3, JSON.stringify(positions));
  if (okPos.length >= 2) {
    const tops = okPos.map(p => p.top);
    const distinct = new Set(tops).size;
    const overlaps = distinct === 1;
    console.log('    三次挂载的 y = [' + tops.join(', ') + ']  去重后 ' + distinct + ' 个位置');
    /* 这条断言是**诊断结论**，不是缺陷：多实例会精确重叠，因为冲突避让
     * （avoidClash → elementFromPoint）命中自身一律视为「角落空闲」，
     * 自己从不避让自己。因此「同屏一串胶囊」不可能由多实例产生 ——
     * 截图里那一串是同一颗控件在多次到访/多页面反复出现（见 T4/T5）。 */
    check('T3：多实例精确重叠（故「同屏一串」不可能来自重复实例 —— 诊断成立）',
      overlaps, overlaps ? '完全重叠' : '却错开了 ' + distinct + ' 个位置（结论需重审）');
  }

  /* ---- T4/T5 是修复验收：✓ 表示实测到了期望行为 ---- */
  console.log('\n  【C-28 修复验收】（✓ = 实测到期望行为）');
  check('T4a：点「隐藏这个按钮（本页）」→ 胶囊立刻消失', afterHide === 0,
    beforeHide + ' → ' + afterHide);
  check('T4a：本页隐藏**本来就不该跨刷新**（语义就是「这一页别挡着我」），'
    + '刷新后回来 1 颗是设计使然 —— 所以持久意图必须另给出口',
    reloadInfo.count === 1, reloadInfo.count + ' 颗');
  check('T4b：点「所有网站都不显示」→ 胶囊消失', hideAllNow === 0, hideAllNow + ' 颗');
  check('T4b：★ 刷新后**不再回来**（持久出口生效）', hideAllAfterReload === 0,
    hideAllAfterReload + ' 颗');
  check('T5：★ 中文页（本来无需翻译）上不再常驻胶囊（截图现象消除）',
    zhInfo.count === 0, 'count=' + zhInfo.count + ' label=' + JSON.stringify(zhInfo.label));
  check('T5：★ 该页 body 里也没有留下装饰性残留',
    zhInfo.count === 0 && !zhInfo.hadSkipNode,
    'skipNode=' + zhInfo.hadSkipNode);
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter(r => !r.ok);
console.log('────────────────────────────────────────────────────');
if (failed.length) {
  console.log('异常 ' + failed.length + ' 项 / 共 ' + results.length + ' 项');
} else {
  console.log('全部符合预期：' + results.length + ' 项');
}
