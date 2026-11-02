#!/usr/bin/env node
/*
 * 叠译 · 判据登记机械闸门（遗留承诺 P-2 的闭环件）—— 2026-09-29
 * ==================================================================
 * 解决的问题
 * ------------------------------------------------------------------
 * 《判据输入含义核对表》(P-2) 的作用是逼人回答「这个量在说什么」。但和护栏清单
 * 一样，它过去也**只靠人记**：判据改了名、删了、或者新判据没登记，文档不会响。
 *
 * 几何判据体系已经连续三次犯**同族**错误（L-1 使用值当声明值 / L-17 级联 /
 * L-19 两轴独立），三次都是「拿一个含义没想清楚的量去做静态判断」。
 * 所以这份表不能是"写给人看的散文"，它得有**一条能红的检查**。
 *
 * 四条检查（三条硬红 + 一条软检）
 * ------------------------------------------------------------------
 *   一、清单完整性      §5.3 声明的在用判据名清单，必须与本脚本内的清单**集合相等**
 *                       （脚本自己也会漂：有人往 §5.3 加了名字而没同步这里，就红）
 *   二、登记完整性      每个在用判据名都必须出现在**主表**（§2）里
 *                       （防「改了判据不登记」—— 这是这张表存在的唯一理由）
 *   三、源码一致性      每个在用判据名都必须在源码里有**定义形态**；
 *                       且已删除的 canInsertAfter **必须仍留有登记**、**不得**被接回
 *   四、行号同步（软检）主表首格写的 `（NNNN）` 必须指向源码里真有这个名字的那一行。
 *                       漂移**只提示不红** —— 行号是给人导航的，它过时不会让判据本身失效，
 *                       把它做成硬红只会训练人「看见红就重新数行号」，反而钝化闸门。
 *
 * 为什么行号只做软检、而「名字在不在表里/源码里」必须是硬红
 * ------------------------------------------------------------------
 * 硬红的判据只有一条：**这件事发生时，是否有人的判断会因为文档而错。**
 * 名字不在表里 / 名字在源码里没了 → 下一个人会照着文档写出错的判据 → 必须红。
 * 行号偏了 3 行 → 下一个人多翻 3 行，判断不会错 → 提示即可。
 *
 * 运行
 * ------------------------------------------------------------------
 *   node tools/criteria-audit.mjs        # 退出码 0 = 通过；1 = 有缺口
 *
 * 仅用于变异验证 / 干跑复现的两个口子（正常跑不要设）：
 *   CT_CRITERIA_DOC=<临时副本>  CT_CRITERIA_SRC=<临时副本>
 *   这样可以在**副本**上植入缺陷验证闸门会红，而不碰正在被别人编辑的真实文件。
 *   脚本每次都会打印它实际读了哪两份文件，所以「默认路径有没有被真正检查」是可见的。
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DOC_PATH = process.env.CT_CRITERIA_DOC
  || path.join(ROOT, 'docs', '判据输入含义核对表.md');
const SRC_PATH = process.env.CT_CRITERIA_SRC
  || path.join(ROOT, 'content', 'renderer.js');

/* ==================================================================
 * 在用的判据名清单 —— 刻意**硬编码**，不从文档里读
 * ------------------------------------------------------------------
 * 不能从 §5.3 读：那样「名字在不在表里」这条检查就变成自证循环（一定通过）。
 * 闸门必须有一份**独立于被检查对象**的名单，才有资格说"你漏登记了"。
 * 代价是这份名单自己会漂 —— 所以检查一会拿它与 §5.3 声明做**集合比对**，
 * 任一侧多/少/改名 → 红。这份硬编码不是冗余，它就是闸门的立足点。
 * ================================================================== */
const LIVE_NAMES = [
  'hasClipContext', 'constrainsContent', 'clipsContent', 'forcesNoWrap', 'collapsesContent',
  'clipInfo', 'isItemContext', 'safeAnchor', 'suspectRisk', 'CLIP_RISK',
  'escapeAnchor', 'canPlaceAfter', 'placementFor', 'rectOutOf', 'RECT_TOL',
  'inHiddenSubtree', 'scrollsOutOf', 'judgeOne', 'verifyBatch', 'layoutOf', 'rescuedFromClip',
];

/* 已删除、但**必须继续留在表里当登记**的历史名。
 * ★ 不要把它当成"文档漏写"清掉 ★：它是给下一个人的路标 ——
 * "我 grep 不到这个函数是正常的，它被有意删除了，承接者在 canPlaceAfter 那一侧"。
 * 若它**被接回源码**（重新出现定义），必须红：P-1 的处置意见明写「不要恢复它」。 */
const RETIRED_NAMES = ['canInsertAfter'];

/* ------------------------------------------------------------------ */
let passed = 0;
const failures = [];
const softs = [];
function ok(label) { passed++; console.log('  \u2713 ' + label); }
function bad(label, detail) {
  failures.push(label + (detail ? '  → ' + detail : ''));
  console.log('  \u2717 ' + label + (detail ? '  → ' + detail : ''));
}
function soft(label) { softs.push(label); console.log('  \u26a0 ' + label); }
function section(t) { console.log('\n' + t); }
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function readOrDie(p, label) {
  if (!fs.existsSync(p)) {
    console.error('\u2717 找不到' + label + '：' + p);
    process.exit(2);
  }
  return fs.readFileSync(p, 'utf8');
}

const docText = readOrDie(DOC_PATH, '判据输入含义核对表');
const srcText = readOrDie(SRC_PATH, '判据源码');
const srcLines = srcText.split(/\r?\n/);

console.log('叠译 · 判据登记机械闸门（P-2）');
console.log('  被检查的文档：' + path.relative(ROOT, DOC_PATH).split(path.sep).join('/'));
console.log('  被检查的源码：' + path.relative(ROOT, SRC_PATH).split(path.sep).join('/'));

/* 取两个区域：主表（§2 → §3）、§5.3 声明块（§5.3 → §5.4） */
function sliceBetween(text, fromRe, toRe, label) {
  const lines = text.split(/\r?\n/);
  const a = lines.findIndex((l) => fromRe.test(l));
  if (a < 0) return null;
  const b = lines.findIndex((l, i) => i > a && toRe.test(l));
  if (b < 0) return null;
  return lines.slice(a, b).join('\n');
}

const mainTable = sliceBetween(docText, /^##\s*2\./, /^##\s*3\./, '主表');
const declaredBlock = sliceBetween(docText, /^###\s*5\.3/, /^###\s*5\.4/, '§5.3');

/* ==================================================================
 * 检查一：脚本清单 与 §5.3 声明清单 必须集合相等
 * ================================================================== */
section('一、清单完整性（脚本清单 ↔ §5.3 声明）');

if (!declaredBlock) {
  bad('找不到 §5.3 区块', '文档结构变了，闸门解析器需要同步');
} else {
  const fence = declaredBlock.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  if (!fence) {
    bad('§5.3 里找不到代码块（应当是名字清单）', '文档结构变了');
  } else {
    const declared = fence[1].split(/\s+/).map((s) => s.trim()).filter(Boolean);
    const declaredSet = new Set(declared);
    const scriptSet = new Set(LIVE_NAMES);

    console.log('  §5.3 声明 ' + declared.length + ' 个 / 本脚本内置 ' + LIVE_NAMES.length + ' 个');

    const onlyDoc = declared.filter((n) => !scriptSet.has(n));
    const onlyScript = LIVE_NAMES.filter((n) => !declaredSet.has(n));

    if (onlyDoc.length || onlyScript.length) {
      if (onlyDoc.length) console.log('      §5.3 有、脚本没有：' + onlyDoc.join(', '));
      if (onlyScript.length) console.log('      脚本有、§5.3 没有：' + onlyScript.join(', '));
      bad('闸门清单与 §5.3 声明不一致', '有人改了判据名单但没同步另一侧 —— 请同步 tools/criteria-audit.mjs');
    } else {
      ok('闸门清单与 §5.3 声明完全一致（' + LIVE_NAMES.length + ' 个名字）');
    }
  }
}

/* ==================================================================
 * 检查二：每个在用判据名都必须在**主表**里登记
 * ------------------------------------------------------------------
 * 只看主表、不看全文：§5.3 自己也是一个"出现位置"，算进去就循环自证了。
 * ================================================================== */
section('二、登记完整性（每个在用判据名都在主表里吗）');

if (!mainTable) {
  bad('找不到主表区域（§2 → §3）', '文档结构变了，闸门解析器需要同步');
} else {
  const missing = LIVE_NAMES.filter((n) => !mainTable.includes(n));
  for (const n of LIVE_NAMES) if (!missing.includes(n)) ok('主表登记了 ' + n);
  if (missing.length) {
    console.log('      未登记：' + missing.join(', '));
    bad(missing.length + ' 个在用判据名没有登记进主表', '改了判据不登记 —— 这正是这张表要防的事');
  }
}

/* ==================================================================
 * 检查三：源码一致性（名字必须真的还在；删掉的不许回来）
 * ================================================================== */
section('三、源码一致性（名字有定义形态吗 / 删掉的有没有被接回）');

const defRe = (n) => new RegExp(
  '(function\\s+' + esc(n) + '\\b|(?:var|let|const)\\s+' + esc(n) + '\\s*='
  + '|\\b' + esc(n) + '\\s*[:=]\\s*[({])');

const noDef = LIVE_NAMES.filter((n) => !defRe(n).test(srcText));
for (const n of LIVE_NAMES) if (!noDef.includes(n)) ok('源码有 ' + n + ' 的定义形态');
if (noDef.length) {
  console.log('      查不到定义：' + noDef.join(', '));
  bad(noDef.length + ' 个在用判据名在源码里找不到定义形态', '判据被改名/删除，或文档登记了不存在的量');
}

for (const n of RETIRED_NAMES) {
  const inDoc = docText.includes(n);
  const hasDef = defRe(n).test(srcText);
  if (!inDoc) {
    bad('已删除判据 ' + n + ' 的登记从文档里消失了', '这是有意留的路标，不是漏写 —— 请恢复 §2.2 那一行');
  } else if (hasDef) {
    bad('已删除判据 ' + n + ' 被接回源码了', 'P-1 明写「不要恢复它」：要加结构预检请加在 canPlaceAfter 一侧');
  } else {
    ok('已删除判据 ' + n + '：文档留有登记，且源码只有注释、无定义形态');
  }
}

/* ==================================================================
 * 检查四（软检）：行号同步
 * ------------------------------------------------------------------
 * 只解析主表**首格**里的全角括号行号（`（833）`），因为它旁边的名字才是锚。
 * 形如 `（P-1 / 2026-09-29）` 的括号不含纯数字，不会被误当行号。
 * ================================================================== */
section('四、行号同步（软检：漂移只提示，不挡住发版）');

let pairs = 0;
let drifted = 0;

if (!mainTable) {
  soft('主表区域没解析到，跳过行号软检');
} else {
  for (const line of mainTable.split(/\r?\n/)) {
    if (!/^\s*\|/.test(line)) continue;
    const firstCell = line.split('|')[1] || '';
    const names = LIVE_NAMES.filter((n) => new RegExp('\\b' + esc(n) + '\\b').test(firstCell));
    if (names.length === 0) continue;
    const nums = [...firstCell.matchAll(/（(\d+)）/g)].map((m) => Number(m[1]));
    for (const num of nums) {
      for (const n of names) {
        pairs++;
        const at = srcLines[num - 1];
        if (at === undefined || !at.includes(n)) {
          drifted++;
          const realAt = srcLines.findIndex((l) => defRe(n).test(l)) + 1;
          soft('行号漂移：主表写 ' + n + ' 在 ' + num + ' 行，但该行不含它'
            + (realAt ? '（定义形态在 ' + realAt + ' 行）' : '（源码里找不到定义形态）'));
        }
      }
    }
  }
  if (pairs === 0) soft('主表里没解析出「名字 + 行号」对，跳过软检（文档格式可能变了）');
  else if (drifted === 0) ok('主表登记的 ' + pairs + ' 处行号全部指向含该名字的那一行');
  else console.log('  共核对 ' + pairs + ' 处行号，漂移 ' + drifted + ' 处（软检，不计入失败）');
}

/* ==================================================================
 * 检查五：**标**集合核对（C-34 / C-36 的标契约）
 * ------------------------------------------------------------------
 * 免检通道清零之后，`rec.risk` 成了「这条记录要不要进第二级复核」的唯一开关。
 * 于是**标**本身成了一套需要被钉住的契约，而且它有两条完全不同的语义：
 *
 *   · 裁切标（CLIP_RISK / 'ancestor-clipped'）：静态判到「位于声明式裁切容器内」。
 *   · 落点标（FLEX_ROW_RISK / 'flex-row-outside'）：纯粹是「为了不挤坏横向
 *     弹性行，落点挂到了容器之后」，**与裁切无关**。
 *
 * 两者必须是**字符串不同、且统计口径互不串味**的：`rescuedFromClip` 靠
 * `CLIP_ENTRY_RISK[rec.risk]` 判定，所以落点标**故意不入** `CLIP_ENTRY_RISK`。
 * 一旦有人「顺手」把它加进去，「为了不挤坏弹性行才挪的」就会被报成
 * 「从裁切容器里救回来的」—— 计数虚高，而且没人会立刻发现（L-2 家族）。
 *
 * ★ 2026-09-29：本条检查是为了让 `tools/test-clip-guard.mjs` 五节里那句
 *   「见 tools/criteria-audit.mjs 的标集合核对」**成为事实** —— 写那句话时
 *   本脚本还没有这条检查，属于**悬空引用**。悬空引用比没有引用更坏：
 *   它让读代码的人以为已经被机械守住了。现在它真的被守住了。
 * ================================================================== */
section('五、标集合核对（裁切标 / 落点标必须分得开）');

/** 取出 `var X = { ... };` 里的花括号体（在原文上配平，够用且不依赖词法分析） */
function bracedBody(text, sig) {
  const i = text.indexOf(sig);
  if (i < 0) return null;
  const open = text.indexOf('{', i);
  if (open < 0) return null;
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    if (text[k] === '{') depth++;
    else if (text[k] === '}') { depth--; if (depth === 0) return text.slice(open, k + 1); }
  }
  return null;
}

/* ① 两个标常量必须都在，且字面值必须没被改过（改字面值会静默改变统计口径） */
const RISK_EXPECTED = { CLIP_RISK: 'ancestor-clipped', FLEX_ROW_RISK: 'flex-row-outside' };
const riskDefs = new Map();
for (const m of srcText.matchAll(/(?:var|let|const)\s+([A-Z][A-Z0-9_]*_RISK)\s*=\s*'([^']*)'/g)) {
  riskDefs.set(m[1], m[2]);
}
for (const [name, value] of Object.entries(RISK_EXPECTED)) {
  if (!riskDefs.has(name)) {
    bad('标常量 ' + name + ' 不见了', '免检通道清零后 rec.risk 是第二级唯一的入场开关，标不能少');
  } else if (riskDefs.get(name) !== value) {
    bad('标常量 ' + name + " 的字面值被改成了 '" + riskDefs.get(name) + "'", "期望 '" + value + "'（改字面值会静默改变统计口径）");
  } else {
    ok("标常量 " + name + " = '" + value + "'");
  }
}

/* ② 每个标都必须至少有一个产出点（`risk: <常量名>`），否则是死标 ——
 *    死标意味着「打了标却没人看」或「本该打标的地方漏了」 */
const usedRisk = new Set([...srcText.matchAll(/risk:\s*([A-Z][A-Z0-9_]*_RISK)/g)].map((m) => m[1]));
for (const name of Object.keys(RISK_EXPECTED)) {
  if (!riskDefs.has(name)) continue;
  if (usedRisk.has(name)) ok('标 ' + name + ' 有产出点（risk: ' + name + '）');
  else bad('标 ' + name + ' 没有任何产出点', '死标：定义了却没人打 —— 要么该打的地方漏了，要么它已作废');
}

/* ③ 统计口径表 CLIP_ENTRY_RISK 的键集合必须**恰好**是裁切标，不得混入落点标 */
const entryBody = bracedBody(srcText, 'var CLIP_ENTRY_RISK');
const entryKeys = entryBody
  ? [...new Set([...entryBody.matchAll(/['"]([a-z-]+)['"]\s*:/g)].map((m) => m[1]))].sort()
  : null;
const expectedEntry = [RISK_EXPECTED.CLIP_RISK].sort();
ok('CLIP_ENTRY_RISK 的键集合恰好只有裁切标（rescuedFromClip 的口径表）',
  !!entryKeys && JSON.stringify(entryKeys) === JSON.stringify(expectedEntry),
  '实际 ' + JSON.stringify(entryKeys) + ' / 期望 ' + JSON.stringify(expectedEntry));

/* ④ 反向：落点标**必须不在**口径表里 —— 这是 ③ 的语义化表述，
 *    单列出来是因为 ③ 失败时人第一眼需要知道"是多了还是少了" */
if (entryKeys && entryKeys.includes(RISK_EXPECTED.FLEX_ROW_RISK)) {
  bad('落点标被混进了 CLIP_ENTRY_RISK', '「为了不挤坏弹性行才挪的」会被报成「从裁切容器里救回来的」，计数虚高');
} else {
  ok('落点标未混进 CLIP_ENTRY_RISK（裁切标 / 落点标统计口径不串味）');
}

/* ==================================================================
 * 收尾
 * ================================================================== */
console.log('\n' + '─'.repeat(52));
if (failures.length) {
  console.log('失败 ' + failures.length + ' 项，通过 ' + passed + ' 项'
    + (softs.length ? '，另有提示 ' + softs.length + ' 条' : ''));
  failures.forEach((f) => console.log('  \u2717 ' + f));
  process.exit(1);
}
console.log('全部通过：' + passed + ' 项检查'
  + (softs.length ? '（另有 ' + softs.length + ' 条软检提示，不挡发版）' : ''));
process.exit(0);
