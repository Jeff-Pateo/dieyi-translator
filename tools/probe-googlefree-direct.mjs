/*
 * 直连诊断探针 · google-free 引擎挂起时 worker 的收尾行为（C-21/C-23 验证）
 * 绕过页面 badge，直接在扩展页面上下文调 ct:translate，测：
 *   ① 响应耗时（预期 ≈ 超时×ceil(CB/并发) 两波内）
 *   ② 回执 failures / notice 是否落终态
 * 运行：NODE_PATH=<node_modules> node tools/probe-googlefree-direct.mjs
 */
import fs from 'node:fs';
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-probe-gf-'));
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
if (!sw) { console.log('✗ 扩展未加载'); process.exit(1); }
const extId = sw.url().split('/')[2];
console.log('✓ 扩展已加载 extId=' + extId);

const optPage = await ctx.newPage();
await optPage.goto('chrome-extension://' + extId + '/options/options.html',
  { waitUntil: 'domcontentloaded', timeout: 30000 });

// 写设置：google-free、并发 4、缓存关
await optPage.evaluate(() => new Promise((resolve) => {
  chrome.runtime.sendMessage({ type: 'ct:set-settings', patch: {
    provider: 'google-free', cacheEnabled: false, concurrency: 4, autoTranslate: false
  } }, () => resolve());
}));

// 直连调翻译：8 条 → 8 批（google 一次一段），引擎不可达时预期：
//   第一波 4 批 30s 超时失败 → 第二波 4 批 → 连续 8 ≥ 6 熔断 → 剩余中止
//   响应应在 ~60s 落终态：failures=8 + notice 含「连续超时」（C-60 文案人话化后，旧词「连续无响应」已改，2026-10-13 对齐）
console.log('发起 ct:translate（8 条，google-free，真实网络）…');
const out = await optPage.evaluate(() => new Promise((resolve) => {
  const t0 = Date.now();
  const items = [];
  for (let i = 0; i < 8; i++) items.push({ text: 'diagnostic sentence number ' + i });
  chrome.runtime.sendMessage({ type: 'ct:translate', source: 'en', target: 'zh-CN', items },
    (r) => resolve({ elapsed: Date.now() - t0, r: r }));
}));

console.log('耗时 ' + out.elapsed + 'ms');
console.log('回执：' + JSON.stringify({
  ok: out.r && out.r.ok,
  provider: out.r && out.r.provider,
  failures: out.r && out.r.failures,
  notice: out.r && out.r.notice,
  translationsLen: out.r && out.r.translations ? out.r.translations.length : null
}));

const verdictFail = out.r && out.r.failures === 8;
// C-60 文案人话化后对齐，2026-10-13：「连续无响应」→「连续超时」，old 词会让本判定恒假。
const verdictNotice = out.r && typeof out.r.notice === 'string' && out.r.notice.indexOf('连续超时') >= 0;
const verdictTime = out.elapsed < 120000;
console.log('判定：全失败落账=' + verdictFail + '，notice 终态=' + verdictNotice + '，及时收尾(<120s)=' + verdictTime);
console.log((verdictFail && verdictNotice && verdictTime) ? '✓ C-21/C-23 在真实网络下生效' : '✗ 真实网络下仍未按设计收尾');

await ctx.close();
process.exit((verdictFail && verdictNotice && verdictTime) ? 0 : 1);
