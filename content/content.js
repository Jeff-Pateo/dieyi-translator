/*
 * 叠译 · 内容脚本编排层
 * ------------------------------------------------------------------
 * 把「检测 → 采集 → 翻译 → 渲染」串成流水线，并处理页面动态化带来的四类现实问题：
 *
 *   1) 无限滚动 / 懒加载 —— MutationObserver 增量处理新增子树
 *   2) 直播时钟 / 逐秒跳动 —— 抖动守卫，把高频变动的元素永久拉黑，避免烧掉接口额度
 *   3) SPA 客户端路由 —— 观察 body 子树即可覆盖，无需 hook history API
 *   4) service worker 被回收 —— 消息失败时自动重试一次
 */
(function () {
  'use strict';

  var CT = window.CT;
  var R = CT.renderer;
  var D = CT.detector;
  var G = CT.guard;
  // v1.7 横向扩展引入的模块。它们都在 manifest 的 js 列表里排在 content.js 之前。
  var FG = CT.frameGate;    // frame 自我评估（iframe 护栏 1）
  var KM = CT.keymap;       // 页内自定义快捷键
  var SEL = CT.selection;   // 划词翻译
  var SW = CT.shadow;       // shadow root 遍历

  /* ================================================================
   * 重复注入守卫
   * ================================================================
   * 这个页面上，本脚本可能被注入不止一次：右键菜单的兜底链、扩展安装/更新后
   * 后台的主动补注入、popup 在内容脚本未就绪时的补注入，都会走到这里。
   *
   * 老实现用一行裸布尔挡重复注入：
   *     if (window.__CT_BOOTED__) return;
   * 它把「注入过」和「本版本已注入」混为一谈，于是扩展【更新】之后，
   * 页面里那个布尔值还挂着，新版本脚本被自己上一次留下的标记拦在门外 ——
   * 而旧实例的 chrome.* 上下文已经被更新作废，什么也做不了。
   * 结果是页面永久卡死：不翻译、不自愈、也看不出原因，只能手动刷新。
   *
   * 所以这里改成「版本号 + 存活探测」：同版本且旧实例仍存活才跳过，
   * 否则先请旧实例退场，再由本实例接管。判定逻辑全在 content/guard.js，
   * 那边是纯函数，可以脱离浏览器直接断言。
   * ================================================================ */

  var VERSION = G.readVersion();
  var decision = G.decide(window.__CT_BOOTED__, VERSION);

  if (decision === 'skip') return;

  if (decision === 'takeover') {
    // 旧实例（可能来自上一个版本）还占着位：先让它把观察器、定时器、
    // 控件都卸掉，再清掉它来不及回收的孤儿浮层。
    // 译文块不在此列 —— 那些译文是有效内容，留着比重译一遍更不打扰用户。
    var prevTeardown = G.takeTeardown(window);
    if (prevTeardown) {
      try { prevTeardown(); } catch (e) { console.warn('[叠译] 旧实例退场失败：', e); }
    }
    G.clearOrphans(document);
  }

  G.markBooted(window, VERSION);
  G.setTeardown(window, teardown);

  /** 单波最多提交多少条，兼顾进度可见性与消息体积 */
  var WAVE_SIZE = 100;
  /** 抖动守卫：窗口内变动超过阈值的元素直接拉黑 */
  var JITTER_WINDOW_MS = 30000;
  var JITTER_LIMIT = 5;
  /*
   * C-71（S-16a · 已签）：**`attr` 型变更（class/style/hidden 开合）独立阈值**。
   * ------------------------------------------------------------------
   * 人机交互（折叠/展开）在站点上天然表现为**高频属性开合**；用内容型的 5 次阈值
   * 会把它误判成"抖动"→ **永久拉黑该块**（`U-6` 物证）。故：
   *   · `attr` 型用本阈值（20），且**超限只跳本轮、不写 `data-ct-skip`（不永久拉黑）**；
   *   · `content` 型保持 `JITTER_LIMIT = 5` + 永久拉黑（**行为等价**，`DL-24`）；
   *   · 混合命中时 **`attr` 位优先**（fail-safe：content 桶不可恢复，attr 桶可恢复）。
   * `JITTER_LIMIT` 原值 5 **不动**；`shared/constants.js` 零触碰（`T4` 明文）。
   */
  var JITTER_ATTR_LIMIT = 20;
  /** C-71：变更类型位 —— `kind` **内联在 `pendingRoots` 条目上**（不另开 WeakMap 旁表）。 */
  var KIND_CONTENT = 1;
  var KIND_ATTR = 2;
  /** 进度刷新节流：徽标与上报都是 DOM/消息操作，不必每波都做 */
  var PROGRESS_MIN_MS = 200;
  /**
   * 待重扫根节点的数量上限。
   * ------------------------------------------------------------------
   * 注意：这里【不是】为了控制扫描成本。待处理根节点之间已经做过包含关系去重，
   * 因此它们互不重叠，扫描它们的工作量之和必然不超过扫描整页 ——
   * 换句话说，逐个子树扫描在成本上永远不劣于整页扫描。
   *
   * 上限真正约束的是「每次 collectUnits 的固定开销」与队列内存：
   * 一次调用要新建跳过判定缓存、遍历队列等结构。取一个远离常规页面
   * （同时变更几十处）的较大值即可；只有在这种规模的并发变更下，
   * 才说明页面在做整体重建，收拢成一次整页扫描更省事。
   */
  var ROOT_LIMIT = 120;

  var state = {
    settings: null,
    sourceLang: 'auto',
    detected: null,
    /**
     * 本页场景（v1.7.2）。扫描开始时探测一次，随每个翻译请求带给后台 ——
     * 后台据此启用「场景限定」的术语条目（如招聘页 Apply→申请）。
     * 纯页面属性，不随设置变化，因此只算一次。
     */
    scene: [],
    enabled: false,
    running: false,
    /** 等待下一轮采集的根节点（去重后）。绝不允许它被静默丢弃 —— 丢弃就等于漏翻。 */
    pendingRoots: [],
    /** 运行期间收到「整页重来」请求（设置变更等）时置位 */
    needsFullScan: false,
    observer: null,
    lastProvider: '',
    lastNotice: '',
    /** 进度文案，供页内开关的「翻译中」态显示 */
    progressText: '',
    /**
     * 本页临时覆盖：null = 跟随设置；true / false = 本页强制开或关。
     * 页内开关点一下改的就是它 —— 刻意【不写回全局设置】，
     * 否则在一个页面临时关掉翻译会让所有标签页跟着停。
     * 只活在当前页面的内存里，刷新后回到站点记忆或全局默认。
     */
    pageOverride: null,
    /**
     * C-54（v1.7.8）：原文视图保持位。用户手动点了「显示原文」= 明确想读原文，
     * autoTranslate 偏好与站点记忆不得在本页会话内推翻这个意图（终验挂账 P3：
     * 恢复原文后被自动重译覆盖，用户无法停留在原文视图）。再次主动翻译
     * （点「翻译此页」/ translateNow / 快捷键 toggle）即解除。只活在当前页面。
     */
    holdOriginal: false,
    /** 站点级记忆：hostname -> true|false（仅在设置里打开 siteMemory 时读写） */
    siteState: {},
    /** 页内开关的句柄 */
    toggle: null,
    /** 开关上的二次确认态（黑名单冲突时用） */
    toggleConfirm: null,
    /**
     * 用户在本页点了「隐藏这个按钮」。
     * 与设置页的 toggleVisible 分开：后者是「以后都不要」，
     * 前者是「这一页别挡我」。混在一起会让一次临时操作变成永久偏好。
     */
    toggleHiddenHere: false,
    /** 用户把开关拖收起过。仅本页记忆，不写设置（写位置是控件自己的事）。 */
    toggleCollapsed: false,
    /** 首段译文上屏耗时，单位毫秒（TTFT，相对页面 navigationStart） */
    ttft: null,

    /* ---- v1.7 ---- */
    /**
     * 本 frame 的自我评估结果（来自 frameGate.assess()）。
     * 它决定「整页翻译」是否在本 frame 里跑 —— 广告位、统计像素、小挂件
     * 不值得翻译。注意它【不】影响划词：用户在哪都能划。
     */
    frameGate: null,
    /** 页内快捷键的卸载函数 */
    keymapDetach: null,
    /** 划词控制器是否已初始化（跨 applySettings 保持） */
    selectionReady: false,
    /** shadow root 是否已做过首次扫描（避免每轮设置变更都重扫全树） */
    shadowScanned: false
  };

  /** performance.now() 在极老的页面里可能不存在，退化到 0 而不是抛错 */
  function now() {
    try { return performance.now(); } catch (e) { return 0; }
  }

  // 抖动计数用 WeakMap：键不会阻止元素被回收。
  // 旧实现用 Map 且从不清理，长会话下每一个曾变动过的元素都被永久持有。
  var jitter = new WeakMap();
  var badgeEl = null;
  var badgeTimer = null;
  /** 当前徽标被点击时要执行的动作（null = 不可点）。见 showBadge 的 opts.onClick */
  var badgeClick = null;
  /* C-64（B2-2）：反馈徽标「悬停暂停倒计时」。
   * badgeDeadline = 绝对到期时间戳；badgeRemaining = 暂停时冻结的剩余毫秒。
   * badgePauseEnabled / badgePaused 只在传了 opts.pauseOnHover 时启用 ——
   * 默认 false，既有徽标调用（不传该选项）行为一字不变。 */
  var badgeDeadline = 0;
  var badgeRemaining = 0;
  var badgePaused = false;
  var badgePauseEnabled = false;

  /* ================================================================
   * 基础工具
   * ================================================================ */

  /** 基于回调封装 sendMessage，并把 lastError 转成可捕获的错误 */
  function send(msg) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          var err = chrome.runtime.lastError;
          if (err) { reject(new Error(err.message)); return; }
          resolve(res);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function chunk(arr, size) {
    var out = [];
    for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  /**
   * 判断节点是否由本扩展创建（译文块 / 浮层 / 徽标 / 页内开关及其子树）
   * ------------------------------------------------------------------
   * 页内开关必须登记在这一层：它挂在 document.body 下，页面只变动一次
   * 就会被 MutationObserver 认作「新增内容」，进而走 scopeOf → collectUnits。
   * 控件里那个「译」字被当成正文采走、再渲染出它自己的译文，就是自噬。
   * 宿主上的 data-ct-skip 是第二道闸门，两道都失效才会出问题。
   */
  function isOwnNode(n) {
    if (!n) return false;
    var el = n.nodeType === 1 ? n : n.parentElement;
    if (!el || !el.classList) return false;
    if (el.classList.contains(CT.TRANS_CLASS)) return true;
    if (el.classList.contains('ct-tip') || el.classList.contains('ct-badge')) return true;
    if (el.classList.contains(CT.TOGGLE_CLASS)) return true;
    /* B2（C-63/C-67）：新增浮层也挂在 body 下，必须登记为「自己的节点」，
     * 否则会被 MutationObserver 当成页面新增内容采走、再把自己的 UI 文本送翻译
     * （自噬）。学习确认卡 / 能力边界提示两者都要挡在这一层。 */
    if (el.classList.contains('ct-learn-card')
      || el.classList.contains('ct-cap-note')) return true;
    return !!(el.closest && el.closest(
      '.' + CT.TRANS_CLASS + ', .ct-tip, .ct-badge, .' + CT.TOGGLE_CLASS
      + ', .ct-learn-card, .ct-cap-note'
    ));
  }

  function hostname() {
    try { return location.hostname || ''; } catch (e) { return ''; }
  }

  /* ================================================================
   * 进度徽标
   * ================================================================ */

  function ensureBadge() {
    if (badgeEl && badgeEl.isConnected) return badgeEl;
    badgeEl = document.createElement('div');
    badgeEl.className = 'ct-badge';
    badgeEl.setAttribute('translate', 'no');
    badgeEl.innerHTML = '<span class="ct-badge__dot"></span><span class="ct-badge__text"></span>';
    // 可点击徽标（当前用于「翻译失败 → 点击重试」的出路）。
    // 用一次性绑定 + 读当前动作变量的形式，避免每次 showBadge 重复挂监听器
    // （重复挂 = 点一下发 N 条消息，是"委托监听器"家族的经典错，L-12）。
    badgeEl.addEventListener('click', function () { if (badgeClick) badgeClick(); });
    /* C-64（B2-2）：悬停暂停倒计时（仅 opts.pauseOnHover 时生效）。
     * 指针进入 → 冻结剩余时间；离开 → 按剩余时间重排自动隐藏。 */
    badgeEl.addEventListener('mouseenter', function () {
      if (!badgePauseEnabled || badgePaused || !badgeTimer) return;
      badgePaused = true;
      clearTimeout(badgeTimer);
      badgeTimer = null;
      badgeRemaining = Math.max(0, badgeDeadline - Date.now());
    });
    badgeEl.addEventListener('mouseleave', function () {
      if (!badgePaused) return;
      badgePaused = false;
      if (badgeRemaining > 0) scheduleBadgeHide(badgeRemaining);
      else hideBadge();
    });
    (document.body || document.documentElement).appendChild(badgeEl);
    return badgeEl;
  }

  /**
   * 排定徽标自动隐藏。
   * C-64：抽成独立函数，供「悬停暂停后按剩余时间恢复」复用 ——
   * 直接写 setTimeout 无法带着剩余时长重排。
   */
  function scheduleBadgeHide(ms) {
    if (badgeTimer) clearTimeout(badgeTimer);
    badgeRemaining = ms;
    badgeDeadline = Date.now() + ms;
    badgeTimer = setTimeout(hideBadge, ms);
  }

  /**
   * 显示进度/结果徽标。
   * opts（v1.7.7 新增，全部可选）：
   *   ms          —— 自动隐藏延时，默认 3200
   *   onClick     —— 点击徽标触发的动作（配 .ct-badge--act 变成可点样式）
   *   pauseOnHover—— C-64 新增：指针悬停其上时暂停倒计时，移开后续走剩余时间
   * 默认行为一字未改：不传 opts 时与 v1.7.6 完全一致。
   */
  function showBadge(text, kind, opts) {
    var el = ensureBadge();
    var dot = el.querySelector('.ct-badge__dot');
    var txt = el.querySelector('.ct-badge__text');
    txt.textContent = text;
    dot.className = 'ct-badge__dot'
      + (kind === 'done' ? ' ct-badge__dot--done' : '')
      + (kind === 'error' ? ' ct-badge__dot--err' : '');
    el.classList.add('ct-badge--on');
    badgeClick = (opts && opts.onClick) || null;
    el.classList.toggle('ct-badge--act', !!badgeClick);

    badgePaused = false;
    badgePauseEnabled = !!(opts && opts.pauseOnHover);
    if (badgeTimer) { clearTimeout(badgeTimer); badgeTimer = null; }
    if (kind !== 'working') {
      scheduleBadgeHide((opts && opts.ms) || 3200);
    }
  }

  /**
   * Z5（v1.7.9 C-60）：出错时「说人话 + 给出路」。
   * ------------------------------------------------------------------
   * 旧文案把「网络」和「配置」并列甩给用户，其中后半句是术语、也不是动作。
   *   1) 「引擎配置」是术语 —— 目标用户不知道它指什么，看到只会更慌，
   *      也不知道该去哪儿查（用户研究 Z5 的原始证据）；
   *   2) 只报现象、不给动作：用户能做的只有猜和重装。
   * 新文案：保留「翻译失败」这一稳定词头（既有探针以 /已译|翻译失败/ 判终态），
   * 后半段换成「点击重试」这一个可执行动作 —— 点一下即原地重跑本轮翻译。
   * 真实原因不丢：写进 console 供排查，不再摊给用户。
   */
  function showTranslateFailed() {
    if (state.lastNotice) console.warn('[叠译] 翻译失败原因：', state.lastNotice);
    showBadge('翻译失败 · 点击重试', 'error', {
      ms: 10000,
      onClick: function () {
        try { handleCommand({ action: 'translateNow' }); } catch (e) { /* 忽略 */ }
      }
    });
  }

  function hideBadge() {
    if (badgeTimer) { clearTimeout(badgeTimer); badgeTimer = null; }
    badgePaused = false;
    badgePauseEnabled = false;
    if (badgeEl && badgeEl.parentNode) badgeEl.parentNode.removeChild(badgeEl);
    badgeEl = null;
  }

  /*
   * C-43（v1.7.7）：翻译进度**单一来源** —— 同屏两个「翻译中 N / M」。
   * ------------------------------------------------------------------
   * 缺陷现场（用户截图）：页内开关胶囊显示「621 / 1272」的同时，
   * 右下角徽标又显示「翻译中 621…」—— 同一个事实算两次、显示两次
   * （L-2 家族的呈现层形态）。两处数据同源（state.progressText），
   * 但用户看到的是两个独立进度条，还各差一个「翻译中」前缀。
   *
   * 归属规则：
   *   · 页内开关**展开在场** → 进度归开关（busyText），徽标让位；
   *   · 开关**不在场**（用户隐藏/设置关闭）或**已收起**（收起态 .label
   *     是 display:none，数字不可见，见 toggle.js）→ 徽标保留，
   *     否则修成「零进度」。
   * 终态（已译/失败）仍走徽标：那是 toast 性质的结果告知，
   * 开关上没有承载它的位置，与本规则不冲突。
   */
  /** 状态此刻应显示在页内开关上吗（开关在场且未收起）。
   *  C-43 进度、C-44 成功终态共用同一判定（状态一体化归属矩阵）。 */
  function statusOnToggle() {
    return !!(state.toggle
      && typeof state.toggle.collapsed === 'function'
      && !state.toggle.collapsed());
  }

  /** 进度态徽标（kind='working' 专用入口）：开关在场时让位并顺手收掉旧徽标 */
  function showProgressBadge(text) {
    if (statusOnToggle()) { hideBadge(); return; }
    showBadge(text, 'working');
  }

  /* ================================================================
   * 悬停浮层（「悬停查看译文」模式）
   * ----------------------------------------------------------------
   * 刻意不用 CSS ::after 实现：那需要给目标元素加 position:relative，
   * 在真实站点上极容易破坏原有布局。改用一个固定定位的浮层，由 JS 给坐标。
   * ================================================================ */

  var tipEl = null;
  var tipTarget = null;

  function ensureTip() {
    if (tipEl && tipEl.isConnected) return tipEl;
    tipEl = document.createElement('div');
    tipEl.className = 'ct-tip';
    tipEl.setAttribute('translate', 'no');
    (document.body || document.documentElement).appendChild(tipEl);
    return tipEl;
  }

  function showTip(text, x, y) {
    var el = ensureTip();
    el.textContent = text;
    el.classList.add('ct-tip--on');

    // 先显示再量尺寸，然后按视口边界夹紧坐标
    var rect = el.getBoundingClientRect();
    var vw = window.innerWidth || document.documentElement.clientWidth;
    var vh = window.innerHeight || document.documentElement.clientHeight;
    var left = Math.min(Math.max(8, x + 14), Math.max(8, vw - rect.width - 8));
    var top = y + 20;
    if (top + rect.height > vh - 8) top = Math.max(8, y - rect.height - 12);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  function hideTip() {
    tipTarget = null;
    if (tipEl) tipEl.classList.remove('ct-tip--on');
  }

  function initHover() {
    document.addEventListener('mouseover', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('.ct-hover') : null;
      if (!el) { hideTip(); return; }
      var rec = R.registry.get(el);
      if (!rec || !rec.text) { hideTip(); return; }
      tipTarget = el;
      showTip(rec.text, e.clientX, e.clientY);
    }, true);

    document.addEventListener('mouseout', function (e) {
      if (!tipTarget) return;
      var to = e.relatedTarget;
      if (to && to.nodeType === 1 && to.closest && to.closest('.ct-hover') === tipTarget) return;
      hideTip();
    }, true);

    // 页面滚动或尺寸变化时浮层位置必然失效，直接收起
    window.addEventListener('scroll', hideTip, true);
    window.addEventListener('resize', hideTip);
  }

  /* ================================================================
   * 页内常驻开关
   * ----------------------------------------------------------------
   * 控件本身的实现全在 content/toggle.js（Shadow DOM 隔离、拖动、位置记忆）。
   * 这里只做三件事：决定它该不该在、告诉它现在什么状态、接住它的用户意图。
   *
   * 粒度是【当前页面】而不是全局：点一下只影响本页，绝不回写 settings.enabled。
   * 理由很实际 —— 用户在一个长文章的页面上临时关掉翻译，没有任何理由让
   * 另外 20 个标签页跟着停。全局开关仍然只由弹窗和设置页改动。
   * ================================================================ */

  /** 什么状态该显示成什么。页面本来就无需翻译时给禁用态，而不是让开关假装能开。 */
  function toggleStatus() {
    var s = state.settings;
    if (!s) return 'off';
    // 与整页闸门用同一条判据。若这里用宽松判据，会出现
    // 「开关显示成灰色不可用，但整页闸门其实放行」的矛盾状态。
    if (!CT.settings.needsPageTranslation(
      state.sourceLang, s.targetLang, state.detected && state.detected.variant)) return 'unavailable';
    if (CT.settings.isBlockedHost(hostname(), s.blocklist)) return 'unavailable';
    if (state.running) return 'busy';
    return state.enabled ? 'on' : 'off';
  }

  /**
   * 本页有没有「活」需要这个控件在场。
   * ------------------------------------------------------------------
   * ★ C-28（2026-09-28）★ 与 toggleStatus() 的分工：
   *   toggleStatus()     —— 在场时**显示什么**（翻译此页 / 翻译中 / 显示原文 / 无需翻译）
   *   toggleWorthShowing —— **要不要在场**
   *
   * 旧实现只有前者，没有后者：挂载条件里完全没有「本页需不需要翻译」这一维，
   * 于是**每一个中文页面右下角都会常驻一颗写着「无需翻译」的胶囊** ——
   * 点了没反应、又关不掉（「隐藏这个按钮」只在当前实例里生效）。
   * 用户的原话是「为什么重复出现这个」：他每翻一个页面就看到同一个东西。
   *
   * 注意这里必须**区分两种 unavailable**（旧实现把它们合并了，直接合并会引新缺陷）：
   *   · 本页语言与目标语言一致（中文页）→ **不显示**。这是噪声，用户不需要它。
   *   · 站点在用户的黑名单里 → **必须显示**。否则用户在页面上就再也没有
   *     「撤销拉黑」的入口了（那条入口只有配合本控件才有）。
   */
  function toggleWorthShowing() {
    var s = state.settings;
    if (!s) return false;
    if (CT.settings.isBlockedHost(hostname(), s.blocklist)) return true;
    return CT.settings.needsPageTranslation(
      state.sourceLang, s.targetLang, state.detected && state.detected.variant);
  }

  /** 把当前状态推给控件。挂载与更新都在这里收口，避免多处各推一次。 */
  function syncToggle() {
    var s = state.settings;
    if (!s) return;

    /*
     * 页内开关只在顶层 frame 渲染。
     * 开关是「页面级」概念 —— 只有顶层有资格代表「这一页」。
     * 一个真实页面最多能有几十个 iframe（广告、统计、评论、播放器），
     * 若每个 frame 都挂一颗悬浮球，右下角会叠成一堆，观感直接崩掉。
     *
     * 注意这里【只】影响控件的挂载，不影响采集与渲染 ——
     * iframe 里的正文照样会被翻译，只是不再各自带一个开关。
     */
    if (FG && typeof FG.isTop === 'function' && !FG.isTop()) return;

    // 设置页整体关掉了控件 → 卸载它。其它入口（快捷键、右键、弹窗）
    // 一律不受影响，这也是「隐藏控件」不等于「禁用扩展」的保证。
    //
    // ★ C-28：再加上「本页无活可干」这一维 —— 中文页面右下角不该常驻一颗
    // 写着「无需翻译」的胶囊（用户截图的直接来源）。见 toggleWorthShowing()。
    if (!s.toggleVisible || state.toggleHiddenHere || !toggleWorthShowing()) {
      destroyToggle();
      return;
    }

    if (!state.toggle || !CT.toggle.isMounted()) {
      state.toggle = CT.toggle.mount({
        collapsed: !!s.toggleDefaultCollapsed,
        mark: CT.langMark ? CT.langMark(s.targetLang) : '译',
        // 引导气泡里点名目标语言：「翻成简体中文」比「翻成目标语言」有用得多
        targetLabel: CT.langLabel ? CT.langLabel(s.targetLang) : '',
        onToggle: onToggleRequest,
        onCollapse: function (collapsed) { state.toggleCollapsed = !!collapsed; },
        onMore: onMoreAction,
        onUnblock: onUnblockRequest,
        onCancel: function () {
          state.toggleConfirm = null;
          syncToggle();
        }
      });
      if (!state.toggle) return;
    }

    CT.toggle.update({
      status: toggleStatus(),
      busyText: state.running ? state.progressText : '',
      confirm: state.toggleConfirm,
      // 目标语言一改，图标立刻跟着变（翻成日语就显示「日」）
      mark: CT.langMark ? CT.langMark(s.targetLang) : '译',
      targetLabel: CT.langLabel ? CT.langLabel(s.targetLang) : ''
    });
  }

  /**
   * 控件「更多」菜单里那几条命令。
   * 全都交给编排层执行 —— 控件自己不知道也不该知道设置存在哪、黑名单怎么改。
   */
  function onMoreAction(id) {
    if (id === 'options') {
      send({ type: CT.MSG.OPEN_OPTIONS }).catch(function () { /* 忽略 */ });
      return;
    }
    if (id === 'never') {
      // 与「不翻译的站点」是同一件事，但入口不同：
      // 右键菜单/设置页是「主动去配置」，这里是从页面上直接说「别烦我」。
      onUnblockRequestReverse();
      return;
    }
    if (id === 'hide') {
      // 只关本页的可见性，不改设置 —— 用户点「隐藏」的意图是
      // 「这一页别挡着我」，而不是「以后都不要这个按钮了」。
      state.toggleHiddenHere = true;
      destroyToggle();
      return;
    }
    if (id === 'hideAll') {
      /*
       * ★ C-28（2026-09-28）：持久出口。
       * ------------------------------------------------------------------
       * 旧实现只有「隐藏这个按钮」这一个入口，而它是**实例级内存变量**
       * （state.toggleHiddenHere）—— 刷新页面、新开标签、扩展更新后实例被接管，
       * 它就满了，胶囊又回来。用户于是陷入「隐藏一次、回来一次」的循环，
       * 体感就是「这东西为什么重复出现」。
       *
       * 真正持久的开关（settings.toggleVisible）原本只长在设置页深处，
       * 用户在页面上表达不出「以后都不要」。这里补上，语义与设置页那个
       * 复选框完全同源（同一个键），不新增存储概念。
       */
      state.toggleHiddenHere = true;
      destroyToggle();
      send({ type: CT.MSG.SET_SETTINGS, patch: { toggleVisible: false } })
        .then(function () {
          showBadge('已隐藏页内按钮，可在设置页重新打开', 'done');
        })
        .catch(function () { /* 落盘失败：本页仍已隐藏，下次再说 */ });
      return;
    }
  }

  /** 卸下页内控件（不改任何状态，纯粹把 DOM 摘掉） */
  function destroyToggle() {
    if (!state.toggle) return;
    try { state.toggle.destroy(); } catch (e) { /* 页面正在卸载 */ }
    state.toggle = null;
  }

  /**
   * 本页是否应该「翻译开启」。
   * 优先级：本页临时覆盖 > 站点记忆 > 全局总开关。
   */
  /* ================================================================
   * v1.7：划词翻译 / 页内快捷键 / shadow root
   * ================================================================ */

  /**
   * 划词翻译的请求函数。
   * ------------------------------------------------------------------
   * 刻意复用整页翻译的**同一条**消息通道（CT.MSG.TRANSLATE），不另开一条。
   * 于是三样东西自动继承，一行都不用重写：
   *   · 掩码保护（URL / 代码 / 版本号不会被翻坏）
   *   · 用户术语表（划词与整页对同一术语给出一致译名）
   *   · 译文缓存（划词过的句子，整页翻译时直接命中）
   * 定位上，划词就是「采样规模 = 1 的整页翻译」。
   */
  async function selectionTranslate(text) {
    var s = state.settings || await getSettings();
    if (s.selectionEnabled === false) return { ok: false, error: '划词翻译当前是关闭的' };

    // 源语言可以复用整页检测的结果：用户在这一页划词，
    // 用「本页已知语言」比让引擎逐句重判更准，也省一次判定
    var src = s.sourceLang;
    if (src === 'auto' && state.sourceLang && state.sourceLang !== 'auto') src = state.sourceLang;

    // 已知源语言 == 目标语言 → 不发请求，直接告诉气泡
    if (src !== 'auto' && CT.settings.normalizeLang(src) === CT.settings.normalizeLang(s.targetLang)) {
      return { ok: true, same: true };
    }

    var res = await send({
      type: CT.MSG.TRANSLATE,
      source: src,
      target: s.targetLang,
      frameArea: (state.frameGate && state.frameGate.area) || 0,
      scene: state.scene || [],
      items: [{ text: text, ctx: '' }]
    });

    if (!res || !res.ok) {
      return { ok: false, error: (res && (res.notice || res.error)) || '翻译服务返回失败' };
    }

    var one = res.translations && res.translations[0];
    var out = typeof one === 'string' ? one : (one && (one.text || one.t)) || '';
    if (!out) return { ok: false, error: '没有返回译文' };
    return { ok: true, text: String(out).trim() };
  }

  /** 挂载 / 卸载划词控制器。它与整页翻译的开关相互独立。 */
  function ensureSelection() {
    var s = state.settings;
    if (!s) return;

    if (s.selectionEnabled === false) {
      if (state.selectionReady) {
        try { SEL.destroy(); } catch (e) { /* 页面卸载中 */ }
        state.selectionReady = false;
      }
      return;
    }

    if (state.selectionReady) return;
    SEL.init({
      translate: selectionTranslate,
      getSettings: function () { return state.settings || CT.DEFAULT_SETTINGS; }
    });
    state.selectionReady = true;
  }

  /** 用当前选区触发一次划词翻译（供页内快捷键调用） */
  function translateSelectionNow() {
    var sel = window.getSelection ? window.getSelection() : null;
    if (!sel || sel.isCollapsed) {
      showTip('请先选中一段文字', 0, 0);
      return;
    }
    // 交给 selection 模块自己走完整链路 —— 它已有「先量后放」的定位与浮层仲裁，
    // 这里手工拼一个气泡只会绕过那些保护
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  }

  /**
   * 页内自定义快捷键。
   * ------------------------------------------------------------------
   * 只在顶层挂。快捷键是「页面上的一次按键」，而一次按键在整页里只发生一次；
   * 非顶层 frame 若各绑一份，用户按一次会触发多次。
   *
   * 与全局键的关系：manifest 的 commands 已经占了 Alt+Shift+T / Y，
   * 页内绑定若与它们相同会被 KM.attach 自动剔除 —— 否则一次按键触发两条路径，
   * 表现为「按一下翻两次」。
   */
  function ensureKeymap() {
    var s = state.settings;
    if (!s) return;
    if (FG && !FG.isTop()) return;
    if (state.keymapDetach) return;

    state.keymapDetach = KM.attach(
      function () {
        var cur = state.settings || CT.DEFAULT_SETTINGS;
        return cur.customShortcuts || {};
      },
      function (action) { runKeyAction(action); },
      CT.RESERVED_COMBOS
    );
  }

  function runKeyAction(action) {
    if (action === 'toggle') { handleCommand({ action: 'toggle' }); return; }
    if (action === 'mode') { cycleDisplayMode(); return; }
    if (action === 'selection') { translateSelectionNow(); return; }
  }

  /** 循环切换显示方式。与设置页里的切换是同一件事，只是入口不同。 */
  async function cycleDisplayMode() {
    var s = state.settings || await getSettings();
    var order = ['below', 'replace', 'hover'];
    var i = order.indexOf(s.displayMode);
    var next = order[(i + 1) % order.length];
    var res = await send({ type: CT.MSG.SET_SETTINGS, patch: { displayMode: next } });
    await applySettings(res && res.ok && res.settings ? res.settings : s, 'settings');
  }

  /**
   * shadow root 扫描。
   * ------------------------------------------------------------------
   * 只在设置打开时做，且整页只做一次首扫 —— 后续由 MutationObserver
   * 在观察到新宿主插入时补扫。
   * 深度限制交给 shadow-walk 的 idle 切片，不在这一层再包一层节流。
   */
  function ensureShadowScan() {
    var s = state.settings;
    if (!s || s.shadowDomEnabled === false) return;
    if (state.shadowScanned) return;
    state.shadowScanned = true;
    try {
      var roots = SW.findRoots(document);
      if (roots.length) SW.enqueueAll(roots);
    } catch (e) {
      console.warn('[叠译] shadow root 扫描失败：', e);
    }
  }

  function effectiveEnabled(s) {
    if (!s) return false;
    if (state.pageOverride !== null) return state.pageOverride;
    // C-54：原文视图保持 —— 即便全局开关被翻转清掉了 pageOverride（下面的
    // applySettingsInner 语义），autoTranslate 也不能在本页会话内自动重译。
    if (state.holdOriginal) return false;
    if (s.siteMemory) {
      var remembered = state.siteState[hostname()];
      if (remembered === true || remembered === false) return remembered;
    }
    return !!s.enabled;
  }

  function loadSiteState() {
    return new Promise(function (resolve) {
      try {
        if (!chrome.storage || !chrome.storage.local) { resolve({}); return; }
        chrome.storage.local.get(CT.STORAGE.SITE_STATE, function (res) {
          void chrome.runtime.lastError;
          var v = res ? res[CT.STORAGE.SITE_STATE] : null;
          resolve(v && typeof v === 'object' ? v : {});
        });
      } catch (e) {
        resolve({});
      }
    });
  }

  /** 站点级记忆。只有设置里打开了 siteMemory 才记录，避免默认偷偷写存储。 */
  function rememberSite(v) {
    var s = state.settings;
    if (!s || !s.siteMemory) return;
    var h = hostname();
    if (!h) return;
    state.siteState[h] = v;
    var payload = {};
    payload[CT.STORAGE.SITE_STATE] = state.siteState;
    try {
      if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.set(payload, function () { void chrome.runtime.lastError; });
      }
    } catch (e) { /* 扩展已失效，记不住就算了 */ }
  }

  /** 用户点了开关。方向由当前状态决定，结果交给 applySettings 统一落地。 */
  async function onToggleRequest() {
    var s = state.settings;
    if (!s) return;

    if (state.enabled) {
      state.pageOverride = false;
      state.holdOriginal = true;   // C-54：手动回原文 = 本页会话内暂停自动翻译
      rememberSite(false);
      await applySettings(s, 'page-off');
      return;
    }

    // 站点在黑名单里：先问一次再动手。直接翻译等于无视用户自己设的规则。
    if (CT.settings.isBlockedHost(hostname(), s.blocklist)) {
      state.toggleConfirm = 'blocked';
      syncToggle();
      return;
    }

    state.pageOverride = true;
    state.holdOriginal = false;    // C-54：主动要求翻译，解除原文保持
    state.toggleConfirm = null;
    rememberSite(true);
    await applySettings(s, 'toggle-on');
  }

  /** 确认「移出黑名单并翻译」：先落盘名单，再按最新设置翻译本页。 */
  async function onUnblockRequest() {
    var s = state.settings;
    if (!s) return;
    var h = hostname();
    var list = (Array.isArray(s.blocklist) ? s.blocklist : []).filter(function (x) { return x !== h; });

    state.toggleConfirm = null;
    state.pageOverride = true;
    state.holdOriginal = false;   // C-54：用户主动要求翻译
    rememberSite(true);

    var res = await send({ type: CT.MSG.SET_SETTINGS, patch: { blocklist: list } })
      .catch(function () { return null; });

    // 落盘成功就用回执里的新设置（它已是权威值）；失败也照常翻译本页，
    // 只是黑名单没改掉 —— 下次打开该站点仍会被拦。
    await applySettings(res && res.ok ? res.settings : s, 'toggle-on');
  }

  /**
   * 「本网站不再自动翻译」：把当前域名加进黑名单并停掉本页翻译。
   * 与 onUnblockRequest 正好相反，两者共用同一条设置落盘路径。
   */
  async function onUnblockRequestReverse() {
    var s = state.settings;
    if (!s) return;
    var h = hostname();
    var list = Array.isArray(s.blocklist) ? s.blocklist.slice(0) : [];
    if (list.indexOf(h) < 0) list.push(h);

    state.pageOverride = false;
    state.holdOriginal = true;   // C-54：「本站不再自动翻译」同样保持原文视图
    state.toggleConfirm = null;
    state.toggleHiddenHere = true;
    if (state.toggle) {
      try { state.toggle.destroy(); } catch (e) { /* 页面正在卸载 */ }
      state.toggle = null;
    }

    var res = await send({ type: CT.MSG.SET_SETTINGS, patch: { blocklist: list } })
      .catch(function () { return null; });

    // 无论落盘成功与否，本页立刻停翻 —— 用户已经表达了「别翻这一站」，
    // 让他再等一次网络往返才生效是没有必要的。
    await applySettings(res && res.ok ? res.settings : s, 'settings');
  }

  /* ================================================================
   * 主流水线
   * ================================================================ */

  function report(phase, extra) {
    var stats = R.getStats();
    var payload = {
      type: CT.MSG.REPORT,
      translated: stats.translated,
      units: stats.units,
      provider: state.lastProvider,
      sourceLang: state.sourceLang,
      // 页面正字法（简体/繁体）。弹窗用它把方向显示成
      // 「简体中文 → 繁体中文」这样的完整语向，而不是只给一个语种名。
      variant: (state.detected && state.detected.variant) || '',
      targetLang: state.settings ? state.settings.targetLang : '',
      mode: state.settings ? state.settings.displayMode : '',
      // 从裁切/折叠容器里救回来的译文条数。不为 0 说明页面上确实有
      // 「内容显示不全」的区块，也是这类反馈可复现的量化依据。
      rescuedFromClip: stats.rescuedFromClip || 0,
      /* ---- v1.7 ---- */
      // 「仅显示译文」模式下，因元素含链接/代码而**降级为双语**的段落数。
      // 这个数字是产品判断的依据：降级比例过高，就说明「仅显示译文」
      // 在这类站点上名不副实（详见 docs/扩展能力架构设计-v1.7.md §8）
      replaceDegraded: stats.replaceDegraded || 0,
      isTop: FG ? FG.isTop() : true,
      frameGate: state.frameGate ? state.frameGate.reason : 'unknown',
      // OCR 能力探针。桌面版 Chrome 现在没有 TextDetector（官方 roadmap
      // 指向 Chrome 168 / 2027），这里如实上报平台现状而不是猜 ——
      // 等它真落地时，这份数据就是「该不该做图片翻译」的决策依据。
      hasTextDetector: !!(window && 'TextDetector' in window),
      /* ---- v1.7.1 译文可见性 ----
       * riskSuspect 是「值得怀疑」，relocated 是「量测后确认不可见、已搬走」，
       * clipUnresolved 是「搬了也没救回来」。三者分开报 ——
       * 合成一个数字会让排障的人分不清「静态判据误判」与「真问题」。 */
      riskSuspect: stats.riskSuspect || 0,
      relocated: stats.relocated || 0,
      clipUnresolved: stats.clipUnresolved || 0,
      phase: phase,
      // TTFT：首段译文上屏的时刻（相对页面 navigationStart）。
      // 这是本轮「零刷新即时翻译」唯一能量化的验收指标 ——
      // 「用户点了开关 → 屏幕上真的出现中文」之间的那段等待，就它一个数。
      ttft: state.ttft
    };
    if (extra) { for (var k in extra) payload[k] = extra[k]; }
    send(payload).catch(function () { /* SW 未就绪时忽略 */ });
  }

  /**
   * @param {string} reason 触发来源：initial / manual / mutation / settings / queued
   * @param {Node|Node[]} [root] 限定采集范围（增量场景传入新增子树）
   */
  async function run(reason, root) {
    if (!state.settings || !state.enabled) return;

    // 已经有一轮在跑：把本轮的范围并进待处理队列，而不是丢弃后整页重来
    // C-71（T7）：此处的 root 可能已是 `{el,mask}[]`（queued 路径）⇒ **在本处归一为
    // Element[]** 后再交给 addRoots（契约：addRoot / addRoots 只收 Element）。
    if (state.running) {
      if (root) addRoots(rootsToElements(root));
      else state.needsFullScan = true;
      return;
    }
    state.running = true;

    try {
      // 场景探测（v1.7.2）：每轮扫描前刷新一次。document.body.innerText
      // 取头部样本即可 —— 关键词是高频 UI 文案，4000 字符足够覆盖首屏信号。
      // 探测失败不阻断翻译（scene 保持 []，场景条目不生效而已）。
      try {
        state.scene = (CT.scene && CT.scene.detect)
          ? CT.scene.detect({
            url: location.href,
            title: document.title || '',
            text: ((document.body && document.body.innerText) || '').slice(0, 4000)
          })
          : [];
      } catch (se) { state.scene = []; }

      // C-71（T8 / 契约）：**run 入口 = 归一许可点之一** —— root 可能是
      // Element / Element[] / `{el,mask}[]`（queued 路径保 mask）⇒ 统一成
      // **Element[]** 再交给 collectUnits（它只收 Element）。
      var scanRoots = root
        ? rootsToElements(root)
        : [document.body];
      if (!scanRoots.length) scanRoots = [document.body];

      // 多个根之间可能有重叠（且 collectUnits 每次都会新建单元对象），
      // 这里按元素去重，避免同一个段落被提交两次、渲染出两个译文块。
      var units = [];
      var seen = new Set();
      for (var r = 0; r < scanRoots.length; r++) {
        var part = R.collectUnits(scanRoots[r], state.settings);
        for (var p = 0; p < part.length; p++) {
          if (seen.has(part[p].el)) continue;
          seen.add(part[p].el);
          units.push(part[p]);
        }
      }
      if (!units.length) {
        if (reason !== 'mutation') report('done');
        return;
      }

      var total = units.length;
      var done = 0;
      var failed = 0;
      // v1.7.5（C-17 F1）：本轮命中用户修正的条数，随各波响应累加
      var corrApplied = 0;
      // v1.7.1：本次翻译过程中因「量测确认不可见」而被搬出原容器的条数。
      // 它不等于 renderer 的累计值 —— 这一轮之前可能已经有译文被搬过。
      var relocatedTotal = 0;
      var lastProgressAt = 0;
      state.progressText = '0 / ' + total;
      showProgressBadge('翻译中 0 / ' + total);   // C-43：开关在场时让位
      syncToggle();
      report('working', { pending: total });

      /*
       * 波水线（v1.7.3，C-11 H1，动因见 docs/性能架构分析-v1.7.3.md）。
       * ------------------------------------------------------------------
       * 旧循环是「请求 → 等结果 → 渲染 → 验真 → 再请求」，网络与渲染
       * 完全串行：每波墙钟 = 往返 + 渲染，10 波就是 10 份往返之和。
       *
       * 新做法：首个请求立刻发出；循环体拿到当前波结果后**先把下一波的
       * 请求挂在路上**，再去渲染本波 —— 渲染与几何验真是同步 JS 工作，
       * 不阻塞已发出的网络往返。墙钟从 Σ(网络+渲染) 变成
       * 网络₀ + Σ max(渲染, 网络)，波数越多省得越多。
       *
       * 首波尺寸收窄到 24：首个响应更早回来，第一批译文更早上屏（TTFT）；
       * 常规波保持 100 —— 单波失败重试的代价不翻倍，引擎负载不抬升。
       *
       * 预取的失败不污染当前波：inflight 挂了，本波照常渲染，
       * 下一波 await 到 null 走既有的 failed 分支。
       */
      var FIRST_WAVE = Math.min(WAVE_SIZE, 24);
      var waves = units.length > FIRST_WAVE
        ? [units.slice(0, FIRST_WAVE)].concat(chunk(units.slice(FIRST_WAVE), WAVE_SIZE))
        : [units];
      var inflight = translateWave(waves[0]);

      for (var w = 0; w < waves.length; w++) {
        var wave = waves[w];
        var res = await inflight;
        inflight = (w + 1 < waves.length) ? translateWave(waves[w + 1]) : null;

        if (!res) {
          failed += wave.length;
        } else {
          if (res.provider) state.lastProvider = res.provider;
          if (res.notice) state.lastNotice = res.notice;
          if (res.corrections) corrApplied += res.corrections;
          // v1.7.1：把后台的质量度量留下来，供 #ct-debug 打印
          if (res.metrics) state.lastMetrics = res.metrics;
          for (var k = 0; k < wave.length; k++) {
            var translation = res.translations ? res.translations[k] : null;
            if (!translation) { failed++; continue; }
            // plan 是采集阶段算好的插入点决策（内含按 display 的分流结果），
            // 这里直接透传，避免渲染阶段再读 computed style 造成强制同步布局
            // 第 6 参是原文文本（C-13 Q3：纠错闭环要用）
            if (R.renderUnit(wave[k].el, translation, state.settings, wave[k].hash, wave[k].plan, wave[k].text)) {
              done++;
              if (state.ttft === null) state.ttft = Math.round(now());
            }
          }
        }

        /*
         * 批末几何验真（v1.7.1）。
         * ------------------------------------------------------------------
         * 第一级只在采集阶段「打标」—— 凡是宿主或祖先写着 overflow:hidden /
         * 定高 / nowrap 的单元，都值得怀疑；但「值得怀疑」不等于「真的被裁」，
         * 而静态判据答不出后者（头像容器、清浮动的老代码都长一个样）。
         *
         * 所以在这里用真实矩形做判决：本批全部渲染完之后，一次性把
         * 被圈选单元的量测读数全部取回，再统一搬移不可见的那些。
         *
         * 为什么按批而不按单元：量矩形会强制布局。逐单元「写一个量一个」
         * 会把一个长页面抖出上百次布局；按批则整批只抖一次。
         * 这与「插入点决策全部前置到采集阶段」是同一条理由。
         */
        var batchEls = [];
        for (var bi = 0; bi < wave.length; bi++) batchEls.push(wave[bi].el);
        var relocatedCount = R.verifyBatch(batchEls);
        if (relocatedCount) relocatedTotal += relocatedCount;

        // 进度刷新节流：徽标改的是 DOM、上报要走一次消息，
        // 每波都做会让长页面产生上百次无意义的布局与消息开销。
        var nowTs = Date.now();
        if (w === waves.length - 1 || nowTs - lastProgressAt >= PROGRESS_MIN_MS) {
          lastProgressAt = nowTs;
          state.progressText = done + ' / ' + total;
          showProgressBadge('翻译中 ' + done + ' / ' + total);   // C-43：开关在场时让位
          syncToggle();
        }
      }

      state.progressText = '';

      /*
       * 排障专用：URL 带 #ct-debug 时打印可见性审计摘要。
       * ------------------------------------------------------------------
       * 这不是调试残留，是**可执行证据**。用户拿一张截图来报障时，
       * 单凭截图无法唯一确定「译文是被谁的 overflow 吃掉的」——
       * 那就让扩展自己在现场把答案量出来：哪条译文、什么原因、矩形差多少。
       * 与 renderer 的第二级判决用同一个判据函数，因此结果口径一致。
       */
      if (location.hash.indexOf('ct-debug') >= 0 && R.auditSummary) {
        var audit = R.auditSummary();
        console.log('[叠译] 译文可见性审计：' + audit.total + ' 条异常',
          audit.byReason, '状态', R.getStats());
        if (audit.items.length) console.table(audit.items);
        // 翻译质量度量：术语命中 / 占位符守恒 / 数组对齐 / 长度膨胀
        if (state.lastMetrics) {
          console.log('[叠译] 翻译质量度量：', state.lastMetrics,
            '（termMasked 术语命中；maskLoss 占位符被破坏；alignFails 译文错位；lenAvg/lenMax 长度膨胀比）');
        }
      }

      if (done > 0) {
        // v1.7.5（C-17 F1）：命中用户修正时明确告知 —— E6 实测「功能环闭合、
        // 感知环断裂」，用户无法区分「修正生效」与「引擎碰巧译对」。
        var doneText = '已译 ' + done + ' 段'
          + (corrApplied ? '（含你的修正 ' + corrApplied + ' 句）' : '')
          + (failed ? '（' + failed + ' 段失败）' : '');
        /* C-44（v1.7.7）：状态一体化 —— 成功终态在开关上闪现 3.2s 再回落
         * 「显示原文」，不再绕道右下角徽标（视线经济：用户点开关发起翻译，
         * 开始/进行/完成都应发生在视线所在处）。开关不在场或收起时徽标仍是
         * 回退面；**错误不走此路**（需要点击出路与长停留，归徽标，
         * 见 docs/UX设计结论-状态一体化-2026-09-29.md 归属矩阵）。 */
        if (statusOnToggle() && state.toggle) {
          state.toggle.update({ flashText: doneText, flashMs: 3200 });
        } else {
          showBadge(doneText, failed && !done ? 'error' : 'done');
        }
        report('done');
        // C-51（2026-09-29）：用户裁决「页面不再展示『改』字」——纠错入口示意角标
        // 整体下线（原 v1.7.5 C-17 F2 每轮自动亮 6 秒的 .ct-corr-hint 已删除），
        // 纠错入口收敛为「悬停译文 → 铅笔 chip」单一通道。
      } else if (failed) {
        // C-60：不把「引擎配置」这类术语摊给用户，改为一句现象 + 一个可点的动作
        showTranslateFailed();
        report('error');
      } else {
        hideBadge();
        report('done');
      }
    } catch (e) {
      console.warn('[叠译] 翻译流程异常：', e);
      // C-60：异常同样给「人话 + 出路」，原始报错只进 console
      showTranslateFailed();
      report('error');
    } finally {
      state.running = false;
      state.progressText = '';
      // 一轮结束，开关从「翻译中」回到「已译 / 未开启」。
      // 放在 finally 是因为异常路径同样要恢复 —— 否则开关会永远停在忙碌态。
      syncToggle();

      /* B2-5（C-67）：顶层本轮翻译收尾后读瞬态 framesSkipped ——
       * 只有当页检测用（frame 被跳过的瞬态计数），抑制另由持久键负责。 */
      if (reason !== 'mutation') checkFramesSkipped();

      // 顺带回收指向已脱离文档节点的登记记录（单页应用切路由后尤其明显）。
      // 只在增量轮次做，成本是 O(已登记单元数)，且只读属性、不碰布局。
      if (reason === 'mutation') R.pruneDisconnected();

      if (state.needsFullScan) {
        state.needsFullScan = false;
        state.pendingRoots.length = 0;
        // 挪到下一个任务循环，避免深递归
        setTimeout(function () { run('queued'); }, 0);
      } else if (state.pendingRoots.length) {
        var next = takeRoots();
        setTimeout(function () { run('queued', next); }, 0);
      }
    }
  }

  /** 提交一波，失败自动重试一次（service worker 冷启动常见偶发失败） */
  async function translateWave(wave) {
    var payload = {
      type: CT.MSG.TRANSLATE,
      source: state.sourceLang,
      target: state.settings.targetLang,
      // v1.7：带上本 frame 的可视面积。后台的每页 frame 预算
      // （background/frame-budget.js）在用完名额后会按面积顶替 ——
      // 面积大的 frame 更可能是正文，让它挤掉当前最小的那个。
      frameArea: (state.frameGate && state.frameGate.area) || 0,
      // v1.7.2：本页场景。后台据此启用场景限定条目（招聘页 Apply→申请 等）。
      // 场景参与 termHash → 招聘页与非招聘页缓存自然分流。
      scene: state.scene || [],
      // ctx 是「位置线索」（通常是所属区块的标题），只对短文本有意义。
      // 后台只在 LLM 引擎上使用它 —— Google / DeepL / 内置模型的接口
      // 都只吃纯文本，塞进去只会污染译文。
      items: wave.map(function (u) { return { text: u.text, ctx: u.ctx || '' }; })
    };

    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        var res = await send(payload);
        if (res && res.ok) return res;
        if (attempt === 1) {
          state.lastNotice = (res && res.notice) || '翻译服务返回失败';
          return null;
        }
      } catch (e) {
        if (attempt === 1) {
          state.lastNotice = e && e.message ? e.message : '无法连接扩展后台';
          return null;
        }
      }
      // 重试前稍等，给 service worker 唤醒留时间
      await new Promise(function (r) { setTimeout(r, 350); });
    }
    return null;
  }

  /* ================================================================
   * 抖动守卫 + 动态内容观察
   * ================================================================ */

  /** 从节点向上找最近的「已登记为翻译单元」的祖先（含自身） */
  function nearestUnit(node) {
    var el = node && (node.nodeType === 1 ? node : node.parentElement);
    while (el) {
      if (R.registry.has(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  /**
   * 把一次变更归到「真正需要重扫的那棵子树上」
   * ------------------------------------------------------------------
   * 这是增量更新的关键，旧实现直接取变更节点的父元素，于是有两头都错：
   *
   *   · 范围过小（漏翻）：变更落在一个已翻译 <p> 的行内子节点里
   *     （<p>正文 <a>链接</a></p> 这种极常见的结构），父元素是 <a>，
   *     对它采集永远没有结果 —— 而 <p> 的译文已经和原文对不上了，
   *     此后也不会再有人去修它。
   *   · 范围过大（浪费）：变更落在高层容器上时，重扫整棵容器。
   *
   * 改为先向上找最近的已登记单元：找到就只重扫它一个（内容没变会被
   * 指纹幂等跳过，代价接近零）；找不到才退回变更节点自身 ——
   * 那说明是尚未翻译过的新内容。
   */
  function scopeOf(node) {
    var unit = nearestUnit(node);
    if (unit) return unit;
    if (!node) return null;
    return node.nodeType === 1 ? node : node.parentElement;
  }

  /**
   * C-71（T7）：把 root 归一为 **Element[]**。
   * 接受 Element ｜ Element[] ｜ `{el,mask}[]`（queued 路径保 mask 的条目数组）。
   * **归一许可点只有两处**：`run()` 入口 与 `run()` 的重入分支。
   * 契约（写死）：`addRoot` / `addRoots` / `scanRoots` / `collectUnits` **只收 Element**。
   */
  function rootsToElements(root) {
    if (!root) return null;
    var list = Array.isArray(root) ? root : [root];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      var el = (it && it.nodeType === 1) ? it : (it && it.el);
      if (el) out.push(el);
    }
    return out;
  }

  /**
   * 并入待处理队列：祖先去重 + 数量上限保护。
   * C-71（T1/T3/T5′/T9）：条目形态 = `{ el, mask }` —— **`kind` 内联在条目上，不另开
   * WeakMap 旁表**（条目与数组同生共死 ⇒ 零清理代码、零孤儿）：
   *   · 命中去重（已被覆盖）⇒ **mask 按位 OR 合并**进既有条目（同键多类型不丢信息）；
   *   · 吸收（用更外层替换内层）⇒ **splice 前把内层条目的 mask OR 进外层**（防丢计数）；
   *   · `ROOT_LIMIT` 清队 ⇒ 推 `{ el: document.body, mask: 0 }`（整页扫描无类型上下文）。
   */
  function addRoot(el, mask) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return;
    var arr = state.pendingRoots;
    var m = (typeof mask === 'number') ? mask : 0;

    for (var i = 0; i < arr.length; i++) {
      if (arr[i].el === el || arr[i].el.contains(el)) {   // 已被覆盖 ⇒ 合并类型位
        arr[i].mask = (arr[i].mask | m);
        return;
      }
    }
    // 反过来包含已有根 → 用更外层的替换，减少扫描次数（内层 mask 收口到外层）
    var outerMask = m;
    for (var j = arr.length - 1; j >= 0; j--) {
      if (el.contains(arr[j].el)) {
        outerMask = outerMask | arr[j].mask;
        arr.splice(j, 1);
      }
    }
    if (arr.length >= ROOT_LIMIT) {
      // 页面正在大规模重建（骨架屏换正文、整表刷新）：逐个子树调度已不划算，
      // 收拢成一次整页扫描反而更省。
      arr.length = 0;
      arr.push({ el: document.body, mask: 0 });
      return;
    }
    arr.push({ el: el, mask: outerMask });
  }

  function addRoots(roots, mask) {
    var list = Array.isArray(roots) ? roots : [roots];
    for (var i = 0; i < list.length; i++) addRoot(list[i], mask);
  }

  /** C-71（T6）：返回**条目数组** `{el,mask}[]`（**保 mask**，由 `run()` 入口归一）。 */
  function takeRoots() {
    var arr = state.pendingRoots;
    state.pendingRoots = [];
    return arr;
  }

  /**
   * C-71（T3）：抖动守卫**分两桶**。
   *   · `content` 型（mask 无 attr 位）：`JITTER_LIMIT = 5` + 写 `data-ct-skip`
   *     （**永久**拉黑，**行为等价**于改前，`DL-24`）；
   *   · `attr` 型：`JITTER_ATTR_LIMIT = 20`，超限**只 `return true`（跳本轮）**、
   *     **不写 `data-ct-skip`**（不永久拉黑）⇒ 计数复位 ⇒ 下一轮即恢复（可恢复性）。
   *   · **`attr` 位优先**（fail-safe）：两个错误方向不对称 —— `attr` 桶只跳本轮
   *     （**可恢复**）、`content` 桶**永久拉黑**（**不可恢复**）⇒ 混合命中必须往
   *     可恢复的一侧倒。（`M2-a`/`M2-b` 正是钉住这条，两种书写序都要成立。）
   */
  function noteChange(el, mask) {
    if (!el || el.nodeType !== 1) return false;

    var isAttr = ((typeof mask === 'number' ? mask : 0) & KIND_ATTR) !== 0;
    var limit = isAttr ? JITTER_ATTR_LIMIT : JITTER_LIMIT;

    var rec = jitter.get(el);
    var now = Date.now();
    if (!rec || now - rec.firstAt > JITTER_WINDOW_MS) {
      jitter.set(el, { count: 1, firstAt: now });
      return false;
    }
    rec.count++;
    if (rec.count > limit) {
      // content 型：内容在以秒级频率变化（时钟、浏览量、倒计时），继续翻译只会
      // 不断烧接口额度 ⇒ 永久跳过（写 data-ct-skip）。
      // attr 型：人机开合（折叠/展开）不该被永久拉黑 ⇒ 只跳本轮（不写属性）。
      if (!isAttr) el.setAttribute('data-ct-skip', 'jitter');
      jitter.delete(el);
      return true;
    }
    return false;
  }

  function startObserver() {
    if (state.observer || !document.body) return;

    var timer = null;

    function flush() {
      timer = null;
      if (!state.pendingRoots.length) return;
      if (!state.enabled) { state.pendingRoots.length = 0; return; }

      // C-71（T2）：`takeRoots()` 返回**条目数组** `{el,mask}[]` ⇒ 逐条目取 `el` 与
      // 类型位，把 `mask` 带到判定点交给 `noteChange` 分桶（**本处不做 Element 归一**，
      // 一旦归一就会丢掉 mask；归一许可点只有 run() 入口与其重入分支）。
      var roots = takeRoots();
      var accepted = [];
      for (var i = 0; i < roots.length; i++) {
        var entry = roots[i] || {};
        var el = entry.el || entry;              // 容错：裸 Element 条目也能跑
        if (!el || !el.isConnected) continue;
        if (noteChange(el, entry.mask)) continue;
        accepted.push(el);
      }
      if (!accepted.length) return;
      run('mutation', accepted);
    }

    state.observer = new MutationObserver(function (records) {
      if (!state.enabled) return;

      for (var i = 0; i < records.length; i++) {
        var rec = records[i];

        if (rec.type === 'childList') {
          for (var j = 0; j < rec.addedNodes.length; j++) {
            var n = rec.addedNodes[j];
            if (isOwnNode(n)) continue;
            addRoot(scopeOf(n), KIND_CONTENT);      // 内容型
          }
        } else if (rec.type === 'characterData') {
          if (isOwnNode(rec.target)) continue;
          addRoot(scopeOf(rec.target), KIND_CONTENT);   // 内容型
        } else if (rec.type === 'attributes') {
          /*
           * C-45（v1.7.7）：折叠/展开往往是**纯 class 切换**（remoteok 实测：
           * `tr.expand` + `active`，零 childList、零 characterData）——
           * 旧 observer 只听 childList/characterData，展开动作完全不可见，
           * 而首扫又跳过了不可见子树（C-45 配套）⇒ 展开后永远没人翻。
           * 属性变更目标 scopeOf 入队，走既有 700ms 防抖 + 去重 + jitter 通道。
           * attributeFilter 限 class/style/hidden，避免 src 轮询类噪声灌爆队列。
           */
          if (isOwnNode(rec.target)) continue;
          addRoot(scopeOf(rec.target), KIND_ATTR);      // 属性型（C-71 T1）
        }
      }

      if (!state.pendingRoots.length) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 700);
    });

    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden']
    });
  }

  function stopObserver() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    state.pendingRoots.length = 0;
    state.needsFullScan = false;
  }

  /* ================================================================
   * 页内纠错闭环（v1.7.4，C-13 Q3）
   * ------------------------------------------------------------------
   * 用户看到错译，在译文上悬停 → 出现「改」入口 → 行内输入修正 →
   * 提交落库（settings.corrections，整句精确匹配）→ 屏上译文立即替换。
   * 下一次翻译同一句原文时，后台组批前短路命中，用户意志终审。
   *
   * 实现纪律：
   *   · 全程事件委托 + 单例浮层 —— 一千个译文的页面也不多挂一个监听器；
   *   · 浮层只读注册表（R.registry），不持有页面状态，页面重建子树后自然失效；
   *   · 保存走 SAVE_CORRECTION 消息，成功后用 R.renderUnit 重渲染该单元
   *     （renderUnit 自带 clearUnit，幂等），不另写替换路径 —— 两处状态必漂移。
   * ================================================================ */
  var corr = { chip: null, editor: null, host: null, lastHost: null };

  /** 从事件目标向上找「带 data-ct-src 的宿主」。译文节点可能是宿主的
   *  兄弟（sibling 模式），所以每层同时看自身与上一个兄弟。 */
  function corrFindHost(n) {
    var cur = n;
    var hops = 0;
    while (cur && cur.nodeType === 1 && hops < 5) {
      if (cur.hasAttribute && cur.hasAttribute('data-ct-src')) return cur;
      var prev = cur.previousElementSibling;
      if (prev && prev.hasAttribute && prev.hasAttribute('data-ct-src')) return prev;
      cur = cur.parentElement;
      hops++;
    }
    return null;
  }

  function corrEnsureChip() {
    if (corr.chip) return corr.chip;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ct-corr-chip';
    b.setAttribute('translate', 'no');
    /* C-51（2026-09-29）：用户裁决「页面不再展示『改』字」——chip 图标从
     * 「改」单字改为铅笔「✎」（语义 = 编辑/修正，读屏与悬停语境不变）。
     * UX 终审（C-46）曾保留「改」单字，本次按用户裁决推翻；
     * aria-label 让读屏跳过图标歧义、直接念出动作意图。 */
    b.textContent = '✎';
    b.setAttribute('aria-label', '修正这句翻译');
    b.title = '这句翻译不对？点这里修正';
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      // 用 lastHost 而不是 host：点击前鼠标必然先移过 chip 本身，
      // 那次 mouseover 会把 host 清空（L-12 时序坑）—— lastHost 不受影响
      corrOpenEditor(corr.lastHost || corr.host);
    });
    document.documentElement.appendChild(b);
    corr.chip = b;
    return b;
  }

  function corrEnsureEditor() {
    if (corr.editor) return corr.editor;
    var d = document.createElement('div');
    d.className = 'ct-corr-editor';
    d.setAttribute('translate', 'no');
    var tip = document.createElement('div');
    tip.className = 'ct-corr-tip';
    var ta = document.createElement('textarea');
    ta.className = 'ct-corr-ta';
    ta.rows = 2;
    var bar = document.createElement('div');
    bar.className = 'ct-corr-bar';
    var ok = document.createElement('button');
    ok.type = 'button'; ok.className = 'ct-corr-btn ct-corr-ok'; ok.textContent = '记下修正';
    var cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'ct-corr-btn'; cancel.textContent = '取消';
    bar.appendChild(ok); bar.appendChild(cancel);
    d.appendChild(tip); d.appendChild(ta); d.appendChild(bar);
    document.documentElement.appendChild(d);
    corr.editor = { root: d, tip: tip, ta: ta };

    ok.addEventListener('click', function () { corrCommit(); });
    cancel.addEventListener('click', function () { corrClose(); });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); corrCommit(); }
      else if (e.key === 'Escape') { e.preventDefault(); corrClose(); }
      e.stopPropagation();
    });
    return corr.editor;
  }

  function corrOnOver(e) {
    // 自己的浮层（chip / 编辑器）上的 mouseover 不参与目标解析 ——
    // 否则「移向 chip」这个动作本身就会把 host 清空，点击时无从打开编辑器
    if (corr.chip && corr.chip.contains(e.target)) return;
    if (corr.editor && corr.editor.root.contains(e.target)) return;
    if (!state.settings || !state.enabled) { corrHideChip(); return; }
    var host = corrFindHost(e.target);
    if (!host) { corrHideChip(); return; }
    var rec = R.registry.get(host);
    // 没有原文记录（例如页面自己带 data-ct-src 属性）就不出入口
    if (!rec || !rec.src) { corrHideChip(); return; }
    corr.host = host;
    corr.lastHost = host;
    var chip = corrEnsureChip();
    var x = Math.min(e.clientX + 8, window.innerWidth - 40);
    var y = Math.min(e.clientY + 12, window.innerHeight - 32);
    chip.style.left = x + 'px';
    chip.style.top = y + 'px';
    chip.classList.add('ct-corr-on');
  }

  function corrHideChip() {
    corr.host = null;
    if (corr.chip) corr.chip.classList.remove('ct-corr-on');
  }

  function corrOpenEditor(host) {
    var rec = R.registry.get(host);
    if (!rec || !rec.src) return;
    var ed = corrEnsureEditor();
    // 先收 chip 再记 host：corrHideChip 会清 corr.host，顺序反了
    // 提交时拿到的一定是 null（e2e 探针实测的静默失败）
    corrHideChip();
    ed.tip.textContent = '原文：' + (rec.src.length > 60 ? rec.src.slice(0, 60) + '…' : rec.src);
    ed.ta.value = rec.text || '';
    corr.host = host;
    corr.lastHost = host;
    // 会话绑定：提交目标取自打开编辑器那一刻的 host ——
    // 编辑器出现后 Chrome 会补发 mouseover(BODY)（指针下元素变了），
    // corrHideChip 会清 corr.host，悬停状态活不到点击时刻（L-12）
    ed.host = host;
    corrPlaceEditor(host, ed);
    ed.root.classList.add('ct-corr-on');
    setTimeout(function () { ed.ta.focus(); ed.ta.select(); }, 0);
  }

  /** 编辑器贴着宿主定位（fixed 视口坐标）。C-25：提取成独立函数，
   *  页面滚动时跟随宿主重新定位 —— 不关闭，避免丢用户正在输入的内容。 */
  function corrPlaceEditor(host, ed) {
    var r = host.getBoundingClientRect();
    var x = Math.min(Math.max(r.left, 8), window.innerWidth - 300);
    var y = Math.min(r.bottom + 6, window.innerHeight - 140);
    ed.root.style.left = x + 'px';
    ed.root.style.top = y + 'px';
  }

  /*
   * C-25（v1.7.6 验收期）：滚动时的浮层残影。
   * ------------------------------------------------------------------
   * chip / 编辑器都是 position:fixed（视口坐标），且只在 mouseover 时
   * 更新位置或隐藏 —— 而**滚动不触发 mouseover**。用户悬停译文亮出
   * 「改」chip 后滚轮一滚，页面内容从 fixed 浮层底下溜走，chip 就
   * 孤悬在无关的空白处（remoteok.com 侧栏真实截图）。
   * 同文件的划词 tooltip 早就配了 scroll 隐藏（hideTip），纠错浮层漏配。
   * 处理：chip 滚动即收（无状态，丢了重悬停就有）；
   * 编辑器不关（用户可能正在输入），跟随宿主重新定位，
   * 宿主脱离文档或滚出视口才收。
   */
  function corrOnScroll() {
    if (corr.chip && corr.chip.classList.contains('ct-corr-on')) {
      corrHideChip();
    }
    if (corr.editor && corr.editor.root.classList.contains('ct-corr-on') && corr.editor.host) {
      var h = corr.editor.host;
      if (!h.isConnected) { corrClose(); return; }
      var r = h.getBoundingClientRect();
      if (r.bottom < -40 || r.top > window.innerHeight + 40) { corrClose(); return; }
      corrPlaceEditor(h, corr.editor);
    }
  }

  function corrClose() {
    if (corr.editor) corr.editor.root.classList.remove('ct-corr-on');
  }

  async function corrCommit() {
    if (!corr.editor || !corr.editor.host) return;
    var host = corr.editor.host;
    var rec = R.registry.get(host);
    var text = corr.editor.ta.value.trim();
    if (!rec || !rec.src || !text) { corrClose(); return; }
    if (text === rec.text) { corrClose(); return; }   // 没改东西就不落库
    var res = await send({
      type: CT.MSG.SAVE_CORRECTION,
      from: rec.src,
      to: text,
      /* B2-1（D-B2-01 口径变更）：补旧机器译文 + 目标语。
       * 词级候选提炼需「旧译文 → 新译文」的**同语言**两侧做 diff ——
       * 原 (英文原文, 中文新译文) 是跨语言对、不可 diff（详设 §2.1 前提修正）。
       * prev 仅用于本次提炼，不落任何存储；worker 据此算目标侧跨度。 */
      prev: rec.text,
      tgt: 'zh-CN'
    });

    if (!res || !res.ok) {
      showBadge('修正保存失败：' + ((res && res.error) || '未知错误'), 'error');
      return;
    }
    corrClose();
    // 屏上立即替换：走 renderUnit 本身（幂等），不另写替换路径
    /* C-42（v1.7.7）：renderUnit 的第 6 参 srcText 才是 rec.src 的来源
     * （C-13 Q3）。这里漏传了 —— 重渲染会把 registry 里该宿主的记录
     * 覆盖成 src:''，corrOnOver 在「!rec.src」分支提前退出：
     * **被修正过的那一句，悬停从此再也不出「改」chip**，纠错入口
     * 对该句永久死亡（probe-corr-hint-click ⑤ 实测复现）。
     * 修法：把 rec.src 传回去，让修正后的句子仍是可纠错的一句。 */
    R.renderUnit(host, text, state.settings, rec.srcHash, null, rec.src);
    /* B2-2（C-64）：即时反馈走**既有徽标通道**（唯一载体）。
     * 5s 存留 + 悬停暂停倒计时；点击徽标 → OPEN_OPTIONS 打开设置页「我的词典」
     * 作沉淀入口（一次性、非常驻）。文案零「改」字。 */
    showBadge('已修正，本次浏览生效', 'done', {
      ms: 5000,
      pauseOnHover: true,
      onClick: openMyDictionary
    });
    /* B2-1（C-63）：worker 在达阈值回带 suggestion 时弹学习确认卡；
     * 未达阈值第 1/2 次无 suggestion，不弹卡（静默生效）。 */
    if (res.suggestion) maybeShowLearnCard(host, res.suggestion);
  }

  function corrHide() {
    corrHideChip();
    corrClose();
  }

  /* ================================================================
   * B2-2 · 纠错沉淀入口（C-64）
   * ------------------------------------------------------------------
   * 提交修正成功后的即时反馈走**既有徽标通道**（showBadge，见 corrCommit）：
   * 5s 存留 + 悬停暂停倒计时；点击徽标 → 打开设置页「我的词典」作沉淀入口。
   * 一次性、非常驻；**不得复活 .ct-corr-hint**（C-51 回归护栏）。
   * （原 UX §4 内联条方案已按 team-lead 裁定 1 移除，避免同屏双显示；
   *   A-05 用签署用例钉死 `.ct-badge__text` + onClick→OPEN_OPTIONS。）
   * ================================================================ */
  /** 打开设置页（沉淀入口唯一通道 = 既有 OPEN_OPTIONS 消息，后台代开） */
  function openMyDictionary() {
    send({ type: CT.MSG.OPEN_OPTIONS }).catch(function () {
      console.warn('[叠译] 打开设置页失败');
    });
  }

  /* ================================================================
   * B2-1 · 学习确认卡（C-63）
   * ------------------------------------------------------------------
   * 反复把 X 改成 Y 达阈值 N=3 后，worker 在 SAVE_CORRECTION 响应里回带
   * suggestion；本层据此弹一张【非模态锚定浮层】（不遮挡正文、不设遮罩）。
   *
   * 三条硬约束：
   *   1) 仲裁：必须经 CT.layers.acquire('learn')（PRIORITY.learn=2.5）。
   *      同刻有 confirm/tip/selection 展开时申请被拒、不抢位（零打扰）。
   *   2) 每会话最多 CT.LEARNING.SESSION_MAX_CARDS 张卡 —— 达上限停止弹卡，
   *      候选继续计数、留待下次会话（不排队、不合并）。计数用进程内存。
   *   3) 点确认才写词典；「不用了」/Esc/点卡外 → DISMISS_PATTERN，
   *      同一候选不再弹（dismissed 落 ct.corrStats，worker 侧负责）。
   * ================================================================ */
  var learnCardsShown = 0;   // 会话内已弹卡数（进程内存，刷新即归零）
  var learnEl = null;
  var learnKey = null;
  var learnOutside = null;
  var learnCand = null;      // 当前卡的候选 { from, to }

  /** HTML 转义：候选 from/to 来自用户纠错文本，可能含 < > & */
  function learnEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function maybeShowLearnCard(host, sug) {
    if (!sug || !sug.from || !sug.to) return;
    if (learnEl) return;   // 同刻只允许一张
    if (learnCardsShown >= CT.LEARNING.SESSION_MAX_CARDS) return;   // 达会话上限，停弹
    // 仲裁：拿不到展开权就放弃，不把别的浮层顶掉
    if (CT.layers && typeof CT.layers.acquire === 'function') {
      if (!CT.layers.acquire('learn', function () { closeLearnCard(false); })) return;
    }
    learnCardsShown++;
    buildLearnCard(host, sug);
  }

  function buildLearnCard(host, sug) {
    var card = document.createElement('div');
    card.className = 'ct-learn-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'false');
    card.setAttribute('tabindex', '-1');
    card.setAttribute('translate', 'no');

    var title = document.createElement('div');
    title.className = 'ct-learn-title';
    // B2 迭代 A2：提议式统一标题（两态同款）。零「改」字（C-51）；
    // 「修正成了」= 修+正，不再把 G2 反查的**推断**说成「检测到你…一直改成」的事实。
    title.innerHTML = '你最近把 <b>' + learnEsc(sug.from) + '</b> 修正成了 <b>'
      + learnEsc(sug.to) + '</b>，要我在别处也这么译吗？';
    card.appendChild(title);

    // 学习预期三句：本地学习 / 只影响自己 / 可撤销
    var expect = document.createElement('div');
    expect.className = 'ct-learn-expect';
    expect.textContent = '不经过我们的服务器，别人看不到，随时可以删。';
    card.appendChild(expect);

    // B2 迭代 A2：按钮旁副文本 —— 保留「我的词典」关键词（探针依赖），
    // 并把「自动=泛化」显式说出。零「改」字。
    var sub = document.createElement('div');
    sub.className = 'ct-learn-sub';
    sub.textContent = '加入我的词典，以后自动这样';
    card.appendChild(sub);

    var bar = document.createElement('div');
    bar.className = 'ct-learn-bar';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ct-learn-btn ct-learn-cancel';
    cancel.textContent = '不用了';
    var ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'ct-learn-btn ct-corr-ok ct-learn-ok';
    ok.textContent = '加入';
    bar.appendChild(cancel);
    bar.appendChild(ok);   // 主按钮在右
    card.appendChild(bar);

    (document.body || document.documentElement).appendChild(card);
    learnEl = card;
    learnCand = { from: sug.from, to: sug.to };

    ok.addEventListener('click', function () { commitLearn(); });
    cancel.addEventListener('click', function () { dismissLearn(); });

    positionLearnCard(host, card);

    // 出现动效：opacity 0→1 + translateY(4px→0)，160ms ease-out
    requestAnimationFrame(function () { card.classList.add('ct-learn-on'); });
    // 焦点入卡（非焦点锁）：键盘用户可 Esc 关闭
    setTimeout(function () { try { card.focus(); } catch (e) { /* 忽略 */ } }, 0);

    // Esc = 「不用了」
    learnKey = function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismissLearn(); }
    };
    document.addEventListener('keydown', learnKey, true);
    // 点击卡外 = 「不用了」；用捕获 mousedown，避开与卡内按钮 click 的竞态
    learnOutside = function (e) {
      if (learnEl && !learnEl.contains(e.target)) dismissLearn();
    };
    setTimeout(function () { document.addEventListener('mousedown', learnOutside, true); }, 0);
  }

  /** 贴着触发单元定位（fixed 视口坐标），四周离锚点 8px，视口内翻转避让 */
  function positionLearnCard(host, card) {
    var PAD = 8;
    var W = 300;
    var r = host.getBoundingClientRect();
    var left = Math.min(Math.max(r.left, PAD), Math.max(PAD, window.innerWidth - W - PAD));
    var estH = card.offsetHeight || 150;
    var top = r.bottom + PAD;
    if (top + estH > window.innerHeight - PAD) {
      var up = r.top - estH - PAD;
      top = up >= PAD ? up : Math.max(PAD, window.innerHeight - estH - PAD);
    }
    card.style.left = left + 'px';
    card.style.top = top + 'px';
  }

  async function commitLearn() {
    var cand = learnCand;
    closeLearnCard(true);
    if (!cand) return;
    var payload = {
      type: CT.MSG.LEARN_PATTERN,
      from: cand.from,
      to: cand.to,
      tgt: CT.LEARNING.TGT
    };
    var res = await send(payload).catch(function () { return null; });
    if (!res || !res.ok) {
      // 失败一律不写词典、零「改」字；audit-failed = 术语校验未过 → 中性告知。
      showBadge('这条暂时存不了', 'error');
    }
  }

  function dismissLearn() {
    var cand = learnCand;
    closeLearnCard(true);
    if (!cand) return;
    send({
      type: CT.MSG.DISMISS_PATTERN,
      from: cand.from,
      to: cand.to,
      tgt: CT.LEARNING.TGT
    }).catch(function () { /* 忽略 */ });
  }

  function closeLearnCard(release) {
    if (learnKey) { document.removeEventListener('keydown', learnKey, true); learnKey = null; }
    if (learnOutside) { document.removeEventListener('mousedown', learnOutside, true); learnOutside = null; }
    var el = learnEl;
    learnEl = null;
    learnCand = null;
    if (release && CT.layers && typeof CT.layers.release === 'function') CT.layers.release('learn');
    if (el) {
      el.classList.remove('ct-learn-on');
      el.classList.add('ct-learn-out');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 140);
    }
  }

  /* ================================================================
   * B2-5 · 能力边界一次性提示（C-67）
   * ------------------------------------------------------------------
   * 首次命中「内容被隔离、译不到」的场景（iframe / Shadow(open)）给一次说明，
   * 人话、零 AI 术语、可关闭、不阻断正文；经 CT.layers.acquire('guide')
   * 最低优先级仲裁 —— 任何既有浮层展开时被拒、不争位。
   *
   * 【检测（瞬态）与抑制（持久）必须分离】（CTO §7.9）：
   *   · 检测用瞬态信号（本页 iframe 存在 / GET_TAB_STATS.framesSkipped）。
   *   · 抑制只由持久键 chrome.storage.local['ct.capNoticeSeen'] 负责，
   *     形状 { iframe?, shadow? }，两子类各占独立位、作用域=全局（不分 tab）。
   *   · framesSkipped 随 worker 重启归零，**只用于当页检测**，绝不做抑制。
   *   · 抑制键落 local、**绝不进 settings**（否则 onChanged 触发整页重扫）。
   *   · closed shadow root 不可检测 → 永不提示、永不写键。
   * ================================================================ */
  var capEl = null;
  var capTimer = null;
  var capSeenCache = null;    // local['ct.capNoticeSeen'] 的内存镜像
  var capSeenPromise = null;  // 首次读取去重，避免并发重复 get
  var capShownThisLoad = {};  // 本页会话已提示的子类，防同页重复

  function capNoticeKey() {
    return CT.STORAGE && CT.STORAGE.CAP_NOTICE;
  }

  function readCapSeen() {
    if (capSeenCache) return Promise.resolve(capSeenCache);
    if (capSeenPromise) return capSeenPromise;
    capSeenPromise = new Promise(function (resolve) {
      var key = capNoticeKey();
      if (!key || !chrome.storage || !chrome.storage.local) { resolve({}); return; }
      try {
        chrome.storage.local.get(key, function (res) {
          void chrome.runtime.lastError;
          var v = res ? res[key] : null;
          capSeenCache = (v && typeof v === 'object') ? v : {};
          resolve(capSeenCache);
        });
      } catch (e) { resolve({}); }
    });
    return capSeenPromise;
  }

  /** 同步判据：本页已弹 / 持久键已抑制 → 不必再走（可能较贵的）检测 */
  function capAlreadySeen(type) {
    if (capShownThisLoad[type]) return true;
    return !!(capSeenCache && capSeenCache[type]);
  }

  function markCapSeen(type) {
    var key = capNoticeKey();
    if (!key) return;
    if (!capSeenCache) capSeenCache = {};
    capSeenCache[type] = true;
    var payload = {};
    payload[key] = capSeenCache;
    try {
      if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.set(payload, function () { void chrome.runtime.lastError; });
      }
    } catch (e) { /* 忽略 */ }
  }

  /** 抑制只认持久键；本页会话内也防重。拿不到展开权不算「已提示」，留待下次。 */
  function maybeCapNotice(type) {
    if (capShownThisLoad[type] || capEl) return;
    readCapSeen().then(function (seen) {
      if (seen && seen[type]) return;               // 已全局提示过 → 不再弹
      if (capShownThisLoad[type] || capEl) return;
      if (CT.layers && typeof CT.layers.acquire === 'function') {
        if (!CT.layers.acquire('guide', function () { hideCapNotice(false); })) return;
      }
      capShownThisLoad[type] = true;
      markCapSeen(type);                            // 提示后写持久键（全局一次性）
      showCapNotice();
    });
  }

  function showCapNotice() {
    var el = document.createElement('div');
    el.className = 'ct-cap-note';
    el.setAttribute('translate', 'no');
    el.setAttribute('role', 'status');

    var body = document.createElement('div');
    body.className = 'ct-cap-note__body';
    var main = document.createElement('div');
    main.className = 'ct-cap-note__main';
    main.textContent = '这段内容在网页里被特殊隔离，暂时译不到';
    var sub = document.createElement('div');
    sub.className = 'ct-cap-note__sub';
    // 只描述已覆盖的 iframe / Shadow(open)；不点名任何未支持类型
    sub.textContent = '有些内容暂时译不到，以后会逐步支持更多页面';
    body.appendChild(main);
    body.appendChild(sub);

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'ct-cap-note__close';
    close.setAttribute('aria-label', '关闭提示');
    close.textContent = '✕';
    close.addEventListener('click', function () { hideCapNotice(true); });

    el.appendChild(body);
    el.appendChild(close);
    (document.body || document.documentElement).appendChild(el);
    capEl = el;
    requestAnimationFrame(function () { el.classList.add('ct-cap-note--on'); });
    capTimer = setTimeout(function () { hideCapNotice(true); }, 4500);
  }

  function hideCapNotice(release) {
    if (capTimer) { clearTimeout(capTimer); capTimer = null; }
    var el = capEl;
    capEl = null;
    if (release && CT.layers && typeof CT.layers.release === 'function') CT.layers.release('guide');
    if (el) {
      el.classList.remove('ct-cap-note--on');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 240);
    }
  }

  /** 只在顶层 frame、依当前设置检测「被隔离且未覆盖」的场景（瞬态检测） */
  function capabilityDetectScenes() {
    if (!(FG && typeof FG.isTop === 'function' && FG.isTop())) return;
    var s = state.settings;
    if (!s) return;
    try {
      // ① iframe：覆盖被关掉且本页确实存在 iframe
      if (s.iframeEnabled === false && !capAlreadySeen('iframe')
        && document.querySelectorAll('iframe').length > 0) {
        maybeCapNotice('iframe');
      }
      // ② Shadow(open)：覆盖被关掉且扫描命中开放 shadow root（closed 恒查不到）
      if (s.shadowDomEnabled === false && !capAlreadySeen('shadow')
        && SW && typeof SW.findRoots === 'function'
        && SW.findRoots(document).length > 0) {
        maybeCapNotice('shadow');
      }
    } catch (e) { /* 检测失败静默，不打扰用户 */ }
  }

  /** 顶层 run() 之后读瞬态 framesSkipped —— 只做「当页检测」，绝不用于抑制 */
  function checkFramesSkipped() {
    if (!(FG && typeof FG.isTop === 'function' && FG.isTop())) return;
    send({ type: CT.MSG.GET_TAB_STATS }).then(function (res) {
      var st = res && res.ok ? res.stats : null;
      if (st && st.framesSkipped > 0) maybeCapNotice('iframe');
    }).catch(function () { /* 忽略 */ });
  }

  /* ================================================================
   * 纠错入口示意角标（v1.7.5 C-17 F2 引入）—— **C-51（2026-09-29）整体下线**
   * ------------------------------------------------------------------
   * 用户裁决「不想要在页面展示改字」：每轮翻译完成后自动亮 6 秒的
   * 「改」角标（.ct-corr-hint）是从用户视角看「页面主动展示改字」的
   * 唯一来源，整模块删除（showCorrHints / corrHideHints / corrHints）。
   * 纠错入口收敛为「悬停译文 → 铅笔 chip」单一通道（corrEnsureChip）；
   * UX-01（角标过期后静态零线索）随之消灭——不再有过期态。
   * ================================================================ */

  /* ================================================================
   * 启动与生命周期
   * ================================================================ */

  async function getSettings() {
    var res = await send({ type: CT.MSG.GET_SETTINGS });
    if (!res || !res.ok) throw new Error('无法读取扩展设置');
    return res.settings;
  }

  /** 只影响控件外观、与译文无关的设置键 */
  var TOGGLE_ONLY_KEYS = { toggleVisible: 1, toggleDefaultCollapsed: 1 };

  /** 值比较。设置里只有数组类型需要深比，其余用 === 足够。 */
  function sameValue(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    }
    return false;
  }

  /**
   * 本次设置变更是否只动了控件外观。
   * 用户在设置页反复试「显示控件 / 默认收起」的开关时，这类变更来得很快，
   * 而每一次都触发整页 collectUnits 是纯粹的浪费 —— 译文一个都不会变。
   */
  function isToggleAppearanceOnly(prev, next) {
    var k;
    for (k in next) {
      if (!Object.prototype.hasOwnProperty.call(next, k)) continue;
      if (TOGGLE_ONLY_KEYS[k]) continue;
      if (!sameValue(prev[k], next[k])) return false;
    }
    for (k in prev) {
      if (!Object.prototype.hasOwnProperty.call(prev, k)) continue;
      if (TOGGLE_ONLY_KEYS[k]) continue;
      if (!(k in next)) return false;
    }
    return true;
  }

  async function applySettings(next, reason) {
    try {
      await applySettingsInner(next, reason);
    } finally {
      // 控件同步统一收口在这里。applySettingsInner 有五个提前 return 的分支，
      // 逐个补 syncToggle() 迟早会漏 —— 而漏掉的表现是「开关显示已开启、
      // 页面却没翻译」，比干脆不显示还难向用户解释。
      syncToggle();
    }
  }

  async function applySettingsInner(next, reason) {
    var prev = state.settings;
    state.settings = next;

    // 全局总开关被改动（弹窗 / 设置页）→ 清掉本页的临时覆盖。
    // 否则用户在弹窗里打开总开关、这个页面却仍然关着，两个入口互相打架。
    if (prev && prev.enabled !== next.enabled) state.pageOverride = null;

    // 只改了控件外观 → 不重扫页面，直接返回（控件由外层 finally 同步）。
    // 这条短路只对「设置变更」成立：initial / manual / toggle-on 这些入口
    // 传进来的 set 可能与当前 state.settings 是同一个对象（boot 会先赋值再调用），
    // 那种情况下逐键比较必然全等，会被误判成「什么都没变」而跳过首次翻译。
    if (reason === 'settings' && prev && prev !== next && isToggleAppearanceOnly(prev, next)) return;

    // 本页被临时关掉，或全局总开关关闭 → 还原页面并停止观察
    if (!effectiveEnabled(next)) {
      stopObserver();
      hideTip();
      hideBadge();
      R.restoreAll();
      state.enabled = false;
      report('off');
      return;
    }

    var blocked = CT.settings.isBlockedHost(hostname(), next.blocklist);
    if (blocked) {
      state.enabled = false;
      stopObserver();
      return;
    }

    /*
     * v1.7：iframe 覆盖被关掉时，非顶层 frame 立即停。
     * manifest 里的 all_frames 是静态的、没法运行时改，所以 content script
     * 照样会注入进来 —— 但这一层可以决定「注入了也不干活」。
     */
    if (next.iframeEnabled === false && FG && typeof FG.isTop === 'function' && !FG.isTop()) {
      stopObserver();
      hideBadge();
      R.restoreAll();
      state.enabled = false;
      report('frame-disabled');
      return;
    }

    // 划词控制器的挂载/卸载跟着设置走；它与整页翻译互不依赖
    ensureSelection();

    // shadow 覆盖从「关」翻到「开」→ 需要重新扫一遍（标记位要复位）
    if (prev && prev.shadowDomEnabled === false && next.shadowDomEnabled !== false) {
      state.shadowScanned = false;
    }
    /* C-73 修①（签附①「换判据」版）：判据 = `effectiveEnabled(next)`（含 `pageOverride`）。
     * ------------------------------------------------------------------
     * 不用 `next.enabled !== false`：那会漏掉「**全局 `enabled=false` ＋ 用户点 `translateNow`**」
     * 这条 per-page 意图路径（`content.js:2350-2351` 注释：「即便全局总开关是关的，用户点了这一下
     * 就是要这一页有译文」）—— 该路径先置 `state.pageOverride = true` 才可翻译；`C-73 §5.1` 的
     * 三组真机读数已证后者过不了 (c)。
     * 语义：翻译由「不可跑」变为「可跑」时复位首扫闩 —— 否则 boot 期那次「扫了但翻译被关掉」
     * 的空转会把该 shadow 根永久闩死（`G-3`）。 */
    if (!state.enabled && effectiveEnabled(next)) state.shadowScanned = false;
    ensureShadowScan();

    /* B2-5（C-67）：依当前设置检测「内容被隔离、暂时译不到」的场景，
     * 首次命中给一次性说明（经 layers 低优先级仲裁、可关闭、不阻断正文）。 */
    capabilityDetectScenes();

    var wasEnabled = state.enabled;
    state.enabled = true;

    // 语言对发生变化 → 整页重来
    var langChanged = !prev
      || prev.targetLang !== next.targetLang
      || prev.sourceLang !== next.sourceLang;
    // 展示模式变化 → 需要撤掉已渲染译文，按新模式重画。
    // 插入方式与译文样式同理：译文节点的挂载位置、类名都变了，
    // 光改 CSS 变量救不回来，必须整体重建。
    var modeChanged = !prev
      || prev.displayMode !== next.displayMode
      || prev.insertMode !== next.insertMode
      || prev.transStyle !== next.transStyle;

    if (modeChanged) {
      R.resetForModeChange();
      // 译文被整体撤掉，下一段译文上屏是一次全新的「首次出现」，
      // TTFT 跟着重新计时，否则这个指标会一直停在很久以前的读数上
      state.ttft = null;
    } else if (prev && prev.fontSizeScale !== next.fontSizeScale) {
      // 只动了字号比例 → 就地刷新已渲染译文即可。
      // 字号是写在译文块上的 CSS 变量，不必整页重译，省掉一次全量重扫。
      R.refreshFontScale(next);
    }

    if (langChanged || reason === 'toggle-on' || reason === 'manual') {
      state.detected = D.detectPageLanguage();
      state.sourceLang = next.sourceLang === 'auto' ? state.detected.lang : next.sourceLang;
    }

    /*
     * 整页闸门：这一页到底需不需要翻。
     * 用 needsPageTranslation 而不是 isSameLanguage —— 后者把中文简繁
     * 视作同一种语言，于是「目标语言 = 繁体中文」在简体页面上永远是死格子。
     * 正字法信息由 detectPageLanguage 一并给出。
     */
    if (!CT.settings.needsPageTranslation(state.sourceLang, next.targetLang, state.detected && state.detected.variant)) {
      if (!wasEnabled) {
        console.info('[叠译] 页面语言已是目标语言，跳过翻译：', state.sourceLang,
          state.detected && state.detected.variant || '');
      }
      state.enabled = false;
      stopObserver();
      return;
    }

    if (!state.observer) startObserver();
    run(reason || 'settings');
  }

  CT.content = { translateRoots: function (roots) { return run('mutation', roots); } };
  async function boot() {
    var s;
    try {
      s = await getSettings();
    } catch (e) {
      console.warn('[叠译] 读取设置失败：', e);
      return;
    }

    state.siteState = await loadSiteState();

    /*
     * v1.7 第一步：frame 自我评估。
     * all_frames 打开之后本脚本会跑在**每一个**命中 matches 的 frame 里 ——
     * 包括广告位、统计像素、评论插件。真实页面里这些能占到 iframe 总数的大半
     * （新闻站 10–30 个、电商详情页 20–50 个），而跨域广告 iframe 的 URL
     * 必然是 https://，**必然命中 matches**。所以「值不值得翻」必须由 frame
     * 自己先答一次。
     *
     * 性能纪律：assess() 只读 innerWidth / innerHeight / innerText，
     * 绝不调用 getComputedStyle —— 它跑在每个 frame 里，成本会被 frame 数放大。
     */
    state.frameGate = FG.assess();
    FG.maybeLog();

    state.settings = s;

    /*
     * 划词在所有 frame 上都挂 —— 用户可能在任何位置划词，
     * 这与「这个 frame 值不值得整页翻译」是两件独立的事。
     * 注意划词不做 frame 预算：它是用户显式动作触发的，一次一句，
     * 不存在「被广告 frame 自动刷爆额度」的风险。
     */
    ensureSelection();

    if (!state.frameGate.ok) {
      // 本 frame 不值得整页翻译：不采集、不观察、不挂开关。
      // 静默退出 —— 广告 iframe 里不该往用户 Console 里刷日志。
      state.enabled = false;
      report('frame-skipped');
      return;
    }

    state.detected = D.detectPageLanguage();
    state.sourceLang = s.sourceLang === 'auto' ? state.detected.lang : s.sourceLang;

    // 设置一到位就把开关挂上，不等译文渲染完。
    // 用户对「装好了没有」的第一判断来自「页面上有没有反应」——
    // 若非要等整页译完才出现控件，装载慢的页面会有一段「什么都没发生」的空窗。
    // 控件本身只是一个 fixed 浮层，挂载成本可以忽略。
    syncToggle();

    // 页内快捷键与 shadow root 扫描不依赖「自动翻译」这个偏好：
    // 用户随时可能按键，也随时可能读一个 shadow 里的组件文档。
    ensureKeymap();
    ensureShadowScan();

    // 纠错闭环入口（C-13 Q3）：事件委托挂在 document 上，与开关状态无关地
    // 常驻 —— 未开翻译时 registry 为空，悬停不会出任何东西，零开销。
    document.addEventListener('mouseover', corrOnOver, true);
    // C-25：滚动不触发 mouseover，fixed 浮层必须自己监听滚动收起/跟随
    window.addEventListener('scroll', corrOnScroll, true);

    // 「自动翻译」是通用偏好；站点记忆是用户在具体站点上的明确选择 —— 后者优先。
    // 用户在某站点手动开过一次翻译，不该因为通用偏好是「关闭自动翻译」而被忽略。
    // C-54：同文档重新注入时（扩展更新接管等），上一实例的原文保持意图仍要尊重。
    var auto = (!!s.autoTranslate
      || (!!s.siteMemory && Object.prototype.hasOwnProperty.call(state.siteState, hostname())))
      && !state.holdOriginal;

    if (s.enabled && !auto) {
      // 关闭了「自动翻译」：不主动跑，也不启动观察器，
      // 但把状态准备好，等用户从页内开关 / 弹窗 / 右键菜单 / 快捷键手动触发。
      if (CT.settings.isBlockedHost(hostname(), s.blocklist)) return;
      state.enabled = false;
      syncToggle();
      return;
    }

    await applySettings(s, 'initial');
  }

  /* ================================================================
   * 退场
   * ================================================================ */

  /**
   * 让本实例彻底停摆，把页面交还给下一个注入的实例。
   * 只有两种情况会走到这里：扩展被更新/重载后新脚本接管，或本实例被显式卸下。
   * 关键在于「不能留下任何还会自己动起来的东西」—— 观察器、定时器、控件，
   * 以及存活位本身（置 false 后，下一次注入才知道可以接管）。
   * 译文块保持原样：它们是页面上的有效内容，清掉只会让用户看到一次闪回。
   */
  function teardown() {
    try { stopObserver(); } catch (e) { /* 未启动 */ }
    try { hideTip(); } catch (e) { /* 忽略 */ }
    try { hideBadge(); } catch (e) { /* 忽略 */ }
    if (state.toggle) {
      try { state.toggle.destroy(); } catch (e) { /* 忽略 */ }
      state.toggle = null;
    }
    /* ---- v1.7：新模块也要一起撤干净 ---- */
    if (state.keymapDetach) {
      try { state.keymapDetach(); } catch (e) { /* 忽略 */ }
      state.keymapDetach = null;
    }
    if (state.selectionReady) {
      try { SEL.destroy(); } catch (e) { /* 忽略 */ }
      state.selectionReady = false;
    }
    try { SW.reset(); } catch (e) { /* 忽略 */ }
    // 浮层仲裁器的状态也要清 —— 否则新实例接管后，
    // 仲裁器还以为「划词气泡开着」，于是拒绝挂载菜单
    try { CT.layers.closeAll(); } catch (e) { /* 忽略 */ }
    G.markAlive(window, false);
    G.setTeardown(window, null);
  }

  /* ================================================================
   * 指令通道（popup / 右键菜单 / 快捷键）
   * ================================================================ */

  function handleCommand(cmd) {
    return (async function () {
      switch (cmd.action) {
        case 'ping':
          return {
            ok: true,
            stats: R.getStats(),
            sourceLang: state.sourceLang,
            enabled: state.enabled,
            /** 本页是否被临时覆盖过（页内开关点过） */
            pageOverride: state.pageOverride,
            /** 控件是否在页面上 */
            toggle: !!state.toggle,
            ttft: state.ttft,
            /* ---- v1.7 ---- */
            /** 是否顶层 frame（非顶层不挂控件，弹窗据此决定怎么显示） */
            isTop: FG ? FG.isTop() : true,
            /** frame 自评结论，便于排查「为什么这个 frame 没翻」 */
            frameGate: state.frameGate ? state.frameGate.reason : 'unknown',
            selectionReady: !!state.selectionReady
          };

        case 'setDisplayMode': {
          /*
           * 这条指令由右键菜单的「显示方式」与 Alt+Shift+Y 触发。
           * 设置本身在后台已经落盘，storage.onChanged 最终也会让本页生效；
           * 这里显式再走一次，是为了立刻拿到返回结果、不依赖事件时序 ——
           * 否则用户点完菜单会有一小段「没反应」的空窗。
           */
          var s3 = state.settings || await getSettings();
          var next3 = CT.settings.merge(s3, { displayMode: cmd.value || s3.displayMode });
          await applySettings(next3, 'settings');
          return { ok: true, displayMode: next3.displayMode };
        }

        case 'translateNow': {
          var s = await getSettings();
          // 「立即翻译本页」是明确的 per-page 意图：即便全局总开关是关的，
          // 用户点了这一下就是要这一页有译文。写成本页覆盖，不动全局设置。
          state.pageOverride = true;
          state.holdOriginal = false;   // C-54：translateNow 是明确的翻译意图
          rememberSite(true);
          await applySettings(s, 'manual');
          return { ok: state.enabled, stats: R.getStats() };
        }

        case 'restore':
          state.pageOverride = false;
          state.holdOriginal = true;   // C-54：右键菜单/快捷键的「显示原文」同享保持
          rememberSite(false);
          stopObserver();
          hideTip();
          hideBadge();
          R.restoreAll();
          state.enabled = false;
          syncToggle();
          return { ok: true };

        case 'toggle': {
          // 语义修正：这条指令由快捷键（Alt+Shift+T「开启 / 关闭当前页面翻译」）
          // 与页内开关共用，作用于【当前页面】。
          // 旧实现改的是全局 settings.enabled —— 在某页按一下快捷键，
          // 所有标签页的翻译一起停，与快捷键自己的说明直接矛盾。
          // 全局开关仍然只由弹窗与设置页改动。
          var cur = state.settings || await getSettings();
          state.pageOverride = !state.enabled;
          state.holdOriginal = !state.pageOverride;   // C-54：关=保持原文，开=解除
          state.toggleConfirm = null;
          rememberSite(state.pageOverride);
          await applySettings(cur, state.pageOverride ? 'toggle-on' : 'page-off');
          return { ok: true, enabled: state.enabled };
        }

        case 'selectionTranslate': {
          /*
           * 右键菜单「翻译选中的文字」。
           * 刻意让内容脚本用**它自己的选区**走划词链路，而不是把 info.selectionText
           * 从后台传过来 —— 两条路都要过同一套掩码保护、术语表与缓存，
           * 走选区那条更不容易漂移（也顺带复用了「先量后放」的气泡定位）。
           */
          translateSelectionNow();
          return { ok: true };
        }

        case 'applySettings': {
          var s2 = await getSettings();
          await applySettings(s2, 'settings');
          return { ok: true, stats: R.getStats() };
        }

        default:
          return { ok: false, error: '未知指令：' + cmd.action };
      }
    })();
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== CT.MSG.CMD) return false;
    handleCommand(msg.cmd || {})
      .then(function (r) { sendResponse(r); })
      .catch(function (e) { sendResponse({ ok: false, error: e && e.message ? e.message : String(e) }); });
    return true;
  });

  // 设置变更（来自设置页或弹窗）→ 实时生效，无需刷新页面
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (!changes.settings) return;
    if (area !== 'sync' && area !== 'local') return;
    var next = CT.settings.merge(CT.DEFAULT_SETTINGS, changes.settings.newValue || {});
    applySettings(next, 'settings').catch(function (e) {
      console.warn('[叠译] 应用新设置失败：', e);
    });
  });

  /* ================================================================
   * 入口
   * ================================================================ */

  initHover();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { boot(); }, { once: true });
  } else {
    boot();
  }
})();
