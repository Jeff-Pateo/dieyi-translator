/*
 * 真实站点复现探针 · remoteok.com「翻译中 N / M 卡死」（C-21）
 * ==================================================================
 * 背景：用户实测 remoteok.com（2396 段）badge 卡在「翻译中 224 / 2396」。
 * 根因：providers.js 无超时保护，引擎挂起 → mapLimit 永久阻塞。
 * 修复：translateBatch 加批级超时（CT.TRANSLATE_TIMEOUT_MS）。
 *
 * 本探针在真实 remoteok.com 上跑两轮：
 *   第一轮 provider=openai → 本地 mock 引擎：验证管线本身能跑完全部段
 *   第二轮 provider=google-free → 真实 Google 接口：贴近用户环境，
 *     即使限流/挂起也必须落到终态（已译/失败），不允许「翻译中」永久滞留
 *
 * 运行：NODE_PATH=<node_modules> node tools/e2e-remoteok-stall.mjs
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
const POLL_MS = 3000;
const MAX_WAIT = 300000; // 单轮上限 5 分钟

/* ---------------- mock 引擎（OpenAI 兼容批量协议） ---------------- */
function startMockServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const user = payload.messages[payload.messages.length - 1].content;
          const texts = JSON.parse(user).map((x) => (typeof x === 'string' ? x : x.s));
          const t = texts.map((s) => '【译】' + s);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'mock', object: 'chat.completion', created: 1, model: 'mock',
            choices: [{ index: 0, finish_reason: 'stop',
              message: { role: 'assistant', content: JSON.stringify({ t }) } }],
            usage: { prompt_tokens: 0, completion_tokens: 0 }
          }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: String(e) } }));
        }
      });
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* ---------------- badge 工具 ---------------- */
/** 读当前进度文案。
 *  C-43（2026-09-29）：进度单一来源 —— 页内开关展开在场时「翻译中 N / M」
 *  让位给开关（shadow .label），徽标为空。本探针的卡死判据依赖进度信号，
 *  因此徽标为空时穿 shadow root 读开关标签（light-DOM querySelector 穿不进去）。 */
async function readBadge(page) {
  return page.evaluate(() => {
    const b = document.querySelector('.ct-badge__text');
    if (b && (b.textContent || '').trim()) return (b.textContent || '').trim();
    const host = document.querySelector('.ct-toggle');
    const lb = host && host.shadowRoot && host.shadowRoot.querySelector('.label');
    if (lb && (lb.textContent || '').trim()) return (lb.textContent || '').trim();
    return '(无 badge)';
  });
}

/** 轮询到终态；返回 { terminal, timeline, last }。
 *  终态 = 已译/翻译失败；若「翻译中 N」的 N 连续 60s 不动也提前退出（卡死判据）。 */
async function pollToTerminal(page, tag) {
  const timeline = [];
  let last = '', lastChangeAt = Date.now(), terminal = false;
  const t0 = Date.now();
  while (Date.now() - t0 < MAX_WAIT) {
    const txt = await readBadge(page);
    if (txt !== last) {
      timeline.push('[' + Math.round((Date.now() - t0) / 1000) + 's] ' + txt);
      last = txt;
      lastChangeAt = Date.now();
    }
    if (/已译|翻译失败/.test(txt)) { terminal = true; break; }
    if (Date.now() - lastChangeAt > 75000) break; // 75s 无进度 = 卡死（熔断收尾约需两波超时 ≈60s，勿误判）
    await page.waitForTimeout(POLL_MS);
  }
  console.log('—— ' + tag + ' 进度时间线 ——');
  for (const line of timeline) console.log('  ' + line);
  return { terminal, timeline, last };
}

/* ---------------- 主流程 ---------------- */
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-e2e-rs-'));
const server = await startMockServer();
const port = server.address().port;
const base = 'http://127.0.0.1:' + port;
console.log('mock 引擎就绪：' + base);

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

let sw = null;
for (let i = 0; i < 40 && !sw; i++) {
  sw = ctx.serviceWorkers().find((w) => w.url().includes('service-worker.js'));
  if (!sw) await new Promise((r) => setTimeout(r, 250));
}
if (!sw) { console.log('✗ 扩展未加载'); process.exit(1); }
const extId = sw.url().split('/')[2];
console.log('✓ 扩展已加载 extId=' + extId);

async function setSettings(patch) {
  const optPage = await ctx.newPage();
  await optPage.goto('chrome-extension://' + extId + '/options/options.html',
    { waitUntil: 'domcontentloaded', timeout: 30000 });
  const res = await optPage.evaluate((p) => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'ct:set-settings', patch: p },
      (r) => resolve(r && r.settings ? r.settings : r));
  }), patch);
  await optPage.close();
  return res;
}

async function openAndTranslate() {
  const page = await ctx.newPage();
  await page.goto('https://remoteok.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.ct-toggle', { timeout: 30000 });
  const guideBtn = page.locator('.ct-toggle .cbtn--ok');
  if (await guideBtn.count() > 0 && await guideBtn.first().isVisible().catch(() => false)) {
    await guideBtn.first().click();
    await page.waitForTimeout(300);
  }
  await page.locator('.ct-toggle button.main').click();
  return page;
}

let failures = 0;

/* ===== 第一轮：mock 引擎（验证管线跑完全部段） ===== */
console.log('\n======== 第一轮：mock 引擎（openai → 本地） ========');
await setSettings({
  provider: 'openai', openaiBaseUrl: base + '/v1', openaiApiKey: 'k', openaiModel: 'mock',
  autoTranslate: false, cacheEnabled: false, selectionEnabled: false
});
{
  const page = await openAndTranslate();
  const r1 = await pollToTerminal(page, '第一轮');
  console.log(r1.terminal ? '✓ 第一轮到达终态：' + r1.last : '✗ 第一轮卡死在：' + r1.last);
  if (!r1.terminal) failures++;
  await page.close();
}

/* ===== 第二轮：google-free（真实引擎，验证超时保护下能收尾） ===== */
console.log('\n======== 第二轮：google-free（真实 Google 接口） ========');
await setSettings({ provider: 'google-free' });
{
  const page = await openAndTranslate();
  const r2 = await pollToTerminal(page, '第二轮');
  console.log(r2.terminal ? '✓ 第二轮到达终态：' + r2.last : '✗ 第二轮卡死在：' + r2.last);
  if (!r2.terminal) failures++;
  const shot = path.join(ROOT, 'tools', 'bench-results', 'remoteok-final.png');
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  await page.screenshot({ path: shot });
  await page.close();
}

console.log('\n────────────────────────────────');
console.log(failures === 0
  ? '真实站点复现探针：两轮均到达终态（无永久卡死）'
  : '真实站点复现探针：' + failures + ' 轮未到达终态（仍存在卡死）');
await ctx.close();
process.exit(failures === 0 ? 0 : 1);
