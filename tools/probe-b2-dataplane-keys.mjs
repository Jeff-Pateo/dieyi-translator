/*
 * B2 数据面 · 键集合 / 落点 探针（C-62 + C-63）
 * ------------------------------------------------------------------
 * 作者：数析（Metric）· 大数据组 ｜ 2026-10-13
 * 依据：CTO §7.8 白名单 + 《B2-详细设计》§2.1 + 《口径变更单 D-B2-01》
 *
 * 只断言**稳定信号**（键名 / 消息字段 / 存储落点），不断言任何文案全文。
 *
 * 断言清单：
 *  A. 静态：CT.DEFAULT_SETTINGS 不含 corrStats / capNoticeSeen 等新增字段；
 *  B. 静态：CT.STORAGE 相对 B2 前基线，新增项 ⊆ {CORR_STATS, CAP_NOTICE}，
 *           且两键字面量 == 'ct.corrStats' / 'ct.capNoticeSeen'；
 *  C. 动态（mock chrome + 真 worker 调用路径）：
 *     - 纠错提交 3 次 → 计数落 local['ct.corrStats']，键落在候选级；
 *     - settings（sync）**永不出现 corrStats 字段**；
 *     - 纠错提交对 sync 只写 'settings'，对 local 只写注册表内键；
 *     - local 观测到的键 ⊆ Object.values(CT.STORAGE) ∪ { tc:* }；
 *  D. 动态：LEARN_PATTERN 落库条目 Object.keys(entry) 严格 == ['from','to']。
 *
 * 运行：node tools/probe-b2-dataplane-keys.mjs   （退出码 0 = 全绿）
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));

let passed = 0, skipped = 0;
const failures = [];
function ok(label, cond, extra) {
  if (cond) { passed++; console.log('  \u2713 ' + label); }
  else { failures.push(label); console.log('  \u2717 ' + label + (extra ? '  \u2192 ' + extra : '')); }
}
function eq(label, actual, expected) {
  ok(label + '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）', actual === expected);
}
function skip(label, why) { skipped++; console.log('  \u25CB SKIP ' + label + ' —— ' + why); }
function section(t) { console.log('\n' + t); }

/* ================================================================== */
/* 一、静态：常量与存储键注册表                                          */
/* ================================================================== */

function loadConstants() {
  const code = fs.readFileSync(path.join(ROOT, 'shared', 'constants.js'), 'utf8');
  const holder = {};
  new Function('self', code).call(holder, holder);
  return holder.CT;
}
const CT0 = loadConstants();

// B2 之前的 CT.STORAGE 值集合（= 我审计报告 §6 记录的基线；硬编码为护栏锚点）
const PRE_B2_STORAGE_VALUES = ['ct.toggleUI', 'ct.siteState'];
/* ✅ **已解除**（`2026-10-17`）—— 原「下列 2 条断言**预期红**」状态结束。
 * 本 2 项由 `ct.reportSalt` / `ct.reportAgg` 触发：它们是 **C-68 的 4 项新增物中的 2 项**
 * （`shared/constants.js:401-402`），其加入「允准清单」的授权来源 = **C-68 变更单 §3「数据面
 * 白名单扩张」**。按 **DL-37**：门禁基线的允准清单必须与变更单签字状态同步 —— 签字前不得把
 * 其新增物加进基线（否则等于用基线"预先放行"未签字的扩张 = 绕过门禁）；**签字后须同轮更新基线**。
 *
 * **授权来源（签字时点）**：`C-68` 签认卡 **`A-1` · 2026-10-17 11:47** · 结论 = **部分批准**
 *   - ① `ct.reportSalt` **有条件同意** · ② `ct.reportAgg` **有条件同意** · ③ `telemetryOptOut` 有条件同意（默认值归法务 `B-1`）· **④ 出机通道 不同意（现状不批准）**
 *   - **性质 = 事后追认（ratification）**：①②③ 三键在签字前已在码并在运行。
 *   - **④ 的前置**：任何 `REPORT.ENABLED → true` / `ENDPOINT` 改非本机 / 放宽 `hostIsLocal` 的改动
 *     ⇒ 须**另立变更单 ＋ `B-2`/`B-3` 闭合 ＋ CTO 重签**。
 *
 * ⚠️ 本清单**只**按 §3 白名单收录 **①②**（③ 落 settings 不属 `CT.STORAGE`；
 *    ④ 未被批准 ⇒ 不得据此放宽任何出机相关断言）。**不得**为"变绿"再加收白名单。 */
const B2_ALLOWED_NEW = ['ct.corrStats', 'ct.capNoticeSeen', 'ct.reportSalt', 'ct.reportAgg'];

section('一、静态 · 常量与存储键注册表');
{
  const ds = CT0.DEFAULT_SETTINGS || {};
  ok('CT.DEFAULT_SETTINGS 不含 corrStats', !('corrStats' in ds));
  ok('CT.DEFAULT_SETTINGS 不含 capNoticeSeen', !('capNoticeSeen' in ds));
  // settings 内不得出现任何 local 键名
  ok('CT.DEFAULT_SETTINGS 不含任何 local 键名字面量',
    !('ct.corrStats' in ds) && !('ct.capNoticeSeen' in ds));

  const storageVals = Object.keys(CT0.STORAGE || {}).map((k) => CT0.STORAGE[k]);
  const added = storageVals.filter((v) => PRE_B2_STORAGE_VALUES.indexOf(v) < 0);
  /* 以下 2 条**已由 `A-1`（2026-10-17 11:47 · 部分批准）解除预期红**：
   * 签字前保留红、不得提前放宽基线；**签字后同轮更新基线**（已执行）。详见 `DL-37`
   * 与本文件 `B2_ALLOWED_NEW` 上方注释。**第二条断言用集合相等、不写死长度**。 */
  ok('CT.STORAGE 相对 B2 前基线无未授权新增键', added.every((v) => B2_ALLOWED_NEW.indexOf(v) >= 0),
    '未授权新增 = ' + JSON.stringify(added.filter((v) => B2_ALLOWED_NEW.indexOf(v) < 0)));
  ok('CT.STORAGE 新增项集合恰为允准清单（集合相等 · 不写死长度）',
    added.length === B2_ALLOWED_NEW.length && B2_ALLOWED_NEW.every((v) => added.indexOf(v) >= 0),
    '实际新增 = ' + JSON.stringify(added));
  eq('CT.STORAGE.CORR_STATS 字面量', CT0.STORAGE.CORR_STATS, 'ct.corrStats');
  eq('CT.STORAGE.CAP_NOTICE 字面量', CT0.STORAGE.CAP_NOTICE, 'ct.capNoticeSeen');

  // 学习参数集中定义（CTO §4④）
  const L = CT0.LEARNING || {};
  eq('CT.LEARNING.THRESHOLD', L.THRESHOLD, 3);
  eq('CT.LEARNING.STATS_MAX', L.STATS_MAX, 200);
  eq('CT.LEARNING.TGT', L.TGT, 'zh-CN');
}

/* ================================================================== */
/* 二、动态：mock chrome + 真 worker                                     */
/* ================================================================== */

const store = { sync: {}, local: {} };
const writeLog = { sync: [], local: [] };

function pick(s, keys) {
  if (keys === null || keys === undefined) return Object.assign({}, s);
  if (typeof keys === 'string') return (keys in s) ? { [keys]: s[keys] } : {};
  if (Array.isArray(keys)) {
    const o = {};
    for (const k of keys) if (k in s) o[k] = s[k];
    return o;
  }
  return {};
}
function rm(s, keys) { for (const k of [].concat(keys)) delete s[k]; }

const listeners = {};
let badgeTextCalls = 0;

globalThis.self = globalThis;
globalThis.addEventListener = () => {};
globalThis.skipWaiting = async () => {};
globalThis.clients = { claim: async () => {} };
globalThis.chrome = {
  storage: {
    sync: {
      get: async (keys) => pick(store.sync, keys),
      set: async (o) => { for (const k of Object.keys(o)) store.sync[k] = o[k]; writeLog.sync.push(Object.keys(o)); },
      remove: async (k) => rm(store.sync, k)
    },
    local: {
      get: async (keys) => pick(store.local, keys),
      set: async (o) => { for (const k of Object.keys(o)) store.local[k] = o[k]; writeLog.local.push(Object.keys(o)); },
      remove: async (k) => rm(store.local, k)
    }
  },
  tabs: {
    onRemoved: { addListener(fn) { listeners.tabRemoved = fn; } },
    onUpdated: { addListener(fn) { listeners.tabUpdated = fn; } },
    query: async () => [],
    sendMessage: async () => ({ ok: true }),
    create: async () => ({ id: 99 })
  },
  action: {
    setBadgeBackgroundColor: () => {},
    setBadgeText: () => { badgeTextCalls++; }
  },
  contextMenus: { removeAll: () => {}, create: () => {}, onClicked: { addListener() {} } },
  commands: { onCommand: { addListener() {} } },
  scripting: { executeScript: async () => {}, insertCSS: async () => {} },
  declarativeNetRequest: { updateDynamicRules: async () => {}, getDynamicRules: async () => [] },
  runtime: {
    onMessage: { addListener: (fn) => { listeners.msg = fn; } },
    onInstalled: { addListener: (fn) => { listeners.installed = fn; } },
    onSuspend: { addListener() {} },
    getURL: (p) => p,
    openOptionsPage: async () => {},
    lastError: null
  }
};
globalThis.Translator = { availability: async () => 'unavailable', create: async () => ({ translate: async (t) => t }) };
globalThis.fetch = async () => { throw new Error('probe: 网络不应被调用'); };

function send(msg, sender) {
  return new Promise((resolve) => listeners.msg(msg, sender || { tab: { id: 7 } }, resolve));
}

const ALLOWED_LOCAL = new Set(Object.keys(CT0.STORAGE).map((k) => CT0.STORAGE[k]));
function localKeysOutsideRegistry() {
  return Object.keys(store.local).filter((k) => !(ALLOWED_LOCAL.has(k) || k.indexOf('tc:') === 0));
}

section('二、动态 · 键集合与落点');
const mod = await import('../background/service-worker.js');
void mod;
await new Promise((r) => setTimeout(r, 60));   // 等 loadSettings / report.startup 落定

{
  // --- C1：纠错提交 3 次（候选级计数）---
  const cand = { from: 'Apply', to: '申请', prev: '应用', tgt: 'zh-CN' };
  const r1 = await send({ type: 'ct:save-correction', ...cand }, { tab: { id: 101 } });
  const r2 = await send({ type: 'ct:save-correction', ...cand }, { tab: { id: 101 } });
  const r3 = await send({ type: 'ct:save-correction', ...cand }, { tab: { id: 101 } });

  eq('SAVE_CORRECTION 返回 ok', !!(r1 && r1.ok), true);
  ok('第 1 次无 suggestion', !(r1 && r1.suggestion));
  ok('第 2 次无 suggestion', !(r2 && r2.suggestion));
  ok('第 3 次出现 suggestion', !!(r3 && r3.suggestion));

  const stats = store.local[CT0.STORAGE.CORR_STATS];
  ok('计数落 local[ct.corrStats]', !!stats && typeof stats === 'object');
  const key = 'apply|申请|zh-CN';
  ok('计数键落在候选级（' + key + '）', !!(stats && stats[key]));
  eq('第 3 次后 n = 3', stats && stats[key] ? stats[key].n : null, 3);
  if (r3 && r3.suggestion) {
    eq('suggestion.from = 候选源词', r3.suggestion.from, 'Apply');
    eq('suggestion.to = 候选译名', r3.suggestion.to, '申请');
    eq('suggestion.n = 3', r3.suggestion.n, 3);
  }

  // --- C2：settings（sync）永不出现 corrStats ---
  const syncSettings = store.sync.settings || {};
  ok('sync.settings 无 corrStats 字段', !('corrStats' in syncSettings));
  ok('sync.settings 序列化后不含 "corrStats"', JSON.stringify(syncSettings).indexOf('corrStats') < 0);

  // --- C3：纠错提交对 sync 只写 settings；对 local 只写注册表内键 ---
  const syncKeyUnion = new Set();
  for (const keys of writeLog.sync) for (const k of keys) syncKeyUnion.add(k);
  ok('sync 写入顶层键不含 ct.corrStats', !syncKeyUnion.has(CT0.STORAGE.CORR_STATS));
  ok('local 写入顶层键无 "settings"（计数未走 local 设置回退）',
    !writeLog.local.some((keys) => keys.indexOf('settings') >= 0));

  const outside = localKeysOutsideRegistry();
  ok('local 观测键 ⊆ Object.values(CT.STORAGE) ∪ {tc:*}', outside.length === 0,
    '越界键 = ' + JSON.stringify(outside));

  // --- D：LEARN_PATTERN 落库条目形状 ---
  const lr = await send({ type: 'ct:learn-pattern', from: 'Apply', to: '申请', tgt: 'zh-CN' }, { tab: { id: 101 } });
  eq('LEARN_PATTERN 返回 ok', !!(lr && lr.ok), true);
  const gl = (store.sync.settings && store.sync.settings.glossary) || [];
  const entry = gl.find((e) => e && e.from === 'Apply');
  ok('学得条目已入 glossary', !!entry);
  if (entry) {
    const ek = Object.keys(entry).sort();
    ok('学得条目 keys 严格 == [from,to]（无 tgt/来源/dismissed）',
      ek.length === 2 && ek[0] === 'from' && ek[1] === 'to',
      '实际 keys = ' + JSON.stringify(Object.keys(entry)));
  }
  ok('入典后 sync.settings 仍无 corrStats 字段', !('corrStats' in (store.sync.settings || {})));
  const outside2 = localKeysOutsideRegistry();
  ok('入典后 local 观测键仍 ⊆ 注册表 ∪ {tc:*}', outside2.length === 0, JSON.stringify(outside2));

  // --- 附加：dismissed 只落 corrStats，不落 glossary 条目 ---
  await send({ type: 'ct:dismiss-pattern', from: 'Apply', to: '申请', tgt: 'zh-CN' }, { tab: { id: 101 } });
  const st2 = store.local[CT0.STORAGE.CORR_STATS] || {};
  ok('DISMISS 后 corrStats 键 dismissed=true', !!(st2[key] && st2[key].dismissed === true));
  const entry2 = ((store.sync.settings && store.sync.settings.glossary) || []).find((e) => e && e.from === 'Apply');
  ok('DISMISS 不改 glossary 条目字段', entry2 && Object.keys(entry2).length === 2);
}

section('E、SPAN_MAX 溢出 · 放弃建键（绝不截断）');
{
  // 构造真实 G2 命中路径：中文 diff 需 ≥2 字（G1 阈值），故用「甲乙丙丁 → 甲乙戊己」
  // 得 removed='丙丁'、added='戊己'；术语表注入「超长源词 + 译法锚 '丙丁译文'」，
  // 使 R='丙丁' 能反查回超长源词 → 命中后应在建键前被 SPAN_MAX 拦下。
  const LONG = 'a'.repeat(45);
  const PREV = '甲乙丙丁';
  const NEWT = '甲乙戊己';
  store.sync.settings.glossary = (store.sync.settings.glossary || []).slice();
  store.sync.settings.glossary.push({ from: LONG, to: '丙丁译文' });

  const before = Object.keys(store.local[CT0.STORAGE.CORR_STATS] || {}).length;
  const ov = await send(
    { type: 'ct:save-correction', from: LONG, to: NEWT, prev: PREV, tgt: 'zh-CN' },
    { tab: { id: 101 } }
  );
  ok('溢出提交仍返回 ok', !!(ov && ov.ok));
  ok('超 SPAN_MAX 候选无 suggestion', !(ov && ov.suggestion));
  const after = Object.keys(store.local[CT0.STORAGE.CORR_STATS] || {}).length;
  eq('超 SPAN_MAX 候选不新增 corrStats 键', after, before);
  ok('corrStats 无截断键（不存在以超长源词前缀开头的键）',
    Object.keys(store.local[CT0.STORAGE.CORR_STATS] || {}).every((k) => k.indexOf(LONG.slice(0, 40)) < 0));

  // 对照：同结构但短源词（≤40）应正常建键 → 证明上面的 NULL 确由 SPAN_MAX 触发，而非恒 NULL
  const SHORT = 'bbbbbbbbbb'; // 10 字符
  store.sync.settings.glossary.push({ from: SHORT, to: '丙丁译文' });
  await send(
    { type: 'ct:save-correction', from: SHORT, to: NEWT, prev: PREV, tgt: 'zh-CN' },
    { tab: { id: 101 } }
  );
  const after2 = Object.keys(store.local[CT0.STORAGE.CORR_STATS] || {}).length;
  eq('对照：短源词候选正常建键（+1）', after2, after + 1);
}

section('F、B1（DL-36 方案②′）· corrStats 条目的 learned 来源标记');
{
  /* 与 section C1 同构：3 次候选级纠错达阈值 → suggestion；再 LEARN_PATTERN 学得。
   * 断言的是**置位点语义**：learned 只在「学得落库成功之后」置位、拒绝路径不置位。 */
  store.local[CT0.STORAGE.CORR_STATS] = {};

  // --- F①：学得成功 → learned=true（且学得前不为 true）---
  const LF = { from: 'Deploy', to: '上线', prev: '部署', tgt: 'zh-CN' };
  const kLF = 'deploy|上线|zh-CN';
  const f1 = await send({ type: 'ct:save-correction', ...LF }, { tab: { id: 201 } });
  const f2 = await send({ type: 'ct:save-correction', ...LF }, { tab: { id: 201 } });
  const f3 = await send({ type: 'ct:save-correction', ...LF }, { tab: { id: 201 } });
  ok('F 前置：第 3 次达阈值回带 suggestion', !!(f1 && f2 && f3 && f3.suggestion),
    JSON.stringify(f3 && f3.suggestion));
  const stPre = (store.local[CT0.STORAGE.CORR_STATS] || {})[kLF];
  ok('F① 学得前 corrStats 条目不携带 learned（真值非 true）', !(stPre && stPre.learned === true),
    JSON.stringify(stPre));

  const lr = await send({ type: 'ct:learn-pattern', from: 'Deploy', to: '上线', tgt: 'zh-CN' }, { tab: { id: 201 } });
  ok('F 前置：LEARN_PATTERN 返回 ok', !!(lr && lr.ok), JSON.stringify(lr));
  const stPost = (store.local[CT0.STORAGE.CORR_STATS] || {})[kLF];
  ok('F① 学得成功 → corrStats[key].learned === true（置位点=落库之后）',
    !!(stPost && stPost.learned === true), JSON.stringify(stPost));

  // --- F④：来源不进 glossary 条目；只落 local corrStats ---
  const glF = ((store.sync.settings && store.sync.settings.glossary) || []).find((e) => e && e.from === 'Deploy');
  ok('F④ 学得条目仍严格 [\'from\',\'to\']（来源标记不进 glossary，守 CTO §7.4）',
    !!glF && JSON.stringify(Object.keys(glF).sort()) === JSON.stringify(['from', 'to']),
    glF ? JSON.stringify(Object.keys(glF)) : 'no entry');
  ok('F④ learned 只落 local[ct.corrStats]；sync.settings 全文无 "learned"',
    JSON.stringify(store.sync.settings || {}).indexOf('learned') < 0);

  // --- F② 假阳性用例（最关键）：达阈值 → 点「不用了」→ 再手填同 (from,to) ---
  const MF = { from: 'Latency', to: '滞后', prev: '延迟', tgt: 'zh-CN' };
  const kMF = 'latency|滞后|zh-CN';
  await send({ type: 'ct:save-correction', ...MF }, { tab: { id: 202 } });
  await send({ type: 'ct:save-correction', ...MF }, { tab: { id: 202 } });
  await send({ type: 'ct:save-correction', ...MF }, { tab: { id: 202 } });
  const dBefore = (store.local[CT0.STORAGE.CORR_STATS] || {})[kMF];
  ok('F② 前置：Latency 达阈值（learned 仍非 true）', !(dBefore && dBefore.learned === true),
    JSON.stringify(dBefore));

  await send({ type: 'ct:dismiss-pattern', from: 'Latency', to: '滞后', tgt: 'zh-CN' }, { tab: { id: 202 } });
  const dSt = (store.local[CT0.STORAGE.CORR_STATS] || {})[kMF];
  ok('F② 拒绝路径：只写 dismissed、**不写 learned**（拒绝≠学过）',
    !!(dSt && dSt.dismissed === true) && dSt.learned !== true, JSON.stringify(dSt));

  // 手填同 (from,to)：用户经设置页写入 glossary（sync），**不得**因此把 corrStats 标 learned
  const glNow = ((store.sync.settings && store.sync.settings.glossary) || []).slice();
  await send({ type: 'ct:set-settings', patch: { glossary: glNow.concat([{ from: 'Latency', to: '滞后' }]) } },
    { tab: { id: 202 } });
  const dSt2 = (store.local[CT0.STORAGE.CORR_STATS] || {})[kMF];
  ok('F② 假阳性判据：dismiss 后手填同词 → learned 仍非 true（options 侧不会标「自动」）',
    !(dSt2 && dSt2.learned === true), JSON.stringify(dSt2));

  // --- F⑤：清空 corrStats ⇒ 读取侧索引空 ⇒ 静默不标（来源确实源自 corrStats）---
  const learnedKeysBefore = Object.keys(store.local[CT0.STORAGE.CORR_STATS] || {})
    .filter((k) => (store.local[CT0.STORAGE.CORR_STATS][k] || {}).learned === true);
  ok('F⑤ 前置：清空前存在 learned===true 的条目', learnedKeysBefore.length >= 1,
    JSON.stringify(learnedKeysBefore));
  store.local[CT0.STORAGE.CORR_STATS] = {};
  const learnedKeysAfter = Object.keys(store.local[CT0.STORAGE.CORR_STATS] || {})
    .filter((k) => (store.local[CT0.STORAGE.CORR_STATS][k] || {}).learned === true);
  ok('F⑤ 清空 ct.corrStats 后 learned 条目数 = 0（标记来源确为 corrStats）',
    learnedKeysAfter.length === 0, 'after=' + learnedKeysAfter.length);
}

section('G、A③-补（层 1 · 填既有契约）· correction_submit.reachedThreshold 补填 + learn_drop 复用');
{
  /* 观测面 = report.js 的本地聚合落盘 `ct.reportAgg`（record 去抖 1000ms ⇒ 等 1.4s）。
   * ⚠ report.js 的 agg 是**进程内存**（`delete store.local[key]` 清不掉）⇒ 本段一律用
   * **快照差分**（按键 cnt 增量）取「本步新产生的 cell」，避免被前面 section 的 cell 污染。
   * 两键**均已在既有白名单**（`report.js:90` / `:93`），本段断言「值确被发出」而非「新增字段」。 */
  const snap = () => {
    const agg = store.local[CT0.STORAGE.REPORT_AGG] || {};
    const cells = agg.cells || {};
    const out = {};
    for (const k of Object.keys(cells)) out[k] = { ev: cells[k].ev, props: cells[k].props, cnt: cells[k].cnt };
    return out;
  };
  const delta = (before, after) => {
    const d = [];
    for (const k of Object.keys(after)) {
      const b = before[k] ? before[k].cnt : 0;
      if (after[k].cnt > b) d.push(after[k]);
    }
    return d;
  };
  const propsKeys = (p) => JSON.stringify(Object.keys(p || {}).sort());

  // --- G①：G4 放弃路径 → learn_drop 发出 + correction_submit.reachedThreshold=false ---
  // 造必然无候选的提交：from 是**带句末标点的整句**（G3 术语样单元判据不通过），
  // 且无 glossary「已知译法」可反查（G2 不命中）⇒ deriveLearnCandidate = null。
  const g4msg = {
    from: 'The quick brown fox jumps over the lazy dog.',
    to: '敏捷狐狸。', prev: '敏捷的狐狸。', tgt: 'zh-CN'
  };
  const before1 = snap();
  const g4 = await send({ type: 'ct:save-correction', ...g4msg }, { tab: { id: 301 } });
  ok('G① 前置：G4 提交返回 ok 且无 suggestion', !!(g4 && g4.ok) && !g4.suggestion, JSON.stringify(g4));

  await new Promise((r) => setTimeout(r, 1400));   // 等 record 去抖落盘（1000ms）
  const d1 = delta(before1, snap());
  const dropCells = d1.filter((c) => c.ev === 'learn_drop');
  ok('G① learn_drop 已真实发出（此前全仓 0 处 record 调用）', dropCells.length >= 1,
    'deltaEv=' + JSON.stringify(d1.map((c) => c.ev)));
  ok('G① learn_drop.props 键 ⊆ 白名单 {reason,langPair,countBucket}（零新增字段 / 零内容面）',
    dropCells.length >= 1 && dropCells.every((c) => propsKeys(c.props) === JSON.stringify(['countBucket', 'langPair', 'reason'])),
    JSON.stringify(dropCells.map((c) => c.props)));
  ok('G① learn_drop.props.reason = g4_no_candidate',
    dropCells.some((c) => c.props && c.props.reason === 'g4_no_candidate'),
    JSON.stringify(dropCells.map((c) => c.props)));
  const g4Sub = d1.filter((c) => c.ev === 'correction_submit' && c.props && c.props.candFound === false);
  ok('G① G4 的 correction_submit 补填 reachedThreshold=false（布尔）',
    g4Sub.length >= 1 && g4Sub.every((c) => c.props.reachedThreshold === false),
    JSON.stringify(g4Sub.map((c) => c.props)));

  // --- G②：达阈值路径 → reachedThreshold 随计数翻转（1/2 次 false、第 3 次 true）---
  // 用**全新候选**（避免本进程内前序 section 的 SW 内存 corrStats 缓存/`dismissed` 干扰）。
  // 形态要点（对齐 section C1 可达性）：`prev`/`to` 取**两个全异的中文字**（R/A 各 2 字，
  // 过 `extractTargetSpan` 的 `sideOk` 单侧 ≥2 阈值）；`from` 是单词术语样单元（G3 可达）。
  const candF = { from: 'Freshtok', to: '新词', prev: '旧译', tgt: 'zh-CN' };
  const before2 = snap();
  const a1 = await send({ type: 'ct:save-correction', ...candF }, { tab: { id: 302 } });
  const a2 = await send({ type: 'ct:save-correction', ...candF }, { tab: { id: 302 } });
  const a3 = await send({ type: 'ct:save-correction', ...candF }, { tab: { id: 302 } });
  const stF = (store.local[CT0.STORAGE.CORR_STATS] || {})['freshtok|新词|zh-CN'];
  ok('G② 前置：第 1/2 次无 suggestion、第 3 次有 suggestion（达阈值）',
    !a1.suggestion && !a2.suggestion && !!a3.suggestion,
    JSON.stringify([!!a1.suggestion, !!a2.suggestion, !!a3.suggestion]) + ' n=' + (stF ? stF.n : null));
  await new Promise((r) => setTimeout(r, 1400));
  const d2 = delta(before2, snap());
  const subCells = d2.filter((c) => c.ev === 'correction_submit');
  const rtTrue = subCells.filter((c) => c.props && c.props.reachedThreshold === true);
  const rtFalse = subCells.filter((c) => c.props && c.props.reachedThreshold === false);
  ok('G② reachedThreshold 出现 true（第 3 次达阈值 ⇒ K1 真分母近似）', rtTrue.length >= 1,
    JSON.stringify(subCells.map((c) => c.props.reachedThreshold)));
  ok('G② 前两次为 false（未达阈值）', rtFalse.length >= 1,
    JSON.stringify(subCells.map((c) => c.props.reachedThreshold)));
  ok('G② correction_submit.props 键 ⊆ 白名单（含 reachedThreshold，零内容面）',
    subCells.length >= 1 && subCells.every((c) => Object.keys(c.props || {}).every((k) =>
      ['langPair', 'changed', 'candFound', 'dropReason', 'isNewCand', 'countBucket', 'reachedThreshold'].indexOf(k) >= 0)),
    JSON.stringify(subCells.map((c) => c.props)));
  ok('G② 达阈值路径未新增 learn_drop cell（learn_drop 只对应放弃）',
    d2.filter((c) => c.ev === 'learn_drop').length === 0,
    JSON.stringify(d2.filter((c) => c.ev === 'learn_drop').map((c) => c.props)));
}

/* ================================================================== */
console.log('\n————————————');
console.log('通过 ' + passed + ' 项；跳过 ' + skipped + ' 项；失败 ' + failures.length + ' 项');
if (failures.length) { console.log('失败项：'); for (const f of failures) console.log('  - ' + f); }
process.exit(failures.length ? 1 : 0);
