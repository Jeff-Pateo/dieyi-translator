/*
 * 决定性探针 · C-45「折叠展开后内容不翻译」（真实 Chrome + 扩展加载 + mock 引擎）
 * ==================================================================
 * 【缺陷现场】（remoteok.com 实测取证）
 * 每个职位行的完整描述**始终在 DOM 里**，折叠 = 外层 TR 的 class 切换
 * （`tr.expand` → CSS `display:none`），零 childList。旧实现两处叠加缺陷：
 *   ① 采集端不跳过 class 隐藏子树 → remoteok 首页 1360 段不可见正文全部
 *      排队翻译 ⇒ 队列被看不见的内容灌满（实测 90s 到不了终态），
 *      用户展开折叠区看到的是「还没轮到」的纯英文；
 *   ② observer 不听 attributes ⇒ 即使跳过采集，展开动作也不可观察，
 *      展开后永远没人补翻。
 *
 * 【修复】① 采集端 BFS 对无盒子树（getClientRects 为空）整棵跳过；
 *         ② observer 补 attributes（filter class/style/hidden），
 *            展开时该子树经 700ms 防抖重扫补翻。
 *
 * 【要证的命题】（夹具 1:1 模拟 remoteok：TR 行 + class 切换折叠）
 *   ① 首扫只翻可见内容：可见段落有译文；隐藏折叠区**零打标**（队列轻了）；
 *   ② 点击展开（纯 class 切换，零 childList）→ 防抖重扫 → 折叠区内容被翻译上屏；
 *   ③ 折叠再展开：幂等 —— 译文块数量不翻倍、无重复译文；
 *   ④ 状态反馈到终态（开关/badge 任一表面）。
 *
 * 运行：NODE_PATH=<node_modules> node tools/probe-c45-collapsed-translate.mjs
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
const CHROME = process.env.CT_E2E_CHROME
  || 'C:/Users/Administrator/.workbuddy/binaries/cft/chrome-win64/chrome.exe';

/* ---------------- mock 引擎（300ms 延迟，让「补翻」可观察）+ 夹具页 ---------------- */
function startServer() {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const user = payload.messages[payload.messages.length - 1].content;
          const texts = JSON.parse(user).map((x) => (typeof x === 'string' ? x : x.s));
          setTimeout(() => {
            const t = texts.map((s) => '【译】' + s);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              id: 'mock', object: 'chat.completion', created: 1, model: 'mock',
              choices: [{ index: 0, finish_reason: 'stop',
                message: { role: 'assistant', content: JSON.stringify({ t }) } }],
              usage: { prompt_tokens: 0, completion_tokens: 0 }
            }));
          }, 300);
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: String(e) } }));
        }
      });
      return;
    }
    if (url === '/page') {
      // 模拟 remoteok：table + tr.job（可见）+ tr.expand（class 折叠，站点脚本点击时只切 class）
      let rows = '';
      for (let i = 1; i <= 6; i++) {
        rows += '<tr class="job" id="job' + i + '"><td class="pos"><h3>Job title number ' + i
          + ' senior engineer</h3><p>Company ' + i + ' hires remote staff.</p></td></tr>\n';
        rows += '<tr class="expand" id="exp' + i + '"><td><div class="description">';
        for (let j = 1; j <= 4; j++) {
          rows += '<p>Description paragraph ' + j + ' of job ' + i
            + ' with plenty of english words to translate.</p>';
        }
        rows += '</div></td></tr>\n';
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>c45</title><style>
table { border-collapse: collapse; }
tr.expand { display: none; }
tr.expand.active { display: table-row; }
td { padding: 8px; }
</style></head><body style="margin:24px;font-family:system-ui">
<h2>C-45 collapsed translate fixture</h2>
<table>${rows}</table>
<script>
// 模拟站点行为：点击职位行 → 只切 TR 的 class（零 childList，remoteok 同款）
document.addEventListener('click', function (e) {
  var job = e.target.closest('tr.job');
  if (!job) return;
  var n = job.id.replace('job', '');
  var exp = document.getElementById('exp' + n);
  if (exp) exp.classList.toggle('active');
});
</script></body></html>`);
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* ---------------- 断言 ---------------- */
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail !== undefined ? ' :: ' + detail : ''));
}

async function main() {
  const server = await startServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-c45-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath: CHROME,
    viewport: { width: 1100, height: 800 },
    args: [
      '--disable-extensions-except=' + ROOT,
      '--load-extension=' + ROOT,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--no-first-run', '--no-default-browser-check'
    ]
  });

  try {
    let sw = null;
    for (let i = 0; i < 40 && !sw; i++) {
      sw = ctx.serviceWorkers().find((w) => w.url().includes('service-worker.js'))
        || ctx.backgroundPages().find((w) => w.url().includes('service-worker.js'));
      if (!sw) await new Promise((r) => setTimeout(r, 250));
    }
    if (!sw) throw new Error('扩展未加载，无法继续');
    const extId = sw.url().split('/')[2];

    const optPage = await ctx.newPage();
    await optPage.goto('chrome-extension://' + extId + '/options/options.html',
      { waitUntil: 'domcontentloaded', timeout: 30000 });
    await optPage.evaluate((patch) => new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'ct:set-settings', patch },
        (r) => resolve(r && r.settings ? r.settings : r));
    }), {
      provider: 'openai',
      openaiBaseUrl: base + '/v1',
      openaiApiKey: 'e2e-mock-key',
      openaiModel: 'mock',
      autoTranslate: false,
      cacheEnabled: false,
      selectionEnabled: false
    });
    await optPage.close();

    const page = await ctx.newPage();
    await page.goto(base + '/page', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ct-toggle', { timeout: 20000 });
    await page.evaluate(() => {
      const host = document.querySelector('.ct-toggle');
      const ok = host && host.shadowRoot.querySelector('.cbtn--ok');
      if (ok) ok.click();
    });
    await page.locator('.ct-toggle button.main').click();

    console.log('\n── C-45 折叠区翻译探针（真实 Chrome）──');

    // 等首轮终态（badge 或开关闪现，双表面读）
    const terminalText = async () => page.evaluate(() => {
      const b = document.querySelector('.ct-badge__text');
      const host = document.querySelector('.ct-toggle');
      const lb = host && host.shadowRoot && host.shadowRoot.querySelector('.label');
      const t = ((b && b.textContent) || '') + '|' + ((lb && lb.textContent) || '');
      return /已译|翻译失败|异常/.test(t);
    });
    const t0 = Date.now();
    while (!(await terminalText()) && Date.now() - t0 < 30000) {
      await page.waitForTimeout(150);
    }
    check('④ 前置：首轮翻译到达终态（30s 内，可见内容轻队列）',
      await terminalText(), ((Date.now() - t0) / 1000).toFixed(1) + 's');

    /* ---- ① 首扫只翻可见内容；隐藏折叠区零打标 ---- */
    const s1 = await page.evaluate(() => {
      const visibleParas = [...document.querySelectorAll('td.pos p')];
      const visibleTranslated = visibleParas.filter((el) => el.querySelector('.ct-trans') || el.parentElement.querySelector('.ct-trans')).length;
      const hiddenParas = [...document.querySelectorAll('tr.expand:not(.active) .description p')];
      const hiddenMarked = hiddenParas.filter((el) =>
        el.hasAttribute('data-ct-src') || (el.parentElement && el.parentElement.hasAttribute('data-ct-src'))).length;
      const hiddenTrans = hiddenParas.filter((el) => el.querySelector('.ct-trans')).length;
      return { visibleParas: visibleParas.length, visibleTranslated, hiddenParas: hiddenParas.length, hiddenMarked, hiddenTrans };
    });
    check('① 首扫：可见内容已翻译（' + s1.visibleTranslated + '/' + s1.visibleParas + '）',
      s1.visibleParas > 0 && s1.visibleTranslated === s1.visibleParas,
      JSON.stringify(s1));
    check('① 首扫：隐藏折叠区零打标、零译文（跳过生效，队列不再被灌满）',
      s1.hiddenParas > 0 && s1.hiddenMarked === 0 && s1.hiddenTrans === 0,
      'hidden=' + s1.hiddenParas + ' marked=' + s1.hiddenMarked + ' trans=' + s1.hiddenTrans);

    /* ---- ② 点击展开（纯 class 切换）→ 防抖重扫 → 补翻 ---- */
    await page.evaluate(() => document.getElementById('job1').click());
    // 700ms 防抖 + 波次，留足时间
    const t2 = Date.now();
    let exp1 = null;
    while (Date.now() - t2 < 15000) {
      await page.waitForTimeout(400);
      exp1 = await page.evaluate(() => {
        const paras = [...document.querySelectorAll('#exp1 .description p')];
        return {
          active: document.getElementById('exp1').classList.contains('active'),
          total: paras.length,
          translated: paras.filter((el) => el.querySelector('.ct-trans')).length
        };
      });
      if (exp1.translated >= exp1.total) break;
    }
    check('② 前置：点击后折叠区已展开（纯 class 切换）', !!(exp1 && exp1.active), JSON.stringify(exp1 || {}));
    check('② 展开后折叠区内容被补翻（' + (exp1 ? exp1.translated : 0) + '/' + (exp1 ? exp1.total : 0) + '）',
      !!exp1 && exp1.total > 0 && exp1.translated === exp1.total, JSON.stringify(exp1 || {}));

    /* ---- ③ 折叠 → 再展开：幂等 ---- */
    await page.evaluate(() => document.getElementById('job1').click());   // 收起
    await page.waitForTimeout(1200);
    await page.evaluate(() => document.getElementById('job1').click());   // 再展开
    await page.waitForTimeout(2500);
    const s3 = await page.evaluate(() => {
      const paras = [...document.querySelectorAll('#exp1 .description p')];
      return {
        translated: paras.filter((el) => el.querySelector('.ct-trans')).length,
        transBlocks: document.querySelectorAll('#exp1 .ct-trans').length,
        // 译文块数应等于段落数（每段一个译文块），翻倍 = 重复渲染
        expected: paras.length
      };
    });
    check('③ 折叠再展开幂等：译文块不翻倍（' + s3.transBlocks + '/' + s3.expected + '）',
      s3.translated === s3.expected && s3.transBlocks === s3.expected, JSON.stringify(s3));

    const pass = results.every((r) => r.ok);
    console.log('\n结论：' + (pass ? 'PASS' : 'FAIL') + '（'
      + results.filter((r) => r.ok).length + '/' + results.length + '）');
    process.exitCode = pass ? 0 : 1;
  } finally {
    await ctx.close();
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
