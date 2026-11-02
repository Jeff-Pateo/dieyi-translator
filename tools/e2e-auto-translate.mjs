/*
 * 端到端验证：「不要自动开启翻译」
 * ------------------------------------------------------------------
 * 用真实 Chrome for Testing（headed）加载本扩展，访问 https://remoteok.com/ ：
 *   1. 页面加载完成后等待 12 秒 —— 期间【不得】出现任何 .ct-trans 译文；
 *   2. 页内开关（.ct-toggle，shadow DOM）必须存在且文案是「翻译此页」；
 *   3. 用户点开关后才出现译文，且条数 > 0。
 *
 * 引擎说明：不依赖外部翻译接口 —— 本脚本起了一个本地 mock 服务
 * （OpenAI 兼容 /chat/completions 协议），并通过设置页同款消息通道
 * （ct:set-settings）把引擎指到它。这样失败只可能是扩展本身的问题，
 * 不会混杂「网络到不了翻译接口」的噪声。
 *
 * 运行：node tools/e2e-auto-translate.mjs
 * 依赖：playwright-core（NODE_PATH 指向托管工作区）+ Chrome for Testing
 *（品牌版 Chrome 137+ 禁用 --load-extension，不能用）。
 * 退出码 0 = 全部通过。
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
const URL = 'https://remoteok.com/';
const OUT_DIR = path.join(ROOT, 'tools', 'bench-results');

const results = [];
function ok(label, cond, extra) {
  results.push({ label, pass: !!cond, extra: extra === undefined ? '' : String(extra) });
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (extra !== undefined ? '  → ' + extra : ''));
}

/* ------------------------------------------------------------------
 * 本地 mock 引擎：OpenAI 兼容 /chat/completions
 * 请求的 user 消息是 JSON 数组（字符串或 {s, c} 对象），
 * 响应按协议返回 {"t": ["【译】+原文", ...]}，逐项一一对应。
 * ------------------------------------------------------------------ */
function startMockEngine() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const user = payload.messages[payload.messages.length - 1].content;
        const arr = JSON.parse(user);
        const texts = arr.map((x) => (typeof x === 'string' ? x : x.s));
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
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-e2e-'));
fs.mkdirSync(OUT_DIR, { recursive: true });
const server = await startMockEngine();
const mockBase = 'http://127.0.0.1:' + server.address().port + '/v1';
console.log('本地 mock 引擎已就绪：' + mockBase);

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

try {
  /* 0. 确认扩展真的注入了：service worker 起来才算 */
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    sw = ctx.serviceWorkers().find((w) => w.url().includes('service-worker.js'))
      || ctx.backgroundPages().find((w) => w.url().includes('service-worker.js'));
    if (!sw) await new Promise((r) => setTimeout(r, 250));
  }
  ok('扩展已加载（service worker 存活）', !!sw, sw ? sw.url() : '未找到');
  if (!sw) throw new Error('扩展未加载，无法继续');

  /* 0.5 把引擎指到本地 mock —— 走设置页同款消息通道（真实路径） */
  const extId = sw.url().split('/')[2];
  const optPage = await ctx.newPage();
  await optPage.goto('chrome-extension://' + extId + '/options/options.html',
    { waitUntil: 'domcontentloaded', timeout: 30000 });
  const setRes = await optPage.evaluate((patch) => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'ct:set-settings', patch: patch },
      (r) => resolve(r && r.settings ? r.settings : r));
  }), {
    provider: 'openai',
    openaiBaseUrl: mockBase,
    openaiApiKey: 'e2e-mock-key',
    openaiModel: 'mock',
    autoTranslate: false
  });
  ok('设置已写入（provider=openai → 本地 mock）', !!setRes
    && setRes.provider === 'openai'
    && setRes.autoTranslate === false,
    JSON.stringify({ provider: setRes && setRes.provider, auto: setRes && setRes.autoTranslate }));
  await optPage.close();

  /* 1. 打开目标页面 */
  const page = ctx.pages().find((p) => !p.url().startsWith('chrome-extension'))
    || (await ctx.newPage());
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('页面已打开：' + page.url());

  /* 2. 关键判据一：加载后【不自动翻译】。
   * 给足时间 —— 如果还有自动翻译残留，12 秒足够它开始注入译文。 */
  await page.waitForTimeout(12000);

  const autoCount = await page.evaluate(() =>
    document.querySelectorAll('.ct-trans').length);
  ok('页面加载后没有自动翻译（.ct-trans 数量 = 0）', autoCount === 0, autoCount + ' 条');

  /* 3. 关键判据二：页内开关在，且处于「翻译此页」（未翻译）状态 */
  const toggleVisible = await page.evaluate(() => {
    const el = document.querySelector('.ct-toggle');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  ok('页内开关存在且可见', toggleVisible);

  const label = await page.evaluate(() => {
    const el = document.querySelector('.ct-toggle');
    return el ? (el.shadowRoot.querySelector('.main .label') || {}).textContent || '' : '';
  });
  ok('开关文案是「翻译此页」（未翻译态）', label === '翻译此页', JSON.stringify(label));

  const status = await page.evaluate(() => {
    const el = document.querySelector('.ct-toggle');
    return el ? el.getAttribute('data-status') : null;
  });
  ok('开关状态 data-status = off', status === 'off', status);

  await page.screenshot({ path: path.join(OUT_DIR, 'e2e-remoteok-before.png') });
  console.log('已截图（点击前）：tools/bench-results/e2e-remoteok-before.png');

  /* 4. 用户点击开关 → 翻译开始 */
  // 首次使用会弹一次性引导气泡，先点掉「知道了」（不影响后续断言）
  const guideBtn = page.locator('.ct-toggle .cbtn--ok');
  if (await guideBtn.count() > 0 && await guideBtn.first().isVisible().catch(() => false)) {
    await guideBtn.first().click();
    await page.waitForTimeout(300);
  }

  await page.locator('.ct-toggle button.main').click();
  console.log('已点击「翻译此页」…');

  /* 5. 关键判据三：点击后译文出现 */
  let afterCount = 0;
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('.ct-trans').length > 0,
      { timeout: 45000 }
    );
    // 再等一小段让首批波次铺开，数字更有代表性
    await page.waitForTimeout(6000);
    afterCount = await page.evaluate(() =>
      document.querySelectorAll('.ct-trans').length);
  } catch (e) {
    // 保持 afterCount = 0，让下面统一给出失败详情
  }
  ok('点击开关后译文出现', afterCount > 0, afterCount + ' 条');

  const statusAfter = await page.evaluate(() => {
    const el = document.querySelector('.ct-toggle');
    return el ? el.getAttribute('data-status') : null;
  });
  ok('开关翻到 on 状态', statusAfter === 'on', statusAfter);

  const sample = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.ct-trans'))
      .slice(0, 3).map((n) => n.textContent.trim().slice(0, 30)));
  ok('译文内容来自引擎（含中文「译」标记）', sample.length > 0
    && sample.every((t) => /[\u4e00-\u9fff]/.test(t)), JSON.stringify(sample));

  await page.screenshot({ path: path.join(OUT_DIR, 'e2e-remoteok-after.png') });
  console.log('已截图（点击后）：tools/bench-results/e2e-remoteok-after.png');
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
console.log('全部通过：' + results.length + ' 项断言 —— 加载页面不自动翻译，点击开关才开始翻译');
