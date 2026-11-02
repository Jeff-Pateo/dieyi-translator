/*
 * 复现探针 v4 · 用户真实路径：展开筛选面板 → 触发翻译（C-26）
 * ==================================================================
 * 用户截图状态 = 面板已展开 + 内容已翻译（显示中文）。
 * 本探针走该路径：加载 → 展开面板（保持站点原生 absolute 定位）→
 * 翻译（此时面板可见，会被采集）→ 量测 + 截图。
 * 对照：v3 已证「未翻译展开」= 原生 400×500 竖排单列（基线）。
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
  const items = [...panel.children].filter((c) => !c.classList.contains('optgroup-header'));
  const tops = new Set([...panel.children].map((c) => Math.round(c.getBoundingClientRect().top)));
  const w = items.map((c) => Math.round(c.getBoundingClientRect().width));
  const first = items[0];
  const transInPanel = panel.querySelectorAll('[class*="ct-trans"]').length;
  // 面板后面是否被插入了「搬出来的译文」（裁切容器救援路径的痕迹）
  let strayAfter = 0;
  let n = panel;
  for (let i = 0; i < 3 && n; i++) {
    n = n.nextElementSibling;
    if (n && n.className && String(n.className).indexOf('ct-trans') >= 0) strayAfter++;
  }
  return {
    visible: cs.display !== 'none' && pr.width > 0,
    panel: { display: cs.display, position: cs.position, width: Math.round(pr.width),
      height: Math.round(pr.height), left: Math.round(pr.left), top: Math.round(pr.top),
      overflow: cs.overflow },
    itemCount: items.length, rowCount: tops.size,
    itemWidth: { min: Math.min.apply(null, w), max: Math.max.apply(null, w) },
    firstItemHeight: first ? Math.round(first.getBoundingClientRect().height) : null,
    transNodesInPanel: transInPanel,
    strayTransAfterPanel: strayAfter,
    firstItemHTML: first ? first.outerHTML.slice(0, 400) : null,
    pageScrollHeight: document.documentElement.scrollHeight
  };
}`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-probe-rl4-'));
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

const page = await ctx.newPage();
await page.goto('https://remoteok.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);

/* 真实路径：点击 location 筛选框展开面板（保持站点原生 absolute 定位） */
const clicked = await page.evaluate(() => {
  const t = document.getElementById('location-filter-text') ||
    [...document.querySelectorAll('input')].find((i) => /location/i.test(i.id + i.name));
  if (t) { t.click(); t.focus(); return 'input-click'; }
  const panel = document.querySelector('.location-filter-results');
  if (panel) { panel.style.display = 'block'; return 'display-block'; }
  return 'none';
});
await page.waitForTimeout(800);
console.log('展开方式：' + clicked);

const before = await page.evaluate((e) => eval(e)(), MEASURE);
console.log('\n—— 展开后（翻译前） ——\n' + JSON.stringify(before, null, 1));
const shotBefore = path.join(OUT, 'panel-v4-before.png');
await page.screenshot({ path: shotBefore, clip: { x: 0, y: 0, width: 1000, height: 900 } });

/* 触发翻译（面板此刻可见，会被采集） */
await page.waitForSelector('.ct-toggle', { timeout: 30000 });
const guide = page.locator('.ct-toggle .cbtn--ok');
if (await guide.count() > 0 && await guide.first().isVisible().catch(() => false)) {
  await guide.first().click();
  await page.waitForTimeout(300);
}
await page.locator('.ct-toggle button.main').click();
await page.waitForFunction(() => {
  
  const b = document.querySelector('.ct-badge__text');

        const host = document.querySelector('.ct-toggle');

        const lb = host && host.shadowRoot && host.shadowRoot.querySelector('.label');

        const t = (b && b.textContent) || (lb && lb.textContent) || '';

        return /已译|翻译失败/.test(t);
}, { timeout: 300000 });
await page.waitForTimeout(2500);

const after = await page.evaluate((e) => eval(e)(), MEASURE);
console.log('\n—— 展开后（翻译后） ——\n' + JSON.stringify(after, null, 1));
const shotAfter = path.join(OUT, 'panel-v4-after.png');
await page.screenshot({ path: shotAfter, clip: { x: 0, y: 0, width: 1000, height: 900 } });

console.log('\n================ 判定 ================');
if (before.visible && after.visible) {
  console.log('面板宽：' + before.panel.width + ' → ' + after.panel.width);
  console.log('面板高：' + before.panel.height + ' → ' + after.panel.height);
  console.log('行数：  ' + before.rowCount + ' → ' + after.rowCount);
  console.log('项最大宽：' + before.itemWidth.max + ' → ' + after.itemWidth.max);
  console.log('首项高： ' + before.firstItemHeight + ' → ' + after.firstItemHeight);
  console.log('面板内译文节点：' + before.transNodesInPanel + ' → ' + after.transNodesInPanel);
  console.log('面板外被搬出的译文块：' + after.strayTransAfterPanel);
  console.log('页面总高：' + before.pageScrollHeight + ' → ' + after.pageScrollHeight);
}
console.log('截图：' + shotBefore + ' / ' + shotAfter);

await ctx.close();
