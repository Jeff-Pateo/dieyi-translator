/*
 * A-07 排查探针 · 设置页 Pro 卡片渲染实测
 * 用途：用 Chrome for Testing 真实加载扩展，打开 options.html，
 *       数分组/卡片、抓「Pro 兑换码」文本与截图 —— 回答「用户为何看不到 Pro 卡片」。
 * 运行：NODE_PATH=<node_modules> node tools/probe-options-render.mjs
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-probe-opt-'));
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

const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto('chrome-extension://' + extId + '/options/options.html',
  { waitUntil: 'load', timeout: 30000 });
await page.waitForTimeout(1200);

const info = await page.evaluate(() => {
  const groups = [...document.querySelectorAll('details.group')];
  const cards = document.querySelectorAll('.card').length;
  const bodyText = document.body.innerText;
  return {
    title: document.title,
    groups: groups.map((g) => {
      const hd = g.querySelector('.group__hd');
      return {
        title: hd ? hd.querySelector('.group__t')?.textContent?.trim() : '(?)',
        open: g.open,
        top: Math.round(g.getBoundingClientRect().top)
      };
    }),
    cards,
    // v1.8.0：商业层已删除 —— 这里改为「残留检查」，应为空数组
    commercialResidue: ['groupPro', 'licenseCode', 'btnActivate', 'btnRemoveLicense',
      'licenseState', 'trialState', 'activateConfirm', 'devTrialPanel', 'jumpPro']
      .filter((id) => !!document.getElementById(id)),
    scriptTags: [...document.querySelectorAll('script')].map((s) => s.getAttribute('src') || '(inline)')
  };
});

console.log(JSON.stringify(info, null, 2));

// 展开所有分组后再数一次（防 details 收起）
await page.evaluate(() => {
  document.querySelectorAll('details.group').forEach((g) => { g.open = true; });
});
await page.waitForTimeout(200);
const expanded = await page.evaluate(() => ({
  commercialResidueAfterExpand: ['groupPro', 'licenseCode', 'btnActivate', 'licenseState', 'trialState']
    .filter((id) => !!document.getElementById(id)),
  bodyScrollH: document.body.scrollHeight
}));
console.log('展开全部分组后：' + JSON.stringify(expanded));

const shot = path.join(ROOT, 'tools', 'bench-results', 'probe-options.png');
fs.mkdirSync(path.dirname(shot), { recursive: true });
await page.screenshot({ path: shot, fullPage: true });
console.log('截图：' + shot);
console.log('控制台错误（' + errors.length + ' 条）：');
for (const e of errors) console.log('  ✗ ' + e);

await ctx.close();
