/*
 * 叠译 · settings 同步配额预算监测（U1）
 * ==================================================================
 * 【背景】
 * `settings`（含 glossary + corrections）是 chrome.storage.sync 的**单个 item**，
 * 受 `QUOTA_BYTES_PER_ITEM = 8192` 硬上限约束（Chrome 按 item 的 JSON
 * 字符串化 UTF-8 字节数计）。`saveSettings`（service-worker.js:163-175）在
 * `sync.set` 抛错（配额溢出）时 catch 回退写 `storage.local`，而
 * `loadSettings`（:118-134）**优先读 sync** —— 于是溢出后「写 local、读 sync」，
 * 学得词/纠错**打了没用**（正打在 B2-1 卖点上）。
 *
 * 本批业务裁定：**不修存储形状**（拆键/裁剪属独立变更），**只加监测**。
 * 因此本脚本**只读地测算**，不修改任何生产代码，也未接入 CI 门禁（见报告 §U1）。
 *
 * 【口径声明】
 *   · Node 单进程，**不 spawn 子进程、不依赖浏览器**（本机 sandbox 禁止 spawn）。
 *   · 与生产**同源序列化口径**：用 `shared/constants.js` 的
 *     `CT.settings.merge(CT.DEFAULT_SETTINGS, patch)` 造出与 `saveSettings`
 *     落盘**逐字段一致**的全量 settings，再按 `JSON.stringify({ settings })`
 *     的 UTF-8 字节数计 item 大小（= 生产 payload 形状）。
 *   · 上限常量（corrections 上限、glossary 有效上限）从源码**实读**：
 *     - corrections 上限：service-worker.js 的 `list.slice(-N)`
 *     - glossary 档位：v1.8.0 起**不再有产品上限**（产品完整免费），
 *       本脚本只取一个**测量样本档位**（50 条）估算体积，不代表任何限制。
 *
 * 运行：node tools/audit-settings-budget.mjs
 * 输出：tools/bench-results/audit-settings-budget-<时间戳>.json（+ -latest.json）
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RESULT_DIR = path.join(HERE, 'bench-results');

/* Chrome storage.sync 单 item 硬上限（引自 chrome.storage API：QUOTA_BYTES_PER_ITEM） */
const QUOTA_BYTES_PER_ITEM = 8192;
/* 监测阈值：占用率 ≥ 该比例即告警（本批只报警、不阻断） */
const WARN_PCT = 80;

/* ------------------------------------------------------------------
 * 实读生产常量（不硬编码）
 * ------------------------------------------------------------------ */
const sources = {};

// ① 从 constants.js 取 DEFAULT_SETTINGS + settings.merge（同源造对象）
let CT;
try {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'shared/constants.js'), 'utf8'),
    sandbox, { filename: 'shared/constants.js' }
  );
  CT = sandbox.CT;
  sources.constants = 'shared/constants.js:CT.DEFAULT_SETTINGS + CT.settings.merge';
} catch (e) {
  console.error('无法加载 shared/constants.js：' + e.message);
  process.exit(1);
}
if (!CT || !CT.DEFAULT_SETTINGS || !CT.settings || typeof CT.settings.merge !== 'function') {
  console.error('shared/constants.js 未导出 DEFAULT_SETTINGS / settings.merge，无法同源造对象');
  process.exit(1);
}

// ② corrections 上限：从 service-worker.js 的 `corrections: list.slice(-N)` 实读
let CORRECTIONS_MAX = null;
const swSrc = fs.readFileSync(path.join(ROOT, 'background/service-worker.js'), 'utf8');
{
  const m = swSrc.match(/corrections:\s*list\.slice\(-(\d+)\)/);
  if (m) { CORRECTIONS_MAX = parseInt(m[1], 10); sources.correctionsMax = 'service-worker.js: corrections: list.slice(-' + m[1] + ')'; }
  else { CORRECTIONS_MAX = 500; sources.correctionsMax = '默认 500（未在源码中匹配到 slice(-N)，回落）'; }
}

// ③ glossary 档位：v1.8.0 起不设上限 ⇒ 取固定**样本档位** 50 条估算单条体积。
//    （此前实读商业层常量；该文件已随商业层一并删除。）
const GLOSSARY_SAMPLE = 50;
sources.glossarySample = '固定样本档位（产品已无术语上限，仅用于估算单条体积）';

/* ------------------------------------------------------------------
 * 工具
 * ------------------------------------------------------------------ */
/** 与生产同源：造出 saveSettings 会落盘的全量 settings，量 item 字节数 */
function itemBytes(patch) {
  const settings = CT.settings.merge(CT.DEFAULT_SETTINGS, patch || {});
  const serialized = JSON.stringify({ settings });   // = 生产 payload 形状
  const valueJson = JSON.stringify(settings);
  return {
    settings,
    itemBytes: Buffer.byteLength(serialized, 'utf8'),        // Chrome 配额口径（UTF-8 字节）
    itemCodeUnits: serialized.length,                          // 参考：UTF-16 code unit 数
    valueBytes: Buffer.byteLength(valueJson, 'utf8')
  };
}
function pct(bytes) { return bytes / QUOTA_BYTES_PER_ITEM * 100; }

/* ------------------------------------------------------------------
 * 夹具：贴近真实使用的条目
 * ------------------------------------------------------------------ */
const GLOSSARY_POOL = [
  { from: 'Prompt', to: '提示词' }, { from: 'Product Manager', to: '产品经理' },
  { from: 'Growth', to: '增长' }, { from: 'Senior Engineer', to: '高级工程师' },
  { from: 'Remote', to: '远程' }, { from: 'Deploy', to: '部署' },
  { from: 'Cache', to: '缓存' }, { from: 'Pipeline', to: '流水线' },
  { from: 'Onboarding', to: '入职引导' }, { from: 'Stakeholder', to: '干系人' },
  { from: 'Roadmap', to: '路线图' }, { from: 'Backlog', to: '需求池' },
  { from: 'Sprint', to: '迭代' }, { from: 'Runbook', to: '操作手册' },
  { from: 'Latency', to: '延迟' }, { from: 'Throughput', to: '吞吐量' },
  { from: 'SLA', to: '服务等级协议' }, { from: 'QPS', to: '每秒查询数' },
  { from: 'Rollback', to: '回滚' }, { from: 'Canary', to: '金丝雀发布' }
];
function makeGlossary(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(GLOSSARY_POOL[i % GLOSSARY_POOL.length]);
  return out;
}
/** corrections 条目 = 整句原文 → 修正译文 → 时间戳（长句，贴近真实纠错） */
function makeCorrections(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      from: 'This is a sample paragraph number ' + i + ' that the user corrected on the page.',
      to: '这是第 ' + i + ' 段用户在本页修正后的译文内容。',
      at: 1700000000000 + i
    });
  }
  return out;
}

/* ==================================================================
 * 测算
 * ================================================================== */
const report = { meta: {}, measurements: {}, thresholds: {} };

/* 空态（仅默认设置，无 glossary / corrections） */
const empty = itemBytes({});
report.measurements.empty = {
  itemBytes: empty.itemBytes,
  itemCodeUnits: empty.itemCodeUnits,
  valueBytes: empty.valueBytes,
  occupancyPct: +pct(empty.itemBytes).toFixed(2),
  fieldCount: Object.keys(empty.settings).length
};

/* glossary 样本档位（GLOSSARY_SAMPLE 条） */
const gFull = itemBytes({ glossary: makeGlossary(GLOSSARY_SAMPLE) });
report.measurements.glossaryFull = {
  count: GLOSSARY_SAMPLE,
  itemBytes: gFull.itemBytes,
  deltaOverEmptyBytes: gFull.itemBytes - empty.itemBytes,
  perEntryBytes: +((gFull.itemBytes - empty.itemBytes) / GLOSSARY_SAMPLE).toFixed(2),
  occupancyPct: +pct(gFull.itemBytes).toFixed(2)
};

/* corrections 逐档 × {glossary 0 条, glossary 满员} */
const CORR_TIERS = [10, 25, 50, 100, 500];
const g0 = itemBytes({ corrections: makeCorrections(1) });
const corrPerEntry = g0.itemBytes - empty.itemBytes;   // 单条 corrections 增量（含首条）
report.measurements.correctionsPerEntryBytes = corrPerEntry;

const tiers = [];
for (const base of [{ tag: 'glossary=0', g: 0 }, { tag: 'glossary=50', g: GLOSSARY_SAMPLE }]) {
  for (const n of CORR_TIERS) {
    if (n > CORRECTIONS_MAX) continue;
    const r = itemBytes({ glossary: makeGlossary(base.g), corrections: makeCorrections(n) });
    tiers.push({
      glossaryCount: base.g,
      correctionsCount: n,
      itemBytes: r.itemBytes,
      occupancyPct: +pct(r.itemBytes).toFixed(2),
      exceedsQuota: r.itemBytes > QUOTA_BYTES_PER_ITEM,
      withinSyncBudget: r.itemBytes <= QUOTA_BYTES_PER_ITEM
    });
  }
}
report.measurements.correctionsTiers = tiers;

/* 首次越过 8192B 的档位（在两个 glossary 基线下分别扫） */
function firstExceed(glossaryCount) {
  for (let n = 1; n <= CORRECTIONS_MAX; n++) {
    const r = itemBytes({ glossary: makeGlossary(glossaryCount), corrections: makeCorrections(n) });
    if (r.itemBytes > QUOTA_BYTES_PER_ITEM) {
      const prev = n > 1
        ? itemBytes({ glossary: makeGlossary(glossaryCount), corrections: makeCorrections(n - 1) })
        : null;
      return {
        glossaryCount,
        firstExceedCount: n,
        bytesAtExceed: r.itemBytes,
        bytesAtPrev: prev ? prev.itemBytes : (n === 1 ? itemBytes({ glossary: makeGlossary(glossaryCount) }).itemBytes : null),
        prevCount: n - 1
      };
    }
  }
  return { glossaryCount, firstExceedCount: null, note: '≤ ' + CORRECTIONS_MAX + ' 条仍未越过 8192B' };
}
report.measurements.firstExceed = {
  glossary0: firstExceed(0),
  glossaryFull: firstExceed(GLOSSARY_SAMPLE)
};

/* 阈值与告警线 */
report.thresholds = {
  quotaBytesPerItem: QUOTA_BYTES_PER_ITEM,
  warnPct: WARN_PCT,
  warnBytes: Math.floor(QUOTA_BYTES_PER_ITEM * WARN_PCT / 100),
  hardStopBytes: QUOTA_BYTES_PER_ITEM,
  note: '本批只监测、不阻断；未接入 CI 门禁'
};

/* ==================================================================
 * 输出
 * ================================================================== */
console.log('── settings 同步配额预算监测（U1 · Node 单进程） ──');
console.log('QUOTA_BYTES_PER_ITEM=' + QUOTA_BYTES_PER_ITEM + '  告警线=' + WARN_PCT + '%');
console.log('常量实读来源：');
console.log('  · DEFAULT_SETTINGS/merge : ' + sources.constants);
console.log('  · corrections 上限       : ' + sources.correctionsMax + ' = ' + CORRECTIONS_MAX);
console.log('  · glossary 样本档位      : ' + sources.glossarySample + ' = ' + GLOSSARY_SAMPLE);
console.log('');

const e = report.measurements.empty;
console.log('[空态] item=' + e.itemBytes + 'B（占用 ' + e.occupancyPct + '%）字段数=' + e.fieldCount);
const gf = report.measurements.glossaryFull;
console.log('[glossary 样本 ' + gf.count + ' 条] item=' + gf.itemBytes + 'B（占用 ' + gf.occupancyPct
  + '%）增量=' + gf.deltaOverEmptyBytes + 'B，约 ' + gf.perEntryBytes + 'B/条');
console.log('');
console.log('[corrections 逐档]（单条增量约 ' + corrPerEntry + 'B，夹具为 ~80 字符英文句 + 中文译文）');
for (const t of tiers) {
  console.log('  glossary=' + String(t.glossaryCount).padStart(2) + ' + corrections=' + String(t.correctionsCount).padStart(3)
    + ' → item=' + String(t.itemBytes).padStart(6) + 'B  占用=' + String(t.occupancyPct).padStart(6) + '%  '
    + (t.exceedsQuota ? '✗ 越过 8192B（sync 溢出）' : '✓'));
}
console.log('');
const fe0 = report.measurements.firstExceed.glossary0;
const feF = report.measurements.firstExceed.glossaryFull;
console.log('[首次越界] glossary=0   → corrections 第 ' + fe0.firstExceedCount + ' 条（' + fe0.bytesAtExceed + 'B）');
console.log('[首次越界] glossary=50  → corrections 第 ' + feF.firstExceedCount + ' 条（' + feF.bytesAtExceed + 'B）');
console.log('');
console.log('告警线：占用 ≥ ' + WARN_PCT + '% 即 ' + report.thresholds.warnBytes + 'B；硬上限 ' + QUOTA_BYTES_PER_ITEM + 'B。');
console.log('注意：越界「条数」与条目平均长度强相关（本夹具 corrections≈' + corrPerEntry + 'B/条、glossary≈'
  + report.measurements.glossaryFull.perEntryBytes + 'B/条）；换用真实数据须以同公式重算。');
console.log('说明：本批**只监测、不阻断**，未接入 CI 门禁。');

/* 结论（显式公式，不臆测） */
report.conclusion = {
  emptyBytes: e.itemBytes,
  glossaryFullBytes: gf.itemBytes,
  correctionsPerEntryBytes: corrPerEntry,
  firstExceedGlossary0: fe0.firstExceedCount,
  firstExceedGlossaryFull: feF.firstExceedCount,
  verdict: (feF.firstExceedCount && feF.firstExceedCount <= 50)
    ? 'R1 风险确认：glossary 满员后仅 ' + feF.firstExceedCount + ' 条 sentence 级 corrections 即溢出 8192B（saveSettings 回退写 local，loadSettings 优先读 sync → 学得词静默失效）'
    : '需人工复核'
};

report.meta = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  tool: 'tools/audit-settings-budget.mjs',
  scope: 'read-only 测算（不改生产代码、不落盘任何 storage 键、不 spawn 子进程、不依赖浏览器）',
  sources
};

fs.mkdirSync(RESULT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = path.join(RESULT_DIR, 'audit-settings-budget-' + stamp + '.json');
const latestPath = path.join(RESULT_DIR, 'audit-settings-budget-latest.json');
const json = JSON.stringify(report, null, 2);
fs.writeFileSync(outPath, json, 'utf8');
fs.writeFileSync(latestPath, json, 'utf8');

console.log('');
console.log('结论：' + report.conclusion.verdict);
console.log('已写入：' + path.relative(ROOT, outPath).replace(/\\/g, '/') + '（+ -latest.json）');
