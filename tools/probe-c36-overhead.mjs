/*
 * 决定性探针 · C-36 量测开销的真实成本（真实 Chromium）
 * ==================================================================
 * 【背景】
 * C-36 给 placementFor 的 ③ 分支（横向不换行弹性容器）补了落点标
 * FLEX_ROW_RISK = 'flex-row-outside'。此前这些单元在 verifyBatch 里被
 * `!rec.risk → continue` 整条跳过（零量测）；补标之后它们进入第二级，
 * 每次批末都要过一遍 judgeOne —— 1 次译文节点 getBoundingClientRect
 * ＋ ≤(CLIP_HOPS+2) 跳祖先链回溯（layoutOf 有 per-element 缓存）。
 *
 * 【要量的命题】
 *   ① 单元成本：一个 flex-row 单元过一次 judgeOne 到底多少微秒？
 *   ② 每波成本：一页 N 个弹性行（招聘/电商列表页的典型形态），
 *      每次 verifyBatch 的增量开销是多少毫秒？占 16ms 帧预算多少？
 *   ③ 反复性：未搬走的单元（常见情形 = 绝大多数）rec.moved 恒为 false，
 *      **每一波都会重量** —— 开销是每波重复的，不是一次性的。
 *      这个性质由 verifyBatch 源码（1643–1650）保证，探针顺带断言钉住。
 *
 * 【为什么不用 A/B 改源码】
 * C-36 的全部增量 = 「带标单元 × judgeOne 单次成本」——A 组（无标）
 * 在 verifyBatch 里是纯 continue，成本为零，不用测。所以只需要在
 * **现行源码**上量 judgeOne 单元成本，不触碰 renderer.js（不触发
 * 并发写文件口令制），也省掉一次全量回归。
 *
 * 【预算阈值从哪来】
 * 帧预算 16ms（60fps）。批末几何判决每翻译波跑一次；同一波内还有
 * 提取、渲染、布局。给第二级几何判决的合理上限是帧预算的 1/3：
 *   · 单元中位成本 ≤ 50µs（现状估算是 1 次 gBCR + 缓存读，个位数微秒级，
 *     50µs 已是 5–10 倍余量；超了说明实现出了问题而不是判据太贵）
 *   · 100 个弹性行的页面，每波增量 ≤ 5ms（= 16ms × 1/3）
 * 两条都是「变异验证有牙齿」的阈值：超线即红，不许口头解释带过。
 *
 * 运行：
 *   NODE_PATH=<node_modules> node tools/probe-c36-overhead.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* ------------------------------------------------------------------
 * 夹具：模拟「招聘/电商列表页」的弹性行密集形态
 *   · 500 个普通流标签行（常见情形：挂出去就看得见，量完不动）
 *   · 30 个定高卡片里的标签行（少数真被裁，第一波就被搬走）
 *   · 200 个普通段落（对照组：第一级不圈选、零第二级成本）
 * ------------------------------------------------------------------ */
const N_ROWS = 500;
const N_CARDS = 30;
const N_PARAS = 200;

const CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff;
  font-family: system-ui, sans-serif; font-size: 16px; }
#stage { width: 760px; margin: 0 auto; padding: 16px; }
.row { display: flex; flex-direction: row; flex-wrap: nowrap;
  width: 100%; gap: 8px; margin: 4px 0; }
.row span { background: #eef; border-radius: 999px; padding: 4px 12px;
  font-size: 14px; white-space: nowrap; }
.card { height: 32px; overflow: hidden; border: 1px solid #ddd;
  border-radius: 12px; margin: 4px 0; }
.card .row { width: 100%; margin: 0; }
p.ctl { margin: 6px 0; }
`;

function buildFixture() {
  let rows = '';
  for (let i = 0; i < N_ROWS; i++) {
    rows += `<div class="row" id="r${i}"><span>Remote</span><span>Full-time</span><span>Senior L${i % 9}</span></div>\n`;
  }
  let cards = '';
  for (let i = 0; i < N_CARDS; i++) {
    cards += `<div class="card" id="c${i}"><div class="row" id="cr${i}"><span>Onsite</span><span>Hybrid</span><span>Lead L${i % 7}</span></div></div>\n`;
  }
  let paras = '';
  for (let i = 0; i < N_PARAS; i++) {
    paras += `<p class="ctl" id="p${i}">Paragraph control unit ${i} with some plain text content for the translator pipeline.</p>\n`;
  }
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>C-36 量测开销夹具</title><style>${CSS}</style></head>
<body><div id="stage">${rows}${cards}${paras}</div></body></html>`;
}

const INJECT = ['shared/constants.js', 'content/detector.js']
  .map((p) => path.join(ROOT, p));

/* ------------------------------------------------------------------ */
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail !== undefined ? ' :: ' + detail : ''));
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* 主测量：在页面里跑，全部用 performance.now() */
async function measure(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.setContent(buildFixture(), { waitUntil: 'load' });
  for (const p of INJECT) await page.addScriptTag({ path: p });
  await page.addScriptTag({ path: path.join(ROOT, 'content/renderer.js') });

  const out = await page.evaluate(({ nRows, nCards, nParas, REPS, WARMUP }) => {
    const med = (arr) => {
      const s = [...arr].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    const CT = window.CT;
    const R = CT.renderer;
    const S = Object.assign({}, CT.DEFAULT_SETTINGS, { displayMode: 'below' });

    // ---- ① 静态决策抽查（形状断言的数据来源） ----
    const probeIds = ['r0', 'r' + (nRows - 1), 'cr0', 'p0'];
    const plans = {};
    for (const id of probeIds) {
      const pl = R.placementFor(document.getElementById(id), S);
      plans[id] = { reason: pl.reason || null, risk: pl.risk || null };
    }

    // ---- ② 收集 + 渲染（与 content.js 波次循环同口径） ----
    const units = R.collectUnits(document.body, S);
    const byId = new Map();
    for (const u of units) byId.set(u.el.id, u);
    for (const u of units) {
      R.renderUnit(u.el, '【译】' + String(u.text || '').slice(0, 12), S, u.hash, u.plan);
    }

    // ---- ③ 第一波批末判决（定高卡片里的行在这一波被搬走） ----
    const allEls = units.map((u) => u.el);
    const firstMoved = R.verifyBatch(allEls);

    // ---- ④ 分组 ----
    const flexIds = [];
    for (let i = 0; i < nRows; i++) flexIds.push('r' + i);
    for (let i = 0; i < nCards; i++) flexIds.push('cr' + i);
    const flexEls = flexIds.map((id) => document.getElementById(id)).filter(Boolean);
    const ctlEls = [];
    for (let i = 0; i < nParas; i++) ctlEls.push(document.getElementById('p' + i));

    // 常见情形（未搬走的 flex 行）= 后续每波都要重量的人群
    const recurring = flexEls.filter((el) => {
      const rec = R.registry.get(el);
      return rec && rec.risk && !rec.moved;
    });

    // ---- ⑤ 计时一：verifyBatch 反复跑（真实「每波」路径） ----
    for (let i = 0; i < WARMUP; i++) R.verifyBatch(recurring);
    const batchMs = [];
    for (let i = 0; i < REPS; i++) {
      const t0 = performance.now();
      R.verifyBatch(recurring);
      batchMs.push(performance.now() - t0);
    }

    // ---- ⑥ 计时二：judgeOne 直测（单元成本交叉核对） ----
    const perUnitUs = [];
    for (let i = 0; i < REPS; i++) {
      const t0 = performance.now();
      for (const el of recurring) {
        R.judgeOne(el, R.registry.get(el));
      }
      perUnitUs.push((performance.now() - t0) * 1000 / recurring.length);
    }

    // ---- ⑦ 对照组确认：普通段落没有 risk 标（零第二级成本） ----
    const ctlWithRisk = ctlEls.filter((el) => {
      const rec = R.registry.get(el);
      return rec && rec.risk;
    }).length;

    // ---- ⑧ 终态审计（常见情形必须零动作、零不可见） ----
    const audit = R.auditSummary();

    return {
      plans,
      unitsTotal: units.length,
      flexTotal: flexEls.length,
      recurring: recurring.length,
      firstMoved,
      batchMedianMs: med(batchMs),
      batchMinMs: Math.min(...batchMs),
      unitMedianUs: med(perUnitUs),
      unitMinUs: Math.min(...perUnitUs),
      ctlWithRisk,
      auditTotal: audit.total || 0,
      auditByReason: audit.byReason || {}
    };
  }, { nRows: N_ROWS, nCards: N_CARDS, nParas: N_PARAS, REPS: 30, WARMUP: 3 });

  await page.close();
  return out;
}

/* ------------------------------------------------------------------ */
async function main() {
  const { chromium: pw } = require('playwright-core');
  const browser = await pw.launch({
    executablePath: 'C:/Users/Administrator/.workbuddy/binaries/cft/chrome-win64/chrome.exe',
    headless: true,
    args: ['--no-first-run', '--disable-gpu']
  });
  try {
    console.log('── C-36 量测开销探针（真实 Chromium）──');
    const m = await measure(browser);

    console.log(`\n页面规模：弹性行 ${m.flexTotal}（普通流 500 + 定高卡 30）、对照段落 ${N_PARAS}、单元总数 ${m.unitsTotal}`);
    console.log(`第一波搬走 ${m.firstMoved} 条（应为定高卡里的 30 条）`);
    console.log(`常见情形（每波重量人群）：${m.recurring} 条`);
    console.log(`\n【单元成本】judgeOne 中位 ${m.unitMedianUs.toFixed(1)}µs / 最快 ${m.unitMinUs.toFixed(1)}µs`);
    console.log(`【每波成本】verifyBatch(${m.recurring} 条) 中位 ${m.batchMedianMs.toFixed(2)}ms / 最快 ${m.batchMinMs.toFixed(2)}ms`);
    console.log(`【外推】100 行的列表页每波增量 ≈ ${(m.unitMedianUs * 100 / 1000).toFixed(2)}ms（16ms 帧预算的 ${((m.unitMedianUs * 100) / 16000 * 100).toFixed(1)}%）`);

    const PER_UNIT_BUDGET_US = 50;   // 现状估算 5–10 倍余量，见文件头
    const WAVE_BUDGET_MS = 5;        // 100 行 ≤ 16ms × 1/3

    check('① flex-row 单元第一级打了落点标（reason=flex-row, risk=flex-row-outside）',
      m.plans.r0.reason === 'flex-row' && m.plans.r0.risk === 'flex-row-outside'
      && m.plans['r' + 499].risk === 'flex-row-outside',
      JSON.stringify(m.plans.r0));
    check('① 定高卡里的行同样打标（走 ③ 分支，constrainsContent 判不出定高 —— L-1）',
      m.plans.cr0.reason === 'flex-row' && m.plans.cr0.risk === 'flex-row-outside',
      JSON.stringify(m.plans.cr0));
    check('① 对照段落零 risk 标（第二级成本为零）',
      m.ctlWithRisk === 0, '带标对照段落数=' + m.ctlWithRisk);

    check('② 该救的救：第一波恰好搬走 30 条（定高卡）',
      m.firstMoved === N_CARDS, 'firstMoved=' + m.firstMoved);

    check('③ 常见情形零动作零不可见：终态审计归零',
      m.auditTotal === 0, JSON.stringify(m.auditByReason));

    check('④ 【阈值有牙齿】judgeOne 单元中位成本 ≤ ' + PER_UNIT_BUDGET_US + 'µs',
      m.unitMedianUs <= PER_UNIT_BUDGET_US, m.unitMedianUs.toFixed(1) + 'µs');
    check('④ 【阈值有牙齿】100 行列表页每波增量 ≤ ' + WAVE_BUDGET_MS + 'ms',
      (m.unitMedianUs * 100 / 1000) <= WAVE_BUDGET_MS,
      (m.unitMedianUs * 100 / 1000).toFixed(2) + 'ms');

    const pass = results.every((r) => r.ok);
    console.log(`\n结论：${pass ? 'PASS' : 'FAIL'}（${results.filter((r) => r.ok).length}/${results.length}）`);
    process.exitCode = pass ? 0 : 1;
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
