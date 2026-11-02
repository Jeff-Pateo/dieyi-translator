/*
 * 叠译 · 后台服务（MV3 Service Worker）
 * ------------------------------------------------------------------
 * 这里是唯一的「外部世界出口」：所有翻译请求、缓存读写、设置持久化都收拢在此，
 * content script 与 UI 页面一律通过消息与它通信。
 *
 * 这么做有两个好处：
 *   1) 页面侧的注入脚本保持轻量，不需要网络权限，也不容易与站点脚本冲突
 *   2) 缓存与并发控制天然是全局的，不会因为开了 20 个标签页就翻 20 倍
 */
'use strict';

import '../shared/constants.js';
import '../shared/protect.js';
// 术语基座与治理。必须排在 constants 之后 —— 它挂在同一个 self.CT 上。
import '../shared/terminology.js';
import './frame-budget.js';
import './pdf-rules.js';
import * as cache from './cache.js';
import {
  translateBatch,
  probe,
  prepareBuiltinModel,
  builtinAvailability,
  resolveProvider,
  batchHintFor
} from './providers.js';
// 匿名埋点（B2 双通道，v1.8.0 免费版）。出站点只在此模块；
// 只发 install / online / translate_round 三类，不含任何用户内容。
import * as report from './report.js';

const CT = self.CT;
const protect = CT.protect;    // 不可译片段保护与术语表，见 shared/protect.js
const term = CT.terminology;   // 术语基座与治理，见 shared/terminology.js

/* ==================================================================
 * 翻译质量度量（v1.7.1）
 * ------------------------------------------------------------------
 * 「翻译不准确」是感受，不是指标。这里把它拆成四个可数的量：
 *   termMasked  本次掩掉的术语次数 —— 术语基座到底有没有在起作用
 *   maskLoss    占位符数量对不上的条数 —— 术语/链接被引擎改写或吞掉
 *   alignFails  引擎返回条目数与请求不符的次数 —— **错位**，
 *               也就是「译文跑到别的段落去」，最致命的一类静默失败
 *   lenSum/lenCount/lenMax  长度膨胀比 —— 与排版膨胀（UI 遮挡）直接耦合
 *
 * 刻意【不落盘】也不上报界面：没有消费者的指标只会变成噪音。
 * 目前由 #ct-debug 与基准页读取。等有 UI 消费方时再考虑持久化。
 * ================================================================== */
const metrics = {
  termMasked: 0, maskLoss: 0, alignFails: 0,
  lenSum: 0, lenCount: 0, lenMax: 0,
  // v1.7.4（C-12/C-13）：
  //   sameAsSrc  译文与原文逐字符相同的条数（只计数不拦截 —— 品牌名/代号原样
  //              返回是合法输出，宽口径拦截会误伤，见《开发可行性评估-v1.7.4》§3）
  //   q2Rejects  被 Q2 窄口径判为坏产出（空译 / 占位符异常）的条数
  //   corrected  用户纠错表直接短路命中的条数 —— 纠错闭环在不在起作用看这个数
  sameAsSrc: 0, q2Rejects: 0, corrected: 0
};

function metricsSnapshot() {
  return {
    termMasked: metrics.termMasked,
    maskLoss: metrics.maskLoss,
    alignFails: metrics.alignFails,
    lenCount: metrics.lenCount,
    lenAvg: metrics.lenCount ? Math.round((metrics.lenSum / metrics.lenCount) * 1000) / 1000 : 0,
    lenMax: Math.round(metrics.lenMax * 1000) / 1000,
    sameAsSrc: metrics.sameAsSrc,
    q2Rejects: metrics.q2Rejects,
    corrected: metrics.corrected
  };
}

/* ==================================================================
 * 内容脚本清单
 * ------------------------------------------------------------------
 * 注入顺序有依赖：constants 提供 CT 命名空间，guard 提供重复注入守卫，
 * detector / renderer / toggle 依次挂到 CT 上，content 最后把它们串成流水线。
 *
 * 这份清单同时被三处需要（manifest 的 content_scripts、下面的补注入、
 * 以及 sendCommandToTab 的兜底链），因此抽成常量 —— 分散写死的结果是
 * 加文件时漏改其中一处，而漏改补注入这条链路的症状是「装完没反应」，
 * 排查成本远高于维护一个数组。
 * ================================================================== */

const CONTENT_FILES = [
  'shared/constants.js',
  // v1.7.1：术语基座要排在 content.js 之前吗？不需要 ——
  // 它只被 service worker 消费（掩码在这里做，不在页面里做）。
  // 放进清单是为了让「清单三处一致」这条纪律成立：
  // manifest 的 content_scripts、下面的补注入、测试的加载列表必须逐项相同。
  'shared/terminology.js',
  // v1.7.2：场景识别。只被 content 消费（探测结果随请求带来），进清单
  // 同样是为了「清单三处一致」纪律。
  'shared/scene.js',
  'content/guard.js',
  // v1.7 新增。顺序有依赖：
  //   frame-gate 要给 content 用；layers 是浮层仲裁（toggle 与 selection 都依赖）；
  //   keymap / shadow-walk / selection 各自独立，但都要排在 content 之前
  'content/frame-gate.js',
  'content/layers.js',
  'content/keymap.js',
  'content/shadow-walk.js',
  'content/selection.js',
  'content/detector.js',
  'content/renderer.js',
  'content/toggle.js',
  'content/content.js'
];
const CONTENT_CSS = 'content/content.css';

/* ==================================================================
 * 设置
 * ================================================================== */

let settingsCache = null;

async function loadSettings(force) {
  if (settingsCache && !force) return settingsCache;
  let stored = {};
  let migrations = {};
  let area = null;
  try {
    const r = await chrome.storage.sync.get(['settings', 'ctMigrations']);
    stored = r.settings || {};
    migrations = r.ctMigrations || {};
    area = chrome.storage.sync;
  } catch (e) {
    // 未登录或同步不可用时退回本地存储
    const r = await chrome.storage.local.get(['settings', 'ctMigrations']);
    stored = r.settings || {};
    migrations = r.ctMigrations || {};
    area = chrome.storage.local;
  }

  /* ---- v1.7.1 一次性迁移：「自动翻译」默认从 true 收为 false ----
   * saveSettings 落盘的是【合并后的全量设置】，所以所有老安装的存储里
   * 都躺着 autoTranslate: true —— 那是旧默认值被持久化的结果，
   * 不是用户的选择。不迁移的话，新的默认 false 永远被旧数据覆盖，
   * 「改了默认值怎么还自动翻译」的反馈就是这么来的。
   * 只跑一次（ctMigrations 标记）；之后用户再手动打开则尊重其选择。 */
  let migrated = false;
  if (!migrations.autoTranslateDefaultOff) {
    stored.autoTranslate = false;
    migrations.autoTranslateDefaultOff = true;
    migrated = true;
  }

  settingsCache = CT.settings.merge(CT.DEFAULT_SETTINGS, stored);
  cache.setLimit(settingsCache.cacheMaxEntries);

  if (migrated) {
    try {
      await area.set({ settings: settingsCache, ctMigrations: migrations });
    } catch (e) {
      // 落盘失败不影响本次会话：缓存里已经是迁移后的值；
      // 下次启动若标记仍未落上，迁移会再跑一次（幂等）。
    }
  }
  return settingsCache;
}

async function saveSettings(patch) {
  const cur = await loadSettings(true);
  const next = CT.settings.merge(cur, patch);
  settingsCache = next;
  cache.setLimit(next.cacheMaxEntries);
  const payload = { settings: next };
  try {
    await chrome.storage.sync.set(payload);
  } catch (e) {
    await chrome.storage.local.set(payload);
  }
  return next;
}

/* ==================================================================
 * 纠错频次统计（C-62 / C-63，B2-1）—— 口径依 D-B2-01
 * ------------------------------------------------------------------
 * 【为什么落独立 local 键 ct.corrStats 而不写 settings】
 *   content.js 的 storage.onChanged 首行是 `if (!changes.settings) return;`
 *   —— 只要 settings 这个键被写，就**无条件** applySettings 重扫整页重译，
 *   与改的是哪个字段无关。把「每提交一次纠错就 +1」的计数写进 settings
 *   = 每次纠错都在所有打开页触发一次全页重扫/重译（性能 + 体验双破坏）。
 *   同型先例：constants.js 的 ct.reportSalt / ct.reportAgg 亦因此落独立 local 键。
 * 【不参与 termHash】：corrStats 不进 mergeGlossary 的 list。
 * 【计数键（D-B2-01 §2.3，唯一修复点）】：key = normKey(cand.from)+'|'+cand.to+'|'+tgt，
 *   cand = deriveLearnCandidate(...)。**落在候选（术语）级，不落在句对级** ——
 *   否则同一 (原文→修正译文) 对经 corrections 精确短路后不再出现，n≥3 永不达成。
 * 【独立命中】：仅当成功提交且 `to !== prev` 时 +1。
 * 【落盘时机 A-02】：n ≤ THRESHOLD 每次立即 flush（阈值达成前不可节流）；
 *   n > THRESHOLD 按 CORR_STATS_WRITE_MS 节流；dismiss / learn 后立即 flush。
 *   可断言：第 1/2/3 次提交后立即读 local['ct.corrStats'][key].n 分别为 1/2/3。
 * ================================================================== */
let corrStatsCache = null;   // { '<normKey(from)>|<to>|<tgt>': { n, first, last, dismissed } }
let corrStatsWroteAt = 0;    // 本会话最近一次 local 落盘时间（节流窗口基准）

function corrStatsKey(candFrom, candTo, tgt) {
  return term._internals.normKey(candFrom) + '|' + candTo + '|' + tgt;
}

async function loadCorrStats() {
  if (corrStatsCache) return corrStatsCache;
  let obj = {};
  try {
    const r = await chrome.storage.local.get(CT.STORAGE.CORR_STATS);
    const v = r[CT.STORAGE.CORR_STATS];
    if (v && typeof v === 'object') obj = v;
  } catch (e) { obj = {}; }
  corrStatsCache = obj;
  return corrStatsCache;
}

/** 超上限按 last 升序淘汰（防 local 配额，族 B/B-5） */
function pruneCorrStats(stats) {
  const keys = Object.keys(stats);
  const max = CT.LEARNING.STATS_MAX;
  if (keys.length <= max) return;
  keys.sort((a, b) => ((stats[a] && stats[a].last) || 0) - ((stats[b] && stats[b].last) || 0));
  for (let i = 0; i < keys.length - max; i++) delete stats[keys[i]];
}

/**
 * 落盘 local。force=true 立即写（n≤THRESHOLD / dismiss / learn）；
 * force=false 走 CORR_STATS_WRITE_MS 窗口节流（n>THRESHOLD）。
 * 写失败不抛出：内存仍持有本会话计数，下次再试。
 */
async function flushCorrStats(force) {
  if (!corrStatsCache) return;
  const now = Date.now();
  if (!force && corrStatsWroteAt && (now - corrStatsWroteAt) < CT.LEARNING.CORR_STATS_WRITE_MS) return;
  try {
    await chrome.storage.local.set({ [CT.STORAGE.CORR_STATS]: corrStatsCache });
    corrStatsWroteAt = now;
  } catch (e) { /* 忽略：下次写再试 */ }
}

/**
 * 一次独立命中 +1（仅在 SAVE_CORRECTION 判定 to !== prev 时调用）。
 * 候选源词超 SPAN_MAX → 返回 null（不建键/不计数）。
 */
async function bumpCorrStat(candFrom, candTo, tgt) {
  if (candFrom.length > CT.LEARNING.SPAN_MAX) return null;
  const stats = await loadCorrStats();
  const key = corrStatsKey(candFrom, candTo, tgt);
  const now = Date.now();
  const st = stats[key] || { n: 0, first: now, last: now, dismissed: false };
  if (st.dismissed === undefined) st.dismissed = false;
  if (!st.first) st.first = now;
  st.n += 1;
  st.last = now;
  stats[key] = st;
  pruneCorrStats(stats);
  await flushCorrStats(st.n <= CT.LEARNING.THRESHOLD);
  return st;
}

/** 标记候选已被消费（dismiss / 已学）→ 同候选不再弹；立即 flush */
async function suppressCorrStat(candFrom, candTo, tgt) {
  const stats = await loadCorrStats();
  const key = corrStatsKey(candFrom, candTo, tgt);
  const now = Date.now();
  const st = stats[key] || { n: 0, first: now, last: now, dismissed: false };
  st.dismissed = true;
  st.last = now;
  stats[key] = st;
  await flushCorrStats(true);
}

/*
 * B1（DL-36 / 方案②′，用户已批准）：在 corrStats 条目上承载**来源标记**。
 * ------------------------------------------------------------------
 * 语义：`learned === true` = 该候选**经确认卡被用户确认学过**（已落 glossary）。
 *   · 置位点：**只在** LEARN_PATTERN 的「学得落库成功之后」调用（见下方调用点）。
 *   · 读取侧：options 的「我的词典」据此显示来源 pill（「自动」）。
 * 【红线纪律】DISMISS_PATTERN 的**拒绝路径严禁**调用本函数 ——
 *   「拒绝过」（dismissed）与「学过」（learned）语义独立；把拒绝误标为学过会
 *   产生**假阳性**（B1 判据②）；故拒绝路径只写 dismissed（走 suppressCorrStat）。
 * 【守 CTO §7.4】来源标记**只落 ct.corrStats（local）**，**绝不进 glossary 条目**
 *   （glossary 条目仍严格 `['from','to']`）。
 * 【note】dismissed 是「不再弹卡」的抑制位，学得后仍需置位以防同候选重复弹；
 *   二者可并存（学得条目通常 learned=true 且 dismissed=true）。
 */
async function markCorrStatLearned(candFrom, candTo, tgt) {
  const stats = await loadCorrStats();
  const key = corrStatsKey(candFrom, candTo, tgt);
  const now = Date.now();
  const st = stats[key] || { n: 0, first: now, last: now, dismissed: false };
  if (st.dismissed === undefined) st.dismissed = false;
  if (!st.first) st.first = now;
  st.learned = true;
  st.last = now;
  stats[key] = st;
  await flushCorrStats(true);
}

/* ==================================================================
 * 学习候选提炼（C-63，B2-1）—— 口径依 D-B2-01 §2.2（替换旧 extractCorrectionSpan）
 * ------------------------------------------------------------------
 * deriveLearnCandidate({from,to,prev,tgt,glossary}) → {from,to} | null
 *   G0 门禁：tgt==='zh-CN'、to 非空、to !== prev、prev 非空；否则 null。
 *   G1 目标侧跨度：extractTargetSpan(prev,to)（prev/to 同为中文）→ {removed:R, added:A}。
 *   G2 源侧反查（主路径）：建「已知译法 → 源词」索引（来源 = 用户术语表 + 基座，
 *      **只读、不得写**）；在原文 from 内找**唯一**源词 f 使 f 的已知译法
 *      ∈ {R、R 的子串、含 R 的串}（= 二者互为子串）→ 候选 {f, A}。
 *      命中 0 或 >1 → 转 G3。
 *   G3 短单元回退：仅当 from 是术语样单元（无换行、长度 ≤ SPAN_MAX、
 *      无句末标点 .!?。！？、词数 ≤4（拉丁按空格计）且 CJK 长度 ≤12）
 *      → 候选 {from, to}（整体）。
 *   G4 放弃：皆不满足 → null（不学/不计数/不建键/不弹卡）。
 *   溢出（钉死）：候选源词 from 长度 > SPAN_MAX → 放弃，**绝不截断**。
 *
 * 成本：G2 每次调用构建一次「译法→源词」索引，规模 = 用户表 + 基座（~百条），
 *   O(n) 线性扫描；SAVE_CORRECTION 属用户驱动低频路径，无需缓存/记忆化。
 * ================================================================== */
function buildTranslationIndex(userGlossary, tgt) {
  // 复用既有 mergeGlossary（本体零改动）：已按 targetLang 过滤、用户优先。
  const list = term.mergeGlossary(Array.isArray(userGlossary) ? userGlossary : [], { targetLang: tgt });
  const index = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e || !e.from || !e.to) continue;   // to===''（保持原样）无译法锚 → 跳过
    index.push({ from: String(e.from), to: String(e.to) });
  }
  return index;
}

/** G2：在原文内找唯一「其已知译法嵌套 R」的源词；0 或 >1 返回 null */
function reverseLookupSource(originText, R, index) {
  if (!R) return null;
  const hay = String(originText).toLowerCase();
  const hits = Object.create(null);
  for (let i = 0; i < index.length; i++) {
    const rt = index[i].to;
    if (!(rt === R || rt.indexOf(R) >= 0 || R.indexOf(rt) >= 0)) continue;
    const f = index[i].from;
    if (hay.indexOf(f.toLowerCase()) < 0) continue;   // 源词须出现在原文中
    hits[term._internals.normKey(f)] = f;
  }
  const keys = Object.keys(hits);
  return keys.length === 1 ? hits[keys[0]] : null;
}

/** G3 条件：from 是否为「术语样短单元」 */
function isTermLikeUnit(from) {
  const s = String(from);
  if (/[\r\n]/.test(s)) return false;
  if (s.length > CT.LEARNING.SPAN_MAX) return false;
  if (/[.!?。！？]/.test(s)) return false;
  const words = s.trim().split(/\s+/).filter((x) => x);
  const cjkCount = (s.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g) || []).length;
  return words.length <= 4 && cjkCount <= 12;
}

function deriveLearnCandidate(input) {
  const from = String(input && input.from != null ? input.from : '').trim();
  const to = String(input && input.to != null ? input.to : '').trim();
  const prev = String(input && input.prev != null ? input.prev : '').trim();
  const tgt = String((input && input.tgt) || CT.LEARNING.TGT);

  // G0 门禁
  if (tgt !== CT.LEARNING.TGT) return null;
  if (!from || !to || !prev) return null;
  if (to === prev) return null;

  // G1 目标侧跨度（同语言）
  const spanT = term.extractTargetSpan(prev, to);
  if (!spanT) return null;
  const R = spanT.removed;
  const A = spanT.added;

  // G2 源侧反查（主路径）
  const index = buildTranslationIndex(input && input.glossary, tgt);
  const f = reverseLookupSource(from, R, index);
  let cand = f ? { from: f, to: A } : null;

  // G3 短单元回退
  if (!cand && isTermLikeUnit(from)) cand = { from: from, to: to };

  // G4 放弃 + 溢出（绝不截断）
  if (!cand) return null;
  if (String(cand.from).length > CT.LEARNING.SPAN_MAX) return null;
  return cand;
}

/* ==================================================================
 * 个人词典学习：写入准入（v1.8.0 免费版）
 * ------------------------------------------------------------------
 * 产品完整免费后**不再有术语条数上限**：任何候选都可写入。
 * 保留一个返回 {fits, capped} 的准入函数，是为了让调用点的分支语义不变
 * （调用方仍按 fits 判断），且未来若再加约束只需改这一处。
 * ================================================================== */
function termAdmission() {
  return { fits: true, capped: 0 };
}

/* ==================================================================
 * 标签页统计（供弹窗展示）
 * ================================================================== */

const tabStats = new Map(); // tabId -> { translated, units, provider, lang, at, framesSkipped }
/**
 * v1.8.0：每 tab × frame 的「上次累计段数」基线，用于把 content 发来的
 * **累计值**换成**增量**再上报。
 * ------------------------------------------------------------------
 * 为什么必须换：content 的 `stats.translated` 是本页会话累计值，而日批对
 * 数值字段是求和（契约 #4 §5.4）。直接上报累计值 ⇒ 同一页一天翻两次就被
 * 累加成两倍，看板的「使用量」系统性虚高。
 * 为什么键必须含 frameId：`all_frames: true`，每个 iframe 各有一份 content
 * 与自己的 stats。只按 tabId 记基线的话，A frame 报 10、B frame 报 8 会被
 * 算成「回落」，增量变 0 —— 反而少记。
 * 结构：Map<tabId, Map<frameId, number>>，tab 级清一次即可连带所有 frame。
 * 基线随 tab 关闭 / 导航（刷新、换 URL）清除，否则同一 tabId 复用会把新页面
 * 当成旧页面续算。
 */
const lastTranslated = new Map(); // tabId -> Map<frameId, 上次累计值>

/*
 * 基线持久化（v1.8.0）：**MV3 的 service worker 会被回收**，只放内存的话，
 * 唤醒后的第一次 REPORT 拿不到 prev → 会把整页累计值当增量发，等于把这一页
 * 重复计一遍。因此镜像到 chrome.storage.session（浏览器会话级：SW 休眠/唤醒
 * 保留，浏览器重启自动清 —— 正好是我们要的语义）。
 * 读失败/无 session API 时退回内存（首报按原值，与改造前行为一致，不会丢数据）。
 */
const SESSION_STORAGE = (chrome.storage && chrome.storage.session) ? chrome.storage.session : null;
const TX_BASE_KEY = 'ct.txBase';
let txBaseLoaded = false;
let txBaseLoading = null;
let txBaseTimer = null;

async function ensureTxBaseLoaded() {
  if (txBaseLoaded) return;
  if (!txBaseLoading) {
    txBaseLoading = (async () => {
      try {
        if (SESSION_STORAGE) {
          const got = await SESSION_STORAGE.get(TX_BASE_KEY);
          const obj = got && got[TX_BASE_KEY];
          if (obj && typeof obj === 'object') {
            for (const k of Object.keys(obj)) {
              const parts = String(k).split(':');
              const tabId = Number(parts[0]), frameId = Number(parts[1]);
              if (!Number.isFinite(tabId) || !Number.isFinite(frameId)) continue;
              if (typeof obj[k] !== 'number') continue;
              let m = lastTranslated.get(tabId);
              if (!m) { m = new Map(); lastTranslated.set(tabId, m); }
              if (!m.has(frameId)) m.set(frameId, obj[k]);   // 内存里更新的值优先
            }
          }
        }
      } catch (e) { /* 读失败 → 当无基线，首报按原值 */ }
      txBaseLoaded = true;
    })();
  }
  await txBaseLoading;
}

function txBaseSnapshot() {
  const o = {};
  for (const [t, m] of lastTranslated) for (const [f, v] of m) o[t + ':' + f] = v;
  return o;
}

/** 去抖落盘（300ms）；不阻塞上报链路 */
function scheduleTxBasePersist() {
  if (!SESSION_STORAGE || txBaseTimer) return;
  txBaseTimer = setTimeout(() => {
    txBaseTimer = null;
    try {
      const pr = SESSION_STORAGE.set({ [TX_BASE_KEY]: txBaseSnapshot() });
      if (pr && typeof pr.catch === 'function') pr.catch(() => {});
    } catch (e) { /* 静默 */ }
  }, 300);
  try { if (typeof txBaseTimer.unref === 'function') txBaseTimer.unref(); } catch (e) { /* ignore */ }
}
/** 上次下发给标签页徽标的内容，用于节流 */
const badgeState = new Map(); // tabId -> { key, at }
/** 进行中的进度最多多久刷新一次（毫秒） */
const BADGE_MIN_MS = 400;

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStats.delete(tabId);
  badgeState.delete(tabId);
  lastTranslated.delete(tabId);
  scheduleTxBasePersist();
  // frame 配额是页面级瞬态资源，标签页一关就没有意义了。
  // 不清的话，Map 会随着用户开的标签页数量单调增长。
  if (CT.frameBudget) CT.frameBudget.reset(tabId);
});

/* PDF 重定向规则的注册状态。
 * 用户点「用原生查看器打开」时需要临时撤下规则再跳转，
 * 这个标志防止并发重复注册。 */
let pdfRuleBusy = false;
/** 规则是否因为「用原生查看器打开」而被临时撤下 */
let pdfRuleSuspended = false;

/**
 * 注册「把 .pdf 导航重定向到自建查看器」的动态规则。
 * 用动态规则而不是静态 rules.json 的原因见 background/pdf-rules.js 顶部注释 ——
 * 一句话：redirect.extensionPath 带不上原始 URL，而 regexSubstitution 需要扩展 ID。
 */
async function registerPdfRule() {
  if (!chrome.declarativeNetRequest || !CT.pdfRules) return;
  if (pdfRuleBusy) return;
  pdfRuleBusy = true;
  try {
    const settings = await loadSettings();
    const viewerUrl = chrome.runtime.getURL(CT.pdfRules.VIEWER_PATH);

    // 先移除再添加：用户可能在设置里刚关掉 PDF 支持
    const rules = settings.pdfEnabled === false ? [] : [CT.pdfRules.build(viewerUrl)];
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [CT.pdfRules.RULE_ID],
      addRules: rules
    });
  } catch (e) {
    console.warn('[叠译] 注册 PDF 规则失败：', e);
  } finally {
    pdfRuleBusy = false;
  }
}

/** 临时撤下规则（供「用原生查看器打开」使用） */
async function suspendPdfRule() {
  if (!chrome.declarativeNetRequest || !CT.pdfRules) return;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [CT.pdfRules.RULE_ID]
    });
  } catch (e) { /* 忽略 */ }
}
chrome.tabs.onUpdated.addListener((tabId, info) => {
  /*
   * 基线清理（v1.8.0）：**任何**导航迹象都要清 —— 刷新（loading，无新 url）、
   * 站点内跳转（url 变）、地址栏回车。少清一次 = 新页面沿用旧基线 ⇒ 少记；
   * 多清一次只会在下一次上报按原值发，不会重复计数。
   */
  if (info.status === 'loading' || info.url) { lastTranslated.delete(tabId); scheduleTxBasePersist(); }

  if (info.status === 'loading' && info.url) {
    tabStats.delete(tabId);
    badgeState.delete(tabId);
    // 新导航开始 → frame 配额重算。
    // 同一个标签页从 A 站跳到 B 站，上一页的 frame 名单已经没有意义。
    if (CT.frameBudget) CT.frameBudget.reset(tabId);

    /*
     * 上一轮若为「用原生查看器打开」而撤下了 PDF 规则，这时把它恢复。
     * 延后 300ms 是为了避开「规则写入」与「导航请求发出」的竞态 ——
     * 早于导航恢复规则的话，用户会被自己扩展拦回查看器。
     */
    if (pdfRuleSuspended) {
      setTimeout(() => {
        pdfRuleSuspended = false;
        registerPdfRule();
      }, 300);
    }
  }
});

/* ==================================================================
 * 翻译主链路
 * ================================================================== */

/** 有限并发映射 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const n = Math.max(1, Math.min(limit || 1, items.length));
  const runners = new Array(n).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (e) {
        results[i] = { error: e };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

/** 把待翻译条目切成批次：条数与字符数双重上限 */
function makeBatches(entries, maxItems) {
  const limitItems = Math.max(1, Math.min(maxItems || CT.BATCH_MAX_ITEMS, CT.BATCH_MAX_ITEMS));
  const batches = [];
  let cur = [];
  let chars = 0;
  for (const e of entries) {
    const len = e.text.length;
    if (cur.length && (cur.length >= limitItems || chars + len > CT.BATCH_MAX_CHARS)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(e);
    chars += len;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/*
 * 引擎熔断器（v1.7.6，C-23）—— worker 级共享状态，按引擎分桶。
 * ------------------------------------------------------------------
 * 为什么不能只做「单次请求内」的熔断：content 侧是分波发消息的
 * （波水线，每波一次独立 ct:translate），单请求熔断意味着每一波都要
 * 重新烧满两波超时（~60s）才能熔断——285 段 ≈ 12 波 × 60s，页面级
 * 永远看不到终态（真实站点 remoteok.com 复测证实）。
 *
 * 这里把连续失败计数提升到 worker 模块作用域、按引擎分桶：
 *   · 连续 ENGINE_CIRCUIT_BREAKER_FAILS 批失败 → 该引擎进入熔断态；
 *   · 熔断期间该引擎的所有翻译请求**瞬时短路**（不发起网络调用），
 *     全部条目按失败落账 + 可读 notice，页面立即落到「翻译失败」终态；
 *   · 60s 冷却后自动复位，给引擎一次重新证明的机会；
 *   · 任一批次成功即清零（偶发失败不会误熔断）。
 */
const engineBreakers = Object.create(null);   // provider -> { consecutive, trippedAt }
const BREAKER_COOLDOWN_MS = 60000;

function breakerActive(provider) {
  const b = engineBreakers[provider];
  if (!b || b.consecutive < (CT.ENGINE_CIRCUIT_BREAKER_FAILS || 6)) return false;
  if (Date.now() - b.trippedAt >= BREAKER_COOLDOWN_MS) {
    // 冷却到期：复位，让引擎重新证明自己
    b.consecutive = 0;
    b.trippedAt = 0;
    return false;
  }
  return true;
}

function breakerNoteFailure(provider) {
  const b = engineBreakers[provider] || (engineBreakers[provider] = { consecutive: 0, trippedAt: 0 });
  b.consecutive++;
  if (b.consecutive >= (CT.ENGINE_CIRCUIT_BREAKER_FAILS || 6) && !b.trippedAt) {
    b.trippedAt = Date.now();
    console.warn('[叠译] 引擎熔断：', provider, '连续失败', b.consecutive, '批，60s 内翻译请求将短路');
  }
}

function breakerNoteSuccess(provider) {
  const b = engineBreakers[provider];
  if (b) { b.consecutive = 0; b.trippedAt = 0; }
}

const BREAKER_NOTICE = '翻译服务连续超时，本次已中止。确认网络正常后稍等一会儿再试；若一直如此，可在设置里换一种翻译方式。';

async function handleTranslate(msg, sender) {
  const settings = await loadSettings();
  const items = Array.isArray(msg.items) ? msg.items : [];
  if (!items.length) return { ok: true, translations: [], provider: settings.provider, failures: 0 };

  /*
   * frame 配额闸门（v1.7）。
   * ------------------------------------------------------------------
   * all_frames 打开后，每个命中 matches 的 iframe 都会来请求翻译。
   * content 侧已经做过一轮自我评估（面积 / 广告容器 / 文本量），
   * 但真实页面里还有一批「面积够大、也有文字、依然不值得翻」的 frame
   * （跨域评论区、嵌入的第三方文档）。这一层按标签页限流兜底。
   *
   * 被拒时返回 ok:true + skipped:true，而**不是**错误 ——
   * 否则每个被拒的 frame 都会在页面上刷一次红色提示。
   */
  if (CT.frameBudget && sender && sender.tab && sender.tab.id !== undefined) {
    const allowed = CT.frameBudget.admit(sender.tab.id, sender.frameId, msg.frameArea);
    if (!allowed) {
      return { ok: true, skipped: true, translations: [], provider: settings.provider, failures: 0, reason: 'frame-budget' };
    }
  }

  const source = msg.source || settings.sourceLang || 'auto';
  const target = msg.target || settings.targetLang || 'zh-CN';
  // v1.7.4（C-12 Q1b）：场景随请求透传给引擎（仅 LLM 引擎消费）
  const scenes = Array.isArray(msg.scene) ? msg.scene : [];

  // 先确定本次实际使用的引擎：缓存键与存储都必须绑定到具体引擎，
  // 否则 auto 模式下会在不同引擎之间串用译文。
  const resolved = await resolveProvider(settings, source, target);
  const provider = resolved.provider;

  // 熔断中的引擎：瞬时短路（不发起任何网络调用），全部条目按失败落账。
  // 页面侧 done=0 + failed>0 → 显示「翻译失败」终态，不再无限「翻译中」。
  if (breakerActive(provider)) {
    return {
      ok: true,
      provider: provider,
      notice: '翻译服务刚刚连续超时，本次已跳过。确认网络正常后，点页面里的开关再试一次。',
      failures: items.length,
      translations: new Array(items.length).fill(null)
    };
  }

  if (settings.cacheEnabled) await cache.ensureLoaded(settings.cacheMaxEntries);

  /*
   * 掩码选项。
   * 目的不是「让引擎更聪明」，而是把**不该翻的东西**在送翻前摘出去：
   * URL、代码标识符、模板占位符、版本号，以及术语表里指定的词。
   * 见 shared/protect.js 开头的说明。
   *
   * 【v1.7.1：生效术语表 = 用户表 ∪ 内置基座】
   * 基座（82 条，五域）解决的是「机制有了、数据是零」：
   * 没有它时，`Growth Product Manager` 必然被译成「成长产品经理」——
   * 那不是引擎的 bug，而是无约束时的默认取义。
   *
   * 合并规则（见 terminology.mergeGlossary）：
   *   · 用户表优先，同名忽略大小写先到先得 —— 用户写了就算数
   *   · 基座条目按 targetLang 过滤 —— **中文译名绝不允许泄漏到日语/法语页**
   *   · domains 为 null 表示全开
   *
   * termBaseEnabled 关掉时退回 v1.7.0 行为（只用用户表）。
   * 留这个开关是为了对照排障：「同一句话开/关基座」是验证术语有效性的
   * 最直接方法，比任何文档都有说服力。
   */
  const userGlossary = Array.isArray(settings.glossary) ? settings.glossary : [];

  /*
   * v1.7.4（C-13 Q3）：用户纠错表 → 精确短路映射。
   * ------------------------------------------------------------------
   * 纠错条目是「整句原文 → 修正译文」的**精确匹配**（exact: true），
   * 与词级正则条目是两种数据：
   *   · 不进 mergeGlossary / 掩码通道 —— 整句做正则既浪费又危险；
   *   · 组批前短路：命中直接采用，不查缓存、不送引擎 ——
   *     用户意志绝对优先于基座与引擎，且旧错译（可能已在缓存里）永远轮不到出场。
   * 独立 settings.corrections 键存储（不混进 glossary）：
   * options 页的术语文本框 parse/format 往返会剥掉未知字段（会破坏 exact 标记），
   * 且整句与词条的匹配语义完全不同 —— 强行同表只会互相污染。
   */
  const correctionsMap = new Map();
  const correctionsList = Array.isArray(settings.corrections) ? settings.corrections : [];
  for (const c of correctionsList) {
    if (c && c.from && c.to) correctionsMap.set(c.from, c.to);
  }
  /*
   * v1.7.3（C-11 H4）：merge + hash 打包记念化。
   * 同一会话里这些输入逐波不变，但 handleTranslate 每波都跑到这里 ——
   * glossaryBundle 按输入指纹缓存，指纹含用户表/语言/域/场景全部四项。
   */
  const bundle = term.glossaryBundle(userGlossary, {
    targetLang: target,
    domains: Array.isArray(settings.termDomains) ? settings.termDomains : null,
    // v1.7.2：content 探测的本页场景。场景条目（如招聘页 Apply→申请）
    // 只在这里放行；无场景信息时多义词依然不生效（G1 保守性兜底）。
    // 场景参与 termHash → 不同场景的页面缓存自然分流。
    scenes: Array.isArray(msg.scene) ? msg.scene : []
  });
  const activeGlossary = (settings.termBaseEnabled === false)
    ? (userGlossary.length ? userGlossary : null)
    : bundle.list;

  /*
   * 术语集哈希 —— 缓存键的第五个维度。
   *
   * 旧实现刻意不含术语表，理由是「否则换了术语表就全部失效」。
   * 那个取舍的后果是：用户改了术语表，页面重译却命中旧译文 ——
   * 看到的是「改了没用」，而产品里没有任何地方告诉他原因。
   *
   * 用哈希而不是全文：术语不变则哈希不变（缓存照常命中，原意图保住）；
   * 术语一变则哈希变（旧译文自然失效，正确性拿回来）。
   * 哈希里拌了 TERMINOLOGY_VERSION，因此基座升级也会让旧错译被淘汰。
   */
  // 基座路径直接复用 bundle 里算好的哈希；仅用户表路径（基座关闭）才现算。
  const termHash = (activeGlossary && activeGlossary.length)
    ? (settings.termBaseEnabled === false ? term.termHash(activeGlossary) : bundle.hash)
    : '0';

  const maskOpts = {
    glossary: activeGlossary,
    protectUntranslatable: settings.protectUntranslatable !== false
  };
  const useMask = maskOpts.protectUntranslatable || (activeGlossary && activeGlossary.length > 0);

  /*
   * 按原文去重。
   * 真实页面上重复文本占比很高（导航项、按钮、表头、标签、"阅读更多"…），
   * 而缓存键本就是「原文 + 语向 + 引擎」—— 同一段原文不可能对应两种译文。
   * 因此合并同文本在语义上完全无副作用，却能把请求数、缓存查找与存储写入
   * 一起降下来。这一步在缓存查询之前做，重复项连缓存都不必查第二遍。
   *
   * 注意缓存键用的是**原文 entry.text**，存的值是**已还原的最终译文** ——
   * 掩码只是传输层的临时形态，绝不能进入缓存键，否则换了术语表就全部失效。
   */
  const groups = new Map();          // text -> [index, ...]
  for (let i = 0; i < items.length; i++) {
    const text = items[i].text;
    if (!text) continue;
    const g = groups.get(text);
    if (g) g.push(i);
    else groups.set(text, [i]);
  }

  const translations = new Array(items.length).fill(null);
  const pending = [];                // { text, idxs, masked, table, ctx }
  let pendingItems = 0;
  // v1.7.5（C-17 F1）：本次请求里被用户纠错短路命中的条数。
  // 与 metrics.corrected（全局累计、只进 debug 口径）不同，这个数只反映
  // 本轮翻译——页面侧用它拼 badge「含你的修正 N 句」，让用户确认修正生效。
  let correctedHits = 0;

  for (const [text, idxs] of groups) {
    // v1.7.4（C-13 Q3）：用户纠错短路 —— 先于缓存与引擎，命中即终审。
    const corr = correctionsMap.get(text);
    if (corr !== undefined) {
      for (const i of idxs) translations[i] = corr;
      metrics.corrected += idxs.length;
      correctedHits += idxs.length;
      continue;
    }
    // 第 5 个参数是术语集哈希：术语一变，这里的键就变，旧错译自然淘汰。
    // 不改这一处，用户改术语表后看到的永远是缓存里的旧译文。
    const hit = settings.cacheEnabled ? cache.get(text, source, target, provider, termHash) : null;
    if (hit !== null && hit !== undefined) {
      for (const i of idxs) translations[i] = hit;
    } else {
      let masked = text;
      let table = null;
      if (useMask) {
        const m = protect.mask(text, maskOpts);
        masked = m.masked;
        table = m.table.length ? m.table : null;
        // 术语命中计数：基座/用户表到底有没有在起作用，就看这个数
        metrics.termMasked += m.termHits || 0;
      }
      // 上下文取组内第一项的位置线索（同文本同上下文，没必要各存一份）
      const first = items[idxs[0]];
      pending.push({ text: text, idxs: idxs, masked: masked, table: table, ctx: (first && first.ctx) || '' });
      pendingItems += idxs.length;
    }
  }

  let failures = 0;
  let notice = resolved.reason || '';
  let usedProvider = provider;
  let unclean = 0;                   // 还原不干净、因而未进缓存的条数

  if (pending.length) {
    // 引擎决定批大小：Google 免费接口一次只能吃一段，就切成 1 段一批，
    // 让外层的 concurrency 真正控制并行度；DeepL / OpenAI / 本地模型能吃多段，
    // 就切大批减少往返次数。见 providers.js 的 BATCH_HINT。
    const batches = makeBatches(pending, batchHintFor(provider));

    /*
     * 批间熔断检查走 worker 级共享熔断器（见 handleTranslate 上方注释）：
     * 本请求内连续失败达到阈值 → 熔断，未开跑批次立即中止；in-flight 批次
     * 自然收尾（有 C-21 超时兜底）。熔断后同引擎的后续请求在入口瞬时短路。
     */
    const batchResults = await mapLimit(batches, settings.concurrency, async (batch) => {
      if (breakerActive(provider)) return { ok: false, aborted: true, batch };
      const texts = batch.map((b) => b.masked);
      const contexts = batch.map((b) => b.ctx);
      try {
        // 引擎已在上面解析过，这里透传，避免每一批都重新解析一次
        const r = await translateBatch({ texts, source, target, settings, provider, contexts, scenes });
        breakerNoteSuccess(provider);
        return { ok: true, r, batch };
      } catch (e) {
        breakerNoteFailure(provider);
        return { ok: false, error: e, batch };
      }
    });
    if (breakerActive(provider)) {
      notice = BREAKER_NOTICE;
      metrics.circuitBreaks = (metrics.circuitBreaks || 0) + 1;
    }

    /*
     * Q2 译后产出自检 + 一次重试（v1.7.4，C-12）。
     * ------------------------------------------------------------------
     * 窄口径（与《开发可行性评估-v1.7.4》§3 一致）：只把两种**无争议**的
     * 坏产出判为拒绝 —— 空译、占位符异常（掩码数量守恒被破坏）。
     * 「译文与原文逐字符相同」只计数（sameAsSrc）：品牌名/代号/已中文文本
     * 原样返回是 system prompt 第 7 条自己要求的合法输出，自动拦截会误伤。
     *
     * 命中拒绝的处理：不进缓存、不上屏（translations[idx] 留空 → 页面侧
     * 计入失败 → 显示原文，宁缺毋错），整批重试一次；重试仍坏则放弃该条。
     * 重试预算限一次：引擎确定性强时重试大概率得到同样结果，多烧无益。
     */

    /**
     * 处理一个批结果。
     * @returns {{rejected: Array|null, recovered: number}}
     *          rejected 仍被判坏的条目（首轮回传供重试）；
     *          recovered 重试中翻盘成功的条目数（供冲减 failures）
     */
    function consumeResult(br, isRetry) {
      usedProvider = br.r.provider;
      if (br.r.notice) notice = br.r.notice;

      if (!Array.isArray(br.r.translations) || br.r.translations.length !== br.batch.length) {
        metrics.alignFails++;
      }

      let rejected = null;
      let recovered = 0;
      for (let k = 0; k < br.batch.length; k++) {
        const entry = br.batch[k];
        const raw = br.r.translations[k];
        // 引擎没给出这一条（错位的下游表现）→ 与 Q2 无关，按普通失败计
        if (raw === null || raw === undefined) {
          failures += entry.idxs.length;
          continue;
        }

        // 还原：占位符 → 原始片段 / 用户指定术语
        let val = raw;
        let bad = false;
        if (entry.table) {
          const rr = protect.restore(raw, entry.table);
          val = rr.text;
          bad = rr.residue;
          // 数量守恒：送出去几个占位符就该还原回几个。
          // 对不上说明引擎合并/拆分了内容。
          if (!bad && protect.countMasks(entry.masked) !== protect.countMasks(raw)) bad = true;
        }

        // 空译：还原后一个字符都没有，属无争议坏产出
        if (!bad && !String(val).trim()) bad = true;

        // 译文与原文逐字符相同：只计数，不拦截（口径理由见上）
        if (!bad && val === entry.text && /[A-Za-z]{3}/.test(entry.text)) {
          metrics.sameAsSrc += entry.idxs.length;
        }

        if (bad) {
          // 占位符守恒被破坏 = 术语或链接被引擎改写/吞掉；空译同理。
          // 单独立计数：它与「引擎翻得不好」是两种病，治法也不同。
          metrics.maskLoss += entry.idxs.length;
          metrics.q2Rejects += entry.idxs.length;
          unclean += entry.idxs.length;
          if (!isRetry) {
            (rejected = rejected || []).push(entry);
            // 拒绝条目按失败计（页面侧显示原文）；重试翻盘后冲减
            failures += entry.idxs.length;
          }
          // 拒绝的条目不上屏、不进缓存 —— translations[idx] 保持 null
          continue;
        }

        if (isRetry) recovered += entry.idxs.length;

        // 长度膨胀比：译文长度 ÷ 原文长度。
        // 它既是译文质量的粗筛（膨胀 3 倍以上通常意味着引擎在硬译），
        // 也是 UI 侧排版策略的输入 —— 窄容器里的溢出一大半由它决定。
        // 只对最终采纳的译文计一次（重试通过时首轮未计，不会重复）。
        if (entry.text && entry.text.length) {
          const ratio = val.length / entry.text.length;
          metrics.lenSum += ratio;
          metrics.lenCount++;
          if (ratio > metrics.lenMax) metrics.lenMax = ratio;
        }

        for (const idx of entry.idxs) translations[idx] = val;
        // 只有还原干净的译文才值得缓存；否则一次错译会被长期粘住
        if (settings.cacheEnabled) {
          cache.set(entry.text, source, target, usedProvider, val, termHash);
        }
      }
      return { rejected: rejected, recovered: recovered };
    }

    const retryBatches = [];
    for (const br of batchResults) {
      if (br && br.ok) {
        const out = consumeResult(br, false);
        if (out.rejected) retryBatches.push(out.rejected);
      } else {
        const err = br && br.error;
        if (br && br.batch) {
          for (const entry of br.batch) failures += entry.idxs.length;
        }
        if (!notice) notice = err && err.message ? err.message : '翻译请求失败';
        console.warn('[叠译] 批次翻译失败：', err);
      }
    }

    // Q2 重试：仅对被判坏产出的条目再试一次（并发度复用同一设置）。
    // 熔断后不再重试：引擎都不可用了，重试只会再烧一轮超时。
    if (retryBatches.length && !breakerActive(provider)) {
      const retryResults = await mapLimit(retryBatches, settings.concurrency, async (batch) => {
        const texts = batch.map((b) => b.masked);
        const contexts = batch.map((b) => b.ctx);
        try {
          const r = await translateBatch({ texts, source, target, settings, provider, contexts, scenes });
          return { ok: true, r, batch };
        } catch (e) {
          return { ok: false, error: e, batch };
        }
      });
      for (const br of retryResults) {
        if (br && br.ok) {
          // 翻盘的条目从失败计数里冲减；仍坏的维持首轮拒绝，不再追加
          const out = consumeResult(br, true);
          if (out.recovered) failures -= out.recovered;
        }
        // 重试本身失败：维持首轮的拒绝计数，不再追加
      }
    }

    // 落盘交给节流逻辑：攒够量会立刻写，否则并入 900ms 合并窗口，
    // 避免一个长页面产生几十次存储写入
    if (settings.cacheEnabled) cache.flushSoon();
  }

  return {
    ok: true,
    provider: usedProvider,
    notice: notice || undefined,
    failures: failures,
    uncached: unclean || undefined,
    cached: items.length - pendingItems,
    deduped: items.length - groups.size,
    // v1.7.5（C-17 F1）：本轮命中用户修正的条数；0 时省略，badge 不追加字样
    corrections: correctedHits || undefined,
    // v1.7.1：把质量度量随响应带回页面侧。页面在 #ct-debug 下打印它 ——
    // 这是 metrics 目前唯一的消费方，因此不落盘、不做 UI。
    metrics: metricsSnapshot(),
    termHash: termHash,
    translations: translations
  };
}

/* ==================================================================
 * 消息路由
 * ================================================================== */

const handlers = {
  [CT.MSG.GET_SETTINGS]: async () => ({ ok: true, settings: await loadSettings() }),

  /*
   * PDF 查看器请求「改用浏览器自带的查看器」。
   * 顺序是关键：必须**先**把重定向规则撤下来，查看器**再**跳转 ——
   * 否则跳回去又被拦回查看器，变成死循环。
   * 规则由下面的 tabs.onUpdated 在那个标签页开始加载后恢复。
   */
  [CT.MSG.PDF_NATIVE]: async () => {
    pdfRuleSuspended = true;
    await suspendPdfRule();
    return { ok: true };
  },

  [CT.MSG.SET_SETTINGS]: async (msg) => {
    const next = await saveSettings(msg.patch || {});
    // 设置里可能改了「PDF 双语对照」开关 → 重新注册一次拦截规则。
    // registerPdfRule 是幂等的（先 removeRuleIds 再 addRules）。
    registerPdfRule();
    return { ok: true, settings: next };
  },

  [CT.MSG.TRANSLATE]: (msg, sender) => handleTranslate(msg, sender),

  /*
   * v1.7.4（C-13 Q3）：用户纠错落库。
   * 页内译文悬停「改」入口 → 行内输入框提交到这里。整句精确匹配条目存进
   * 独立的 settings.corrections 键（理由见 handleTranslate 内 correctionsMap 注释）。
   * 同 from 覆盖旧值（用户改主意以最后一次为准）；上限 500 条防失控增长。
   *
   * v1.8.0（B2-1，D-B2-01）：请求新增 `prev`（该单元当前/旧译文，content 取
   * rec.text）与 `tgt`。`prev` **仅在本次提炼内使用，不落任何存储**（白名单不变）。
   * 落库后内联执行 deriveLearnCandidate → 计数（键落候选级）→ 达阈值回带 suggestion。
   */
  [CT.MSG.SAVE_CORRECTION]: async (msg) => {
    const from = String((msg && msg.from) || '').trim();
    const to = String((msg && msg.to) || '').trim();
    if (!from || !to) return { ok: false, error: '原文与修正译文都不能为空' };
    if (from.length > 2000 || to.length > 2000) return { ok: false, error: '文本过长（上限 2000 字符）' };
    const prev = String((msg && msg.prev) || '').trim();      // 仅用于本次提炼，不落盘
    const tgt = String((msg && msg.tgt) || CT.LEARNING.TGT);
    const cur = await loadSettings(true);
    const list = Array.isArray(cur.corrections) ? cur.corrections.slice() : [];
    const rec = { from: from, to: to, at: Date.now() };
    const idx = list.findIndex((x) => x && x.from === from);
    if (idx >= 0) list[idx] = rec; else list.push(rec);
    const next = await saveSettings({ corrections: list.slice(-500) });
    const result = { ok: true, count: (next.corrections || []).length };

    // C-63：候选提炼（G0~G4）+ 频次统计（键落候选级，不落句对级）
    const cand = deriveLearnCandidate({ from: from, to: to, prev: prev, tgt: tgt, glossary: cur.glossary });
    if (!cand) return result;

    // 独立命中（D-B2-01 §2.3）：仅当 to !== prev 时 +1
    const changed = to !== prev;
    const st = changed ? await bumpCorrStat(cand.from, cand.to, tgt) : null;
    const reachedThreshold = !!(st && st.n >= CT.LEARNING.THRESHOLD && !st.dismissed);
    if (!st) return result;
    if (reachedThreshold) {
      result.suggestion = Object.assign(termAdmission(), {
        from: cand.from, to: cand.to, tgt: tgt, n: st.n
      });
    }
    return result;
  },

  /*
   * C-63：学习闭环写入（D-B2-01 §2.4）。用户在确认卡点「加入 / 替换并加入」才发。
   * 受控写入两闸：① auditGlossary.errors 空才继续；② 与既有 glossary 按 normKey
   * 去重（冲突放弃候选，用户已有条目优先 / 先到先得）；通过后 glossary=[...list,{from,to}] →
   * 既有 saveSettings(sync) → termHash 变 → 缓存自然失效。
   * 成功后置 corrStats[key].dismissed=true（D-B2-01 §4.2 追认：已入典不再弹）。
   * 冻结契约：请求 {from,to,tgt:'zh-CN'}
   *   响应 {ok:true,glossaryCount} | {ok:false,error:'audit-failed',errors?}
   */
  [CT.MSG.LEARN_PATTERN]: async (msg) => {
    const from = String((msg && msg.from) || '').trim();
    const to = String(msg && msg.to != null ? msg.to : '').trim();  // to==='' = 保持原样
    const tgt = String((msg && msg.tgt) || CT.LEARNING.TGT);
    if (!from) return { ok: false, error: 'audit-failed', errors: [{ from: from, code: 'empty-from' }] };
    if (tgt !== CT.LEARNING.TGT) {
      return { ok: false, error: 'audit-failed', errors: [{ from: from, code: 'bad-tgt' }] };
    }

    // ① 审计：errors 非空 → 不写 glossary
    const audit = term.auditGlossary([{ from: from, to: to }]);
    if (audit.errors && audit.errors.length) {
      return { ok: false, error: 'audit-failed', errors: audit.errors };
    }

    const cur = await loadSettings(true);
    let list = Array.isArray(cur.glossary) ? cur.glossary.slice() : [];

    // ② 去重：与既有 glossary 冲突（同 normKey）→ 放弃候选，不覆盖、不双写
    const key = term._internals.normKey(from);
    if (list.some((x) => x && term._internals.normKey(x.from) === key)) {
      await suppressCorrStat(from, to, tgt);   // 已有条目 → 该候选不再弹
      return { ok: true, glossaryCount: list.length };
    }

    // ③ 落库（追加到尾部 = 最新），经既有 saveSettings 落 sync；
    //    学得条目只含 {from,to}（不带 tgt / 来源标记，options 往返会剥离未知字段）
    list.push({ from: from, to: to });
    const next = await saveSettings({ glossary: list });
    // B1（DL-36 方案②′）：**学得语义的发生点 = 落库成功之后** → 在 corrStats
    // 条目标 learned（此调用点位于「落库之后、抑制之前」）。拒绝路径**不**调用本
    // 函数 ⇒ 「拒绝过」不会被误标「学过」（根除假阳性，B1 判据②）。
    await markCorrStatLearned(from, to, tgt);
    // 已入典 → 同候选不再弹；learn 动作后立即 flush corrStats
    await suppressCorrStat(from, to, tgt);
    return { ok: true, glossaryCount: (next.glossary || []).length };
  },

  /*
   * C-63：拒绝候选。corrStats[key].dismissed=true → 立即 flush。
   * dismissed 粒度 = 候选键（含 tgt），非本 from / 会话 / 全局。
   * 冻结契约：请求 {from,to,tgt:'zh-CN'} → 响应 {ok:true}。
   */
  [CT.MSG.DISMISS_PATTERN]: async (msg) => {
    const from = String((msg && msg.from) || '').trim();
    const to = String(msg && msg.to != null ? msg.to : '').trim();
    const tgt = String((msg && msg.tgt) || CT.LEARNING.TGT);
    if (from) await suppressCorrStat(from, to, tgt);
    return { ok: true };
  },

  [CT.MSG.PROBE_PROVIDER]: async () => {
    const settings = await loadSettings(true);
    try {
      const r = await probe(settings);
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  },

  [CT.MSG.PREPARE_MODEL]: async (msg) => {
    const r = await prepareBuiltinModel(msg.source || 'en', msg.target || 'zh-CN');
    return { ok: r.ok, message: r.message };
  },

  [CT.MSG.CACHE_STATS]: async () => ({ ok: true, stats: await cache.stats() }),

  [CT.MSG.CACHE_CLEAR]: async () => {
    const n = await cache.clear();
    return { ok: true, removed: n };
  },

  [CT.MSG.REPORT]: async (msg, sender) => {
    const tabId = sender && sender.tab ? sender.tab.id : null;

    /*
     * translated：累计 → 增量（v1.8.0）。
     * ------------------------------------------------------------------
     * content 发来的是**本页会话累计**成功段数；日批对数值字段求和。
     * 直接上报累计值会让同一页一天翻两次被记成两倍。
     * 规则：
     *   · 有基线且 now >= prev → 发 now - prev
     *   · 无基线，或 now < prev（页面被还原/重置/换语向后从头计）→ 按 now 原值发
     *   · 每次上报都刷新基线（含 0），保证下一次的差值有正确起点
     * 无 tabId（理论上不会发生）时退回原值，不凭空造增量。
     */
    // SW 可能刚被唤醒：先把上次落 session 的基线读回来（否则首报会把累计值当增量）
    await ensureTxBaseLoaded();
    const nRaw = Number(msg.translated);
    const rawTranslated = Number.isFinite(nRaw) ? Math.max(0, Math.floor(nRaw)) : 0;
    const nUnits = Number(msg.units);
    const hasUnits = Number.isFinite(nUnits);
    let translatedDelta = rawTranslated;
    if (tabId !== null && tabId !== undefined) {
      const frameId = (sender && sender.frameId !== undefined && sender.frameId !== null) ? sender.frameId : 0;
      let byFrame = lastTranslated.get(tabId);
      if (!byFrame) { byFrame = new Map(); lastTranslated.set(tabId, byFrame); }
      const prev = byFrame.get(frameId);
      translatedDelta = (typeof prev === 'number' && rawTranslated >= prev)
        ? Math.max(0, rawTranslated - prev)
        : rawTranslated;
      byFrame.set(frameId, rawTranslated);
      // 契约：0 ≤ translated ≤ units（整数）。units 缺失时不做上限约束。
      if (hasUnits) translatedDelta = Math.min(translatedDelta, Math.max(0, Math.floor(nUnits)));
      scheduleTxBasePersist();
    }

    report.record('translate_round', { phase: msg.phase || 'done', provider: msg.provider || '', sourceLang: msg.sourceLang || '', targetLang: msg.targetLang || '', mode: msg.mode || '', units: msg.units || 0, translated: translatedDelta, failed: msg.failed || 0, framesSkipped: msg.framesSkipped || 0, isTop: !!msg.isTop, frameGate: msg.frameGate || 'unknown', langPair: (msg.sourceLang || 'auto') + '>' + (msg.targetLang || 'zh-CN') });
    if (tabId !== null && tabId !== undefined) {
      // v1.8.0（B2-5，C-67）：framesSkipped 并入既有 tabStats 对象（不另起 Map、
      // 不落任何 storage 键、不写 settings）——它是检测用**瞬态**量，随 worker
      // 重启归零，只用于「当页检测到该场景」这一次判断；一次性抑制由持久键
      // ct.capNoticeSeen 独立负责，绝不用本量替代。标签关闭/更新处的 delete 清理点保持。
      tabStats.set(tabId, {
        translated: msg.translated || 0,
        units: msg.units || 0,
        provider: msg.provider || '',
        sourceLang: msg.sourceLang || '',
        targetLang: msg.targetLang || '',
        mode: msg.mode || '',
        phase: msg.phase || 'done',
        framesSkipped: msg.framesSkipped || 0,
        at: Date.now()
      });
      updateBadge(tabId, msg);
    }
    /*
     * 回带本次**上报用的增量**（不是 content 发来的累计值）。
     * 用途：单测可直接断言「10 → 25 发的是 10 与 15」，以及排障时对照
     * tabStats.translated（后者仍是累计值，供弹窗展示，两者语义不同）。
     * content 不消费该字段（它只看 ok）。
     */
    return { ok: true, translated: translatedDelta };
  },

  // 只读返回（不加闸门：数据消息不该被任何产品状态阻断）。
  // popup 带 msg.tabId；content 拿不到自己的 tabId（只有 worker 的 sender.tab.id 有）
  // → 回退 sender.tab.id，使 content 侧也能读到本 tab 的 stats（含 framesSkipped）。
  [CT.MSG.GET_TAB_STATS]: async (msg, sender) => {
    const tabId = (msg && msg.tabId != null)
      ? msg.tabId
      : (sender && sender.tab ? sender.tab.id : null);
    return { ok: true, stats: tabStats.get(tabId) || null };
  },

  // 供 popup / options 复用同一套「注入 + 发指令」逻辑
  [CT.MSG.SEND_COMMAND]: async (msg) => {
    return sendCommandToTab(msg.tabId, msg.cmd);
  },

  // 供设置页查询内置模型对某语向的支持情况
  [CT.MSG.BUILTIN_AVAILABILITY]: async (msg) => {
    const a = await builtinAvailability(msg.source || 'en', msg.target || 'zh-CN');
    return { ok: true, availability: a };
  },

  // content script 里没有 chrome.runtime.openOptionsPage，
  // 页内开关的「设置」按钮经这条消息由后台代开
  [CT.MSG.OPEN_OPTIONS]: async () => {
    try {
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }
};

function updateBadge(tabId, msg) {
  try {
    const n = msg.translated || 0;
    const text = n > 0 ? String(Math.min(n, 9999)) : '';
    const key = (msg.phase || 'done') + '|' + text;
    const prev = badgeState.get(tabId);
    const now = Date.now();

    // 内容没变 → 不必重复下发；
    // 进行中的进度 → 最多 BADGE_MIN_MS 刷一次。
    // 每次 setBadgeText 都会引起浏览器 UI 的一次更新，长页面会产生上百次，
    // 而人眼根本分辨不出这种频率的计数变化。
    if (prev && prev.key === key) return;
    if (prev && msg.phase === 'working' && now - prev.at < BADGE_MIN_MS) return;

    badgeState.set(tabId, { key: key, at: now });

    const color = msg.phase === 'error' ? '#d9534f'
      : msg.phase === 'working' ? '#2f7fd4'
      : '#2fa96b';
    chrome.action.setBadgeBackgroundColor({ tabId, color });
    chrome.action.setBadgeText({ tabId, text });
  } catch (e) {
    // 标签页可能已关闭，忽略
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  const handler = handlers[msg.type];
  if (!handler) return false;

  Promise.resolve()
    .then(() => handler(msg, sender))
    .then((res) => sendResponse(res))
    .catch((e) => {
      console.error('[叠译] 处理消息失败：', msg.type, e);
      sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
    });

  return true; // 异步响应
});

/* ==================================================================
 * 右键菜单
 * ================================================================== */

const MENU_IDS = {
  TRANSLATE: 'ct-menu-translate',
  RESTORE: 'ct-menu-restore',
  MODE_BELOW: 'ct-menu-mode-below',
  MODE_REPLACE: 'ct-menu-mode-replace',
  MODE_HOVER: 'ct-menu-mode-hover',
  /* v1.7 新增 */
  SELECTION: 'ct-menu-selection',
  IMG_COPY: 'ct-menu-img-copy',
  IMG_OPEN: 'ct-menu-img-open'
};

chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_IDS.TRANSLATE, title: '叠译：翻译此页面', contexts: ['page', 'selection'] });
    chrome.contextMenus.create({ id: MENU_IDS.RESTORE, title: '叠译：还原原文', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'ct-sep', type: 'separator', contexts: ['page'] });
    chrome.contextMenus.create({ id: MENU_IDS.MODE_BELOW, title: '显示方式：原文下方双语', contexts: ['page'] });
    chrome.contextMenus.create({ id: MENU_IDS.MODE_REPLACE, title: '显示方式：仅显示译文', contexts: ['page'] });
    chrome.contextMenus.create({ id: MENU_IDS.MODE_HOVER, title: '显示方式：悬停查看译文', contexts: ['page'] });

    /*
     * v1.7：划词的右键入口。
     * 存在的意义是「可发现性」—— 页内开关的 ⋯ 菜单里没有划词这一项，
     * 而用户不一定知道「选中就能翻」。右键菜单是最自然的学习路径。
     */
    chrome.contextMenus.create({ id: 'ct-sep-sel', type: 'separator', contexts: ['selection'] });
    chrome.contextMenus.create({ id: MENU_IDS.SELECTION, title: '叠译：翻译选中的文字', contexts: ['selection'] });

    /*
     * v1.7：图片入口。
     * ------------------------------------------------------------------
     * 这里【刻意】没有「翻译这张图片」。桌面版 Chrome 没有可用的
     * TextDetector（官方 roadmap 指向 Chrome 168 / 2027），本地 WASM OCR
     * 要额外背 13–19MB 包体、云端 OCR 又要破坏「内容不出机」的承诺。
     * 所以只提供两条「把图片交给别的工具」的短路径 ——
     * 与其给一个转圈然后失败的按钮，不如给用户一条走得通的路。
     */
    chrome.contextMenus.create({ id: 'ct-sep-img', type: 'separator', contexts: ['image'] });
    chrome.contextMenus.create({ id: MENU_IDS.IMG_COPY, title: '叠译：复制图片地址（可交给外部 OCR）', contexts: ['image'] });
    chrome.contextMenus.create({ id: MENU_IDS.IMG_OPEN, title: '叠译：在新标签页打开此图片', contexts: ['image'] });
  });

  // 主动补注入。放在 loadSettings 之前【同步发起】：MV3 的 service worker 在
  // 空闲 30 秒后被回收，而 listener 返回的 Promise 并不会被等待 ——
  // 唯一的保命手段是尽早发起一个扩展 API 调用，让计时器被刷新。
  // 安装（install）与更新（update）都要做：前者让「装完就能用」成立，
  // 后者让「更新后不必刷新」成立。
  reinjectAllTabs(details.reason).catch((e) => {
    console.warn('[叠译] 主动补注入失败：', e);
  });

  await loadSettings(true);

  // PDF 拦截规则依赖 settings.pdfEnabled，所以必须在设置就绪之后注册
  registerPdfRule();

  if (details.reason === 'install') {
    /*
     * 安装事件（v1.8.0）：只在**首次安装**时上报一次，供后台统计安装量。
     * ------------------------------------------------------------------
     * 为什么必须先 await report.startup()：
     *   startup() 会从 storage 载入既有聚合，若 install 事件先记录、startup
     *   后执行，刚记下的事件会被从存储读回的聚合覆盖掉 —— 事件静默丢失。
     * 幂等在 report.installOnce 内部（local['ct.installReported'] + 会话内存闸），
     * 因此 onInstalled 重复触发也不会重复计数。
     */
    try {
      await report.startup();
      await report.installOnce(chrome.runtime.getManifest().version);
    } catch (e) {
      console.warn('[叠译] 安装事件上报失败（不影响功能）：', e);
    }
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html?welcome=1') });
  }
});

/** 把图片地址复制到剪贴板。service worker 里没有剪贴板 API，只能委托页面执行。 */
async function copyImageUrlToTab(tabId, url) {
  if (!url) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: function (u) {
        // 双路径：剪贴板 API 需要页面处于安全上下文且有用户激活；
        // 失败就退回 textarea + execCommand，那条路更老但更宽容。
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(u);
            return;
          }
        } catch (e) { /* 落到下面 */ }
        try {
          var ta = document.createElement('textarea');
          ta.value = u;
          ta.setAttribute('readonly', '');
          ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        } catch (e) { /* 页面拒绝，静默 */ }
      },
      args: [url]
    });
  } catch (e) {
    // 受限页面（chrome://、应用商店）无法注入 —— 静默失败即可，
    // 用户还可以用「在新标签页打开此图片」那条路
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id === undefined) return;

  /* ---- v1.7：图片两项不经过内容脚本，直接由后台处理 ---- */
  if (info.menuItemId === MENU_IDS.IMG_OPEN) {
    if (info.srcUrl) chrome.tabs.create({ url: info.srcUrl });
    return;
  }
  if (info.menuItemId === MENU_IDS.IMG_COPY) {
    copyImageUrlToTab(tab.id, info.srcUrl);
    return;
  }

  let cmd = null;
  if (info.menuItemId === MENU_IDS.TRANSLATE) cmd = { action: 'translateNow' };
  // 右键「翻译选中的文字」→ 让内容脚本用它自己的选区走划词链路，
  // 而不是把 info.selectionText 传过去。两条路都要经过同一套
  // 掩码保护 / 术语表 / 缓存，走选区那条更不容易漂移。
  else if (info.menuItemId === MENU_IDS.SELECTION) cmd = { action: 'selectionTranslate' };
  else if (info.menuItemId === MENU_IDS.RESTORE) cmd = { action: 'restore' };
  else if (info.menuItemId === MENU_IDS.MODE_BELOW) cmd = { action: 'setDisplayMode', value: 'below' };
  else if (info.menuItemId === MENU_IDS.MODE_REPLACE) cmd = { action: 'setDisplayMode', value: 'replace' };
  else if (info.menuItemId === MENU_IDS.MODE_HOVER) cmd = { action: 'setDisplayMode', value: 'hover' };
  if (!cmd) return;

  sendCommandToTab(tab.id, cmd);
});

/* ==================================================================
 * 快捷键
 * ================================================================== */

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!tab || tab.id === undefined) return;

  if (command === 'toggle-translate') {
    sendCommandToTab(tab.id, { action: 'toggle' });
    return;
  }
  if (command === 'toggle-mode') {
    const s = await loadSettings();
    const order = ['below', 'replace', 'hover'];
    const i = order.indexOf(s.displayMode);
    const next = order[(i + 1) % order.length];
    await saveSettings({ displayMode: next });
    sendCommandToTab(tab.id, { action: 'setDisplayMode', value: next });
  }
});

/**
 * 往标签页发指令。若内容脚本尚未注入（扩展刚安装、或页面在安装前已打开），
 * 先补注入一次再重试 —— 否则用户会看到「毫无反应」。
 */
async function sendCommandToTab(tabId, cmd) {
  const message = { type: CT.MSG.CMD, cmd: cmd };
  try {
    const res = await chrome.tabs.sendMessage(tabId, message);
    return res || { ok: true };
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: CONTENT_FILES
      });
      await chrome.scripting.insertCSS({ target: { tabId: tabId }, files: [CONTENT_CSS] });
      const res2 = await chrome.tabs.sendMessage(tabId, message);
      return res2 || { ok: true };
    } catch (e2) {
      console.warn('[叠译] 无法在当前页面注入翻译脚本：', e2);
      return { ok: false, error: '当前页面不支持扩展注入（如浏览器内置页、应用商店页面）' };
    }
  }
}

/* ==================================================================
 * 安装 / 更新后的主动补注入
 * ==================================================================
 * Chrome 的默认行为是：content_scripts 只在【页面加载时】注入。
 * 也就是说，扩展刚装好、或刚刚更新到新版本，那些【已经开着】的标签页
 * 里没有任何内容脚本 —— 用户不刷新页面就永远看不到译文，而且他会以为
 * 扩展坏了（因为工具栏图标点了也没反应，兜底链要先跑一遍注入）。
 *
 * 所以这里在 onInstalled 时主动把内容脚本补进所有已打开的网页。
 * 这也是需求「不用刷新页面就出现译文」的前半段：后半段是 content/guard.js
 * 的注入守卫改造 —— 只有守卫允许新版本脚本接管，这两步才算真正闭环。
 */

async function reinjectAllTabs(reason) {
  let tabs = [];
  try {
    // url 过滤依赖 host_permissions（http/https 已全量声明），
    // 因此无需额外的 "tabs" 权限也能拿到这批标签页的 url 与 status
    tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  } catch (e) {
    console.warn('[叠译] 无法枚举已打开标签页：', e);
    return { attempted: 0, candidates: 0, injected: 0, failed: 0 };
  }

  const targets = [];
  for (const t of tabs) {
    if (!t || t.id === undefined || t.id === null) continue;
    // 还在加载中的页面不必补：它加载到 document_idle 时 content_scripts 自然会注入。
    // 硬插进去反而要在 DOM 未就绪时初始化，得不偿失。
    if (t.status && t.status !== 'complete') continue;
    targets.push(t.id);
  }

  let injected = 0;
  let failed = 0;
  await mapLimit(targets, 4, async (tabId) => {
    const r = await sendCommandToTab(tabId, { action: 'applySettings' });
    if (r && r.ok) injected++;
    else failed++;
  });

  console.info(
    '[叠译] ' + (reason || 'install') + '：已对 ' + injected + ' / ' + targets.length
    + ' 个已打开页面补注入（候选 ' + tabs.length + ' 个标签页）'
  );
  return { attempted: tabs.length, candidates: targets.length, injected: injected, failed: failed };
}

// 供 popup 复用同一套注入逻辑（已并入 handlers，见上方 CT.MSG.SEND_COMMAND）

/* ==================================================================
 * 生命周期
 * ================================================================== */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// service worker 被回收前的最后一搏：把内存里的脏缓存落盘。
// 注意 MV3 的 SW 没有可靠的卸载钩子，因此主链路本身也会在每轮翻译后主动 flush，
// 这里只是兜底。
if (chrome.runtime.onSuspend && chrome.runtime.onSuspend.addListener) {
  chrome.runtime.onSuspend.addListener(() => {
    cache.flush().catch(() => {});
  });
}

// 首次唤醒即预热设置
loadSettings(true).catch((e) => console.warn('[叠译] 初始化失败：', e));

// 匿名埋点：启动补发（跨日/离线队列）。非阻塞、静默降级。
// 安装事件（install）由 onInstalled 在 await 本函数之后单独记录，见上。
report.startup().catch(() => {});

/*
 * PDF 拦截规则的「每次都注册」。
 * ------------------------------------------------------------------
 * MV3 的 service worker 会在空闲约 30 秒后被回收，重启时 onInstalled
 * **不会**再次触发，而动态 DNR 规则是持久化的 —— 看起来不需要重装。
 * 但仍然要在这里再跑一次，理由有两个：
 *   1) 用户在设置页关掉「PDF 双语对照」后，规则必须真的消失；
 *      而那次改动只可能在 SW 存活期内被观察到，重启后没人再确认过
 *   2) 规则写入可能失败（权限、并发），每次启动重来一遍是零成本的兜底
 * registerPdfRule 内部是「先 remove 再 add」，因此重复调用是安全的。
 */
registerPdfRule();
