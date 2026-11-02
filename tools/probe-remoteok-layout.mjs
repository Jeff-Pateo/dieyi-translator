/*
 * 现场取证探针 v3 · 真实用户路径：点击筛选框展开候选面板（C-26）
 * ==================================================================
 * 用户截图里的「地区/国家」列表 = remoteok 筛选下拉面板展开状态。
 * 本探针走真实交互：
 *   A. 不翻译，点击筛选输入框展开 → 量面板自然宽度/行数/项宽 + 截图
 *   B. 翻译整页后，再点击展开 → 同样量测 + 截图
 * 对比判断：竖排与宽面板是站点原生，还是我们翻译造成的。
 * 运行：NODE_PATH=<node_modules> node tools/probe-remoteok-layout.mjs
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
const OUT = path.join(ROOT, 'tools', 'bench-results');

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const p = JSON.parse(body);
          const texts = JSON.parse(p.messages[p.messages.length - 1].content)
            .map((x) => (typeof x === 'string' ? x : x.s));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 'm', object: 'c', created: 1, model: 'm',
            choices: [{ index: 0, finish_reason: 'stop',
              message: { role: 'a', content: JSON.stringify({ t: texts.map((s) => '【译】' + s) }) } }] }));
        } catch (e) { res.writeHead(500); res.end('{}'); }
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const MEASURE = `() => {
  const panel = document.querySelector('.location-filter-results');
  if (!panel) return { err: 'panel missing' };
  const cs = getComputedStyle(panel);
  const pr = panel.getBoundingClientRect();
  if (cs.display === 'none' || pr.width === 0) return { visible: false, display: cs.display };
  const items = [...panel.children].filter((c) => !c.classList.contains('optgroup-header'));
  const tops = new Set([...panel.children].map((c) => Math.round(c.getBoundingClientRect().top)));
  const w = items.map((c) => Math.round(c.getBoundingClientRect().width));
  const first = items[0];
  const trans = panel.querySelector('[class*="ct-trans"]');
  return {
    visible: true,
    panel: { display: cs.display, position: cs.position, width: Math.round(pr.width),
      height: Math.round(pr.height), left: Math.round(pr.left), top: Math.round(pr.top) },
    itemCount: items.length, rowCount: tops.size,
    itemWidth: { min: Math.min.apply(null, w), max: Math.max.apply(null, w) },
    firstItemHeight: first ? Math.round(first.getBoundingClientRect().height) : null,
    hasTransInPanel: !!trans,
    transDisplay: trans ? getComputedStyle(trans).display : null,
    transWidth: trans ? Math.round(trans.getBoundingClientRect().width) : null
  };
}`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-probe-rl3-'));
const server = await startServer();
const base = 'http://127.0.0.1:' + server.address().port;
fs.mkdirSync(OUT, { recursive: true });

const ctx = await chromium.launchPersistentContext(profile, {
  headless: false, executablePath: CHROME, viewport: { width: 1400, height: 900 },
  args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT,
    '--disable-features=DisableLoadExtensionCommandLineSwitch', '--no-first-run']
});
let sw = null;
for (let i = 0; i < 40 && !sw; i++) {
  sw = ctx.serviceWorkers().find((w) => w.url().includes('service-worker.js'));
  if (!sw) await new Promise((r) => setTimeout(r, 250));
}
const extId = sw.url().split('/')[2];
const opt = await ctx.newPage();
await opt.goto('chrome-extension://' + extId + '/options/options.html', { waitUntil: 'domcontentloaded' });
await opt.evaluate((b) => new Promise((res) => {
  chrome.runtime.sendMessage({ type: 'ct:set-settings', patch: {
    provider: 'openai', openaiBaseUrl: b + '/v1', openaiApiKey: 'k', openaiModel: 'm',
    autoTranslate: false, cacheEnabled: false, selectionEnabled: false
  } }, () => res());
}), base);
await opt.close();

/** 点击筛选框展开面板（真实用户路径），返回量测结果 */
async function openFilterAndMeasure(page, tag) {
  // remoteok 的 location 筛选项：面板 id 关联的输入控件
  const opened = await page.evaluate(() => {
    const t = document.getElementById('location-filter-text') ||
      document.querySelector('input[name="location"]') ||
      [...document.querySelectorAll('input')].find((i) => /location|country|region/i.test(i.id + i.name + i.placeholder));
    if (!t) return false;
    t.click();
    t.focus();
    return true;
  });
  await page.waitForTimeout(600);
  let m = await page.evaluate((e) => eval(e)(), MEASURE);
  if (!m || !m.visible) {
    // 点击没展开 → 兜底：直接用站点 toggle 逻辑（display 置 block，不改宽度/定位）
    await page.evaluate(() => {
      const panel = document.querySelector('.location-filter-results');
      if (panel) panel.style.display = 'block';
    });
    await page.waitForTimeout(300);
    m = await page.evaluate((e) => eval(e)(), MEASURE);
    m.fallbackToDisplayBlock = true;
  }
  console.log('\n—— ' + tag + ' ——\n' + JSON.stringify(m, null, 1));
  const shot = path.join(OUT, 'filter-panel-' + tag + '.png');
  await page.screenshot({ path: shot, clip: { x: 0, y: 0, width: 1200, height: 900 } });
  console.log('截图：' + shot);
  return m;
}

/* ---- A. 基线：不翻译 ---- */
const pageA = await ctx.newPage();
await pageA.goto('https://remoteok.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await pageA.waitForTimeout(3000);
const before = await openFilterAndMeasure(pageA, 'baseline-未翻译');
await pageA.close();

/* ---- B. 翻译后 ---- */
const pageB = await ctx.newPage();
await pageB.goto('https://remoteok.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await pageB.waitForTimeout(3000);
await pageB.waitForSelector('.ct-toggle', { timeout: 30000 });
const guide = pageB.locator('.ct-toggle .cbtn--ok');
if (await guide.count() > 0 && await guide.first().isVisible().catch(() => false)) {
  await guide.first().click();
  await pageB.waitForTimeout(300);
}
await pageB.locator('.ct-toggle button.main').click();
await pageB.waitForFunction(() => {
  
  const b = document.querySelector('.ct-badge__text');

        const host = document.querySelector('.ct-toggle');

        const lb = host && host.shadowRoot && host.shadowRoot.querySelector('.label');

        const t = (b && b.textContent) || (lb && lb.textContent) || '';

        return /已译|翻译失败/.test(t);
}, { timeout: 240000 });
await pageB.waitForTimeout(1500);
const after = await openFilterAndMeasure(pageB, 'after-翻译后');

console.log('\n================ 差异判定 ================');
if (before && after && before.visible && after.visible) {
  console.log('面板宽度：' + before.panel.width + ' → ' + after.panel.width);
  console.log('面板高：  ' + before.panel.height + ' → ' + after.panel.height);
  console.log('行数：    ' + before.rowCount + ' → ' + after.rowCount + '（项 ' + before.itemCount + '）');
  console.log('项最大宽：' + before.itemWidth.max + ' → ' + after.itemWidth.max);
  console.log('首项高：  ' + before.firstItemHeight + ' → ' + after.firstItemHeight);
  const wRatio = after.panel.width / Math.max(1, before.panel.width);
  console.log(wRatio > 1.4 ? '✗ 面板/项宽度被翻译撑大（比例 ' + wRatio.toFixed(2) + '）—— 我方问题'
    : '✓ 宽度与基线一致 —— 竖排与宽度均为站点原生结构（比例 ' + wRatio.toFixed(2) + '）');
} else {
  console.log('量测不完整：before.visible=' + (before && before.visible) + ' after.visible=' + (after && after.visible));
}

await ctx.close();
