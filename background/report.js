/*
 * 叠译 · 匿名埋点上报（B2 双通道，v1.8.0 免费版）
 * ==================================================================
 * 【本文件是什么】
 *   扩展侧**匿名埋点**的本地聚合 + 出站管线。出站点只在 background
 *   service worker（契约 §1.1），由本模块统一负责：
 *     · installSalt 管理（32B CSPRNG，仅存 local['ct.reportSalt']，**永不出机**）
 *     · 前缀式域分离派生 tok / anon（契约 §2.0，**不得用 HKDF**）
 *     · 双通道组帧：通道 A 实时帧 / 通道 B 日批（契约 §1.3/§1.4）
 *     · 本地有界聚合 ct.reportAgg + 离线队列 + 指数退避（契约 §1.7/§1.8）
 *     · 退出短路 / 重置匿名标识（契约 §4.3）
 *
 * 【v1.8.0 产品口径】产品完整免费、不设付费墙 ⇒ 上报只服务两件事：
 *   安装量（install）与使用量（translate_round），外加通道 A 心跳 online。
 *   纠错/词典/术语/场景等**功能全部保留**，只是不再上报。
 *
 * 【三条不可越界的硬约束】
 *   ① 静默降级（契约 §1.9）：任何异常/超时/断网**不得**抛出到调用方，
 *      **不得**影响翻译主路径。所有对外函数内部 try/catch，只吞不抛。
 *   ② 三重总闸：**ENABLED===true** ∧ **host ∈ ALLOWED_HOSTS** ∧ **未退出**
 *      （见 outboundAllowed），任一不满足即出站 no-op。
 *   ③ 红线：本文件不读任何用户内容（原文/译文/网址/账号），只发计数与版本号。
 *
 * 【出机侧只允许两种信封】（顶层键 fail-closed，见契约 §1.4）
 *   通道 A 帧   {v,kind:/frame/,bid,did,ext,prod,win,tok,events}   —— 无 anon / 无 day / 无事件级 at
 *     帧 props **仅允许 count**（int≥1）；唯一例外 = online 的 props 恒 {}；
 *     每帧**恰好 1 条** online（§3.13）。
 *   通道 B 日批 {v,kind:/daily/,bid,did,anon,day,ext,prod,events}  —— 无 tok / 无 win；禁 online
 *
 * 权威：契约 v2.3；事件枚举/props 白名单 = #4《动作记录数据结构》v2.2 §2/§3。
 */
'use strict';

const CT = self.CT || {};

/* ==================================================================
 * 0. 常量（含缺省兜底 —— 便于本模块被独立单测时也能工作）
 * ================================================================== */
const RP = CT.REPORT || {};
const DOMAIN_TOK = RP.DOMAIN_TOK || 'w:';    // 通道 A 域标签（常量，不得复用于其它派生）
const DOMAIN_ANON = RP.DOMAIN_ANON || 'd:';  // 通道 B 域标签（常量，不得复用于其它派生）
const STORE = CT.STORAGE || {};
const KEY_SALT = STORE.REPORT_SALT || 'ct.reportSalt';
const KEY_AGG = STORE.REPORT_AGG || 'ct.reportAgg';
const KEY_DID = STORE.DID || 'ct.did';   // 安装期固定设备标识（UUIDv4，永不出机以外只进信封）

/** 端点：动态读取（改 CT.REPORT.ENDPOINT 即时生效，便于单测与灰度） */
function endpointUrl() { return (RP && RP.ENDPOINT) || 'http://127.0.0.1:7791/api/telemetry/actions'; }
const FRAME_MS = RP.FRAME_MS || (15 * 60 * 1000);
const BATCH_MAX = RP.BATCH_MAX || 50;            // 单批 ≤50 事件
const BYTES_MAX = RP.BYTES_MAX || 65536;         // 单批 ≤64KB
const QUEUE_MAX_ITEMS = RP.QUEUE_MAX_ITEMS || 200;
const QUEUE_MAX_BYTES = RP.QUEUE_MAX_BYTES || 262144;
const CELLS_MAX = RP.CELLS_MAX || 200;
const RETRY_BASE_MS = RP.RETRY_BASE_MS || 30000;
const RETRY_FACTOR = RP.RETRY_FACTOR || 2;
const RETRY_JITTER = RP.RETRY_JITTER || 0.25;
const RETRY_CAP_MS = RP.RETRY_CAP_MS || (30 * 60 * 1000);
const RETRY_MAX = RP.RETRY_MAX || 8;
function timeoutMs() { return (RP && RP.TIMEOUT_MS) || 8000; }
const PROD = RP.PROD || 'dieyi';
const CLIENT = RP.CLIENT || 'dieyi-ext-1.8';

/* v1.8.0：只保留 3 类事件（免费版口径 —— 安装量 / 使用量 / 心跳）
 *   install          通道 B（daily，带 bid+anon+day），首次安装报一次
 *   translate_round  通道 B，使用量的主来源
 *   online           通道 A 专用心跳（每帧恰好 1 条，props 恒 {}） */
const EV = {
  INSTALL: 'install',
  TRANSLATE_ROUND: 'translate_round',
  ONLINE: 'online'
};
const EV_SET = new Set(Object.keys(EV).map((k) => EV[k]));

/* 允许进入通道 A（帧）的事件：只有使用量计数。
 * install 必须走通道 B（带 anon+day），不得在无 day 的帧里裸奔；
 * online 由 buildFrame 每帧固定追加 1 条，不参与计数。 */
const FRAME_EV = new Set([EV.TRANSLATE_ROUND]);

/* 信封顶层键（fail-closed；仅用于自检与调试） */
const FRAME_KEYS = ['v', 'kind', 'bid', 'did', 'ext', 'prod', 'win', 'tok', 'events'];
const DAILY_KEYS = ['v', 'kind', 'bid', 'did', 'anon', 'day', 'ext', 'prod', 'events'];

/* ------------------------------------------------------------------
 * props 字段白名单（逐事件）—— 唯一权威 = #4 v2.2 §3。
 * 【产生侧防线】（契约 §4.2 ①）：只 pick 允许键，绝不 spread 整对象。
 * install 只有 ver（扩展版本号）—— 不含任何设备/账号/页面信息。
 * ------------------------------------------------------------------ */
const PROP_WHITELIST = {
  translate_round: ['phase', 'provider', 'sourceLang', 'targetLang', 'variant', 'mode',
    'units', 'translated', 'failed', 'rescuedFromClip', 'replaceDegraded',
    'riskSuspect', 'relocated', 'clipUnresolved', 'framesSkipped', 'isTop', 'frameGate', 'langPair'],
  install: ['ver']
};

/* 需在日聚合内**求和**的数值字段（其余字段进 cell 键，作为维度区分） */
const NUMERIC_FIELDS = {
  translate_round: ['units', 'translated', 'failed', 'rescuedFromClip', 'replaceDegraded',
    'riskSuspect', 'relocated', 'clipUnresolved', 'framesSkipped']
};

/* ==================================================================
 * 1. 低层工具（字节 / 编码 / 时间 / uuid）—— 全部容错
 * ================================================================== */
function webcrypto() {
  try {
    if (typeof crypto !== 'undefined' && crypto && crypto.subtle) return crypto;
    if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) return globalThis.crypto;
  } catch (e) { /* ignore */ }
  return null;
}

function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return s;
}

function bytesToB64(bytes) {
  try {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    if (typeof btoa === 'function') return btoa(bin);
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  } catch (e) { /* ignore */ }
  return bytesToHex(bytes);
}

function b64ToBytes(str) {
  try {
    if (typeof atob === 'function') {
      const bin = atob(str);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(str, 'base64'));
  } catch (e) { /* ignore */ }
  return null;
}

/** 32 字节 CSPRNG —— installSalt 唯一来源（永不出机） */
function randomSalt() {
  const c = webcrypto();
  const out = new Uint8Array(32);
  try {
    if (c && c.getRandomValues) { c.getRandomValues(out); return out; }
  } catch (e) { /* ignore */ }
  for (let i = 0; i < out.length; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

function uuidv4() {
  try {
    const c = webcrypto();
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  } catch (e) { /* ignore */ }
  // 兜底：非加密随机 UUIDv4（仅用于批幂等键，非身份）
  const b = new Uint8Array(16);
  const c = webcrypto();
  if (c && c.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = bytesToHex(b);
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}

/** 窗桶起点：epoch 毫秒 int，对齐 ≤15min（DL-17②；契约 §1.4） */
function winBucket(now) {
  const t = typeof now === 'number' ? now : Date.now();
  return Math.floor(t / FRAME_MS) * FRAME_MS;
}

/** UTC 日 YYYY-MM-DD（契约 §2.0：day = UTC 日） */
function utcDay(now) {
  const t = typeof now === 'number' ? now : Date.now();
  return new Date(t).toISOString().slice(0, 10);
}

function extVersion() {
  try {
    if (typeof chrome !== 'undefined' && chrome && chrome.runtime && chrome.runtime.getManifest) {
      const m = chrome.runtime.getManifest();
      if (m && m.version) return String(m.version);
    }
  } catch (e) { /* ignore */ }
  return RP.EXT_FALLBACK || '1.8.0';
}

function encoder() {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder();
  return null;
}

/* ==================================================================
 * 2. 域分离派生（前缀式，契约 §2.0；**不得用 HKDF**）
 * ------------------------------------------------------------------
 *   tok  = HMAC-SHA256(installSalt, "w:" + winId)[:8]   // 通道 A
 *   anon = HMAC-SHA256(installSalt, "d:" + day  )[:8]   // 通道 B
 * 域标签 "w:" / "d:" 为常量，不得复用于任何其它派生。
 * ================================================================== */
async function hmac8(saltBytes, msg) {
  const c = webcrypto();
  const enc = encoder();
  if (!c || !enc || !saltBytes) return null;
  const key = await c.subtle.importKey('raw', saltBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await c.subtle.sign('HMAC', key, enc.encode(String(msg)));
  return bytesToHex(new Uint8Array(sig)).slice(0, 8);
}

async function deriveTok(saltBytes, win) {
  return hmac8(saltBytes, DOMAIN_TOK + String(win));
}

async function deriveAnon(saltBytes, day) {
  return hmac8(saltBytes, DOMAIN_ANON + String(day));
}

/* ==================================================================
 * 3. installSalt 读写（**不做内存缓存** —— 保证「重置匿名标识」在 worker
 *    存活期内也即时生效：options 侧删除该键后，下一次派生即生成新盐）
 * ================================================================== */
function localApi() {
  try {
    if (typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.local) return chrome.storage.local;
  } catch (e) { /* ignore */ }
  return null;
}

/** 无 chrome 时的兜底内存存储（仅供单测） */
const memStore = new Map();

async function storeGet(key) {
  const L = localApi();
  if (L) {
    try { const r = await L.get(key); return r ? r[key] : undefined; } catch (e) { return undefined; }
  }
  return memStore.get(key);
}
async function storeSet(obj) {
  const L = localApi();
  if (L) { try { await L.set(obj); return; } catch (e) { return; } }
  for (const k of Object.keys(obj)) memStore.set(k, obj[k]);
}
async function storeRemove(key) {
  const L = localApi();
  if (L) { try { await L.remove(key); return; } catch (e) { return; } }
  memStore.delete(key);
}

/** 读 installSalt；createIfMissing=true 时缺失即生成并落盘 */
async function loadSalt(createIfMissing) {
  try {
    const v = await storeGet(KEY_SALT);
    if (v) {
      const bytes = typeof v === 'string' ? b64ToBytes(v) : null;
      if (bytes && bytes.length === 32) return bytes;
    }
    if (!createIfMissing) return null;
    const fresh = randomSalt();
    await storeSet({ [KEY_SALT]: bytesToB64(fresh) });
    return fresh;
  } catch (e) { return null; }
}

/**
 * 读 did；createIfMissing=true 时缺失即生成 UUIDv4 并落 local。
 * ------------------------------------------------------------------
 * 生成时机覆盖两类用户：
 *   · 新装 —— onInstalled(reason='install') 会 await startup()，这里补建；
 *   · 从 1.7.x 升级 —— 没有 install 事件，靠 worker 启动的 startup() 补建。
 * 只落 local、绝不进 sync（跨设备同步会把两台机器算成同一台）。
 * 格式校验失败（被手改坏）时按缺失处理、重新生成 —— did 只是匿名计数键，
 * 不承担任何身份/鉴权语义。
 */
async function loadDid(createIfMissing) {
  try {
    const v = await storeGet(KEY_DID);
    if (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)) {
      state.did = v;
      return v;
    }
    if (!createIfMissing) return '';
    const fresh = uuidv4();
    await storeSet({ [KEY_DID]: fresh });
    state.did = fresh;
    return fresh;
  } catch (e) { return ''; }
}

/* ==================================================================
 * 4. 退出开关（契约 §4.3）：开=退出
 *    ① 出站短路 no-op；② 清空 ct.reportAgg；③ 删除 ct.reportSalt
 * ================================================================== */
const state = {
  optOut: false,
  did: '',                // 安装期固定设备标识（ct.did 的内存镜像）
  agg: null,              // 内存镜像（ct.reportAgg 的形状）
  persistTimer: null,
  flushTimer: null,
  loaded: false
};

function emptyAgg(now) {
  return {
    day: utcDay(now),
    win: winBucket(now),
    cells: {},                                 // dimKey -> {ev, props, cnt, first, last}
    frameEv: {},                               // 当前窗内各 ev 计数
    queue: [],                                 // [{bid, kind, body, attempts, nextAt, bytes}]
    bytes: 0
  };
}

function ensureAgg() {
  if (!state.agg) state.agg = emptyAgg(Date.now());
  return state.agg;
}

/** 清空本地聚合（退出 / 重置时调用） */
function clearAgg() {
  state.agg = emptyAgg(Date.now());
  state.agg.queue = [];
  state.agg.bytes = 0;
}

function syncApi() {
  try {
    if (typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.sync) return chrome.storage.sync;
  } catch (e) { /* ignore */ }
  return null;
}

async function loadOptOut() {
  const S = syncApi();
  if (S) {
    try {
      const r = await S.get('settings');
      const v = r && r.settings && r.settings.telemetryOptOut;
      return v === true;
    } catch (e) { return false; }
  }
  return state.optOut;
}

/**
 * 应用退出语义（幂等）。optOut=true → 短路 + 清聚合 + 删盐。
 * optOut=false（重新开启）→ 生成**全新**盐，聚合从空起。
 */
export async function applyOptOut(optOut) {
  try {
    state.optOut = optOut === true;
    if (state.optOut) {
      clearAgg();
      await storeSet({ [KEY_AGG]: state.agg });   // 落盘「空聚合」（覆盖旧数据）
      await storeRemove(KEY_SALT);                // 删除 installSalt ⇒ 重开即新盐
      cancelTimers();
    } else {
      await storeRemove(KEY_SALT);                // 重开：确保是新盐
      clearAgg();
      await storeSet({ [KEY_AGG]: state.agg });
    }
  } catch (e) { /* 静默 */ }
  return { ok: true, optOut: state.optOut };
}

/**
 * ⑤ 出站前最终复读退出开关（压「退出 → 生效」窗口，契约 §4.3）。
 * ------------------------------------------------------------------
 * 与 options.js 同源：chrome.storage.sync 的 settings.telemetryOptOut（经 loadOptOut 读）。
 * 命中且当前尚未退出 → 执行 applyOptOut(true) 的**既有**退出语义
 *   （清 ct.reportAgg + 删 ct.reportSalt + 取消在途定时器）。
 * 返回 true = 已退出，调用方须短路（不发任何请求）。全程静默，绝不抛出。
 * 残余窗口：某次 doFetch 已越过此点后**在途**的请求无法召回，≤ 单次请求往返。
 */
async function refreshOptOut() {
  try {
    const fresh = await loadOptOut();
    if (fresh && !state.optOut) await applyOptOut(true);
  } catch (e) { /* 静默：读失败按未退出处理，不打断出站主路径 */ }
  return state.optOut === true;
}

/** 「重置匿名标识」入口（契约 §4.3）：重新生成 installSalt（覆盖旧值） */
export async function resetAnonId() {
  try {
    const fresh = randomSalt();
    await storeSet({ [KEY_SALT]: bytesToB64(fresh) });
  } catch (e) { /* 静默 */ }
  return { ok: true };
}

function cancelTimers() {
  try {
    if (state.persistTimer) { clearTimeout(state.persistTimer); state.persistTimer = null; }
    if (state.flushTimer) { clearTimeout(state.flushTimer); state.flushTimer = null; }
  } catch (e) { /* ignore */ }
}

/* 让定时器不阻塞 Node 事件循环（仅供单测脚本自然退出；浏览器侧无 unref） */
function unref(t) {
  try { if (t && typeof t.unref === 'function') t.unref(); } catch (e) { /* ignore */ }
  return t;
}

/* ==================================================================
 * 5. 本地聚合（record 为**同步非阻塞**；只更新内存，落盘去抖）
 * ================================================================== */
function sanitizeProps(ev, raw) {
  const allow = PROP_WHITELIST[ev];
  const out = {};
  if (!allow || !raw || typeof raw !== 'object') return out;
  for (const k of allow) {
    if (Object.prototype.hasOwnProperty.call(raw, k) && raw[k] !== undefined && raw[k] !== null) {
      out[k] = raw[k];
    }
  }
  return out;
}

function sortedKey(obj) {
  const keys = Object.keys(obj || {}).sort();
  const o = {};
  for (const k of keys) o[k] = obj[k];
  return JSON.stringify(o);
}

/** cell 维度键：ev + 非数值 props（数值字段按 §5.4 求和，不进键） */
function cellKey(ev, props) {
  const numeric = NUMERIC_FIELDS[ev] || [];
  const dim = {};
  for (const k of Object.keys(props)) if (numeric.indexOf(k) < 0) dim[k] = props[k];
  return ev + '|' + sortedKey(dim);
}

function sumNumeric(target, src, ev) {
  const numeric = NUMERIC_FIELDS[ev] || [];
  for (const k of numeric) {
    if (typeof src[k] === 'number' && isFinite(src[k])) {
      target[k] = (typeof target[k] === 'number' ? target[k] : 0) + src[k];
    }
  }
}

/**
 * ★ 记录一次动作（**非阻塞**：只更新内存 + 去抖落盘，绝不 await 网络/存储）。
 * 任何异常就地吞掉，绝不向调用方抛出（契约 §1.9）。
 */
export function record(ev, props) {
  try {
    if (!EV_SET.has(ev)) return;
    if (state.optOut) return;                 // 退出即停（不再产生新事件）
    const now = Date.now();
    const agg = ensureAgg();
    const day = utcDay(now);

    // 日切：先把上一日的帧/日批补发掉（fire-and-forget），再重置当日状态
    if (agg.day !== day) {
      const prevDay = agg.day;
      const prevCounts = agg.frameEv;
      if (prevCounts && Object.keys(prevCounts).length) enqueueFrameFor(agg.win, prevCounts);
      enqueueDailyFor(prevDay, agg);
      agg.day = day;
      agg.frameEv = {};
    }
    // 窗切：把上一窗的计数组帧发出
    const win = winBucket(now);
    if (agg.win !== win) {
      const prevWin = agg.win;
      const prevCounts = agg.frameEv;
      if (prevCounts && Object.keys(prevCounts).length) enqueueFrameFor(prevWin, prevCounts);
      agg.win = win;
      agg.frameEv = {};
    }

    if (FRAME_EV.has(ev)) agg.frameEv[ev] = (agg.frameEv[ev] || 0) + 1;

    const p = sanitizeProps(ev, props);
    const key = cellKey(ev, p);
    let cell = agg.cells[key];
    if (!cell) { cell = agg.cells[key] = { ev: ev, props: p, cnt: 0, first: now, last: now }; }
    cell.cnt += 1;
    cell.last = now;
    sumNumeric(cell.props, p, ev);

    pruneAgg(agg);
    schedulePersist();
  } catch (e) { /* 静默：绝不影响主路径 */ }
}

function pruneAgg(agg) {
  // cells 上界：按 last 升序丢最旧（FIFO 淘汰，防无界增长）
  const keys = Object.keys(agg.cells);
  if (keys.length > CELLS_MAX) {
    keys.sort((a, b) => (agg.cells[a].last || 0) - (agg.cells[b].last || 0));
    for (let i = 0; i < keys.length - CELLS_MAX; i++) delete agg.cells[keys[i]];
  }
}

function aggBytes(agg) {
  try { return JSON.stringify(agg).length; } catch (e) { return 0; }
}

function schedulePersist() {
  if (state.persistTimer) return;
  state.persistTimer = unref(setTimeout(() => {
    state.persistTimer = null;
    persist().catch(() => {});
  }, 1000));
}

async function persist() {
  try {
    if (!state.agg) return;
    const agg = state.agg;
    agg.bytes = aggBytes(agg);
    await storeSet({ [KEY_AGG]: agg });
  } catch (e) { /* 静默 */ }
}

/* ==================================================================
 * 6. 组帧 / 组批（**纯函数**，便于单测直接断言信封形状）
 * ================================================================== */

/** 帧事件项：非 online 只允许 {count:int≥1}；online 恒 {} */
function frameEventItem(ev, count) {
  if (ev === EV.ONLINE) return { ev: EV.ONLINE, props: {} };
  const n = (typeof count === 'number' && count >= 1) ? Math.floor(count) : 1;
  return { ev: ev, props: { count: n } };
}

/**
 * 构造通道 A 帧（契约 §1.4-A）。
 * ★ 顶层键恒为 {v,kind,bid,did,ext,prod,win,tok,events}（**无 anon/day/at**）；
 * ★ events 内**恰好 1 条** online 且 props 恒 {}；其余事件 props 仅 count。
 */
function buildFrame(opts) {
  const counts = opts && opts.counts ? opts.counts : {};
  const events = [];
  for (const ev of Object.keys(counts)) {
    if (ev === EV.ONLINE) continue;                     // online 由下方统一追加，防重复
    if (!FRAME_EV.has(ev)) continue;                    // 只有使用量计数进帧（install 走 B）
    events.push(frameEventItem(ev, counts[ev]));
  }
  events.push({ ev: EV.ONLINE, props: {} });            // 每帧恰好 1 条 online
  const env = {
    v: 2,
    kind: 'frame',
    bid: (opts && opts.bid) || uuidv4(),
    did: (opts && opts.did) || state.did || '',
    ext: (opts && opts.ext) || extVersion(),
    prod: PROD,
    win: (opts && typeof opts.win === 'number') ? opts.win : winBucket(Date.now()),
    tok: (opts && opts.tok) || '',
    events: events
  };
  return env;
}

/** 日批事件项：带完整 props（白名单内）；**禁 count**、**禁 online** */
function dailyEventItem(ev, props) {
  return { ev: ev, props: sanitizeProps(ev, props) };
}

/**
 * 构造通道 B 日批（契约 §1.4-B）。
 * ★ 顶层键恒为 {v,kind,bid,did,anon,day,ext,prod,events}（**无 tok/win**）；
 * ★ 不含 online；事件 props 内**不得出现 count**。
 */
function buildDaily(opts) {
  const list = (opts && opts.events) || [];
  const events = [];
  for (const it of list) {
    if (!it || !EV_SET.has(it.ev) || it.ev === EV.ONLINE) continue;   // 日批禁 online
    events.push(dailyEventItem(it.ev, it.props));
  }
  const env = {
    v: 2,
    kind: 'daily',
    bid: (opts && opts.bid) || uuidv4(),
    did: (opts && opts.did) || state.did || '',
    anon: (opts && opts.anon) || '',
    day: (opts && opts.day) || utcDay(Date.now()),
    ext: (opts && opts.ext) || extVersion(),
    prod: PROD,
    events: events
  };
  return env;
}

/** 按 ≤50 事件 / ≤64KB 切批（任一先到；契约 §1.7） */
function splitBatches(events, maxItems, maxBytes) {
  const mi = maxItems || BATCH_MAX;
  const mb = maxBytes || BYTES_MAX;
  const out = [];
  let cur = [];
  let curBytes = 2;   // "[]"
  for (const e of events) {
    const sz = JSON.stringify(e).length + 1;
    if (cur.length >= mi || (cur.length > 0 && curBytes + sz > mb)) {
      out.push(cur); cur = []; curBytes = 2;
    }
    cur.push(e); curBytes += sz;
  }
  if (cur.length) out.push(cur);
  return out;
}

/* ==================================================================
 * 7. 出站（总闸 + 退避 + 静默降级）
 * ================================================================== */

/**
 * 端点 host 是否在允许清单内（总闸第二道锁：白名单外一律不发）。
 * 判据 = hostname ∈ CT.REPORT.ALLOWED_HOSTS（缺省仅本机三写法）。
 * 白名单**不得**包含通配符；生产域名由主理人下发后追加进常量表。
 */
function hostAllowed(endpoint) {
  try {
    const list = Array.isArray(RP.ALLOWED_HOSTS) ? RP.ALLOWED_HOSTS : ['127.0.0.1', 'localhost', '[::1]'];
    const u = new URL(endpoint || endpointUrl());
    return list.indexOf(u.hostname) >= 0;
  } catch (e) { return false; }
}

/**
 * 总闸：是否允许真正出站。
 * 条件 = ① ENABLED===true；② 端点 host ∈ ALLOWED_HOSTS；③ 未退出。
 * 三者缺一即 no-op。
 */
function outboundAllowed(endpointOverride) {
  if (state.optOut) return false;
  if (RP.ENABLED !== true) return false;
  return hostAllowed(endpointOverride);
}

function backoffMs(attempts) {
  const base = RETRY_BASE_MS * Math.pow(RETRY_FACTOR, Math.max(0, attempts - 1));
  const capped = Math.min(base, RETRY_CAP_MS);
  const jitter = capped * RETRY_JITTER * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

async function doFetch(body) {
  // ⑤ 出站前最后一次复读退出开关：命中即短路，不发请求（窗口压到单次往返内）
  if (await refreshOptOut()) {
    const e = new Error('opt-out');
    e.__optOut = true;
    throw e;
  }
  const f = (typeof fetch === 'function') ? fetch : null;
  if (!f) throw new Error('no-fetch');
  const signal = (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
    ? AbortSignal.timeout(timeoutMs()) : undefined;
  const res = await f(endpointUrl(), {
    method: 'POST',
    keepalive: true,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Dieyi-Client': CLIENT },
    body: JSON.stringify(body),
    signal: signal
  });
  return res;
}

/** 入队一条待发信封（bid 入队即生成、重试不变；契约 §1.6） */
function enqueue(kind, body) {
  const agg = ensureAgg();
  const text = JSON.stringify(body);
  const item = {
    bid: body.bid,
    kind: kind,
    body: body,
    attempts: 0,
    nextAt: 0,
    bytes: text.length
  };
  agg.queue.push(item);
  agg.bytes = aggBytes(agg);
  // 队列有界：200 条 / 256KB，任一先到 → FIFO 丢最旧
  while (agg.queue.length > QUEUE_MAX_ITEMS) { agg.queue.shift(); }
  while (agg.queue.length > 1 && agg.bytes > QUEUE_MAX_BYTES) {
    const dropped = agg.queue.shift();
    agg.bytes -= dropped.bytes || 0;
  }
  scheduleFlush(0);
  return item;
}

function scheduleFlush(delay) {
  if (state.flushTimer) return;
  state.flushTimer = unref(setTimeout(() => {
    state.flushTimer = null;
    flushNow().catch(() => {});
  }, typeof delay === 'number' ? delay : 0));
}

/**
 * ★ 出站一次（异步、静默降级）。
 * 总闸关闭 → 直接返回（**不发任何请求**）；任何异常只吞不抛。
 */
export async function flushNow() {
  try {
    if (state.optOut) return { ok: true, skipped: 'opt-out' };
    if (!outboundAllowed()) return { ok: true, skipped: 'gate-closed' };
    // ⑤ 出站前复读退出开关（压窗口）：命中即应用退出语义并短路
    if (await refreshOptOut()) return { ok: true, skipped: 'opt-out' };
    const agg = ensureAgg();
    const now = Date.now();
    for (let i = 0; i < agg.queue.length; i++) {
      const item = agg.queue[i];
      if (item.nextAt && item.nextAt > now) continue;
      let res = null;
      try { res = await doFetch(item.body); }
      catch (e) {
        if (e && e.__optOut) return { ok: true, skipped: 'opt-out' };  // ⑤ 出站前发现退出
        res = null;                             // 断网 / 超时 / DNS：入队保留，退避重试
      }

      const status = res && typeof res.status === 'number' ? res.status : 0;
      if (res && status >= 200 && status < 300) {
        agg.queue.splice(i, 1); i--;            // 送达 → 出队
        continue;
      }
      if (status === 429) {
        let ra = 0;
        try { ra = parseInt(res.headers && res.headers.get && res.headers.get('Retry-After'), 10) || 0; } catch (e) { ra = 0; }
        item.attempts += 1;
        item.nextAt = now + (ra > 0 ? ra * 1000 : backoffMs(item.attempts));
        continue;
      }
      if (status === 400 || status === 413 || status === 422) {   // 毒消息：丢弃不重试
        agg.queue.splice(i, 1); i--;
        continue;
      }
      // 其余（5xx / 0=网络失败）：指数退避；超上限丢弃
      item.attempts += 1;
      if (item.attempts >= RETRY_MAX) { agg.queue.splice(i, 1); i--; continue; }
      item.nextAt = now + backoffMs(item.attempts);
    }
    await persist();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };  // 只返回，不抛
  }
}

/* ==================================================================
 * 8. 启动补发 + 安装事件（契约 §1.8）
 * ------------------------------------------------------------------
 * 挂点 = worker 侧 startup()（service-worker.js）。**非阻塞**。
 * 退出（optOut）时：不补发、不记录（契约 §4.3）。
 * ================================================================== */

/**
 * ★ 启动补发。幂等、非阻塞、全程 try/catch。
 */
export async function startup() {
  try {
    if (state.loaded) return { ok: true, skipped: 'already' };
    state.loaded = true;

    // 退出状态（读 settings；读不到按未退出处理）
    state.optOut = await loadOptOut();
    if (state.optOut) {
      clearAgg();
      await storeSet({ [KEY_AGG]: state.agg });
      await storeRemove(KEY_SALT);
      return { ok: true, skipped: 'opt-out' };
    }

    // 补建 did（新装 + 从 1.7.x 升级都靠这里兜底；optOut 时不生成）
    await loadDid(true);

    // 载入既有聚合（失败即空）
    try {
      const raw = await storeGet(KEY_AGG);
      if (raw && typeof raw === 'object' && raw.cells) {
        state.agg = Object.assign(emptyAgg(Date.now()), raw);
        if (!Array.isArray(state.agg.queue)) state.agg.queue = [];
        if (!state.agg.frameEv) state.agg.frameEv = {};
      }
    } catch (e) { /* ignore */ }

    const agg = ensureAgg();
    const today = utcDay(Date.now());

    // 跨日补发：worker 休眠期间跨了日 → 先把上一日的聚合补成日批
    if (agg.day !== today) {
      const prevDay = agg.day;
      const prevCounts = agg.frameEv;
      if (prevCounts && Object.keys(prevCounts).length) enqueueFrameFor(agg.win, prevCounts);
      enqueueDailyFor(prevDay, agg);
      agg.day = today;
      agg.win = winBucket(Date.now());
      agg.frameEv = {};
    }

    schedulePersist();
    scheduleFlush(0);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };  // 不抛
  }
}

/** 本 worker 会话内是否已处理过 install（同实例内存闸，避免并发重复入队） */
let installReportedThisSession = false;
const KEY_INSTALL_REPORTED = STORE.INSTALL_REPORTED || 'ct.installReported';

/**
 * ★ 安装事件（只在首次安装报一次）。幂等、非阻塞、全程 try/catch。
 * ------------------------------------------------------------------
 * 幂等键落 local['ct.installReported']：同一浏览器实例无论 onInstalled
 * 触发几次（重载/更新/并发唤醒）都只入队一次，后台安装量不被重复计数。
 * 无 chrome 的 Node 单测环境走 memStore，行为一致。
 * 必须在 startup() 之后调用（否则聚合会被 startup 从存储覆盖掉）。
 */
export async function installOnce(ver) {
  try {
    if (state.optOut) return { ok: true, skipped: 'opt-out' };
    if (installReportedThisSession) return { ok: true, skipped: 'already' };
    installReportedThisSession = true;
    if (await storeGet(KEY_INSTALL_REPORTED)) return { ok: true, skipped: 'already' };
    // 先落幂等位再记录：宁可极端情况下漏一条，也不重复计数。
    await storeSet({ [KEY_INSTALL_REPORTED]: true });
    await loadDid(true);
    const agg = ensureAgg();
    record(EV.INSTALL, { ver: String(ver || extVersion()) });
    /*
     * 立即组批（不等次日轮转）。
     * install 是一次性事件，若只留在 cells 里等跨日 rollover，绝大多数
     * 「装完就用一次、之后长期不回来」的用户会永远不被计入安装量。
     * 安装当下 cells 里只有这一条，成批是安全的；通道 B 契约（anon+day）不变。
     */
    await enqueueDailyFor(agg.day, agg);
    schedulePersist();
    scheduleFlush(0);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/** 组一帧并入队（异步；fire-and-forget，绝不抛出）。win = 该帧所属窗桶起点。 */
function enqueueFrameFor(win, counts) {
  Promise.resolve().then(async () => {
    try {
      if (!counts || !Object.keys(counts).length) return;
      const salt = await loadSalt(true);
      if (!salt) return;
      const did = state.did || await loadDid(true);
      const tok = await deriveTok(salt, win);
      if (!tok) return;
      const env = buildFrame({ win: win, did: did, tok: tok, counts: counts });
      enqueue('frame', env);
    } catch (e) { /* 静默 */ }
  });
}

/** 组一日批并入队（异步；cells 为该日聚合）。日批禁 online、props 禁 count。
 *  返回 promise —— installOnce 需要 await 它，确保「入队完成」再触发 flush。 */
function enqueueDailyFor(day, agg) {
  return Promise.resolve().then(async () => {
    try {
      const cells = Object.keys(agg.cells || {}).map((k) => agg.cells[k]);
      if (!cells.length) return;
      const salt = await loadSalt(true);
      if (!salt) return;
      const did = state.did || await loadDid(true);
      const anon = await deriveAnon(salt, day);
      if (!anon) return;
      const items = cells.map((c) => ({ ev: c.ev, props: c.props }));
      const batches = splitBatches(items, BATCH_MAX, BYTES_MAX);
      for (const b of batches) enqueue('daily', buildDaily({ events: b, day: day, did: did, anon: anon }));
      agg.cells = {};
    } catch (e) { /* 静默 */ }
  });
}

/* ==================================================================
 * 9. 对外只读快照（供 UI / 单测观测；**不含任何用户内容**）
 * ================================================================== */
export function snapshot() {
  try {
    const agg = state.agg || emptyAgg(Date.now());
    return {
      optOut: state.optOut,
      day: agg.day,
      win: agg.win,
      cells: Object.keys(agg.cells || {}).length,
      frameEv: Object.assign({}, agg.frameEv || {}),
      queue: (agg.queue || []).length
    };
  } catch (e) { return null; }
}

/* ==================================================================
 * 10. 内部导出（仅单测使用；命名以下划线开头，不属对外契约）
 * ================================================================== */
export const _internals = {
  EV, EV_SET, FRAME_KEYS, DAILY_KEYS, PROP_WHITELIST, NUMERIC_FIELDS,
  DOMAIN_TOK, DOMAIN_ANON,
  winBucket, utcDay, uuidv4, hmac8, deriveTok, deriveAnon, randomSalt,
  bytesToB64, b64ToBytes, bytesToHex, hostAllowed, outboundAllowed, endpointUrl,
  sanitizeProps, cellKey, buildFrame, buildDaily, splitBatches, frameEventItem,
  emptyAgg, clearAgg, enqueue, enqueueFrameFor, enqueueDailyFor, loadOptOut, loadSalt, loadDid,
  getState: () => state,
  setState: (patch) => { Object.assign(state, patch); },
  reset: () => {
    cancelTimers();
    state.loaded = false;
    state.optOut = false;
    state.agg = null;
    state.did = '';
    installReportedThisSession = false;
    memStore.clear();
  }
};
