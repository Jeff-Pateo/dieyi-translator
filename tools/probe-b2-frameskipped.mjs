/*
 * B2 数据面 · framesSkipped 瞬态计数 探针（C-67 / B2-5）
 * ------------------------------------------------------------------
 * 作者：数析（Metric）· 大数据组 ｜ 2026-10-13
 * 依据：CTO §7.9（frameSkipByTab 属进程内存）+ D-B2-01 §4.5（GET_TAB_STATS 回退追认）
 *
 * 只断言**稳定信号**（消息字段 / 存储落点 / 清理行为），不断言任何文案全文。
 *
 * 断言清单：
 *  A. framesSkipped 并入既有 tabStats 对象，由 REPORT 写入、GET_TAB_STATS 读出；
 *  B. GET_TAB_STATS 只读：未知 tab 返回 null、不新建条目、不写存储；
 *  C. REPORT / GET_TAB_STATS 全程**零存储写入**（含 framesSkipped 不落盘）；
 *  D. GET_TAB_STATS 缺省 msg.tabId 时回退 sender.tab.id；
 *  E. 标签关闭 / 更新（loading）时随既有 tabStats 一并清理；
 *  F. 静态护栏：源码无 frameSkipByTab（禁止另起 Map / 独立模块）。
 *
 * 运行：node tools/probe-b2-frameskipped.mjs   （退出码 0 = 全绿）
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
function section(t) { console.log('\n' + t); }

/* ================================================================== */
/* mock chrome                                                          */
/* ================================================================== */

const store = { sync: {}, local: {} };
const writeLog = { sync: [], local: [] };

function pick(s, keys) {
  if (keys === null || keys === undefined) return Object.assign({}, s);
  if (typeof keys === 'string') return (keys in s) ? { [keys]: s[keys] } : {};
  if (Array.isArray(keys)) { const o = {}; for (const k of keys) if (k in s) o[k] = s[k]; return o; }
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
  return new Promise((resolve) => listeners.msg(msg, sender, resolve));
}
function writeCount() { return writeLog.sync.length + writeLog.local.length; }

/* ================================================================== */
/* F. 静态护栏（先跑，与运行时无关）                                      */
/* ================================================================== */
section('F、静态护栏 · 禁止另起 Map / 独立模块');
{
  const src = fs.readFileSync(path.join(ROOT, 'background', 'service-worker.js'), 'utf8');
  ok('源码无 frameSkipByTab（未另起 Map / 独立模块）', !/frameSkipByTab/.test(src));
  ok('既有 tabStats 仍以单例 Map 存在', /const tabStats = new Map\(\)/.test(src));
}

/* ================================================================== */
/* 动态                                                                */
/* ================================================================== */
section('A、REPORT 写入 · GET_TAB_STATS 读出');
const mod = await import('../background/service-worker.js');
void mod;
await new Promise((r) => setTimeout(r, 60));

{
  const before = writeCount();
  const localKeysBefore = Object.keys(store.local).slice().sort();

  const rp = await send(
    { type: 'ct:report', translated: 10, units: 12, framesSkipped: 4, phase: 'done' },
    { tab: { id: 101 } }
  );
  eq('REPORT 返回 ok', !!(rp && rp.ok), true);

  const g1 = await send({ type: 'ct:get-tab-stats', tabId: 101 }, { tab: { id: 101 } });
  eq('GET_TAB_STATS(tabId) 返回 ok', !!(g1 && g1.ok), true);
  ok('tabStats 含 framesSkipped 字段', !!(g1 && g1.stats && 'framesSkipped' in g1.stats));
  eq('framesSkipped = 4', g1 && g1.stats ? g1.stats.framesSkipped : null, 4);
  eq('同记录仍保留 translated = 10', g1 && g1.stats ? g1.stats.translated : null, 10);

  // 缺省 framesSkipped → 0
  await send({ type: 'ct:report', translated: 1, units: 1, phase: 'done' }, { tab: { id: 303 } });
  const g303 = await send({ type: 'ct:get-tab-stats', tabId: 303 }, { tab: { id: 303 } });
  eq('未上报 framesSkipped 时默认 0', g303 && g303.stats ? g303.stats.framesSkipped : null, 0);

  section('B、GET_TAB_STATS 只读');
  const g2 = await send({ type: 'ct:get-tab-stats', tabId: 999 }, { tab: { id: 999 } });
  ok('未知 tabId → stats = null', g2 && g2.stats === null);
  const g999again = await send({ type: 'ct:get-tab-stats', tabId: 999 }, { tab: { id: 999 } });
  ok('再次读未知 tabId 仍为 null（未新建条目）', g999again && g999again.stats === null);

  section('D、缺省 msg.tabId → 回退 sender.tab.id');
  const gfb = await send({ type: 'ct:get-tab-stats' }, { tab: { id: 101 } });
  eq('无 msg.tabId 时按 sender.tab.id 命中', gfb && gfb.stats ? gfb.stats.framesSkipped : null, 4);

  section('C、全程零存储写入');
  eq('REPORT/GET_TAB_STATS 未产生任何 storage 写入', writeCount() - before, 0);
  const localKeysAfter = Object.keys(store.local).slice().sort();
  ok('local 键集合未变（framesSkipped 未落任何 storage 键）',
    JSON.stringify(localKeysAfter) === JSON.stringify(localKeysBefore),
    'before=' + JSON.stringify(localKeysBefore) + ' after=' + JSON.stringify(localKeysAfter));
  ok('local 无任何含 frames 的键',
    localKeysAfter.every((k) => k.toLowerCase().indexOf('frame') < 0),
    JSON.stringify(localKeysAfter));
  ok('sync.settings 无 framesSkipped 字段',
    JSON.stringify(store.sync.settings || {}).indexOf('framesSkipped') < 0);

  section('E、标签关闭 / 更新 随 tabStats 清理');
  ok('已捕获 tabs.onRemoved 监听器', typeof listeners.tabRemoved === 'function');
  ok('已捕获 tabs.onUpdated 监听器', typeof listeners.tabUpdated === 'function');
  if (typeof listeners.tabRemoved === 'function') listeners.tabRemoved(101);
  const g101after = await send({ type: 'ct:get-tab-stats', tabId: 101 }, { tab: { id: 101 } });
  ok('tab 关闭后 stats = null', g101after && g101after.stats === null);

  await send({ type: 'ct:report', translated: 2, units: 2, framesSkipped: 9, phase: 'done' }, { tab: { id: 202 } });
  if (typeof listeners.tabUpdated === 'function') listeners.tabUpdated(202, { status: 'loading', url: 'https://x.example/' });
  const g202after = await send({ type: 'ct:get-tab-stats', tabId: 202 }, { tab: { id: 202 } });
  ok('新导航（loading）后 stats = null', g202after && g202after.stats === null);

  section('边界 · REPORT 无 sender.tab');
  const rpNoTab = await send({ type: 'ct:report', translated: 5, units: 5, framesSkipped: 1, phase: 'done' }, {});
  eq('REPORT 无 sender.tab 仍返回 ok', !!(rpNoTab && rpNoTab.ok), true);
  eq('无 sender.tab 的 REPORT 不产生存储写入', writeCount() - before, 0);
}

/* ================================================================== */
console.log('\n————————————');
console.log('通过 ' + passed + ' 项；失败 ' + failures.length + ' 项');
if (failures.length) { console.log('失败项：'); for (const f of failures) console.log('  - ' + f); }
process.exit(failures.length ? 1 : 0);
