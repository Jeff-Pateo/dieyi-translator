/*
 * 双语助手 · 术语数据审计
 * ==================================================================
 * 这不是单元测试，是**数据治理工具**：术语表是沉默生效的 ——
 * 一条写错的术语不会报错，只会安静地把所有页面上的某个词译错，
 * 而且因为进缓存，改了也未必生效。等用户发现时问题已经扩散。
 *
 * 因此把「数据质量」变成可执行结论：
 *   1) 结构审计 —— 空词、重复、冲突译名、过短易误伤、译名含占位符字符
 *   2) 目标语言隔离 —— 中文译名绝不能泄漏到日语/法语等语向
 *   3) 冲突消解 —— 用户表是否真的压住了基座
 *   4) 端到端验证 —— 用真实句子跑一遍掩码 → 还原，确认译名真的落地
 *
 * 用法：
 *   node tools/glossary-audit.mjs                      # 审基座
 *   node tools/glossary-audit.mjs user.json            # 审基座 + 用户表
 *   node tools/glossary-audit.mjs --json               # 机器可读输出
 *
 * 退出码：0 = 无 errors；1 = 有 errors（供 CI 门禁）
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* ---------------- 装配：三个 UMD 普通脚本，在全局上下文执行 ---------------- */
globalThis.self = globalThis;
for (const rel of ['shared/constants.js', 'shared/terminology.js', 'shared/protect.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), { filename: rel });
}
const CT = globalThis.CT;
const T = CT.terminology;
const P = CT.protect;

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const userPath = argv.find((a) => !a.startsWith('--')) || null;

/* ---------------- 工具 ---------------- */
const bar = (n) => '─'.repeat(n);
function hr(title) {
  if (asJson) return;
  console.log('\n' + title);
  console.log(bar(56));
}
function kv(k, v) {
  if (asJson) return;
  console.log('  ' + k.padEnd(30, ' ') + v);
}

/* ================================================================== */
/* 一、基座盘点                                                        */
/* ================================================================== */
const report = { base: {}, domains: {}, audit: {}, locales: {}, conflicts: {}, e2e: {}, issues: [] };

const base = T.BASE;
const byDomain = {};
const byTgt = {};
for (const e of base) {
  byDomain[e.domain] = (byDomain[e.domain] || 0) + 1;
  const tk = e.to === '' ? '*' : (e.tgt || 'zh-CN');
  byTgt[tk] = (byTgt[tk] || 0) + 1;
}

report.base = {
  version: T.VERSION,
  total: base.length,
  keepAsIs: base.filter((e) => e.to === '').length,
  translated: base.filter((e) => e.to !== '').length,
  ambiguousExcluded: CT.AMBIGUOUS.length
};
report.domains = byDomain;
report.locales = byTgt;

hr('一、基座盘点');
kv('治理版本', T.VERSION);
kv('条目总数', String(base.length));
kv('  · 保持原样（to = ""）', String(report.base.keepAsIs));
kv('  · 给出指定译名', String(report.base.translated));
kv('  · 有意排除的多义词（留痕）', String(report.base.ambiguousExcluded));
for (const d of T.DOMAINS) {
  kv('  域 ' + d.id + '（' + d.label + '）', String(byDomain[d.id] || 0));
}

/* ================================================================== */
/* 二、结构审计                                                        */
/* ================================================================== */
const audit = T.auditGlossary(base);
report.audit = {
  errors: audit.errors,
  warnings: audit.warnings,
  errorCount: audit.errors.length,
  warningCount: audit.warnings.length
};

hr('二、结构审计（基座）');
kv('errors', String(audit.errors.length));
for (const e of audit.errors) kv('  ✗ ' + (e.from || '(空)'), e.code + ' —— ' + e.msg);
kv('warnings', String(audit.warnings.length));
for (const w of audit.warnings) kv('  ! ' + (w.from || '(空)'), w.code + ' —— ' + w.msg);

/* 用户表（可选） */
let userGlossary = null;
if (userPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.resolve(userPath), 'utf8'));
    userGlossary = Array.isArray(raw) ? raw : raw.glossary;
    if (!Array.isArray(userGlossary)) throw new Error('既不是数组，也没有 glossary 字段');
  } catch (e) {
    report.issues.push('用户表读取失败：' + e.message);
    console.error('\n用户表读取失败：' + e.message);
    process.exit(1);
  }
  const ua = T.auditGlossary(userGlossary);
  report.audit.user = {
    total: userGlossary.length,
    errors: ua.errors,
    warnings: ua.warnings
  };
  hr('二·补 结构审计（用户表）');
  kv('条目总数', String(userGlossary.length));
  kv('errors', String(ua.errors.length));
  for (const e of ua.errors) kv('  ✗ ' + (e.from || '(空)'), e.code + ' —— ' + e.msg);
  kv('warnings', String(ua.warnings.length));
  for (const w of ua.warnings) kv('  ! ' + (w.from || '(空)'), w.code + ' —— ' + w.msg);
}

/* ================================================================== */
/* 三、目标语言隔离                                                    */
/* ================================================================== */
hr('三、目标语言隔离（给定译名的条目不得跨语向泄漏）');
const zhOnly = base.filter((e) => e.to !== '' && (e.tgt || 'zh-CN') === 'zh-CN').length;
const keepAll = base.filter((e) => e.to === '').length;

const zhMerged = T.mergeGlossary(userGlossary, { targetLang: 'zh-CN' });
const jaMerged = T.mergeGlossary(userGlossary, { targetLang: 'ja' });
const frMerged = T.mergeGlossary(userGlossary, { targetLang: 'fr' });

report.locales = {
  zhCN: zhMerged.length,
  ja: jaMerged.length,
  fr: frMerged.length,
  expectedNonZh: keepAll + (userGlossary ? userGlossary.filter((t) => t && t.to === '').length : 0)
};

kv('zh-CN 生效条目', String(zhMerged.length));
kv('ja   生效条目', String(jaMerged.length) + '（应等于「保持原样」条目数 ' + keepAll + '）');
kv('fr   生效条目', String(frMerged.length));
const leak = jaMerged.filter((t) => /[\u4E00-\u9FFF]/.test(t.to));
const okIsolation = leak.length === 0;
kv('中文译名泄漏到 ja 的条数', String(leak.length));
if (!okIsolation) {
  report.issues.push('目标语言隔离被破坏：' + leak.map((t) => t.from).join(', '));
  for (const t of leak) kv('  ✗ ' + t.from, t.to);
}

/* ================================================================== */
/* 四、冲突消解：用户表是否真的压住了基座                                */
/* ================================================================== */
hr('四、冲突消解（用户 > 基座）');
const probeFrom = 'Product Manager';
const baseVal = (zhMerged.find((t) => t.from === probeFrom) || {}).to;
const userOverride = T.mergeGlossary([{ from: probeFrom, to: '产品负责人' }], { targetLang: 'zh-CN' });
const overVal = (userOverride.find((t) => t.from === probeFrom) || {}).to;
kv('基座给出的译名', String(baseVal));
kv('用户覆盖后的译名', String(overVal));
const okOverride = overVal === '产品负责人' && userOverride.length === zhMerged.length +
  (userGlossary && userGlossary.some((t) => t && String(t.from).toLowerCase() === probeFrom.toLowerCase()) ? 0 : 1);
report.conflicts = { baseVal, overVal, okOverride };
if (overVal !== '产品负责人') {
  report.issues.push('用户术语未能覆盖基座同名条目');
}

/* 大小写不同的同名词不得重复入场 */
const dupTrial = T.mergeGlossary([
  { from: 'product manager', to: 'A' },
  { from: 'Product Manager', to: 'B' }
], { targetLang: 'zh-CN' });
const dupHits = dupTrial.filter((t) => String(t.from).toLowerCase() === 'product manager');
kv('大小写同名词入场次数', String(dupHits.length) + '（应为 1）');
if (dupHits.length !== 1) report.issues.push('大小写同名词重复入场');

/* ================================================================== */
/* 五、端到端：真实句子走一遍掩码 → 还原                                */
/* ================================================================== */
hr('五、端到端验证（截图现场）');

/** 模拟「引擎什么都没改」的最坏情况：译文 = 掩码串本身。
 *  这样能纯靠还原逻辑验证「术语判据真的命中、真的替换」。 */
function pipeline(text, glossary) {
  const r = P.mask(text, { protectUntranslatable: true, glossary });
  const restored = P.restore(r.masked, r.table);
  return { masked: r.masked, out: restored.text, terms: r.table.map((t) => t.text) };
}

const cases = [
  // [名称, 原文, 必须命中, 必须不命中]
  // 截图标题：长搭配 `Growth Product Manager` 必须**先**命中，
  // 短搭配 `Product Manager` 因此不得再独立入场 —— 否则
  // "Product Manager" 段会连同前面的 "Growth" 一起留在原文里被引擎乱翻。
  // 剩下的 `Senior` 单独交给引擎译成「高级」，这是有意的。
  ['截图标题', 'Senior Growth Product Manager AI Native', ['增长产品经理'], ['产品经理']],
  ['截图标签行', 'Product Manager  Marketing  Executive', ['产品经理', '市场营销'], []],
  ['截图品牌行', 'Magic Eden', ['Magic Eden'], []],
  ['缩写保持', 'Own the OKR and PRD for the team', ['OKR', 'PRD'], []],
  ['长搭配优先', 'Growth Product Manager', ['增长产品经理'], ['产品经理']]
];

const e2e = [];
for (const [name, text, expect, notExpect] of cases) {
  const r = pipeline(text, zhMerged);
  const missed = expect.filter((x) => r.terms.indexOf(x) < 0);
  const leaked = (notExpect || []).filter((x) => r.terms.indexOf(x) >= 0);
  const pass = missed.length === 0 && leaked.length === 0;
  e2e.push({ name, text, expect, notExpect: notExpect || [], terms: r.terms, missed, leaked, pass });
  if (missed.length) {
    report.issues.push('端到端未命中：' + name + ' 缺少 ' + JSON.stringify(missed) +
      ' 实际 ' + JSON.stringify(r.terms));
  }
  if (leaked.length) {
    report.issues.push('短搭配越权入场：' + name + ' 不该出现 ' + JSON.stringify(leaked) +
      '（长搭配应已吃掉它）');
  }
}
report.e2e = e2e;

for (const c of e2e) {
  const detail = '命中 ' + JSON.stringify(c.terms) +
    (c.notExpect.length ? '（不得含 ' + JSON.stringify(c.notExpect) + '）' : '');
  kv((c.pass ? '✓ ' : '✗ ') + c.name, detail);
}

/* 反例：多义词不应被硬替换 */
hr('五·补 反例（被有意排除的多义词不该命中）');
const negCases = [
  ['personal growth', ['个人成长'], 'Growth 单独出现时不得被替换成「增长」'],
  ['promotion to senior level', [], 'Promotion 不在基座内']
];
const neg = [];
for (const [text, , why] of negCases) {
  const r = pipeline(text, zhMerged);
  const leaked = r.terms.filter((t) => t === '增长' || t === '晋升');
  neg.push({ text, why, leaked, pass: leaked.length === 0 });
  if (leaked.length) report.issues.push('多义词误伤：' + text + ' → ' + JSON.stringify(leaked));
}
report.negatives = neg;
for (const n of neg) kv((n.pass ? '✓ ' : '✗ ') + n.text, n.why);

/* ================================================================== */
/* 六、哈希稳定性                                                      */
/* ================================================================== */
hr('六、术语哈希（缓存键的一致性依据）');
const h1 = T.termHash(zhMerged);
const h2 = T.termHash(zhMerged.slice().reverse());
const h3 = T.termHash(zhMerged.concat([{ from: 'Fixture Only', to: '仅测试' }]));
const h4 = T.termHash(T.mergeGlossary([{ from: 'Product Manager', to: '产品负责人' }], { targetLang: 'zh-CN' }));
kv('同一术语集哈希', h1);
kv('顺序颠倒后', h2 + (h1 === h2 ? '（一致 ✓）' : '（不一致 ✗）'));
kv('新增一条后', h3 + (h1 !== h3 ? '（变化 ✓）' : '（未变 ✗）'));
kv('改一条译名后', h4 + (h1 !== h4 ? '（变化 ✓）' : '（未变 ✗）'));
report.hashes = { base: h1, reordered: h2, added: h3, overridden: h4 };
if (h1 !== h2) report.issues.push('哈希对顺序敏感 —— 合并顺序变化会导致缓存整体失效');
if (h1 === h3) report.issues.push('新增术语未改变哈希 —— 缓存不会失效，错译无法纠正');
if (h1 === h4) report.issues.push('译名变更未改变哈希 —— 缓存不会失效，改术语不生效');

/* ================================================================== */
/* 汇总                                                               */
/* ================================================================== */
const errorCount = audit.errors.length +
  (report.audit.user ? report.audit.user.errors.length : 0) +
  (okIsolation ? 0 : 1) +
  e2e.filter((c) => !c.pass).length +
  neg.filter((n) => !n.pass).length;

report.summary = {
  errors: errorCount,
  issues: report.issues,
  ok: errorCount === 0
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('\n' + bar(56));
  if (report.issues.length) {
    console.log('需要处理的问题：');
    for (const i of report.issues) console.log('  · ' + i);
  }
  console.log(errorCount === 0
    ? '术语数据体检通过（errors 0）'
    : '术语数据体检发现 ' + errorCount + ' 项 error');
}

process.exit(errorCount === 0 ? 0 : 1);
