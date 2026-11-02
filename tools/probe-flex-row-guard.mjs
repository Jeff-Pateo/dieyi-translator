/*
 * 决定性探针 · C-36「横向弹性行落点标」的 A/B 对照（真实 Chromium）
 * ==================================================================
 * 【背景】
 * P-1 落地后，criteria-counterexample 的对抗式清点（docs/P-1-免检通道复查.md
 * 「免检 A」）发现：placementFor 的 ③ 分支（单元自身是横向不换行弹性容器 →
 * 把译文挂到容器之后）是一次**跨父节点落点变更**，却**不打 risk 标** ——
 * verifyBatch 的 `!rec.risk → continue` 把它整条跳过，第二级从不回看。
 * 与 P-1 刚清掉的免检通道形状完全相同（同族第 4 次）。C-36 的修法是给它补
 * `FLEX_ROW_RISK = 'flex-row-outside'`（落点标，**不计入** rescuedFromClip）。
 *
 * 【要证的命题】
 *   ① 无净行为变化：常见情形（挂出去就看得见）→ 第二级量完不动作，
 *      一个字节都不动 —— 这是 C-36 最大的风险点（此前零成本，现在多一次量测）；
 *   ② 该救的救：挂出去的落点真被裁时，第二级必须把它搬走并复验通过；
 *   ③ 口径不串味：落点标触发的搬迁**不得**计入 rescuedFromClip。
 *
 * 【为什么必须是真实浏览器】
 * 与 probe-clip-channel-ab.mjs 同一条理由（L-17）：搬迁的落点判据
 * `escapeAnchor(el, t)` 只认真实矩形，jsdom 里恒为零矩形、走不通。
 *
 * 【两组夹具】
 *   ① row1 —— 普通流里的标签行（3 个 pill 的横向 flex）。
 *      落点挂在行容器之后、完全可见 → 两组都应「量完不动」。
 *   ② row2 —— **定高 + overflow:hidden 的卡片**里同样的标签行。
 *      关键：定高（height 使用值）+ overflow:hidden 的盒子，
 *      `constrainsContent` 判不出来（L-1：height 是使用值，判据只认
 *      max-height/line-clamp 的**声明**），所以 clipInfo 不会把它当裁切容器，
 *      单元照走 ③ 分支（flex-row）；但译文挂到行容器之后，几何上**真的**
 *      越出了那张定高卡片 → judgeOne 判 spills-host → relocate 必须接管。
 *      这是「flex-row 落点被裁」能被构造出来的**唯一**自然形态，
 *      也是真实站点最常见的那种（卡片定高 + 内部一行标签）。
 *
 * 【A 组怎么来的】
 * 把当前源码 ③ 分支里的 `, risk: FLEX_ROW_RISK` 逐字删掉（C-36 之前的写法），
 * mustFind 防呆：找不到就直接 exit 1，别悄悄测了个空气。
 *
 * 运行：
 *   NODE_PATH=<node_modules> node tools/probe-flex-row-guard.mjs
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
 * 夹具
 * ------------------------------------------------------------------ */
const CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 16px; }
#stage { width: 720px; margin: 0 auto; padding: 16px; }

/* ① 常见情形：普通流里的标签行（横向不换行 flex） */
.row { display: flex; flex-direction: row; flex-wrap: nowrap;
  width: 600px; gap: 8px; }
.row span { background: #eef; border-radius: 999px; padding: 4px 12px;
  font-size: 14px; white-space: nowrap; }

/* ② 该救的救：定高卡片里的标签行。
   height + overflow:hidden 但**没有** max-height / line-clamp ——
   constrainsContent 判不出（L-1），clipInfo 不算它裁切容器，
   单元照走 flex-row 分支；但译文挂到行后几何上真越界。
   高度必须压到「行高 + 译文高」以下（32 < 25+20），否则根本裁不到。 */
#card2 { height: 32px; overflow: hidden; border: 1px solid #ddd;
  border-radius: 12px; padding: 0; }
#card2 .row { width: 100%; }
`;

const FIXTURE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>C-36 弹性行落点标 A/B 夹具</title><style>${CSS}</style></head>
<body>
<div id="stage">
  <div class="row" id="row1">
    <span id="p1">Remote</span><span id="p2">Full-time</span><span id="p3">Senior</span>
  </div>

  <div id="card2">
    <div class="row" id="row2">
      <span id="q1">Remote</span><span id="q2">Full-time</span><span id="q3">Senior</span>
    </div>
  </div>
</div>
</body></html>`;

/* ------------------------------------------------------------------
 * 构造 A 组（C-36 之前的写法）：删掉 ③ 分支的落点标
 * ------------------------------------------------------------------
 * ⚠️ 源码是 CRLF 行尾。先归一化成 LF 再逐字匹配（同 probe-clip-channel-ab）。
 */
const NEW_SRC = fs.readFileSync(path.join(ROOT, 'content/renderer.js'), 'utf8')
  .replace(/\r\n/g, '\n');

const NEW_BRANCH = "      return { kind: 'after', anchor: safeAnchor(el), reason: 'flex-row', risk: FLEX_ROW_RISK };";
const OLD_BRANCH = "      return { kind: 'after', anchor: safeAnchor(el), reason: 'flex-row' };";

function mustFind(hay, needle, what) {
  if (hay.indexOf(needle) < 0) {
    console.error('✗ 未在 content/renderer.js 中找到' + what + '：');
    console.error('    ' + needle);
    console.error('  （说明源码已被改动 —— 请先更新本探针的替换标记，'
      + '不要让它悄悄测了个空气。）');
    process.exit(1);
  }
}
mustFind(NEW_SRC, NEW_BRANCH, 'C-36 之后的 ③ 分支');

const OLD_SRC = NEW_SRC.replace(NEW_BRANCH, OLD_BRANCH);

/* 逐字自检：A 组里新写法必须不在、旧写法必须在 */
if (OLD_SRC.indexOf(NEW_BRANCH) >= 0 || OLD_SRC.indexOf(OLD_BRANCH) < 0) {
  console.error('✗ A 组副本构造失败（替换没有生效，A/B 实际是同一份代码）');
  process.exit(1);
}
if (OLD_SRC.length >= NEW_SRC.length) {
  console.error('✗ A 组副本没有变短 —— 替换至少应删掉 ", risk: FLEX_ROW_RISK"');
  process.exit(1);
}

const INJECT = ['shared/constants.js', 'content/detector.js']
  .map((p) => path.join(ROOT, p));

/* ------------------------------------------------------------------ */
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' :: ' + detail : ''));
}

const BOX_OF = { row1: 'row1', row2: 'card2' };

async function runCase(browser, rendererSrc) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.setContent(FIXTURE, { waitUntil: 'load' });
  for (const p of INJECT) await page.addScriptTag({ path: p });
  await page.addScriptTag({ content: rendererSrc });

  const out = await page.evaluate((boxOf) => {
    const CT = window.CT;
    const R = CT.renderer;
    const S = Object.assign({}, CT.DEFAULT_SETTINGS, { displayMode: 'below' });
    const IDS = Object.keys(boxOf);

    // ① 静态决策（这一步不许改 DOM）
    const plans = {};
    for (const id of IDS) {
      const p = R.placementFor(document.getElementById(id), S);
      plans[id] = {
        kind: p.kind, reason: p.reason || null, risk: p.risk || null,
        hasAnchor: !!p.anchor,
        // 锚点是不是单元自身（safeAnchor 可能爬到跨父的更高层）
        anchorIsSelf: p.anchor === document.getElementById(id)
      };
    }

    // ② 渲染 + 批末几何判决（与 content.js 波次循环同口径）
    const units = R.collectUnits(document.body, S);
    for (const u of units) {
      R.renderUnit(u.el, '【译】' + String(u.text || '').slice(0, 12), S, u.hash, u.plan);
    }
    const relocated = R.verifyBatch(units.map((u) => u.el));

    // ③ 量最终态
    const place = {};
    for (const id of IDS) {
      const el = document.getElementById(id);
      const rec = R.registry.get(el);
      const node = rec && rec.node;
      const box = document.getElementById(boxOf[id]);
      const r = node ? node.getBoundingClientRect() : null;
      place[id] = {
        hasNode: !!node,
        inside: !!(node && box && box.contains(node)),
        moved: !!(rec && rec.moved),
        verdict: rec ? (rec.verdict || null) : null,
        stillFailing: !!(node && R.judgeOne(el, rec)),
        w: r ? Math.round(r.width) : 0,
        h: r ? Math.round(r.height) : 0
      };
    }

    const audit = R.auditSummary();
    const stats = R.getStats();
    return {
      plans, units: units.length, relocated, place,
      auditTotal: audit.total, auditByReason: audit.byReason, stats
    };
  }, BOX_OF);

  await page.close();
  return out;
}

/* ------------------------------------------------------------------ */
const browser = await chromium.launch({
  executablePath: process.env.CT_E2E_CHROME
    || 'C:/Users/Administrator/.workbuddy/binaries/cft/chrome-win64/chrome.exe',
  headless: true
});

let A, B;
try {
  console.log('\n【A 组】C-36 之前（flex-row 落点不打标 · 第二级从不回看）');
  A = await runCase(browser, OLD_SRC);
  console.log('  静态决策：');
  for (const k of Object.keys(A.plans)) console.log('    ' + k + ' → ' + JSON.stringify(A.plans[k]));
  console.log('  最终态：');
  for (const k of Object.keys(A.place)) {
    const p = A.place[k];
    console.log('    ' + k + ' 译文在容器内=' + p.inside + ' 已搬迁=' + p.moved
      + ' 仍不可见=' + p.stillFailing + ' 矩形=' + p.w + '×' + p.h + ' verdict=' + p.verdict);
  }
  console.log('  stats: relocated=' + A.stats.relocated + ' rescuedFromClip=' + A.stats.rescuedFromClip
    + '   审计不可见=' + A.auditTotal + '(' + JSON.stringify(A.auditByReason) + ')');

  console.log('\n【B 组】当前代码（C-36：flex-row 落点打 FLEX_ROW_RISK 标 · 第二级复核）');
  B = await runCase(browser, NEW_SRC);
  console.log('  静态决策：');
  for (const k of Object.keys(B.plans)) console.log('    ' + k + ' → ' + JSON.stringify(B.plans[k]));
  console.log('  最终态：');
  for (const k of Object.keys(B.place)) {
    const p = B.place[k];
    console.log('    ' + k + ' 译文在容器内=' + p.inside + ' 已搬迁=' + p.moved
      + ' 仍不可见=' + p.stillFailing + ' 矩形=' + p.w + '×' + p.h + ' verdict=' + p.verdict);
  }
  console.log('  stats: relocated=' + B.stats.relocated + ' rescuedFromClip=' + B.stats.rescuedFromClip
    + '   审计不可见=' + B.auditTotal + '(' + JSON.stringify(B.auditByReason) + ')');
} finally {
  await browser.close();
}

console.log('\n────────────────────────────────────────────────────');

/* ---- ① 静态级的形状 ---- */
check('A 组：flex-row 落点**不打标**（C-36 之前的缺陷形态）',
  A.plans.row1.risk === null && A.plans.row1.kind === 'after'
  && A.plans.row1.reason === 'flex-row',
  JSON.stringify(A.plans.row1));
check('B 组：flex-row 落点打上落点标 flex-row-outside',
  B.plans.row1.risk === 'flex-row-outside' && B.plans.row1.kind === 'after',
  JSON.stringify(B.plans.row1));
check('B 组：落点标**不是**裁切标（不得串进 rescuedFromClip 口径）',
  B.plans.row1.risk !== 'ancestor-clipped',
  'risk=' + B.plans.row1.risk + '（CLIP_ENTRY_RISK 只收裁切标）');

/* ---- ② 无净行为变化：常见情形一个字节都不动 ---- */
check('【无净变化】A 组：普通标签行的译文挂在行容器之后且可见',
  A.place.row1.inside === false && A.place.row1.stillFailing === false
  && A.place.row1.h > 0,
  JSON.stringify(A.place.row1));
check('【无净变化】B 组：同样挂在行容器之后、同样可见（量完不动作）',
  B.place.row1.inside === false && B.place.row1.stillFailing === false
  && B.place.row1.h > 0,
  JSON.stringify(B.place.row1));
check('【无净变化】B 组第二级量过但没动它（row1 不搬、verdict 空、仍可见）',
  B.place.row1.moved === false && B.place.row1.verdict === null
  && B.place.row1.stillFailing === false,
  'moved=' + B.place.row1.moved + ' verdict=' + B.place.row1.verdict
  + ' 仍不可见=' + B.place.row1.stillFailing);
check('【无净变化】两组在常见情形下行为完全一致（row1 逐字段相同）',
  A.place.row1.moved === B.place.row1.moved
  && A.place.row1.inside === B.place.row1.inside
  && A.place.row1.h === B.place.row1.h
  && A.place.row1.verdict === B.place.row1.verdict,
  'A(' + A.place.row1.moved + ',' + A.place.row1.inside + ',' + A.place.row1.h + ')'
  + ' B(' + B.place.row1.moved + ',' + B.place.row1.inside + ',' + B.place.row1.h + ')'
  + ' —— 注意此处故意不用全局 stats：页面里 row2 的救援差异是 C-36 的收益，'
  + '不该被「一致性」吞掉');

/* ---- ③ 该救的救：定高卡片里的标签行，挂出去的落点真被裁 ---- */
check('【该救的救】A 组（缺陷现场）：译文留在定高卡片内、被裁、第二级从不回看',
  A.place.row2.inside === true && A.place.row2.stillFailing === true
  && A.stats.relocated === 0 && A.place.row2.verdict === null,
  'inside=' + A.place.row2.inside + ' 仍不可见=' + A.place.row2.stillFailing
  + ' relocated=' + A.stats.relocated + ' verdict=' + A.place.row2.verdict);
check('【该救的救】A 组：审计如实报出这条被裁的译文（仍不可见）',
  A.auditTotal === 1, '审计=' + A.auditTotal + '(' + JSON.stringify(A.auditByReason) + ')');
check('【该救的救】B 组：第二级量出被裁 → 搬出定高卡片 → 复验通过',
  B.place.row2.inside === false && B.place.row2.moved === true
  && B.place.row2.verdict === 'moved' && B.place.row2.stillFailing === false
  && B.place.row2.h > 0,
  'inside=' + B.place.row2.inside + ' verdict=' + B.place.row2.verdict
  + ' 高=' + B.place.row2.h);
check('【该救的救】B 组：搬完后审计归零（没有留下不可见译文）',
  B.auditTotal === 0, '审计=' + B.auditTotal);

/* ---- ④ 口径不串味：落点标触发的搬迁不计入 rescuedFromClip ---- */
check('【口径】B 组 relocated ≥ 1（该救的那条确实被搬了）',
  B.stats.relocated >= 1, 'relocated=' + B.stats.relocated);
check('【口径】B 组 rescuedFromClip === 0（落点标 flex-row-outside 不入 CLIP_ENTRY_RISK）',
  B.stats.rescuedFromClip === 0,
  'rescuedFromClip=' + B.stats.rescuedFromClip + '（这条是 C-36 与 C-34 的分界线）');
check('【口径】A 组同样不计（无标路径压根不进第二级）',
  A.stats.rescuedFromClip === 0, 'rescuedFromClip=' + A.stats.rescuedFromClip);

const failed = results.filter((r) => !r.ok);
console.log('────────────────────────────────────────────────────');
if (failed.length) {
  console.log('失败 ' + failed.length + ' 项，通过 ' + (results.length - failed.length) + ' 项');
  failed.forEach((f) => console.log('  ✗ ' + f.name));
  process.exit(1);
}
console.log('全部通过：' + results.length + ' 项检查');
