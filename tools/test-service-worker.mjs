/*
 * 双语助手 · 后台服务集成自检
 * ------------------------------------------------------------------
 * 这一层此前没有测试：handleTranslate 不对外导出，而 service-worker.js
 * 在加载时就依赖 chrome.* API。这里用桩把运行环境补齐，再通过
 * chrome.runtime.onMessage 注册的监听器把消息打进去 —— 也就是真实调用路径。
 *
 * 重点验证本次性能优化引入的几处行为变更：
 *   1. 批次内按原文去重后，重复文本只消耗一次请求
 *   2. 译文能正确扇出回所有原始下标（去重不能造成错位或丢项）
 *   3. 引擎解析结果透传 + 可用性记忆，使可用性查询次数与批次数量解耦
 *   4. 缓存命中时不发请求
 *   5. 标签页徽标下发被节流
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
/* 桩：chrome.* / self / fetch                                          */
/* ================================================================== */

const calls = {
  fetch: 0, qs: [], badgeText: [], badgeColor: [], avail: 0,
  tabQuery: [], tabSend: [], injected: 0, created: [],
  reportPosts: []          // v1.8.0：匿名埋点出站（与翻译请求分开记，便于断言）
};
const listeners = {};
let storedSettings = { provider: 'google-free', cacheEnabled: true, sourceLang: 'en', targetLang: 'zh-CN' };
/** v1.8.0：chrome.storage.session 的桩（translated 基线镜像） */
const sessionStore = new Map();
let storedMigrations = {};   // 模拟 chrome.storage 里的 ctMigrations（迁移标记）
let lastSyncWrite = null;    // 最近一次 sync.set 的载荷，供迁移断言用
let storageSetCount = 0;

/**
 * 标签页夹具。刻意混入一个 status=loading 的页面：
 * 主动补注入必须跳过它 —— 它自己加载到 document_idle 时会注入，
 * 硬插进去只会在 DOM 未就绪时初始化。
 * 2 号标签页刻意让 sendMessage 抛错，用来验证兜底注入链真的会跑。
 */
const tabFixture = [
  { id: 1, status: 'complete', url: 'https://a.example/' },
  { id: 2, status: 'complete', url: 'https://b.example/' },
  { id: 3, status: 'loading', url: 'https://c.example/' },
  { id: 4, status: 'complete', url: 'https://d.example/' }
];

globalThis.self = globalThis;
// Service Worker 的 install / activate 钩子只在真实 SW 环境里触发，
// 这里只需要它存在，不需要真的被调用
globalThis.addEventListener = () => {};
globalThis.skipWaiting = async () => {};
globalThis.clients = { claim: async () => {} };
globalThis.chrome = {
  storage: {
    sync: {
      get: async () => ({ settings: storedSettings, ctMigrations: storedMigrations }),
      set: async (o) => {
        storageSetCount++;
        lastSyncWrite = o;
        // 让 mock 存储像真的一样回写：迁移落盘后标记必须能被下次读到
        if (o && o.settings) storedSettings = o.settings;
        if (o && o.ctMigrations) storedMigrations = o.ctMigrations;
      }
    },
    session: {
      get: async (k) => {
        const keys = Array.isArray(k) ? k : [k];
        const out = {};
        for (const kk of keys) if (sessionStore.has(kk)) out[kk] = sessionStore.get(kk);
        return out;
      },
      set: async (o) => { for (const k of Object.keys(o)) sessionStore.set(k, o[k]); },
      remove: async (k) => { const keys = Array.isArray(k) ? k : [k]; for (const kk of keys) sessionStore.delete(kk); }
    },
    local: {
      get: async () => ({}),
      set: async (o) => { storageSetCount++; void o; },
      remove: async () => {}
    }
  },
  tabs: {
    onRemoved: { addListener: (fn) => { listeners.tabRemoved = fn; } },
    onUpdated: { addListener: (fn) => { listeners.tabUpdated = fn; } },
    query: async (q) => { calls.tabQuery.push(q); return tabFixture; },
    sendMessage: async (tabId, msg) => {
      calls.tabSend.push({ tabId, msg });
      // 2 号标签页模拟「内容脚本尚未注入」：消息送达失败
      if (tabId === 2) throw new Error('Could not establish connection.');
      return { ok: true };
    },
    create: async (o) => { calls.created.push(o); return { id: 99 }; }
  },
  action: {
    setBadgeBackgroundColor: (o) => calls.badgeColor.push(o),
    setBadgeText: (o) => calls.badgeText.push(o)
  },
  contextMenus: {
    removeAll: () => {},
    create: () => {},
    onClicked: { addListener() {} }
  },
  commands: { onCommand: { addListener() {} } },
  scripting: {
    executeScript: async () => { calls.injected++; },
    insertCSS: async () => {}
  },
  runtime: {
    onMessage: { addListener: (fn) => { listeners.msg = fn; } },
    onInstalled: { addListener: (fn) => { listeners.installed = fn; } },
    onSuspend: { addListener() {} },
    getManifest: () => ({ version: '1.8.0' }),
    getURL: (p) => p,
    openOptionsPage: async () => { calls.openOptions = (calls.openOptions || 0) + 1; },
    lastError: null
  }
};

// 内置模型桩：availability 每次调用都计数，用来验证「记忆」是否生效
globalThis.Translator = {
  availability: async () => { calls.avail++; return 'unavailable'; },
  create: async () => ({ translate: async (t) => '内置:' + t })
};

globalThis.fetch = async (url, init) => {
  // v1.8.0：埋点出站（dev 端点 127.0.0.1:7791）与翻译引擎请求分开处理
  if (init && init.headers && init.headers['X-Dieyi-Client']) {
    let parsed = null;
    try { parsed = JSON.parse(init && init.body); } catch (e) { parsed = null; }
    calls.reportPosts.push({ url, body: parsed, headers: (init && init.headers) || {} });
    return { ok: true, status: 202, headers: { get: () => null } };
  }
  calls.fetch++;
  const body = new URLSearchParams(init && init.body ? init.body : '');
  const q = body.get('q') || '';
  calls.qs.push(q);
  // v1.7.4 Q2 测试桩：按原文前缀模拟引擎的三类行为
  //   'EMPTY please …'            → 引擎返回空译（触发 Q2 拒绝 + 重试）
  //   'Review <url> …' 的掩码串   → 引擎吞掉占位符（触发 maskLoss + Q2 拒绝）
  //   'KEEPME identical'          → 引擎原样返回（触发 sameAsSrc 计数，不拦截）
  let t = '〔' + q + '〕';
  if (q === 'EMPTY please ignore') t = '';
  else if (q.indexOf('\uE000') >= 0 && q.indexOf('REVIEWIT ') === 0) t = q.replace(/[\uE000-\uF8FF]/g, '');
  else if (q === 'KEEPME identical') t = q;
  return {
    ok: true,
    status: 200,
    json: async () => ([[[t, q, null, null, 10]], null, 'en'])
  };
};

/** 按真实调用路径发消息：走 SW 注册的 onMessage 监听器 */
function send(msg, sender) {
  return new Promise((resolve) => {
    listeners.msg(msg, sender || { tab: { id: 7 } }, resolve);
  });
}

/* ================================================================== */

await import('../background/service-worker.js');
// SW 加载时会异步预热设置，等它落定
await new Promise((r) => setTimeout(r, 30));

section('一、批次内去重');
{
  calls.fetch = 0; calls.qs = [];
  const items = [
    { text: 'Alpha one' },
    { text: 'Beta two' },
    { text: 'Alpha one' },      // 重复
    { text: 'Gamma three' },
    { text: 'Beta two' },       // 重复
    { text: 'Alpha one' }       // 重复
  ];
  const res = await send({
    type: 'ct:translate', source: 'en', target: 'zh-CN', items
  });

  eq('6 条输入只发 3 次请求（重复项被合并）', calls.fetch, 3);
  eq('去重计数正确', res.deduped, 3);
  eq('没有缓存命中', res.cached, 0);
  eq('译文条数与输入一致', res.translations.length, 6);
  ok('重复项拿到了同一份译文', res.translations[0] === res.translations[2]
    && res.translations[0] === res.translations[5], JSON.stringify(res.translations));
  ok('不同原文的译文没有串位', res.translations[1] === '〔Beta two〕'
    && res.translations[3] === '〔Gamma three〕', JSON.stringify(res.translations));
  ok('重复项不会被重复送入接口', calls.qs.filter((t) => t === 'Alpha one').length === 1,
    JSON.stringify(calls.qs));
}

section('二、缓存命中');
{
  const before = calls.fetch;
  const res = await send({
    type: 'ct:translate', source: 'en', target: 'zh-CN',
    items: [{ text: 'Alpha one' }, { text: 'Beta two' }]
  });
  eq('已译过的原文不再发请求', calls.fetch, before);
  eq('全部命中缓存', res.cached, 2);
  ok('缓存返回的译文正确', res.translations[0] === '〔Alpha one〕', JSON.stringify(res.translations));
}

section('三、引擎解析不随批次重复');
{
  // 换成 auto：需要查询内置模型可用性；批大小为 1（google-free 回退），
  // 若没有做「解析结果透传 + 可用性记忆」，查一次会变成查 N 次。
  storedSettings = { provider: 'auto', cacheEnabled: false, sourceLang: 'en', targetLang: 'zh-CN' };
  await send({ type: 'ct:set-settings', patch: { provider: 'auto', cacheEnabled: false } });
  calls.avail = 0;
  calls.fetch = 0;

  const items = [];
  for (let i = 0; i < 12; i++) items.push({ text: 'Unique sentence ' + i });

  const res = await send({ type: 'ct:translate', source: 'en', target: 'zh-CN', items });
  eq('12 条唯一文本切成 12 批', calls.fetch, 12);
  eq('可用性查询只发生 1 次（记忆生效）', calls.avail, 1);
  ok('每批译文都正确落位',
    res.translations.every((t, i) => t === '〔Unique sentence ' + i + '〕'), JSON.stringify(res.translations));
}

section('四、提交给标签页的徽标被节流');
{
  /* v1.8.0：SW 被回收后再唤醒，必须从 storage.session 取回基线。
   * 否则首次 REPORT 会把整页累计值当增量发 ⇒ 这一页被重复计一次。 */
  sessionStore.set('ct.txBase', { '98:0': 100 });
  const restored = await send({
    type: 'ct:report', phase: 'done', translated: 130, units: 200,
    provider: 'google-free', sourceLang: 'en', targetLang: 'zh-CN', mode: 'below'
  }, { tab: { id: 98 }, frameId: 0 });
  eq('SW 唤醒后从 session 恢复基线：130-100 → 发 30（不是 130）', restored.translated, 30);

  const before = calls.badgeText.length;
  for (let i = 1; i <= 20; i++) {
    await send({
      type: 'ct:report', phase: 'working', translated: i,
      units: i, provider: 'google-free', sourceLang: 'en', targetLang: 'zh-CN', mode: 'below'
    }, { tab: { id: 7 } });
  }
  const emitted = calls.badgeText.length - before;
  ok('20 次进度上报最多只下发 3 次徽标（实际 ' + emitted + '）', emitted <= 3);

  // 终态必须下发，否则徽标会停在中间值
  const mid = calls.badgeText.length;
  await send({
    type: 'ct:report', phase: 'done', translated: 20,
    units: 20, provider: 'google-free', sourceLang: 'en', targetLang: 'zh-CN', mode: 'below'
  }, { tab: { id: 7 } });
  ok('终态徽标一定下发', calls.badgeText.length > mid);
  eq('徽标文本是最终段数', calls.badgeText[calls.badgeText.length - 1].text, '20');
}

section('四之二、translated 累计值 → 增量（v1.8.0）');
{
  /*
   * 背景：content 发的是**本页累计**成功段数，日批对数值字段求和。
   * 直接上报累计值 ⇒ 同一页翻两次记两倍。SW 侧按 tab 记基线改发增量。
   * 断言全部走真实消息链路（onMessage → REPORT handler），用 handler 回带的
   * translated（= 本次实际写进日批的值）判，不读内部变量。
   */
  const rep1 = (tabId, translated, phase) => send({
    type: 'ct:report', phase: phase || 'done', translated: translated,
    units: translated, provider: 'google-free', sourceLang: 'en', targetLang: 'zh-CN', mode: 'below'
  }, { tab: { id: tabId } });

  const a1 = await rep1(91, 10);
  eq('首次上报（无基线）→ 原值 10', a1.translated, 10);
  const a2 = await rep1(91, 25);
  eq('同 tab 累计 10→25 → 只发增量 15（不是 25）', a2.translated, 15);

  const a3 = await rep1(91, 5);
  eq('同 tab 累计回落 25→5（页面重置）→ 按原值发 5', a3.translated, 5);
  const a4 = await rep1(91, 9);
  eq('重置后继续累计 5→9 → 增量 4', a4.translated, 4);

  const b1 = await rep1(92, 10);
  eq('tab 92 首次 → 10', b1.translated, 10);
  listeners.tabRemoved(92);
  const b2 = await rep1(92, 10);
  eq('tab 关闭后同 id 首次上报 → 基线已清，按原值发 10', b2.translated, 10);

  const c1 = await rep1(93, 10);
  eq('tab 93 首次 → 10', c1.translated, 10);
  listeners.tabUpdated(93, { status: 'loading', url: 'https://nav.example/' });
  const c2 = await rep1(93, 10);
  eq('导航（loading+url）后同 tab 再报 → 基线已清，按原值发 10', c2.translated, 10);

  const d1 = await rep1(94, 8);
  eq('tab 94 首次 → 8', d1.translated, 8);
  listeners.tabUpdated(94, { status: 'loading' });     // 刷新：loading 但无 url
  const d2 = await rep1(94, 8);
  eq('刷新（loading 无 url）后 → 基线已清，按原值发 8', d2.translated, 8);

  const e1 = await rep1(95, 12);
  eq('tab 95 首次 → 12', e1.translated, 12);
  listeners.tabUpdated(95, { url: 'https://spa.example/route2' });   // SPA 路由变化
  const e2 = await rep1(95, 12);
  eq('SPA 路由变化（仅 url）后 → 基线已清，按原值发 12', e2.translated, 12);

  /* all_frames=true：每个 iframe 各有一份 stats，基线必须按 frameId 分开。
   * 混用会把「B frame 的较小值」当成 A frame 的回落，增量被吃掉（少记）。 */
  const frameRep = (frameId, translated) => send({
    type: 'ct:report', phase: 'done', translated: translated,
    units: translated, provider: 'google-free', sourceLang: 'en', targetLang: 'zh-CN', mode: 'below'
  }, { tab: { id: 96 }, frameId: frameId });
  const f0a = await frameRep(0, 10);
  eq('tab96/frame0 首次 → 10', f0a.translated, 10);
  const f1a = await frameRep(1, 8);
  eq('tab96/frame1 首次 → 8（不被 frame0 的 10 影响，不判成回落）', f1a.translated, 8);
  const f0b = await frameRep(0, 15);
  eq('tab96/frame0 累计 10→15 → 增量 5（基线按 frame 隔离）', f0b.translated, 5);
  const f1b = await frameRep(1, 8);
  eq('tab96/frame1 累计 8→8 → 增量 0', f1b.translated, 0);

  // 基线镜像：SW 被回收后再唤醒要靠它续算（否则重复计一次）
  await new Promise((r) => setTimeout(r, 400));
  const baseMap = sessionStore.get('ct.txBase') || {};
  eq('基线已落 chrome.storage.session（91:0 = 9）', baseMap['91:0'], 9);
  eq('基线含 frame 维度（96:1 = 8）', baseMap['96:1'], 8);

  // 线上弹窗仍看累计值：tabStats 不得被增量污染
  const stats91 = await send({ type: 'ct:get-tab-stats', tabId: 91 });
  eq('tabStats.translated 仍是累计值 9（未被增量改写）', stats91.stats && stats91.stats.translated, 9);
}

section('五、存储写入节流');
{
  storedSettings = { provider: 'google-free', cacheEnabled: true, sourceLang: 'en', targetLang: 'zh-CN' };
  await send({ type: 'ct:set-settings', patch: { provider: 'google-free', cacheEnabled: true } });
  calls.fetch = 0;
  const before = storageSetCount;

  // 连续多轮翻译：旧实现每轮强制落盘一次
  for (let round = 0; round < 6; round++) {
    const items = [];
    for (let i = 0; i < 20; i++) items.push({ text: 'R' + round + '-sentence ' + i });
    await send({ type: 'ct:translate', source: 'en', target: 'zh-CN', items });
  }
  const writes = storageSetCount - before;
  ok('6 轮 × 20 条只产生少量存储写入（实际 ' + writes + '）', writes <= 4);
  ok('去重与节流没有影响译文完整性', calls.fetch === 120);
}

section('六、安装 / 更新后主动补注入');
{
  // 这是需求「不用刷新页面就出现译文」的前半段：
  // 没有这一步，装好扩展后那些已经开着的标签页里根本没有内容脚本。
  calls.tabQuery.length = 0;
  calls.tabSend.length = 0;
  calls.injected = 0;
  calls.created.length = 0;

  await listeners.installed({ reason: 'update' });
  // reinjectAllTabs 是「同步发起、不等结果」的：listener 返回时它还在跑
  await new Promise((r) => setTimeout(r, 150));

  eq('主动查询了可注入的标签页', calls.tabQuery.length, 1);
  eq('查询限定在 http / https（不碰浏览器内置页）',
    JSON.stringify(calls.tabQuery[0].url), JSON.stringify(['http://*/*', 'https://*/*']));

  const synced = calls.tabSend.filter((c) => c.msg && c.msg.cmd && c.msg.cmd.action === 'applySettings');
  const syncedIds = new Set(synced.map((c) => c.tabId));
  eq('3 个已加载完成的页面都被同步到', syncedIds.size, 3);
  eq('2 号因消息失败被「兜底注入 + 重试」了两次',
    synced.filter((c) => c.tabId === 2).length, 2);
  eq('其余页面各只发一次（不重复打扰）',
    synced.filter((c) => c.tabId !== 2).length, 2);
  ok('跳过了 status=loading 的标签页（它自己会注入）',
    !calls.tabSend.some((c) => c.tabId === 3),
    JSON.stringify(calls.tabSend.map((c) => c.tabId)));
  ok('对全部候选标签页都做了尝试（含消息失败的 2 号）',
    [1, 2, 4].every((id) => calls.tabSend.some((c) => c.tabId === id)),
    JSON.stringify(calls.tabSend.map((c) => c.tabId)));

  // 2 号标签页消息失败 → 必须走 executeScript 兜底，否则它永远拿不到内容脚本
  ok('消息失败的标签页走了兜底注入链', calls.injected >= 1, 'injected=' + calls.injected);

  eq('update 时不打开欢迎页', calls.created.length, 0);

  // install 场景：同样补注入，并且会打开欢迎页
  calls.tabSend.length = 0;
  await listeners.installed({ reason: 'install' });
  await new Promise((r) => setTimeout(r, 150));
  ok('install 时同样补注入', calls.tabSend.length > 0);
  eq('install 打开一次欢迎页', calls.created.length, 1);
  ok('欢迎页指向设置页', String(calls.created[0].url).indexOf('options/options.html') >= 0,
    String(calls.created[0].url));

  /* v1.8.0：安装事件必须**真的发出去**（不是只写本地聚合）
   * 判据：走 onInstalled(reason='install') 这条真实链路后，dev 端点上出现
   * 一条通道 B 日批，且 events 内含 install / props.ver === manifest.version。 */
  const installPost = calls.reportPosts.find((r) => r.body
    && r.body.kind === 'daily'
    && Array.isArray(r.body.events)
    && r.body.events.some((e) => e && e.ev === 'install'));
  ok('安装事件真的走到了出站（127.0.0.1 收到 daily 批次）', !!installPost,
    JSON.stringify(calls.reportPosts.map((r) => r.body && r.body.kind)));
  if (installPost) {
    const ev = installPost.body.events.find((e) => e && e.ev === 'install');
    eq('install.props.ver === manifest.version', ev.props && ev.props.ver, '1.8.0');
    ok('通道 B 带 anon + day', !!installPost.body.anon && !!installPost.body.day,
      JSON.stringify({ anon: installPost.body.anon, day: installPost.body.day }));
    ok('带 X-Dieyi-Client 头', !!installPost.headers['X-Dieyi-Client']);
    ok('日批顶层带 did（UUIDv4，安装期固定）',
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(installPost.body.did)),
      String(installPost.body.did));
    ok('did 与 bid 是两个不同的标识', installPost.body.did !== installPost.body.bid,
      JSON.stringify({ did: installPost.body.did, bid: installPost.body.bid }));
    ok('出站请求体不含原文/网址字段（只有 ev/props）',
      installPost.body.events.every((e) => Object.keys(e).sort().join(',') === 'ev,props'),
      JSON.stringify(installPost.body.events));
  }
  const countInstallPosts = () => calls.reportPosts.filter((r) => r.body && Array.isArray(r.body.events)
    && r.body.events.some((e) => e && e.ev === 'install')).length;
  const firstCount = countInstallPosts();
  eq('首次安装产生 1 条 install 批次', firstCount, 1);

  // 幂等：同一浏览器实例再次触发 onInstalled(install) → 不得重复计数
  await listeners.installed({ reason: 'install' });
  await new Promise((r) => setTimeout(r, 150));
  eq('重复触发 onInstalled(install) 不再产生 install 批次', countInstallPosts(), firstCount);
}

section('七、页内开关的设置入口');
{
  // content script 里没有 chrome.runtime.openOptionsPage，必须由后台代开。
  // 这条链路断了，页内开关上的齿轮按钮就是死的。
  calls.openOptions = 0;
  const res = await send({ type: 'ct:open-options' }, { tab: { id: 7 } });
  eq('open-options 返回成功', res.ok, true);
  eq('后台确实调了 openOptionsPage', calls.openOptions, 1);
}

section('八、v1.7.1 一次性迁移：autoTranslate 旧默认值被持久化');
{
  // 复现「改了默认值怎么还自动翻译」：saveSettings 落盘的是全量设置，
  // 老安装的存储里躺着 autoTranslate: true（旧默认值被持久化的结果），
  // merge(DEFAULT_SETTINGS, stored) 永远被旧数据覆盖。
  storedSettings = { provider: 'google-free', cacheEnabled: true,
    sourceLang: 'en', targetLang: 'zh-CN', autoTranslate: true };
  storedMigrations = {};      // 迁移未跑过

  let res = await send({ type: 'ct:set-settings', patch: {} });  // saveSettings 会强制从存储重读
  eq('老安装首次加载：autoTranslate 被迁移为 false', res.settings.autoTranslate, false);
  eq('迁移标记已落进存储', storedMigrations.autoTranslateDefaultOff, true);
  eq('迁移后的设置也已落盘（存储里不再是 true）', storedSettings.autoTranslate, false);

  // 迁移完成后用户主动打开：必须被尊重，不得再被强行关闭
  storedSettings.autoTranslate = true;
  res = await send({ type: 'ct:set-settings', patch: {} });
  eq('迁移完成后用户的显式选择（true）被尊重', res.settings.autoTranslate, true);
  eq('尊重用户选择时不再改写迁移标记', storedMigrations.autoTranslateDefaultOff, true);

  // 幂等：迁移标记在，即使存储又被改回 true 也不会二次强改 ——
  // 二次强改会让「用户打开」这个动作永远存不住
  storedSettings.autoTranslate = true;
  res = await send({ type: 'ct:get-settings' });
  eq('迁移只跑一次（get-settings 走缓存，不再强改）', res.settings.autoTranslate, true);
}

section('九、v1.7.4 C-13 Q3：用户纠错短路（先于缓存与引擎）');
{
  // 干净起点：关缓存，避免前几节留下的缓存条目干扰
  storedSettings = { provider: 'google-free', cacheEnabled: false, sourceLang: 'en', targetLang: 'zh-CN' };
  await send({ type: 'ct:set-settings', patch: {
    provider: 'google-free', cacheEnabled: false,
    corrections: [{ from: 'Broken phrase', to: '修正后的句子', at: 1 }]
  } });
  calls.fetch = 0; calls.qs = [];

  const res = await send({
    type: 'ct:translate', source: 'en', target: 'zh-CN',
    items: [{ text: 'Broken phrase' }, { text: 'Broken phrase' }, { text: 'Fresh line' }]
  });
  eq('纠错命中 + 引擎各 1 次 = 只发 1 次请求', calls.fetch, 1);
  ok('纠错条目直接采用用户译文',
    res.translations[0] === '修正后的句子' && res.translations[1] === '修正后的句子',
    JSON.stringify(res.translations));
  eq('纠错命中计数 = 2', res.metrics.corrected, 2);
  // v1.7.5（C-17 F1）：本次请求的纠错命中数随响应带回，页面侧拼 badge 用
  eq('响应带 corrections 字段（本轮命中 2）', res.corrections, 2);
  ok('未纠错的原文照常走引擎', res.translations[2] === '〔Fresh line〕', JSON.stringify(res.translations));

  /* 纠错优先级必须高于缓存：先把 Cache victim 灌进缓存，再加纠错 */
  await send({ type: 'ct:set-settings', patch: { cacheEnabled: true, corrections: [] } });
  await send({ type: 'ct:translate', source: 'en', target: 'zh-CN', items: [{ text: 'Cache victim' }] });
  await send({ type: 'ct:set-settings', patch: {
    cacheEnabled: true, corrections: [{ from: 'Cache victim', to: '你说了算', at: 2 }] } });
  calls.fetch = 0;
  const res2 = await send({
    type: 'ct:translate', source: 'en', target: 'zh-CN', items: [{ text: 'Cache victim' }]
  });
  eq('有纠错时缓存里的旧错译不再出场（零请求）', calls.fetch, 0);
  eq('缓存之上的纠错译文返回给页面', res2.translations[0], '你说了算');
}

section('十、v1.7.4 C-13 Q3：SAVE_CORRECTION 落库');
{
  await send({ type: 'ct:set-settings', patch: { corrections: [] } });

  const r1 = await send({ type: 'ct:save-correction', from: 'Hello world', to: '你好，世界' });
  eq('保存成功', r1.ok, true);
  let gs = await send({ type: 'ct:get-settings' });
  let list = gs.settings.corrections || [];
  eq('条目写入 corrections 键', list.length, 1);
  eq('原文正确', list[0].from, 'Hello world');
  eq('译文正确', list[0].to, '你好，世界');

  await send({ type: 'ct:save-correction', from: 'Hello world', to: '你好世界' });
  gs = await send({ type: 'ct:get-settings' });
  list = gs.settings.corrections || [];
  eq('同原文覆盖旧修正（不重复堆积）', list.length, 1);
  eq('覆盖后是最新译文', list[0].to, '你好世界');

  const r3 = await send({ type: 'ct:save-correction', from: 'x', to: '  ' });
  eq('空修正被拒绝', r3.ok, false);
  const r4 = await send({ type: 'ct:save-correction', from: '', to: 'y' });
  eq('空原文被拒绝', r4.ok, false);
}

section('十一、v1.7.4 C-12 Q2：译后产出自检 + 一次重试');
{
  storedSettings = { provider: 'google-free', cacheEnabled: false, sourceLang: 'en', targetLang: 'zh-CN' };
  await send({ type: 'ct:set-settings', patch: { provider: 'google-free', cacheEnabled: false } });

  /* 空译：拒绝 → 重试 → 仍坏 → 计失败、不上屏 */
  calls.fetch = 0;
  let res = await send({
    type: 'ct:translate', source: 'en', target: 'zh-CN',
    items: [{ text: 'EMPTY please ignore' }, { text: 'Good sentence' }]
  });
  eq('空译触发首试 + 重试共 3 次请求（两条首试 + 空译重试）', calls.fetch, 3);
  eq('重试仍坏：计 1 条失败', res.failures, 1);
  ok('坏产出不上屏（translations 留空 → 页面显示原文）', res.translations[0] === null, JSON.stringify(res.translations));
  ok('同批健康条目照常返回', res.translations[1] === '〔Good sentence〕', JSON.stringify(res.translations));
  ok('坏产出计数已累加（q2Rejects ≥ 2：两轮各 1）', res.metrics.q2Rejects >= 2, JSON.stringify(res.metrics));

  /* 占位符被引擎吞掉：同样拒绝，且不进缓存 */
  storedSettings = { provider: 'google-free', cacheEnabled: false, sourceLang: 'en', targetLang: 'zh-CN' };
  await send({ type: 'ct:set-settings', patch: { provider: 'google-free', cacheEnabled: false } });
  calls.fetch = 0;
  res = await send({
    type: 'ct:translate', source: 'en', target: 'zh-CN',
    items: [{ text: 'REVIEWIT see https://a.example/x for details' }]
  });
  ok('占位符丢失被识别为坏产出（maskLoss ≥ 2）', res.metrics.maskLoss >= 2, JSON.stringify(res.metrics));
  eq('占位符丢失同样重试了一次', calls.fetch, 2);

  /* 原样返回：只计数，不拦截（品牌名/代号原样返回是合法输出） */
  calls.fetch = 0;
  res = await send({
    type: 'ct:translate', source: 'en', target: 'zh-CN',
    items: [{ text: 'KEEPME identical' }]
  });
  ok('原样返回只计数不拒绝（sameAsSrc = 1）', res.metrics.sameAsSrc >= 1, JSON.stringify(res.metrics));
  eq('原样返回没有触发重试', calls.fetch, 1);
  ok('原样返回的译文照常上屏', res.translations[0] === 'KEEPME identical', JSON.stringify(res.translations));
}

/* ==================================================================
 * 十一之二、v1.8.0 免费版：术语不限量 + 商业层消息已下线
 * ================================================================== */
{
  section('十一之二、v1.8.0 免费版：术语不限量 + 商业层消息已下线');
  {
    await send({ type: 'ct:set-settings', patch: { provider: 'google-free', cacheEnabled: false, glossary: [] } });

    // 60 条术语全部生效（旧版有 50 条上限，超出会被裁掉）
    const terms = Array.from({ length: 60 }, (_, k) => ({ from: 'capw' + k, to: '译' + k }));
    await send({ type: 'ct:set-settings', patch: { glossary: terms } });
    const rAll = await send({ type: 'ct:translate', source: 'en', target: 'zh-CN', items: [{ text: 'capw55 is here' }] });
    ok('60 条术语全部生效（第 56 条按指定译名还原，无裁剪）',
      rAll.translations[0].indexOf('译55') >= 0, JSON.stringify(rAll.translations));
    ok('响应不再带 glossaryCapped 字段', !('glossaryCapped' in rAll), JSON.stringify(Object.keys(rAll)));

    // 商业层消息常量已删除（发送这些消息不再有处理器）
    for (const k of ['SAVE_LICENSE', 'REMOVE_LICENSE', 'GET_TRIAL_STATE', 'SET_TRIAL_CLOCK']) {
      ok('CT.MSG.' + k + ' 已删除', CT.MSG[k] === undefined, String(CT.MSG[k]));
    }
    const gs = await send({ type: 'ct:get-settings' });
    ok('settings 里不再有 pro / licenseCode 默认字段',
      !('pro' in gs.settings) && !('licenseCode' in gs.settings), JSON.stringify(Object.keys(gs.settings)));

    await send({ type: 'ct:set-settings', patch: { glossary: [] } });
  }
}

  /* ============ 十二、v1.7.6 C-23：引擎熔断器 ============
   * 引擎整体不可用时（挂起/不可达），连续 CB 阈值批失败 → 未开跑批次直接
   * 中止，响应落明确终态 + 可读 notice。没有它：285 批 × 30s 超时 ÷ 并发
   * 仍要烧 20+ 分钟——技术上会结束，用户视角就是假卡死。 */
  {
    section('十二、v1.7.6 C-23：引擎熔断器（连续失败中止全页）');
    const prevSettings = storedSettings;
    storedSettings = Object.assign({}, prevSettings, { provider: 'google-free', cacheEnabled: false, concurrency: 3 });
    const prevTimeout = CT.TRANSLATE_TIMEOUT_MS['google-free'];
    const prevCB = CT.ENGINE_CIRCUIT_BREAKER_FAILS;
    CT.TRANSLATE_TIMEOUT_MS['google-free'] = 200;   // 挂起桩 200ms 判超时
    CT.ENGINE_CIRCUIT_BREAKER_FAILS = 3;            // 连续 3 批失败即熔断

    const realFetch = globalThis.fetch;
    let hangCount = 0;
    globalThis.fetch = async () => { hangCount++; return new Promise(() => {}); }; // 引擎整体挂起

    const items = [];
    for (let i = 0; i < 12; i++) items.push({ text: 'hang me ' + i });
    const t0 = Date.now();
    const r = await send({ type: 'ct:translate', source: 'en', target: 'zh-CN', items: items });
    const elapsed = Date.now() - t0;

    ok('熔断后仍返回响应（管线不挂死）', r && r.ok === true);
    ok('全部条目计入失败', r && r.failures === 12, JSON.stringify({ failures: r && r.failures }));
    // C-60 文案人话化后对齐，2026-10-13：产品已把「连续无响应」改为「连续超时」，
    // 并把「熔断 / 更换引擎」等术语移除。断言做双向：正面钉真实稳定词，负面钉不得回退旧术语。
    ok('notice 写明服务连续超时（C-60 文案人话化后对齐，2026-10-13）',
      r && typeof r.notice === 'string' && r.notice.indexOf('连续超时') >= 0, r && r.notice);
    ok('notice 不得重现 C-60 已移除的术语（熔断 / 更换引擎）',
      r && typeof r.notice === 'string'
        && r.notice.indexOf('熔断') < 0
        && r.notice.indexOf('更换引擎') < 0
        && r.notice.indexOf('引擎配置') < 0, r && r.notice);
    ok('熔断提前中止（耗时远小于逐批烧超时）', elapsed < 5000, elapsed + 'ms');
    ok('未开跑的批次不再发请求（实际 fetch ' + hangCount + ' 次 < 12）', hangCount > 0 && hangCount < 12);

    globalThis.fetch = realFetch;
    CT.TRANSLATE_TIMEOUT_MS['google-free'] = prevTimeout;
    CT.ENGINE_CIRCUIT_BREAKER_FAILS = prevCB;

    // —— 熔断后的后续请求必须瞬时短路（不发起任何网络调用）——
    // 这是 C-23 修订的核心：content 侧分波发消息，若每波都重新烧超时，
    // 285 段 ≈ 12 波 × 60s，页面级永远看不到终态。
    const fetchBefore = hangCount;
    const t1 = Date.now();
    const r2 = await send({ type: 'ct:translate', source: 'en', target: 'zh-CN',
      items: [{ text: 'wave two a' }, { text: 'wave two b' }] });
    const elapsed2 = Date.now() - t1;
    ok('熔断中后续请求瞬时短路（<500ms，实测 ' + elapsed2 + 'ms）', elapsed2 < 500);
    ok('短路请求不发网络调用', hangCount === fetchBefore);
    ok('短路请求全部条目计失败', r2 && r2.failures === 2, JSON.stringify({ failures: r2 && r2.failures }));
    // C-60 文案人话化后对齐，2026-10-13：「熔断中」已从产品移除，短路 notice 改为「刚刚连续超时」。
    ok('短路请求 notice 提明连续超时（C-60 文案人话化后对齐，2026-10-13）',
      r2 && typeof r2.notice === 'string' && r2.notice.indexOf('连续超时') >= 0, r2 && r2.notice);
    ok('短路请求 notice 不得重现 C-60 已移除的术语（熔断 / 更换引擎）',
      r2 && typeof r2.notice === 'string'
        && r2.notice.indexOf('熔断') < 0
        && r2.notice.indexOf('更换引擎') < 0
        && r2.notice.indexOf('引擎配置') < 0, r2 && r2.notice);

    storedSettings = prevSettings;
  }

console.log('\n────────────────────────────────────────────────────');
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  · ' + f);
  console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
  process.exit(1);
}
console.log('全部通过：' + passed + ' 项断言');
