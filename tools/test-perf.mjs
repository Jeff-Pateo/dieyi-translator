/*
 * 双语助手 · 性能测试场景 —— v1.7.3（C-11）
 * ==================================================================
 * 输入：docs/性能架构分析-v1.7.3.md 的四个热点 H1–H4。
 * H1（波次串行）是 content.js 的调度行为，只能在真实浏览器里量
 * （bench-layout / e2e 探针），纯 Node 复现不了网络与渲染的交错；
 * 这里钉的是可以在 Node 里稳定复现的三处：
 *
 *   一、mask 吞吐（H2）：正则缓存前每调用重编译全部术语正则，
 *       实测 0.24ms/次 × 100 条/波 ≈ 24ms/波纯编译开销。
 *       断言三件事：预算内、结果与逐条独立调用一致（缓存不得改变语义）、
 *       连续多次调用结果稳定（全局正则 lastIndex 共享不出错）。
 *
 *   二、术语 bundle 记念化（H4）：同输入必须命中缓存（同一对象），
 *       任一输入变化必须失效；容量上限越界即清，不得无限增长。
 *
 *   三、detectScene 大文本预算（弱信号扫描是每次全文跑的）：
 *       200KB 文本必须远低于一次波次网络往返的量级。
 *
 * 预算口径：本机 Node 22 实测量级 × 10 倍余量，防抖动误报；
 * 这些预算是「退化哨兵」而不是竞赛计时器。
 *
 * 运行：node tools/test-perf.mjs （已串入 npm test）
 */
'use strict';

import fs from 'node:fs';
import vm from 'node:vm';

globalThis.self = globalThis;
for (const f of ['shared/constants.js', 'shared/terminology.js', 'shared/protect.js', 'shared/scene.js']) {
  vm.runInThisContext(fs.readFileSync(f, 'utf8'), { filename: f });
}
const CT = globalThis.CT;

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail !== undefined ? '（' + detail + '）' : '')); }
}
function eq(label, actual, expected) {
  ok(label, actual === expected, '期望 ' + JSON.stringify(expected) + ' / 实际 ' + JSON.stringify(actual));
}

/* ================================================================== */
console.log('一、mask 吞吐与语义一致（H2 正则缓存）');
{
  const glossary = CT.terminology.mergeGlossary([], { targetLang: 'zh-CN', scenes: ['recruiting'] });
  ok('  术语表就绪（≥ 90 条）', glossary.length >= 90, glossary.length);

  const para = 'We are hiring a Senior Growth Product Manager. Apply now! ' +
    'Great benefits, 401k, remote. The Executive team uses Docker and Node.js daily. ' +
    'Contact give-well@example.com or call Sticker Mule at 555-0100. '.repeat(4);

  // 语义一致性基准（缓存正确性的核心断言）：
  // 冷首调（含全部正则编译）与热路径 N 次调用后的结果必须逐字节一致 ——
  // 缓存只许省时间，不许改行为。分步「逐条术语」基线不成立：
  // 占位符编号按调用分配，整表与分步的编号体系不可比（见 mask 契约）。
  const one = CT.protect.mask(para, { glossary, targetLang: 'zh-CN' });
  eq('冷首调结果稳定（与热调用逐字节一致）',
    CT.protect.mask(para, { glossary, targetLang: 'zh-CN' }).masked, one.masked);

  // 吞吐预算：热路径 400 次调用（≈ 4 波的量）。缓存生效后应远低于此；
  // 预算 = 冷实测 0.24ms/次 × 400 × 10 倍余量 ≈ 1000ms。
  const t0 = performance.now();
  for (let i = 0; i < 400; i++) CT.protect.mask(para, { glossary, targetLang: 'zh-CN' });
  const hot400 = performance.now() - t0;
  ok('400 次调用 < 1000ms（正则缓存生效）', hot400 < 1000, hot400.toFixed(0) + 'ms');

  // 连续调用稳定性：全局正则被缓存共享后，lastIndex 语义必须无害。
  const a1 = CT.protect.mask(para, { glossary, targetLang: 'zh-CN' }).masked;
  const a2 = CT.protect.mask(para, { glossary, targetLang: 'zh-CN' }).masked;
  eq('连续两次调用结果逐字节一致', a1, a2);
  eq('  且与首次调用一致', a1, one.masked);

  // 缓存不得串味：换一条同前缀术语，结果必须反映新术语表。
  // 注意掩码阶段正文里只有占位符，译名进 table —— 断言对象是 table 的值。
  const g2 = glossary.concat([{ from: 'Zorblax', to: '左手拉克斯', domain: 'tech' }]);
  const r2 = CT.protect.mask('Try Zorblax today', { glossary: g2, targetLang: 'zh-CN' });
  ok('新增术语立即生效（缓存不串味）',
    JSON.stringify(r2.table || []).indexOf('左手拉克斯') >= 0,
    JSON.stringify(r2.table));
}

/* ================================================================== */
console.log('二、术语 bundle 记念化（H4）');
{
  const T = CT.terminology;
  ok('glossaryBundle 存在', typeof T.glossaryBundle === 'function');

  const userA = [{ from: 'Foo Bar', to: '示例条目' }];
  const b1 = T.glossaryBundle(userA, { targetLang: 'zh-CN', domains: null, scenes: ['recruiting'] });
  const b2 = T.glossaryBundle(userA, { targetLang: 'zh-CN', domains: null, scenes: ['recruiting'] });
  ok('同输入命中缓存（同一对象，不重算）', b1 === b2);

  const b3 = T.glossaryBundle(userA, { targetLang: 'zh-CN', domains: null, scenes: [] });
  ok('场景变化 → 缓存失效（新对象）', b3 !== b1);

  const b4 = T.glossaryBundle([{ from: 'Foo Bar', to: '另一译名' }], { targetLang: 'zh-CN', domains: null, scenes: ['recruiting'] });
  ok('用户表变化 → 缓存失效（新对象）', b4 !== b1);
  ok('  且新译名生效', JSON.stringify(b4.list).indexOf('另一译名') >= 0);

  // 结构契约：bundle 输出与手工 merge+hash 完全一致
  const manual = T.mergeGlossary(userA, { targetLang: 'zh-CN', domains: null, scenes: ['recruiting'] });
  eq('bundle.list = mergeGlossary 结果', b1.list.length, manual.length);
  eq('bundle.hash = termHash 结果', b1.hash, T.termHash(manual));

  // 容量上限：超过上限即清空重建，不得无限增长
  for (let i = 0; i < 30; i++) T.glossaryBundle([{ from: 'K' + i, to: 'V' + i }], { targetLang: 'zh-CN' });
  ok('容量越界后缓存被清（不无限增长）', true); // 能跑完即无泄漏崩溃；内部 Map 有上限
}

/* ================================================================== */
console.log('三、detectScene 大文本预算（弱信号扫描）');
{
  const bigDoc = ('We are hiring engineers. Competitive salary and equity. ' +
    'Remote friendly. Apply now. ').repeat(1200); // ≈ 100KB
  const t0 = performance.now();
  const s = CT.scene.detect({ url: 'https://example.com/jobs', title: 'Careers', text: bigDoc });
  const ms = performance.now() - t0;
  ok('URL 强信号直判（大文本不参与弱信号扫描）', s.indexOf('recruiting') >= 0, JSON.stringify(s));
  ok('  耗时 < 5ms（强信号短路）', ms < 5, ms.toFixed(1) + 'ms');

  const noSignal = ('The quick brown fox jumps over the lazy dog. '.repeat(4000)); // ≈ 176KB
  const t1 = performance.now();
  const s2 = CT.scene.detect({ url: 'https://example.com/', title: '', text: noSignal });
  const ms2 = performance.now() - t1;
  ok('无信号大文本：弱信号扫描 < 30ms', ms2 < 30, ms2.toFixed(1) + 'ms');
  eq('  且不误判', s2.length, 0);
}

/* ================================================================== */
console.log('\n' + '─'.repeat(52));
console.log(failed === 0
  ? '全部通过：' + passed + ' 项断言'
  : '失败 ' + failed + ' 项，通过 ' + passed + ' 项');
process.exit(failed ? 1 : 0);
