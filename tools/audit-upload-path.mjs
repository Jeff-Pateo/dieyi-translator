/*
 * 叠译 · 「上报不落入翻译主路径」静态审计（任务 #5，perf-upload）
 * ==================================================================
 * 【目的】
 * DL-10 立项「动作记录上报」时，最大性能风险不是上报本身，而是**上报挂点
 * 被塞进每波/每单元的热循环**——一旦落在 translateWave / renderUnit / verifyBatch
 * 的调用环里，请求数会从「每翻译轮 +O(1)」退化成「每单元 +O(1)」（千倍放大）。
 * 本审计对**冻结产品源码**做可复现的静态证据提取，证明：
 *   ① 扩展出网**只有白名单两处**：翻译引擎链（background/providers.js）与
 *      受控上报（background/report.js，须过受控能力契约 RB-1…RB-8）；
 *      其余背景/内容文件不得出现 fetch(（含 fetch 别名）或 sendBeacon；
 *   ② 唯一的「上行」消息是既有 REPORT（content→SW），且只在 run() 的**轮次级**
 *      相位点触发（working/done/error/off/...），**不在**波循环 / 单元循环体内；
 *   ③ SW 侧 REPORT / GET_TAB_STATS handler 与 TRANSLATE（handleTranslate）**分离**，
 *      不在 termHash / 引擎链上；
 *   ④ 因此拟议上报通道只要挂在与 R6 同级的位置（SW handler 尾部 / 轮次级），
 *      对扫描/渲染/termHash/引擎链的新增调用恒为 0。
 *
 * 【口径】纯静态文本/括号匹配分析，跑在**只读**产品源码上；不改任何文件。
 *   行号证据随输出打印（file:line），可人工复核。
 *
 * 运行：node tools/audit-upload-path.mjs
 * 输出：tools/bench-results/audit-upload-path-<时间戳>.json（另有 -latest.json）
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RESULT_DIR = path.join(HERE, 'bench-results');

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

/* ---------------- 工具：按大括号匹配抽出函数体（含起止行） ---------------- */
function extractFn(src, signature) {
  const at = src.indexOf(signature);
  if (at < 0) return null;
  const braceStart = src.indexOf('{', at + signature.length);
  if (braceStart < 0) return null;
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const body = src.slice(at, i);
  const lineOf = (idx) => src.slice(0, idx).split('\n').length;
  return { startLine: lineOf(at), endLine: lineOf(i), body, signature };
}

/** 找出 src 中所有 `needle(` 的调用行号（允许 `.` 前缀=方法调用，跳过定义行） */
function callLines(src, needle, skipLine) {
  const re = new RegExp('(^|[^\\w$])' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(', 'g');
  const lines = [];
  let m;
  while ((m = re.exec(src))) {
    const ln = src.slice(0, m.index).split('\n').length;
    if (skipLine && ln === skipLine) continue;
    lines.push(ln);
  }
  return [...new Set(lines)].sort((a, b) => a - b);
}

const out = { generatedAt: new Date().toISOString(), node: process.version, files: {}, checks: [] };
const log = [];
function say(s) { log.push(s); console.log(s); }
function check(name, ok, detail) { out.checks.push({ name, ok, detail }); say(`  ${ok ? '✓' : '✗'} ${name} :: ${detail}`); }
/* SKIP：条件不适用（如 report.js 未落地）——不计入 PASS/FAIL 分母，不判红、不抛异常 */
function checkSkip(name, detail) { out.checks.push({ name, ok: true, skipped: true, detail }); say(`  ○ ${name} :: SKIP — ${detail}`); }

/* ---------------- 轻量词法：字符串/注释感知的括号匹配（供 report.js 源码级断言用） ----------------
 * ⚠ 限制：不识别正则字面量内部的 `{`/`(`/`[`。若 report.js 在正则里写裸括号，可能误判——
 *   届时以「本工具明示 assumption」为准，人工复核，不得因误判而放宽断言。
 */
const lineOfIdx = (src, idx) => src.slice(0, idx).split('\n').length;
function skipStr(src, i) {
  const q = src[i]; i++;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === q) return i;
    i++;
  }
  return src.length - 1;
}
function skipComment(src, i) {
  if (src[i] === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); return n < 0 ? src.length - 1 : n; }
  if (src[i] === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); return n < 0 ? src.length - 1 : n + 1; }
  return -1;
}
function matchPair(src, openIdx, openCh, closeCh) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = skipStr(src, i); continue; }
    if (ch === '/') { const k = skipComment(src, i); if (k >= 0) { i = k; continue; } }
    if (ch === openCh) depth++;
    else if (ch === closeCh) { depth--; if (depth === 0) return i; }
  }
  return -1;
}
const matchParen = (src, i) => matchPair(src, i, '(', ')');
/* 收集所有不在字符串/注释内的 {} 配对（按 open 升序） */
function bracePairs(src) {
  const stack = [], pairs = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = skipStr(src, i); continue; }
    if (ch === '/') { const k = skipComment(src, i); if (k >= 0) { i = k; continue; } }
    if (ch === '{') stack.push(i);
    else if (ch === '}') { const o = stack.pop(); if (o !== undefined) pairs.push({ open: o, close: i }); }
  }
  return pairs.sort((a, b) => a.open - b.open);
}
/* 包含 idx 的最内层 { } 对象字面量 */
function innermostObject(src, idx, pairs) {
  let best = null;
  for (const p of pairs) if (p.open < idx && idx < p.close && (!best || p.open > best.open)) best = p;
  return best ? { start: best.open, end: best.close, body: src.slice(best.open + 1, best.close) } : null;
}
/* 对象字面量体 → 顶层 [key,val]（depth0 逗号切分；支持简写键；展开项跳过） */
function objEntries(body) {
  const res = [];
  let depth = 0, start = 0;
  const flush = (s, e) => {
    const raw = body.slice(s, e).trim();
    if (!raw || raw.startsWith('...')) return;
    let d = 0, ci = -1;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '"' || ch === "'" || ch === '`') { i = skipStr(raw, i); continue; }
      if (ch === '{' || ch === '[' || ch === '(') d++;
      else if (ch === '}' || ch === ']' || ch === ')') d--;
      else if (ch === ':' && d === 0) { ci = i; break; }
    }
    if (ci < 0) { // 简写
      const k = raw.replace(/^['"`]|['"`]$/g, '');
      if (/^[A-Za-z_$][\w$]*$/.test(k)) res.push({ key: k, val: k });
      return;
    }
    const k = raw.slice(0, ci).trim().replace(/^['"`]|['"`]$/g, '');
    if (/^[A-Za-z_$][\w$]*$/.test(k)) res.push({ key: k, val: raw.slice(ci + 1).trim() });
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = skipStr(body, i); continue; }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) { flush(start, i); start = i + 1; }
  }
  flush(start, body.length);
  return res;
}
const objTopKeys = (body) => objEntries(body).map((e) => e.key);
/* 收集 if ( ... ) { ... } 区段（cond 文本 + 块区间），用于判「fetch 是否被守卫」 */
function ifRegions(src) {
  const regions = [], pairs = bracePairs(src);
  const re = /\bif\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const openParen = src.indexOf('(', m.index);
    const closeParen = matchParen(src, openParen);
    if (closeParen < 0) continue;
    const cond = src.slice(openParen + 1, closeParen);
    let j = closeParen + 1;
    while (j < src.length && /\s/.test(src[j])) j++;
    let bodyStart = -1, bodyEnd = -1;
    if (src[j] === '{') { const pk = pairs.find((p) => p.open === j); if (pk) { bodyStart = pk.open; bodyEnd = pk.close; } }
    regions.push({ cond, bodyStart, bodyEnd });
  }
  return regions;
}
/* 取某调用点（左括号 idx）的实参文本 */
function callArg(src, lparenIdx) { const close = matchParen(src, lparenIdx); return close < 0 ? '' : src.slice(lparenIdx + 1, close); }
/* depth0 逗号切分（数组元素 / 顶层片段） */
function splitTopLevel(s) {
  const parts = []; let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = skipStr(s, i); continue; }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  if (s.slice(start).trim()) parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}
const countLabel = (src, label) => (src.match(new RegExp('([\'"])' + label.replace(':', '\\:') + '\\1', 'g')) || []).length;
/* 注释置空（保留长度与换行）——使 marker/计数只作用于**代码**，不会被注释命中 */
function stripComments(src) {
  const a = src.split('');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = skipStr(src, i); continue; }
    if (ch === '/' && src[i + 1] === '/') { let n = src.indexOf('\n', i); n = n < 0 ? src.length : n; for (let k = i; k < n; k++) a[k] = ' '; i = n; continue; }
    if (ch === '/' && src[i + 1] === '*') { let n = src.indexOf('*/', i + 2); n = n < 0 ? src.length : n + 2; for (let k = i; k < n; k++) if (a[k] !== '\n') a[k] = ' '; i = n - 1; continue; }
  }
  return a.join('');
}
/* fetch 别名（const f = ... fetch，报告已按此隔离出站调用） */
function fetchAliases(src) {
  const names = []; const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\bfetch\b/g; let m;
  while ((m = re.exec(src))) names.push(m[1]);
  return [...new Set(names)];
}
/* 文件级出（网）调用行 = 直接 fetch( + fetch 别名调用（防「用别名绕过直扫」的盲区） */
function fetchCallLines(src, allowAlias) {
  const set = new Set(callLines(src, 'fetch', null));
  if (allowAlias !== false) for (const a of fetchAliases(src)) for (const l of callLines(src, a, null)) set.add(l);
  return [...set].sort((x, y) => x - y);
}
/* 顶层函数声明（函数体经大括号匹配；含 export/async） */
function allFunctions(src) {
  const pairs = bracePairs(src), res = [];
  const re = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g; let m;
  while ((m = re.exec(src))) {
    const braceIdx = src.indexOf('{', m.index + m[0].length);
    if (braceIdx < 0) continue;
    const pk = pairs.find((p) => p.open === braceIdx);
    if (pk) res.push({ name: m[1], start: pk.open, end: pk.close, body: src.slice(pk.open + 1, pk.close) });
  }
  return res;
}
/* 函数体内被调用的标识符（粗略，够用于 guard 谓词可达性） */
function callsOf(body) {
  const s = new Set(); const re = /(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g; let m;
  const KW = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'typeof', 'await', 'new', 'return', 'of']);
  while ((m = re.exec(body))) if (!KW.has(m[2])) s.add(m[2]);
  return s;
}

/* ==================================================================
 * ① 全仓出网调用扫描（区分「翻译引擎出网」与「上报出网」）
 * ================================================================== */
const SCAN_DIRS = ['content', 'background', 'shared', 'options', 'popup', 'pdf', 'admin-web'];
const SKIP_RE = /(node_modules|[\\/]dist[\\/]|[\\/]bench-results[\\/]|\.md$|\.bak$)/;
function walk(dir, acc) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return acc;
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, ent.name);
    if (SKIP_RE.test(rel)) continue;
    if (ent.isDirectory()) walk(rel, acc);
    else if (/\.(js|mjs|html)$/.test(ent.name)) acc.push(rel);
  }
  return acc;
}
let files = [];
for (const d of SCAN_DIRS) files = walk(d, files);

const fetchHits = [], beaconHits = [];
for (const f of files) {
  const src = read(f);
  // vendor 压缩产物不做别名展开（避免压缩代码误识别），其余扩展运行时含别名
  const fl = fetchCallLines(src, !/pdf[\\/]vendor/.test(f));
  if (fl.length) fetchHits.push({ file: f, lines: fl });
  const bl = callLines(src, 'sendBeacon', null);
  if (bl.length) beaconHits.push({ file: f, lines: bl });
}
// 出网分类：引擎链（providers.js）/ 上报通道（report.js，受控）/ PDF 库 / 旧世代后台 web / 其余（=可疑上报）
const isEngine = (f) => f.replace(/\\/g, '/') === 'background/providers.js';
const isReport = (f) => f.replace(/\\/g, '/') === 'background/report.js';
const isVendor = (f) => /pdf[\\/]vendor/.test(f);
const isOldAdmin = (f) => /admin-web/.test(f);
const suspicious = fetchHits.filter((h) => !isEngine(h.file) && !isVendor(h.file) && !isOldAdmin(h.file));

say('── ① 全仓出网调用扫描 ──');
say(`扫描 ${files.length} 个源文件（content/background/shared/options/popup/pdf/admin-web）`);
for (const h of fetchHits) {
  const cls = isEngine(h.file) ? '翻译引擎链' : isReport(h.file) ? '上报通道(受控能力契约 RB-1…RB-7)' : isVendor(h.file) ? 'PDF 库(vendor)' : isOldAdmin(h.file) ? '旧世代后台 web(127.0.0.1)' : '⚠其他';
  say(`  fetch( ${h.file}:${h.lines.join(',')}  [${cls}]`);
}
say(`navigator.sendBeacon 命中：${beaconHits.length} 处`);
// 上报专用出网关键字（若存在，直接坐实「出机通道已落地」）
const REPORT_KW = /(report|ingest|telemetry|beacon|analytics|event)s?['"`]?\s*[,)]|\/events\b|\/api\/report/i;
const reportKwHits = [];
for (const f of files) {
  if (isVendor(f) || isOldAdmin(f)) continue;   // 第三方库 / 旧世代后台不在「扩展运行时」口径内
  const src = read(f);
  const ls = src.split('\n');
  const outLines = new Set(fetchCallLines(src, true));   // 直接 fetch( + 别名（防盲区）
  for (let i = 0; i < ls.length; i++) if (outLines.has(i + 1) && REPORT_KW.test(ls[i])) reportKwHits.push(f + ':' + (i + 1));
}
out.files.scanned = files.length;
out.files.fetchHits = fetchHits;
out.files.beaconHits = beaconHits;
out.files.suspiciousFetch = suspicious;
out.files.reportKeywordFetchHits = reportKwHits;
check('content/ 无 fetch（上报若挂 content 会破此界）', !fetchHits.some((h) => /^content[\\/]/.test(h.file)), 'content fetch=' + fetchHits.filter((h) => /^content[\\/]/.test(h.file)).length);

/* ==================================================================
 * ①b 受控能力契约：background/report.js 源码级断言（DL-24「等价强化」）
 * ------------------------------------------------------------------
 * 事由：#6 新建 background/report.js（受授权的 fetch 上报，端点
 *   http://127.0.0.1:7791/api，总闸默认短路）⇒ 原 :126/:127 的
 *   「文件名白名单」必然翻红——这是**变更落地的证据**，非缺陷。
 * 裁定：原 :126/:127 的**原意 = 防「未授权出站」**，非「永久禁任何出站」。
 *   ⇒ **只许等价强化，不许放宽**：白名单从「文件名」升级为「受控能力
 *   契约」——允许的背景出站仍只有两处（providers.js 引擎链 / report.js），
 *   且 report.js 必须**同时满足全部 7 组不变量**（RB-1…RB-7）才算被豁免。
 *   直接删断言、或把 report.js 无条件加白名单 = **放宽，明确否决**。
 * 缺件处理：report.js 未落地时，RB-1…RB-7 一律 **SKIP**（不判红、不抛
 *   异常、不崩溃）；(a)(b) 两条按「白名单外背景 fetch = 0」判定。
 * ================================================================== */
const REPORT_JS = 'background/report.js';
const REPORT_JS_ABS = path.join(ROOT, REPORT_JS);
/* 红线件 content/content.js 的 md5 冻结（R-1 正规处置：受控触碰后同轮重报 md5）。
 * 沿革：v1.7.7 `fe03660943f71bb695323abafa4d5a66` / 2357 行 ⇒（2026-10-13 B2 迭代 S4
 * 受控触碰：A1 满额口径 + A2 确认卡提议式，**仅中文字符串与常量引用**；登记见
 * docs/B2-变更跟踪 §9.11）`aacab8819626249d33a38c98db928c9c` / 2367 行 ⇒（2026-10-16
 * `C-70`（S-13 · Option E）`D1`：**仅 +1 行导出** `CT.content.translateRoots`，**不改任何
 * 既有语句**；红线触碰已由 CTO+PMO 落签）`bad14187b1f925fcd92e27d289e473e2` / 2368 行 ⇒
 * （2026-10-16 `C-71`（S-16a · `attr` 分桶）`T1/T2/T3/T4/T5′/T6/T7/T8/T9`：`JITTER_ATTR_LIMIT`
 * ＋ `kind` 内联 `pendingRoots` 条目 ＋ `noteChange` 分两桶；红线触碰已由 CTO+PMO 落签）
 * `2187dcec14a9d36c6ff91272f2cbd417` / 2439 行 ⇒（2026-10-17 `C-73`（`G-3` 修法 · 签附①②）
 * 修①：在既有 `shadowDomEnabled` 复位块后新增判据行
 * `if (!state.enabled && effectiveEnabled(next)) state.shadowScanned = false;`（＋注释 8 行，
 * **既有语句零删改**）；红线触碰已由 CTO 落签）
 * **fadf6c87410d7fafe83c3528d0fd4d91 / 2448 行** ⇒（2026-11-02 v1.8.0 免费版：
 * 产品改为完整免费，**仅删除**商业层死代码 —— ① 到期分支 showTrialEnded 与
 * lastBlocked 全删；② 学习卡「满额 / 替换并加入」分支全删；③ 其余功能
 * （纠错 / 词典 / 术语 / 场景 / 划词 / 渲染）**零改动**）
 * **94c179d146af33e6a05705670069191b / 2375 行**。
 * 本常量只做「字节冻结」；任何再改动都必须同轮重报（DL-30：边改边登记失效）。 */
const CONTENT_JS_MD5_EXPECT = '94c179d146af33e6a05705670069191b';
const FRAME_ENV_KEYS = ['v', 'kind', 'bid', 'did', 'ext', 'prod', 'win', 'tok', 'events'];
const DAILY_ENV_KEYS = ['v', 'kind', 'bid', 'did', 'anon', 'day', 'ext', 'prod', 'events'];
const reportPresent = fs.existsSync(REPORT_JS_ABS);
const reportResults = [];   // {name, ok, detail, skipped?}
const rCheck = (name, ok, detail) => reportResults.push({ name, ok: !!ok, detail });
const rSkip = (name, detail) => reportResults.push({ name, ok: true, skipped: true, detail });
const setEq = (a, b) => !!a && a.length === b.length && b.every((k) => a.includes(k));

say('── ①b background/report.js 受控能力契约（源码级断言；缺件则 SKIP）──');
if (!reportPresent) {
  rSkip('RB-1 端点与总闸（CT.REPORT.ENDPOINT 存在 + 总闸默认 false）', 'report.js 未落地');
  rSkip('RB-2 report.js 出站 fetch 全部被 {host∈ALLOWED_HOSTS 且总闸开} 守卫', 'report.js 未落地');
  rSkip('RB-3 帧封套键集合严格相等 === [v,kind,bid,did,ext,prod,win,tok,events]（无 anon/day）', 'report.js 未落地');
  rSkip('RB-4 日批封套键集合严格相等 === [v,kind,bid,did,anon,day,ext,prod,events]（无 tok/win）', 'report.js 未落地');
  rSkip('RB-5 帧事件 props 仅 count；online props 恒 {} 且每帧恰 1 条', 'report.js 未落地');
  rSkip('RB-6 域标签 "w:"/"d:" 不复用（各恰 1 处）', 'report.js 未落地');
  rSkip('RB-7 零埋点：report.js/SW 无 content|options 出站 + content.js md5 冻结', 'report.js 未落地');
} else {
  const rjs = read(REPORT_JS);
  const rCode = stripComments(rjs);              // 去注释（保长度）——marker/计数只作用于代码
  const rpairs = bracePairs(rCode);
  const rFuncs = allFunctions(rCode);
  const consts = read('shared/constants.js');
  const HOST_RE = /127\.0\.0\.1|localhost|\[::1\]|ALLOWED_HOSTS/;
  const SWITCH_RE = /(ENABLED|SHIP|LIVE|ACTIVE)/;

  /* RB-1 端点、总闸与 host 白名单
   * v1.8.0：产品完整免费、主理人已批准开启匿名埋点 ⇒ 总闸由「默认 false」
   * 改为**显式 true**；端点已切生产（https://createive.cn/api）。
   * 断言不再是「写死本机地址」，而是四条**配置自洽**约束：
   *   ① ENDPOINT 存在且能解析出 host；② 总闸必须显式 true；
   *   ③ ALLOWED_HOSTS 存在且不含通配符；④ **ENDPOINT 的 host 必须在该白名单里**。
   * ④ 比原来的「127.0.0.1:7791 字样」更强：改了端点却忘记加白名单 ⇒ 立刻红。
   */
  const endpointFound = /CT\.(?:REPORT|TELEMETRY)[\s\S]{0,1600}?ENDPOINT\s*[:=]/.test(consts);
  const epM = consts.match(/ENDPOINT\s*:\s*['"`]([^'"`]+)['"`]/);
  let epHost = '';
  try { epHost = epM ? new URL(epM[1]).hostname : ''; } catch (e) { epHost = ''; }
  const switchM = consts.match(/(ENABLED|SHIP|LIVE|ACTIVE|GATE)\s*[:=]\s*(false|true)/);
  const switchOn = !!switchM && switchM[2] === 'true';
  const allowM = consts.match(/ALLOWED_HOSTS\s*:\s*\[([^\n]*)\]/);
  const allowEntries = allowM
    ? allowM[1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    : [];
  const allowListed = allowEntries.length > 0;
  const allowNoWildcard = !!allowM && !/\*/.test(allowM[1]);
  const epInAllow = !!epHost && allowEntries.indexOf(epHost) >= 0;
  rCheck('RB-1 端点可解析 + 总闸显式 true + host 白名单（无通配且端点 host 在表内）',
    endpointFound && !!epHost && switchOn && allowListed && allowNoWildcard && epInAllow,
    `endpoint=${endpointFound} host=${epHost || '解析失败'} 总闸=${switchM ? switchM[1] + ':' + switchM[2] : '未找到'} 白名单=${JSON.stringify(allowEntries)} 无通配=${allowNoWildcard} 端点在表内=${epInAllow}`);

  /* RB-2 出站必须被守卫 —— 出站 = 直接 fetch( 或 fetch 别名调用；
     guard 谓词 = 体内经调用链同时触达 host(127.0.0.1|localhost) 与总闸(ENABLED) 的函数；
     发送函数须「自身是 guard / 调用 guard / 其全部调用者已受守卫」（含跨函数调用链）；
     另接受内联 if(host && 总闸) 包裹。任一裸出站 → 红。 */
  const sendSites = [];
  { const re = /(^|[^\w$])fetch\s*\(/g; let m; while ((m = re.exec(rCode))) sendSites.push({ idx: m.index + m[0].length - 1, alias: false }); }
  for (const a of fetchAliases(rCode)) {
    const re2 = new RegExp('(^|[^\\w$.])' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(', 'g'); let m2;
    while ((m2 = re2.exec(rCode))) sendSites.push({ idx: m2.index + m2[0].length - 1, alias: true });
  }
  const seenSend = new Set(); const sendSitesU = sendSites.filter((s) => (seenSend.has(s.idx) ? false : (seenSend.add(s.idx), true)));
  /* guard 谓词 = **直接**校验总闸(SWITCH_RE) 且 host 校验直接或经一层 host 辅助函数触达者。
     仅允许一层 host 间接（如 outboundAllowed → hostIsLocal）；不做全链闭包，避免把普通函数误判为 guard。 */
  const hostDirect = new Set(rFuncs.filter((f) => HOST_RE.test(f.body)).map((f) => f.name));
  /* 白名单机制的强校验：host 辅助函数必须**真的读** CT.REPORT.ALLOWED_HOSTS，
   * 而不是只写死字面量（否则改常量却不生效 = 假绿）。 */
  const hostFn = rFuncs.find((f) => /^hostAllowed$/.test(f.name));
  const hostFnUsesAllowList = !!hostFn && /ALLOWED_HOSTS/.test(hostFn.body);
  const hostReach = (f) => HOST_RE.test(f.body) || [...callsOf(f.body)].some((c) => hostDirect.has(c));
  const guardNames = new Set(rFuncs.filter((f) => SWITCH_RE.test(f.body) && hostReach(f)).map((f) => f.name));
  const prot = new Set(guardNames);
  for (const f of rFuncs) for (const c of callsOf(f.body)) if (guardNames.has(c)) prot.add(f.name);   // 直接调用 guard 者
  const callers = new Map();
  for (const f of rFuncs) for (const c of callsOf(f.body)) { if (!callers.has(c)) callers.set(c, new Set()); callers.get(c).add(f.name); }
  for (let changed = true; changed;) {
    changed = false;
    for (const f of rFuncs) {
      if (prot.has(f.name)) continue;
      const cs = callers.get(f.name);
      if (cs && cs.size > 0 && [...cs].every((n) => prot.has(n))) { prot.add(f.name); changed = true; }
    }
  }
  const rRegions = ifRegions(rCode);
  const sendInfo = sendSitesU.map((s) => {
    const f = rFuncs.find((fn) => fn.start < s.idx && s.idx < fn.end);
    const inl = rRegions.filter((r) => r.bodyStart >= 0 && r.bodyStart < s.idx && s.idx < r.bodyEnd).find((r) => HOST_RE.test(r.cond) && SWITCH_RE.test(r.cond));
    const viaPred = !!(f && prot.has(f.name));
    return { line: lineOfIdx(rjs, s.idx), alias: s.alias, func: f ? f.name : null, guarded: viaPred || !!inl, via: viaPred ? ('谓词链@' + f.name) : (inl ? '内联if' : null) };
  });
  const unguardedSends = sendInfo.filter((s) => !s.guarded);
  rCheck('RB-2 report.js 出站 fetch 全部被 {host∈ALLOWED_HOSTS 且总闸开} 守卫', sendSitesU.length > 0 && guardNames.size > 0 && unguardedSends.length === 0 && hostFnUsesAllowList,
    `出站调用点=${sendSitesU.length} guard谓词=${JSON.stringify([...guardNames])} hostAllowed读ALLOWED_HOSTS=${hostFnUsesAllowList} 未守卫=${JSON.stringify(unguardedSends)}`);

  /* RB-3/RB-4 封套键集合严格相等（kind 标记 → 最内层对象字面量 → 顶层键） */
  const frameMark = rCode.match(/kind\s*:\s*['"]frame['"]/);
  const dailyMark = rCode.match(/kind\s*:\s*['"]daily['"]/);
  const frameObj = frameMark ? innermostObject(rCode, frameMark.index, rpairs) : null;
  const dailyObj = dailyMark ? innermostObject(rCode, dailyMark.index, rpairs) : null;
  const frameKeys = frameObj ? objTopKeys(frameObj.body) : null;
  const dailyKeys = dailyObj ? objTopKeys(dailyObj.body) : null;
  rCheck('RB-3 帧封套键集合严格相等 === [v,kind,bid,did,ext,prod,win,tok,events]（无 anon/day）', setEq(frameKeys, FRAME_ENV_KEYS),
    `找到=${!!frameObj} keys=${JSON.stringify(frameKeys)} 期望=${JSON.stringify(FRAME_ENV_KEYS)}`);
  rCheck('RB-4 日批封套键集合严格相等 === [v,kind,bid,did,anon,day,ext,prod,events]（无 tok/win）', setEq(dailyKeys, DAILY_ENV_KEYS),
    `找到=${!!dailyObj} keys=${JSON.stringify(dailyKeys)} 期望=${JSON.stringify(DAILY_ENV_KEYS)}`);

  /* RB-5 帧事件 props 仅 count；online props 恒 {} 且每帧恰 1 条
     —— 定位「帧构造函数」（含 kind:'frame'）与「帧事件项构造函数」（产出 props:{count:...}）；
        ①帧构造内 online 追加恰 1 条且 props 空；②凡 EV.ONLINE 同现的 props 字面量必为空；
        ③帧构造须委托帧事件项构造器；④该构造器内所有 props 字面量 ⊆ {count} 或空。 */
  let rb5ok = false, rb5detail = '';
  const frameFn = rFuncs.find((f) => /kind\s*:\s*['"]frame['"]/.test(f.body));
  const itemFn = rFuncs.find((f) => /props\s*:\s*\{\s*count\s*:/.test(f.body));
  if (frameFn && itemFn) {
    const onlinePushes = (frameFn.body.match(/ONLINE\s*,\s*props\s*:\s*\{\s*\}/g) || []).length;
    const badOnline = (rCode.match(/ONLINE\s*,\s*props\s*:\s*\{[^{}]*\}/g) || []).filter((s) => !/props\s*:\s*\{\s*\}/.test(s)).length;
    const itemPropsKeys = objEntries(itemFn.body).filter((e) => e.key === 'props')
      .map((e) => (e.val.startsWith('{') ? objTopKeys(e.val.slice(1, e.val.lastIndexOf('}'))) : ['<expr>']));
    const itemBad = itemPropsKeys.filter((pk) => pk.length !== 0 && !pk.every((k) => k === 'count')).length;
    const delegates = new RegExp('(^|[^\\w$.])' + itemFn.name + '\\s*\\(').test(frameFn.body);
    rb5ok = onlinePushes === 1 && badOnline === 0 && itemBad === 0 && delegates;
    rb5detail = `帧构造=${frameFn.name} online追加=${onlinePushes} online非空props=${badOnline} 事件项构造=${itemFn.name} 其props键=${JSON.stringify(itemPropsKeys)} 违规=${itemBad} 委托=${delegates}`;
  } else { rb5detail = `未定位帧构造=${!!frameFn} 帧事件项构造=${!!itemFn}`; }
  rCheck('RB-5 帧事件 props 仅 count；online props 恒 {} 且每帧恰 1 条', rb5ok, rb5detail);

  /* RB-6 域标签 "w:"/"d:" 不复用（代码中各恰 1 处，第三处即红）+ 各自用于自身派生 */
  const wCount = countLabel(rCode, 'w:'), dCount = countLabel(rCode, 'd:');
  const tokFn = rFuncs.find((f) => /^deriveTok$/.test(f.name));
  const anonFn = rFuncs.find((f) => /^deriveAnon$/.test(f.name));
  const derivOk = !tokFn || !anonFn || (/\bDOMAIN_TOK\b/.test(tokFn.body) && /\bDOMAIN_ANON\b/.test(anonFn.body) && !/\bDOMAIN_ANON\b/.test(tokFn.body));
  rCheck('RB-6 域标签 "w:"/"d:" 不复用（各恰 1 处）+ 各自派生', wCount === 1 && dCount === 1 && derivOk,
    `"w:"=${wCount} "d:"=${dCount} 派生DOMAIN_TOK/ANON各就其位=${derivOk}`);

  /* RB-7 零埋点：report.js/SW 无指向 content|options 的出站（含 fetch 别名）+ content.js md5 冻结 */
  const contentMd5 = md5(fs.readFileSync(path.join(ROOT, 'content/content.js')));
  const outs = [];
  for (const [file, raw] of [[REPORT_JS, rjs], ['background/service-worker.js', read('background/service-worker.js')]]) {
    const src = stripComments(raw);
    const lps = [];
    { const re = /(^|[^\w$])fetch\s*\(/g; let m; while ((m = re.exec(src))) lps.push(src.indexOf('(', m.index)); }
    for (const a of fetchAliases(src)) { const re2 = new RegExp('(^|[^\\w$.])' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(', 'g'); let m2; while ((m2 = re2.exec(src))) lps.push(src.indexOf('(', m2.index)); }
    for (const lp of lps) {
      const arg = callArg(src, lp);
      if (/content[\\/]|options[\\/]/.test(arg)) outs.push(`${file}:${lineOfIdx(src, lp)} -> ${arg.replace(/\s+/g, ' ').slice(0, 70)}`);
    }
  }
  const md5ok = contentMd5 === CONTENT_JS_MD5_EXPECT;
  rCheck('RB-7 零埋点：report.js/SW 无 content|options 出站 + content.js md5 冻结', outs.length === 0 && md5ok,
    `content.js md5=${contentMd5}(${md5ok ? 'OK' : '已变更!'}) 指向content|options的出站=${JSON.stringify(outs)}`);
}
for (const r of reportResults) { if (r.skipped) checkSkip(r.name, r.detail); else check(r.name, r.ok, r.detail); }
const reportAllOk = reportResults.every((r) => r.ok);
const reportExempt = reportPresent && reportAllOk;
out.report = { path: REPORT_JS, present: reportPresent, allOk: reportAllOk, exempt: reportExempt, assertions: reportResults };

/* ---- (a)(b)(d) 白名单升级后的判定 ---- */
const bgFetch = fetchHits.filter((h) => /^background[\\/]/.test(h.file));
const allowedBg = ['background/providers.js', ...(reportExempt ? [REPORT_JS] : [])];
const bgOutside = bgFetch.filter((h) => !allowedBg.includes(h.file.replace(/\\/g, '/')));
check('(a1) background/ 出站 fetch 仅限 {providers.js, report.js}',
  bgOutside.length === 0,
  `background fetch=${JSON.stringify(bgFetch.map((h) => h.file))} 白名单外=${JSON.stringify(bgOutside.map((h) => h.file))} report豁免=${reportExempt}`);
if (reportPresent) {
  check('(a2) report.js 出站通过受控能力契约（RB-1…RB-7 全不变量）', reportExempt, `(c) 全通过=${reportAllOk}`);
} else {
  checkSkip('(a2) report.js 出站通过受控能力契约（RB-1…RB-8 全不变量）', 'report.js 未落地（(a1) 已按白名单外=0 判定）');
}
const reportKwOutside = reportKwHits.filter((h) => !(reportExempt && h.startsWith(REPORT_JS + ':')));
check('(b) 无白名单外上报/后台 fetch', reportKwOutside.length === 0, reportKwOutside.length ? reportKwOutside.join(',') : 'ok（白名单外=0）');
check('(d) 全仓无 sendBeacon（含 report.js；契约 §1.2 裁决不用它）', beaconHits.length === 0, beaconHits.length + ' 处');
say('');

/* ==================================================================
 * ② content 侧：report() 的唯一上行 + 调用点相位
 * ================================================================== */
const content = read('content/content.js');
const reportFn = extractFn(content, 'function report');
const runFn = extractFn(content, 'async function run');
const waveFn = extractFn(content, 'async function translateWave');
const checkFrameFn = extractFn(content, 'function checkFramesSkipped');

const reportCalls = callLines(content, 'report', reportFn ? reportFn.startLine : null);
// report() 定义行本身不算调用；找同签名行
const reportDefLine = reportFn ? reportFn.startLine : -1;
const reportCallLines = reportCalls.filter((l) => l !== reportDefLine);

say('── ② content 侧上行通道 ──');
say(`report() 定义 @ content.js:${reportFn.startLine}-${reportFn.endLine}（唯一上行 = CT.MSG.REPORT）`);
say(`report() 调用点（共 ${reportCallLines.length} 处）：content.js:${reportCallLines.join(', :')}`);
out.content = {
  reportDef: { start: reportFn.startLine, end: reportFn.endLine },
  reportCallLines,
  run: runFn ? { start: runFn.startLine, end: runFn.endLine } : null,
  translateWave: waveFn ? { start: waveFn.startLine, end: waveFn.endLine } : null,
  checkFramesSkipped: checkFrameFn ? { start: checkFrameFn.startLine, end: checkFrameFn.endLine } : null
};

// 每个 report() 调用点是否落在 run() 函数体内（= 轮次级，not 波/单元级）
const inRun = reportCallLines.filter((l) => runFn && l >= runFn.startLine && l <= runFn.endLine);
out.content.reportCallsInsideRun = inRun;
say(`  其中落在 run() 体内的：${inRun.length} / ${reportCallLines.length}（其余为 boot/frame/生命周期相位）`);

// translateWave 体内不得出现 report / fetch / send( 上行
const waveBody = waveFn ? waveFn.body : '';
const waveHasReport = /(^|[^\w.$])report\s*\(/.test(waveBody);
const waveHasFetch = /(^|[^\w.$])fetch\s*\(/.test(waveBody);
out.content.waveHasReport = waveHasReport;
out.content.waveHasFetch = waveHasFetch;
check('translateWave 体内无 report()', !waveHasReport, waveFn ? `content.js:${waveFn.startLine}-${waveFn.endLine}` : '未找到');
check('translateWave 体内无 fetch()', !waveHasFetch, 'ok');

// 波循环区段（run 内、report('working') 之后到 finally）不得含 report 调用
// 取 report('working') 行 与 run() 结束行之间，排除 finally 收尾的 report
const workingLine = reportCallLines.find((l) => /report\(\s*'working'/.test(content.split('\n')[l - 1] || ''));
const perWaveReports = reportCallLines.filter((l) => workingLine && l > workingLine && runFn && l < runFn.endLine && !/report\(\s*'(done|error)'/.test(content.split('\n')[l - 1] || ''));
out.content.perWaveReportCalls = perWaveReports;
check('波循环体内无 report（仅轮首/轮尾）', perWaveReports.length === 0, perWaveReports.length ? '命中行 ' + perWaveReports : 'ok（' + (workingLine ? 'working@' + workingLine : '?') + ' → 轮尾 done/error）');
say('');

/* ==================================================================
 * ③ content 侧主路径原语：扫描/渲染/量测 —— 均不含上行
 * ================================================================== */
const MAIN_PRIMITIVES_CONTENT = ['R.collectUnits', 'R.renderUnit', 'R.verifyBatch', 'R.getStats', 'R.judgeOne'];
say('── ③ content 主路径原语调用点（扫描/渲染/量测）──');
out.contentMainPrimitives = {};
for (const p of MAIN_PRIMITIVES_CONTENT) {
  const short = p.split('.').pop();
  const lines = callLines(content, short, null).filter((l) => (content.split('\n')[l - 1] || '').includes('R.' + short));
  out.contentMainPrimitives[p] = lines;
  say(`  ${p.padEnd(16)} 调用 ${String(lines.length).padStart(3)} 处`);
}
// 断言：report() 函数体（getStats 之外）不调用主路径原语；且主路径原语体内无 report
// —— 这里做「同名共现」反证：任何一行同时含主路径原语与 report/fetch
const coOccur = [];
const cLines = content.split('\n');
for (let i = 0; i < cLines.length; i++) {
  const s = cLines[i];
  const hasPrim = MAIN_PRIMITIVES_CONTENT.some((p) => s.includes(p));
  const hasUp = /(^|[^\w.$.])report\s*\(|(^|[^\w.$.])fetch\s*\(|sendBeacon/.test(s);
  if (hasPrim && hasUp) coOccur.push(i + 1);
}
out.contentMainPrimitiveCoOccur = coOccur;
check('主路径原语与上行调用零共现行', coOccur.length === 0, coOccur.length ? '行 ' + coOccur : 'ok');
say('');

/* ==================================================================
 * ④ SW 侧：REPORT / GET_TAB_STATS 与 TRANSLATE 分离；termHash / 引擎链隔离
 * ================================================================== */
const sw = read('background/service-worker.js');
const swLines = sw.split('\n');
const handleTranslate = extractFn(sw, 'async function handleTranslate');
const termHashCalls = callLines(sw, 'termHash', null);

// handler 行号
const lineOfText = (re) => swLines.findIndex((l) => re.test(l)) + 1;
const reportHandlerLine = lineOfText(/\[CT\.MSG\.REPORT\]:/);
const tabStatsHandlerLine = lineOfText(/\[CT\.MSG\.GET_TAB_STATS\]:/);
const translateHandlerLine = lineOfText(/\[CT\.MSG\.TRANSLATE\]:/);
const handlersLine = lineOfText(/^const handlers = \{/);

say('── ④ SW 侧 handler 拓扑 ──');
say(`handleTranslate 定义 @ service-worker.js:${handleTranslate.startLine}-${handleTranslate.endLine}`);
say(`handlers 映射表 @ :${handlersLine}；TRANSLATE @ :${translateHandlerLine}；REPORT @ :${reportHandlerLine}；GET_TAB_STATS @ :${tabStatsHandlerLine}`);
out.sw = {
  handleTranslate: { start: handleTranslate.startLine, end: handleTranslate.endLine },
  handlersLine, translateHandlerLine, reportHandlerLine, tabStatsHandlerLine,
  termHashCallLines: termHashCalls
};
// REPORT / GET_TAB_STATS 必须落在 handleTranslate 行区间之外
check('REPORT handler 独立于 handleTranslate', reportHandlerLine > handleTranslate.endLine, `REPORT@:${reportHandlerLine} > handleTranslate 尾 :${handleTranslate.endLine}`);
check('GET_TAB_STATS handler 独立于 handleTranslate', tabStatsHandlerLine > handleTranslate.endLine, `GET_TAB_STATS@:${tabStatsHandlerLine} > :${handleTranslate.endLine}`);
check('TRANSLATE handler 独立于 REPORT 区段', translateHandlerLine < reportHandlerLine, `TRANSLATE@:${translateHandlerLine} < REPORT@:${reportHandlerLine}`);

// termHash 调用点必须落在 handleTranslate 内（= 引擎链），且 handleTranslate 体内无 REPORT/GET_TAB_STATS/fetch
const htBody = handleTranslate.body;
out.sw.handleTranslateHasFetch = /(^|[^\w.$])fetch\s*\(/.test(htBody);
out.sw.handleTranslateHasReportMsg = /CT\.MSG\.REPORT/.test(htBody);
out.sw.handleTranslateHasTabStats = /GET_TAB_STATS/.test(htBody);
check('handleTranslate 体内无 fetch()', !out.sw.handleTranslateHasFetch, 'ok');
check('handleTranslate 体内无 REPORT 消息', !out.sw.handleTranslateHasReportMsg, 'ok');
check('handleTranslate 体内无 GET_TAB_STATS 消息', !out.sw.handleTranslateHasTabStats, 'ok');
check('termHash 调用仅在 handleTranslate/术语链内', termHashCalls.every((l) => l >= handleTranslate.startLine && l <= handleTranslate.endLine), 'termHash@:' + termHashCalls.join(',:'));

/* ④b 契约拟定的全部 hook 点必须在 handleTranslate 之外（非阻塞上行前提） */
const HOOKS = {
  'REPORT': /\[CT\.MSG\.REPORT\]:/,
  'SAVE_CORRECTION': /\[CT\.MSG\.SAVE_CORRECTION\]:/,
  'LEARN_PATTERN': /\[CT\.MSG\.LEARN_PATTERN\]:/,
  'DISMISS_PATTERN': /\[CT\.MSG\.DISMISS_PATTERN\]:/
};
out.hookPoints = {};
say('  契约拟挂 hook 点 vs handleTranslate 区间（:%d-%d）：'.replace('%d', handleTranslate.startLine).replace('%d', handleTranslate.endLine));
for (const [name, re] of Object.entries(HOOKS)) {
  const ln = lineOfText(re);
  out.hookPoints[name] = ln;
  const outside = ln < handleTranslate.startLine || ln > handleTranslate.endLine;
  say(`    ${name.padEnd(18)} @ :${String(ln).padStart(4)}  ${outside ? '✓ 在 handleTranslate 之外' : '✗ 落在翻译链内'}`);
}
const allHooksOutside = Object.values(out.hookPoints).every((l) => l < handleTranslate.startLine || l > handleTranslate.endLine);
check('全部契约 hook 点均在 handleTranslate 之外（可在轮次外非阻塞入队）', allHooksOutside, JSON.stringify(out.hookPoints));
say('');

/* ==================================================================
 * ⑤ 拟议上报的最优挂点（结论：与 R6 同级，轮次级）
 * ================================================================== */
say('── ⑤ 拟议上报通道的挂点建议（性能组）──');
say(`  最优挂点：SW 侧 REPORT handler 尾部（service-worker.js:${reportHandlerLine}-${tabStatsHandlerLine - 1}）或轮次收尾同级新 handler；`);
say('  该位置在 handleTranslate 之外、不在 termHash 上、不随波/单元调用 → 新增主路径调用 = 0。');
say('  禁止挂点：translateWave / R.renderUnit / R.verifyBatch / handleTranslate 循环体内。');
out.recommendedAttach = {
  primary: `SW REPORT handler tail @ service-worker.js:${reportHandlerLine}`,
  forbidden: ['content translateWave', 'content R.renderUnit', 'content R.verifyBatch', 'SW handleTranslate loop'],
  rationale: '与 R6（checkFramesSkipped 每轮 +1 只读消息）同级：轮次 O(1)，非波/单元'
};
say('');

/* ---------------- 契约文件存在性 + 关键参数实读（跨组依赖） ----------------
 * ⚠ DL-20 / DL-18(f)：本节的 md5 与版本**仅供打印对版**（便于人工比对 §7 冻结登记表），
 *   **不作为任何断言的基准**；冻结 md5 唯一权威 = `B2-变更跟踪-2026-10-12.md` §7。
 */
const contractPath = 'docs/B2-前后台联调接口契约-2026-10-13.md';
const contractAbs = path.join(ROOT, contractPath);
const contractExists = fs.existsSync(contractAbs);
out.contract = { path: contractPath, exists: contractExists };
if (contractExists) {
  const cb = fs.readFileSync(contractAbs);
  out.contract.md5 = md5(cb);
  out.contract.lines = cb.toString('utf8').replace(/\n$/, '').split('\n').length;
}
say('── ⑥ 契约依赖（版本 + 哈希【仅打印对版，不作断言基准；冻结值见变更跟踪 §7】）──');
if (contractExists) {
  const cs = read(contractPath);
  out.contract.params = {
    version: (cs.match(/版本\*\*：\*\*(v[\d.]+)/) || [, null])[1] || (cs.match(/版本\*\*：(v[\d.]+)/) || [, null])[1] || 'unknown',
    dualChannel: cs.includes('双通道') && cs.includes('kind'),
    envelopes: cs.includes('kind": "frame"') && cs.includes('kind": "daily"') ? 'frame + daily（契约 §1.4 双通道定稿）' : null,
    envelopeVersionV: cs.includes('"v": 2') ? 2 : null,
    endpoint: cs.includes('/telemetry/actions') ? '/telemetry/actions' : null,
    batchMaxEvents: cs.includes('≤50 事件') || cs.includes('上限 50') ? 50 : null,
    batchKb: cs.includes('64KB') ? 64 : null,
    queueItems: cs.includes('200 条') ? 200 : null,
    queueKb: cs.includes('256 KB') ? 256 : null,
    retryText: cs.includes('基 **30s**') && cs.includes('最多 8 次') ? '基30s×2±25% cap30min max8' : null,
    frameMs: cs.includes('FRAME_MS') ? 'present（CT.REPORT.FRAME_MS 15min）' : 'absent'
  };
  say(`  ${contractPath} 存在：是 | 磁盘 md5=${out.contract.md5}（对版用） | ${out.contract.lines} 行`);
  say(`  版本=${out.contract.params.version} | 双通道=${out.contract.params.dualChannel} | 封套=${out.contract.params.envelopes}`);
  say('  注：冻结 md5 一律取自 B2-变更跟踪-2026-10-12.md §7 冻结登记表（DL-20/DL-18(f)：实读只可证伪、不可立值）。');
} else {
  say(`  ${contractPath} 存在：否（arch-contract 任务 #2 产出中）`);
}
say('');

/* ---------------- #4 数据结构文档（事件类型 / props 唯一权威） ---------------- */
const dsPath = 'docs/B2-动作记录数据结构-2026-10-13.md';
const dsAbs = path.join(ROOT, dsPath);
const dsExists = fs.existsSync(dsAbs);
let ds = '';
out.dataSchema = { path: dsPath, exists: dsExists };
if (dsExists) {
  const db = fs.readFileSync(dsAbs);
  out.dataSchema.md5 = md5(db);
  out.dataSchema.lines = db.toString('utf8').replace(/\n$/, '').split('\n').length;
  ds = db.toString('utf8');
  say(`  ${dsPath} 存在：是 | 磁盘 md5=${out.dataSchema.md5}（对版用） | ${out.dataSchema.lines} 行（事件类型/props 唯一权威，#4；冻结值见变更跟踪 §7）`);
} else {
  say(`  ${dsPath} 存在：否（#4 产出中）`);
}
say('');

/* ==================================================================
 * ⑦ UP-9 + UP-10 双通道封套隐私静态断言（契约 §1.4 + #4 §3.13）——团队指令新增
 * ------------------------------------------------------------------
 * 机械闸门：
 *   UP-9  ：帧封套不得出现 anon/day/事件级 at，帧事件 props 仅 count（online 例外 {}）；
 *           日批封套不得出现 tok/win，且不得出现 online。
 *   UP-10 ：帧 events[].props 全项 ⊆ {count}（online 恒 {}）；帧 win 为数值 int（DL-17②）；日批 props 不含 count（DL-17①）。
 * 源：契约 §1.4 的 JSON 代码块（spec-of-record）+ #4 §3.13 的 count-only / online 规则。
 * 本断言钉住契约与 #4（**语义与判定集不变**）；#6 落地后的 report.js 源码级断言
 * 已由 ①b「受控能力契约（RB-1…RB-8）」承接（DL-24），本节不做改动。
 * ================================================================== */
const UP9 = {
  frameAllowed: ['v', 'kind', 'bid', 'ext', 'prod', 'win', 'tok', 'events'],
  frameForbidden: ['anon', 'day'],
  eventAllowed: ['ev', 'props'],
  eventForbidden: ['at'],
  dailyAllowed: ['v', 'kind', 'bid', 'anon', 'day', 'ext', 'prod', 'events'],
  dailyForbidden: ['tok', 'win']
};
const topKeys = (o) => Object.keys(o || {});
const firstEventKeys = (o) => { const e = (o && Array.isArray(o.events) && o.events[0]) || {}; return Object.keys(e); };
const firstEventPropsKeys = (o) => { const e = (o && Array.isArray(o.events) && o.events[0]) || {}; return Object.keys((e && e.props) || {}); };
const subsetOf = (ks, allow) => ks.every((k) => allow.includes(k));
let frameEnv = null, dailyEnv = null;
if (contractExists) {
  const cs = read(contractPath);
  const blocks = [...cs.matchAll(/```json\s*([\s\S]*?)```/g)].map((m) => m[1].trim());
  const parsed = [];
  for (const b of blocks) { try { parsed.push(JSON.parse(b)); } catch (e) { /* 非纯 JSON 的示例跳过 */ } }
  frameEnv = parsed.find((o) => o && o.kind === 'frame') || null;
  dailyEnv = parsed.find((o) => o && o.kind === 'daily') || null;
}
say('── ⑦ UP-9 + UP-10 双通道封套隐私静态断言（契约 §1.4 + #4 §3.13）──');
out.up9 = { frameEnvFound: !!frameEnv, dailyEnvFound: !!dailyEnv };
if (frameEnv && dailyEnv) {
  const fk = topKeys(frameEnv), dk = topKeys(dailyEnv);
  const fe = firstEventKeys(frameEnv), de = firstEventKeys(dailyEnv);
  Object.assign(out.up9, {
    frameKeys: fk, dailyKeys: dk, frameEventKeys: fe, dailyEventKeys: de,
    frameHasAnon: fk.includes('anon'), frameHasDay: fk.includes('day'), frameEventHasAt: fe.includes('at'),
    dailyHasTok: dk.includes('tok'), dailyHasWin: dk.includes('win')
  });
  say(`  帧封套键: ${JSON.stringify(fk)}；事件项键: ${JSON.stringify(fe)}`);
  say(`  日批封套键: ${JSON.stringify(dk)}；事件项键: ${JSON.stringify(de)}`);
  check('UP-9a 帧封套禁 anon/day', !fk.includes('anon') && !fk.includes('day'), 'frameKeys=' + JSON.stringify(fk));
  check('UP-9b 帧封套禁事件级 at', !fe.includes('at'), 'frameEventKeys=' + JSON.stringify(fe));
  check('UP-9c 帧封套键 ⊆ 白名单{v,kind,bid,ext,prod,win,tok,events}', subsetOf(fk, UP9.frameAllowed), JSON.stringify(fk));
  check('UP-9d 帧封套必含 win+tok', fk.includes('win') && fk.includes('tok'), JSON.stringify(fk));
  check('UP-9e 日批封套禁 tok/win', !dk.includes('tok') && !dk.includes('win'), 'dailyKeys=' + JSON.stringify(dk));
  check('UP-9f 日批封套键 ⊆ 白名单{v,kind,bid,anon,day,ext,prod,events}', subsetOf(dk, UP9.dailyAllowed), JSON.stringify(dk));
  check('UP-9g 日批封套必含 anon+day', dk.includes('anon') && dk.includes('day'), JSON.stringify(dk));
  check('UP-9h 事件项键 ⊆ {ev,props}（两通道）', subsetOf(fe, UP9.eventAllowed) && subsetOf(de, UP9.eventAllowed), 'frame Ev=' + JSON.stringify(fe) + ' daily Ev=' + JSON.stringify(de));

  // —— 通道 A 帧 props 的 count-only 约束 + online 例外（#4 §3.13 复裁 / DL-17①）——
  const framePropsKeys = firstEventPropsKeys(frameEnv);
  const frameHasOnline = (frameEnv.events || []).some((e) => e && e.ev === 'online');
  const countOnlyRule = /帧\s*`props`\s*只允许一个键\s*`count`/.test(ds);
  const onlineRule = /`props`\s*恒为\s*`\{\}`/.test(ds);
  const dailyNoOnline = /通道\s*B\s*禁出现\s*`online`/.test(ds);
  const frameNoOnlineInDaily = !(dailyEnv.events || []).some((e) => e && e.ev === 'online');
  Object.assign(out.up9, { framePropsKeys, frameHasOnline, countOnlyRule, onlineRule, dailyNoOnline });
  check('UP-9i 帧事件 props 键 ⊆ {count}（契约 §1.4 帧样例）', subsetOf(framePropsKeys, ['count']), 'frameProps=' + JSON.stringify(framePropsKeys));
  check('UP-9j #4 §3.13 帧 props 只允许 count（唯一权威）', countOnlyRule, '源=#4 文档文本（v2.2；md5 见变更跟踪 §7）');
  check('UP-9k #4 §3.13 online 例外 props 恒 {}', onlineRule, 'ok=' + onlineRule);
  check('UP-9l #4 通道 B 禁出现 online', dailyNoOnline && frameNoOnlineInDaily, '#4规则=' + dailyNoOnline + ' 日批样例无online=' + frameNoOnlineInDaily);

  // —— UP-10：锁 DL-17①/②（帧 events 全项 count-only / win 为数值 int / 日批细分不得带 count）——
  const frameWin = frameEnv.win;
  const frameWinIsInt = typeof frameWin === 'number' && Number.isInteger(frameWin);
  const frameEvents = frameEnv.events || [];
  const frameBadItems = frameEvents.filter((e) => {
    if (!e) return true;
    const pk = Object.keys(e.props || {});
    if (e.ev === 'online') return pk.length !== 0;   // online 必须恒 {}
    return !pk.every((k) => k === 'count');          // 其余事件项仅允许 count
  });
  const dailyPropsKeysAll = (dailyEnv.events || []).map((e) => (e ? Object.keys(e.props || {}) : []));
  const dailyHasCountKey = dailyPropsKeysAll.some((ks) => ks.includes('count'));
  Object.assign(out.up9, { frameWin, frameWinIsInt, frameBadItems: frameBadItems.length, dailyPropsKeysAll, dailyHasCountKey });
  check('UP-10a 帧 events[].props 键 ⊆ {count}（online 恒 {}）', frameBadItems.length === 0, '违规项=' + frameBadItems.length + ' | ev=' + JSON.stringify(frameEvents.map((e) => e && e.ev)));
  check('UP-10b 帧 win 为数值 int（非字符串，锁 DL-17②）', frameWinIsInt, 'win=' + JSON.stringify(frameWin) + ' | typeof=' + typeof frameWin);
  check('UP-10c 日批 events[].props 不含 count（细分为日批专属维字段）', !dailyHasCountKey, 'daily props 键=' + JSON.stringify(dailyPropsKeysAll));
} else {
  check('UP-9 契约 §1.4 双封套可解析', false, `frame=${!!frameEnv} daily=${!!dailyEnv}`);
}
say('');

/* ---------------- 判定 ---------------- */
const allPass = out.checks.every((c) => c.ok);
out.conclusion = allPass ? 'PASS' : 'FAIL';
say(`结论：${out.conclusion}（${out.checks.filter(c => !c.skipped && c.ok).length}/${out.checks.filter(c => !c.skipped).length}${out.checks.some(c => c.skipped) ? '，' + out.checks.filter(c => c.skipped).length + ' SKIP 不计入' : ''}）`);

fs.mkdirSync(RESULT_DIR, { recursive: true });
const ts = new Date().toISOString().replace(/[:]/g, '-').replace(/\..+/, '');
const file = path.join(RESULT_DIR, `audit-upload-path-${ts}.json`);
const payload = { ...out, log };
fs.writeFileSync(file, JSON.stringify(payload, null, 2));
fs.writeFileSync(path.join(RESULT_DIR, 'audit-upload-path-latest.json'), JSON.stringify(payload, null, 2));
console.log('结果：' + file);
process.exit(allPass ? 0 : 1);
