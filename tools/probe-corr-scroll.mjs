/*
 * 复现探针 · 纠错 chip 滚动残影（C-25）
 * ==================================================================
 * 用户实测（remoteok.com 侧栏）：悬停译文亮出「改」chip 后滚动页面，
 * 浏览器不触发 mouseover，fixed 浮层原地钉在视口上 —— 内容溜走，
 * chip 孤悬在无关空白处。夹具站全是短页（无滚动），e2e 永远踩不到。
 *
 * 本探针用高页夹具（可滚动）复现并验证修复：
 *   A. 悬停译文 → chip 可见且贴近鼠标
 *   B. 滚动 400px → chip 必须自动收起（修复点，修复前此处失败）
 *   C. 打开编辑器 → 滚动 200px → 编辑器保持打开（不丢输入）且跟随宿主重定位
 *   D. 宿主滚出视口 → 编辑器自动收起
 * 运行：NODE_PATH=<node_modules> node tools/probe-corr-scroll.mjs
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

const results = [];
function ok(label, cond, extra) {
  results.push(!!cond);
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (extra !== undefined ? '  → ' + extra : ''));
}

/* ---------------- 高页夹具 + mock 引擎 ---------------- */
function tallPage() {
  const paras = [];
  for (let i = 1; i <= 40; i++) {
    paras.push('<p id="p' + i + '">Scroll probe paragraph number ' + i + ' about the rolling hills.</p>');
  }
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>Scroll Probe</title>
<style>body{margin:40px 120px;} p{margin:28px 0;}</style>
</head><body>${paras.join('\n')}</body></html>`;
}

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const payload = JSON.parse(body);
        const texts = JSON.parse(payload.messages[payload.messages.length - 1].content)
          .map((x) => (typeof x === 'string' ? x : x.s));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'mock', object: 'chat.completion', created: 1, model: 'mock',
          choices: [{ index: 0, finish_reason: 'stop',
            message: { role: 'assistant', content: JSON.stringify({ t: texts.map((s) => '【译】' + s) }) } }]
        }));
      });
      return;
    }
    if (req.url === '/tall') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(tallPage());
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-probe-cs-'));
const server = await startServer();
const base = 'http://127.0.0.1:' + server.address().port;

const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  executablePath: CHROME,
  viewport: { width: 1200, height: 800 },
  args: [
    '--disable-extensions-except=' + EXT,
    '--load-extension=' + EXT,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-first-run', '--no-default-browser-check'
  ]
});

let sw = null;
for (let i = 0; i < 40 && !sw; i++) {
  sw = ctx.serviceWorkers().find((w) => w.url().includes('service-worker.js'));
  if (!sw) await new Promise((r) => setTimeout(r, 250));
}
const extId = sw.url().split('/')[2];

const optPage = await ctx.newPage();
await optPage.goto('chrome-extension://' + extId + '/options/options.html', { waitUntil: 'domcontentloaded' });
await optPage.evaluate((b) => new Promise((resolve) => {
  chrome.runtime.sendMessage({ type: 'ct:set-settings', patch: {
    provider: 'openai', openaiBaseUrl: b + '/v1', openaiApiKey: 'k', openaiModel: 'mock',
    autoTranslate: false, cacheEnabled: false, selectionEnabled: false
  } }, () => resolve());
}), base);
await optPage.close();

const page = await ctx.newPage();
await page.goto(base + '/tall', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.ct-toggle', { timeout: 20000 });
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

        return /已译/.test(t);
}, { timeout: 60000 });
await page.waitForTimeout(8000); // 等示意角标（6s）淡出，避免混淆

console.log('\n—— A. 悬停译文：chip 出现且贴近鼠标 ——');
// 注意：Playwright 的 hover() 在元素不在视口时会先滚轮滚动——滚动本身会触发
// C-25 修复的「滚动收 chip」。因此先把元素滚进视口、等滚动稳定，再 hover。
await page.evaluate(() => window.scrollTo(0, 600));
await page.waitForTimeout(200);
const target = page.locator('#p30');
await target.scrollIntoViewIfNeeded();
await page.waitForTimeout(400); // 让 hover 内部滚动彻底结束，避免误收 chip
await target.hover();
await page.waitForTimeout(400);
const a = await page.evaluate(() => {
  const chip = document.querySelector('.ct-corr-chip');
  if (!chip) return { exists: false };
  const on = chip.classList.contains('ct-corr-on');
  const style = { left: chip.style.left, top: chip.style.top };
  return { exists: true, on, style };
});
ok('chip 存在且可见', a.exists && a.on, JSON.stringify(a));

console.log('\n—— B. 滚动 400px：chip 必须自动收起（修复点） ——');
await page.evaluate(() => window.scrollBy(0, 400));
await page.waitForTimeout(400);
const b = await page.evaluate(() => {
  const chip = document.querySelector('.ct-corr-chip');
  return { on: chip ? chip.classList.contains('ct-corr-on') : false };
});
ok('滚动后 chip 已收起（不残影）', !b.on, JSON.stringify(b));

console.log('\n—— C. 编辑器打开后滚动：保持打开且跟随宿主 ——');
// B 的滚动已把 chip 收起（修复生效），重新悬停点亮后再点 chip
await page.locator('#p30').scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
await page.locator('#p30').hover();
await page.waitForTimeout(300);
const clicked = await page.evaluate(() => {
  const chip = document.querySelector('.ct-corr-chip');
  if (!chip || !chip.classList.contains('ct-corr-on')) return false;
  chip.click();
  return true;
});
await page.waitForTimeout(400);
const c1 = await page.evaluate(() => {
  const ed = document.querySelector('.ct-corr-editor');
  return { on: ed ? ed.classList.contains('ct-corr-on') : false };
});
ok('编辑器已打开', clicked && c1.on);
await page.evaluate(() => window.scrollBy(0, 200));
await page.waitForTimeout(400);
const c2 = await page.evaluate(() => {
  const ed = document.querySelector('.ct-corr-editor');
  const host = document.getElementById('p30');
  if (!ed || !host) return {};
  const er = ed.getBoundingClientRect();
  const hr = host.getBoundingClientRect();
  const on = ed.classList.contains('ct-corr-on');
  const near = on && Math.abs(er.top - (hr.bottom + 6)) < 60;
  const taVal = ed.querySelector('.ct-corr-ta') ? ed.querySelector('.ct-corr-ta').value : '';
  return { on, near, erTop: Math.round(er.top), hostBottom: Math.round(hr.bottom), taLen: taVal.length };
});
ok('滚动后编辑器仍打开（不丢输入）', c2.on, JSON.stringify(c2));
ok('编辑器跟随宿主重新定位', c2.near, 'erTop=' + c2.erTop + ' hostBottom+6=' + (c2.hostBottom + 6));

console.log('\n—— D. 宿主滚出视口：编辑器自动收起 ——');
// 此时页面已接近底部（向下滚不动），改为向上滚 —— 让宿主滚出视口下方
await page.evaluate(() => window.scrollBy(0, -1500));
await page.waitForTimeout(400);
const d = await page.evaluate(() => {
  const ed = document.querySelector('.ct-corr-editor');
  const h = document.getElementById('p30');
  const r = h ? h.getBoundingClientRect() : null;
  return { on: ed ? ed.classList.contains('ct-corr-on') : false,
    hostTop: r ? Math.round(r.top) : null };
});
ok('宿主滚出视口后编辑器已收起', !d.on, JSON.stringify(d));

await page.close();
await ctx.close();

const passed = results.filter(Boolean).length;
console.log('\n' + '─'.repeat(48));
console.log(passed === results.length
  ? '全部通过：' + passed + ' / ' + results.length + ' —— 滚动残影已修复'
  : '失败 ' + (results.length - passed) + ' 项 / ' + results.length);
process.exit(passed === results.length ? 0 : 1);
