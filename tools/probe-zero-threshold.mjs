/*
 * 零 AI 知识门槛 · 契约探针（Z1 / Z4 / Z5）
 * ------------------------------------------------------------------
 * 对应文档：deliverables/product-strategy/proposal-zero-ai-threshold-2026-10-12.md
 *   Z1（C-59）设置页信息分层 —— 小白首屏零 AI 术语
 *   Z4（C-61）激活成功确认态 —— 成没成 / 永久不永久 / 换电脑还算不算
 *   Z5（C-60）错误文案人话化 —— 不出现术语，且每条给出一个可点的动作
 *
 * 断言分两类：
 *   A. 真机 DOM（Chrome for Testing 加载扩展后打开设置页）
 *      —— 首屏可视文本用 innerText：折叠 <details> 的内容不计入，
 *         这正是 Z1 的判据来源（内容仍在 DOM 里，需要的人展开就能看到）。
 *   B. 静态源码（读 content/ background/ 源文件）
 *      —— 错误文案属于「运行时才出现」的面，用源码断言把口径锁死。
 *
 * 运行：node tools/probe-zero-threshold.mjs
 * 退出码：0 = 全绿；1 = 有失败（禁止带着失败发布）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.CT_E2E_CHROME
  || 'C:/Users/Administrator/.workbuddy/binaries/cft/chrome-win64/chrome.exe';

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}

/* ------------------------------------------------------------------
 * B. 静态源码断言（不需要浏览器，先跑 —— 失败得快）
 * ------------------------------------------------------------------ */
console.log('【B】错误文案口径（静态源码）');

const contentSrc = fs.readFileSync(path.join(ROOT, 'content', 'content.js'), 'utf8');
const providersSrc = fs.readFileSync(path.join(ROOT, 'background', 'providers.js'), 'utf8');
const workerSrc = fs.readFileSync(path.join(ROOT, 'background', 'service-worker.js'), 'utf8');

check('Z5 · 「请检查网络或引擎配置」已下线（术语 + 无动作的老文案）',
  !contentSrc.includes('请检查网络或引擎配置'));
check('Z5 · 失败提示保留稳定词头「翻译失败」+ 给出可点动作「点击重试」',
  contentSrc.includes('翻译失败 · 点击重试'));
check('Z5 · 点击重试接到真实翻译通道（handleCommand translateNow）',
  /handleCommand\(\{\s*action:\s*'translateNow'\s*\}\)/.test(contentSrc));
check('Z5 · 异常分支不再把原始报错摊给用户（「翻译异常：」已下线）',
  !contentSrc.includes("'翻译异常：'"));
check('Z5 · 引擎切换理由不含「降级」术语',
  !providersSrc.includes('已降级到 Google 翻译'));
check('Z5 · 熔断提示不含「熔断」「更换引擎」术语',
  !workerSrc.includes('翻译引擎熔断中') && !workerSrc.includes('更换引擎'));

/* ------------------------------------------------------------------
 * A. 真机 DOM 断言
 * ------------------------------------------------------------------ */
console.log('\n【A】设置页真机 DOM');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-probe-zero-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  executablePath: CHROME,
  viewport: { width: 1400, height: 900 },
  args: [
    '--disable-extensions-except=' + ROOT,
    '--load-extension=' + ROOT,
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
if (!sw) { console.log('✗ 扩展未加载'); await ctx.close(); process.exit(1); }
const extId = sw.url().split('/')[2];

const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto('chrome-extension://' + extId + '/options/options.html',
  { waitUntil: 'load', timeout: 30000 });
await page.waitForTimeout(1200);

const first = await page.evaluate(() => {
  const adv = document.getElementById('groupAdvanced');
  const t = document.body.innerText || '';
  return {
    hasAdvanced: !!adv,
    advancedOpen: adv ? adv.open : null,
    // 首屏可视文本（折叠区不计入）
    hitDeepL: t.includes('DeepL'),
    hitOpenAI: t.includes('OpenAI'),
    hitConcurrency: t.includes('并发'),
    hitApiKey: t.includes('API Key'),
    // 首屏必须仍然有小白真正需要的东西
    hasDisplayMode: !!document.getElementById('displayMode'),
    hasTargetLang: !!document.getElementById('targetLang'),
    hasActivateBtn: !!document.getElementById('btnActivate'),
    // 安装横幅（首装可见）不得出现 AI 术语
    banner: (document.getElementById('welcome') || {}).textContent || '',
    // 确认卡片：存在、初始隐藏、文案含三件事实
    confirmExists: !!document.getElementById('activateConfirm'),
    confirmHidden: document.getElementById('activateConfirm')
      ? document.getElementById('activateConfirm').hidden : null,
    confirmText: (document.getElementById('activateConfirm') || {}).textContent || ''
  };
});

check('Z1 · 「高级设置」分组存在', first.hasAdvanced);
check('Z1 · 「高级设置」默认收起（折叠区不计入首屏）', first.advancedOpen === false,
  'open=' + first.advancedOpen);
check('Z1 · 首屏不含「DeepL」', !first.hitDeepL);
check('Z1 · 首屏不含「OpenAI」', !first.hitOpenAI);
check('Z1 · 首屏不含「并发」', !first.hitConcurrency);
check('Z1 · 首屏不含「API Key」', !first.hitApiKey);
check('Z1 · 首屏仍保留小白真正要用的控件（显示方式 / 翻译方向 / 激活入口）',
  first.hasDisplayMode && first.hasTargetLang && first.hasActivateBtn);
check('Z1 · 安装横幅不解释「模型」「降级」（首装第一眼的文案）',
  !first.banner.includes('模型') && !first.banner.includes('降级'),
  first.banner.trim().slice(0, 40));
check('Z4 · 激活确认卡片存在且默认隐藏（只在激活成功那一刻出现）',
  first.confirmExists && first.confirmHidden === true);
check('Z4 · 确认卡片答全三件事：永久 / 重新激活',
  first.confirmText.includes('永久') && first.confirmText.includes('重新激活'));

/* 展开高级区：内容必须还在（分层≠删除） */
const expanded = await page.evaluate(() => {
  const adv = document.getElementById('groupAdvanced');
  adv.open = true;
  const t = document.body.innerText || '';
  return {
    hitDeepL: t.includes('DeepL'),
    hasProvider: !!document.getElementById('provider'),
    hasConcurrency: !!document.getElementById('concurrency'),
    hasOpenaiKey: !!document.getElementById('openaiApiKey'),
    note: (adv.querySelector('.group__note') || {}).textContent || ''
  };
});
check('Z1 · 展开高级区后技术选项可见（分层不是删除）',
  expanded.hitDeepL && expanded.hasProvider && expanded.hasConcurrency && expanded.hasOpenaiKey);
check('Z1 · 高级区有「不懂别改」的引导语', expanded.note.includes('不用改'));

const shot = path.join(ROOT, 'tools', 'bench-results', 'probe-zero-threshold.png');
fs.mkdirSync(path.dirname(shot), { recursive: true });
await page.screenshot({ path: shot, fullPage: true });

console.log('\n控制台错误（' + errors.length + ' 条）：');
for (const e of errors) console.log('  ✗ ' + e);
if (errors.length) { fail++; console.log('  ✗ 设置页存在运行时错误（计入失败）'); }

console.log('\n截图：' + shot);
console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
await ctx.close();
process.exit(fail ? 1 : 0);
