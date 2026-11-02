/*
 * 叠译 · 匿名埋点单元测试（B2 双通道，v1.8.0 免费版）
 * ==================================================================
 * 覆盖：
 *   ① 帧封套白名单（无 anon/day/事件级 at）+ install 不进帧（只走通道 B）
 *   ② 日批封套（无 tok/win，禁 online，props 无 count）+ install.props.ver
 *   ③ 帧 props 仅 count
 *   ④ online 每帧恰好 1 条且 props={}
 *   ⑤ 域分离（同 salt 下 tok≠anon，域标签为常量且生效）
 *   ⑥ 零出站守卫：总闸关 / 非白名单 host / 退出 三种情形都不发 fetch
 *   ⑦ 退出后清空 reportAgg + 删除 reportSalt
 *   ⑧ 断网/超时不影响主路径（record 不抛 / flushNow 不抛）
 *   ⑨ 退出即时性：出站前复读退出开关 → 已入队批次被丢弃
 *   ⑩ install 事件：只保留 3 类事件、props.ver 正确、幂等（同实例 + 跨实例）
 *
 * 运行：node tools/test-report.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));

let passed = 0;
const failures = [];
function ok(label, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failures.push(label); console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
function eq(label, actual, expected) {
  ok(label + '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）', actual === expected);
}
function section(t) { console.log('\n' + t); }

/* ================================================================== */
/* 桩：self / chrome.storage / fetch                                    */
/* ================================================================== */
globalThis.self = globalThis;

const localStore = new Map();
let syncSettings = {};
const syncSetCalls = [];      // 记录每次 sync.set 的载荷（校验 ct.did 绝不进 sync）
let fetchCalls = [];

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, init });
  return { ok: true, status: 202, headers: { get: () => null } };
};

globalThis.chrome = {
  runtime: { getManifest: () => ({ version: '1.8.0' }) },
  storage: {
    sync: {
      get: async () => ({ settings: syncSettings }),
      set: async (o) => { syncSetCalls.push(o); if (o && o.settings) syncSettings = o.settings; }
    },
    local: {
      get: async (k) => {
        const keys = Array.isArray(k) ? k : [k];
        const out = {};
        for (const kk of keys) if (localStore.has(kk)) out[kk] = localStore.get(kk);
        return out;
      },
      set: async (o) => { for (const k of Object.keys(o)) localStore.set(k, o[k]); },
      remove: async (k) => { const keys = Array.isArray(k) ? k : [k]; for (const kk of keys) localStore.delete(kk); }
    }
  }
};

// 先加载 constants（挂 self.CT），再加载 report.js（其顶层读 self.CT）
await import('../shared/constants.js');
const R = await import('../background/report.js');
const CT = self.CT;
const I = R._internals;
const SALT_KEY = CT.STORAGE.REPORT_SALT;
const AGG_KEY = CT.STORAGE.REPORT_AGG;
const INSTALL_KEY = CT.STORAGE.INSTALL_REPORTED;

const BID = '11111111-1111-4111-8111-111111111111';
function keysOf(o) { return Object.keys(o || {}); }
function sameKeys(a, b) { return a.length === b.length && a.every((k, i) => k === b[i]); }
const tick = () => new Promise((r) => setTimeout(r, 30));

/* 造一条真实的待发日批：record 产生 cell → enqueueDailyFor 组批入队。
 * v1.8.0 起 startup 不再自动入队 canary，因此"有无待发批次"必须显式造。 */
async function seedDaily() {
  R.record('translate_round', { units: 1, langPair: 'en>zh-CN', provider: 'google-free' });
  const st = R._internals.getState();
  R._internals.enqueueDailyFor(st.agg.day, st.agg);
  await tick();
}

/* 统一：把总闸/端点/白名单恢复到产品默认值 */
function restoreReportConsts(saved) {
  CT.REPORT.ENABLED = saved.ENABLED;
  CT.REPORT.ENDPOINT = saved.ENDPOINT;
  CT.REPORT.ALLOWED_HOSTS = saved.ALLOWED_HOSTS;
}
function saveReportConsts() {
  return {
    ENABLED: CT.REPORT.ENABLED,
    ENDPOINT: CT.REPORT.ENDPOINT,
    ALLOWED_HOSTS: CT.REPORT.ALLOWED_HOSTS
  };
}
const DEFAULTS = saveReportConsts();

/* ================================================================== */
section('⓪ 事件枚举收敛为 3 类（install / translate_round / online）');
{
  eq('EV 键数', keysOf(I.EV).length, 3);
  eq('EV.INSTALL', I.EV.INSTALL, 'install');
  eq('EV.TRANSLATE_ROUND', I.EV.TRANSLATE_ROUND, 'translate_round');
  eq('EV.ONLINE', I.EV.ONLINE, 'online');
  const removed = ['correction_submit', 'learn_confirm', 'learn_dismiss', 'learn_drop',
    'engine_degrade', 'trial_state', 'activation', 'cap_notice_shown',
    'provider_probe', 'frame_budget_skip', 'canary'];
  ok('已删除的 11 类事件不再出现在 EV_SET', removed.every((e) => !I.EV_SET.has(e)),
    JSON.stringify(removed.filter((e) => I.EV_SET.has(e))));
  ok('PROP_WHITELIST 只含 3 类事件的键（online 无 props）',
    sameKeys(keysOf(I.PROP_WHITELIST).sort(), ['install', 'translate_round']),
    JSON.stringify(keysOf(I.PROP_WHITELIST)));
  ok('install 白名单只有 ver', sameKeys(I.PROP_WHITELIST.install, ['ver']));
}

/* ================================================================== */
section('① 帧封套白名单（无 anon/day/事件级 at）+ install 不进帧');
{
  const f = I.buildFrame({
    bid: BID, win: 1697202900000, tok: '3a7f0c19',
    counts: { translate_round: 37, install: 4, online: 99 }
  });
  ok('帧顶层键 === {v,kind,bid,ext,prod,win,tok,events}（顺序一致）',
    sameKeys(keysOf(f), I.FRAME_KEYS), JSON.stringify(keysOf(f)));
  ok('帧封套不含 anon', !('anon' in f));
  ok('帧封套不含 day', !('day' in f));
  ok('帧封套不含事件级 at（全串扫描）', !/"at"\s*:/.test(JSON.stringify(f)));
  ok('帧 v === 2 且 kind === "frame"', f.v === 2 && f.kind === 'frame');
  ok('帧顶层键 ⊆ 契约白名单', keysOf(f).every((k) => I.FRAME_KEYS.indexOf(k) >= 0));
  ok('帧事件项键 ⊆ {ev,props}',
    f.events.every((e) => keysOf(e).every((k) => k === 'ev' || k === 'props')));
  ok('install 不进通道 A（即使 counts 里塞了）',
    !f.events.some((e) => e.ev === 'install'), JSON.stringify(f.events.map((e) => e.ev)));
}

/* ================================================================== */
section('② 日批封套（无 tok/win，禁 online，props 无 count）+ install.props.ver');
{
  const d = I.buildDaily({
    bid: BID, anon: '9f2a1c07', day: '2026-10-13',
    events: [
      { ev: 'translate_round', props: { langPair: 'en>zh-CN', provider: 'chrome-builtin' } },
      { ev: 'install', props: { ver: '1.8.0', rogue: 'must-be-dropped' } },
      { ev: 'online', props: {} }                    // 蓄意：必须被丢弃
    ]
  });
  ok('日批顶层键 === {v,kind,bid,anon,day,ext,prod,events}（顺序一致）',
    sameKeys(keysOf(d), I.DAILY_KEYS), JSON.stringify(keysOf(d)));
  ok('日批封套不含 tok', !('tok' in d));
  ok('日批封套不含 win', !('win' in d));
  ok('日批封套不含事件级 at', !/"at"\s*:/.test(JSON.stringify(d)));
  ok('日批 v === 2 且 kind === "daily"', d.v === 2 && d.kind === 'daily');
  ok('日批禁出现 online（蓄意塞入已被丢弃）',
    !d.events.some((e) => e.ev === 'online'), JSON.stringify(d.events.map((e) => e.ev)));
  ok('日批 events[].props 不含 count',
    d.events.every((e) => !('count' in (e.props || {}))), JSON.stringify(d.events));
  const inst = d.events.find((e) => e.ev === 'install');
  ok('日批含 install 且 props.ver="1.8.0"', !!inst && inst.props.ver === '1.8.0', JSON.stringify(inst));
  ok('install 白名单外的键被丢弃（rogue 不入信封）', !!inst && !('rogue' in inst.props), JSON.stringify(inst && inst.props));
}

/* ================================================================== */
section('③ 帧 props 仅允许 count');
{
  const f = I.buildFrame({
    bid: BID, win: 1, tok: 'x',
    counts: { translate_round: 5, install: 2, online: 1 }
  });
  const nonOnline = f.events.filter((e) => e.ev !== 'online');
  ok('帧非 online 事件 props 仅 {count}',
    nonOnline.every((e) => sameKeys(keysOf(e.props), ['count'])), JSON.stringify(nonOnline));
  ok('帧 count 为 ≥1 的整数',
    nonOnline.every((e) => Number.isInteger(e.props.count) && e.props.count >= 1));
  const it = I.frameEventItem('translate_round', 0);
  ok('frameEventItem 对非法 count 归一为 1', it.props.count === 1 && sameKeys(keysOf(it.props), ['count']));
}

/* ================================================================== */
section('④ online 每帧恰好 1 条且 props 恒 {}');
{
  const a = I.buildFrame({ bid: BID, win: 1, tok: 'x', counts: { translate_round: 3 } });
  const b = I.buildFrame({ bid: BID, win: 1, tok: 'x', counts: { translate_round: 3, online: 7 } });
  for (const [name, f] of [['未预置 online', a], ['已预置 online', b]]) {
    const onl = f.events.filter((e) => e.ev === 'online');
    eq(name + '：online 恰好 1 条', onl.length, 1);
    ok(name + '：online.props 恒 {}', sameKeys(keysOf(onl[0].props), []));
  }
}

/* ================================================================== */
section('⑤ 域分离（同 salt 下 tok≠anon，域标签为常量且生效）');
{
  const salt = I.randomSalt();
  eq('installSalt 为 32 字节', salt.length, 32);
  eq('域标签 DOMAIN_TOK 为常量 "w:"', I.DOMAIN_TOK, 'w:');
  eq('域标签 DOMAIN_ANON 为常量 "d:"', I.DOMAIN_ANON, 'd:');

  const win = 1697202900000;
  const day = '2026-10-13';
  const t = await I.deriveTok(salt, win);
  const a = await I.deriveAnon(salt, day);
  ok('tok 为 8 位 hex', /^[0-9a-f]{8}$/.test(String(t)), String(t));
  ok('anon 为 8 位 hex', /^[0-9a-f]{8}$/.test(String(a)), String(a));
  ok('同 salt 下 tok ≠ anon（域分离生效）', t !== a, t + ' vs ' + a);
  eq('tok === HMAC(salt, "w:"+win)', t, await I.hmac8(salt, 'w:' + win));
  eq('anon === HMAC(salt, "d:"+day)', a, await I.hmac8(salt, 'd:' + day));
  ok('同一输入不同标签 → 不同输出', (await I.hmac8(salt, 'w:1')) !== (await I.hmac8(salt, 'd:1')));
  ok('tok 逐窗轮换（不同 win → 不同 tok）',
    (await I.deriveTok(salt, win)) !== (await I.deriveTok(salt, win + CT.REPORT.FRAME_MS)));
}

/* ================================================================== */
section('⑥ 零出站守卫（总闸关 / 非白名单 host / 退出 → 均无 fetch）');
{
  ok('hostAllowed 对白名单外端点判 false', I.hostAllowed('https://api.example.com/x') === false);
  ok('hostAllowed 对 127.0.0.1 判 true', I.hostAllowed('http://127.0.0.1:7791/api') === true);
  ok('hostAllowed 对 localhost 判 true', I.hostAllowed('http://localhost:7791/api') === true);
  ok('hostAllowed 对 [::1] 判 true', I.hostAllowed('http://[::1]:7791/api') === true);
  ok('hostAllowed 对后缀伪装域名判 false（evil-127.0.0.1.com）',
    I.hostAllowed('http://evil-127.0.0.1.com/api') === false);

  // (a) 总闸关 + 白名单内 host → 不发
  CT.REPORT.ENABLED = false;
  CT.REPORT.ENDPOINT = 'http://127.0.0.1:7791/api';
  R._internals.reset(); localStore.clear(); fetchCalls = []; syncSettings = {};
  await R.startup();
  const before = fetchCalls.length;
  const ra = await R.flushNow();
  eq('总闸关闭时 flushNow 返回 skipped:gate-closed', ra && ra.skipped, 'gate-closed');
  eq('总闸关闭时无 fetch', fetchCalls.length, before);
  eq('总闸关闭时 outboundAllowed=false', I.outboundAllowed(), false);

  // (b) 总闸开但 host 不在白名单 → 不发
  CT.REPORT.ENABLED = true;
  CT.REPORT.ENDPOINT = 'https://telemetry.example.com/api';
  R._internals.reset(); localStore.clear(); fetchCalls = []; syncSettings = {};
  await R.startup();
  const rb = await R.flushNow();
  eq('非白名单 host → skipped:gate-closed', rb && rb.skipped, 'gate-closed');
  eq('非白名单 host → 无 fetch', fetchCalls.length, 0);
  eq('非白名单 host → outboundAllowed=false', I.outboundAllowed(), false);

  // (c) 总闸开 + 白名单 host，但用户已退出 → 不发（专属原因码 opt-out）
  CT.REPORT.ENDPOINT = 'http://127.0.0.1:7791/api';
  R._internals.reset(); localStore.clear(); fetchCalls = []; syncSettings = {};
  await R.startup();
  R.record('translate_round', { units: 1 });
  syncSettings = { telemetryOptOut: true };
  await R.applyOptOut(true);
  fetchCalls = [];
  const rc = await R.flushNow();
  eq('退出态 flushNow 返回 skipped:opt-out（专属原因码，同样零出站）', rc && rc.skipped, 'opt-out');
  eq('退出态无 fetch', fetchCalls.length, 0);
  eq('退出态 outboundAllowed=false', I.outboundAllowed(), false);

  // (d) 总闸开 + 白名单 host → 真正发送
  syncSettings = {};
  await R.applyOptOut(false);
  R._internals.reset(); localStore.clear(); fetchCalls = []; syncSettings = {};
  await R.startup();
  await seedDaily();
  await R.flushNow();
  ok('白名单 host + 总闸开 → 发出请求', fetchCalls.length >= 1, 'fetch=' + fetchCalls.length);
  if (fetchCalls[0]) {
    eq('请求 URL 为 dev 端点', fetchCalls[0].url, 'http://127.0.0.1:7791/api');
    eq('请求方法 POST', fetchCalls[0].init && fetchCalls[0].init.method, 'POST');
    ok('带 X-Dieyi-Client 头', !!(fetchCalls[0].init && fetchCalls[0].init.headers && fetchCalls[0].init.headers['X-Dieyi-Client']));
    ok('keepalive=true 且 credentials=omit',
      fetchCalls[0].init.keepalive === true && fetchCalls[0].init.credentials === 'omit');
  }

  restoreReportConsts(DEFAULTS);
}

/* ================================================================== */
section('⑦ 退出后清空 reportAgg + 删除 reportSalt');
{
  R._internals.reset(); localStore.clear(); fetchCalls = []; syncSettings = {};
  CT.REPORT.ENABLED = false;
  await R.startup();
  await seedDaily();

  ok('启用态：ct.reportSalt 已生成', localStore.has(SALT_KEY));

  syncSettings = { telemetryOptOut: true };
  await R.applyOptOut(true);

  eq('退出后 ct.reportSalt 被删除', localStore.has(SALT_KEY), false);
  const agg = localStore.get(AGG_KEY);
  ok('退出后 ct.reportAgg 被清空（cells 空 + queue 空）',
    !!agg && Object.keys(agg.cells || {}).length === 0 && (agg.queue || []).length === 0,
    JSON.stringify({ cells: Object.keys((agg && agg.cells) || {}).length, queue: ((agg && agg.queue) || []).length }));
  eq('退出状态快照 optOut=true', R.snapshot().optOut, true);

  // 退出后再启动 → 不得产生任何新批次
  R._internals.getState().loaded = false;
  fetchCalls = [];
  await R.startup();
  eq('退出后 startup 不产生新批次', R.snapshot().queue, 0);
  eq('退出后不再补发（无 fetch）', fetchCalls.length, 0);

  // 收尾：恢复正常
  await R.applyOptOut(false);
  R._internals.getState().loaded = false;
  restoreReportConsts(DEFAULTS);
}

/* ================================================================== */
section('⑧ 断网/超时不影响主路径（record 不抛 / flushNow 不抛）');
{
  CT.REPORT.ENABLED = true;
  CT.REPORT.ENDPOINT = 'http://127.0.0.1:7791/api';
  const savedTimeout = CT.REPORT.TIMEOUT_MS;

  // (a) 断网：fetch 直接 reject
  globalThis.fetch = async () => { fetchCalls.push({}); throw new Error('ECONNREFUSED'); };
  R._internals.reset(); localStore.clear(); fetchCalls = []; syncSettings = {};
  await R.startup();
  await seedDaily();
  fetchCalls = [];
  let threw = false;
  try { R.record('translate_round', { units: 1 }); } catch (e) { threw = true; }
  eq('断网时 record 不抛', threw, false);
  let res = null; threw = false;
  try { res = await R.flushNow(); } catch (e) { threw = true; }
  eq('断网时 flushNow 不抛', threw, false);
  ok('断网时 flushNow 返回对象（吞掉错误）', res && typeof res === 'object');
  ok('断网批次保留在队列内（等待退避）', R.snapshot().queue >= 1, 'queue=' + R.snapshot().queue);

  // (b) 超时：fetch 挂起，依赖 AbortSignal.timeout 到点中断
  CT.REPORT.TIMEOUT_MS = 40;
  globalThis.fetch = (url, init) => new Promise((_resolve, reject) => {
    fetchCalls.push({});
    if (init && init.signal) {
      init.signal.addEventListener('abort', () => reject(new Error('TimeoutError: aborted')));
    }
  });
  fetchCalls = [];
  const t0 = Date.now();
  let threw2 = false;
  try { await R.flushNow(); } catch (e) { threw2 = true; }
  const dt = Date.now() - t0;
  eq('超时时 flushNow 不抛', threw2, false);
  ok('超时被 AbortSignal 及时中断（<1500ms，实测 ' + dt + 'ms）', dt < 1500);
  ok('超时批次保留在队列内', R.snapshot().queue >= 1, 'queue=' + R.snapshot().queue);

  CT.REPORT.TIMEOUT_MS = savedTimeout;
  restoreReportConsts(DEFAULTS);
  globalThis.fetch = realFetch;
}

/* ================================================================== */
section('⑨ 退出即时性：出站前复读退出开关 → 已入队批次被丢弃（⑤ 压窗口）');
{
  // 恢复计数桩（⑧ 末尾换过 fetch）
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init });
    return { ok: true, status: 202, headers: { get: () => null } };
  };

  R._internals.reset(); localStore.clear(); fetchCalls = []; syncSettings = {};
  CT.REPORT.ENDPOINT = 'http://127.0.0.1:7791/api';
  CT.REPORT.ENABLED = true;

  // 手工装配「已入队、尚未发出」的批次（真实 enqueue 路径）
  const st = R._internals.getState();
  st.loaded = true; st.optOut = false;
  st.agg = R._internals.emptyAgg(Date.now());
  R._internals.enqueue('daily', {
    v: 2, kind: 'daily', bid: BID, anon: '00000000', day: '2026-10-13',
    ext: '1.8.0', prod: 'dieyi', events: [{ ev: 'install', props: { ver: '1.8.0' } }]
  });
  ok('前置：已入队 1 条待发批次（且总闸开）', R.snapshot().queue === 1 && I.outboundAllowed() === true,
    'queue=' + R.snapshot().queue + ' gate=' + I.outboundAllowed());

  // options 侧此刻把开关关掉（写 settings.sync），worker 尚未 startup
  syncSettings = { telemetryOptOut: true };
  fetchCalls = [];

  const res = await R.flushNow();
  eq('关掉开关后首次 flushNow 返回 skipped:opt-out', res && res.skipped, 'opt-out');
  eq('关掉开关后 flushNow 未发出任何请求', fetchCalls.length, 0);
  eq('退出语义即刻生效（snapshot.optOut=true）', R.snapshot().optOut, true);
  eq('退出后 ct.reportSalt 被删除', localStore.has(SALT_KEY), false);
  eq('退出后待发队列被清空', R.snapshot().queue, 0);

  // 再 flush 一次：仍不得补发
  fetchCalls = [];
  const res2 = await R.flushNow();
  eq('后续 flushNow 仍短路（skipped:opt-out）', res2 && res2.skipped, 'opt-out');
  eq('后续 flushNow 仍无 fetch', fetchCalls.length, 0);

  // 收尾
  syncSettings = {};
  await R.applyOptOut(false);
  R._internals.getState().loaded = false;
  restoreReportConsts(DEFAULTS);
}

/* ================================================================== */
section('⑩ install 事件：入队 + props.ver + 幂等（同实例 / 跨实例）');
{
  R._internals.reset(); localStore.clear(); fetchCalls = []; syncSettings = {};
  CT.REPORT.ENABLED = false;              // 本段只看入队，不需要真的出网
  CT.REPORT.ENDPOINT = 'http://127.0.0.1:7791/api';

  await R.startup();
  const r1 = await R.installOnce('1.8.0');
  ok('首次 installOnce 未被跳过', !r1.skipped, JSON.stringify(r1));
  eq('落幂等位 ct.installReported=true', localStore.get(INSTALL_KEY), true);
  await tick();

  const st = R._internals.getState();
  const installQueueItems = () => (st.agg.queue || []).filter((it) => (it.body.events || []).some((e) => e.ev === 'install'));
  ok('install 不进入帧计数（frameEv 里没有 install）', !st.agg.frameEv.install, JSON.stringify(st.agg.frameEv));

  // installOnce 内部**立即组批**（不依赖次日轮转）——这是「真的发出去了」的前提
  const daily = installQueueItems()[0];
  ok('install 立即进入通道 B 日批队列', !!daily, JSON.stringify((st.agg.queue || []).map((it) => it.kind)));
  const instEv = daily && daily.body.events.find((e) => e.ev === 'install');
  ok('日批内 install.props.ver 正确', !!instEv && instEv.props.ver === '1.8.0', JSON.stringify(instEv));
  ok('日批带 anon 与 day（通道 B 契约）', !!daily && !!daily.body.anon && !!daily.body.day,
    JSON.stringify(daily && { anon: daily.body.anon, day: daily.body.day }));
  ok('install 批次不含 online、不含通道 A 帧', !(st.agg.queue || []).some((it) => it.kind === 'frame'),
    JSON.stringify((st.agg.queue || []).map((it) => it.kind)));

  // 同实例第二次调用 —— 队列里不得多出第二条
  const r2 = await R.installOnce('1.8.0');
  eq('同实例重复调用 → skipped:already', r2.skipped, 'already');
  await tick();
  eq('重复调用后 install 批次仍为 1 条', installQueueItems().length, 1);

  // 跨实例（模拟浏览器重启：内存全清，local 保留）
  R._internals.reset(); localStore.delete(SALT_KEY); localStore.delete(AGG_KEY);
  syncSettings = {}; fetchCalls = [];
  await R.startup();
  const r3 = await R.installOnce('1.8.0');
  eq('跨实例重复调用（local 幂等位仍在）→ skipped:already', r3.skipped, 'already');
  await tick();
  const st3 = R._internals.getState();
  eq('跨实例后未新增 install 批次', (st3.agg.queue || []).length, 0);

  // 未安装过的新环境：应记录
  R._internals.reset(); localStore.clear(); syncSettings = {};
  await R.startup();
  const r4 = await R.installOnce('1.8.0');
  eq('全新环境首次调用无 skipped', r4.skipped, undefined);
  ok('全新环境写入幂等位', localStore.get(INSTALL_KEY) === true);

  restoreReportConsts(DEFAULTS);
}

/* ================================================================== */
section('⑪ did（安装期固定设备标识）');
{
  R._internals.reset(); localStore.clear(); syncSettings = {}; syncSetCalls.length = 0;
  CT.REPORT.ENABLED = false;
  await R.startup();

  const did1 = localStore.get(CT.STORAGE.DID);
  ok('首次 startup 生成 ct.did', typeof did1 === 'string' && did1.length > 0, String(did1));
  ok('did 是合法 UUIDv4',
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(did1)), String(did1));
  eq('内存镜像 state.did 与存储一致', I.getState().did, did1);

  const did2 = await I.loadDid(false);
  eq('再次读取（create=false）不重新生成', did2, did1);

  // 模拟 SW 重启：内存全清、local 保留
  R._internals.reset();
  await R.startup();
  eq('SW 重启后 ct.did 值不变', localStore.get(CT.STORAGE.DID), did1);
  eq('重启后内存镜像也恢复', I.getState().did, did1);

  // 信封顶层必须带 did，且常量键序与契约一致
  eq('FRAME_KEYS 第 4 位是 did', I.FRAME_KEYS[3], 'did');
  eq('DAILY_KEYS 第 4 位是 did', I.DAILY_KEYS[3], 'did');
  const f = I.buildFrame({ bid: BID, win: 1, tok: 'x', counts: { translate_round: 3 } });
  eq('帧封套顶层带 did（值 = ct.did）', f.did, did1);
  ok('帧封套键序 === FRAME_KEYS', sameKeys(keysOf(f), I.FRAME_KEYS), JSON.stringify(keysOf(f)));
  const d = I.buildDaily({ bid: BID, anon: 'abcdef01', day: '2026-11-02',
    events: [{ ev: 'install', props: { ver: '1.8.0' } }] });
  eq('日批封套顶层带 did（值 = ct.did）', d.did, did1);
  ok('日批封套键序 === DAILY_KEYS', sameKeys(keysOf(d), I.DAILY_KEYS), JSON.stringify(keysOf(d)));

  // 隐私边界：did 只落 local，绝不进 sync（跨设备同步会把两台机器算成一台）
  ok('ct.did 从未出现在 chrome.storage.sync 的写入载荷里',
    !syncSetCalls.some((o) => o && Object.prototype.hasOwnProperty.call(o, CT.STORAGE.DID)),
    JSON.stringify(syncSetCalls.map((o) => Object.keys(o || {}))));

  restoreReportConsts(DEFAULTS);
}

/* ================================================================== */
console.log('\n────────────────────────────────────────────────────');
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  · ' + f);
  console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
  process.exit(1);
}
console.log('全部通过：' + passed + ' 项断言');
