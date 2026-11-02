/*
 * 决定性探针 · C-43「同屏两个翻译进度」（真实 Chrome + 扩展加载 + mock 引擎）
 * ==================================================================
 * 【缺陷现场】（用户截图）
 * 页内开关胶囊显示「621 / 1272」的同时，右下角徽标又显示「翻译中 621…」
 * —— 同一个事实显示两次（L-2 家族的呈现层形态）。
 *
 * 【修复】进度单一来源（content.js showProgressBadge / statusOnToggle）：
 *   · 开关展开在场 → 进度归开关（busyText），徽标让位（隐藏）；
 *   · 开关不在场或已收起（收起态 .label display:none，数字不可见）→ 徽标保留；
 *   · C-44 起成功终态同样一体化：展开在场 → 开关闪现 3.2s；徽标是回退面；
 *     错误/试用到期始终走徽标（需要点击出路与长停留）。
 *
 * 【要证的命题】
 *   ① 开关展开在场时翻译：徽标全程不可见，进度只出现在开关（shadow .label）；
 *      —— 同一时刻两处都出现进度 = 缺陷复现；
 *   ② 开关收起后重译：徽标显示「翻译中 i / N」（收起态开关无数字，不许修成零进度）；
 *   ③ 终态不受让位影响（收起态 = 徽标回退面）：徽标照常显示「已译 N 段」；
 *   ④ C-44 状态一体化：展开在场时成功终态闪现在开关 label（已译…）且徽标
 *      不出现（互斥）；闪现结束 label 回落「显示原文」。
 *
 * 运行：NODE_PATH=<node_modules> node tools/probe-c43-single-progress.mjs
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

/* ---------------- mock 引擎（带延时，制造可采样的 busy 窗口）+ 夹具页 ---------------- */
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
          // 500ms 延时：让「翻译中」状态持续存在，轮询才采得到样
          setTimeout(() => {
            const t = texts.map((s) => '【译】' + s);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              id: 'mock', object: 'chat.completion', created: 1, model: 'mock',
              choices: [{ index: 0, finish_reason: 'stop',
                message: { role: 'assistant', content: JSON.stringify({ t }) } }],
              usage: { prompt_tokens: 0, completion_tokens: 0 }
            }));
          }, 500);
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: String(e) } }));
        }
      });
      return;
    }
    if (url === '/page') {
      // 40 段：首波 24 + 第二波 16 → 至少两次进度刷新，busy 窗口 >1s
      let ps = '';
      for (let i = 0; i < 40; i++) {
        ps += '<p>Paragraph number ' + i + ' carries some sample English text.</p>\n';
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>c43</title></head>'
        + '<body style="margin:24px;font-family:system-ui"><h2>C-43 single progress fixture</h2>'
        + ps + '</body></html>');
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

/** 读进度现场：徽标可见性 + 开关 shadow 的 busy 态与标签文案 */
async function snapshot(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.ct-badge');
    const badgeOn = !!(el && el.classList.contains('ct-badge--on'));
    const bTxt = badgeOn && el ? ((el.querySelector('.ct-badge__text') || {}).textContent || '').trim() : '';
    const host = document.querySelector('.ct-toggle');
    const sr = host && host.shadowRoot;
    const lb = sr && sr.querySelector('.label');
    return {
      badgeOn, bTxt,
      toggleBusy: !!(sr && host.getAttribute('data-status') === 'busy'),
      collapsed: !!(host && host.getAttribute('data-collapsed') === '1'),
      label: ((lb && lb.textContent) || '').trim()
    };
  });
}

async function waitDoneBadge(page, timeout) {
  await page.waitForFunction(() => {
    
    const b = document.querySelector('.ct-badge__text');

          const host = document.querySelector('.ct-toggle');

          const lb = host && host.shadowRoot && host.shadowRoot.querySelector('.label');

          const t = (b && b.textContent) || (lb && lb.textContent) || '';

          return /已译|翻译失败/.test(t);
  }, { timeout: timeout || 60000 });
}

async function main() {
  const server = await startServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-c43-'));
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
    // 关掉首次引导气泡（若出现），避免遮挡
    await page.evaluate(() => {
      const host = document.querySelector('.ct-toggle');
      const ok = host && host.shadowRoot.querySelector('.cbtn--ok');
      if (ok) ok.click();
    });
    await page.waitForTimeout(300);

    console.log('\n── C-43 翻译进度单一来源探针（真实 Chrome）──');

    /* ---- ① 开关展开在场：徽标让位，进度只在开关 ---- */
    let samples = [];
    let dupSeen = false;
    let toggleProgressSeen = false;
    let terminalOn = '';   // C-44：终态落在哪个表面（'toggle' | 'badge'）
    await page.locator('.ct-toggle button.main').click();
    let pollErr = null;
    const poll = (async () => {
      try {
        while (true) {
          const s = await snapshot(page);
          samples.push(s);
          const busyRe = /翻译中|^\d+ \/ \d+$/;
          const onBadge = s.badgeOn && busyRe.test(s.bTxt);
          const onToggle = s.toggleBusy && busyRe.test(s.label);
          if (onToggle) toggleProgressSeen = true;
          if (onBadge && onToggle) dupSeen = true;
          if (/已译|翻译失败/.test(s.bTxt)) { terminalOn = 'badge'; break; }
          if (/已译|翻译失败/.test(s.label)) { terminalOn = 'toggle'; break; }   // C-44 闪现
          await page.waitForTimeout(60);
        }
      } catch (e) { pollErr = e; }
    })();
    await waitDoneBadge(page, 60000);
    await poll;
    if (pollErr) throw pollErr;
    check('① 前置：过程中开关侧出现过数字进度（busy 可采样）', toggleProgressSeen,
      'samples=' + samples.length);
    check('① 开关展开在场时徽标全程让位（无同屏双进度）', !dupSeen,
      'dup=' + dupSeen + '，badge 样本=' + samples.filter((s) => s.badgeOn).length);
    if (dupSeen) {
      const bad = samples.filter((s) => s.badgeOn && s.toggleBusy);
      console.log('    缺陷样本：', JSON.stringify(bad.slice(0, 3)));
    }

    /* ---- ④ C-44 状态一体化：展开在场时成功终态闪现在开关，徽标不出现 ---- */
    check('④ C-44：展开在场 → 成功终态闪现在开关 label（已译…）', terminalOn === 'toggle', terminalOn);
    check('④ C-44：同一终态不出现在徽标上（互斥）',
      !samples.some((s) => s.badgeOn && /已译|翻译失败/.test(s.bTxt)),
      'badge 终态样本=' + samples.filter((s) => s.badgeOn && /已译|翻译失败/.test(s.bTxt)).length);
    // 闪现结束后 label 回落「显示原文」
    await page.waitForTimeout(3600);
    const labelAfterFlash = await page.evaluate(() => {
      const sr = document.querySelector('.ct-toggle').shadowRoot;
      return ((sr.querySelector('.label') || {}).textContent || '').trim();
    });
    check('④ C-44：闪现结束后 label 回落「显示原文」', labelAfterFlash === '显示原文', labelAfterFlash);

    /* ---- ② 开关收起后重译：徽标保留（不许修成零进度） ---- */
    // 收起：「⋯」菜单 → 收起为圆点
    await page.evaluate(() => {
      const sr = document.querySelector('.ct-toggle').shadowRoot;
      sr.querySelector('.tool--more').click();
    });
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const sr = document.querySelector('.ct-toggle').shadowRoot;
      const item = sr.querySelector('.menu__i--collapse');
      if (item) item.click();
    });
    await page.waitForTimeout(300);
    const collapsedNow = await page.evaluate(() =>
      document.querySelector('.ct-toggle').getAttribute('data-collapsed'));
    check('② 前置：开关已收起', collapsedNow === '1', 'data-collapsed=' + collapsedNow);

    // 关 → 开（重译），采样徽标
    let badgeBusySeen = false;
    let badgeBusyText = '';
    await page.locator('.ct-toggle button.main').click();   // 关
    await page.waitForTimeout(500);
    await page.locator('.ct-toggle button.main').click();   // 开（重译）
    const poll2 = (async () => {
      try {
        while (true) {
          const s = await snapshot(page);
          if (s.badgeOn && /翻译中/.test(s.bTxt)) { badgeBusySeen = true; badgeBusyText = s.bTxt; }
          if (/已译|翻译失败/.test(s.bTxt)) break;
          if (!s.collapsed && /已译|翻译失败/.test(s.label)) break;   // 防御：意外展开时别死等
          await page.waitForTimeout(60);
        }
      } catch (e) { /* 与 poll1 同理：主流程错误优先暴露 */ }
    })();
    await waitDoneBadge(page, 60000);
    await poll2;
    check('② 收起态重译：徽标显示「翻译中 i / N」（零进度禁令）', badgeBusySeen, badgeBusyText);

    /* ---- ③ 终态徽标不受让位影响 ---- */
    const finalBadge = await page.evaluate(() => {
      const b = document.querySelector('.ct-badge__text');
      return b ? (b.textContent || '').trim() : '(gone)';
    });
    check('③ 终态徽标照常显示「已译 N 段」', /已译 \d+ 段/.test(finalBadge), finalBadge);

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
