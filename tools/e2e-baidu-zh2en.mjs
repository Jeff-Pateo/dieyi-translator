/*
 * 决定性探针 · 中译英/中译日真实页面（百度新闻）——测试总攻新方向
 * ==================================================================
 * 【背景】
 * 此前所有真实站点探针都是「外译中」方向（remoteok 系）。用户指令：
 * 测试要覆盖「将中文翻译成英文或其他语言」的场景 —— 方向翻转后，
 * 采集（中文不进 protect 名单？可译性判定对 CJK 的口径）、
 * 目标语言落盘（lang 属性）、渲染链路都是新的细节风险面。
 *
 * 【要量的命题】（真实页面 news.baidu.com + 本地 mock 引擎，零外部调用）
 *   B1  中文页首轮自动翻译到达终态（双表面读取）；
 *   B2  打标数收敛（连续 2s 无增长）且 ≥ 20（新闻页链接/段落密集）；
 *   B3  方向抽样：宿主原文含中文 [\u4e00-\u9fff] 且配对 .ct-trans 存在
 *       ——「源真的是中文」而不是碰巧翻了一堆英文残留；
 *   B4  方向落盘：译文块 lang 属性 === 目标语言（renderer 硬契约）；
 *   B5  幂等：终态后 3s 译文块数量不增长（观察者不吃自己的渲染）；
 *   B6  显示原文往返：点开关主按钮 → 原文恢复（ct-trans 归零）→
 *       再点 → 重译到终态（C-44 状态机在中文方向同样走通）；
 *   B7  滚动往返：滚到底再回顶，打标数不减少、终态不破坏；
 *   J1  换目标语言重跑（targetLang: 'ja'）：终态 + lang=ja + 译块存在
 *       ——「其他语言」方向抽查。
 *
 * 【mock 引擎】
 * 与 e2e-remoteok-ops 相同：本地 /v1/chat/completions 返回「【译】+ 原文」。
 * mock 前缀与语言无关 —— 本探针验证的是**链路与方向语义**（采集/渲染/
 * lang 落盘/状态机），翻译质量本身由 providers 单测与线上模型保证。
 *
 * 【页面稳定性纪律】
 * 真实站点会改版：所有断言用「计数收敛 + 存在性」口径，不钉具体数字；
 * 抽样断言留余量（10 抽 8）。
 * ==================================================================
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
/* ⚠️ 默认必须用 Chrome for Testing：branded Chrome 137+ 会静默忽略
 * --load-extension（extension_service 拒绝命令行装扩展，SW 永不注册，
 * 症状是「扩展未加载」）。CFT 不受此限。 */

/* ---------------- mock 引擎（零外部调用） ---------------- */
function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url.split('?')[0] === '/v1/chat/completions') {
      let body = ''; req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const user = payload.messages[payload.messages.length - 1].content;
          const texts = JSON.parse(user).map((x) => (typeof x === 'string' ? x : x.s));
          const t = texts.map((s) => '【译】' + s);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 'm', object: 'chat.completion', created: 1, model: 'mock',
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ t }) } }],
            usage: { prompt_tokens: 0, completion_tokens: 0 } }));
        } catch (e) { res.writeHead(500); res.end(String(e)); }
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* ---------------- 断言 ---------------- */
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail !== undefined ? ' :: ' + detail : ''));
}

/** 等翻译终态（双表面：徽标 / 开关 shadow label 闪现） */
async function waitTerminal(page, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const done = await page.evaluate(() => {
      const b = document.querySelector('.ct-badge__text');
      const host = document.querySelector('.ct-toggle');
      const lb = host && host.shadowRoot && host.shadowRoot.querySelector('.label');
      const t = ((b && b.textContent) || '') + '|' + ((lb && lb.textContent) || '');
      return /已译|翻译失败|异常/.test(t);
    }).catch(() => true);
    if (done) return (Date.now() - t0) / 1000;
    if (Date.now() - t0 > (timeoutMs || 60000)) return -1;
    await page.waitForTimeout(300);
  }
}

/** 打标数收敛（连续 stable 次读数无增长；同时盯打标与译块两个计数） */
async function waitMarkedConverged(page, stableRounds, timeoutMs) {
  const t0 = Date.now();
  let prev = -1, prevT = -1, stable = 0;
  for (;;) {
    const n = await page.evaluate(() => ({
      marked: document.querySelectorAll('[data-ct-src]').length,
      trans: document.querySelectorAll('.ct-trans').length
    })).catch(() => ({ marked: -1, trans: -1 }));
    if (n.marked === prev && n.trans === prevT) stable++;
    else { stable = 0; prev = n.marked; prevT = n.trans; }
    if (stable >= (stableRounds || 4)) return { marked: prev, trans: prevT };
    if (Date.now() - t0 > (timeoutMs || 40000)) return { marked: prev, trans: prevT };
    await page.waitForTimeout(500);
  }
}

/** 方向抽样：宿主原文（textContent）含中文且配对译文块存在；译文块 lang 属性分布
 *  ⚠️ data-ct-src 存的是 srcHash 不是原文 —— 中文判定必须读宿主 textContent */
async function directionSample(page, sampleN) {
  return page.evaluate((n) => {
    const hosts = [...document.querySelectorAll('[data-ct-src]')]
      .filter((el) => /[\u4e00-\u9fff]/.test(el.textContent || ''));
    const picked = hosts.slice(0, n);
    const paired = picked.filter((el) => {
      const inSelf = el.querySelector('.ct-trans');
      const sibling = el.parentElement && el.parentElement.querySelector(':scope > .ct-trans');
      const next = el.nextElementSibling && el.nextElementSibling.classList.contains('ct-trans');
      return !!(inSelf || sibling || next);
    });
    const langs = {};
    for (const t of document.querySelectorAll('.ct-trans')) {
      const l = t.getAttribute('lang') || '(none)';
      langs[l] = (langs[l] || 0) + 1;
    }
    return {
      markedTotal: document.querySelectorAll('[data-ct-src]').length,
      zhHosts: hosts.length,
      sampled: picked.length,
      paired: paired.length,
      transBlocks: document.querySelectorAll('.ct-trans').length,
      langs
    };
  }, sampleN);
}

async function main() {
  const server = await startServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-zh2en-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath: CHROME,
    viewport: { width: 1300, height: 900 },
    args: [
      '--disable-extensions-except=' + ROOT,
      '--load-extension=' + ROOT,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--no-first-run', '--no-default-browser-check'
    ]
  });

  try {
    let sw = null;
    // MV3 惰性注册：先开一个空白页把扩展上下文拉起来，再等 SW
    const warm = await ctx.newPage();
    await warm.goto('about:blank').catch(() => {});
    for (let i = 0; i < 80 && !sw; i++) {
      sw = ctx.serviceWorkers().find((w) => w.url().includes('service-worker.js'))
        || ctx.backgroundPages().find((w) => w.url().includes('service-worker.js'));
      if (!sw) await new Promise((r) => setTimeout(r, 250));
    }
    if (!sw) throw new Error('扩展未加载');
    const extId = sw.url().split('/')[2];
    await warm.close().catch(() => {});

    /** 设置目标语言并打开页面 */
    async function openWithLang(page, targetLang) {
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
        targetLang,
        autoTranslate: true,
        cacheEnabled: false,
        selectionEnabled: false,
        maxUnitsPerPage: 20000
      });
      await optPage.close();
      await page.goto('https://news.baidu.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    }

    /* ============ Pass A：中译英 ============ */
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    console.log('\n── 百度新闻 · 中译英（真实站点 + mock 引擎）──');
    await openWithLang(page, 'en');

    const t1 = await waitTerminal(page, 90000);
    check('B1 中文页首轮终态到达', t1 >= 0, t1 >= 0 ? t1.toFixed(1) + 's' : '90s 超时');

    // 页面异步内容会持续触发增量补翻（这是正确行为）：等 marked+trans 双收敛再断言
    const conv = await waitMarkedConverged(page, 4, 40000);
    check('B2 打标收敛且覆盖充分（≥20）', conv.marked >= 20, conv.marked + ' 标 / ' + conv.trans + ' 译块');

    const dir = await directionSample(page, 10);
    check('B3 方向抽样：中文宿主配对译文块（10 抽 8）',
      dir.sampled >= 5 && dir.paired >= Math.min(8, dir.sampled) * 0.8,
      JSON.stringify(dir));

    const langEn = dir.langs['en'] || 0;
    check('B4 方向落盘：译文块 lang="en"（硬契约）',
      dir.transBlocks > 0 && langEn === dir.transBlocks,
      langEn + '/' + dir.transBlocks + ' lang 分布=' + JSON.stringify(dir.langs));

    const before5 = await page.evaluate(() => document.querySelectorAll('.ct-trans').length);
    await page.waitForTimeout(3000);
    const after5 = await page.evaluate(() => document.querySelectorAll('.ct-trans').length);
    check('B5 幂等：双收敛后 3s 译块数不增长', after5 === before5, before5 + ' → ' + after5);

    /* B6 显示原文往返 */
    const st1 = await page.evaluate(() => {
      const host = document.querySelector('.ct-toggle');
      const main = host && host.shadowRoot && host.shadowRoot.querySelector('.main');
      if (main) main.click();
      return !!main;
    });
    await page.waitForTimeout(800);
    const restored = await page.evaluate(() => ({
      trans: document.querySelectorAll('.ct-trans').length,
      marked: document.querySelectorAll('[data-ct-src]').length,
      label: (() => {
        const host = document.querySelector('.ct-toggle');
        const lb = host && host.shadowRoot && host.shadowRoot.querySelector('.label');
        return lb ? lb.textContent : '(no label)';
      })()
    }));
    check('B6a 显示原文：点开关主按钮 → 原文恢复（ct-trans 归零）',
      st1 && restored.trans === 0, JSON.stringify(restored));

    /* B6a2（C-54 新契约）：autoTranslate 开启时，手动回原文后视图必须保持 ——
     * 修复前此处会被观察者自动重译覆盖（闪现「已译 1 段」），用户无法停留在原文。
     * 等 3.5s：译块数必须保持 0、标记数不得增长（防异步重译）。 */
    await page.waitForTimeout(3500);
    const hold = await page.evaluate(() => ({
      trans: document.querySelectorAll('.ct-trans').length,
      marked: document.querySelectorAll('[data-ct-src]').length,
      label: (() => {
        const host = document.querySelector('.ct-toggle');
        const lb = host && host.shadowRoot && host.shadowRoot.querySelector('.label');
        return lb ? lb.textContent : '(no label)';
      })()
    }));
    check('B6a2 原文视图保持（C-54）：3.5s 内零重译、开关仍为「翻译此页」',
      hold.trans === 0 && hold.marked <= restored.marked && /翻译此页/.test(hold.label),
      JSON.stringify({ hold, base: restored.marked }));

    const st2 = await page.evaluate(() => {
      const host = document.querySelector('.ct-toggle');
      const main = host && host.shadowRoot && host.shadowRoot.querySelector('.main');
      if (main) main.click();
      return !!main;
    });
    // ⚠️ 不能用 waitTerminal：上一轮的徽标终态文案（「已译 N 段」）还挂着，
    // 会秒匹配假绿。改为等译块数量恢复到重译前水位并收敛。
    let recov = null;
    const t0b = Date.now();
    for (;;) {
      recov = await page.evaluate(() => ({
        trans: document.querySelectorAll('.ct-trans').length,
        marked: document.querySelectorAll('[data-ct-src]').length
      })).catch(() => null);
      if (recov && recov.trans >= (dir.transBlocks || 1) * 0.9) {
        const conv2 = await waitMarkedConverged(page, 4, 30000);
        recov = { trans: conv2.trans, marked: conv2.marked };
        break;
      }
      if (Date.now() - t0b > 90000) break;
      await page.waitForTimeout(400);
    }
    check('B6b 再点重译：回到终态且译块恢复', st2 && !!recov && recov.trans >= (dir.transBlocks || 1) * 0.9,
      JSON.stringify(recov) + '（重译前 ' + dir.transBlocks + ' 译块）');

    /* B7 滚动往返 */
    const pre7 = await page.evaluate(() => document.querySelectorAll('[data-ct-src]').length);
    await page.evaluate(() => new Promise((res) => {
      let y = 0; const step = () => {
        y += 800; window.scrollTo(0, y);
        if (y < document.body.scrollHeight) setTimeout(step, 120);
        else { window.scrollTo(0, 0); setTimeout(res, 400); }
      }; step();
    }));
    const post7 = await waitMarkedConverged(page, 4, 30000);
    check('B7 滚动往返：打标不丢失、终态保持',
      post7.marked >= pre7, pre7 + ' → ' + post7.marked + ' 标');

    await page.close();

    /* ============ Pass B：中译日（其他语言抽查） ============ */
    const page2 = await ctx.newPage();
    console.log('\n── 百度新闻 · 中译日（targetLang=ja 抽查）──');
    await openWithLang(page2, 'ja');
    const tJ = await waitTerminal(page2, 90000);
    await waitMarkedConverged(page2, 4, 40000);
    const dirJ = await directionSample(page2, 10);
    const langJa = dirJ.langs['ja'] || 0;
    check('J1 中译日：终态 + lang="ja" + 译块存在',
      tJ >= 0 && dirJ.transBlocks > 0 && langJa === dirJ.transBlocks,
      '终态 ' + (tJ >= 0 ? tJ.toFixed(1) + 's' : '超时') + '，lang 分布=' + JSON.stringify(dirJ.langs));
    await page2.close();

    check('X1 全程无页面异常（pageerror=0）', pageErrors.length === 0,
      pageErrors.slice(0, 2).join(' | ') || '0');

    const pass = results.every((r) => r.ok);
    console.log('\n结论：' + (pass ? 'PASS' : 'FAIL') + '（' + results.filter((r) => r.ok).length + '/' + results.length + '）');
    process.exitCode = pass ? 0 : 1;
  } finally {
    await ctx.close().catch(() => {});
    server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
