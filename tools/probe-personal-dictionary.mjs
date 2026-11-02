/*
 * 决定性探针 · B2-1「个人词典学习闭环」（C-62 + C-63）
 * ==================================================================
 * 真实 Chrome + 真实扩展 + mock 引擎。覆盖 10 条断言（A-01/A-02/A-04/C-51/
 * CTO §4 / PM §七），逐项 console.log PASS/FAIL，末尾以非 0 退出码暴露失败。
 *
 * 【设计的真实交互链路（不绕过产品代码）】
 *   页面翻译（术语掩码 → mock 引擎 → 还原术语 to）→ 悬停译文 → 铅笔 chip
 *   → 纠错编辑器（预填现译文）→ 只改术语那一小段 → 提交 SAVE_CORRECTION
 *   → worker deriveLearnCandidate（G2 源侧反查）→ 计数键落候选级
 *   → 达阈值回带 suggestion → 内容层弹 .ct-learn-card → 加入 / 不用了。
 *
 * 【为什么用 G2（源侧反查）而非 G3（短单元）】
 *   计数键 = 候选级（normKey(cand.from)|cand.to|tgt）。同一候选要累积 3 次，
 *   必须来自 3 个不同的整句原文（corrections 整句精确短路 → 同一句第二次
 *   不会再走 worker）。基座术语（如 Deployment→部署）参与掩码，译文里自带
 *   该术语的中文，用户只把它改成新译法 → G2 反查命中同源词 → 候选恒定
 *   {Deployment → 新译法}。这正是 D-B2-01 §2.3 的可达性论证。
 *
 * 【断言纪律】只断言稳定信号：storage 键 / 消息字段 / DOM 存在性与关键词；
 *   不断言整段展示文案全文（防文案微调批量返工）。
 *
 * 运行：
 *   NODE_PATH=<node_workspace_node_modules> node tools/probe-personal-dictionary.mjs
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

/* 冷启动专项（#17）用：允许复用同一个 user-data-dir，做「冷 profile 首跑 vs
 * 同 profile 热跑」对照。默认不设 → 每次 mkdtemp 全新冷 profile（原行为）。
 * 复用时只删除本进程创建的目录。 */
const REUSE_PROFILE = process.env.CT_PROBE_PROFILE || '';

const STORAGE_CORR_STATS = 'ct.corrStats';
const TGT = 'zh-CN';
const THRESHOLD = 3;

/* ------------------------------------------------------------------
 * 断言收集
 * ------------------------------------------------------------------ */
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail !== undefined ? '  :: ' + detail : ''));
}
function normKey(from) { return String(from == null ? '' : from).trim().toLowerCase(); }
function statsKey(from, to, tgt) { return normKey(from) + '|' + to + '|' + (tgt || TGT); }

/* ------------------------------------------------------------------
 * mock 引擎 + 夹具页
 * ------------------------------------------------------------------ */
const engineHits = new Map();
function pageHtml(id, sentences) {
  const ps = sentences.map((s, i) => '<p id="' + id + i + '">' + s + '</p>').join('\n');
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>'
    + id + '</title></head>\n<body style="margin:24px;font-family:system-ui">\n'
    + '<h2>' + id + ' fixture</h2>\n' + ps + '\n</body></html>';
}

// 每个场景独立的夹具页（同会话内 K≤2 与跨场景隔离来自「不同页 = 不同 content 会话」）
const SENTENCES = {
  a1: ['Deployment is ready.', 'Check deployment status now.', 'Deployment finished successfully.'],
  a4: ['Latency is too high.', 'Reduce latency please.', 'Latency improved today.', 'Measure latency again.'],
  a5: ['Rollback completed.', 'Rollback the change now.', 'Rollback was successful.'],
  a9: ['Refactoring is needed here.', 'Start refactoring the module.', 'Refactoring takes time.'],
  a10: [
    'Headcount is limited.', 'Increase headcount now.', 'Headcount approval pending.',
    'Vesting starts today.', 'Vesting schedule updated.', 'Review vesting terms.',
    'Stakeholder meeting today.', 'Stakeholder feedback needed.', 'Notify stakeholder soon.'
  ],
  benign: ['The weather is nice today.', 'A short note about lunch.', 'Another harmless sentence here.'],
  learn: ['Deployment is ready.'],
  // G4 放弃 + 对照组（DL-8 防假绿）：
  //   g400 = 46 字符单短语（无换行、无句末标点、2 词）——若长度 ≤40 本可走 G3，
  //          因 > SPAN_MAX=40 被放弃（不建键/不计数/无 suggestion）；
  //   g401 = 'Widget'（6 字符短源词）——对照组，必须正常建键 +1。
  g4: ['Supercalifragilisticexpialidocious Development', 'Widget']
};

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
    const key = url.replace(/^\//, '');
    if (SENTENCES[key]) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(pageHtml(key, SENTENCES[key]));
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* ------------------------------------------------------------------
 * 浏览器 / 扩展
 * ------------------------------------------------------------------ */
async function findWorker(ctx) {
  let sw = null;
  for (let i = 0; i < 60 && !sw; i++) {
    sw = ctx.serviceWorkers().find((w) => w.url().includes('service-worker.js'))
      || ctx.backgroundPages().find((w) => w.url().includes('service-worker.js'));
    if (!sw) await new Promise((r) => setTimeout(r, 250));
  }
  return sw;
}

async function launch(profile) {
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath: CHROME,
    viewport: { width: 1200, height: 860 },
    args: [
      '--disable-extensions-except=' + ROOT,
      '--load-extension=' + ROOT,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--no-first-run', '--no-default-browser-check'
    ]
  });
  const sw = await findWorker(ctx);
  if (!sw) { await ctx.close(); throw new Error('扩展未加载，无法继续'); }
  const extId = sw.url().split('/')[2];
  return { ctx, extId };
}

const CT_SETTINGS_PATCH = (base) => ({
  provider: 'openai',
  openaiBaseUrl: base + '/v1',
  openaiApiKey: 'e2e-mock-key',
  openaiModel: 'mock',
  autoTranslate: false,
  cacheEnabled: false,
  selectionEnabled: false,
  targetLang: 'zh-CN',
  termBaseEnabled: true
});

/** 打开一个常驻扩展页（用于发消息 / 读 storage / 设置页 DOM） */
async function openExtPage(ctx, extId, file) {
  const p = await ctx.newPage();
  await p.goto('chrome-extension://' + extId + '/' + file, { waitUntil: 'domcontentloaded', timeout: 30000 });
  return p;
}

function makeBus(msgPage) {
  return {
    setSettings: (patch) => msgPage.evaluate((pt) => new Promise((r) => {
      chrome.runtime.sendMessage({ type: 'ct:set-settings', patch: pt },
        (x) => r(x && x.settings ? x.settings : x));
    }), patch),
    getSettings: () => msgPage.evaluate(() => new Promise((r) => {
      chrome.runtime.sendMessage({ type: 'ct:get-settings' }, (x) => r(x && x.settings ? x.settings : x));
    })),
    corrStats: () => msgPage.evaluate((k) => new Promise((r) => {
      chrome.storage.local.get(k, (v) => r(v[k] || null));
    }), STORAGE_CORR_STATS),
    termHash: (text) => msgPage.evaluate((t) => new Promise((r) => {
      chrome.runtime.sendMessage({ type: 'ct:translate', items: [{ text: t }], source: 'en', target: 'zh-CN' },
        (x) => r(x && x.termHash));
    }), text)
  };
}

/* ------------------------------------------------------------------
 * 页面交互
 * ------------------------------------------------------------------ */
async function waitDone(page) {
  await page.waitForFunction(() => {
    const b = document.querySelector('.ct-badge__text');
    const host = document.querySelector('.ct-toggle');
    const lb = host && host.shadowRoot && host.shadowRoot.querySelector('.label');
    const t = (b && b.textContent) || (lb && lb.textContent) || '';
    return /已译|翻译失败/.test(t);
  }, { timeout: 60000 });
  await page.waitForTimeout(500);
}

async function translatePage(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ct-toggle', { timeout: 20000 });
  const guide = page.locator('.ct-toggle .cbtn--ok');
  if (await guide.count() && await guide.first().isVisible().catch(() => false)) {
    await guide.first().click().catch(() => {});
    await page.waitForTimeout(200);
  }
  await page.locator('.ct-toggle button.main').click();
  await waitDone(page);
}

/**
 * 真实交互：悬停宿主 → 铅笔 chip → 编辑器 → 把现译文里的 fromTerm 改成 toTerm
 * → 提交。srcNeedle 用于确认编辑器绑定的是目标宿主（tip 含原文）。
 */
async function correctTerm(page, sel, srcNeedle, fromTerm, toTerm) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.hover(sel).catch(() => {});
    await page.waitForTimeout(250);
    const hasChip = await page.evaluate((s) => {
      const h = document.querySelector(s);
      if (h) h.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      const c = document.querySelector('.ct-corr-chip');
      if (c) c.click();
      return !!c;
    }, sel);
    if (!hasChip) { await page.waitForTimeout(200); continue; }

    let opened = false;
    try { await page.waitForSelector('.ct-corr-editor.ct-corr-on', { timeout: 3000 }); opened = true; } catch (e) { opened = false; }
    if (!opened) { await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(150); continue; }

    const tip = await page.evaluate(() => {
      const d = document.querySelector('.ct-corr-editor');
      return d ? ((d.querySelector('.ct-corr-tip') || {}).textContent || '') : '';
    });
    if (srcNeedle && tip.indexOf(srcNeedle) < 0) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(150);
      continue;
    }
    const cur = await page.inputValue('.ct-corr-ta');
    if (cur.indexOf(fromTerm) < 0) {
      await page.keyboard.press('Escape').catch(() => {});
      return { ok: false, reason: 'prev 里找不到待改术语 ' + fromTerm + ' :: ' + cur };
    }
    const nv = cur.replace(fromTerm, toTerm);
    await page.fill('.ct-corr-ta', nv);
    await page.locator('.ct-corr-ok').click();
    await page.waitForTimeout(600);
    return { ok: true, prev: cur, next: nv };
  }
  return { ok: false, reason: 'chip/编辑器 3 次重试仍未绑定到 ' + sel };
}

async function cardCount(page) {
  return await page.evaluate(() => document.querySelectorAll('.ct-learn-card').length);
}

/** 点击可能不存在的卡按钮：不因缺失中断整份探针（变异期要跑完全部断言） */
async function clickMaybe(page, sel) {
  try {
    await page.locator(sel).first().click({ timeout: 3000 });
    return true;
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------ */
async function main() {
  const server = await startServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  const ownProfile = !REUSE_PROFILE;
  const profile = REUSE_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'ct-pdict-'));

  let ctx = null;
  let msgPage = null;
  try {
    let L = await launch(profile);
    ctx = L.ctx;
    const extId = L.extId;
    msgPage = await openExtPage(ctx, extId, 'options/options.html');
    let bus = makeBus(msgPage);

    /* 从「已知初始态」开始：清掉可能残留的计数与整句纠错短路。
     * - 冷 profile 本就为空，无损；
     * - 复用 profile（CT_PROBE_PROFILE）时，避免上次运行的 ct.corrStats /
     *   corrections 污染断言（否则 n 会承接上次的 3 而非从 0 起）。 */
    await msgPage.evaluate(() => new Promise((r) => {
      chrome.storage.local.remove('ct.corrStats', () => r(true));
    }));
    await bus.setSettings(Object.assign(CT_SETTINGS_PATCH(base), { glossary: [], corrections: [] }));
    await new Promise((r) => setTimeout(r, 400));

    console.log('\n── B2-1 个人词典学习闭环探针（真实 Chrome + 真实扩展）──');

    const extraPages = [];

    /* ============ 断言 8：零「改」字（卡未打开态） / .ct-corr-hint = 0 ============ */
    {
      const p = await ctx.newPage();
      extraPages.push(p);
      await translatePage(p, base + '/benign');
      const hasGai = await p.evaluate(() => (document.body.innerText || '').indexOf('改') >= 0);
      const hint = await p.evaluate(() => document.querySelectorAll('.ct-corr-hint').length);
      check('8 零「改」字（普通翻译页 innerText 不含「改」）', !hasGai, 'hasGai=' + hasGai);
      check('8 .ct-corr-hint 恒 0（C-51 未复活）', hint === 0, 'count=' + hint);
      await p.close();
    }

    /* ============ A-01/A-02：1/2 次不弹卡、n 立即 flush 可读；第 3 次恰好 1 张卡 ============ */
    const beforeHash = await bus.termHash('Deployment is ready.');
    const pA = await ctx.newPage();
    extraPages.push(pA);
    await translatePage(pA, base + '/a1');

    const keyDeploy = statsKey('Deployment', '上线', TGT);

    const r1 = await correctTerm(pA, '#a10', 'Deployment is ready.', '部署', '上线');
    check('A-01 第 1 次提交成功（编辑器绑定正确宿主）', r1.ok, r1.ok ? 'prev=' + r1.prev : r1.reason);
    await new Promise((r) => setTimeout(r, 300));
    let stats = await bus.corrStats();
    const n1 = stats && stats[keyDeploy] ? stats[keyDeploy].n : null;
    const c1 = await cardCount(pA);
    check('A-02 第 1 次后 ct.corrStats[key].n == 1（立即 flush 可读）', n1 === 1, 'n=' + n1);
    check('A-02 第 1 次后无 .ct-learn-card', c1 === 0, 'cards=' + c1);

    const r2 = await correctTerm(pA, '#a11', 'Check deployment status now.', '部署', '上线');
    check('A-01 第 2 次提交成功', r2.ok, r2.ok ? 'prev=' + r2.prev : r2.reason);
    await new Promise((r) => setTimeout(r, 300));
    stats = await bus.corrStats();
    const n2 = stats && stats[keyDeploy] ? stats[keyDeploy].n : null;
    const c2 = await cardCount(pA);
    check('A-02 第 2 次后 ct.corrStats[key].n == 2（立即 flush 可读，非旧值）', n2 === 2, 'n=' + n2);
    check('A-02 第 2 次后仍无 .ct-learn-card', c2 === 0, 'cards=' + c2);

    const r3 = await correctTerm(pA, '#a12', 'Deployment finished successfully.', '部署', '上线');
    check('A-01 第 3 次提交成功', r3.ok, r3.ok ? 'prev=' + r3.prev : r3.reason);
    await new Promise((r) => setTimeout(r, 300));
    const c3 = await cardCount(pA);
    check('A-01 第 3 次后 .ct-learn-card 恰好 1 次', c3 === 1, 'cards=' + c3);
    const cardText = await pA.evaluate(() => {
      const d = document.querySelector('.ct-learn-card');
      return d ? d.textContent : '';
    });
    check('A2 §一 卡内文案含新关键词「修正成了」', cardText.indexOf('修正成了') >= 0, cardText.slice(0, 80));
    check('A2 §一 卡内旧关键词「一直改成」已消失', cardText.indexOf('一直改成') < 0, cardText.slice(0, 80));
    check('A2 §一 卡内文案含「别处」（显式说出泛化范围）', cardText.indexOf('别处') >= 0, cardText.slice(0, 80));
    check('PM §二 卡内文案含关键词「我的词典」', cardText.indexOf('我的词典') >= 0, cardText.slice(0, 80));
    /* B2 迭代 A2（G-9 盲区补齐）：确认卡**打开态**零「改」字（C-51）。
     * 此前 probe-corr-hint-click 只扫普通页、本探针断言 8 只测「卡未打开态」，
     * 两处一起漏掉卡片正文里的「改」字。变异验证：卡内注入「改」⇒ 本行必红。 */
    {
      const gaiOpen = await scanOpenLearnCardNoGai(pA);
      check('A2 §一 确认卡打开态零「改」字（C-51 / G-9）',
        gaiOpen.opened && !gaiOpen.hasGai,
        gaiOpen.opened ? ('hasGai=' + gaiOpen.hasGai + ' :: ' + gaiOpen.cardText) : 'card 未打开（前置失败）');
    }
    stats = await bus.corrStats();
    const n3 = stats && stats[keyDeploy] ? stats[keyDeploy].n : null;
    check('A-01 第 3 次后 n == 3', n3 === 3, 'n=' + n3);

    /* ============ 断言 3：确认才写入（glossary 条目字段严格 {from,to}） ============ */
    await clickMaybe(pA, '.ct-learn-ok');
    await new Promise((r) => setTimeout(r, 700));
    let st = await bus.getSettings();
    const gl = Array.isArray(st.glossary) ? st.glossary : [];
    const learned = gl.find((x) => normKey(x.from) === 'deployment');
    check('CTO §4① 点「加入」→ glossary 新增该条目', !!learned && learned.to === '上线',
      JSON.stringify(gl));
    check('CTO §7.4 学得条目字段严格 == [\'from\',\'to\']',
      !!learned && JSON.stringify(Object.keys(learned).sort()) === JSON.stringify(['from', 'to']),
      learned ? JSON.stringify(Object.keys(learned)) : 'no entry');

    /* ============ 断言 6：新页生效 + termHash 变化 ============ */
    const afterHash = await bus.termHash('Deployment is ready.');
    check('C-63 termHash 写入后与写入前不同（缓存自然失效）',
      beforeHash !== undefined && afterHash !== undefined && beforeHash !== afterHash,
      'before=' + beforeHash + ' after=' + afterHash);
    {
      const p = await ctx.newPage();
      extraPages.push(p);
      await translatePage(p, base + '/learn');
      const txt = await p.evaluate(() => {
        const t = document.querySelector('#learn0 .ct-trans') || document.querySelector('.ct-trans');
        return t ? t.textContent : '';
      });
      check('C-63 新页命中该源词 → 译文采用学得译法「上线」', txt.indexOf('上线') >= 0, txt.slice(0, 60));
      check('C-63 新页不再使用基座旧译「部署」', txt.indexOf('部署') < 0, txt.slice(0, 60));
      await p.close();
    }

    /* ============ 断言 7：可视可撤销（我的词典列表 + 单条删除 + termHash 再变） ============ */
    await msgPage.goto('chrome-extension://' + extId + '/options/options.html', { waitUntil: 'domcontentloaded' });
    await msgPage.waitForTimeout(400);
    const dictRow = await msgPage.evaluate(() => {
      const items = document.querySelectorAll('#dictList .dict-item');
      const first = items[0];
      return {
        count: items.length,
        from: first ? ((first.querySelector('.dict-item__from') || {}).textContent || '') : ''
      };
    });
    check('CTO §4③ 设置页「我的词典」出现该条目', dictRow.count >= 1 && dictRow.from === 'Deployment',
      JSON.stringify(dictRow));

    /* ============ 断言 7b：B1（DL-36 方案②′）来源 pill（真实浏览器） ============ */
    const pillLearned = await msgPage.evaluate(() => {
      const items = [...document.querySelectorAll('#dictList .dict-item')];
      const li = items.find((x) => {
        const f = x.querySelector('.dict-item__from');
        return f && f.textContent === 'Deployment';
      });
      const p = li && li.querySelector('.pill');
      return p ? { hidden: p.hidden, text: p.textContent } : null;
    });
    check('B1① 学得条目显示来源 pill「自动」（据 ct.corrStats.learned===true）',
      !!pillLearned && pillLearned.hidden === false && pillLearned.text === '自动',
      JSON.stringify(pillLearned));

    // 手填条目（经设置页写入 glossary = 非学得）**不得**显示标记
    {
      const sCur = await bus.getSettings();
      const withManual = (Array.isArray(sCur.glossary) ? sCur.glossary : []).concat([{ from: 'ManualTerm', to: '手填词' }]);
      await bus.setSettings({ glossary: withManual });
      await msgPage.goto('chrome-extension://' + extId + '/options/options.html', { waitUntil: 'domcontentloaded' });
      await msgPage.waitForTimeout(700);
      const manualPill = await msgPage.evaluate(() => {
        const items = [...document.querySelectorAll('#dictList .dict-item')];
        const li = items.find((x) => {
          const f = x.querySelector('.dict-item__from');
          return f && f.textContent === 'ManualTerm';
        });
        const p = li && li.querySelector('.pill');
        return p ? { hidden: p.hidden, text: p.textContent } : null;
      });
      check('B1① 手填条目无来源标记（pill hidden —— 非学得）',
        !!manualPill && manualPill.hidden === true, JSON.stringify(manualPill));
    }

    // 判据⑤：清空 ct.corrStats ⇒ 来源索引空 ⇒ 标记消失（证明来源确源自 corrStats）
    {
      await msgPage.evaluate(() => new Promise((r) => {
        chrome.storage.local.remove('ct.corrStats', () => r(true));
      }));
      await msgPage.goto('chrome-extension://' + extId + '/options/options.html', { waitUntil: 'domcontentloaded' });
      await msgPage.waitForTimeout(700);
      const clearedPill = await msgPage.evaluate(() => {
        const items = [...document.querySelectorAll('#dictList .dict-item')];
        const li = items.find((x) => {
          const f = x.querySelector('.dict-item__from');
          return f && f.textContent === 'Deployment';
        });
        const p = li && li.querySelector('.pill');
        return p ? { hidden: p.hidden } : null;
      });
      check('B1⑤ 清空 ct.corrStats 后学得标记消失（来源确源自 corrStats，非别处）',
        !!clearedPill && clearedPill.hidden === true, JSON.stringify(clearedPill));
    }

    // 复原：移除 B1 探针用的手填条目，避免污染后续 termHash 基线断言
    {
      const sR = await bus.getSettings();
      await bus.setSettings({
        glossary: (Array.isArray(sR.glossary) ? sR.glossary : []).filter((x) => normKey(x && x.from) !== 'manualterm')
      });
      await msgPage.goto('chrome-extension://' + extId + '/options/options.html', { waitUntil: 'domcontentloaded' });
      await msgPage.waitForTimeout(500);
    }
    await clickMaybe(msgPage, '#dictList .dict-item .dict-item__del');
    await msgPage.waitForTimeout(900);
    st = await bus.getSettings();
    const gl2 = Array.isArray(st.glossary) ? st.glossary : [];
    check('CTO §4③ 单条删除后 glossary 少一条', gl2.filter((x) => normKey(x.from) === 'deployment').length === 0,
      JSON.stringify(gl2));
    const delHash = await bus.termHash('Deployment is ready.');
    check('C-63 删除后 termHash 再变（回到写入前）',
      delHash !== afterHash && delHash === beforeHash,
      'before=' + beforeHash + ' after=' + afterHash + ' del=' + delHash);

    /* ============ 断言 4：拒绝不写 + dismissed + 同候选不再弹 ============ */
    {
      const p = await ctx.newPage();
      extraPages.push(p);
      await translatePage(p, base + '/a4');
      const keyLat = statsKey('Latency', '滞后', TGT);
      const cr = [
        await correctTerm(p, '#a40', 'Latency is too high.', '延迟', '滞后'),
        await correctTerm(p, '#a41', 'Reduce latency please.', '延迟', '滞后'),
        await correctTerm(p, '#a42', 'Latency improved today.', '延迟', '滞后')
      ];
      check('A-04 前置：Latency 三次纠错均提交成功', cr.every((x) => x.ok),
        cr.map((x) => (x.ok ? 'ok' : x.reason)).join(' | '));
      await new Promise((r) => setTimeout(r, 300));
      const cards = await cardCount(p);
      check('A-04 前置：第 3 次弹卡', cards === 1, 'cards=' + cards);
      await clickMaybe(p, '.ct-learn-cancel');   // 不用了
      await new Promise((r) => setTimeout(r, 500));
      const s = await bus.getSettings();
      const glL = (Array.isArray(s.glossary) ? s.glossary : []).filter((x) => normKey(x.from) === 'latency');
      check('A-04 点「不用了」→ glossary 不新增 Latency', glL.length === 0, JSON.stringify(s.glossary));
      const statsL = await bus.corrStats();
      check('A-04 ct.corrStats[key].dismissed === true（立即 flush）',
        !!(statsL && statsL[keyLat] && statsL[keyLat].dismissed === true),
        statsL && statsL[keyLat] ? JSON.stringify(statsL[keyLat]) : 'no key');

      const r4 = await correctTerm(p, '#a43', 'Measure latency again.', '延迟', '滞后');
      check('A-04 前置：第 4 次同候选提交成功', r4.ok, r4.ok ? 'ok' : r4.reason);
      await new Promise((r) => setTimeout(r, 500));
      const cards4 = await cardCount(p);
      check('A-04 第 4 次同候选不再弹卡（dismissed 生效）', cards4 === 0, 'cards=' + cards4);
      await p.close();
    }

    /* ============ 断言 10：每会话 K≤2（3 个候选达阈值 → 最多 2 张卡） ============ */
    {
      await bus.setSettings({ glossary: [] });
      await new Promise((r) => setTimeout(r, 300));
      const p = await ctx.newPage();
      extraPages.push(p);
      await translatePage(p, base + '/a10');
      // 三个候选：Headcount→人数 / Vesting→兑现 / Stakeholder→干系人
      const groups = [
        [['#a100', 'Headcount is limited.', '编制', '人数'],
         ['#a101', 'Increase headcount now.', '编制', '人数'],
         ['#a102', 'Headcount approval pending.', '编制', '人数']],
        [['#a103', 'Vesting starts today.', '归属', '兑现'],
         ['#a104', 'Vesting schedule updated.', '归属', '兑现'],
         ['#a105', 'Review vesting terms.', '归属', '兑现']],
        [['#a106', 'Stakeholder meeting today.', '利益相关方', '干系人'],
         ['#a107', 'Stakeholder feedback needed.', '利益相关方', '干系人'],
         ['#a108', 'Notify stakeholder soon.', '利益相关方', '干系人']]
      ];
      let shown = 0;
      const notes = [];
      for (let gi = 0; gi < groups.length; gi++) {
        for (const [sel, needle, fromT, toT] of groups[gi]) {
          const r = await correctTerm(p, sel, needle, fromT, toT);
          if (!r.ok) notes.push('g' + gi + ' ' + sel + ':' + r.reason);
        }
        await new Promise((r) => setTimeout(r, 400));
        const cards = await cardCount(p);
        notes.push('g' + gi + ' cards=' + cards);
        if (cards > 0) {
          shown += 1;
          // 关掉（不用了），让下一个候选有机会（会话预算 +1）
          await clickMaybe(p, '.ct-learn-cancel');
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      check('PM §七② 同会话 3 个候选达阈值 → 卡出现次数 ≤ 2（SESSION_MAX_CARDS=2）',
        shown <= 2 && shown === 2, 'shown=' + shown + ' | ' + notes.join(' ; '));
      // 第 3 个候选不排队：会话结束后它仍未弹（下个会话才可能）
      await p.close();
    }

    /* ============ 断言 5：跨会话可达（关闭浏览器再开，计数不丢） ============ */
    {
      await bus.setSettings({ glossary: [] });
      await new Promise((r) => setTimeout(r, 300));
      const p1 = await ctx.newPage();
      await translatePage(p1, base + '/a5');
      const c1 = await correctTerm(p1, '#a50', 'Rollback completed.', '回滚', '复原');
      const c2 = await correctTerm(p1, '#a51', 'Rollback the change now.', '回滚', '复原');
      await new Promise((r) => setTimeout(r, 300));
      const keyRb = statsKey('Rollback', '复原', TGT);
      let s = await bus.corrStats();
      const nBefore = s && s[keyRb] ? s[keyRb].n : null;
      const cardsBefore = await cardCount(p1);
      check('A-02 跨会话前置：会话 1 两次提交 n==2 且未弹卡',
        c1.ok && c2.ok && nBefore === 2 && cardsBefore === 0,
        'n=' + nBefore + ' cards=' + cardsBefore);
      await p1.close();

      // 关闭整个浏览器 → worker 内存归零；local 持久化
      await msgPage.close().catch(() => {});
      for (const ep of extraPages) { await ep.close().catch(() => {}); }
      await ctx.close();

      // 同一 profile 重开（真正的跨会话）
      L = await launch(profile);
      ctx = L.ctx;
      msgPage = await openExtPage(ctx, L.extId, 'options/options.html');
      bus = makeBus(msgPage);
      await bus.setSettings(CT_SETTINGS_PATCH(base));
      await new Promise((r) => setTimeout(r, 400));

      const s2 = await bus.corrStats();
      check('A-02 重开浏览器后 ct.corrStats 仍在（local 持久化，n 未丢）',
        !!(s2 && s2[keyRb] && s2[keyRb].n >= 2),
        s2 && s2[keyRb] ? JSON.stringify(s2[keyRb]) : 'no key');

      const p2 = await ctx.newPage();
      await translatePage(p2, base + '/a5');
      const c3 = await correctTerm(p2, '#a52', 'Rollback was successful.', '回滚', '复原');
      await new Promise((r) => setTimeout(r, 400));
      const cards = await cardCount(p2);
      const s3 = await bus.corrStats();
      const nAfter = s3 && s3[keyRb] ? s3[keyRb].n : null;
      check('A-02/R3 跨会话第 3 次 → 达阈值弹卡（计数跨会话不丢）', c3.ok && cards === 1,
        'cards=' + cards + ' n=' + nAfter + ' | ' + (c3.ok ? '' : c3.reason));
      await p2.close();
    }

    /* ============ 断言 11：G4 放弃分支（超 SPAN_MAX=40 的候选源词）+ 短源词对照组 ============ */
    {
      await bus.setSettings({ glossary: [] });
      await new Promise((r) => setTimeout(r, 300));
      const s0 = await bus.corrStats();
      const keysBefore = Object.keys(s0 || {}).length;

      const p = await ctx.newPage();
      await translatePage(p, base + '/g4');

      // 11a 放弃：46 字符长源词（无换行/无句末标点/2 词，仅因 >40 被拒）
      const longFrom = 'Supercalifragilisticexpialidocious Development';
      const ra = await correctTerm(p, '#g40', 'Supercalifragilisticexpialidocious', longFrom, '超长词开发');
      check('11a 前置：长源词单位纠错提交成功', ra.ok, ra.ok ? 'prev=' + ra.prev : ra.reason);
      await new Promise((r) => setTimeout(r, 400));
      const s1 = await bus.corrStats();
      const keysAfter = Object.keys(s1 || {}).length;
      const longKey = statsKey(longFrom, '超长词开发', TGT);
      check('11a 超 SPAN_MAX=40 → 不建键（corrStats 键数不变）', keysAfter === keysBefore,
        'before=' + keysBefore + ' after=' + keysAfter);
      check('11a 长源词键不存在（未计数）', !(s1 && s1[longKey]), longKey);
      const cardsA = await cardCount(p);
      check('11a 长源词无 suggestion / 不弹卡', cardsA === 0, 'cards=' + cardsA);

      // 11b 对照组：短源词 'Widget'（6 字符）必须正常建键 +1
      const rb = await correctTerm(p, '#g41', 'Widget', 'Widget', '控件');
      check('11b 前置：短源词单位纠错提交成功', rb.ok, rb.ok ? 'prev=' + rb.prev : rb.reason);
      await new Promise((r) => setTimeout(r, 400));
      const s2 = await bus.corrStats();
      // G3 回退的候选 = { from, to }（整体），故键的 to 段是「整段新译文」
      const shortKey = statsKey('Widget', rb.next, TGT);
      check('11b 对照组：短源词正常建键且 n==1（防「放弃」假绿，DL-8）',
        !!(s2 && s2[shortKey] && s2[shortKey].n === 1),
        'key=' + shortKey + ' st=' + JSON.stringify(s2 ? s2[shortKey] : null));
      await p.close();
    }

    const pass = results.every((r) => r.ok);
    const okN = results.filter((r) => r.ok).length;
    console.log('\n结论：' + (pass ? 'PASS' : 'FAIL') + '（' + okN + '/' + results.length + '）');
    process.exitCode = pass ? 0 : 1;
  } finally {
    try { if (msgPage && !msgPage.isClosed()) await msgPage.close(); } catch (e) { /* ignore */ }
    try { if (ctx) await ctx.close(); } catch (e) { /* ignore */ }
    server.close();
    if (ownProfile) fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
