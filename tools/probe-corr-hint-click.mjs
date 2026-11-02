/*
 * 决定性探针 · C-51「页面不再展示『改』字」（真实 Chrome + 扩展加载 + mock 引擎）
 * ==================================================================
 * 【契约变更（C-51，2026-09-29 用户裁决）】
 * 用户指令「不想要在页面展示改字」——每轮翻译后自动亮 6 秒的「改」
 * 示意角标（.ct-corr-hint，v1.7.5 C-17 F2 引入、C-42/C-46 两轮增强）
 * **整体下线**；悬停 chip 图标从「改」单字改为铅笔「✎」；
 * 引导气泡文案同步（toggle.js）。本探针前身是 C-42 的 hint 可点性
 * 探针，C-51 后 hint 已不存在，契约翻写为「页内零改字 + 铅笔 chip
 * 入口完好」（文件名保留，护栏清单 A-13 复跑命令不变）。
 *
 * 【要证的命题】（全部真实交互，不是 dispatchEvent 兜底）
 *   ① 翻译完成后 .ct-corr-hint 数量 = 0（示意角标确已下线）；
 *   ② 页面上零「改」字（可见文本扫描 + chip 图标 = ✎ + aria-label 保留）；
 *   ③ 悬停译文 → 铅笔 chip 出现（真实 mousemove）；
 *   ④ 真实点击 chip → 编辑器打开，tip 带原文、输入框预填现译文；
 *   ⑤ 提交修正 → 屏上译文立即替换（纠错闭环不受下线影响）；
 *   ⑥ 重译同页：被修正的句子不再打引擎（组批前短路命中）。
 *
 * 运行：NODE_PATH=<node_modules> node tools/probe-corr-hint-click.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

// B2 迭代 A2（G-9）：公共断言「确认卡打开态零『改』字」（两支探针各调用一次）
import { scanOpenLearnCardNoGai } from './_learn-card-gai.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.CT_E2E_CHROME
  || 'C:/Users/Administrator/.workbuddy/binaries/cft/chrome-win64/chrome.exe';

/* ---------------- mock 引擎 + 夹具页 ---------------- */
const engineHits = new Map();
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
          for (const t of texts) engineHits.set(t, (engineHits.get(t) || 0) + 1);
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
    if (url === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>corr hint probe</title></head>
<body style="margin:24px;font-family:system-ui">
<h2>Corr hint click fixture</h2>
<p id="p0">The first paragraph talks about remote work policies.</p>
<p id="p1">The second paragraph discusses quarterly revenue results.</p>
<p id="p2">The third paragraph covers hiring plans for next year.</p>
<p id="p3">A fourth paragraph that will not get a hint badge attached.</p>
</body></html>`);
      return;
    }
    if (url === '/learnfix') {
      // B2 迭代 A2（G-9）：学习确认卡打开态夹具 —— 3 句含基座术语 Deployment
      // （→ 部署），供词级纠错 3 次达阈值弹卡，再复扫「卡打开态零改字」。
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>learn card fixture</title></head>
<body style="margin:24px;font-family:system-ui">
<h2>learn card fixture</h2>
<p id="l0">Deployment is ready.</p>
<p id="l1">Check deployment status now.</p>
<p id="l2">Deployment finished successfully.</p>
</body></html>`);
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

async function waitDone(page) {
  await page.waitForFunction(() => {
    
    const b = document.querySelector('.ct-badge__text');

          const host = document.querySelector('.ct-toggle');

          const lb = host && host.shadowRoot && host.shadowRoot.querySelector('.label');

          const t = (b && b.textContent) || (lb && lb.textContent) || '';

          return /已译|翻译失败/.test(t);
  }, { timeout: 60000 });
  await page.waitForTimeout(600);   // 终态节拍缓冲（C-51 后无 hint 挂出，纯稳定等待）
}

async function main() {
  const server = await startServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-corr-hint-'));
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

    // 注入设置：mock 引擎 + 不自动翻译
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
      selectionEnabled: false,
      // B2 迭代 A2（G-9）：学习卡夹具需基座术语掩码（Deployment→部署）+ 目标语
      targetLang: 'zh-CN',
      termBaseEnabled: true
    });
    await optPage.close();

    const page = await ctx.newPage();
    await page.goto(base + '/page', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ct-toggle', { timeout: 20000 });
    await page.locator('.ct-toggle button.main').click();
    await waitDone(page);

    console.log('\n── C-51 页内零改字 + 铅笔 chip 探针（真实 Chrome）──');

    // ① 示意角标确已下线
    const hintCount = await page.evaluate(() => document.querySelectorAll('.ct-corr-hint').length);
    check('① 翻译完成后零示意角标（.ct-corr-hint = 0，C-51 下线生效）', hintCount === 0,
      'count=' + hintCount);

    // ② 页面上零「改」字（chip 尚未创建——corrEnsureChip 惰性，图标形态断言见 ③）
    const visibleGai = await page.evaluate(() =>
      (document.body.innerText || '').indexOf('改') >= 0);
    check('② 页面可见文本零「改」字', !visibleGai, 'visibleGai=' + visibleGai);
    const guideHasGai = await page.evaluate(() => {
      const host = document.querySelector('.ct-toggle');
      if (!host || !host.shadowRoot) return false;
      return host.shadowRoot.textContent.indexOf('「改」') >= 0;
    });
    check('② 引导气泡文案零「改」字（toggle.js 同步）', !guideHasGai, 'guideHasGai=' + guideHasGai);

    // ③ 悬停译文 → 铅笔 chip 出现（真实 mousemove；dispatchEvent 只做兜底）
    await page.mouse.move(4, 4);
    await page.waitForTimeout(300);
    const box2 = await page.locator('#p1').boundingBox();
    await page.mouse.move(box2.x + box2.width / 2, box2.y + Math.min(box2.height / 2, 12));
    await page.waitForTimeout(500);
    const chipOn = await page.evaluate(() => {
      const c = document.querySelector('.ct-corr-chip');
      if (!(c && c.classList.contains('ct-corr-on'))) {
        const p = document.querySelector('#p1');
        if (p) p.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      }
      const c2 = document.querySelector('.ct-corr-chip');
      return !!(c2 && c2.classList.contains('ct-corr-on'));
    });
    check('③ 悬停译文 → 铅笔 chip 出现', chipOn, String(chipOn));

    // ③b chip 图标形态（chip 已由悬停创建）：✎ + aria-label 保留
    const glyph = await page.evaluate(() => {
      const chip = document.querySelector('.ct-corr-chip');
      return {
        chipText: chip ? chip.textContent : '(no chip)',
        aria: chip ? chip.getAttribute('aria-label') : null
      };
    });
    check('③b chip 图标 = ✎（不是「改」）', glyph.chipText === '✎', glyph.chipText);
    check('③b aria-label 保留（读屏不受图标变更影响）',
      glyph.aria === '修正这句翻译', String(glyph.aria));

    // ④ 真实点击 chip → 编辑器打开
    if (chipOn) {
      const chipBox = await page.evaluate(() => {
        const r = document.querySelector('.ct-corr-chip').getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await page.mouse.click(chipBox.x, chipBox.y);
      await page.waitForTimeout(400);
    } else {
      await page.evaluate(() => document.querySelector('.ct-corr-chip').click());
      await page.waitForTimeout(400);
    }
    const ed = await page.evaluate(() => {
      const d = document.querySelector('.ct-corr-editor');
      if (!d || !d.classList.contains('ct-corr-on')) return null;
      return {
        tip: (d.querySelector('.ct-corr-tip') || {}).textContent || '',
        val: (d.querySelector('.ct-corr-ta') || {}).value || ''
      };
    });
    check('④ 点击 chip → 修正编辑器打开', !!ed, ed ? 'ok' : 'editor 未出现');
    check('④ tip 带原文（原文：…）', !!(ed && /原文：/.test(ed.tip)), ed ? ed.tip.slice(0, 30) : '');
    check('④ 输入框预填现译文（【译】…）', !!(ed && ed.val.startsWith('【译】')), ed ? ed.val.slice(0, 20) : '');

    // ⑤ 提交修正 → 屏上立即替换（修正文本刻意不含「改」字，零改字断言可复扫）
    const NEW_TEXT = '【正】这是用户修正后的译文。';
    await page.evaluate((t) => {
      const ta = document.querySelector('.ct-corr-ta');
      ta.value = t;
    }, NEW_TEXT);
    await page.locator('.ct-corr-ok').click();
    await page.waitForTimeout(700);
    // data-ct-src 存的是 srcHash（renderer.js:622），按译文内容反查被修正宿主
    const replaced = await page.evaluate(() => {
      const blocks = document.querySelectorAll('.ct-trans');
      for (const b of blocks) {
        if ((b.textContent || '').indexOf('这是用户修正后的译文') >= 0) {
          const host = b.closest('[data-ct-src]') || b.parentElement;
          return {
            host: host ? (host.getAttribute('data-ct-src') || '').slice(0, 10) : '(no host)',
            text: (b.textContent || '').slice(0, 40)
          };
        }
      }
      return null;
    });
    check('⑤ 提交修正 → 屏上译文立即替换', !!replaced,
      replaced ? replaced.host + ' / ' + replaced.text : '未找到修正译文块');
    const gaiAfter = await page.evaluate(() =>
      (document.body.innerText || '').indexOf('改') >= 0);
    check('⑤ 修正落屏后页面仍零「改」字', !gaiAfter, 'visibleGai=' + gaiAfter);

    // ⑥ 纠错闭环仍落库：被修正那句（p1）再次翻译不再打引擎（组批前短路）
    const SENT2 = 'The second paragraph discusses quarterly revenue results.';
    const hitsBefore = engineHits.get(SENT2) || 0;
    check('⑥ 前置：该句在下线前确实被引擎翻过（hits ≥ 1）', hitsBefore >= 1, String(hitsBefore));
    await page.keyboard.press('Escape');
    await page.locator('.ct-toggle button.main').click();   // 关
    await page.waitForTimeout(400);
    await page.locator('.ct-toggle button.main').click();   // 开（重译）
    await waitDone(page);
    const hitsAfter = engineHits.get(SENT2) || 0;
    check('⑥ 重译同页：被修正的句子不再打引擎（组批前短路命中）',
      hitsAfter === hitsBefore, 'hits ' + hitsBefore + ' → ' + hitsAfter);

    /* ==================================================================
     * B2 迭代 A2（G-9 盲区补齐）：确认卡**打开态**零「改」字（C-51）
     * ------------------------------------------------------------------
     * 本探针此前只扫「普通翻译页」的 body.innerText（②），**从不触发确认卡
     * 路径** ⇒ 卡内文案的「改」字长期漏网（另一支 probe-personal-dictionary
     * 的断言 8 亦只测「卡未打开态」）。此处真实走完学习闭环触发确认卡，
     * 再调用公共断言复扫；变异验证：卡内注入「改」⇒ 本行必红。
     * ================================================================== */
    {
      const lp = await ctx.newPage();
      await lp.goto(base + '/learnfix', { waitUntil: 'domcontentloaded' });
      await lp.waitForSelector('.ct-toggle', { timeout: 20000 });
      await lp.locator('.ct-toggle button.main').click();
      await lp.waitForFunction(() => {
        const b = document.querySelector('.ct-badge__text');
        const host = document.querySelector('.ct-toggle');
        const lb = host && host.shadowRoot && host.shadowRoot.querySelector('.label');
        const t = (b && b.textContent) || (lb && lb.textContent) || '';
        return /已译|翻译失败/.test(t);
      }, { timeout: 60000 });
      await lp.waitForTimeout(500);

      const units = [
        ['#l0', 'Deployment is ready.'],
        ['#l1', 'Check deployment status now.'],
        ['#l2', 'Deployment finished successfully.']
      ];
      let okCount = 0;
      for (const [sel, needle] of units) {
        for (let attempt = 0; attempt < 3; attempt++) {
          await lp.hover(sel).catch(() => {});
          await lp.waitForTimeout(250);
          const had = await lp.evaluate((s) => {
            const h = document.querySelector(s);
            if (h) h.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            const c = document.querySelector('.ct-corr-chip');
            if (c) c.click();
            return !!c;
          }, sel);
          if (!had) { await lp.waitForTimeout(200); continue; }
          let opened = false;
          try { await lp.waitForSelector('.ct-corr-editor.ct-corr-on', { timeout: 3000 }); opened = true; } catch (e) { opened = false; }
          if (!opened) { await lp.keyboard.press('Escape').catch(() => {}); await lp.waitForTimeout(150); continue; }
          const tip = await lp.evaluate(() => {
            const d = document.querySelector('.ct-corr-editor');
            return d ? ((d.querySelector('.ct-corr-tip') || {}).textContent || '') : '';
          });
          if (needle && tip.indexOf(needle) < 0) { await lp.keyboard.press('Escape').catch(() => {}); await lp.waitForTimeout(150); continue; }
          const cur = await lp.inputValue('.ct-corr-ta');
          if (cur.indexOf('部署') < 0) { await lp.keyboard.press('Escape').catch(() => {}); break; }
          await lp.fill('.ct-corr-ta', cur.replace('部署', '上线'));
          await lp.locator('.ct-corr-ok').click();
          await lp.waitForTimeout(600);
          okCount++;
          break;
        }
      }
      await lp.waitForTimeout(400);
      const cards = await lp.evaluate(() => document.querySelectorAll('.ct-learn-card').length);
      check('A2 §一 前置：Deployment 三次纠错后弹出确认卡',
        okCount >= 3 && cards === 1, 'ok=' + okCount + ' cards=' + cards);
      const gaiOpen = await scanOpenLearnCardNoGai(lp);
      check('A2 §一 确认卡打开态零「改」字（C-51 / G-9，probe-corr-hint-click 调用点）',
        gaiOpen.opened && !gaiOpen.hasGai,
        gaiOpen.opened ? ('hasGai=' + gaiOpen.hasGai + ' :: ' + gaiOpen.cardText) : 'card 未打开');
      await lp.close();
    }

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
