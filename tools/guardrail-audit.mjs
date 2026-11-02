#!/usr/bin/env node
/*
 * 叠译 · 护栏入册机械闸门（遗留承诺 P-4 的闭环件）—— 2026-09-29
 * ==================================================================
 * 解决的问题
 * ------------------------------------------------------------------
 * 《历史缺陷回归护栏清单》把历史缺陷按 A–F 六族列成表，每行 = 缺陷 + 能抓住它的
 * 断言 + 一键复跑命令。但「表在」不等于「新缺陷会被记进去」——过去这条承诺
 * 在事件 4、事件 5 两次遗留未启动，原因就是**靠人记**。
 *
 * 本脚本把「新缺陷有没有入册」变成**一条能红的检查**：
 *
 *   全集   = 《docs/变更台账.md》里登记为变更的 C-NN（"发生过什么"的唯一权威源）
 *   已入册 = 《docs/历史缺陷回归护栏清单.md》正文里提到编号的 C-NN
 *   缺口   = 全集 − 已入册 − 排除清单
 *   缺口非空 → 打印缺口 + 台账行标题，退出码 1
 *
 * 为什么「已入册」只认编号被写进护栏清单：清单是按「如果这个缺陷复活，哪一条
 * 断言会变红」组织起来的。一旦某次变更的编号根本没进清单，那条变更对应的现象
 * 就不可能有人去复盘，护栏体系对它就是盲的。要求写编号，是为了逼出那条断言。
 *
 * 六条检查
 * ------------------------------------------------------------------
 *   一、缺陷入册核对（核心闸门：缺口必须为空）
 *   二、门禁清单每一行必须同时有「能抓住它的护栏」与「复跑方式」（空单元格 = 没护栏）
 *   三、清单里引用的 tools/ 文件必须真实存在（防「清单漂移」：文件改名了清单没改）
 *   四、清单末尾「一键复跑」块与实际 tools/ 套件双向一致（漏登记 / 幽灵套件）
 *   五、清单头条的「快照计数」必须与权威源一致（防头条数字腐化）
 *   六、台账内「裸提及但未登记」的编号（副检：补 check 一 只看"登记形态"的盲区）
 *
 * 运行
 * ------------------------------------------------------------------
 *   node tools/guardrail-audit.mjs         # 在项目根目录执行
 *   退出码 0 = 可发版；1 = 有缺口，红灯不发版
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LEDGER_PATH = path.join(ROOT, 'docs', '变更台账.md');
const GUARD_PATH = path.join(ROOT, 'docs', '历史缺陷回归护栏清单.md');
const TOOLS_DIR = path.join(ROOT, 'tools');

/* ==================================================================
 * 排除清单 —— 显式、有理由、可打印
 * ------------------------------------------------------------------
 * 台账里有些 C 编号**不是缺陷**：纯版本号提升、纯文档、纯命名、测试基建、
 * 以及"用户新需求"这类需求变更。这些不该被要求写进缺陷护栏清单，
 * 因此必须在下面**逐条列名**，不许用正则悄悄过滤掉（正则过滤等于把闸门关掉）。
 *
 *   ★ 排除清单的增长本身应被视为可疑信号 ★
 *   每加一条，都意味着"台账里又多了一条无法用护栏表达的变更"。
 *   正常版本里版本号提升每年也就几条；如果某个版本一口气加进来十条，
 *   大概率不是"文案/版本变更变多了"，而是有人用排除清单来让闸门变绿。
 *   复核人应当逐条追问：这条真的不是缺陷吗？有没有可能它只是"还没被写成断言"？
 *   答不出"它本来就不该有护栏"的，就不该待在这张表里，而应去补断言。
 * ================================================================== */
const EXCLUSIONS = [
  { id: 'C-04', reason: '需求变更（用户要求默认不自动翻译），非缺陷' },
  { id: 'C-10', reason: '术语基座版本号提升（TERMINOLOGY_VERSION），非缺陷' },
  { id: 'C-14', reason: '测试基建（新增多场景 e2e），无产品代码改动，非缺陷' },
  { id: 'C-15', reason: '纯文档（知识库架构评估，结论为"不做"），非缺陷' },
  { id: 'C-16', reason: '版本号变更 1.7.3 → 1.7.4，非缺陷' },
  { id: 'C-18', reason: '版本号变更 1.7.4 → 1.7.5，非缺陷' },
  { id: 'C-20', reason: '版本号变更 1.7.5 → 1.7.6，非缺陷' },
  { id: 'C-30', reason: '版本号变更 1.7.6 → 1.7.7，非缺陷' },
  { id: 'C-33', reason: '命名变更（产品名「双语助手」→「叠译」），非缺陷' },
  { id: 'C-39', reason: '测试基建（probe-c27-axis A 组期望翻写为 C-34 后契约，探针文件改动，无产品代码改动），非缺陷' },
  { id: 'C-41', reason: '需求/合规变更（L1 引擎合规改造，已登记未实施），非缺陷' },
  { id: 'C-47', reason: '商业决策（定价方案定数，已登记未实施，扩展代码零改动），非缺陷' },
  { id: 'C-48', reason: '项目立项（轨道三后台管理，未动工，扩展代码零改动），非缺陷' },
  { id: 'C-49', reason: '项目管理（后台管理部成立 + Web 详设 v2 + 测试用例文档，纯文档，扩展产品代码零改动），非缺陷' },
  { id: 'C-50', reason: '组织变更（前台开发部成立，纯文档，扩展产品代码零改动），非缺陷' },
  { id: 'C-52', reason: '后台 Web 动工（admin-web 新建 + admin.mjs 重构自测覆盖，扩展产品代码零改动，联调探针 14/14），非缺陷' },
  { id: 'C-53', reason: '平台化重设计（架构文档 + UI/UX 规范 + admin-web v2 + UX 走查探针 16/16，扩展产品代码零改动），非缺陷' },
  { id: 'C-55', reason: '法务文档（隐私政策 v1.1 + 用户协议 v1.0 条款草案，扩展产品代码零改动），非缺陷' },
  { id: 'C-56', reason: '版本变更 1.7.7 → 1.7.8 + 上线启动（发布包打包与实机冒烟 6/6、上线材料/手册纯文档；C-54 产品修复本身已单独入册），非缺陷' },
  { id: 'C-57', reason: '管理后台独立建仓 + React/OpenAPI 重构立项（新仓纯文档/契约/设计稿，扩展产品代码零改动，签名迁移未动工），非缺陷' },
  { id: 'C-58', reason: '运维基建（devops-deploy-engineer skill 新增 + 部署方案文档，扩展产品代码零改动），非缺陷' },
];

/* ------------------------------------------------------------------
 * 计数与判定
 * ------------------------------------------------------------------ */
let passed = 0;
const failures = [];
function ok(label) {
  passed++;
  console.log('  \u2713 ' + label);
}
function bad(label, detail) {
  failures.push(label + (detail ? '  → ' + detail : ''));
  console.log('  \u2717 ' + label + (detail ? '  → ' + detail : ''));
}
function section(t) { console.log('\n' + t); }
function sortByNum(ids) {
  return ids.slice().sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
}

/* ==================================================================
 * 一、读文件
 * ================================================================== */
function readOrDie(p, label) {
  if (!fs.existsSync(p)) {
    console.error('\u2717 找不到' + label + '：' + p);
    process.exit(2);
  }
  return fs.readFileSync(p, 'utf8');
}

const ledgerText = readOrDie(LEDGER_PATH, '变更台账');
const guardText = readOrDie(GUARD_PATH, '护栏清单');

console.log('叠译 · 护栏入册机械闸门（P-4）');
console.log('  权威源   ：docs/变更台账.md');
console.log('  已入册源 ：docs/历史缺陷回归护栏清单.md');

/* ==================================================================
 * 二、解析「全集」——台账里被"登记"的变更
 * ------------------------------------------------------------------
 * 只认两种形态，避免正文里的顺带提及（如"见 C-27"、"C-19…C-20"）被当成新变更：
 *   | C-NN | 版本 | 日期 | 变更内容 | …            → 登记表行
 *   ### C-NN（日期）：标题                          → 台账追加的小节
 * ================================================================== */
function parseLedger(text) {
  const entries = new Map(); // id -> 台账里的那一行标题
  for (const line of text.split(/\r?\n/)) {
    const row = line.match(/^\|\s*(C-\d{2})\s*\|(.+)$/);
    if (row) {
      /* 首格后依次是 版本 | 日期 | 变更内容 | … */
      const cells = row[2].split('|').map((s) => s.trim());
      entries.set(row[1], clean((cells[2] || '').trim()));
      continue;
    }
    const head = line.match(/^#{2,4}\s*(C-\d{2})（([^）]*)）：\s*(.+?)\s*$/);
    if (head) entries.set(head[1], clean(head[3].trim()));
  }
  return entries;
}
function clean(s) { return s.replace(/\*\*/g, '').trim(); }

/* ==================================================================
 * 三、解析「已入册」——护栏清单正文里出现的 C 编号
 * ------------------------------------------------------------------
 * 两处必须小心，否则会算出**假的已入册**（闸门静默失效，比红灯更危险）：
 *
 *   ① 范围记法：正文有一句"30 个变更（C-01…C-30）"，那是"共 30 条"的意思，
 *      不指代任何单条。先把范围整体剔除，再提取编号。
 *   ② 行首单元格：门禁清单的行号与变更编号**同形** —— 族 C 的第 10 行写作
 *      `| C-10 |`，而变更 C-10 也确实存在。二者只差在语义上。因此把每个
 *      表格行的**第一个单元格**（永远是行号列）整体去掉，再扫描其余部分。
 * ================================================================== */
function parseGuard(text) {
  /* ① 剔范围记法（…/.../~/～/至/—/-） */
  const noRange = text.replace(
    /C-\d{2}\s*(?:\u2026|\.{2,}|~|\uff5e|至|\u2014|--|-)\s*C-\d{2}/g,
    '（范围记法，不指代单条变更）');

  /* ② 表格行去掉首个单元格（行号列） */
  const stripped = noRange.split(/\r?\n/).map((line) => {
    if (!/^\s*\|/.test(line)) return line;
    const end = line.indexOf('|', line.indexOf('|') + 1);
    return end >= 0 ? line.slice(end) : line;
  }).join('\n');

  const ids = new Set();
  const re = /C-(\d{2})(?![0-9])/g;
  let m;
  while ((m = re.exec(stripped)) !== null) ids.add('C-' + m[1]);
  return ids;
}

/* ==================================================================
 * 检查一：缺口 = 全集 − 已入册 − 排除
 * ================================================================== */
section('一、缺陷入册核对（核心闸门）');

const ledger = parseLedger(ledgerText);
const registered = parseGuard(guardText);
const excluded = new Map(EXCLUSIONS.map((e) => [e.id, e.reason]));
const universe = [...ledger.keys()];
const gap = sortByNum(universe.filter((id) => !registered.has(id) && !excluded.has(id)));

console.log('  全集 ' + universe.length + ' 条 / 已入册 ' + registered.size
  + ' 条 / 显式排除 ' + excluded.size + ' 条 / 缺口 ' + gap.length + ' 条');

if (universe.length === 0) {
  bad('台账里一条变更都没解析到（解析器失效？）', LEDGER_PATH);
} else {
  ok('台账解析到 ' + universe.length + ' 条变更登记（C-' + universe[0].slice(2)
    + ' … C-' + sortByNum(universe).slice(-1)[0].slice(2) + '）');
}

/* 排除清单是显式的、要能复核 —— 一律打印 */
console.log('  排除清单（' + EXCLUSIONS.length + ' 条，增长即可疑信号）：');
for (const e of EXCLUSIONS) {
  const known = ledger.has(e.id);
  console.log('    ' + e.id + '  ' + e.reason + (known ? '' : '   [警告：台账里没有此编号]'));
  if (!known) bad('排除清单含台账中不存在的编号 ' + e.id, '排除清单已腐化，请清理');
}
const staleExclusion = EXCLUSIONS.filter((e) => ledger.has(e.id) && registered.has(e.id));
for (const e of staleExclusion) {
  bad('排除清单与已入册冲突：' + e.id, '既被排除又被引用，请二选一');
}

if (gap.length === 0) {
  ok('无缺口：每条变更要么有护栏，要么在排除清单里有明确理由');
} else {
  bad('缺口 ' + gap.length + ' 项（台账已登记，护栏清单从未提到它）');
  for (const id of gap) {
    console.log('      ' + id + '  ' + (ledger.get(id) || '(台账行标题解析失败)'));
  }
  console.log('    → 处置：为该缺陷补一行护栏（写清"哪条断言会变红"），');
  console.log('      或加入上面的排除清单并写明理由。红灯不发版。');
}

/* ==================================================================
 * 检查二：门禁清单每一行都要"有牙齿"
 * ------------------------------------------------------------------
 * 一行 = 一条历史缺陷。缺「能抓住它的护栏」= 这条缺陷复活时没人会知道；
 * 缺「复跑方式」= 知道该跑什么却没人跑得起来。两者缺一即为缺口。
 * ================================================================== */
section('二、门禁清单行完整性（断言 + 复跑命令）');

const families = new Map(); // A..F -> { rows, incomplete }
for (const line of guardText.split(/\r?\n/)) {
  const m = line.match(/^\|\s*([A-F])-(\d+)\s*\|/);
  if (!m) continue;
  const fam = m[1];
  const label = fam + '-' + m[2];
  const cells = line.split('|').map((s) => s.trim());
  /* cells[0]='' cells[1]=行号 cells[2]=历史缺陷 cells[3]=曾发生
     cells[4]=能抓住它的护栏 cells[5]=复跑方式 cells[6]=状态 */
  const guardCell = (cells[4] || '').trim();
  const rerunCell = (cells[5] || '').trim();
  if (!families.has(fam)) families.set(fam, []);
  families.get(fam).push(label);

  if (!guardCell) bad('族 ' + label + ' 缺「能抓住它的护栏」', '空单元格');
  else if (!rerunCell) bad('族 ' + label + ' 缺「复跑方式」', '空单元格');
  else ok('族 ' + label + ' 具备断言与复跑命令');
}

for (const fam of ['A', 'B', 'C', 'D', 'E', 'F']) {
  const rows = families.get(fam);
  if (!rows || rows.length === 0) bad('族 ' + fam + ' 一行都没有', '族表缺失或全部空行');
  else ok('族 ' + fam + ' 共 ' + rows.length + ' 行');
}

/* ==================================================================
 * 检查三：清单引用的 tools/ 文件必须真实存在（防清单漂移）
 * ------------------------------------------------------------------
 * 典型漂移：文件改了名字（如 c27 → c27-axis），清单没跟着改，
 * 于是"复跑方式"栏看起来齐备，实际跑起来报 ENOENT。人不会发现，闸门能。
 * ================================================================== */
section('三、清单引用的 tools/ 文件是否存在');

const referenced = [...new Set(guardText.match(/tools\/[A-Za-z0-9_.\-]+/g) || [])].sort();
let refMissing = 0;
for (const rel of referenced) {
  if (fs.existsSync(path.join(ROOT, rel))) ok('存在 ' + rel);
  else { refMissing++; bad('清单引用了不存在的文件 ' + rel, '清单漂移：文件已改名或删除'); }
}
if (referenced.length === 0) bad('清单里一个 tools/ 路径都没解析到', '解析器失效？');
console.log('  共引用 ' + referenced.length + ' 个 tools/ 文件，缺失 ' + refMissing + ' 个');

/* ==================================================================
 * 检查四：「一键复跑」块与实际套件双向一致
 * ------------------------------------------------------------------
 * 口径：单元套件 = tools/test-*.mjs + tools/selftest.mjs。
 *   e2e-*.mjs 需要真实浏览器与（部分）真实站点，probe-*.mjs 为按需诊断探针，
 *   二者不计入"全量单元回归"的自动比对，但清单里 **点名写出** 的 node 行
 *   仍逐条检查文件存在（见下）。
 * ================================================================== */
section('四、一键复跑清单与实际套件一致性');

const blocks = guardText.match(/```[a-zA-Z]*\n[\s\S]*?```/g) || [];
const rerunBlock = blocks.find((b) => /\bfor\s+t\s+in\b/.test(b));
if (!rerunBlock) {
  bad('没找到含 `for t in` 的「一键复跑」代码块', '清单结构与闸门解析不一致');
} else {
  const loopLine = (rerunBlock.match(/\bfor\s+t\s+in\s+([\s\S]*?);\s*do\b/) || [])[1] || '';
  const listed = loopLine.split(/\s*\\\s*|\s+/).map((s) => s.trim()).filter(Boolean);

  const actual = fs.readdirSync(TOOLS_DIR)
    .filter((f) => /^test-.*\.mjs$/.test(f) || f === 'selftest.mjs')
    .map((f) => f.replace(/\.mjs$/, '')).sort();

  const missingFile = listed.filter((t) => !fs.existsSync(path.join(TOOLS_DIR, t + '.mjs')));
  const notListed = actual.filter((t) => !listed.includes(t));
  const ghost = listed.filter((t) => !actual.includes(t) && fs.existsSync(path.join(TOOLS_DIR, t + '.mjs')));

  console.log('  清单声明 ' + listed.length + ' 套 / tools/ 实际 ' + actual.length + ' 套');

  if (missingFile.length === 0) ok('清单里的 ' + listed.length + ' 套文件全部存在');
  for (const t of missingFile) bad('清单列了但文件不存在：' + t, 'tools/' + t + '.mjs');

  if (notListed.length === 0) ok('tools/ 下没有"新增但未进复跑清单"的套件');
  for (const t of notListed) bad('新增套件未进复跑清单：' + t, 'tools/' + t + '.mjs 跑不到');

  if (ghost.length === 0) ok('清单与目录双向一致');
  else for (const t of ghost) bad('清单条目与目录清单不一致：' + t, '');

  /* 清单里单独写的 `node tools/xxx.mjs` 行，逐个查存在 */
  const named = [...new Set((rerunBlock.match(/^\s*node\s+(tools\/[A-Za-z0-9_.\-]+\.mjs)/gm) || [])
    .map((l) => l.trim().split(/\s+/)[1]))];
  for (const rel of named) {
    if (fs.existsSync(path.join(ROOT, rel))) ok('复跑块点名 ' + rel + ' 存在');
    else bad('复跑块点名了不存在的文件 ' + rel, '');
  }
}

/* ==================================================================
 * 检查五：清单头条的「快照计数」必须与权威源一致
 * ------------------------------------------------------------------
 * 清单开头那句「项目已有 N 条教训（L-a…L-b）与 M 项变更（C-01…C-c）」是**快照**。
 * 快照天然会腐：它曾经在台账到了 C-33 时还写着「30 个变更（C-01…C-30）」。
 *
 * 两种处置快照漂移的办法：
 *   (a) 把它删掉  —— 读者失去"规模感"（这份清单有多重？）；
 *   (b) 把它**变成受闸门保护的量** —— 数字留在原处，但一旦与权威源不符就红。
 * 这里选 (b)：删掉只是把问题藏起来，钉住才是真的让它不再漂移。
 *
 * 变更数直接与台账核对；教训数没有第二权威源可对，就只做**内部自洽**核对
 * （「21 条（L-1…L-21）」而不是「20 条（L-1…L-21）」）。
 * ================================================================== */
section('五、清单头条快照计数（必须与权威源一致）');

const changeNote = guardText.match(/与\s*(\d+)\s*[个项]变更（C-(\d{2})…C-(\d{2})）/);
if (!changeNote) {
  bad('头条里找不到「与 N 项变更（C-aa…C-bb）」字样', '格式变了，闸门解析器需要同步');
} else {
  const declaredCount = Number(changeNote[1]);
  const declaredLo = changeNote[2];
  const declaredHi = changeNote[3];
  const nums = universe.map((id) => Number(id.slice(2)));
  const realHi = String(Math.max(...nums)).padStart(2, '0');
  const realLo = String(Math.min(...nums)).padStart(2, '0');

  if (declaredCount === universe.length && declaredLo === realLo && declaredHi === realHi) {
    ok('头条变更快照与台账一致（' + declaredCount + ' 项，C-' + declaredLo + '…C-' + declaredHi + '）');
  } else {
    bad('头条变更快照已腐',
      '头条写 ' + declaredCount + ' 项 C-' + declaredLo + '…C-' + declaredHi
      + '；台账实际 ' + universe.length + ' 项 C-' + realLo + '…C-' + realHi
      + '（请同步头条，或把数字换成指向台账的表述）');
  }
}

const lessonNote = guardText.match(/已有\s*(\d+)\s*条教训（L-(\d+)…L-(\d+)）/);
if (!lessonNote) {
  bad('头条里找不到「已有 N 条教训（L-a…L-b）」字样', '格式变了，闸门解析器需要同步');
} else {
  const declared = Number(lessonNote[1]);
  const lo = Number(lessonNote[2]);
  const hi = Number(lessonNote[3]);
  if (declared === hi - lo + 1) {
    ok('头条教训快照内部自洽（' + declared + ' 条，L-' + lo + '…L-' + hi + '）');
  } else {
    bad('头条教训快照内部不自洽',
      '写「' + declared + ' 条（L-' + lo + '…L-' + hi + '）」但 L-' + lo + '…L-' + hi
      + ' 是 ' + (hi - lo + 1) + ' 条');
  }
}

/* ==================================================================
 * 检查六：台账内「裸提及但未登记」的编号（副检 · 补 check 一 的盲区）
 * ------------------------------------------------------------------
 * check 一 的 universe **只从"登记形态"出发**（表行 / 小节）。于是它有两副面孔：
 *   · 「**登记了**却没有护栏」→ 看得见（缺口项，红灯）；
 *   · 「**连登记都没有**，却在正文里被引用」→ **看不见**（压根不在 universe）。
 * 后者是真实盲区。实例 `C-37`（2026-09-29 P-1 闭环日的"悬停标注改盒模型"，
 * 记于《风险登记册》R-10、标为"未闭环"）被 13 份文档引用，却**既无表行也无小节**
 * ⇒ 旧闸门对它是瞎的；且"越引用越看得见、越不登记越安全"是**反向激励**。
 *
 * 本副检：取台账里**全部** `C-\d{2}`（**不限形态**，正文里的裸提及都算）
 *         − universe（登记形态）− EXCLUSIONS；**非空即红灯**。
 * 方向**只紧不松**：只会把"引用了一个台账从未登记的编号"顶出来。
 *
 * 为什么不会误伤正文互引（「见 C-27」「C-19…C-20」「C-01…C-67」）：
 *   凡被引用的编号本身都已登记 ⇒ 已在 universe 内 ⇒ 差集不含它们。
 *   只有"未登记的裸提及"才会落进差集（当前唯一 = C-37）。
 * ================================================================== */
section('六、台账内「裸提及但未登记」的编号（副检）');

/* 纯函数 + **导出**：本副检的牙齿用"内存变异"证明 —— 同一份逻辑，喂入注入了
 * 一个未登记编号的台账文本，须变红。导出纯粹是为了让自检能调用同一实现，
 * 不写任何文件（Node 的 `node:fs` 命名空间只读，无法用 monkey-patch 做变异）。 */
export function findBareUnregisteredIds(ledgerText, exclusions = EXCLUSIONS) {
  const reg = parseLedger(ledgerText);
  const ex = new Set(exclusions.map((e) => e.id));
  const all = new Set();
  const re = /C-(\d{2})(?![0-9])/g;   /* 与 parseLedger/parseGuard 同口径：两位数字 + 右侧不得接数字 */
  let m;
  while ((m = re.exec(ledgerText)) !== null) all.add('C-' + m[1]);
  return {
    allCount: all.size,
    registeredCount: reg.size,
    missing: sortByNum([...all].filter((id) => !reg.has(id) && !ex.has(id))),
  };
}

const bareCheck = findBareUnregisteredIds(ledgerText);

console.log('  台账出现编号 ' + bareCheck.allCount + ' 个 / 登记形态 ' + bareCheck.registeredCount
  + ' 个 / 裸提及未登记 ' + bareCheck.missing.length + ' 个');

if (bareCheck.allCount === 0) {
  bad('台账里一个 C 编号都没解析到', '解析器失效？');
} else if (bareCheck.missing.length === 0) {
  ok('台账里没有"裸提及但未登记"的编号（登记形态覆盖了全部被引用的编号）');
} else {
  bad('台账内 ' + bareCheck.missing.length + ' 个编号被引用却无登记行/小节');
  for (const id of bareCheck.missing) {
    const one = new RegExp('C-' + id.slice(2) + '(?![0-9])');
    const hits = [];
    ledgerText.split(/\r?\n/).forEach((l, i) => { if (one.test(l)) hits.push(i + 1); });
    console.log('      ' + id + '  出现于台账行：'
      + hits.slice(0, 5).join(', ') + (hits.length > 5 ? ' …（共 ' + hits.length + ' 处）' : ''));
  }
  console.log('    → 处置：为它在《变更台账》补一条登记（表行或小节）。');
  console.log('      ⚠ 同轮须知：补登记会让它**进入 check 一 的 universe** ⇒ 若《护栏清单》侧无对应行，');
  console.log('        check 一 将当场变红 ⇒ **台账行与清单行必须同轮一起补**。红灯不发版。');
}

/* ==================================================================
 * 收尾
 * ================================================================== */
console.log('\n' + '─'.repeat(52));
if (failures.length) {
  console.log('失败 ' + failures.length + ' 项，通过 ' + passed + ' 项');
  failures.forEach((f) => console.log('  \u2717 ' + f));
  process.exit(1);
}
console.log('全部通过：' + passed + ' 项检查');
process.exit(0);
