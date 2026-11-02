/*
 * 叠译 · 持久化翻译缓存
 * ------------------------------------------------------------------
 * 为什么需要它：
 *   同一篇文章反复打开、SPA 来回切页、翻页后重访 —— 这些场景下
 *   重复请求外部翻译接口是纯浪费，既慢又可能触发限流。
 *
 * 存储策略：
 *   - 落在 chrome.storage.local，键前缀 tc:
 *   - 首次使用时一次性把全部缓存读进内存 Map，之后查询走同步路径
 *     （翻译主链路是高频同步查询，不能每次都 await 存储）
 *   - 写入先入脏队列，合并后延迟落盘，避免逐条写造成 IO 抖动
 *   - 超过 maxEntries 时按插入顺序做 FIFO 淘汰
 */
'use strict';

const PREFIX = 'tc:';

/** 内存镜像：cacheKey -> { t: 译文, a: 写入时间戳 } */
const mem = new Map();
/** 待落盘的键值 */
const dirty = new Map();

let loaded = false;
let loadPromise = null;
let flushTimer = null;
let maxEntries = 8000;

/* ------------------------------------------------------------------ */

/**
 * 生成缓存键：同一段原文 + 同一语向 + 同一引擎 + 同一术语集 ⇒ 同一译文
 * ------------------------------------------------------------------
 * 【v1.7.1 为什么必须加 termHash】
 * 旧版刻意把术语表排除在键外，注释写的是「否则换了术语表就全部失效」。
 * 追求的是命中率，代价却是**正确性**：
 *
 *     用户把 `Growth Product Manager` 加进术语表 → 页面重译
 *     → 缓存命中旧译文「成长产品经理」→ 用户看到「改了没用」。
 *
 * 而产品里并没有任何地方告诉他这件事，于是他只会得出「这功能是坏的」。
 *
 * 用**术语集哈希**而不是术语表全文：术语不变则哈希不变（缓存照常命中，
 * 原意图保住）；术语一变则哈希变（旧译文自然失效，正确性拿回来）。
 * 两难被哈希消掉，不必二选一。
 *
 * 哈希里还拌了 TERMINOLOGY_VERSION —— 否则基座新增一条术语、用户表没动时
 * 哈希不变，那条错译在缓存里永远不会被纠正。
 *
 * @param {string} [termHash] 生效术语集的哈希。缺省 '0' = 未启用术语约束。
 *        缺省值必须是稳定常量而不是随机值，否则等于「每次都是新缓存」。
 */
export function makeKey(text, source, target, provider, termHash) {
  return PREFIX + provider + '|' + source + '|' + target + '|' +
    (termHash || '0') + '|' + fnv1a(text);
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36) + str.length.toString(36);
}

/* ------------------------------------------------------------------ */

/** 一次性载入全部缓存。多次调用共享同一个 Promise，避免重复读取。 */
export async function ensureLoaded(limit) {
  if (limit) maxEntries = limit;
  if (loaded) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all);
      for (const k of keys) {
        if (k.indexOf(PREFIX) !== 0) continue;
        const v = all[k];
        if (v && typeof v.t === 'string') mem.set(k, v);
      }
    } catch (e) {
      console.warn('[叠译] 缓存载入失败，将以空缓存运行：', e);
    }
    loaded = true;
  })();

  return loadPromise;
}

/** 同步读缓存；未命中返回 null */
export function get(text, source, target, provider, termHash) {
  const key = makeKey(text, source, target, provider, termHash);
  const hit = mem.get(key);
  return hit ? hit.t : null;
}

/** 写缓存（先入内存与脏队列，延迟落盘） */
export function set(text, source, target, provider, translation, termHash) {
  const key = makeKey(text, source, target, provider, termHash);
  const rec = { t: translation, a: Date.now() };
  mem.set(key, rec);
  dirty.set(key, rec);

  // FIFO 淘汰：Map 保持插入顺序，超限就删最早的
  if (mem.size > maxEntries) {
    const overflow = mem.size - maxEntries;
    let i = 0;
    for (const k of mem.keys()) {
      if (i++ >= overflow) break;
      mem.delete(k);
      dirty.set(k, null);   // 标记为删除
    }
  }

  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush().catch((e) => console.warn('[叠译] 缓存落盘失败：', e));
  }, 900);
}

/**
 * 有节制的落盘（翻译主链路在每轮结束时调用）
 * ------------------------------------------------------------------
 * 旧实现在每条翻译消息后都强制 flush：一个长页面会切成几十批，
 * 于是产生几十次存储写入，而每次都要把待写条目整体序列化一遍。
 * 这里改为按量决定：
 *   · 待写条目已攒够一定数量 → 立刻落盘（单次写入不至于过大）
 *   · 否则沿用 900ms 的合并窗口，把密集写入自然合并掉
 * 真正必须马上落盘的场合（SW 即将休眠）仍由 flush() 直接负责。
 */
const FLUSH_EAGER_ENTRIES = 200;

export function flushSoon() {
  if (dirty.size >= FLUSH_EAGER_ENTRIES) {
    return flush().catch((e) => console.warn('[叠译] 缓存落盘失败：', e));
  }
  scheduleFlush();
  return Promise.resolve();
}

/**
 * 立即落盘（service worker 即将休眠时调用）
 * ------------------------------------------------------------------
 * 【C-40 F2】落盘失败必须把这一批**原样退回脏队列**，下一轮重试。
 * 旧实现在 await 之前就 dirty.clear()，storage 写入一旦失败（典型：
 * 配额超限），本批写入与**删除标记**双双丢失 —— 删除标记丢失的后果
 * 更隐蔽：已淘汰条目残留 storage，下次 ensureLoaded 又被读回内存，
 * FIFO 淘汰静默失效并向配额上限缓慢漂移。重入时对同 key 让位给
 * 更新的脏值（flush 期间可能有新写入，不许旧值覆盖新值）。
 */
export async function flush() {
  if (!dirty.size) return;
  const payload = {};
  const removals = [];
  for (const [k, v] of dirty) {
    if (v === null) removals.push(k);
    else payload[k] = v;
  }
  dirty.clear();

  try {
    if (Object.keys(payload).length) await chrome.storage.local.set(payload);
    if (removals.length) await chrome.storage.local.remove(removals);
  } catch (e) {
    for (const k of removals) if (!dirty.has(k)) dirty.set(k, null);
    for (const k of Object.keys(payload)) if (!dirty.has(k)) dirty.set(k, payload[k]);
    throw e;
  }
}

/**
 * UTF-8 编码字节数（C-40 F1）
 * ------------------------------------------------------------------
 * stats() 的容量读数必须是**字节**而不是 JS 字符数：设置页直接展示
 * 「约 X MB」，中文在 UTF-8 下每字 3 字节，按字符数会最多低估 3 倍，
 * 用户对着 8000 条中文缓存看到「1.3 MB」会以为离 10MB 配额还很远。
 * 手写累加而不用 TextEncoder：省一次全串编码分配，缓存热路径外
 * 只有设置页偶尔调用，量级毫秒以下。
 */
function utf8Bytes(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; } // 代理对合为一字
    else n += 3;
  }
  return n;
}

/** 缓存统计，供设置页展示（字节口径：UTF-8 编码字节数，见 utf8Bytes） */
export async function stats() {
  await ensureLoaded();
  let bytes = 0;
  for (const [k, v] of mem) bytes += utf8Bytes(k) + (v.t ? utf8Bytes(v.t) : 0) + 40;
  return {
    entries: mem.size,
    approxBytes: bytes,
    maxEntries
  };
}

/** 清空缓存 */
export async function clear() {
  const keys = [];
  for (const k of mem.keys()) keys.push(k);
  mem.clear();
  dirty.clear();

  const all = await chrome.storage.local.get(null);
  const allKeys = Object.keys(all).filter((k) => k.indexOf(PREFIX) === 0);
  const toRemove = Array.from(new Set(keys.concat(allKeys)));
  if (toRemove.length) await chrome.storage.local.remove(toRemove);
  return toRemove.length;
}

/** 设置项变更时同步上限 */
export function setLimit(n) {
  if (typeof n === 'number' && n > 0) maxEntries = n;
}
