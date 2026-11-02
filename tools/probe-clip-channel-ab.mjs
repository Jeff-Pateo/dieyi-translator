/*
 * 决定性探针 · P-1「免检通道清零」的 A/B 对照（真实 Chromium）
 * ==================================================================
 * 【要证的命题】
 * 把「把译文搬到裁切容器之外」这个**不可逆动作**从第一级（静态判据）
 * 整体搬到第二级（几何判决）之后，**行为是否等价**：
 *   · 真诚实被裁的译文 —— 第二级必须照样把它救出来（否则就是净退化）；
 *   · 静态判据的**假阳性**（声明了硬约束、其实没裁到译文）——
 *     不应再被无谓搬迁（这正是 P-1 的收益）；
 *   · 几何上挪不出去的（<td> 被裁）—— 旧实现**静默**，新实现**如实上报**。
 *
 * 【为什么必须是真实浏览器】
 * 搬迁的落点判据是 `escapeAnchor(el, t)`，它只认**真实矩形**：
 * 只挑「几何上确实切掉了译文」的那一层做锚点。jsdom 没有布局引擎，
 * `getBoundingClientRect()` 恒为全零，这条路径在那里根本走不通 ——
 * 也就是说「搬迁去哪」这件事**在 jsdom 里不可复现**（见 L-17 的纪律：
 * jsdom 测不到的呈现层，必须有静态门禁 + 真实浏览器验证）。
 * 静态门禁已落在 tools/test-clip-guard.mjs 第九节；本支负责行为侧。
 *
 * 【三组夹具，对应三种判决命运】
 *   ① clipP  —— 真裁切（-webkit-line-clamp + max-height 的卡片标题）
 *                → 两组都应把译文搬到容器外，且译文**可见**
 *   ② fpP    —— 假阳性（overflow:hidden + max-height:400px，内容根本放得下）
 *                → 旧实现会误搬出去（A 组），新实现必须**留在容器内**
 *   ③ cellP  —— 挪不出去（译文真被裁，但锚点落在 <tr> 链上）
 *                → 两组都留在原地；A 组静默，B 组如实记 clipUnresolved
 *
 * 【★ 一条被本探针自己推翻的预期（别再把它当收益）★】
 * 我原本写的断言是「A 组把假阳性容器的译文搬出去，把页面哨兵推下去」。
 * 实测 **A 组的哨兵与 B 组完全同高**，原因不是夹具搭错，而是**这条预期本身错**：
 *   A 组：译文挂在 `.fp` 之外 → `.fp` 高 58，译文自己占 20px 页高；
 *   B 组：译文留在 `.fp` 之内 → `.fp` 被撑到 78，译文同样占 20px 页高。
 * 只要容器**能长高**（`max-height` 没顶死），译文占的高度两种做法**一模一样**；
 * 容器顶死时它又是**真的被裁**，第二级照样会搬走 —— 所以「省页高」不是 P-1 的收益，
 * 一次都不成立。P-1 的真实收益是**归属与形态**：
 *   · A 组被逐出的译文落在 `#stage` 层级，撑成**整页宽 688px**（脱离卡片的边框、
 *     圆角、内边距，变成悬在卡片外的一条通栏文字）；
 *   · B 组留在卡片内，宽 302px，与卡片同宽、同归属；卡片自己被撑高 20px。
 * 本支按后者立断言（见第 ③ 组），并把「两组页高一致」也留成一条**记录在案**的等价性。
 *
 * 【A 组怎么来的】
 * 不是「凭记忆重写一份旧代码」，而是把当前源码里那三处**逐字**换回旧写法：
 *   · placementFor 的裁切分支换回「直接外挪」；
 *   · 把当时那个结构预检函数补回去（它已随 P-1 删除）；
 *   · 把当时那个「声明口径」的 rescuedFromClip 计数点补回去（它已随 P-1 移走）。
 * 换的时候逐字比对标记串，找不到就直接失败退出 —— 免得探针悄悄测了个空气。
 *
 * 【未纳入本支的相邻观察（留给判据表，别丢）】
 * `text-overflow` **不是继承属性**：`<td style="overflow:hidden;white-space:nowrap;
 * text-overflow:ellipsis"><p id="u">…</p></td>` 里，`judgeOne` 拿 `layoutOf(<p>)`
 * 读到的 `te` 是 `clip` 而非 `ellipsis`，于是 `ellipsized` 判据对「单元是 <td> 的
 * 子元素」这一形态不生效（实测 judge=null）。已交测试2组复核是否真漏判。
 *
 * 运行：
 *   NODE_PATH=<node_modules> node tools/probe-clip-channel-ab.mjs
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

/* ① 真裁切：卡片标题被两行 clamp 截断（最经典的双语译文被吃场景） */
.card { display: -webkit-box; -webkit-box-orient: vertical;
  -webkit-line-clamp: 2; overflow: hidden; max-height: 48px; width: 320px; }
.card p { margin: 0; font-weight: 700; }

/* ② 假阳性：声明了硬约束，但 max-height:400px 根本够不着 —— 内容放得下。
   注意它的 border：A 组把译文逐出这个盒子之后，译文会掉到边框外面去。 */
.fp { overflow: hidden; max-height: 400px; width: 320px;
  padding: 8px; border: 1px solid #ddd; border-radius: 12px; }
.fp p { margin: 0; }

/* ③ 挪不出去：译文真的被裁，但锚点落在 <tr> 链上（块级兄弟插不进 <tbody>）。
   ★ 实测结论：表格单元格上的 max-height 会被浏览器**整条忽略**
     （display:table-cell 的宿主高是 40 而不是 22）——要让它真的裁，
     必须先把 display 改成块级。所以这里写 display:block：
     DOM 上它仍是 <tr> 的子节点，safeAnchor 照旧沿 table-row /
     table-row-group 上溯到 <tbody>，canPlaceAfter(<tbody>) 因父为
     <table> 返回 false —— 「挪不出去」这条路径才是真的。 */
table { border-collapse: collapse; width: 320px; }
td.cellclip { display: block; overflow: hidden; max-height: 22px; padding: 0; }
td.cellclip p { margin: 0; }

/* 页面级哨兵：正文之后的一个定高块。本支用它记录**两组页高是否一致**
   （结论：一致 —— P-1 不省页高，见文件头那段） */
#sentinel { height: 40px; background: #eef; margin-top: 24px; }
`;

const FIXTURE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>P-1 免检通道 A/B 夹具</title><style>${CSS}</style></head>
<body>
<div id="stage">
  <div class="card" id="card">
    <p id="clipP">Senior Growth Product Manager AI Native for the international marketplace team</p>
  </div>

  <div class="fp" id="fpBox">
    <p id="fpP">Deployment finished successfully this morning.</p>
  </div>

  <table id="cellBox"><tbody><tr>
    <td class="cellclip"><p id="cellP">Cycle time is the only metric that matters here at all</p></td>
  </tr></tbody></table>

  <div id="sentinel"></div>
</div>
</body></html>`;

/* ------------------------------------------------------------------
 * 构造 A 组（旧实现）副本
 * ------------------------------------------------------------------
 * ⚠️ 源码是 **CRLF** 行尾（1857 行）。多行标记串在 CRLF 文本上
 * 一个都匹配不到 —— 而 indexOf 返回 -1 时若不报错，探针就会
 * 「安静地测一份根本没替换成功的代码」，A/B 变成同一份。
 * 所以这里先归一化成 LF，再逐字匹配。
 */
const NEW_SRC = fs.readFileSync(path.join(ROOT, 'content/renderer.js'), 'utf8')
  .replace(/\r\n/g, '\n');

const NEW_CLIP_BLOCK = [
  '    if (clip.clip) {',
  "      if (mode === 'sibling') return { kind: 'after', anchor: el, risk: CLIP_RISK };",
  "      return { kind: 'inside', risk: CLIP_RISK };",
  '    }'
].join('\n');

const OLD_CLIP_BLOCK = [
  '    if (clip.clip) {',
  '      var clipAnchor = safeAnchor(clip.clip);',
  '      if (canInsertAfter(clipAnchor, el)) {',
  "        return { kind: 'after', anchor: clipAnchor, reason: 'clipped' };",
  '      }',
  "      return { kind: 'inside', reason: 'clipped-degraded' };",
  '    }'
].join('\n');

const NO_BLOCK_CHILD_DECL = [
  '  var NO_BLOCK_CHILD = {',
  '    TR: 1, TBODY: 1, THEAD: 1, TFOOT: 1, TABLE: 1, COLGROUP: 1,',
  '    SELECT: 1, OPTGROUP: 1, DATALIST: 1',
  '  };'
].join('\n');

const OLD_CANINSERT = [
  '',
  '',
  '  function canInsertAfter(anchor, el) {',
  '    if (!anchor || anchor === el) return false;',
  '    var parent = anchor.parentNode;',
  '    if (!parent || parent.nodeType !== 1) return false;',
  '    if (NO_BLOCK_CHILD[parent.tagName]) return false;',
  '    if (el.contains(anchor)) return false;',
  '    return true;',
  '  }'
].join('\n');

/* 第三处：旧实现的 rescuedFromClip 是**声明口径** —— 计数点在第一级
 * （renderUnit 里 `if (plan.reason === 'clipped') ++`），所以它把
 * 「静态判它是裁切容器」的**假阳性**也一并算成「救回来了」。
 * P-1 把这个计数点整体移到了第二级的 relocate 末尾（复验通过之后）。 */
const NEW_STATS_BLOCK = [
  '     * 第一级不再单独产出搬迁决策，这个数只有量测完才知道答案。 */',
  '    if (!hadPrev) stats.translated++;',
  '    return true;'
].join('\n');

const OLD_STATS_BLOCK = [
  '     * 第一级不再单独产出搬迁决策，这个数只有量测完才知道答案。 */',
  "    if (plan.reason === 'clipped') stats.rescuedFromClip = (stats.rescuedFromClip || 0) + 1;",
  '    if (!hadPrev) stats.translated++;',
  '    return true;'
].join('\n');

function mustFind(hay, needle, what) {
  if (hay.indexOf(needle) < 0) {
    console.error('✗ 未在 content/renderer.js 中找到' + what + '，A/B 无法构造：');
    console.error(needle.split('\n').map((l) => '    ' + l).join('\n'));
    console.error('  （说明源码已被改动 —— 请先更新本探针的替换标记，'
      + '不要让它悄悄测了个空气。）');
    process.exit(1);
  }
}
mustFind(NEW_SRC, NEW_CLIP_BLOCK, 'P-1 之后的裁切分支');
mustFind(NEW_SRC, NO_BLOCK_CHILD_DECL, 'NO_BLOCK_CHILD 声明');
mustFind(NEW_SRC, NEW_STATS_BLOCK, 'P-1 之后的统计块');

const OLD_SRC = NEW_SRC
  .replace(NEW_CLIP_BLOCK, OLD_CLIP_BLOCK)
  .replace(NO_BLOCK_CHILD_DECL, NO_BLOCK_CHILD_DECL + OLD_CANINSERT)
  .replace(NEW_STATS_BLOCK, OLD_STATS_BLOCK);

/* 逐字自检：换完之后旧写法必须在、新写法必须不在 */
if (OLD_SRC.indexOf('var clipAnchor = safeAnchor(clip.clip);') < 0
  || OLD_SRC.indexOf('function canInsertAfter(anchor, el)') < 0
  || OLD_SRC.indexOf("if (plan.reason === 'clipped') stats.rescuedFromClip") < 0) {
  console.error('✗ A 组副本构造失败（旧写法没换进去）');
  process.exit(1);
}
if (OLD_SRC.indexOf('    if (clip.clip) {\n      return { kind: ' + "'inside', risk: CLIP_RISK };") >= 0) {
  console.error('✗ A 组副本里新写法还在，A/B 实际是同一份代码');
  process.exit(1);
}
if (OLD_SRC.length <= NEW_SRC.length) {
  console.error('✗ A 组副本没有变长 —— 三处替换至少应净增 200 字符以上');
  process.exit(1);
}

const INJECT = ['shared/constants.js', 'content/detector.js']
  .map((p) => path.join(ROOT, p));

/* ------------------------------------------------------------------
 * 跑一组
 * ------------------------------------------------------------------ */
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' :: ' + detail : ''));
}

const BOX_OF = { clipP: 'card', fpP: 'fpBox', cellP: 'cellBox' };

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

    // ① 静态决策（这一步**不许改 DOM**）
    const plans = {};
    for (const id of IDS) {
      const p = R.placementFor(document.getElementById(id), S);
      plans[id] = {
        kind: p.kind,
        reason: p.reason || null,
        risk: p.risk || null,
        hasAnchor: !!p.anchor
      };
    }
    const domBefore = document.getElementById('clipP').querySelectorAll('.ct-trans').length;

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
        // 译文是否仍在它所属的那个容器内（"留"= inside，被救出去 = false）
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
    const stage = document.getElementById('stage');
    return {
      plans,
      domBefore,
      units: units.length,
      relocated,
      place,
      auditTotal: audit.total,
      auditByReason: audit.byReason,
      stats,
      sentinelTop: Math.round(document.getElementById('sentinel').getBoundingClientRect().top),
      stageW: Math.round(document.getElementById('stage').getBoundingClientRect().width),
      // #stage 的**内容**宽（去掉左右 padding）—— A 组被逐出的译文会撑满这一宽度。
      // 不能拿 stageW 比：那是 border-box 宽（720），译文是 688。
      stageContentW: (function () {
        const cs = window.getComputedStyle(stage);
        return Math.round(stage.clientWidth
          - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0));
      })(),
      // 容器实际高度：假阳性容器在 B 组应该被译文撑高（说明译文归属仍在它里面）
      boxH: {
        card: Math.round(document.getElementById('card').getBoundingClientRect().height),
        fpBox: Math.round(document.getElementById('fpBox').getBoundingClientRect().height),
        cellBox: Math.round(document.getElementById('cellBox').getBoundingClientRect().height)
      }
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
  console.log('\n【A 组】旧实现（第一级直接外挪 · 无验真 · 声明口径计数）');
  A = await runCase(browser, OLD_SRC);
  console.log('  #stage 内容宽 ' + A.stageW + '   采集到 ' + A.units + ' 个单元   批末搬迁 ' + A.relocated + ' 条');
  console.log('  容器高：卡片 ' + A.boxH.card + ' / 假阳性盒 ' + A.boxH.fpBox + ' / 表格 ' + A.boxH.cellBox);
  console.log('  静态决策：');
  for (const k of Object.keys(A.plans)) {
    console.log('    ' + k + ' → ' + JSON.stringify(A.plans[k]));
  }
  console.log('  最终态：');
  for (const k of Object.keys(A.place)) {
    const p = A.place[k];
    console.log('    ' + k + ' 译文留在容器内=' + p.inside
      + '  已搬迁=' + p.moved + '  仍不可见=' + p.stillFailing
      + '  矩形=' + p.w + '×' + p.h + '  verdict=' + p.verdict);
  }
  console.log('  stats: relocated=' + A.stats.relocated
    + ' rescuedFromClip=' + A.stats.rescuedFromClip
    + ' clipUnresolved=' + A.stats.clipUnresolved
    + '   审计不可见=' + A.auditTotal
    + '   哨兵 top=' + A.sentinelTop + 'px');

  console.log('\n【B 组】当前代码（P-1 之后：静态只打标，搬迁归几何判决）');
  B = await runCase(browser, NEW_SRC);
  console.log('  #stage 内容宽 ' + B.stageW + '   采集到 ' + B.units + ' 个单元   批末搬迁 ' + B.relocated + ' 条');
  console.log('  容器高：卡片 ' + B.boxH.card + ' / 假阳性盒 ' + B.boxH.fpBox + ' / 表格 ' + B.boxH.cellBox);
  console.log('  静态决策：');
  for (const k of Object.keys(B.plans)) {
    console.log('    ' + k + ' → ' + JSON.stringify(B.plans[k]));
  }
  console.log('  最终态：');
  for (const k of Object.keys(B.place)) {
    const p = B.place[k];
    console.log('    ' + k + ' 译文留在容器内=' + p.inside
      + '  已搬迁=' + p.moved + '  仍不可见=' + p.stillFailing
      + '  矩形=' + p.w + '×' + p.h + '  verdict=' + p.verdict);
  }
  console.log('  stats: relocated=' + B.stats.relocated
    + ' rescuedFromClip=' + B.stats.rescuedFromClip
    + ' clipUnresolved=' + B.stats.clipUnresolved
    + '   审计不可见=' + B.auditTotal
    + '   哨兵 top=' + B.sentinelTop + 'px');
} finally {
  await browser.close();
}

console.log('\n────────────────────────────────────────────────────');

/* ---- ① 静态级的形状：不可逆动作已从静态级消失 ---- */
check('A 组：静态级直接产出外挪（reason=clipped 且带锚点）',
  A.plans.clipP.reason === 'clipped' && A.plans.clipP.hasAnchor === true
  && A.plans.clipP.kind === 'after',
  JSON.stringify(A.plans.clipP));
check('A 组：静态阶段就已经改了插入点，却**不打风险标**（第二级从不回看）',
  A.plans.clipP.risk === null, 'risk=null → verifyBatch 的 !rec.risk 会把整条跳过');
check('B 组：静态级只打标、不外挪（kind=inside + risk=ancestor-clipped）',
  B.plans.clipP.kind === 'inside' && B.plans.clipP.risk === 'ancestor-clipped',
  JSON.stringify(B.plans.clipP));
check('B 组：静态级不再产出搬迁锚点、不再产出 reason=clipped',
  B.plans.clipP.hasAnchor === false && B.plans.clipP.reason === null);

/* ---- ② 行为等价性（本探针最要紧的一条）：真裁切的译文照样被救出来 ---- */
check('【等价性】真裁切场景：A 组把译文放到容器外（基线行为）',
  A.place.clipP.inside === false, JSON.stringify(A.place.clipP));
check('【等价性】真裁切场景：B 组**同样**把译文放到容器外（没有净退化）',
  B.place.clipP.inside === false, JSON.stringify(B.place.clipP));
check('【等价性】真裁切场景：B 组译文可见（搬迁后复验通过，不是 unresolved）',
  B.place.clipP.stillFailing === false && B.place.clipP.h > 0
  && B.place.clipP.verdict === 'moved',
  'stillFailing=' + B.place.clipP.stillFailing
  + ' verdict=' + B.place.clipP.verdict + ' 高=' + B.place.clipP.h);

/* ---- ③ P-1 的真实收益：假阳性不再被逐出容器（归属与形态） ---- */
check('A 组（基线缺陷）：假阳性容器（放得下）也被误逐出容器',
  A.place.fpP.inside === false, JSON.stringify(A.place.fpP));
check('【P-1 收益 · 归属】假阳性容器：B 组译文留在容器内（不再无谓搬迁）',
  B.place.fpP.inside === true, JSON.stringify(B.place.fpP));
check('【P-1 收益 · 可见性】假阳性容器：B 组译文留在里面也看得见',
  B.place.fpP.stillFailing === false && B.place.fpP.h > 0);
check('【P-1 收益 · 形态】A 组被逐出的译文撑成整页宽（脱离卡片）',
  A.place.fpP.w === A.stageContentW && A.place.fpP.w > B.place.fpP.w * 2,
  'A 宽=' + A.place.fpP.w + '（#stage 内容宽 ' + A.stageContentW + '）'
  + ' vs B 宽=' + B.place.fpP.w + '（与卡片同宽）');
check('【P-1 收益 · 容器完整性】假阳性容器被译文撑高，说明译文归属仍在它里面',
  B.boxH.fpBox > A.boxH.fpBox,
  'A 容器高=' + A.boxH.fpBox + '（译文在盒子外） vs B 容器高=' + B.boxH.fpBox
  + '（译文在盒子里）');
check('【等价性 · 记录在案】两组页高一致 —— P-1 **不省页高**，只改归属与形态',
  A.sentinelTop === B.sentinelTop,
  'A 哨兵 top=' + A.sentinelTop + 'px vs B=' + B.sentinelTop + 'px'
  + '（容器能长高时，译文占的高度两种做法一样）');

/* ---- ④ 挪不出去时必须如实上报，不许静默 ---- */
check('挪不出去的 <td>：两组都留在原地（归属不被打乱）',
  A.place.cellP.inside === true && B.place.cellP.inside === true,
  'A=' + A.place.cellP.inside + ' / B=' + B.place.cellP.inside);
check('挪不出去的 <td>：A 组**静默** —— 判据算得出它被裁，第二级却从不回看',
  A.place.cellP.stillFailing === true && A.place.cellP.verdict === null
  && A.stats.clipUnresolved === 0,
  'judgeOne 会返回「被裁」=' + A.place.cellP.stillFailing
  + '，但 clipUnresolved=' + A.stats.clipUnresolved + '、verdict=' + A.place.cellP.verdict);
check('挪不出去的 <td>：B 组如实计入 clipUnresolved（不静默）',
  B.stats.clipUnresolved > 0 && B.place.cellP.verdict
  && B.place.cellP.verdict.indexOf('unresolved') === 0,
  'clipUnresolved=' + B.stats.clipUnresolved + ' verdict=' + B.place.cellP.verdict);

/* ---- ⑤ 口径：rescuedFromClip 从「声明」变「结果」 ---- */
check('口径：A 组 rescuedFromClip 是**声明口径** —— 连假阳性一起算成「救回来了」',
  A.stats.rescuedFromClip === 2, 'A=' + A.stats.rescuedFromClip
  + '（真裁切 1 + 假阳性 1，后者其实是被逐出容器）');
check('口径：声明口径**高估**救援数（A 比 B 多）',
  A.stats.rescuedFromClip > B.stats.rescuedFromClip,
  'A=' + A.stats.rescuedFromClip + ' vs B=' + B.stats.rescuedFromClip);
check('口径：B 组 rescuedFromClip 只数**复验通过的救援**，且不高于 relocated',
  B.stats.rescuedFromClip <= B.stats.relocated
  && B.stats.rescuedFromClip > 0,
  'B rescuedFromClip=' + B.stats.rescuedFromClip
  + ' / relocated=' + B.stats.relocated);
check('B 组：真裁切那一条确实被计入了 rescuedFromClip（≥1）',
  B.stats.rescuedFromClip >= 1);

/* ---- ⑥ 审计如实：挪不出去的那条必须被报出来，一条都不许藏 ----
 * ★ 这条断言的原版写的是「两组审计都为空」。它当时能过，是因为
 * 那时的 cellP 夹具（table-cell 上的 max-height）**根本没被裁**，
 * 于是「空」这个结论什么都没证。夹具修对之后，cellP 是真的挪不出去，
 * 审计**本来就该**报出一条 —— 报不出来才是缺陷。
 * 所以这里改成正向断言：审计必须恰好报出那一条，且归因是 clipped。 */
check('审计如实：挪不出去的那一条被报出来（两组都恰好 1 条，且归因 clipped）',
  A.auditTotal === 1 && B.auditTotal === 1
  && A.auditByReason.clipped === 1 && B.auditByReason.clipped === 1,
  'A=' + A.auditTotal + '(' + JSON.stringify(A.auditByReason) + ')'
  + ' B=' + B.auditTotal + '(' + JSON.stringify(B.auditByReason) + ')');
check('审计如实：**除了**那一条，两组都不留其它不可见译文（真能救的都救干净了）',
  A.auditTotal - (A.auditByReason.clipped || 0) === 0
  && B.auditTotal - (B.auditByReason.clipped || 0) === 0);

const failed = results.filter((r) => !r.ok);
console.log('────────────────────────────────────────────────────');
if (failed.length) {
  console.log('失败 ' + failed.length + ' 项，通过 ' + (results.length - failed.length) + ' 项');
  failed.forEach((f) => console.log('  ✗ ' + f.name));
  process.exit(1);
}
console.log('全部通过：' + results.length + ' 项检查');
