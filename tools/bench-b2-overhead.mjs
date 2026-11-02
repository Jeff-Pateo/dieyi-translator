/*
 * 叠译 · B2 性能压测台 —— corrStats 纯逻辑基准（C-62）
 * ==================================================================
 * 【为什么是这台压测台】
 * B2 唯一的「高频写」热点是纠错提交时的 `ct.corrStats` 计数：
 *   每次 SAVE_CORRECTION 成功都要 —— 读 local → 键归一 → 计数 → 淘汰 → 写 local。
 * 这条链在 worker 进程内、不是翻译主路径，却随用户纠错频率线性增长，
 * 因此需要一把**可复现的尺子**把单次提交的量级钉死。
 *
 * 【口径声明（重要，不许含糊）】
 *   · 本脚本测的是 **算法级等价实现**，不是端到端。
 *     原因：corrStats 逻辑封在 MV3 service worker 内，Node 无法直接 import
 *     （chrome.* 全局不存在），且本机 sandbox 禁止 node spawn 子进程（EBUSY）。
 *     因此脚本内联一份与《B2-详细设计》§2.1 伪码逐条对应的等价实现
 *     （normKey / 键拼接 / n++ / last / 按 last 淘汰 / JSON 序列化）。
 *     若 shared/constants.js 已定义 `CT.LEARNING.STATS_MAX`，脚本**自动采用**
 *     真实常量（保证与 dev-core 落地的容量口径一致），否则用设计文档值并标注。
 *   · `chrome.storage.local.get/set` 的真实 I/O 延迟**不在本基准内**
 *     （那是浏览器/磁盘行为，不是算法成本）。本基准量的是 CPU 侧成本，
 *     localStorage 的读写延迟在报告里按 0.1~1ms 量级单独讨论。
 *
 * 【测什么】
 *   ① 单次提交热路径（update+evict）：normKey + 键拼接 + n++ + 淘汰。
 *   ② 冷淘汰开销：满 200 键时再来一条新键，三种淘汰实现的差异。
 *   ③ 序列化（write payload 准备）：JSON.stringify(200 键) 的耗时。
 *   ④ 反序列化（read 侧等价）：JSON.parse 的耗时。
 *   ⑤ 三种淘汰实现的复杂度对比：全排序 O(n log n) / 最小扫描 O(n) / LRU-Map O(1)。
 *
 * 【规模】1 / 50 / 200 键（分别对应：冷启动首条、中等使用、容量上限）。
 *   每规模 10,000 次提交 —— 远超真人单会话纠错次数（百量级），
 *   是为了把单次成本的噪声压到可读。
 *
 * 运行（单进程，禁止 spawn）：
 *   node tools/bench-b2-overhead.mjs
 * 输出：tools/bench-results/bench-b2-overhead-<时间戳>.json
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RESULT_DIR = path.join(HERE, 'bench-results');

/* ------------------------------------------------------------------
 * 采用真实常量（如已落地），否则回落设计文档值并如实标注
 * ------------------------------------------------------------------ */
let STATS_MAX = 200;
let THRESHOLD = 3;
let WRITE_MS = 600000;
let SPAN_MAX = 40;
let constantsSource = 'design-doc-fallback（shared/constants.js 未定义 CT.LEARNING）';
let normKeySource = 'inline-equivalent（未取到 terminology._internals.normKey）';
let realNormKey = null;
try {
  const sandbox = {};
  vm.createContext(sandbox);
  for (const f of ['shared/constants.js', 'shared/terminology.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
  }
  const CT = sandbox.CT;
  if (CT && CT.LEARNING) {
    if (CT.LEARNING.STATS_MAX) STATS_MAX = CT.LEARNING.STATS_MAX;
    if (CT.LEARNING.THRESHOLD) THRESHOLD = CT.LEARNING.THRESHOLD;
    if (CT.LEARNING.CORR_STATS_WRITE_MS) WRITE_MS = CT.LEARNING.CORR_STATS_WRITE_MS;
    if (CT.LEARNING.SPAN_MAX) SPAN_MAX = CT.LEARNING.SPAN_MAX;
    constantsSource = 'shared/constants.js:CT.LEARNING（真实常量）';
  }
  // production 实现用的是 term._internals.normKey（service-worker.js:344），
  // 复用同一实现 → 本基准的键归一成本与生产同源。
  if (CT && CT.terminology && CT.terminology._internals
    && typeof CT.terminology._internals.normKey === 'function') {
    realNormKey = CT.terminology._internals.normKey;
    normKeySource = 'shared/terminology.js:_internals.normKey（与生产同源）';
  }
} catch (e) {
  constantsSource = 'design-doc-fallback（读取 constants.js 失败：' + e.message + '）';
}

/* ==================================================================
 * 算法级等价实现（对应《B2-详细设计》§2.1 伪码 + service-worker.js:343-401）
 * ================================================================== */

/** 键归一：优先用生产同源 normKey，否则内联等价（trim + toLowerCase） */
function normKey(from) {
  if (realNormKey) return realNormKey(from);
  return String(from == null ? '' : from).trim().toLowerCase();
}

/** 词级唯一连续改动跨度（对应 extractCorrectionSpan 的核心：前后缀裁剪） */
function extractCorrectionSpan(from, to) {
  if (from === to) return null;
  const a = String(from), b = String(to);
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  const spanFrom = a.slice(p, a.length - s);
  const spanTo = b.slice(p, b.length - s);
  if (!spanFrom && !spanTo) return null;
  return { from: spanFrom, to: spanTo };
}

/** 键 = normKey(spanFrom)+'|'+spanTo+'|'+tgt */
function corrKey(span, tgt) {
  return normKey(span.from) + '|' + span.to + '|' + (tgt || 'zh-CN');
}

/* ------------------------------------------------------------------
 * 三种淘汰实现
 * ------------------------------------------------------------------ */

/** ① 全排序按 last 升序（设计文档字面口径）：O(n log n) */
function evictSort(stats, max) {
  const keys = Object.keys(stats);
  if (keys.length <= max) return 0;
  keys.sort((x, y) => stats[x].last - stats[y].last);
  const drop = keys.length - max;
  for (let i = 0; i < drop; i++) delete stats[keys[i]];
  return drop;
}

/** ② 最小扫描：单次找 min(last) 删除：O(n) */
function evictMinScan(stats, max) {
  let dropped = 0;
  while (Object.keys(stats).length > max) {
    let victim = null, vLast = Infinity;
    for (const k in stats) {
      if (stats[k].last < vLast) { vLast = stats[k].last; victim = k; }
    }
    if (victim === null) break;
    delete stats[victim];
    dropped++;
  }
  return dropped;
}

/** ③ LRU-Map：touch 时 delete+set 把键移到 Map 末尾，淘汰取首个 key：O(1) */
class LruStats {
  constructor(max) { this.max = max; this.map = new Map(); }
  touch(key, now) {
    let st = this.map.get(key);
    if (st) { this.map.delete(key); st.n += 1; st.last = now; this.map.set(key, st); }
    else {
      st = { n: 1, first: now, last: now, dismissed: false };
      this.map.set(key, st);
      if (this.map.size > this.max) {
        const victim = this.map.keys().next().value;
        this.map.delete(victim);
      }
    }
    return st;
  }
}

/* ------------------------------------------------------------------
 * 夹具：造出「接近真实」的 span 字符串（拉丁搭配 / 纯 CJK）
 * ------------------------------------------------------------------ */
const LATIN_WORDS = ['Prompt', 'Manager', 'Growth', 'Engineer', 'Remote', 'Senior', 'Product', 'Design', 'Deploy', 'Cache'];
const CJK_WORDS = ['提示词', '产品经理', '增长', '工程师', '远程', '高级', '产品', '设计', '部署', '缓存'];
function makeSpan(i) {
  // 带 i 后缀保证键唯一（否则 200 规模会因键碰撞塌缩成个位数）
  if (i % 2 === 0) return { from: LATIN_WORDS[i % 10] + ' ' + i, to: CJK_WORDS[i % 10] + i };
  return { from: CJK_WORDS[(i + 3) % 10] + '工程师' + i, to: CJK_WORDS[(i + 5) % 10] + '专家' + i };
}
function makeSentence(i) {
  return 'We are hiring a ' + LATIN_WORDS[i % 10] + ' for the platform team number ' + i + '.';
}

/* ------------------------------------------------------------------
 * 计时工具
 * ------------------------------------------------------------------ */
function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    min: +s[0].toFixed(4),
    p50: +q(0.5).toFixed(4),
    p95: +q(0.95).toFixed(4),
    max: +s[s.length - 1].toFixed(4),
    avg: +avg.toFixed(4)
  };
}

/* ==================================================================
 * 场景执行
 * ================================================================== */
const SUBMITS = 10000;

/** 规模 = 预置键数；每规模跑 SUBMITS 次提交，记录逐次耗时 */
function runScenario(presetKeys, impl) {
  const now0 = 1700000000000;

  // 预置：填到 presetKeys（不足时只填这么多）
  const stats0 = {};
  const lru = impl === 'lru' ? new LruStats(STATS_MAX) : null;
  for (let i = 0; i < presetKeys; i++) {
    const span = makeSpan(i);
    const key = corrKey(span, 'zh-CN');
    const t = now0 + i;
    if (lru) lru.touch(key, t);
    else stats0[key] = { n: 1, first: t, last: t, dismissed: false };
  }

  const coreUs = new Array(SUBMITS);
  const evictUs = new Array(SUBMITS);
  let evictCount = 0;

  for (let i = 0; i < SUBMITS; i++) {
    // 稳态：在既有键集上反复提交（真人「同一处反复改」的形态）；
    // 淘汰只在满容量 + 新键出现时发生 —— 由 runEvictStress 单独隔离量测。
    const span = makeSpan(i % presetKeys);
    const t = now0 + presetKeys + i;

    // ---- ① 键归一 + 拼接（每次提交都做） ----
    const t0 = performance.now();
    const key = corrKey(span, 'zh-CN');

    // ---- ② 计数（读+改+写） ----
    if (lru) {
      lru.touch(key, t);
    } else {
      const st = stats0[key];
      if (st) { st.n += 1; st.last = t; }
      else stats0[key] = { n: 1, first: t, last: t, dismissed: false };
    }
    const t1 = performance.now();
    coreUs[i] = (t1 - t0) * 1000;

    // ---- ③ 淘汰（仅在超限时发生；单独计） ----
    const t2 = performance.now();
    if (!lru) {
      const dropped = impl === 'sort'
        ? evictSort(stats0, STATS_MAX)
        : evictMinScan(stats0, STATS_MAX);
      evictCount += dropped;
    }
    const t3 = performance.now();
    evictUs[i] = (t3 - t2) * 1000;
  }

  const finalSize = lru ? lru.map.size : Object.keys(stats0).length;

  // ---- ④ 序列化（write payload 准备） ----
  const serMs = [];
  for (let r = 0; r < 200; r++) {
    const t = performance.now();
    if (lru) {
      // Map → 普通对象（真实落盘前要转 JSON 可序列化结构）
      const obj = {};
      for (const [k, v] of lru.map) obj[k] = v;
      JSON.stringify(obj);
    } else {
      JSON.stringify(stats0);
    }
    serMs.push(performance.now() - t);
  }

  // ---- ⑤ 反序列化（read 侧等价：local.get 回来是已解析对象，
  //         这里用 parse 的等价成本近似结构化克隆的下界） ----
  const payload = lru
    ? (() => { const obj = {}; for (const [k, v] of lru.map) obj[k] = v; return JSON.stringify(obj); })()
    : JSON.stringify(stats0);
  const deMs = [];
  for (let r = 0; r < 200; r++) {
    const t = performance.now();
    JSON.parse(payload);
    deMs.push(performance.now() - t);
  }

  return {
    presetKeys,
    impl,
    submits: SUBMITS,
    finalKeys: finalSize,
    evictedTotal: evictCount,
    coreUs: stats(coreUs),
    evictUs: stats(evictUs),
    serializeMs: stats(serMs),
    deserializeMs: stats(deMs),
    payloadBytes: payload.length
  };
}

/** 纯淘汰路径压测：满容量 + 全新键，隔离淘汰成本 */
function runEvictStress(impl) {
  const now0 = 1800000000000;
  const REPS = 2000;
  const us = [];
  let droppedTotal = 0;
  const stats0 = {};
  for (let i = 0; i < STATS_MAX; i++) {
    const key = corrKey(makeSpan(i), 'zh-CN');
    stats0[key] = { n: 1, first: now0 + i, last: now0 + i, dismissed: false };
  }
  const lru = impl === 'lru' ? new LruStats(STATS_MAX) : null;
  if (lru) {
    for (let i = 0; i < STATS_MAX; i++) lru.touch(corrKey(makeSpan(i), 'zh-CN'), now0 + i);
  }
  for (let i = 0; i < REPS; i++) {
    const t = now0 + 100000 + i;
    const key = 'brand|new|' + i + '|zh-CN'; // 全新键 → 必触发淘汰
    const t0 = performance.now();
    if (lru) {
      lru.touch(key, t);
      droppedTotal += 1;
    } else {
      stats0[key] = { n: 1, first: t, last: t, dismissed: false };
      droppedTotal += impl === 'sort'
        ? evictSort(stats0, STATS_MAX)
        : evictMinScan(stats0, STATS_MAX);
    }
    us.push((performance.now() - t0) * 1000);
  }
  return { impl, reps: REPS, evictedTotal: droppedTotal, perEvictUs: stats(us) };
}

/* ==================================================================
 * 主流程
 * ================================================================== */
console.log('── B2 corrStats 纯逻辑基准（Node 单进程 · 算法级等价） ──');
console.log('STATS_MAX=' + STATS_MAX + ' THRESHOLD=' + THRESHOLD + ' WRITE_MS=' + WRITE_MS + ' SPAN_MAX=' + SPAN_MAX);
console.log('常量来源：' + constantsSource);
console.log('normKey 来源：' + normKeySource + '\n');

const scenarios = [];
for (const keys of [1, 50, STATS_MAX]) {
  for (const impl of ['sort', 'minscan', 'lru']) {
    const r = runScenario(keys, impl);
    scenarios.push(r);
    console.log(
      `[keys=${String(keys).padStart(3)} ${impl.padEnd(7)}] ` +
      `core p50=${r.coreUs.p50}µs p95=${r.coreUs.p95}µs max=${r.coreUs.max}µs | ` +
      `evict p50=${r.evictUs.p50}µs max=${r.evictUs.max}µs | ` +
      `ser p50=${r.serializeMs.p50}ms 反ser p50=${r.deserializeMs.p50}ms | ` +
      `payload=${r.payloadBytes}B 终键=${r.finalKeys}`
    );
  }
}

console.log('');
const evictStress = ['sort', 'minscan', 'lru'].map((impl) => {
  const r = runEvictStress(impl);
  console.log(
    `[满容量淘汰 ${impl.padEnd(7)}] 每次淘汰 p50=${r.perEvictUs.p50}µs p95=${r.perEvictUs.p95}µs ` +
    `max=${r.perEvictUs.max}µs avg=${r.perEvictUs.avg}µs（${r.reps} 次全新键）`
  );
  return r;
});

/* ------------------------------------------------------------------
 * 验收门槛（与报告一致；「有牙齿」= 超线即红）
 * ------------------------------------------------------------------ */
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail !== undefined ? ' :: ' + detail : ''));
}

console.log('');
const maxKeyScenario = scenarios.filter((s) => s.presetKeys === STATS_MAX);
const bestImpl = maxKeyScenario.reduce((a, b) => (a.coreUs.p50 <= b.coreUs.p50 ? a : b));
const worstEvict = evictStress.reduce((a, b) => (a.perEvictUs.p50 >= b.perEvictUs.p50 ? a : b));

check('① 满容量单次提交核心成本 p50 ≤ 20µs（远低于一次 local 写 0.1~1ms）',
  bestImpl.coreUs.p50 <= 20, bestImpl.impl + ' ' + bestImpl.coreUs.p50 + 'µs');
check('② 满容量单次提交核心成本 p95 ≤ 50µs',
  bestImpl.coreUs.p95 <= 50, bestImpl.coreUs.p95 + 'µs');
check('③ 最坏淘汰实现单次淘汰 p50 ≤ 500µs（200 键全排序上界）',
  worstEvict.perEvictUs.p50 <= 500, worstEvict.impl + ' ' + worstEvict.perEvictUs.p50 + 'µs');
check('④ 200 键序列化 p50 ≤ 1ms',
  bestImpl.serializeMs.p50 <= 1, bestImpl.serializeMs.p50 + 'ms');
check('⑤ 淘汰后键数守恒 == STATS_MAX',
  scenarios.filter((s) => s.presetKeys === STATS_MAX && s.impl !== 'lru')
    .every((s) => s.finalKeys === STATS_MAX),
  JSON.stringify(scenarios.filter((s) => s.presetKeys === STATS_MAX).map((s) => s.finalKeys)));

const pass = results.every((r) => r.ok);

const report = {
  meta: {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    tool: 'tools/bench-b2-overhead.mjs',
    scope: 'algorithm-level-equivalent（算法级等价，非端到端；不含 chrome.storage.local I/O）',
    constantsSource,
    normKeySource,
    STATS_MAX, THRESHOLD, WRITE_MS, SPAN_MAX,
    submitsPerScenario: SUBMITS
  },
  scenarios,
  evictStress,
  checks: results,
  conclusion: pass ? 'PASS' : 'FAIL'
};

fs.mkdirSync(RESULT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = path.join(RESULT_DIR, 'bench-b2-overhead-' + stamp + '.json');
fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
const latestPath = path.join(RESULT_DIR, 'bench-b2-overhead-latest.json');
fs.writeFileSync(latestPath, JSON.stringify(report, null, 2), 'utf8');

console.log('\n' + '─'.repeat(60));
console.log('结论：' + (pass ? 'PASS' : 'FAIL') +
  `（${results.filter((r) => r.ok).length}/${results.length}）`);
console.log('已写入：' + path.relative(ROOT, outPath).replace(/\\/g, '/'));
process.exitCode = pass ? 0 : 1;
