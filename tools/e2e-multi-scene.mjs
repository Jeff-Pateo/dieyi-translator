/*
 * 端到端验证 · 多场景翻译质量（v1.7.4，C-14/C-15）
 * ==================================================================
 * 覆盖用户验收要求：
 *   1. 多场景：新闻站 / 技术文档站 / 购物站 三类页面均能正常翻译；
 *   2. 翻译成功率 ≥ 90%（口径：badge「已译 N 段（M 段失败）」→ N/(N+M)）；
 *   3. 纠错闭环（C-13 Q3）：悬停「改」→ 行内修正 → 屏上立即替换 →
 *      落库 → 重新翻译时用户译文直接出场（引擎不再收到该句）。
 *
 * 引擎与页面：本地 HTTP 服务同时扮演 mock 翻译引擎（OpenAI 兼容协议）
 * 与三个场景夹具站 —— 全程不出网，失败只可能来自扩展本身。
 *
 * 运行：node tools/e2e-multi-scene.mjs
 * 依赖：playwright-core（NODE_PATH 指向托管工作区）+ Chrome for Testing
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
// 品牌版 Chrome 137+ 禁用了 --load-extension；必须用 Chrome for Testing 构建。
const CHROME = process.env.CT_E2E_CHROME
  || 'C:/Users/Administrator/.workbuddy/binaries/cft/chrome-win64/chrome.exe';
const OUT_DIR = path.join(ROOT, 'tools', 'bench-results');

const results = [];
function ok(label, cond, extra) {
  results.push({ label, pass: !!cond, extra: extra === undefined ? '' : String(extra) });
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (extra !== undefined ? '  → ' + extra : ''));
}

/* ------------------------------------------------------------------
 * 场景夹具（HTML）。每页刻意混入导航、标题、段落、按钮、列表 ——
 * 覆盖真实站点里最常见的单元形态。
 * ------------------------------------------------------------------ */
const CORRECT_SENTENCE = 'This headline is wrong.';

function newsPage() {
  const paras = [];
  for (let i = 1; i <= 28; i++) {
    paras.push('<p>The newsroom published report number ' + i
      + ' about the ongoing climate summit today.</p>');
  }
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>Daily Gazette News</title></head><body>
<nav><a>Home</a><a>World</a><a>Business</a><a>Science</a><a>Contact</a></nav>
<h1>Breaking headlines from the summit</h1>
<article>
  <h2>Editorial desk</h2>
  <p id="fixme">${CORRECT_SENTENCE}</p>
  ${paras.join('\n  ')}
  <h2>Market wrap</h2>
  <p>Markets closed higher as investors awaited the central bank decision.</p>
  <p>Reporters confirmed that delegates reached a tentative agreement late yesterday.</p>
</article>
<footer><a>About us</a><a>Privacy policy</a><a>Terms of service</a></footer>
</body></html>`;
}

function techPage() {
  const steps = [];
  for (let i = 1; i <= 24; i++) {
    steps.push('<li>Step ' + i + ': configure the router and restart the local development server.</li>');
  }
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>DevDocs Handbook</title></head><body>
<nav><a>Guides</a><a>Reference</a><a>Examples</a><a>Blog</a></nav>
<h1>Getting started with the framework</h1>
<p>This guide walks you through installation, configuration and deployment.</p>
<h2>Installation</h2>
<p>Run the bootstrap script inside your project directory to install dependencies.</p>
<ol>
  ${steps.join('\n  ')}
</ol>
<h2>Troubleshooting</h2>
<p>If the compiler complains about missing peer dependencies, clear the cache first.</p>
<p>Community support is available on the forum every weekday afternoon.</p>
<button>Download the CLI</button><button>Open the playground</button>
</body></html>`;
}

function shopPage() {
  const cards = [];
  const names = ['Wireless earbuds', 'Ceramic coffee mug', 'Trail running backpack',
    'Bamboo cutting board', 'LED desk lamp', 'Stainless water bottle'];
  for (let i = 0; i < 6; i++) {
    cards.push(`<div class="card">
  <h3>${names[i]}</h3>
  <p>Lightweight design with a two year warranty and free returns.</p>
  <span class="lbl">Price</span><button>Add to cart</button><button>See details</button>
</div>`);
  }
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>BrightMall Store</title></head><body>
<nav><a>Deals</a><a>New arrivals</a><a>Best sellers</a><a>Gift cards</a><a>Help center</a></nav>
<h1>Spring collection</h1>
<p>Free shipping on every order placed this week.</p>
<div class="grid">
  ${cards.join('\n')}
</div>
<footer><a>Shipping policy</a><a>Returns</a><a>Contact support</a></footer>
</body></html>`;
}

/* ------------------------------------------------------------------
 * 本地服务：/v1/chat/completions = mock 引擎；/news /tech /shop = 夹具。
 * 引擎把每条原文译成「【译】原文」，并按原文计数 —— 供纠错断言用。
 * ------------------------------------------------------------------ */
const engineHits = new Map();      // 原文 → 收到的次数
function startServer() {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const user = payload.messages[payload.messages.length - 1].content;
          const arr = JSON.parse(user);
          const texts = arr.map((x) => (typeof x === 'string' ? x : x.s));
          for (const t of texts) engineHits.set(t, (engineHits.get(t) || 0) + 1);
          const t = texts.map((s) => '【译】' + s);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'mock', object: 'chat.completion', created: 1, model: 'mock',
            choices: [{
              index: 0, finish_reason: 'stop',
              message: { role: 'assistant', content: JSON.stringify({ t: t }) }
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
    const pages = { '/news': newsPage(), '/tech': techPage(), '/shop': shopPage() };
    if (pages[url]) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(pages[url]);
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** 等一轮翻译收尾：badge 出现「已译 …」终态 */
async function waitDone(page, timeout) {
  await page.waitForFunction(() => {
    
    const b = document.querySelector('.ct-badge__text');

          const host = document.querySelector('.ct-toggle');

          const lb = host && host.shadowRoot && host.shadowRoot.querySelector('.label');

          const t = (b && b.textContent) || (lb && lb.textContent) || '';

          return /已译|翻译失败/.test(t);
  }, { timeout: timeout || 60000 });
  await page.waitForTimeout(800);
}

/** 读取成功率：badge「已译 N 段（M 段失败）」→ N/(N+M) */
async function successRate(page) {
  return page.evaluate(() => {
    const b = document.querySelector('.ct-badge__text');
    const t = b ? b.textContent : '';
    const m = t.match(/已译 (\d+) 段（(\d+) 段失败）/) || t.match(/已译 (\d+) 段/);
    if (!m) return { done: 0, failed: 0, rate: 0, text: t };
    const done = Number(m[1]);
    const failed = m[2] ? Number(m[2]) : 0;
    return { done, failed, rate: (done + failed) ? done / (done + failed) : 0, text: t };
  });
}

/* ================================================================== */

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-e2e-ms-'));
fs.mkdirSync(OUT_DIR, { recursive: true });
const server = await startServer();
const port = server.address().port;
const base = 'http://127.0.0.1:' + port;
console.log('本地 mock 引擎 + 夹具站已就绪：' + base);

console.log('启动 Chrome（加载扩展）…');
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  executablePath: CHROME,
  viewport: { width: 1400, height: 900 },
  args: [
    '--disable-extensions-except=' + EXT,
    '--load-extension=' + EXT,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1400,900'
  ]
});

async function translatePage(page, name) {
  await page.goto(base + '/' + name, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('.ct-toggle', { timeout: 20000 });
  const guideBtn = page.locator('.ct-toggle .cbtn--ok');
  if (await guideBtn.count() > 0 && await guideBtn.first().isVisible().catch(() => false)) {
    await guideBtn.first().click();
    await page.waitForTimeout(300);
  }
  await page.locator('.ct-toggle button.main').click();
  await waitDone(page);
}

try {
  /* 0. 扩展就绪 + 引擎指向 mock；关缓存保证第二轮断言干净 */
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    sw = ctx.serviceWorkers().find((w) => w.url().includes('service-worker.js'))
      || ctx.backgroundPages().find((w) => w.url().includes('service-worker.js'));
    if (!sw) await new Promise((r) => setTimeout(r, 250));
  }
  ok('扩展已加载（service worker 存活）', !!sw, sw ? sw.url() : '未找到');
  if (!sw) throw new Error('扩展未加载，无法继续');

  const extId = sw.url().split('/')[2];
  const optPage = await ctx.newPage();
  await optPage.goto('chrome-extension://' + extId + '/options/options.html',
    { waitUntil: 'domcontentloaded', timeout: 30000 });
  const setRes = await optPage.evaluate((patch) => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'ct:set-settings', patch: patch },
      (r) => resolve(r && r.settings ? r.settings : r));
  }), {
    provider: 'openai',
    openaiBaseUrl: base + '/v1',
    openaiApiKey: 'e2e-mock-key',
    openaiModel: 'mock',
    autoTranslate: false,
    cacheEnabled: false,
    selectionEnabled: false
  });
  ok('设置已写入（provider=openai → 本地 mock，缓存关闭）', !!setRes && setRes.provider === 'openai',
    JSON.stringify({ provider: setRes && setRes.provider }));
  await optPage.close();

  const page = ctx.pages().find((p) => !p.url().startsWith('chrome-extension'))
    || (await ctx.newPage());

  /* 1. 三个场景：正常翻译 + 成功率 ≥ 90% */
  const scenarios = [
    ['news', '新闻站'], ['tech', '技术文档站'], ['shop', '购物站']
  ];
  const rates = {};
  for (const [name, label] of scenarios) {
    console.log('\n—— 场景：' + label + ' ——');
    await translatePage(page, name);
    const s = await successRate(page);
    rates[name] = s;
    ok(label + '翻译完成（已译 ' + s.done + ' 段，失败 ' + s.failed + '）', s.done > 0, s.text);
    ok(label + '成功率 ≥ 90%（实际 ' + Math.round(s.rate * 1000) / 10 + '%）', s.rate >= 0.9,
      s.text);
    const transCount = await page.evaluate(() => document.querySelectorAll('.ct-trans').length);
    ok(label + '译文节点已上屏', transCount > 0, transCount + ' 条');
    const zh = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('.ct-trans')).slice(0, 5);
      return nodes.every((n) => /[\u4e00-\u9fff]/.test(n.textContent));
    });
    ok(label + '译文确实是中文', zh);
    await page.screenshot({ path: path.join(OUT_DIR, 'e2e-scene-' + name + '.png') });
  }

  /* 2. 纠错闭环（C-13 Q3）：回到新闻页翻译后，修正那句话 */
  console.log('\n—— 纠错闭环 ——');

  // 上一个场景停在购物站 —— 先回新闻页重新翻译，让目标句子出现在屏上。
  // 这次翻译发生在纠错之前，引擎收到该句是预期行为 —— 因此基线在它之后取。
  await translatePage(page, 'news');
  const wrongBefore = engineHits.get(CORRECT_SENTENCE) || 0;
  ok('第一轮：引擎确实收到过那句原文', wrongBefore >= 1, String(wrongBefore));

  // 悬停宿主 → 「改」入口出现
  const hostSel = '#fixme';
  await page.hover(hostSel);
  await page.waitForSelector('.ct-corr-chip', { timeout: 5000 });
  ok('悬停译文后出现「改」入口', true);
  await page.click('.ct-corr-chip');
  await page.waitForSelector('.ct-corr-editor', { timeout: 5000 });
  ok('点击后行内编辑器打开', true);
  ok('编辑器预填当前译文',
    (await page.inputValue('.ct-corr-ta')).indexOf('【译】' + CORRECT_SENTENCE) === 0,
    await page.inputValue('.ct-corr-ta'));

  const CORRECTED = '这条标题由用户修正。';
  await page.fill('.ct-corr-ta', CORRECTED);
  await page.click('.ct-corr-ok');
  await page.waitForSelector('.ct-corr-editor', { state: 'detached', timeout: 5000 })
    .catch(() => {});
  await page.waitForTimeout(500);
  const fixedText = await page.evaluate((sel) => {
    const host = document.querySelector(sel);
    const t = host.querySelector('.ct-trans');
    return t ? t.textContent.trim() : '';
  }, hostSel);
  ok('屏上译文立即替换为用户修正', fixedText === CORRECTED, JSON.stringify(fixedText));

  // 落库核验
  const optPage2 = await ctx.newPage();
  await optPage2.goto('chrome-extension://' + extId + '/options/options.html',
    { waitUntil: 'domcontentloaded', timeout: 30000 });
  const saved = await optPage2.evaluate((from) => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'ct:get-settings' }, (r) => {
      const list = (r && r.settings && r.settings.corrections) || [];
      resolve(list.find((x) => x.from === from) || null);
    });
  }), CORRECT_SENTENCE);
  ok('修正已写入 settings.corrections（整句精确匹配）',
    !!saved && saved.to === CORRECTED, JSON.stringify(saved));
  await optPage2.close();

  // 第二轮：重开新闻页翻译 → 用户译文出场，引擎不再收到该句
  await page.goto('about:blank');
  await translatePage(page, 'news');
  const fixedText2 = await page.evaluate((sel) => {
    const host = document.querySelector(sel);
    const t = host.querySelector('.ct-trans');
    return t ? t.textContent.trim() : '';
  }, hostSel);
  ok('重新翻译后用户修正仍然生效', fixedText2 === CORRECTED, JSON.stringify(fixedText2));
  const wrongAfter = engineHits.get(CORRECT_SENTENCE) || 0;
  ok('纠错短路生效：引擎没有再收到该句（' + wrongBefore + ' → ' + wrongAfter + '）',
    wrongAfter === wrongBefore, String(wrongAfter));

  await page.screenshot({ path: path.join(OUT_DIR, 'e2e-scene-corrected.png') });
} finally {
  await ctx.close().catch(() => {});
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

console.log('\n────────────────────────────────');
const fails = results.filter((r) => !r.pass);
for (const f of fails) console.log('  ✗ ' + f.label);
if (fails.length) {
  console.log('通过 ' + (results.length - fails.length) + ' 项，失败 ' + fails.length + ' 项');
  process.exit(1);
}
console.log('全部通过：' + results.length + ' 项断言 —— 三场景成功率 ≥ 90%，纠错闭环端到端可用');
