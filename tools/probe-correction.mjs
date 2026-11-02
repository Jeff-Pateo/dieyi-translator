/*
 * 探针：纠错提交链路（corrCommit）卡在哪一步。
 * 打开新闻夹具页 → 翻译 → 悬停 → 改 → 提交，逐步回显页面侧状态与 console。
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

const SENT = 'This headline is wrong.';

function startServer() {
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Probe News</title></head><body>
<h1>Probe page</h1><p id="fixme">${SENT}</p><p>Another paragraph for context here.</p></body></html>`;
  const hits = new Map();
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const payload = JSON.parse(body);
        const arr = JSON.parse(payload.messages[payload.messages.length - 1].content);
        const texts = arr.map((x) => (typeof x === 'string' ? x : x.s));
        for (const t of texts) hits.set(t, (hits.get(t) || 0) + 1);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant',
          content: JSON.stringify({ t: texts.map((s) => '【译】' + s) }) } }] }));
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, hits })));
}

const { server, hits } = await startServer();
const port = server.address().port;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-probe-'));
const logs = [];

const ctx = await chromium.launchPersistentContext(profile, {
  headless: false, executablePath: CHROME,
  viewport: { width: 1400, height: 900 },
  args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT,
    '--disable-features=DisableLoadExtensionCommandLineSwitch', '--no-first-run']
});

try {
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    sw = ctx.serviceWorkers().find((w) => w.url().includes('service-worker.js'));
    if (!sw) await new Promise((r) => setTimeout(r, 250));
  }
  const extId = sw.url().split('/')[2];
  const optPage = await ctx.newPage();
  await optPage.goto('chrome-extension://' + extId + '/options/options.html', { waitUntil: 'domcontentloaded' });
  await optPage.evaluate((patch) => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'ct:set-settings', patch }, resolve);
  }), { provider: 'openai', openaiBaseUrl: 'http://127.0.0.1:' + port + '/v1',
    openaiApiKey: 'k', openaiModel: 'mock', autoTranslate: false, cacheEnabled: false, selectionEnabled: false });
  await optPage.close();

  const page = await ctx.newPage();
  page.on('console', (m) => logs.push('[' + m.type() + '] ' + m.text()));
  page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));

  await page.goto('http://127.0.0.1:' + port + '/news', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ct-toggle', { timeout: 20000 });
  const guide = page.locator('.ct-toggle .cbtn--ok');
  if (await guide.count() > 0 && await guide.first().isVisible().catch(() => false)) await guide.first().click();
  await page.locator('.ct-toggle button.main').click();
  await page.waitForFunction(() => {
    
    const b = document.querySelector('.ct-badge__text');

          const host = document.querySelector('.ct-toggle');

          const lb = host && host.shadowRoot && host.shadowRoot.querySelector('.label');

          const t = (b && b.textContent) || (lb && lb.textContent) || '';

          return /已译|失败/.test(t);
  }, { timeout: 30000 });

  console.log('翻译完成，hits =', JSON.stringify([...hits.entries()]));

  await page.hover('#fixme');
  await page.waitForSelector('.ct-corr-chip', { timeout: 5000 });
  await page.click('.ct-corr-chip');
  await page.waitForSelector('.ct-corr-editor', { timeout: 5000 });
  console.log('编辑器已打开，预填 =', await page.inputValue('.ct-corr-ta'));

  await page.fill('.ct-corr-ta', '用户修正版本。');
  // 提交前状态回显
  const before = await page.evaluate(() => {
    const ed = document.querySelector('.ct-corr-editor');
    return {
      editorVisible: ed && ed.classList.contains('ct-corr-on'),
      editorRect: ed ? JSON.parse(JSON.stringify(ed.getBoundingClientRect())) : null
    };
  });
  console.log('提交前编辑器状态 =', JSON.stringify(before));

  await page.click('.ct-corr-ok');
  await page.waitForTimeout(1500);

  const after = await page.evaluate(() => {
    const host = document.querySelector('#fixme');
    const t = host.querySelector('.ct-trans');
    const b = document.querySelector('.ct-badge__text');
    const ed = document.querySelector('.ct-corr-editor');
    return {
      trans: t ? t.textContent.trim() : null,
      badge: b ? b.textContent : null,
      editorOn: ed ? ed.classList.contains('ct-corr-on') : null,
      hostHasAttr: host.hasAttribute('data-ct-src')
    };
  });
  console.log('提交后状态 =', JSON.stringify(after));
  console.log('引擎 hits =', JSON.stringify([...hits.entries()]));
  const saved = await optPage2Saved(ctx, extId, SENT);
  console.log('corrections =', JSON.stringify(saved));
} finally {
  console.log('\n---- 页面 console ----');
  for (const l of logs) console.log(l);
  await ctx.close().catch(() => {});
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

async function optPage2Saved(ctx, extId, from) {
  const p = await ctx.newPage();
  await p.goto('chrome-extension://' + extId + '/options/options.html', { waitUntil: 'domcontentloaded' });
  const out = await p.evaluate((f) => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'ct:get-settings' }, (r) =>
      resolve(((r && r.settings && r.settings.corrections) || []).filter((x) => x.from === f)));
  }), from);
  await p.close();
  return out;
}
