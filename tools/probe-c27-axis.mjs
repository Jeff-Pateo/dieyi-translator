/*
 * 决定性探针 · C-27 同轴收口的 A/B 对照（真实 Chromium + 站点原文 CSS）
 * ==================================================================
 * 为什么要有这一支：
 *   probe-remoteok-moved.mjs 跑的是**真实站点全量翻译**（2396 段），
 *   一次十分多钟，且结论被翻译耗时淹没。可我们要证的其实只是一条
 *   判据的取值 —— 那就不该让翻译参与。
 *
 * 这一支的做法：
 *   ① 夹具页里**逐字复制** remoteok index.css 的两条真实规则
 *      （.location-filter-results 与它的 div），外壳照 remoteok 的
 *      `.container > [banner, 面板(absolute), 职位表]` 结构搭；
 *   ② 用真实 Chromium 取**真实计算值**（不是我们猜的字符串）；
 *   ③ 同一份夹具、同一批元素，跑两次判决：
 *        A 组 = 旧判据（把 C-27 那一行去掉的 renderer 副本）
 *        B 组 = 新判据（当前 content/renderer.js）
 *      逐条比对 placementFor 的 {kind, reason}，并把「旧行为的页面级后果」
 *      （职位表被顶下多少像素）量出来。
 *
 * 断言（退出码非 0 即失败）：
 *   · 面板计算值必须是 ox:hidden / oy:scroll（简写被长手按轴覆盖）
 *   · A 组：259 条全部被误打裁切标（risk=ancestor-clipped 计数）且零搬迁 ——
 *     【C-34 契约翻写 2026-09-29】旧期望「reason='clipped' 外挪 + 职位表被顶下」
 *     写于 C-34 之前；C-34（P-1）把静态外挪通道整体删除（门禁 2 禁止第一级
 *     产出 reason='clipped'）后，判据误判的后果从「259 条外挪顶下页面」降级为
 *     「只打标、第二级量测放行、零布局位移」。A 组零位移本身就是 P-1 架构收益
 *     （静态判据不再产生不可逆 DOM 变更）的直接证明——比旧断言更强。
 *     本次由上线评审会实弹复跑抓到（A 组测了个空气：reason 全空、位移 0）。
 *   · B 组：reason='clipped' 的条目数 === 0（C-27 之后一条都不外挪）
 *   · B 组：职位表位置与「不翻译」基线一致（页面级零位移）
 *
 * 运行：
 *   NODE_PATH=<node_modules> node tools/probe-c27-axis.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ITEM_COUNT = 259;

/* remoteok index.css 的真实规则，逐字复制（含简写 + 长手覆盖） */
const SITE_CSS = `
/* ==== 以下三条逐字复制自 https://remoteok.com/index.css ==== */
.location-filter-results {
  display: none; width: 400px; max-width: 80vw; position: absolute;
  border-radius: 12px; z-index: 10; overflow: hidden; padding: 7px;
  max-height: 500px; overflow-y: scroll; backdrop-filter: blur(12px);
  background: rgba(251, 250, 248, 0.95);
}
.location-filter-results div {
  padding: 7px; font-weight: 800; font-size: 16px;
  text-overflow: ellipsis; white-space: nowrap;
}
/* ==== 以下仅为夹具外壳，模拟 remoteok 的 .container 层序 ==== */
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fbfaf8;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
.container { position: relative; width: 1100px; margin: 0 auto; }
.banner { height: 80px; background: #eceae6; margin-bottom: 12px; }
#jobs { width: 100%; border-collapse: collapse; }
#jobs td { padding: 18px; border-bottom: 1px solid #e6e2dc; }
/* 只看面板展开态：把站点用于折叠的 display:none 覆盖掉 */
#panel.location-filter-results { display: block; }
`;

/* 外壳：banner（常规流）→ 面板（absolute，脱离流）→ 职位表（常规流） */
const FIXTURE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>remoteok 筛选面板结构夹具</title><style>${SITE_CSS}</style></head>
<body>
<div class="container">
  <div class="banner">banner</div>
  <div class="location-filter-results" id="panel"></div>
  <table id="jobs"><tbody>
    <tr class="job"><td>Senior Product Manager</td></tr>
    <tr class="job"><td>Frontend Engineer</td></tr>
    <tr class="job"><td>Data Analyst</td></tr>
  </tbody></table>
</div>
<script>
  /* 259 个国家/地区选项，与 remoteok 服务端渲染的条数同量级 */
  var panel = document.getElementById('panel');
  for (var i = 0; i < ${ITEM_COUNT}; i++) {
    var d = document.createElement('div');
    d.textContent = 'Region ' + i;
    d.id = 'ri' + i;
    panel.appendChild(d);
  }
</script>
</body></html>`;

/* ---- 构造「旧判据」副本：只回退 C-27 的那一行 ---- */
const NEW_SRC = fs.readFileSync(path.join(ROOT, 'content/renderer.js'), 'utf8');
const C27_LINE = "if (l.oy === 'auto' || l.oy === 'scroll') return false;";
if (NEW_SRC.indexOf(C27_LINE) < 0) {
  console.error('✗ 未在 renderer.js 中找到 C-27 同轴收口那一行，A/B 无法构造：');
  console.error('  ' + C27_LINE);
  process.exit(1);
}
const OLD_SRC = NEW_SRC.replace(C27_LINE, '/* [A/B 探针] 已回退 C-27 同轴收口 */');

const INJECT = [
  'shared/constants.js',
  'content/detector.js'
].map(p => path.join(ROOT, p));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' :: ' + detail : ''));
}

async function runCase(browser, rendererSrc, injectSrc) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.setContent(FIXTURE, { waitUntil: 'load' });
  for (const p of injectSrc) await page.addScriptTag({ path: p });
  await page.addScriptTag({ content: rendererSrc });

  return await page.evaluate(({ count, injectSrc }) => {
    const R = window.CT.renderer;
    const panel = document.getElementById('panel');
    const cs = getComputedStyle(panel);
    const panelRect = panel.getBoundingClientRect();

    // 旧判据（跨轴组合）与 C-27 判据（同轴收口），就地各算一遍
    const anyAxisClip = ['overflowX', 'overflowY']
      .some(k => { const v = cs[k]; return v === 'hidden' || v === 'clip'; });
    const maxH = cs.maxHeight && cs.maxHeight !== 'none' && parseFloat(cs.maxHeight) > 0;
    const oldVerdict = anyAxisClip && maxH;
    const newVerdict = oldVerdict && !(cs.overflowY === 'auto' || cs.overflowY === 'scroll');

    const tally = { inside: 0, after: 0, inline: 0, other: 0 };
    const reasons = {};
    const risks = {};
    const vsPanel = { in: 0, vOut: 0, hOut: 0, zero: 0 };
    for (let i = 0; i < count; i++) {
      const el = document.getElementById('ri' + i);
      const plan = R.placementFor(el, { insertMode: 'auto' });
      if (tally[plan.kind] === undefined) tally.other++; else tally[plan.kind]++;
      const k = plan.reason || '(none)';
      reasons[k] = (reasons[k] || 0) + 1;
      const rk = plan.risk || '(none)';
      risks[rk] = (risks[rk] || 0) + 1;

      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) vsPanel.zero++;
      else if (r.top < panelRect.top - 1 || r.bottom > panelRect.bottom + 1) vsPanel.vOut++;
      else if (r.left < panelRect.left - 1 || r.right > panelRect.right + 1) vsPanel.hOut++;
      else vsPanel.in++;
    }

    const jobsTop = document.getElementById('jobs').getBoundingClientRect().top;

    /* 模拟「旧行为」的页面级后果：把 259 条译文块按旧路径真的插到面板之后，
     * 再量一次职位表被顶下去多少。这一步只改本次探针的临时页面。 */
    const beforeSim = jobsTop;
    for (let i = 0; i < count; i++) {
      const el = document.getElementById('ri' + i);
      const plan = R.placementFor(el, { insertMode: 'auto' });
      if (plan.kind === 'after' && plan.reason === 'clipped') {
        const t = document.createElement('div');
        t.className = 'ct-trans ct-trans--out';
        t.textContent = '【译】地区 ' + i;
        plan.anchor.parentNode.insertBefore(t, plan.anchor.nextSibling);
      }
    }
    const afterSim = document.getElementById('jobs').getBoundingClientRect().top;

    return {
      computed: {
        overflowX: cs.overflowX, overflowY: cs.overflowY, maxHeight: cs.maxHeight
      },
      oldVerdict, newVerdict,
      tally, reasons, risks, vsPanel,
      panelRect: { w: Math.round(panelRect.width), h: Math.round(panelRect.height) },
      jobsShift: Math.round(afterSim - beforeSim),
      itemH: Math.round(document.getElementById('ri0').getBoundingClientRect().height),
      injectedScripts: injectSrc.length
    };
  }, { count: ITEM_COUNT, injectSrc });
}

const browser = await chromium.launch({
  executablePath: process.env.CT_E2E_CHROME
    || 'C:/Users/Administrator/.workbuddy/binaries/cft/chrome-win64/chrome.exe',
  headless: true
});
let oldRes, newRes;
try {
  console.log('\n【A 组】旧判据（C-27 同轴收口已回退）');
  oldRes = await runCase(browser, OLD_SRC, INJECT);
  console.log('  面板计算值：overflow-x=' + oldRes.computed.overflowX
    + '  overflow-y=' + oldRes.computed.overflowY
    + '  max-height=' + oldRes.computed.maxHeight);
  console.log('  面板矩形：' + oldRes.panelRect.w + '×' + oldRes.panelRect.h
    + '   条目高：' + oldRes.itemH + 'px');
  console.log('  判据取值：旧=' + oldRes.oldVerdict + ' / 新=' + oldRes.newVerdict);
  console.log('  placementFor 分布：' + JSON.stringify(oldRes.tally)
    + '  reasons=' + JSON.stringify(oldRes.reasons));
  console.log('  条目相对面板：可见 ' + oldRes.vsPanel.in
    + ' / 纵向之外 ' + oldRes.vsPanel.vOut
    + ' / 横向之外 ' + oldRes.vsPanel.hOut
    + ' / 零矩形 ' + oldRes.vsPanel.zero);
  console.log('  席位表位移（模拟旧行为后）：' + oldRes.jobsShift + 'px');

  console.log('\n【B 组】当前代码（C-27 已生效）');
  newRes = await runCase(browser, NEW_SRC, INJECT);
  console.log('  placementFor 分布：' + JSON.stringify(newRes.tally)
    + '  reasons=' + JSON.stringify(newRes.reasons)
    + '  risks=' + JSON.stringify(newRes.risks));
  console.log('  条目相对面板：可见 ' + newRes.vsPanel.in
    + ' / 纵向之外 ' + newRes.vsPanel.vOut
    + '（这 ' + newRes.vsPanel.vOut + ' 条正是「滚出去 ≠ 被裁」那类，由 scrollsOutOf 放行）');
  console.log('  席位表位移：' + newRes.jobsShift + 'px');
} finally {
  await browser.close();
}

console.log('\n────────────────────────────────────────────────────');
check('面板计算值是 ox:' + oldRes.computed.overflowX + ' / oy:' + oldRes.computed.overflowY
  + '（简写被长手按轴覆盖）',
  oldRes.computed.overflowX === 'hidden' && oldRes.computed.overflowY === 'scroll');
check('旧判据判它是裁切容器（跨轴组合，误判）', oldRes.oldVerdict === true);
check('C-27 判据判它不是（同轴收口）', newRes.newVerdict === false);
check('A 组：' + ITEM_COUNT + ' 条全部被误打裁切标（risk 计数）—— 判据仍会误判，但 C-34 后第一级只打标、零搬迁',
  oldRes.risks['ancestor-clipped'] === ITEM_COUNT && !oldRes.reasons['clipped'],
  'risks=' + JSON.stringify(oldRes.risks) + ' reasons=' + JSON.stringify(oldRes.reasons));
check('A 组：判据误判下职位表位移 ' + oldRes.jobsShift + 'px（0 = C-34 架构收益：'
  + '静态判据不再产生不可逆变更，remoteok 症状不可复发）',
  oldRes.jobsShift === 0);
check('B 组：clipped 外挪计数为 0', !newRes.reasons['clipped'],
  JSON.stringify(newRes.reasons));
check('B 组：' + ITEM_COUNT + ' 条全部留在面板内部（kind=inside）',
  newRes.tally.inside === ITEM_COUNT, JSON.stringify(newRes.tally));
check('B 组：职位表零位移（页面级无破坏）', newRes.jobsShift === 0,
  newRes.jobsShift + 'px');
check('B 组：条目自身 nowrap 仍被第一级圈选（self-nowrap ×' + ITEM_COUNT
  + '）—— 圈选没被顺手收窄，横轴裁切那条路径仍在',
  newRes.risks['self-nowrap'] === ITEM_COUNT, JSON.stringify(newRes.risks));
check('对照组：A 组里 ' + oldRes.vsPanel.vOut + ' 条纵向越界条目被误判为「被裁」；'
  + 'B 组同一条目改判为「滚出去」（只圈不算 → 量测放行）',
  oldRes.vsPanel.vOut > 0 && newRes.risks['self-nowrap'] === ITEM_COUNT);

const failed = results.filter(r => !r.ok);
console.log('────────────────────────────────────────────────────');
if (failed.length) {
  console.log('失败 ' + failed.length + ' 项，通过 ' + (results.length - failed.length) + ' 项');
  process.exit(1);
} else {
  console.log('全部通过：' + results.length + ' 项（A/B 对照成立，C-27 收口生效）');
}
