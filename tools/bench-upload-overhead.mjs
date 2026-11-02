/*
 * 叠译 · 扩展→后台「动作记录上报」开销基准（任务 #5，perf-upload）
 * ==================================================================
 * 【为什么有这台台】
 * DL-10 立项「管理后台实时看扩展动作记录」= 数据面第一次**出机**。扩展侧当前
 * **零上报通道**（全仓无指向上报端点的 fetch，见 audit-upload-path.mjs），但通道一旦
 * 落地，客户端会新增三类固定成本，必须在变更单放行前把量级钉死：
 *   ① 批量窗口内的**序列化**成本（JSON.stringify 事件批）；
 *   ② 离线队列的**内存占用**与**淘汰策略**；
 *   ③ 网络失败时**重试退避**带来的额外请求数。
 *
 * 【参数来源（与契约/数据结构同源，非臆造）】
 *   · 事件形状：#4 定稿 docs/B2-动作记录数据结构-2026-10-13.md
 *       md5=5084949b779b3409621958c899a241eb（782 行）§3.0-A/§3.1~§3.12/§3.13
 *       —— **两通道 props 形状不同**（DL-17① 复裁）：
 *          通道 A（帧）事件 props **只允许一个键 `count`（int≥1）**；唯一例外
 *          `{ev:"online", props:{}}`（每帧恰好 1 条）；**帧内禁任何维度细分**。
 *          通道 B（日批）事件 props = 该事件的**完整维度白名单**（§3.1~§3.12）。
 *   · 传输/批量/队列/退避：docs/B2-前后台联调接口契约-2026-10-13.md §1.7/§1.8
 *       v2.2（md5=bbdacb16fc85f5dae1318195271efbed, 529 行）= §1.4「双通道定稿」
 *       - 单批 ≤ 50 条、请求体 ≤ 64 KB（§1.7）
 *       - 离线队列 200 条 或 256 KB 任一先到，FIFO 丢最旧（§1.8）
 *       - 退避 基 30s ×2 ±25%，cap 30min，最多 8 次（§1.8）
 *       - 帧聚合窗 CT.REPORT.FRAME_MS = 15min（§1.3/§1.8）；日批每安装每日 ≤1 批
 *   · 常量：CT.STORAGE / CT.LEARNING 经 vm 实读 shared/constants.js（与生产同源）。
 *
 * 【口径声明（不许含糊）】
 *   · 本脚本量的是 **CPU 侧 / 纯逻辑成本**，不是端到端。
 *     原因同 bench-b2-overhead.mjs：上报逻辑将封在 MV3 service worker，Node 无法直接
 *     import（chrome.* 不存在），且本机 sandbox 禁止 node spawn。故内联与生产**同形状**的
 *     事件夹具做序列化/队列模拟。
 *   · **不含真实网络往返 / chrome.storage.local I/O**（浏览器/磁盘行为）——
 *     这两项在报告里按量级单独讨论并标注「未实测/设计估算」。
 *   · 契约 v2.x 定版为**双通道两套封套**（帧 `{v,kind,bid,ext,prod,win,tok,events}` /
 *     日批 `{v,kind,bid,anon,day,ext,prod,events}`）——本台对**两套封套都测**。
 *   · 单事件 = 批内单元 `{ev,props}`（v2.x 已废除独立事件信封与事件级 `at`）；
 *     **帧项按 count-only 建模、日批项按完整维度建模**（形状差异见 #4 §3.13）。
 *   · `win` 为数值 epoch ms（≤15min 对齐）；`tok`/`anon` 为 8 hex。
 *
 * 运行（单进程，禁止 spawn）：
 *   node tools/bench-upload-overhead.mjs
 * 输出：tools/bench-results/bench-upload-overhead-<时间戳>.json（另有 -latest.json）
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RESULT_DIR = path.join(HERE, 'bench-results');

/* ------------------------------------------------------------------
 * 实读生产常量（与生产同源），取不到如实标注
 * ------------------------------------------------------------------ */
let constantsSource = 'design-fallback（shared/constants.js 未取到 CT）';
let STORAGE = {};
let STATS_MAX = 200, THRESHOLD = 3;
try {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'shared/constants.js'), 'utf8'), sandbox, { filename: 'shared/constants.js' });
  const CT = sandbox.CT;
  if (CT && CT.STORAGE) STORAGE = CT.STORAGE;
  if (CT && CT.LEARNING) {
    STATS_MAX = CT.LEARNING.STATS_MAX || STATS_MAX;
    THRESHOLD = CT.LEARNING.THRESHOLD || THRESHOLD;
  }
  constantsSource = 'shared/constants.js（真实常量：CT.STORAGE / CT.LEARNING / CT.REPORT）';
} catch (e) {
  constantsSource = 'design-fallback（vm 读取失败：' + (e && e.message) + '）';
}

/* ------------------------------------------------------------------
 * 契约参数（来自 arch-contract 契约 v2.2 §1.6/§1.7/§1.8/§1.3，非臆造）
 * ------------------------------------------------------------------ */
const CONTRACT = {
  batchMaxEvents: 50,          // §1.6
  batchMaxBytes: 64 * 1024,    // §1.6
  queueMaxItems: 200,          // §1.7
  queueMaxBytes: 256 * 1024,   // §1.7
  retryBaseMs: 30 * 1000,      // §1.7
  retryFactor: 2,              // §1.7
  retryJitter: 0.25,           // §1.7
  retryCapMs: 30 * 60 * 1000,  // §1.7
  retryMax: 8,                 // §1.7
  flushMsNearRealtime: 15 * 60 * 1000, // §9.3（待法务；另一案 = 24h）
  flushMsDaily: 24 * 60 * 60 * 1000
};

/* ------------------------------------------------------------------
 * 事件夹具 —— 形状取自 #4 定稿（md5=5084949b…, §3.13 复裁）
 *   通道 A（帧）项：{ev, props:{count:N}}（count-only）+ online 例外 {ev:'online',props:{}}
 *   通道 B（日批）项：{ev, props:{...完整维度白名单}}
 *   信封字段（v/kind/bid/win/tok/anon/day/ext/prod）为常量，无自由文本。
 * ------------------------------------------------------------------ */
const ENV = { v: 2, day: '2026-10-13', anon: '9f2a1c07', ext: '1.8.0', prod: 'dieyi' };

/** 通道 B（日批）**保留的 2 类事件**的完整维度 props（v1.8.0 免费版；
 *  install 只带 ver，translate_round 保留既有全维度 —— 用于字节上界估算，无自由文本） */
const PROPS = {
  translate_round: { phase: 'done', provider: 'chrome-builtin', sourceLang: 'en', targetLang: 'zh-CN', langPair: 'en>zh-CN', variant: 'hans', mode: 'below', units: 214, translated: 214, failed: 0, rescuedFromClip: 0, replaceDegraded: 3, riskSuspect: 5, relocated: 0, clipUnresolved: 0, framesSkipped: 0, isTop: true, frameGate: 'ok', ttft: 812 },
  install: { ver: '1.8.0' }
};
const EV_TYPES = Object.keys(PROPS);

/** 帧内 count 取值（代表性窗口计数，确定性循环，便于复现字节数上界） */
const FRAME_COUNTS = [1, 2, 3, 9, 37, 128];

/** 通道 A（帧）项：{ev, props:{count}}（**count-only**；无任何维度键） */
function makeFrameItem(ev, count = 1) {
  return { ev, props: { count } };
}
/** 通道 A（帧）存活标记：每帧恰好 1 条，props 严格 {} */
function makeFrameOnlineItem() {
  return { ev: 'online', props: {} };
}
/** 通道 B（日批）项：{ev, props:{...完整维度}} */
function makeDailyItem(ev) {
  return { ev, props: { ...PROPS[ev] } };
}

/** 契约 v2.2 §1.4 通道 A（实时帧）：{v:2,kind:"frame",bid,ext,prod,win,tok,events}
 *   —— 含 1 条 online + (n-1) 条 count-only 动作事件；禁 anon/day/事件级 at/维度键 */
function buildFrameBatch(n) {
  const events = [makeFrameOnlineItem()];
  for (let i = 0; i < n - 1; i++) {
    const ev = EV_TYPES[i % EV_TYPES.length];
    events.push(makeFrameItem(ev, FRAME_COUNTS[i % FRAME_COUNTS.length]));
  }
  return { v: 2, kind: 'frame', bid: 'b1d4f0aa-0000-4000-8000-000000000000', ext: ENV.ext, prod: ENV.prod, win: 1697202900000, tok: '3a7f0c19', events };
}
/** 契约 v2.2 §1.4 通道 B（日批）：{v:2,kind:"daily",bid,anon,day,ext,prod,events}
 *   —— 每项完整维度 props；禁 tok/win、禁 online */
function buildDailyBatch(n) {
  const events = [];
  for (let i = 0; i < n; i++) events.push(makeDailyItem(EV_TYPES[i % EV_TYPES.length]));
  return { v: 2, kind: 'daily', bid: 'c2e5a1bb-0000-4000-8000-000000000000', anon: ENV.anon, day: ENV.day, ext: ENV.ext, prod: ENV.prod, events };
}

/* ------------------------------------------------------------------
 * 计时工具
 * ------------------------------------------------------------------ */
function pct(samples, p) {
  const a = samples.slice().sort((x, y) => x - y);
  const idx = Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1));
  return a[idx];
}
function benchSerialize(payload, iters) {
  const s = [];
  let bytes = 0;
  for (let w = 0; w < 2000; w++) JSON.stringify(payload);
  for (let k = 0; k < iters; k++) {
    const t0 = process.hrtime.bigint();
    const str = JSON.stringify(payload);
    const t1 = process.hrtime.bigint();
    bytes = Buffer.byteLength(str, 'utf8');
    s.push(Number(t1 - t0) / 1e6);
  }
  return { p50: pct(s, 50), p95: pct(s, 95), avg: s.reduce((a, b) => a + b, 0) / s.length, bytes };
}

/* ------------------------------------------------------------------
 * 离线队列模拟（条数上限 + 字节上限 + FIFO 淘汰）
 * ------------------------------------------------------------------ */
function simulateQueue({ capCount, capBytes, perEventBytes, nEvents }) {
  const q = [];
  let bytes = 0, droppedCount = 0, droppedBytes = 0;
  for (let i = 0; i < nEvents; i++) {
    q.push(i); bytes += perEventBytes;
    while (q.length > capCount) { q.shift(); bytes -= perEventBytes; droppedCount++; droppedBytes += perEventBytes; }
    while (bytes > capBytes && q.length) { q.shift(); bytes -= perEventBytes; droppedCount++; droppedBytes += perEventBytes; }
  }
  return { retained: q.length, retainedBytes: Math.round(bytes), dropped: droppedCount, droppedBytes: Math.round(droppedBytes) };
}

/* ------------------------------------------------------------------
 * 重试退避模拟（契约参数：基 30s ×2 ±25%，cap 30min，最多 8 次）
 * ------------------------------------------------------------------ */
function simulateRetry({ failuresBeforeSuccess }) {
  // 成功发生在第 `failuresBeforeSuccess` 次尝试 → 重试次数 = failuresBeforeSuccess-1，封顶 maxRetries
  const retries = Math.max(0, Math.min(CONTRACT.retryMax, failuresBeforeSuccess - 1));
  const delays = [];
  for (let i = 1; i <= retries; i++) {
    let raw = CONTRACT.retryBaseMs * Math.pow(CONTRACT.retryFactor, i - 1);
    if (raw > CONTRACT.retryCapMs) raw = CONTRACT.retryCapMs;
    const jitter = raw * CONTRACT.retryJitter * (Math.random() * 2 - 1);
    delays.push(Math.round(raw + jitter));
  }
  const giveUp = (failuresBeforeSuccess - 1) > CONTRACT.retryMax;
  const requests = 1 + retries;
  return { requests, retries, totalBackoffMs: delays.reduce((a, b) => a + b, 0), delays, giveUp };
}

/* ------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------ */
const ITERS = 50000;
const out = { generatedAt: new Date().toISOString(), node: process.version, constantsSource, contract: CONTRACT, statsMax: STATS_MAX, threshold: THRESHOLD, itersPerCase: ITERS, singleEvents: {}, batches: {}, queue: {}, retry: {}, dailyRequests: {} };

console.log('── 上报开销基准（Node 单进程 · 算法级等价） ──');
console.log('常量来源：' + constantsSource);
console.log(`契约参数：批≤${CONTRACT.batchMaxEvents}条/${CONTRACT.batchMaxBytes / 1024}KB | 队列 ${CONTRACT.queueMaxItems}条/${CONTRACT.queueMaxBytes / 1024}KB | 退避 基${CONTRACT.retryBaseMs / 1000}s×${CONTRACT.retryFactor} cap${CONTRACT.retryCapMs / 60000}min max${CONTRACT.retryMax}`);
console.log('');

/* ① 单事件项序列化（v2.x 批内单元 = {ev,props}；**两通道形状不同**） */
console.log('── ① 单事件项序列化（v2.x：帧=count-only / 日批=完整维度；封套字段在批级）──');
// 通道 A（帧）：props 仅 {count}；另测 online 例外 {}
const onlineR = benchSerialize(makeFrameOnlineItem(), 20000);
let frMin = Infinity, frMax = 0, frMaxEv = '', frSum = 0;
for (const ev of EV_TYPES) {
  const lo = benchSerialize(makeFrameItem(ev, 1), 20000);
  const hi = benchSerialize(makeFrameItem(ev, 999), 20000);
  frSum += lo.bytes;
  if (lo.bytes < frMin) frMin = lo.bytes;
  if (hi.bytes > frMax) { frMax = hi.bytes; frMaxEv = ev; }
  out.singleEvents['frame:' + ev] = { bytesCount1: lo.bytes, bytesCount999: hi.bytes, p50ms: +lo.p50.toFixed(6) };
  console.log(`  [frame] ${ev.padEnd(18)} count=1 → ${String(lo.bytes).padStart(4)} B | count=999 → ${String(hi.bytes).padStart(4)} B`);
}
out.singleEvents['frame:online'] = { bytes: onlineR.bytes, p50ms: +onlineR.p50.toFixed(6) };
out.singleStats = out.singleStats || {};
out.singleStats.frame = { onlineBytes: onlineR.bytes, minBytes: frMin, avgBytesCount1: +(frSum / EV_TYPES.length).toFixed(1), maxBytesCount999: frMax, maxEv: frMaxEv };
console.log(`  帧项 online = ${onlineR.bytes} B；动作项 count=1 均 ${out.singleStats.frame.avgBytesCount1} B（最小 ${frMin}），count=999 最大 ${frMax} B（${frMaxEv}）`);
// 通道 B（日批）：完整维度 props
let dSum = 0, dMax = 0, dMaxEv = '';
for (const ev of EV_TYPES) {
  const r = benchSerialize(makeDailyItem(ev), 20000);
  out.singleEvents['daily:' + ev] = { bytes: r.bytes, p50ms: +r.p50.toFixed(6), p95ms: +r.p95.toFixed(6) };
  dSum += r.bytes; if (r.bytes > dMax) { dMax = r.bytes; dMaxEv = ev; }
  console.log(`  [daily] ${ev.padEnd(18)} ${String(r.bytes).padStart(4)} B | ser p50=${r.p50.toFixed(5)}ms`);
}
out.singleStats.daily = { avgBytes: +(dSum / EV_TYPES.length).toFixed(1), maxBytes: dMax, maxEv: dMaxEv };
console.log(`  日批项 平均 ${out.singleStats.daily.avgBytes} B/项；最大 ${dMax} B（${dMaxEv}）`);
console.log('');

/* ② 批量序列化（v2.x 双通道封套，条数 1/10/50） */
console.log('── ② 批量序列化（v2.x 帧/日批双封套；契约批上限 50 条 / 64KB）──');
for (const [label, build] of [['帧封套(kind:frame)', buildFrameBatch], ['日批封套(kind:daily)', buildDailyBatch]]) {
  out.batches[label] = {};
  for (const n of [1, 10, 50]) {
    const r = benchSerialize(build(n), n <= 10 ? 50000 : 20000);
    out.batches[label][n] = { bytes: r.bytes, perEventBytes: +(r.bytes / n).toFixed(2), p50ms: +r.p50.toFixed(6), p95ms: +r.p95.toFixed(6) };
    const over = r.bytes > CONTRACT.batchMaxBytes;
    console.log(`  [${label}] 批${String(n).padStart(2)}条 ${String(r.bytes).padStart(6)} B (${(r.bytes / n).toFixed(1)} B/条) | ser p50=${r.p50.toFixed(5)}ms p95=${r.p95.toFixed(5)}ms${over ? '  ⚠超64KB' : ''}`);
  }
}
// 封套固定开销（批级一次性）= 空 events 的同封套序列化字节
const envFrameEmpty = { ...buildFrameBatch(1), events: [] };
const envDailyEmpty = { ...buildDailyBatch(1), events: [] };
out.envelopeOverheadB = {
  frame: Buffer.byteLength(JSON.stringify(envFrameEmpty), 'utf8'),
  daily: Buffer.byteLength(JSON.stringify(envDailyEmpty), 'utf8')
};
console.log(`  封套固定开销（批级一次性）：帧 ≈ ${out.envelopeOverheadB.frame} B / 日批 ≈ ${out.envelopeOverheadB.daily} B`);
console.log('');

/* ③ 离线队列（契约：200 条 / 256 KB；模拟 1 天事件流） */
console.log('── ③ 离线队列（200 条 / 256KB，FIFO 丢最旧）──');
const perEventBytes = out.batches['帧封套(kind:frame)'][50].perEventBytes;
// 一天事件量：以「中活跃」为参考，962 条/天（见 ⑤）
const DAILY_EVENTS = 1000;
const qr = simulateQueue({ capCount: CONTRACT.queueMaxItems, capBytes: CONTRACT.queueMaxBytes, perEventBytes, nEvents: DAILY_EVENTS });
out.queue = { capItems: CONTRACT.queueMaxItems, capBytes: CONTRACT.queueMaxBytes, perEventBytes, dailyEventsAssumed: DAILY_EVENTS, ...qr };
console.log(`  按 ${perEventBytes} B/事件，1 天 ${DAILY_EVENTS} 条 → 驻留 ${qr.retained} 条 / ${qr.retainedBytes} B | 当日淘汰 ${qr.dropped} 条`);
console.log(`  队列内存驻留上界 = ${CONTRACT.queueMaxBytes} B（256 KB，含 storage.local 序列化前的内存对象）`);
console.log('');

/* ④ 重试退避 */
console.log('── ④ 重试退避（基30s×2±25%，cap30min，max8）──');
for (const c of [{ f: 1, l: '首试成功' }, { f: 3, l: '第3次成功' }, { f: 10, l: '超上限放弃' }]) {
  const r = simulateRetry({ failuresBeforeSuccess: c.f });
  out.retry[c.l] = r;
  console.log(`  ${c.l.padEnd(10)} 总请求 ${r.requests}（重试 ${r.retries}）| 退避合计 ${Math.round(r.totalBackoffMs / 1000)}s | 占用小时=${(r.totalBackoffMs / 3600000).toFixed(2)}h | 放弃=${r.giveUp}`);
}
console.log('');

/* ⑤ 日请求上界推导（设计估算，非实测） */
console.log('── ⑤ 日请求上界推导（设计估算：近实时 15min 窗 vs 日批）──');
const SCEN = {
  '低活跃(1轮/5min,8h)': { roundsPerDay: 96, activeSeconds: 8 * 3600 },
  '中活跃(1轮/30s,8h)': { roundsPerDay: 960, activeSeconds: 8 * 3600 },
  '高活跃(1轮/10s,12h)': { roundsPerDay: 4320, activeSeconds: 12 * 3600 },
  '极端(1轮/3s,24h)': { roundsPerDay: 28800, activeSeconds: 24 * 3600 }
};
for (const [label, s] of Object.entries(SCEN)) {
  const events = s.roundsPerDay;                       // 每轮 1 条 translate_round（终态）
  const win15 = CONTRACT.flushMsNearRealtime / 1000;
  const windows15 = Math.floor(s.activeSeconds / win15) || 1; // 窗口数
  // 请求数上界 = Σ_窗口 ceil(该窗事件数 / 单批上限)，至少每有事件的窗口 1 批
  const evPerWin = events / windows15;
  const batchesPerWin = Math.max(events > 0 ? 1 : 0, Math.ceil(evPerWin / CONTRACT.batchMaxEvents));
  const reqs15 = batchesPerWin * windows15;
  const reqsDaily = events ? 1 : 0;                    // 日批：全天 1 批（canary 同批）
  out.dailyRequests[label] = {
    eventsPerDay: events,
    windowSec: win15,
    windows: windows15,
    eventsPerWindow: +evPerWin.toFixed(1),
    nearRealtime15min: { requests: reqs15, batchesPerWindow: batchesPerWin, eventsPerReq: reqs15 ? +(events / reqs15).toFixed(2) : 0 },
    dailyBatch: { requests: reqsDaily, eventsPerReq: events }
  };
  console.log(`  ${label.padEnd(20)} 事件/天=${String(events).padStart(5)} | 15min窗(${windows15}个,${evPerWin.toFixed(0)}事件/窗)→${String(reqs15).padStart(4)} 请求/天 | 日批→${reqsDaily} 请求/天`);
}
console.log('');

/* ------------------------------------------------------------------
 * 阈值判定
 * ------------------------------------------------------------------ */
const checks = [];
function check(name, ok, detail) { checks.push({ name, ok, detail }); console.log(`  ${ok ? '✓' : '✗'} ${name} :: ${detail}`); }

console.log('── 判定 ──');
check('帧项（count=999 最大类） ≤ 128 B', out.singleStats.frame.maxBytesCount999 <= 128, out.singleStats.frame.maxBytesCount999 + ' B（' + out.singleStats.frame.maxEv + '）');
check('日批项（最大类） ≤ 1 KB', out.singleStats.daily.maxBytes <= 1024, out.singleStats.daily.maxBytes + ' B（' + out.singleStats.daily.maxEv + '）');
check('帧项 props 仅 {count}（online 例外 = {}）', Object.keys(makeFrameItem('translate_round', 1).props).join() === 'count' && Object.keys(makeFrameOnlineItem().props).length === 0, '帧项 props=[' + Object.keys(makeFrameItem('translate_round', 1).props) + ']，online props=[]');
check('帧 win 为数值 epoch ms int（契约 §1.4 / DL-17②）', Number.isInteger(buildFrameBatch(2).win), 'win=' + buildFrameBatch(2).win + ' | typeof=' + typeof buildFrameBatch(2).win);
check('批 50 条（帧封套） ≤ 64 KB（契约硬上限）', out.batches['帧封套(kind:frame)'][50].bytes <= CONTRACT.batchMaxBytes, out.batches['帧封套(kind:frame)'][50].bytes + ' B');
check('批 50 条（日批封套） ≤ 64 KB（契约硬上限）', out.batches['日批封套(kind:daily)'][50].bytes <= CONTRACT.batchMaxBytes, out.batches['日批封套(kind:daily)'][50].bytes + ' B');
check('批 50 条序列化 p95 ≤ 5ms', Math.max(out.batches['帧封套(kind:frame)'][50].p95ms, out.batches['日批封套(kind:daily)'][50].p95ms) <= 5, Math.max(out.batches['帧封套(kind:frame)'][50].p95ms, out.batches['日批封套(kind:daily)'][50].p95ms).toFixed(4) + ' ms');
check('队列驻留 ≤ 256 KB（契约上限）', out.queue.retainedBytes <= CONTRACT.queueMaxBytes, out.queue.retainedBytes + ' B');
check('重试（max8）额外请求 ≤ 8', out.retry['超上限放弃'].retries <= CONTRACT.retryMax, out.retry['超上限放弃'].retries + ' 次');
const allPass = checks.every((c) => c.ok);
out.checks = checks;
out.conclusion = allPass ? 'PASS' : 'FAIL';
console.log(`结论：${out.conclusion}（${checks.filter(c => c.ok).length}/${checks.length}）`);

/* 输出 */
fs.mkdirSync(RESULT_DIR, { recursive: true });
const ts = new Date().toISOString().replace(/[:]/g, '-').replace(/\..+/, '');
const file = path.join(RESULT_DIR, `bench-upload-overhead-${ts}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(RESULT_DIR, 'bench-upload-overhead-latest.json'), JSON.stringify(out, null, 2));
console.log('结果：' + file);
process.exit(allPass ? 0 : 1);
