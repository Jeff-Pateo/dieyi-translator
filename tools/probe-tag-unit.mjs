/*
 * 探针：remoteok 标签行的单元形态（F6/F9 归因依据）
 * ------------------------------------------------------------------
 * 载入扩展 + mock 引擎（回显请求体原文），开启翻译后检查译文节点的
 * 父单元形态：单元 = 整个标签行容器（多标签串接送翻）还是每个标签独立单元。
 * 设置注入走 options 页消息通道（与真实用户路径一致）。
 */
import { createRequire } from 'node:module';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXT = ROOT;
const CHROME = process.env.CFT_CHROME || 'C:/Users/Administrator/.workbuddy/binaries/cft/chrome-win64/chrome.exe';

/* mock：providers 的 openai 批量协议 —— 最后一条 message.content 是
 * JSON 数组 [{s:原文}...]；响应 content 必须是 JSON 串 {"t":["译文",...]} */
const srv = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    try {
      const j = JSON.parse(raw || '{}');
      const msgs = (j.messages || []);
      const user = (msgs[msgs.length - 1] || {}).content || '[]';
      const arr = JSON.parse(user);
      const texts = arr.map((x) => (typeof x === 'string' ? x : x.s));
      const t = texts.map((s) => '【译】' + s);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'mock', object: 'chat.completion', created: 1, model: 'mock',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ t: t }) } }],
        usage: { prompt_tokens: 0, completion_tokens: 0 }
      }));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(e) } }));
    }
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const mockBase = 'http://127.0.0.1:' + srv.address().port + '/v1';

const profile = path.join(process.env.TEMP || '/tmp', 'ct-probe-' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath: CHROME,
  args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT, '--no-first-run', '--window-size=1400,900']
});
try {
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    sw = ctx.serviceWorkers().find((w) => w.url().includes('service-worker.js'));
    if (!sw) await new Promise((r) => setTimeout(r, 250));
  }
  if (!sw) throw new Error('扩展未加载');

  const extId = sw.url().split('/')[2];
  const optPage = await ctx.newPage();
  await optPage.goto('chrome-extension://' + extId + '/options/options.html',
    { waitUntil: 'domcontentloaded', timeout: 30000 });
  await optPage.evaluate((patch) => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'ct:set-settings', patch: patch }, (r) => resolve(r));
  }), {
    provider: 'openai', openaiBaseUrl: mockBase, openaiApiKey: 'k', openaiModel: 'mock',
    autoTranslate: false
  });
  await optPage.close();

  const page = await ctx.newPage();
  await page.goto('https://remoteok.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);

  const guideBtn = page.locator('.ct-toggle .cbtn--ok');
  if (await guideBtn.count() > 0 && await guideBtn.first().isVisible().catch(() => false)) {
    await guideBtn.first().click();
    await page.waitForTimeout(300);
  }
  await page.locator('.ct-toggle button.main').click();
  let reached = 0;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2000);
    reached = await page.evaluate(() => document.querySelectorAll('.ct-trans').length);
    if (reached > 0) break;
  }
  if (reached === 0) {
    const dbg = await page.evaluate(() => ({
      status: (document.querySelector('.ct-toggle') || {}).getAttribute
        ? document.querySelector('.ct-toggle').getAttribute('data-status') : 'no-toggle',
      trans: document.querySelectorAll('.ct-trans').length,
      title: document.title.slice(0, 80)
    }));
    console.error('未出现译文，现场：' + JSON.stringify(dbg));
  }
  await page.waitForTimeout(8000);

  const probe = await page.evaluate(() => {
    const out = { total: 0, samples: [] };
    const nodes = document.querySelectorAll('.ct-trans');
    out.total = nodes.length;
    for (const n of nodes) {
      const t = (n.textContent || '').replace(/^【译】/, '');
      const unit = n.parentElement;
      if (!unit) continue;
      if (/Executive|Sys Admin|Marketing|Content Writing/.test(t)) {
        out.samples.push({
          transText: t.slice(0, 160),
          unitTag: unit.tagName + ' class="' + String(unit.className || '').slice(0, 50) + '"',
          elementChildren: unit.children.length,
          unitHtml: unit.outerHTML.replace(/\s+/g, ' ').slice(0, 420)
        });
        if (out.samples.length >= 3) break;
      }
    }
    return out;
  });
  console.log(JSON.stringify(probe, null, 2));
} finally {
  await ctx.close().catch(() => {});
  srv.close();
}
