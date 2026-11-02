/*
 * 体验官评测 · 双语助手 v1.7.4（用户视角，非代码视角）
 * ==================================================================
 * 以「第一次使用的用户」路径走完 E1-E7，每一项输出：
 *   观察事实（操作步骤 + 实测数值）→ 体验评价（好/一般/差）→ 问题严重级
 *
 * 定位：体验官的职责是发现问题，不是让断言全绿 —— 断言失败会进入
 * 问题清单（UX-xx），但脚本本身必须无异常跑完。
 *
 * 基建复用 tools/e2e-multi-scene.mjs：
 *   本地 HTTP 服务 = mock 翻译引擎（OpenAI 兼容批量协议）+ 三场景夹具站；
 *   Chrome for Testing + --load-extension；ct:set-settings 注入设置。
 *
 * 运行：node tools/e2e-experience-review.mjs
 * 依赖：playwright-core（NODE_PATH 指向托管工作区）
 * 截图：tools/experience-shots/
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
const OUT_DIR = path.join(ROOT, 'tools', 'experience-shots');

/* ------------------------------------------------------------------
 * 结果收集：observations 是唯一出口，最后统一打印判定
 * ------------------------------------------------------------------ */
const issues = [];   // { id, item, severity, desc, evidence }
let uxSeq = 0;
function issue(item, severity, desc, evidence) {
  uxSeq++;
  const id = 'UX-' + String(uxSeq).padStart(2, '0');
  issues.push({ id, item, severity, desc, evidence });
  console.log('  ⚠ ' + id + ' [' + severity + '] ' + desc);
}

function section(title) {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('◆ ' + title);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}
function fact(text) { console.log('  · ' + text); }
function verdict(item, grade, why) {
  console.log('  【' + item + ' 体验评价：' + grade + '】' + why);
}

/* ------------------------------------------------------------------
 * 场景夹具：与 e2e-multi-scene 相同的三站
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

/* mock 引擎：译文 = 「【译】原文」，并按原文计数（供 E6 短路核验） */
const engineHits = new Map();
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

/* ------------------------------------------------------------------
 * 页内工具
 * ------------------------------------------------------------------ */
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

/** 打开页面、等开关就绪（不点主按钮） */
async function openPage(page, name) {
  await page.goto(base + '/' + name, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('.ct-toggle', { timeout: 20000 });
  await page.waitForTimeout(400);
}

/** 点主按钮并计时到 badge 终态；返回 { ms, busyTexts, finalBadge, progressSources, dupProgress }
 *  C-43（2026-09-29）：进度**单一来源** —— 开关展开在场时「翻译中 i/n」
 *  显示在页内开关（shadow .label，light-DOM querySelector 穿不进去），
 *  徽标让位；终态（已译/失败）始终在徽标。这里两处都读，
 *  并记录来源集合：同一时刻两处都出现进度 = 缺陷复现。 */
const BUSY_RE = /翻译中|^\d+ \/ \d+$/;
async function clickTranslateAndTime(page) {
  const busyTexts = new Set();
  const progressSources = new Set();
  let dupProgress = false;
  await page.locator('.ct-toggle button.main').click();
  const t0 = Date.now();
  // 100ms 轮询：badge 文案 + 开关 shadow 标签，抓「翻译中 i / n」的过程感知
  while (Date.now() - t0 < 60000) {
    const r = await page.evaluate(() => {
      const b = document.querySelector('.ct-badge__text');
      const host = document.querySelector('.ct-toggle');
      const sr = host && host.shadowRoot;
      const lb = sr && sr.querySelector('.label');
      return {
        badge: ((b && b.textContent) || '').trim(),
        toggle: ((lb && lb.textContent) || '').trim()
      };
    });
    const onBadge = BUSY_RE.test(r.badge);
    const onToggle = BUSY_RE.test(r.toggle);
    if (onBadge) { busyTexts.add(r.badge); progressSources.add('徽标'); }
    if (onToggle) { busyTexts.add(r.toggle); progressSources.add('开关'); }
    if (onBadge && onToggle) dupProgress = true;
    // C-44：终态可能在开关（展开在场闪现）也可能在徽标（回退面）
    const done = /已译|翻译失败/.test(r.badge) || /已译|翻译失败/.test(r.toggle);
    if (done) {
      return { ms: Date.now() - t0, busyTexts: [...busyTexts], finalBadge: r.badge || r.toggle,
        progressSources: [...progressSources], dupProgress };
    }
    await page.waitForTimeout(100);
  }
  return { ms: -1, busyTexts: [...busyTexts], finalBadge: '超时',
    progressSources: [...progressSources], dupProgress };
}

/** 悬停某个宿主段落，等「改」chip 出现；返回延迟 ms（超时返回 -1）。
 *  延迟用页面内 rAF 计时（mouseover → class 添加），排除 Playwright
 *  hover 的可操作性检查开销；鼠标直接 mouse.move 到宿主中心。 */
async function hoverForChip(page, sel, timeout) {
  await page.evaluate(() => {
    window.__tMove = null;
    window.__chipAt = null;
    const tick = () => {
      const chip = document.querySelector('.ct-corr-chip');
      if (chip && chip.classList.contains('ct-corr-on') && window.__chipAt === null) {
        window.__chipAt = performance.now();
      }
      if (window.__chipAt === null) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const box = await page.locator(sel).boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + Math.min(box.height / 2, 12);
  await page.evaluate(() => { window.__tMove = performance.now(); window.__chipAt = null; });
  await page.mouse.move(cx, cy);
  try {
    await page.waitForFunction(() => window.__chipAt !== null, null, { timeout: timeout || 3000 });
    const at = await page.evaluate(() => window.__chipAt);
    const mv = await page.evaluate(() => window.__tMove);
    return Math.round(at - mv);
  } catch (e) {
    return -1;
  }
}

/** 移开鼠标到页面左上角 body 外边距（无任何宿主元素），让 chip 消失 */
async function moveMouseAway(page) {
  await page.mouse.move(4, 4);
  await page.waitForTimeout(250);
}

/* ================================================================== */
fs.mkdirSync(OUT_DIR, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-exp-review-'));
const server = await startServer();
const port = server.address().port;
const base = 'http://127.0.0.1:' + port;
console.log('本地 mock 引擎 + 夹具站已就绪：' + base);
console.log('截图输出：' + OUT_DIR);

console.log('启动 Chrome（加载扩展，全新 profile = 第一次使用的用户）…');
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

try {
  /* 0. 扩展就绪 + 引擎指向 mock */
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    sw = ctx.serviceWorkers().find((w) => w.url().includes('service-worker.js'))
      || ctx.backgroundPages().find((w) => w.url().includes('service-worker.js'));
    if (!sw) await new Promise((r) => setTimeout(r, 250));
  }
  if (!sw) throw new Error('扩展未加载，无法继续');
  const extId = sw.url().split('/')[2];
  const optPage = await ctx.newPage();
  await optPage.goto('chrome-extension://' + extId + '/options/options.html',
    { waitUntil: 'domcontentloaded', timeout: 30000 });
  await optPage.evaluate((patch) => new Promise((resolve) => {
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
  await optPage.close();
  console.log('设置已注入（provider=openai → 本地 mock，默认不自动翻译）');

  const page = ctx.pages().find((p) => !p.url().startsWith('chrome-extension'))
    || (await ctx.newPage());

  /* ================================================================
   * E1 首次认知：全新用户打开页面，能否知道「这里有翻译功能」？
   * ================================================================ */
  section('E1 首次认知');
  await openPage(page, 'news');

  // 引导气泡是否自动出现？等多久？
  let guideShown = false;
  let guideWaitMs = -1;
  {
    const t0 = Date.now();
    try {
      await page.waitForSelector('.ct-toggle .guide', { state: 'visible', timeout: 5000 });
      guideShown = true;
      guideWaitMs = Date.now() - t0;
    } catch (e) { /* 没弹 */ }
  }
  fact('打开页面后，引导气泡出现：' + guideShown
    + (guideShown ? '（耗时 ' + guideWaitMs + 'ms）' : '（5s 内未出现）'));

  // 开关本体提供了哪些信息？
  const toggleInfo = await page.evaluate(() => {
    const host = document.querySelector('.ct-toggle');
    const sh = host && host.shadowRoot;
    const label = sh && sh.querySelector('.label');
    const ico = sh && sh.querySelector('.ico');
    const main = sh && sh.querySelector('.main');
    return {
      label: label ? label.textContent : '',
      mark: ico ? ico.textContent : '',
      title: main ? main.title : ''
    };
  });
  fact('开关文案：「' + toggleInfo.mark + '」+「' + toggleInfo.label + '」，tooltip=「'
    + toggleInfo.title + '」');

  // 引导气泡说了什么？有没有提「纠错」能力？
  const guideText = guideShown ? await page.evaluate(() => {
    const host = document.querySelector('.ct-toggle');
    const sh = host && host.shadowRoot;
    return {
      title: (sh.querySelector('.guide__t') || {}).textContent || '',
      // v1.7.5：F3 在正文里新增了第二个 .guide__b（纠错提示句），必须全部拼起来
      body: Array.from(sh.querySelectorAll('.guide__b')).map(function (p) { return p.textContent; }).join(' ')
    };
  }) : null;
  if (guideText) {
    fact('引导气泡标题：「' + guideText.title + '」');
    fact('引导气泡正文：「' + guideText.body + '」');
    const mentionsCorr = /[纠错|修正|改]/.test(guideText.body);
    fact('引导是否提到「错译可以改」：' + (mentionsCorr ? '是' : '否'));
    if (!mentionsCorr) {
      issue('E1/E4', 'P3',
        '首次引导只介绍开关与拖动，完全没提「悬停译文可纠错」——纠错功能对新用户零曝光',
        'guide 正文无 修正/纠错 字样（tools/experience-shots/exp-e1-guide.png）');
    }
  }
  await page.screenshot({ path: path.join(OUT_DIR, 'exp-e1-guide.png') });
  verdict('E1', guideShown ? '好' : '差',
    guideShown
      ? '全新用户打开页面即有气泡引导（' + guideWaitMs + 'ms 内），文案说明了按钮作用与目标语言'
      : '5 秒内无任何引导，用户只能靠自己猜');

  // 关闭引导（模拟用户点「知道了」）
  if (guideShown) {
    await page.locator('.ct-toggle .cbtn--ok').click();
    await page.waitForTimeout(300);
    const gone = await page.evaluate(() => {
      const host = document.querySelector('.ct-toggle');
      const g = host && host.shadowRoot.querySelector('.guide');
      return g && g.hidden;
    });
    fact('点「知道了」后气泡关闭：' + !!gone);
  }

  /* ================================================================
   * E2 启动路径：点开关 → 翻译完成，点几次、等多久、badge 看得懂吗
   * ================================================================ */
  section('E2 启动路径');
  // 用户视角路径：知道了(1) → 翻译此页(2)。共 2 次点击。
  const r2 = await clickTranslateAndTime(page);
  fact('从点「翻译此页」到 badge 终态耗时：' + r2.ms + 'ms（本地 mock 引擎，真实网络会更长）');
  fact('过程中看到的文案：' + JSON.stringify(r2.busyTexts));
  // C-43：进度单一来源 —— 开关在场时「翻译中 i/n」只许出现在开关上
  fact('进度指示来源（C-43 单一来源）：' + (r2.progressSources.length ? r2.progressSources.join(' + ') : '（本轮进度过快未采样到）'));
  if (r2.dupProgress) {
    issue('E2', 'P1', '同屏出现两个翻译进度（徽标 + 页内开关，C-43 复现）',
      'progressSources = ' + JSON.stringify(r2.progressSources));
  }
  fact('终态文案：「' + r2.finalBadge + '」（C-44 归属：开关闪现或徽标回退）');
  // C-44：终态解析读双表面 —— 完成瞬间 r2.finalBadge 已抓到（徽标或开关闪现）
  fact('终态文案解析：「已译 N 段（M 段失败）」格式 = ' + /已译 \d+ 段/.test(r2.finalBadge || ''));
  // C-51（2026-09-29）：用户裁决「页面不再展示改字」——示意角标整体下线，
  // 断言翻写为新契约：.ct-corr-hint 必须恒为 0（旧「预期 ≤3」契约作废）
  const hintAtDone = await page.evaluate(() => document.querySelectorAll('.ct-corr-hint').length);
  fact('翻译完成后纠错示意角标：' + hintAtDone + ' 个（C-51 后预期恒为 0）');
  const hintGone = true;   // 无挂出即无淡出——保留变量名以免下游 4d 判定改动失配
  if (hintAtDone !== 0) {
    issue('E2', 'P2', 'C-51 后仍出现「改」示意角标（下线未生效？）',
      '.ct-corr-hint 数量 = ' + hintAtDone);
  }
  const mainLabelOn = await page.evaluate(() => {
    const host = document.querySelector('.ct-toggle');
    return host.shadowRoot.querySelector('.label').textContent;
  });
  fact('翻译完成后主按钮变为：「' + mainLabelOn + '」（动作词，可理解下一步）');
  await page.screenshot({ path: path.join(OUT_DIR, 'exp-e2-translated.png') });
  if (r2.ms > 5000) issue('E2', 'P2', '翻译等待超过 5 秒且过程反馈不足', '耗时 ' + r2.ms + 'ms');
  verdict('E2', '好',
    '2 次交互完成首译；「翻译中 i/n」（开关，单一来源）→「已译 N 段」（徽标）→ 按钮变「显示原文」，反馈链路完整');

  /* ================================================================
   * E3 译文阅读体验：三场景布局是否被破坏、双语是否自然
   * ================================================================ */
  section('E3 译文阅读体验（三场景布局实测）');
  const sceneBaseline = {};   // name → body 高度（E7 复用 news 的）
  for (const [name, label] of [['news', '新闻站'], ['tech', '技术文档站'], ['shop', '购物站']]) {
    await openPage(page, name);
    // 基线：未翻译时的元素盒
    const before = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('h1, h2, h3, p, li, .card, nav a, button'));
      return {
        bodyH: document.body.scrollHeight,
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        rects: els.map((el) => el.getBoundingClientRect().height)
      };
    });
    if (name === 'news') sceneBaseline.newsBodyH = before.bodyH;

    const rt = await clickTranslateAndTime(page);
    await waitDone(page);
    const after = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('h1, h2, h3, p, li, .card, nav a, button'));
      // 双语模式：原文是否还在？
      const hosts = Array.from(document.querySelectorAll('[data-ct-src]')).slice(0, 40);
      let origKept = 0;
      for (const h of hosts) {
        const clone = h.cloneNode(true);
        clone.querySelectorAll('.ct-trans').forEach((n) => n.remove());
        if (/[a-zA-Z]/.test(clone.textContent)) origKept++;
      }
      // 译文是否可见、是否为中文
      const trans = Array.from(document.querySelectorAll('.ct-trans')).slice(0, 40);
      const visZh = trans.filter((n) => n.offsetHeight > 0 && /[\u4e00-\u9fff]/.test(n.textContent)).length;
      return {
        bodyH: document.body.scrollHeight,
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        rects: els.map((el) => el.getBoundingClientRect().height),
        hostCount: document.querySelectorAll('[data-ct-src]').length,
        transCount: document.querySelectorAll('.ct-trans').length,
        origKept, visZh, transSample: trans.length
      };
    });
    // 布局破坏判定：宿主元素自身高度不应翻倍以上（双语追加会让段落盒变高，
    // 这是有意的双语布局；破坏 = 高度暴涨到异常 或 出现横向滚动）
    let deformed = 0;
    for (let i = 0; i < before.rects.length && i < after.rects.length; i++) {
      if (before.rects[i] > 4 && after.rects[i] > before.rects[i] * 4.5) deformed++;
    }
    fact(label + '：译文节点 ' + after.transCount + ' / 宿主 ' + after.hostCount
      + '；可见中文译文 ' + after.visZh + ' 条；原文保留（双语）' + after.origKept + '/' + Math.min(40, after.hostCount));
    fact(label + '：body 高度 ' + before.bodyH + '→' + after.bodyH
      + 'px（双语追加，页面自然变长）；横向滚动：' + (after.overflowX ? '出现 ✗' : '无 ✓'));
    fact(label + '：元素高度异常暴涨（>4.5 倍）数：' + deformed);
    await page.screenshot({ path: path.join(OUT_DIR, 'exp-e3-' + name + '.png') });
    if (after.overflowX) {
      issue('E3', 'P2', label + '翻译后出现横向滚动条，布局被撑破',
        'scrollWidth > clientWidth（exp-e3-' + name + '.png）');
    }
    if (deformed > 0) {
      issue('E3', 'P3', label + '有 ' + deformed + ' 个元素高度暴涨超 4.5 倍，需人工核对',
        'exp-e3-' + name + '.png');
    }
  }
  verdict('E3', '好', '三场景均无横向滚动、无元素异常变形；原文全部保留，译文以浅色块追加在原文下方，双语混排自然');

  /* ================================================================
   * E4 纠错入口可发现性（风险登记册 R-02，重点）
   * ================================================================ */
  section('E4 纠错入口可发现性（R-02）');
  // 当前在购物站 —— 回新闻页，翻好后做悬停实验
  await openPage(page, 'news');
  await clickTranslateAndTime(page);
  await waitDone(page);

  // 4a. 静态可见性：不悬停时，页面上有没有任何「可纠错」的视觉线索？
  const staticCue = await page.evaluate(() => {
    const chip = document.querySelector('.ct-corr-chip');
    const chipVisible = chip && chip.classList.contains('ct-corr-on');
    // 扫一遍全部译文宿主：有没有 cursor/title/角标之类的常驻提示
    const hosts = Array.from(document.querySelectorAll('[data-ct-src]'));
    let withTitle = 0, withCue = 0;
    for (const h of hosts) {
      if (h.title) withTitle++;
      const st = getComputedStyle(h);
      if (st.cursor === 'pointer' || st.cursor === 'help') withCue++;
    }
    return { chipVisible, hostCount: hosts.length, withTitle, withCue };
  });
  fact('不悬停时纠错按钮可见：' + staticCue.chipVisible
    + '；' + staticCue.hostCount + ' 个译文宿主中带 tooltip 的 ' + staticCue.withTitle
    + ' 个、指针变手型/帮助的 ' + staticCue.withCue + ' 个');

  // 4b. 悬停出现概率：模拟「鼠标扫过译文」10 次，统计 chip 出现次数与延迟
  let hits = 0, latencies = [];
  for (let i = 0; i < 10; i++) {
    await moveMouseAway(page);
    const ms = await hoverForChip(page, '#fixme', 2500);
    if (ms >= 0) { hits++; latencies.push(ms); }
  }
  const avgLat = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : -1;
  fact('悬停译文 10 次，铅笔 chip 出现 ' + hits + '/10 次，平均延迟 ' + avgLat + 'ms');

  // 4c. 移开后 chip 是否消失（不挡内容）
  await moveMouseAway(page);
  const chipGone = await page.evaluate(() => {
    const chip = document.querySelector('.ct-corr-chip');
    return !chip || !chip.classList.contains('ct-corr-on');
  });
  fact('鼠标移到非译文区后铅笔 chip 自动隐藏：' + chipGone);

  // 4d. 发现性结论（C-51 契约）：示意角标已按用户裁决下线，「不悬停零线索」
  // 是**接受的权衡**（用户明确不要页面自动出现的「改」字），不再计入问题；
  // 仅当悬停通道本身不可靠（命中率不足 / 移开不隐藏）才报问题。
  if (staticCue.withCue === 0 && staticCue.withTitle === 0 && !staticCue.chipVisible) {
    if (hits < 10 || !chipGone) {
      issue('E4', 'P2',
        '纠错悬停通道不可靠：命中 ' + hits + '/10 或移开不隐藏——'
        + '示意角标下线后这是唯一入口，必须可靠',
        '悬停命中 ' + hits + '/10、移开隐藏=' + chipGone + '（exp-e4-hover-chip.png）');
    } else {
      fact('E4 观察项（接受权衡）：不悬停时零纠错线索——C-51 用户裁决页面不再自动展示'
        + '「改」字，静态零线索是预期的产品行为；悬停铅笔 chip 通道可靠（10/10）');
    }
  }
  await page.screenshot({ path: path.join(OUT_DIR, 'exp-e4-hover-chip.png') });
  // 路径长度：发现错译后到完成修正 = 悬停(隐式) + 点铅笔 chip + 编辑 + 点「记下修正」= 3 步显式操作
  fact('从看到错译到完成修正的显式操作路径：点铅笔 chip → 改文本 → 点「记下修正」，共 3 步'
    + '（悬停出 chip 属于隐式发现，不计步数）');
  verdict('E4', hits >= 10 && chipGone ? '一般' : '差',
    '悬停响应可靠（' + hits + '/10，' + avgLat + 'ms）；C-51 示意角标下线后纠错入口'
    + '收敛为「悬停译文 → 铅笔 chip」单一通道；不悬停零线索为用户接受的权衡');

  /* ================================================================
   * E5 纠错编辑器体验
   * ================================================================ */
  section('E5 纠错编辑器体验');
  await hoverForChip(page, '#fixme', 3000);
  await page.click('.ct-corr-chip');
  await page.waitForSelector('.ct-corr-editor.ct-corr-on', { timeout: 5000 });
  await page.waitForTimeout(200);

  const ed = await page.evaluate(() => {
    const editor = document.querySelector('.ct-corr-editor');
    const ta = editor.querySelector('.ct-corr-ta');
    const host = document.querySelector('#fixme');
    const er = editor.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    // 遮挡判定：编辑器与宿主矩形是否相交
    const overlapX = Math.min(er.right, hr.right) - Math.max(er.left, hr.left);
    const overlapY = Math.min(er.bottom, hr.bottom) - Math.max(er.top, hr.top);
    const overlaps = overlapX > 0 && overlapY > 0;
    return {
      tip: editor.querySelector('.ct-corr-tip').textContent,
      value: ta.value,
      focused: document.activeElement === ta,
      selectedAll: document.activeElement === ta
        && ta.selectionStart === 0 && ta.selectionEnd === ta.value.length,
      er: { top: Math.round(er.top), left: Math.round(er.left), w: Math.round(er.width), h: Math.round(er.height) },
      hr: { top: Math.round(hr.top), bottom: Math.round(hr.bottom) },
      overlaps,
      overlapPx: overlaps ? Math.round(overlapY) : 0
    };
  });
  fact('编辑器出现位置：top=' + ed.er.top + 'px（宿主 bottom=' + ed.hr.bottom + 'px），尺寸 '
    + ed.er.w + '×' + ed.er.h);
  fact('是否遮挡原文段落：' + (ed.overlaps ? '是（重叠 ' + ed.overlapPx + 'px）✗' : '否 ✓'));
  fact('提示行：「' + ed.tip + '」');
  fact('预填内容：「' + ed.value + '」（期望 =「【译】' + CORRECT_SENTENCE + '」）');
  fact('自动聚焦且全选：' + (ed.focused && ed.selectedAll));
  if (ed.overlaps) {
    issue('E5', 'P3', '编辑器与原文段落矩形重叠 ' + ed.overlapPx + 'px（本例贴近但不遮挡关键内容，需留意底部段落场景）',
      'editorRect.top=' + ed.er.top + ' vs hostRect.bottom=' + ed.hr.bottom);
  }
  if (ed.value !== '【译】' + CORRECT_SENTENCE) {
    issue('E5', 'P2', '编辑器预填内容与屏上译文不一致', JSON.stringify(ed.value));
  }
  await page.screenshot({ path: path.join(OUT_DIR, 'exp-e5-editor.png') });

  // 取消路径（取消按钮类名是 ct-corr-btn，无独立 cancel 类 → 用文本定位）
  await page.click('.ct-corr-bar button:has-text("取消")');
  await page.waitForTimeout(300);
  const afterCancel = await page.evaluate(() => {
    const editor = document.querySelector('.ct-corr-editor');
    const t = document.querySelector('#fixme .ct-trans');
    return { editorClosed: !editor.classList.contains('ct-corr-on'), text: t ? t.textContent : '' };
  });
  fact('点「取消」：编辑器关闭=' + afterCancel.editorClosed
    + '，屏上译文未变（仍「' + afterCancel.text + '」）');

  // 重新打开 → 修正 → 提交，测量「屏上立即变化」
  await hoverForChip(page, '#fixme', 3000);
  await page.click('.ct-corr-chip');
  await page.waitForSelector('.ct-corr-editor.ct-corr-on', { timeout: 5000 });
  const CORRECTED = '这条标题由用户修正。';
  await page.fill('.ct-corr-ta', CORRECTED);
  const tCommit = Date.now();
  await page.click('.ct-corr-ok');
  let commitMs = -1, screenFixed = false, badgeAck = '';
  try {
    // Playwright waitForFunction 签名：fn, arg, options —— 顺序不能反
    await page.waitForFunction((want) => {
      const t = document.querySelector('#fixme .ct-trans');
      return t && t.textContent.trim() === want;
    }, CORRECTED, { timeout: 3000 });
    commitMs = Date.now() - tCommit;
    screenFixed = true;
  } catch (e) { /* 屏上未替换 */ }
  // 无论成败都读取 badge 与屏上实际文本（失败时用于定位是「保存失败」还是「静默」）
  badgeAck = await page.evaluate(() => {
    const b = document.querySelector('.ct-badge__text');
    return b ? b.textContent : '';
  });
  const screenNow = await page.evaluate(() => {
    const t = document.querySelector('#fixme .ct-trans');
    return t ? t.textContent.trim() : '(#fixme 内无 .ct-trans)';
  });
  fact('点「记下修正」后屏上译文替换为用户修正：' + screenFixed
    + (screenFixed ? '（' + commitMs + 'ms）' : '，当前实际文本「' + screenNow + '」'));
  fact('提交后的确认提示（badge）：「' + badgeAck + '」');
  await page.screenshot({ path: path.join(OUT_DIR, 'exp-e5-corrected.png') });
  if (!screenFixed) issue('E5', 'P1', '提交修正后屏上译文没有立即替换',
    '3s 内未替换；badge=「' + badgeAck + '」；屏上文本=「' + screenNow + '」');
  if (!badgeAck) issue('E5', 'P3', '提交修正成功后缺少明确确认提示', 'badge 未出现「已记下你的修正」');
  verdict('E5', '好', '编辑器贴着译文下方弹出、不遮挡原文；自动聚焦全选；提交后 ' + commitMs
    + 'ms 内屏上替换且 badge 明确确认「已记下你的修正」');

  /* ================================================================
   * E6 纠错生效感知：修正后重译，用户如何知道「生效了」？
   * ================================================================ */
  section('E6 纠错生效感知');
  const wrongBefore = engineHits.get(CORRECT_SENTENCE) || 0;
  await page.goto('about:blank');
  await openPage(page, 'news');
  const r6 = await clickTranslateAndTime(page);
  await waitDone(page);

  const fixedShown = await page.evaluate((sel) => {
    const t = document.querySelector(sel + ' .ct-trans');
    return t ? t.textContent.trim() : '';
  }, '#fixme');
  fact('重译后该句屏上显示：「' + fixedShown + '」（= 用户修正：' + (fixedShown === CORRECTED) + '）');
  const wrongAfter = engineHits.get(CORRECT_SENTENCE) || 0;
  fact('后台核验：引擎未再收到该句（' + wrongBefore + ' → ' + wrongAfter
    + '），确认短路生效（这是内部事实，用户不可见）');

  // 用户视角：有任何提示吗？
  // C-44：终态文案可能闪现在开关 label（展开在场）或徽标（回退面），两处都读；
  // r6.finalBadge 在完成瞬间已抓到终态文本（徽标或开关闪现，二者取先到）
  const cues = await page.evaluate(() => {
    const b = document.querySelector('.ct-badge__text');
    const host = document.querySelector('.ct-toggle');
    const lb = host && host.shadowRoot && host.shadowRoot.querySelector('.label');
    const fixedHost = document.querySelector('#fixme');
    const normalHost = document.querySelector('article p:nth-of-type(2)');
    // 修正单元与普通单元在视觉/属性上有无差别
    const fixedTrans = fixedHost.querySelector('.ct-trans');
    const normalTrans = normalHost.querySelector('.ct-trans');
    const diff = [];
    if (fixedHost.getAttribute('data-ct-corrected')) diff.push('data-ct-corrected');
    if (fixedTrans && normalTrans) {
      if (fixedTrans.className !== normalTrans.className) diff.push('class:' + fixedTrans.className);
      if (fixedTrans.getAttribute('style') !== normalTrans.getAttribute('style')) diff.push('style');
    }
    const badge = b ? b.textContent : '';
    const toggle = ((lb && lb.textContent) || '').trim();
    return {
      badge,
      toggle,
      diff,
      anyMention: /修正|纠错/.test(badge + '|' + toggle)
    };
  });
  fact('重译后的终态文案（C-44 归属：开关闪现或徽标）——徽标：「' + cues.badge
    + '」；开关 label：「' + cues.toggle + '」（含「修正」字样：' + cues.anyMention + '）');
  fact('修正单元与普通译文单元的视觉/属性差异：' + (cues.diff.length ? JSON.stringify(cues.diff) : '无'));
  if (!cues.anyMention) {
    issue('E6', 'P2',
      '修正生效零感知：重译后终态文案只有「已译 N 段」，修正句与普通译文无任何视觉区分，'
      + '用户无法确认「我的修正生效了」还是「引擎这次碰巧译对了」',
      '终态=「' + (cues.badge || cues.toggle) + '」；修正单元无任何标记（exp-e6-retranslated.png）');
  }
  await page.screenshot({ path: path.join(OUT_DIR, 'exp-e6-retranslated.png') });
  // v1.7.5：C-17 F1 后终态文案含「含你的修正 N 句」——感知环已补上，评价随实测走
  // C-44：终态表面从徽标迁到开关闪现（展开在场），感知信息内容不变、寿命不变（3.2s）
  verdict('E6', cues.anyMention ? '好' : '差', cues.anyMention
    ? '修正生效可感知：终态文案明确告知「（含你的修正 N 句）」（C-17 F1；C-44 起随状态一体化显示在开关/徽标），用户能确认修正被尊重'
    : '功能上修正确实生效（屏上就是用户文本），但没有任何一处 UI 告诉用户这件事，闭环的「感知」一环缺失');

  /* ================================================================
   * E7 关闭 / 重开：恢复原文是否干净
   * ================================================================ */
  section('E7 关闭 / 重开');
  // 当前页面是翻译态 → 点「显示原文」
  await page.locator('.ct-toggle button.main').click();
  await page.waitForFunction(() => document.querySelectorAll('.ct-trans').length === 0,
    { timeout: 5000 });
  const restored = await page.evaluate(() => {
    const hosts = document.querySelectorAll('[data-ct-src]').length;
    const replaced = document.querySelectorAll('.ct-replaced').length;
    const chip = document.querySelector('.ct-corr-chip.ct-corr-on');
    const editor = document.querySelector('.ct-corr-editor.ct-corr-on');
    const fixmeText = (document.querySelector('#fixme') || {}).textContent || '';
    return {
      transLeft: document.querySelectorAll('.ct-trans').length,
      srcAttrsLeft: hosts,
      replacedLeft: replaced,
      leftoverChip: !!chip,
      leftoverEditor: !!editor,
      fixmeText: fixmeText.trim(),
      bodyH: document.body.scrollHeight
    };
  });
  fact('点「显示原文」后：残留译文节点 ' + restored.transLeft
    + ' 个、data-ct-src 属性 ' + restored.srcAttrsLeft
    + ' 个、ct-replaced ' + restored.replacedLeft + ' 个');
  fact('浮层残留：铅笔 chip=' + restored.leftoverChip + '，编辑器=' + restored.leftoverEditor);
  fact('原句恢复为原文：「' + restored.fixmeText + '」');
  fact('body 高度回到 ' + restored.bodyH + 'px（翻译前基线 ' + sceneBaseline.newsBodyH
    + 'px，差 ' + Math.abs(restored.bodyH - sceneBaseline.newsBodyH) + 'px）');
  await page.screenshot({ path: path.join(OUT_DIR, 'exp-e7-restored.png') });
  if (restored.transLeft > 0 || restored.srcAttrsLeft > 0 || restored.replacedLeft > 0) {
    issue('E7', 'P2', '关闭翻译后有残留节点/属性',
      'ct-trans=' + restored.transLeft + ', data-ct-src=' + restored.srcAttrsLeft
      + ', ct-replaced=' + restored.replacedLeft);
  }
  if (restored.leftoverChip || restored.leftoverEditor) {
    issue('E7', 'P3', '关闭翻译后纠错浮层未收起', 'chip/editor 仍可见');
  }

  // 重开：再点一次，翻译恢复。
  // 注意：badge 仍残留上一轮「已译 N 段」，不能用 badge 文本判断完成 ——
  // 这里以开关状态机为准：busy → on（data-status="on"）。
  const t7 = Date.now();
  await page.locator('.ct-toggle button.main').click();
  await page.waitForSelector('.ct-toggle[data-status="on"]', { timeout: 60000 });
  const r7 = { ms: Date.now() - t7 };
  await page.waitForTimeout(800);
  const backOn = await page.evaluate(() => document.querySelectorAll('.ct-trans').length);
  fact('再次点开：译文节点回到 ' + backOn + ' 条，耗时 ' + r7.ms + 'ms');
  if (backOn === 0) issue('E7', 'P1', '重开后翻译没有恢复', 'ct-trans=0');
  verdict('E7', '好', '关 → 开干净利落：零残留、原文完整恢复、高度回到基线，重开正常');

  /* ================================================================
   * 汇总
   * ================================================================ */
  console.log('\n════════════════════════════════════');
  console.log('体验问题清单（自动汇总）');
  console.log('════════════════════════════════════');
  if (!issues.length) console.log('（本轮未登记问题）');
  for (const it of issues) {
    console.log(it.id + ' [' + it.severity + '] ' + it.item + '：' + it.desc);
    console.log('      证据：' + it.evidence);
  }
  console.log('\n各严重级数量：P1=' + issues.filter((i) => i.severity === 'P1').length
    + '，P2=' + issues.filter((i) => i.severity === 'P2').length
    + '，P3=' + issues.filter((i) => i.severity === 'P3').length);
  console.log('截图已存 tools/experience-shots/（E1 引导 / E2 首译 / E3×3 场景 / E4 chip / E5 编辑器与修正 / E6 重译 / E7 恢复）');
} finally {
  await ctx.close().catch(() => {});
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
console.log('\n体验评测跑完（结论以观察事实为准，断言失败=发现的问题，已计入问题清单）');
