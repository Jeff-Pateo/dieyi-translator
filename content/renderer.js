/*
 * 叠译 · DOM 渲染引擎
 * ------------------------------------------------------------------
 * 本模块解决三个问题：
 *
 *   1) 「翻译单元」如何界定
 *      —— 页面不是按 DOM 节点翻译的，是按「语义段落」翻译的。
 *         这里把「不含任何块级子元素的块级元素」定义为翻译单元（leaf block），
 *         例如 <p>、<li>、<h1>、<td>、以及只含内联内容的 <div>。
 *         这样 <p>Hello <a>world</a></p> 是【一条】译文，而不是两条。
 *
 *   2) 译文插到哪里
 *      —— 按宿主的 computed display 分流（见「插入点决策」一节）：
 *         · 内联级宿主        → 追加内联译文，不打断行盒
 *         · 横向弹性容器      → 改插到容器之后（追加进去会被平分宽度）
 *         · 其余（含 td/li）  → 追加到单元内部末尾
 *         三条分支的共同目标：不做任何「让页面上其他元素的宽度或横向位置
 *         发生变化」的事。设置项 insertMode 可强制走某一条，用于对照排障。
 *
 *   3) 如何幂等与可还原
 *      —— 用 registry（Map<Element, Record>）记录每个单元的原文指纹与译文节点，
 *         内容未变的单元永不重复翻译；restore 时按记录精确还原。
 */
(function (root) {
  'use strict';

  var CT = (root.CT = root.CT || {});
  var D = CT.detector;

  /* 单元注册表：Element -> { mode, text, srcHash, node?, origHTML? } */
  var registry = new Map();

  var stats = {
    translated: 0, failed: 0, skipped: 0, units: 0,
    /* rescuedFromClip 「从裁切容器里救回来的译文条数」
     * ----------------------------------------------------------------
     * ★ P-1（2026-09-29）口径变更 ★
     * 旧口径：第一级按**声明**判它是裁切容器并外挪，计数点在第一级的
     *   placement（`plan.reason === 'clipped'`）—— 即「我以为它被裁了」。
     * 新口径：**量测确认不可见 + 真的搬成功了**才计数，计数点在第二级的
     *   搬迁成功处（relocate）。改了是因为免检通道清零后，第一级不再
     *   单独产出搬迁决策，「我判它是裁切容器」不再等于「译文被救回来了」。
     * 因此本数从「声明口径」变成「结果口径」：它是**活体检测**（为 0 说明
     * 页面上没有真的被裁的译文，或者救援链路没跑），见 tools/bench-layout.html。
     */
    rescuedFromClip: 0, replaceDegraded: 0,
    // ---- v1.7.1 遮挡治理 ----
    // riskSuspect   第一级静态圈选命中的单元数（「值得怀疑」，不代表真有问题）
    // relocated     第二级几何判决后真正搬走的单元数
    // relocated*    按失败原因细分，用于归因
    // clipUnresolved 搬走后仍判失败的单元数 —— 如实上报，不静默
    riskSuspect: 0, relocated: 0, clipUnresolved: 0,
    relocatedInvisible: 0, relocatedClipped: 0,
    relocatedEllipsized: 0, relocatedSpills: 0
  };

  /*
   * 「仅显示译文」模式下必须保结构保留的行内元素。
   * ------------------------------------------------------------------
   * 为什么需要这份名单：译文是**一段纯文本**，引擎不会返回标记，
   * 因此译文与原文的行内节点之间没有可靠的对应关系。强行按长度比例切分，
   * 会切出「请现 在阅读 文档」这种断句错误 —— 比丢链接更糟。
   *
   * 所以含这些元素的段落【不做替换】，改为在原文之后挂译文（见 renderUnit）。
   * 链接因此 100% 保留，代价是这类段落呈现为双语。
   * 这是有意的取舍：丢链接是静默的数据损失，降级为双语是可见的行为变化。
   */
  var INLINE_KEEP = 'a,button,input,select,textarea,label,code,kbd,samp,var,abbr,time,[role="link"],[role="button"]';

  /* ================================================================
   * 译文字号：为什么不能直接写「95%」
   * ================================================================
   * 百分比字号是相对【父元素】解析的。译文块一旦落到 <h1> 里面，
   * 它的父元素就是那个 32px 的 <h1>，于是 95% 变成「比标题小 5%」——
   * 一段 30px 的中文译文压在标题下方，整页视觉重量直接翻倍。
   * 更糟的是 <p> 里的 95% ≈ 15px，和原文几乎等大，读者分不出主次。
   *
   * 所以字号改由两个 CSS 变量 + 一条 min() 收口：
   *   --ct-scale  相对原文单元的比例（正文段落得到「小一号」的读数）
   *   --ct-cap    页面正文基准字号（标题下的译文不再跟着放大）
   * 最终 font-size = min(--ct-scale, --ct-cap)。
   * 变量写在译文块自己的 style 上，不碰页面的任何一个元素。
   */

  var FONT_CAP_FALLBACK = 16;   // 拿不到页面基准字号时的兜底值
  var FONT_CAP_MIN = 11;        // 页面基准字号过低时抬到这个值，避免小到不可读
  var FONT_CAP_MAX = 18;        // 页面基准字号过高时压住，避免译文抢戏
  var SCALE_FALLBACK = 0.85;
  var SCALE_MIN = 0.5;
  var SCALE_MAX = 1.5;

  var baseFontPx = 0;           // 整页只读一次，不随单元数增长

  /**
   * 页面正文基准字号（px）。
   * ------------------------------------------------------------------
   * 用 body 的 computed font-size 而不是根元素：根元素常被 reset 成
   * `html { font-size: 62.5% }` 这类值，用 getComputedStyle 取回的是
   * 解析后的 px（10px），会离正文实际字号很远；而 rem 也会跟着这个 62.5% 走，
   * 所以也不能用 rem 做上限。
   * 读一次、缓存一次 —— 这是本模块唯一一处 getComputedStyle 调用。
   */
  function pageBaseFontPx() {
    if (baseFontPx > 0) return baseFontPx;
    var v = FONT_CAP_FALLBACK;
    try {
      var body = document.body || document.documentElement;
      var cs = root.getComputedStyle ? root.getComputedStyle(body, null) : null;
      var n = parseFloat(cs && cs.fontSize);
      if (isFinite(n) && n > 0) v = n;
    } catch (e) { /* 拿不到就用兜底值，不影响功能 */ }

    if (v < FONT_CAP_MIN) v = FONT_CAP_MIN;
    if (v > FONT_CAP_MAX) v = FONT_CAP_MAX;
    baseFontPx = v;
    return v;
  }

  /** 把字号变量写到译文块上（幂等，可重复调用） */
  function applyFontVars(node, settings) {
    var scale = Number(settings && settings.fontSizeScale);
    if (!isFinite(scale) || scale <= 0) scale = SCALE_FALLBACK;
    if (scale < SCALE_MIN) scale = SCALE_MIN;
    if (scale > SCALE_MAX) scale = SCALE_MAX;

    /*
     * 一次属性写入，而不是两次 style.setProperty。
     * 实测（tools/bench.sh，2250 个节点）：两次 setProperty 共 2.6ms，
     * 而整页渲染的总差值只有 1.3ms —— 变量写入是这里唯一的可观成本，
     * 每次 setProperty 都要单独解析一遍自定义属性并标记行内样式失效，
     * 合成一条声明串只走一次这条路径。
     * 前提：译文块的行内样式【只由本函数写入】，不接受其他来源的 style，
     * 否则这句会把它们抹掉。
     */
    node.setAttribute('style',
      '--ct-scale:' + Math.round(scale * 100) + '%;--ct-cap:' + pageBaseFontPx() + 'px');
  }

  /**
   * 设置里改了字号比例时就地刷新已渲染的译文。
   * 字号是变量、变量写在译文块上，所以不必整页重译 —— 走一遍注册表即可。
   * @returns {number} 刷新条数
   */
  function refreshFontScale(settings) {
    var n = 0;
    registry.forEach(function (rec) {
      if (rec.mode === 'below' && rec.node) {
        applyFontVars(rec.node, settings);
        n++;
      }
    });
    return n;
  }

  /* ================================================================
   * 文本工具
   * ================================================================ */

  /** 折叠空白：把换行、连续空格压成单空格，与翻译服务对齐 */
  function normalizeText(s) {
    if (!s) return '';
    return String(s).replace(/\s+/g, ' ').trim();
  }

  /**
   * 取元素「可见文本」。
   * ------------------------------------------------------------------
   * 【为什么不再用 innerText】
   * innerText 的正确性依赖「布局是最新的」，浏览器在返回它之前必须先
   * 校验（必要时重算）样式与布局。注入脚本里最忌讳的就是在页面主线程上
   * 引入这种布局依赖：一旦与自己的 DOM 写入交织，就会退化成强制同步布局
   * （forced synchronous layout），代价随页面规模非线性放大。
   *
   * 本机 Chrome 实测（tools/bench.sh，2500 块页面）：
   *   遍历 900 个 <p> 取 innerText  ≈ 1.7ms
   *   同样遍历取 textContent        ≈ 0.3ms
   * 差值全部来自布局校验，而且这是「布局本来就干净」的最好情况。
   *
   * 【代价与补偿】
   * 改用遍历后，无法感知「由外部样式表造成的 display:none」。
   * 遍历因而显式跳过：[hidden]、内联 display:none、[translate=no]、
   * .notranslate、内容可编辑区、代码/表单等 SKIP_TAGS，
   * 以及本扩展自己插入的译文块 —— 覆盖了实际会遇到的绝大多数情形。
   *
   * 另外：译文块被排除这一条是正确性的前提。若把译文块计入原文，
   * 元素文本会随译文变化 → 内容指纹永远对不上 → 每轮 MutationObserver
   * 都判定为「新内容」并重译，形成 DOM 写入与观察之间的死循环。
   */
  function extractText(el) {
    /*
     * 快路径 0：译文已按默认方式追加在本单元内部末尾。
     * ------------------------------------------------------------------
     * 译文块自身带 translate="no"，所以下面两条快路径都会因为它而退化成
     * TreeWalker；而「已译完的页面被重扫」这条路径每轮要走成千上万次，
     * 正好是最该快的地方。
     * 既然译文就在末尾，直接从 textContent 末尾扣掉即可 —— textContent 是
     * 纯读、不碰布局，字符串切片也远比重建 TreeWalker 便宜。
     * 只有结构被页面改动过（译文节点已不在末尾）时才退回通用逻辑。
     */
    var rec = registry.get(el);
    if (rec && rec.mode === 'below' && rec.node && rec.node.parentNode === el) {
      var full = el.textContent || '';
      var own = rec.node.textContent || '';
      if (own && full.length > own.length && full.slice(full.length - own.length) === own) {
        return full.slice(0, full.length - own.length);
      }
    }

    var kids = el.children;
    // 快路径 1：没有任何元素子节点时，textContent 即等于可见文本
    //（不存在隐藏子树，也不可能有我们自己插入的译文块）
    if (!kids.length) return el.textContent || '';

    // 快路径 2：子节点全是「简单内联」时（无嵌套元素、自身也不在跳过名单里），
    // textContent 与遍历结果一致，但省掉一次 TreeWalker 构造。
    // 这是最常见的形态：<p>正文 <a>链接</a> 正文</p>
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].children.length) return walkText(el);
      if (D.shouldSkipElement(kids[i], null)) return walkText(el);
    }
    return el.textContent || '';
  }

  /**
   * 「像句子」判定（joinChildTexts 的句读守卫）。
   * 只拒绝【以句末标点结尾】或含强句读（！？。；省略号）的段 ——
   * **内部句点要放过**：React.js / Node.js / Next.js 这类技术名带句点，
   * remoteok 标签行实測就卡在这里（19 枚标签整行回退）。
   * 「React. JS」这类内部 '. ' 不构成句末证据 —— 段长 ≤60 的标签串里，
   * 真句子比技术名罕见得多，这里宁可放行。
   */
  function looksLikeSentence(s) {
    return /[.!?。！？；;…]$/.test(s);
  }

  /**
   * 标签串接形态检测与边界重建（v1.7.2，F6/F9 的修法）。
   * ------------------------------------------------------------------
   * 【现场依据】remoteok 的标签行是 <td class="tags"> 里十几枚
   * <a><div class="tag"><h3>Executive</h3></div></a>。collectUnits 把整个
   * td 收成一个单元（子元素全是内联，无块级孩子），extractText 走
   * textContent 拼接 → 送翻的是
   *   "Executive Sys Admin Edu Supervisor Customer Support …"
   * 这样一串没有边界的文本。引擎对串接文本的译文边界感极差，
   * 输出就成了截图里的「执行设计系统管理员Docker技术客户支持开发人员…」。
   *
   * 【修法】识别「标签串接形态」并把子元素文本用 ' / ' 重建边界：
   *   "Executive / Sys Admin / …" → 引擎输出 "高管 / 系统管理员 / …"
   * 术语掩码不受影响（整词匹配照常命中）。分隔符选 ' / ' 而非 '、'：
   * 任何语言的引擎都不会把斜杠吞掉，也不与正文里的标点混淆。
   *
   * 【形态判据 —— 宁窄勿宽，四条全过才算串接】
   *   ① 子元素 ≥ 2 个，且跳过我们自己的译文节点后仍 ≥ 2；
   *   ② 每段非空、≤ 60 字符、不含句读（有句读说明是句子，不是标签）；
   *   ③ 总长 ≤ 300；
   *   ④ 段落用空格重新拼接后与单元整体文本一致 —— 保证中间没有
   *      混入别的内容（如 <p>正文 <b>强调</b></p> 会被第④条拦下，
   *      因为它的元素子节点只有 <b>，拼不出完整文本）。
   * 不满足则返回 null，调用方沿用原文本 —— 检测失败永远安全。
   */
  function joinChildTexts(el, knownText) {
    var kids = el.children;
    if (!kids || kids.length < 2) return null;
    var parts = [];
    var total = 0;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (D.shouldSkipElement(k, null)) continue;   // 自己的译文节点等
      if (k.children && k.children.length) {
        // 含元素子节点的孩子先展开一层（remoteok 的 <a> 包着 <h3>），
        // 展开仍是递归同判定：只接受「干净的两层结构」
        var sub = k.children;
        for (var s = 0; s < sub.length; s++) {
          if (D.shouldSkipElement(sub[s], null)) continue;
          var st = normalizeText(sub[s].textContent);
          if (!st || st.length > 60 || looksLikeSentence(st)) return null;
          parts.push(st); total += st.length;
        }
        var own = normalizeText(k.textContent);
        if (normalizeText(parts.slice(-sub.length).join(' ')) !== own) return null;
      } else {
        var t = normalizeText(k.textContent);
        if (!t || t.length > 60 || looksLikeSentence(t)) return null;
        parts.push(t); total += t.length;
      }
      if (parts.length > 30 || total > 300) return null;
    }
    if (parts.length < 2) return null;
    // 终判：拼回的片段必须与整体文本一致。调用方（maybePush）在调这里
    // 之前刚用 extractText(el) 算过同一个文本 —— 传进来复用，别再走一遍树
    //（v1.7.3 C-11 H3：采集是最热路径，这段重复抽取是纯浪费）。
    // 缺省 knownText 时行为与 v1.7.2 完全一致。
    var whole = (knownText != null) ? normalizeText(knownText) : normalizeText(extractText(el));
    if (normalizeText(parts.join(' ')) !== whole) return null;
    return parts.join(' / ');
  }

  /* 过滤器对象提到模块级：acceptNode 不捕获任何局部变量，无需每次重建 */  var WALK_FILTER = {
    acceptNode: function (node) {
      if (node.nodeType === 1) {
        return D.shouldSkipElement(node, null) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  };

  /** 逐文本节点拼接，跳过应当排除的子树（FILTER_REJECT 会连同后代一起排除） */
  function walkText(el) {
    var buf = [];
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, WALK_FILTER);
    var node;
    while ((node = walker.nextNode())) buf.push(node.nodeValue);
    return buf.join(' ');
  }

  /** 把一个字符串转成可安全放进 CSS 自定义属性的 quoted string */
  function toCssString(s) {
    return '"' + String(s)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\A ')
      .replace(/\r/g, '') + '"';
  }

  /**
   * 清理被掏空的属性。
   * classList.remove() 与 style.removeProperty() 都会把属性保留成空串，
   * 序列化后就是 class="" style="" —— 页面上看不出差别，但会让
   * 「还原后与原始 DOM 完全一致」这个承诺失真，也容易踩到站点的
   * [class] / [style] 属性选择器。因此只在确认为空时才摘掉属性。
   */
  function tidyEmptyAttrs(el) {
    if (el.getAttribute('class') === '') el.removeAttribute('class');
    if (el.getAttribute('style') === '') el.removeAttribute('style');
  }

  /* ================================================================
   * 一、翻译单元采集
   * ================================================================ */

  /**
   * 从 root 开始采集待翻译单元
   * @param {Node} root
   * @param {Object} settings
   * @returns {Array<{el: Element, text: string, hash: string}>}
   */
  function collectUnits(root, settings) {
    var out = [];
    if (!root) return out;

    var max = settings.maxUnitsPerPage || 4000;
    var rawSel = settings.skipSelectors;
    var extraSelectors = (rawSel && rawSel.length) ? rawSel : null;
    var minLen = settings.minTextLength || 2;
    var target = settings.targetLang || 'zh-CN';

    // MutationObserver 可能传来文本节点，归一到其父元素
    if (root.nodeType === 3) root = root.parentElement;
    if (!root || root.nodeType !== 1) return out;

    /*
     * 跳过判定的缓存。
     * 元素会以两种身份被检查：作为父节点的子节点、以及自己出队时。
     * 而 shouldSkipElement 内部要读若干属性、并在配置了 skipSelectors 时
     * 做选择器匹配 —— 同一个元素在一轮采集里判定两遍是纯浪费。
     * 缓存的生命周期就是本次采集（局部变量），不跨轮次，因此不会读到过期结论。
     */
    var skipCache = new Map();

    function skipped(el) {
      var hit = skipCache.get(el);
      if (hit !== undefined) return hit;
      var v = D.shouldSkipElement(el, extraSelectors);
      skipCache.set(el, v);
      return v;
    }

    // 如果 root 自身就带跳过标记，整棵子树放弃
    if (skipped(root)) return out;

    /*
     * C-45（v1.7.7）：不可见子树整棵跳过。
     * ------------------------------------------------------------------
     * 缺陷现场（remoteok.com）：每个职位行的完整描述**始终在 DOM 里**，
     * 折叠只是外层 TR 的 class 切换（`tr.expand` → `display:none`）。
     * 旧采集只跳过 [hidden] 与**内联** display:none —— class 驱动的隐藏
     * 子树全部进队列。remoteok 一个首页折叠区就有 1360 段不可见正文，
     * 全部排队翻译 ⇒ 队列被看不见的内容灌满，90 秒都到不了终态；
     * 用户展开折叠区时看到的是「还没轮到」的纯英文 —— **为不可见内容
     * 排队，把看得见的内容饿死了**（资源倒挂）。
     *
     * 判据用 getClientRects().length === 0（无盒即不可见），比读
     * computed display 便宜；display:contents 的容器自身无盒但子元素
     * 可见，特判放行。配合 content.js 侧 observer 补听 attributes
     * （class/style/hidden）—— 展开折叠区时该子树由重扫负责补翻。
     *
     * ⚠️ 引擎探测（jsdom 兼容，L-17 纪律）：jsdom 没有布局引擎，
     * getClientRects() 恒返回空数组 —— 判据会把「所有节点」误判成
     * 无盒、采集 0 条（selftest 全线崩）。用 documentElement 恒有盒子
     * 这一事实探测引擎：无引擎环境整个判据失效、放行所有节点
     * （退回 C-45 之前行为，呈现层由探针在真实浏览器覆盖）。
     * 结果按文档缓存一次（首次调用时页面布局已可强制计算）。
     */
    var _layoutChecked = false;
    var _engineHasLayout = true;
    function engineHasLayout() {
      if (!_layoutChecked) {
        _layoutChecked = true;
        try {
          _engineHasLayout = document.documentElement.getClientRects().length !== 0;
        } catch (e) { _engineHasLayout = false; }
      }
      return _engineHasLayout;
    }
    function renderedOut(el) {
      if (!engineHasLayout()) return false;
      if (el.getClientRects().length !== 0) return false;
      try {
        return getComputedStyle(el).display !== 'contents';
      } catch (e) { return true; }
    }

    // 广度优先遍历。用游标而不是 shift()，避免大页面上的 O(n²) 开销
    var queue = [root];
    var cursor = 0;
    var candidates = [];
    while (cursor < queue.length && out.length < max) {
      var el = queue[cursor++];

      // 出队后必须重新判定一次：父节点入队时合法，不代表自己合法
      // （例如 <pre><code> 里的 code、translate="no" 容器，都是在这里被拦下的）
      if (skipped(el)) continue;
      // C-45：无盒子树不下钻、不采集（展开时由 attributes 重扫补翻）
      if (renderedOut(el)) continue;

      var children = el.children;
      var hasBlockChild = false;
      var n = 0;
      candidates.length = 0;

      // 单次遍历同时完成「是否存在块级子元素」与「哪些子节点需要下钻」
      for (var i = 0; i < children.length; i++) {
        var c = children[i];
        // 我们自己插入的译文块不算「块级子元素」，否则会阻断单元识别
        if (skipped(c)) continue;
        if (D.isInlineElement(c)) {
          // 纯内联且没有元素子节点的节点不可能含块级后代，无需入队。
          // 旧实现把它们全部入队，再在出队时用 isInlineElement 丢弃。
          if (c.children.length) candidates[n++] = c;
        } else {
          hasBlockChild = true;
          candidates[n++] = c;
        }
      }

      if (hasBlockChild) {
        for (var k = 0; k < n; k++) queue.push(candidates[k]);
        continue;
      }

      // 叶子块 —— 候选翻译单元
      if (D.isInlineElement(el)) continue;    // 内联元素不能独立成单元
      var pushed = maybePush(el, out, target, minLen, settings);
      if (!pushed) stats.skipped++;
      // 收集满上限就停
      if (out.length >= max) break;
    }

    return out;
  }

  function maybePush(el, out, target, minLen, settings) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'BODY' || el.tagName === 'HTML') return false;

    var prev = registry.get(el);

    // 「仅显示译文」模式下，元素内容已经被替换成上一轮写入的译文，
    // 此时比对原文指纹毫无意义。改用「我们写进去的内容是否原样还在」判定，
    // 既不误判，又能在页面真的把内容改回去时正确重新翻译。
    //
    // 这一步刻意放在取文本之前：textContent 是纯读、不碰布局，
    // 而文本抽取要为含子节点的元素走一遍树；已经译好的单元占多数时，
    // 把幂等判定前置可以省掉绝大多数抽取开销。
    if (prev && prev.mode === 'replace' && prev.text) {
      if (normalizeText(el.textContent) === normalizeText(prev.text)) return false;
    }

    var text = normalizeText(extractText(el));
    // 标签串接形态 → 用 ' / ' 重建边界（v1.7.2，F6/F9）。
    // 检测失败返回 null，沿用原文本 —— 永远安全。
    // 把刚提取的 text 传进去复用，joinChildTexts 的终判不再重复走树（C-11 H3）。
    var joined = joinChildTexts(el, text);
    if (joined) text = joined;
    if (!text) return false;

    var verdict = D.isTranslatableText(text, target, minLen);
    if (!verdict.ok) return false;

    var hash = CT.settings.hash(text);

    // 已翻译且原文未变 → 幂等跳过
    if (prev && prev.mode !== 'replace' && prev.srcHash === hash) return false;

    // 插入点决策在这里算完并随单元一起交给渲染阶段。
    // 采集阶段是纯读，不会让自己的写入使样式失效，因此这一批
    // getComputedStyle 最多触发一次样式重算；若挪到渲染阶段边写边读，
    // 就退化成强制同步布局，代价随单元数线性放大。
    var plan = placementFor(el, settings);

    // 被裁切到「零高度」的折叠区不翻。
    // 这类区域是手风琴/「展开全文」的收起态，内容确实存在但用户看不见。
    // 翻了也不显示，还白白占一次接口额度与缓存条目；
    // 等用户真把它展开，MutationObserver 会看到变化并重新采到它。
    if (plan.collapsed) return false;

    out.push({
      el: el,
      text: text,
      hash: hash,
      plan: plan,
      // 位置线索：只有短文本才带。
      // 长段落自身就带足了语境，而 "Home" / "Back" / "Read more" 这类
      // 两三个词的短标签才是「翻译不正确」的重灾区 —— 脱离语境根本没法定夺。
      ctx: text.length <= 60 ? contextFor(el) : ''
    });
    return true;
  }

  /* ================================================================
   * 位置线索（给短标签用的上下文）
   * ----------------------------------------------------------------
   * 取「最近的、直接带标题子元素的祖先」里的第一个 h1~h3 文本。
   * 只扫直接子元素、并按祖先缓存 —— 长页面上成千上万个单元通常只归属
   * 十几个区块，缓存命中率极高，且全程不读布局（只看 children 数组）。
   * ================================================================ */

  var ctxCache = new WeakMap();
  var HEADING_TAGS = { H1: 1, H2: 1, H3: 1 };

  function firstHeading(container) {
    var kids = container.children;
    for (var i = 0; i < kids.length; i++) {
      if (!HEADING_TAGS[kids[i].tagName]) continue;
      var t = (kids[i].textContent || '').trim().replace(/\s+/g, ' ');
      if (!t) continue;
      return t.length > 80 ? t.slice(0, 80) : t;
    }
    return '';
  }

  /**
   * 位置线索（v1.7.4，C-12 Q1a：区块标题 → 标题链 + 页题）。
   * ------------------------------------------------------------------
   * 旧实现只取「最近一个带标题的祖先」的第一个 h1~h3。但短标签的取义
   * 常常需要更外层的语境：导航里的 "Home" 需要页面标题，
   * 面包屑下的 "Overview" 需要两层区块标题才能定位到正确章节。
   *
   * 新链路：页面标题 › 外层区块标题 › 内层区块标题（最多两级），
   * 全链截断 60 字符（与短文本的 ctx 阈值一致）。逐层缓存保留 ——
   * 长页面上成千上万个单元通常只归属十几个区块，缓存命中率极高，
   * 且全程只看 children 数组、不读布局。
   */
  function contextFor(el) {
    var parts = [];
    var cur = el.parentElement;
    var hops = 0;
    while (cur && hops < 6 && parts.length < 2) {
      hops++;
      if (cur === document.body || cur === document.documentElement) break;
      var cached = ctxCache.get(cur);
      if (cached === undefined) {
        cached = firstHeading(cur);
        ctxCache.set(cur, cached);     // '' 也是有效缓存：避免下次重查同一层
      }
      if (cached) parts.push(cached);
      cur = cur.parentElement;
    }
    var title = (document.title || '').replace(/\s+/g, ' ').trim();
    if (title) parts.unshift(title.length > 30 ? title.slice(0, 30) : title);
    var s = parts.join(' › ');
    return s.length > 60 ? s.slice(0, 60) : s;
  }

  function clearContextCache() { ctxCache = new WeakMap(); }

  /* ================================================================
   * 二、译文渲染
   * ================================================================ */

  /**
   * 渲染一条译文
   * @param {Element} el 目标单元
   * @param {string} translation 中文译文
   * @param {Object} settings
   * @param {string} srcHash 原文指纹（用于幂等判断）
   * @param {{kind: string, anchor?: Element}} [plan] 采集阶段算好的插入点决策。
   *        传进来是为了让「读 computed style」全部集中在纯读的采集阶段；
   *        不传也能工作（此时在这里现算）。
   * @param {string} [srcText] 原文文本（v1.7.4 C-13 Q3：纠错闭环需要知道
   *        「这句译文对应哪句原文」，存进注册表供页内「改」入口读取。
   *        可选参数，旧调用方与基准页不受影响。）
   * @returns {boolean}
   */
  function renderUnit(el, translation, settings, srcHash, plan, srcText) {
    if (!el || !translation) return false;
    var mode = settings.displayMode || 'below';

    /*
     * 译文落在 shadow root 内时，必须把样式注入到那个 root 内部。
     * ------------------------------------------------------------------
     * 页面级 CSS 不穿透 shadow 边界 —— 包括 manifest 里 content_scripts.css
     * 注入的那份。不补这一步，shadow 里的译文会是「有内容、没样式」，
     * 视觉上和原文糊在一起，表现成「翻译好像没生效」。
     * ensureStyle 内部有幂等标记，同一个 root 只会注入一次。
     */
    if (CT.shadow && typeof el.getRootNode === 'function') {
      var rn = el.getRootNode();
      if (rn && rn.host) CT.shadow.ensureStyle(rn);
    }

    // 先清掉旧译文，避免模式切换后残留
    /* ★ C-74（重译双计修正）：在清旧译文**之前**记下「这个元素此前是否已有登记记录」。
     * clearUnit(el,false) 只摘节点、不删记录（`:1816` 仅 dropRecord 才 delete）⇒ 重渲染同一元素时
     * 记录仍在，但那不是「新译了一段」而是「同一段换了个节点」⇒ translated 不得再 +1。
     * 只在**首次**渲染时计入，使 translated 与「屏上译文条数」同口径（与 popup 展示口径一致）。 */
    var hadPrev = registry.has(el);
    clearUnit(el, false);

    if (mode === 'replace') {
      /*
       * 「仅显示译文」分两条路走 —— 这是 v1.7 的修正。
       *
       * 旧实现一律 `el.textContent = translation`。于是
       * 「Read <a>the docs</a> now」里那个链接被无声吃掉：
       * 用户读到了译文，但再也点不进那份文档。
       * 留一个看不见的损失，比明着降级更糟。
       *
       * 新行为：
       *   纯文本元素         → 整体替换（最干净，且 origHTML 可一键还原）
       *   含链接/代码等元素  → 不替换，改为在原文之后挂译文。
       *                       链接 100% 保留，代价是这类段落呈现为双语。
       */
      if (hasProtectedInline(el)) {
        var style0 = (settings.transStyle === 'accent') ? 'accent' : 'plain';
        var keepNode = document.createElement('div');
        keepNode.className = CT.TRANS_CLASS + ' ct-trans--out ct-s-' + style0 + ' ct-trans--keep';
        keepNode.textContent = translation;
        insertAfter(el, keepNode);
        registry.set(el, {
          mode: 'below-keep',
          node: keepNode,
          text: translation,
          srcHash: srcHash || '',
          src: srcText || ''
        });
        if (!hadPrev) stats.translated++;
        stats.replaceDegraded = (stats.replaceDegraded || 0) + 1;
        return true;
      }

      // 纯文本元素：整体替换。
      // 把原 innerHTML 暂存到注册表，可一键还原为「原文」。
      var rec = {
        mode: 'replace',
        origHTML: el.innerHTML,
        text: translation,
        srcHash: srcHash || '',
        src: srcText || ''
      };
      el.setAttribute('data-ct-src', srcHash || '');
      el.classList.add('ct-replaced');
      el.textContent = translation;
      registry.set(el, rec);
      if (!hadPrev) stats.translated++;
      return true;
    }

    if (mode === 'hover') {
      el.classList.add('ct-hover');
      el.style.setProperty('--ct-tip', toCssString(translation));
      el.setAttribute('data-ct-src', srcHash || '');
      registry.set(el, { mode: 'hover', text: translation, srcHash: srcHash || '', src: srcText || '' });
      if (!hadPrev) stats.translated++;
      return true;
    }

    // 默认模式：原文下方双语
    // 插入点用采集阶段算好的决策；锚点已脱离文档时（页面在翻译途中重建了子树）
    // 就地重算一次，避免把译文插到游离节点上。
    if (!plan || (plan.kind === 'after' && plan.anchor && !plan.anchor.isConnected)) {
      plan = placementFor(el, settings);
    }

    var style = (settings.transStyle === 'accent') ? 'accent' : 'plain';
    var node;

    if (plan.kind === 'inline') {
      // 内联级宿主：追加内联译文。不打断行盒、不新增兄弟节点，
      // 宿主盒子只会因为内容变长而自然变宽 —— 与原文本身更长是同一种变化。
      node = document.createElement('span');
      node.className = CT.TRANS_CLASS + ' ct-trans--inl ct-s-' + style;
    } else if (plan.kind === 'after') {
      node = document.createElement('div');
      node.className = CT.TRANS_CLASS + ' ct-trans--out ct-s-' + style;
    } else {
      node = document.createElement('div');
      node.className = CT.TRANS_CLASS + ' ct-trans--in ct-s-' + style;
      // 宿主是可换行的横向弹性容器：给译文一个整行宽的弹性基准，
      // 它会换到新的一行而不是与原有子项平分宽度
      if (plan.wrap) node.classList.add('ct-trans--wrap');
    }

    node.setAttribute('translate', 'no');
    node.setAttribute('lang', settings.targetLang || 'zh-CN');
    node.setAttribute('dir', 'auto');
    // 标注样式下左上角那个小标记。之前是 CSS 里写死的「译」，
    // 多语言互译下必须跟着目标语言走 —— 目标语言是日语却标着「译」，
    // 用户第一眼分不清这是「中文译文」还是「日语译文」。
    node.setAttribute('data-ct-mark', CT.langMark ? CT.langMark(settings.targetLang) : '译');
    node.textContent = translation;
    applyFontVars(node, settings);

    if (plan.kind === 'after') {
      // 插到锚点之后：横向弹性容器，或「追加进去会被裁掉」的裁切容器
      var anchor = plan.anchor || el;
      if (!insertAfter(anchor, node)) {
        // 锚点已脱离文档（页面在这期间重绘过）→ 退回就地追加，
        // 总比译文整条丢失好；裁切场景下用户至少能在 DOM 里看到它
        el.appendChild(node);
      }
    } else {
      el.appendChild(node);
    }

    el.setAttribute('data-ct-src', srcHash || '');
    var risk = plan.risk || '';
    if (risk) stats.riskSuspect++;
    registry.set(el, {
      mode: 'below',
      node: node,
      text: translation,
      srcHash: srcHash || '',
      src: srcText || '',
      placement: plan.kind,
      // 记录「为什么挪出去了」，供设置页的对照排障与基准统计使用
      reason: plan.reason || '',
      // v1.7.1：第一级圈选结果。带这个标的单元才会进入第二级几何判决 ——
      // 没标的单元永远不会被量测，因此绝大多数页面为「零额外量测开销」
      risk: risk,
      moved: false,
      verdict: ''
    });
    /* ★ P-1（2026-09-29）：rescuedFromClip 的计数点已移到第二级的搬迁成功处
     * （relocate）。这里原本是 `if (plan.reason === 'clipped') rescuedFromClip++`，
     * 那是「声明口径」——第一级判它是裁切容器就 +1。免检通道清零后，
     * 第一级不再单独产出搬迁决策，这个数只有量测完才知道答案。 */
    if (!hadPrev) stats.translated++;
    return true;
  }

  /* ================================================================
   * 插入点决策（按 computed display 分流）
   * ================================================================
   * 【为什么不能只看标签】
   * 上一版按「标签白名单 + 全局内部追加」决策，于是把块级译文塞进了弹性
   * 容器内部 —— 它立刻变成一个新的弹性项。实测在「标签行 / 薪资行」这类
   * `display:flex` 的横向容器上，原有 N 个子项被 N+1 个平分宽度，整行被挤
   * 变形；内联级宿主更直接：块级译文会把行盒打断，pill 被撑成两行。
   *
   * 而 `<div>` 既可能是普通块，也可能是弹性行容器 —— 标签判断不出来，
   * 只有 computed display 能区分。
   *
   * 【怎么读得省】
   *   1) 结果缓存在 WeakMap 里跨轮次复用（同一元素反复采集也只读一次）；
   *   2) 决策全部在【采集阶段】算完并挂在单元对象上。采集阶段是纯读，
   *      不会因为自己的写入让样式失效，因此整轮最多触发一次样式重算；
   *      若挪到渲染阶段边写边读，就是教科书式的强制同步布局。
   */

  /** 内联级显示：宿主不参与块级布局，块级译文会直接打断行盒 */
  var INLINE_LEVEL = {
    'inline': 1, 'inline-block': 1, 'inline-flex': 1, 'inline-grid': 1,
    'inline-table': 1, 'contents': 1, 'ruby': 1
  };

  var layoutCache = new WeakMap();

  /** 标签兜底：拿不到 computed style（非浏览器环境 / 读取异常）时按标签近似 */
  function fallbackLayout(el) {
    var tag = el.tagName;
    var d = 'block';
    if (D.isInlineElement(el)) d = 'inline';
    else if (tag === 'TD' || tag === 'TH') d = 'table-cell';
    else if (tag === 'TR') d = 'table-row';
    else if (tag === 'TABLE') d = 'table';
    else if (tag === 'LI') d = 'list-item';
    // 兜底时一律当作「不裁切」：拿不到 computed style 就宁可照原样插入，
    // 也不能凭猜测把所有译文都挪到外面去。
    return {
      display: d, fd: 'row', fw: 'nowrap', position: 'static',
      ox: 'visible', oy: 'visible', mh: 'none', clamp: 'none',
      // v1.7.1：height / white-space / text-overflow 三项与新判据配套。
      // 兜底值同样取「不裁切、可换行」的保守一侧。
      h: 'auto', ws: 'normal', te: 'clip'
    };
  }

  /**
   * 取元素的布局特征（display / flex-direction / position / 裁切信息），带缓存。
   * 只读、不写；在采集阶段调用时段内不会有样式失效，因此代价是一次性的。
   *
   * 裁切信息（overflow / max-height / -webkit-line-clamp）搭同一次
   * getComputedStyle 顺带取回 —— 多读三个属性不额外触发样式重算，
   * 而这是判断「译文会不会被站点裁掉」的唯一依据。
   */
  function layoutOf(el) {
    if (!el || el.nodeType !== 1) return fallbackLayout(el || document.documentElement);
    var hit = layoutCache.get(el);
    if (hit) return hit;

    var out = null;
    try {
      var cs = root.getComputedStyle ? root.getComputedStyle(el, null) : null;
      if (cs && cs.display) {
        out = {
          display: cs.display,
          fd: cs.flexDirection || 'row',
          fw: cs.flexWrap || 'nowrap',
          position: cs.position || 'static',
          ox: cs.overflowX || '',
          oy: cs.overflowY || '',
          mh: cs.maxHeight || 'none',
          clamp: (cs.getPropertyValue ? cs.getPropertyValue('-webkit-line-clamp') : '') || cs.webkitLineClamp || 'none',
          /* v1.7.1 新增三项，与上面共用同一次 getComputedStyle。
           * 为什么必须补 h（height）：定高裁切（overflow:hidden + height:24px）
           * 是卡片标题、标签行最常见的防溢出写法，它既没有 max-height
           * 也没有 line-clamp —— 旧的裁切判据对这类容器**完全失明**。
           * 而 ws（white-space）与 te（text-overflow）用于识别
           * 「单行 + 省略号」，那是截图里译文被截成 `高级成长产…` 的直接来源。 */
          h: cs.height || 'auto',
          ws: cs.whiteSpace || 'normal',
          te: cs.textOverflow || 'clip'
        };
      }
    } catch (e) { /* 拿不到就走标签兜底 */ }
    if (!out) out = fallbackLayout(el);

    // display:none 的节点不参与布局，且随时可能被显示出来 —— 不缓存它
    if (out.display !== 'none') layoutCache.set(el, out);
    return out;
  }

  /* ================================================================
   * 裁切容器判定
   * ----------------------------------------------------------------
   * 用户反馈的原话：「中文翻译后存在被隐藏内容无法显示更多」。
   *
   * 根因有两层，而且都出在「插入点决策完全不感知 overflow 与裁切」上：
   *
   *   ① 译文自己被裁掉
   *      `-webkit-line-clamp: 3` 之类会把容器里超出 3 行的内容**整段不渲染**。
   *      我们把译文追加到单元内部末尾，它正好落在被截掉的那一段里 ——
   *      用户看到的是「原文末尾带个省略号，译文一个字都没有」。
   *
   *   ② 站点自己的「展开全文 / 显示更多」被搅乱
   *      这类折叠常由 `-webkit-box` + `-webkit-line-clamp` 实现。
   *      `.ct-trans` 是 `display: block`，作为 `-webkit-box` 的子项时，
   *      行数统计会连带把译文块算进去，折叠窗口里原本该出现的原文被顶掉，
   *      而站点判断「是否需要显示展开按钮」的依据（通常是 scrollHeight
   *      与 clientHeight 的比较）也跟着变了 —— 于是既看不全，又找不到按钮。
   *
   * 修法：**让译文根本不进入被裁切的那棵子树** —— 挂到最外层裁切容器之后。
   * 这样译文完整可见，站点那棵子树的 DOM 与几何量一个字节都没变，
   * 它自己的折叠/展开逻辑完全不受影响。
   *
   * 为什么取「最外层」裁切容器：套两层很常见（外层 max-height 折叠整块、
   * 内层 line-clamp 截摘要）。挂在里层，仍然被外层裁掉。
   * ================================================================ */

  /** 是否建立了裁切上下文（overflow 为 hidden / clip）。 */
  function hasClipContext(l) {
    return l.ox === 'hidden' || l.ox === 'clip' || l.oy === 'hidden' || l.oy === 'clip';
  }

  /**
   * 该层是否**声明了**把内容限制在固定范围内的属性（line-clamp / max-height）。
   * ------------------------------------------------------------------
   * ★★ v1.7.1 的第一版写错过这里，务必读完再改 ★★
   *
   * 第一版把「定高」也算进来了：`l.h !== 'auto' && parseFloat(l.h) > 0`。
   * 理由看起来无懈可击 —— 「overflow:hidden + height:24px」是卡片标题 / 标签行 /
   * 单行副标题最常见的防溢出写法，旧判据确实看不见它。
   *
   * 但 `layoutOf` 里的 `l.h` 取自 `getComputedStyle(el).height`，而
   * **Chrome 对已渲染元素返回的是「使用值」而不是声明值**：
   *
   *     <div style="overflow:hidden">      → height: "21px"    ← 没写高度！
   *     <div style="height:22px">          → height: "22px"
   *     <div style="overflow:visible">     → height: "21px"    ← 完全不裁也一样
   *
   * （实测见 tools/_probe-height.html，结论与浏览器版本无关 ——
   *   getComputedStyle 返回 resolved value 是规范行为，不是 Chrome 的怪癖。）
   *
   * 于是那条判据实际等价于「只要它有任何高度」→ 恒为真，
   * `constrainsContent` 退化成 `hasClipContext`。后果分两处：
   *
   *   · `suspectRisk` 过度圈选 —— 只是多量几条，第二级会判决，可以接受；
   *   · `clipInfo` / clipsContent 过度命中 —— **不可接受**：
   *     这条路径是**第一级直接搬走、没有验真**的。圆角卡片写
   *     `border-radius + overflow:hidden` 极其常见，于是译文会被搬到卡片外面，
   *     归属直接错乱 —— 这是相对 v1.7.0 的净退化，等于用新缺陷换旧缺陷。
   *
   * 所以这里退回「只认声明式的硬约束」，让 clipInfo 的行为与 v1.7.0 逐字节一致；
   * 「定高裁切」那一类改由**圈选 + 几何验真**这条新路径处理
   * （见 suspectRisk / judgeOne）：宽度高度这类被浏览器解析成使用值的属性，
   * 不能拿来做静态判据，但**可以**拿来量。
   *
   * auto / scroll 不算：它们会出滚动条，内容没丢。
   */
  function constrainsContent(l) {
    if (!hasClipContext(l)) return false;
    var clamp = l.clamp && l.clamp !== 'none' && l.clamp !== '' && l.clamp !== '0';
    var capH = l.mh && l.mh !== 'none' && parseFloat(l.mh) > 0;
    if (!(clamp || capH)) return false;

    /* ★★ C-27（2026-09-28）：约束与「还能不能滚到」必须**同轴**判断 ★★
     * ------------------------------------------------------------------
     * 上面那段注释写的规则是「auto / scroll 不算：它们会出滚动条，内容没丢」，
     * 但那句话是**按轴**成立的，而这一版判据把两轴混着看了：
     * 只要 `hasClipContext` 为真（任一轴 hidden/clip）**且**有 max-height，
     * 就判成裁切容器 —— 完全不管那个 max-height 所在的**纵轴其实可以滚**。
     *
     * 现场反例（remoteok.com 的地区筛选下拉，用户截图实证）：
     *
     *     .location-filter-results {
     *       overflow: hidden;            → 计算值 overflow-x: hidden
     *       max-height: 500px;
     *       overflow-y: scroll;          → 计算值 overflow-y: scroll（后写覆盖）
     *     }
     *
     * 这是一个「定高 + 纵向可滚」的下拉面板，259 个国家选项滚一滚全能看见，
     * 没有任何内容被裁掉。但旧判据判定它是裁切容器，于是
     * `placementFor` 把这 259 条译文**全部搬到面板之外**（reason: 'clipped'），
     * 成为 .container 里紧跟 banner 的第一批常规流内容 —— 一条 259 行、
     * 每行约 22px 的中文竖排列表把筛选栏和职位表整体顶到页面下方，
     * 用户看到的就是「竖排 + 右侧一大片空白」。
     *
     * 修法：声明式硬约束（line-clamp / max-height）落在**纵向**上时，
     * 只有纵向 overflow 也是 hidden/clip（内容真的够不着）才算裁切；
     * overflow-y 是 auto/scroll（滚得到）就不算。
     * ----------------------------------------------------------------
     * 注意不要顺手把这条写成「只要任一轴可滚就放过」：横向 hidden 且
     * `white-space:nowrap` 的标题行仍然是真的在吃内容，那条路径由
     * `forcesNoWrap` + 第二级几何判决继续兜住。 */
    if (l.oy === 'auto' || l.oy === 'scroll') return false;

    return true;
  }

  /** 旧名保留为别名：clipInfo 仍在用，语义与 v1.7.0 一致 */
  function clipsContent(l) { return constrainsContent(l); }

  /**
   * 该层是否会把内容拉成不换行的长串。
   * ------------------------------------------------------------------
   * `nowrap` 本身不是错 —— 但对我们追加的译文来说，它是致命的：
   * `.ct-trans--inl` 显式写着 `white-space: inherit`（有意为之，
   * 否则会把定高 pill 撑成两行），于是宿主 nowrap 时译文也永不换行，
   * 只能一行排到底 → 溢出 → 被裁切上下文吃成省略号。
   *
   * `pre` 同样不换行，一并纳入。
   */
  function forcesNoWrap(l) {
    return l.ws === 'nowrap' || l.ws === 'pre';
  }

  /** 该层是否被折叠到零高度（手风琴收起态、"展开全文"未展开态） */
  function collapsesContent(l) {
    if (!hasClipContext(l)) return false;
    // 定高为零：手风琴常用 `height:0;overflow:hidden` 收起。
    // 旧版只看 max-height，对这类站点漏判 —— v1.7.1 顺带补上（成本近零）。
    if (l.h && l.h !== 'auto' && parseFloat(l.h) === 0) return true;
    if (!l.mh || l.mh === 'none') return false;
    return parseFloat(l.mh) === 0;
  }

  var CLIP_HOPS = 6;

  /**
   * @returns {{clip: Element|null, collapsed: boolean}}
   *   clip      —— 最外层那个会裁切内容的祖先（没有则 null）
   *   collapsed —— 祖先链上存在「零高度折叠层」→ 整条单元不值得翻
   *
   * 不缓存结果：整条上溯最多 6 步，每步只查一次已缓存的 layoutOf，
   * 而站点随时可能改 class 让裁切消失/出现，缓存反而会读到过期结论。
   */
  function clipInfo(el) {
    var info = { clip: null, collapsed: false };
    var cur = el.parentElement;
    var hops = 0;
    while (cur && hops < CLIP_HOPS) {
      hops++;
      if (cur === document.body || cur === document.documentElement) break;
      var l = layoutOf(cur);
      if (collapsesContent(l)) info.collapsed = true;
      if (clipsContent(l)) info.clip = cur;      // 继续上溯，最终留下最外层那个
      cur = cur.parentElement;
    }
    return info;
  }

  function isRowDirection(fd) {
    return !fd || fd === 'row' || fd === 'row-reverse';
  }

  /** 子元素一旦进入这个容器就会被当作弹性 / 网格项 —— 我们不该追加进去 */
  function isItemContext(l) {
    var d = l.display;
    if (d === 'flex' || d === 'inline-flex') return isRowDirection(l.fd);
    if (d === 'grid' || d === 'inline-grid') return true;
    if (d === 'table-row' || d === 'table-row-group') return true;
    return false;
  }

  /**
   * 向上寻找「不受弹性 / 网格布局约束」的插入锚点。
   * 最多上溯 4 层：再往上找，译文离原文太远会失去归属感，不如就地退化。
   */
  function safeAnchor(el) {
    var cur = el;
    var hops = 0;
    while (cur && hops < 4) {
      hops++;
      var p = cur.parentElement;
      if (!p || p === document.body || p === document.documentElement) break;
      if (!isItemContext(layoutOf(p))) break;
      cur = p;
    }
    return cur || el;
  }

  /**
   * 能不能把一个块级译文插到 anchor 之后？
   * ------------------------------------------------------------------
   * `insertAfter(anchor)` 只要求 anchor 有父节点，但「有父节点」远不等于
   * 「父节点收得下」：往 `<tr>` 里插 div、往 `<select>` 里插 div 都会被
   * 浏览器重新解析成别的东西（生成匿名单元格、节点被丢弃），
   * 症状是译文凭空消失或整张表错位。
   *
   * ★ P-1（2026-09-29）★
   * 这里原有一个「能不能把块级译文插到 anchor 之后」的结构预检函数 —— 它是
   * **第一级**用来给「搬到裁切容器之外」这个不可逆动作做铺垫的
   * （判断锚点插不插得进去）。那个动作整体移交第二级之后，它已无调用点，
   * **已删除**：留着它等于给免检通道留下一段随时能被人接回去的现成代码。
   * 它的结构判据（`NO_BLOCK_CHILD` + 父节点收不收得下块级子元素）由第二级的
   * `canPlaceAfter` 承接 —— `NO_BLOCK_CHILD` 因此**不是死代码**：它是
   * `canPlaceAfter` 的判据表，也是拿不到 computed style 时的标签兜底。
   * （`canPlaceAfter` 另有一层计算 display 的判据 `TABLE_LAYOUT_DISPLAY`，
   * 对付 CSS 模拟表格，见该函数。差别只有一条：`canPlaceAfter`
   * **允许 anchor === el**
   * （搬移场景下锚点常就是单元自身，「放成它的下一个块级兄弟」是最自然的
   * 「下方」形态）。而那个被删掉的预检曾禁止它，是为了防「锚点没套住单元」，
   * 那个顾虑在只向上走的 `escapeAnchor` 里不存在。
   */
  var NO_BLOCK_CHILD = {
    TR: 1, TBODY: 1, THEAD: 1, TFOOT: 1, TABLE: 1, COLGROUP: 1,
    SELECT: 1, OPTGROUP: 1, DATALIST: 1
  };

  /* ================================================================
   * v1.7.1 · 第一级：静态圈选（只打标，绝不改变插入点）
   * ----------------------------------------------------------------
   * 【为什么只打标，不直接搬】
   * 把 M1/M2/M3 三条判据补齐之后，静态判定的假阳性会变得非常高：
   * 头像容器、图标按钮、清浮动的老代码，都写着 `overflow:hidden`；
   * `nowrap` 的宿主在能自由变宽时，追加内联译文只是让它变宽 ——
   * 那是 v1.5 起就明确接受的取舍（见 .ct-trans--inl 的注释）。
   * 若在静态阶段就搬走，会用「拆散药丸行」换掉「标题被截断」。
   *
   * 因此这一级只回答「**值得怀疑吗**」，由第二级（verifyBatch）
   * 用真实几何量测做判决。判决通过的单元一个字节都不动。
   * ================================================================ */

  /**
   * @returns {string|null} 命中原因；null = 不值得怀疑，走原有插入点
   *
   * 圈选用的是 `hasClipContext`（**会裁**）而不是 `constrainsContent`（**声明了硬约束**）。
   * 这一条是刻意的、也是这一级唯一需要的严格性：
   *   · 「定高裁切」判不出来（浏览器把 height 解析成使用值，见 constrainsContent 的注释），
   *     所以只要它 overflow 是 hidden/clip，就当成可疑对象，交给第二级量。
   *   · 代价是圈选会偏多 —— 圆角卡片、清浮动的老代码都写着 overflow:hidden。
   *     这个代价是**可控的**：多出来的那些量完就通过，一个字节都不动。
   *     反过来说，若把判据收窄到这里，A1/A2 那两类就整条漏掉了。
   */
  function suspectRisk(el) {
    var l = layoutOf(el);

    // ①② 单元自身。旧版的 clipInfo 从 parentElement 起步，
    //     因此**单元自己**的裁切与 nowrap 从未被检查过，
    //     而卡片标题恰恰最常把防溢出写在标题元素本身上。
    if (hasClipContext(l)) return 'self-constrained';
    if (forcesNoWrap(l)) return 'self-nowrap';

    // ③④ 祖先链。命中即返回，第一个命中的原因最具解释力
    var cur = el.parentElement;
    var hops = 0;
    while (cur && hops < CLIP_HOPS) {
      hops++;
      if (cur === document.body || cur === document.documentElement) break;
      var pl = layoutOf(cur);
      /* ★ C-27（2026-09-28）：这里**故意**不按轴收窄，别顺手改成 constrainsContent ★
       * 已经有人会问：既然 constrainsContent 学会了「纵轴可滚就不算裁」，
       * 为什么这一级不跟着学？
       *
       * 因为这一级圈的从来不是「声明了硬约束」，而是「任一轴会裁」——
       * 二者不是同一条判据。`overflow-x:hidden; overflow-y:scroll` 的面板
       * （remoteok 的地区下拉）纵向确实滚得到，但**横轴照旧会裁**：
       * 一条 `white-space:nowrap` 的译文落在里面，就是会被吃成省略号。
       * 若按纵轴把它放过，等于把「横轴裁切」整条路径从圈选里删掉。
       *
       * 多圈出来的那些（纵向只是滚出去的行）由第二级几何判决清掉 ——
       * judgeOne 里 `scrollsOutOf` 只放过「越界那一轴可滚」的情形，
       * 横轴真越界照旧判失败（tools/test-clip-guard.mjs 第七节 2）。
       * 一句话：**同轴原则修的是判决，不是圈选。** */
      if (hasClipContext(pl)) { cur = null; return 'ancestor-constrained'; }
      if (forcesNoWrap(pl)) { cur = null; return 'ancestor-nowrap'; }
      cur = cur.parentElement;
    }
    return null;
  }

  /**
   * 搬移目标：先走出「真的把译文裁掉了的那一层」，再走 safeAnchor。
   * ------------------------------------------------------------------
   * 【为什么是几何判定，而不是「最外层 overflow:hidden」】
   * 第一版按声明判：只要祖先 `constrainsContent` 就当作裁切层、取最外层。
   * 修掉 constrainsContent 的定高误判之后，按声明判仍不够 ——
   * 圆角卡片写 `border-radius + overflow:hidden` 极其常见，而这种祖先
   * **并没有裁到我们的译文**（译文是块级、white-space:normal、width:100%，
   * 自然流里根本溢不出去）。若把它一起跳过，译文会被搬到卡片外面，
   * 归属直接错乱 —— 那就是用新缺陷换旧缺陷。
   *
   * 所以这里改成：**只有「译文当前确实越出了这一层」才算它裁了译文**。
   * 传入的 t 是译文当前矩形；不传 t 时退回「按声明取最外层」的旧行为，
   * 供单测直接调用（它要断言的正是「走出最外层约束容器」这条语义）。
   *
   * 为什么仍要取最外层：套两层裁切很常见（外层 max-height 折叠整块、
   * 内层定高截标题）。只挪出里层，外层继续把它裁掉。
   *
   * 为什么还要再走 safeAnchor：挪出去的位置若正好落在弹性行容器里，
   * 译文会变成一个新的弹性项，把原有子项挤变形。
   */
  function escapeAnchor(el, t) {
    var outer = null;
    var cur = el.parentElement;
    var hops = 0;
    while (cur && hops < CLIP_HOPS) {
      hops++;
      if (cur === document.body || cur === document.documentElement) break;
      var pl = layoutOf(cur);
      if (hasClipContext(pl) && (!t || rectOutOf(t, cur.getBoundingClientRect()))) {
        outer = cur;
      }
      cur = cur.parentElement;
    }
    return safeAnchor(outer || el);
  }

  /**
   * 能不能把译文插到 anchor 之后？
   * ------------------------------------------------------------------
   * 区别只有一条：**允许 anchor === el**。
   * 搬移场景下 anchor 常就是单元自身（把译文放成它的下一个块级兄弟），
   * 那是最自然、也是用户最期待的「下方」形态。
   *
   * ★ P-1（2026-09-29）★ 本函数是**第二级**（几何判决之后）的结构预检 ——
   * 它与第一级那个已删除的 `canInsertAfter` 的关系，见上方的说明。
   *
   * ★ C-34（2026-09-29）：只查 tagName 是**不够**的 ★
   * 现代站点大量用 CSS 模拟表格（`<div style="display:table-row">` 套
   * `<div style="display:table-cell">`），DOM 里一个 `<tr>`/`<td>` 都没有。
   * 旧版只看 `parent.tagName`，于是往 `display:table-row` 的 div 里插一个
   * 块级译文时，浏览器把它当成**同一行里的第二个匿名单元格** ——
   * 实测译文落在原文**右侧并排**（原文 x=30 → 译文 x=92，同一个 y），
   * 语义从「下方」反转成「第二列」。与 C-26/C-27「把整行版式搬散」同族。
   *
   * P-1 删掉第一级那个结构预检之后，本函数是 `relocate` 的**唯一**结构
   * 闸门 —— 兜底从两个减到一个，所以它必须自己认得 CSS 表格。
   *
   * 判据：父元素的计算 display **参与表格布局**则拒绝。
   * **`table-cell` 不在拒绝集合内**：块级子元素落在单元格里是纵向堆叠，
   * 形态正确；误拦它会砍掉「译文追加进单元格内」这条合法路径。
   *
   * 判据输入量的变更（登记在《判据输入含义核对表》§2.2）：从「纯 DOM 结构
   * （tagName）」变成「DOM 结构 + 父元素的计算 display」。方向是**只收紧** ——
   * 只会让更多 relocate 变成如实上报的 `unresolved`，不会让任何原本被拒的
   * 插入变成允许。读的是 `layoutOf` 的缓存值（采集阶段已算过），
   * 而 relocate 本来就要量矩形，因此不新增样式重算。
   */
  var TABLE_LAYOUT_DISPLAY = {
    'table': 1, 'inline-table': 1,
    'table-row': 1, 'table-row-group': 1,
    'table-header-group': 1, 'table-footer-group': 1
  };

  function canPlaceAfter(anchor) {
    if (!anchor) return false;
    var parent = anchor.parentNode;
    if (!parent || parent.nodeType !== 1) return false;
    if (NO_BLOCK_CHILD[parent.tagName]) return false;
    return !TABLE_LAYOUT_DISPLAY[layoutOf(parent).display];
  }

  /**
   * 第一级给「位于声明式裁切容器内」贴的标。
   * ------------------------------------------------------------------
   * ★ P-1（2026-09-29）★ 它是**唯一**由静态判据产生、且与「不可逆 DOM 变更」
   * 相关的信号 —— 而它本身**不改变 DOM**，只是让第二级知道「这条要看紧点」。
   *
   * 为什么不让第一级直接搬：见 placementFor 里那段注释（免检通道清零）。
   * 改这个标的名字/语义时，必须同步 tools/test-clip-guard.mjs 的静态门禁节
   * 与 docs/架构约定-静态判据与几何判决衔接.md。
   */
  var CLIP_RISK = 'ancestor-clipped';

  /**
   * 「哪些 risk 标算『因为被裁才被救回来』」的**登记集合**。
   * ------------------------------------------------------------------
   * ★ C-34（2026-09-29）★ 这里原本写的是 `rec.risk === CLIP_RISK`（相等判断）。
   * 相等判断本身没写错 —— 它引用的是常量，所以改 `CLIP_RISK` 的**值**两处会
   * 一起改，不会静默漂移。真正的坑在**将来**：有人加一个新的裁切入口标
   * （比如把内联宿主那条路径单独打一个标），它天然应该计入 `rescuedFromClip`，
   * 但相等判断会**静默地不收**它 —— 指标少算，而没有任何一处会红。
   *
   * 所以改成集合：新增裁切标时必须**显式决定**它是否入册。
   * 配套机械门禁：`tools/criteria-audit.mjs` 会把源码里所有 risk 标收集出来，
   * 要求它们在《判据输入含义核对表》的「是否计入 rescuedFromClip」列里
   * **逐个归类** —— 漏登记就红。
   */
  var CLIP_ENTRY_RISK = { 'ancestor-clipped': 1 };

  /**
   * 横向弹性行「挂到容器之后」的落点标。
   * ------------------------------------------------------------------
   * ★ C-36（2026-09-29）★ 它是**第二个**由静态判据产生、且伴随跨父节点落点
   * 变更的标 —— 见 `placementFor` 的 ③ 分支。
   *
   * 它与 `CLIP_RISK` 是**两条严格度不同的判据**，只是共用 `rec.risk` 这一个
   * 字段：
   *   · `CLIP_RISK`      —— 「祖先声明了裁切上下文」，圈得很宽（假阳性高），
   *                         **计入** rescuedFromClip；
   *   · `FLEX_ROW_RISK`  —— 「为了不挤坏横向弹性行，落点挂到了容器之后」，
   *                         是**形态**理由不是裁切理由，**不计入** rescuedFromClip。
   * 因此**绝不能**用 `rec.risk === 某个值` 去判口径，只能用登记集合。
   */
  var FLEX_ROW_RISK = 'flex-row-outside';

  /**
   * 决定一条译文插到哪、以什么形态插。
   * ------------------------------------------------------------------
   * ★ P-1（2026-09-29）后的职责边界（硬约束，改代码前先读）★
   * 本函数只允许做两件事：
   *   ① **不改 DOM 的早退**（返回 collapsed 让调用方跳过该单元）；
   *   ② 决定**插入点**（可逆、且必然被第二级几何判决复核）。
   * 它**不得**为了让译文「逃出」某个容器而输出不可逆的归属变更 ——
   * 那必须有几何证据，只能由第二级的 relocate 做。
   *
   * ★ C-36（2026-09-29）把「跨父插入」这一条讲清 ★
   * 上面那句曾经被读成「不许跨父节点插入」，那是**过头**的：横向弹性行那条
   * 分支（③）有充分的**形态**理由把译文挂到容器之后（不挂就会把原有子项
   * 平分宽度、挤变形）。真正的界线不是「跨不跨父」，而是**有没有被复核**：
   *   · 允许跨父插入 —— 但**必须打 risk 标**，让第二级去看一眼它可不可见；
   *   · 不许**为了救援**而跨父插入 —— 救援的落点只有几何判决能定。
   * 现在两条跨父路径（③ 横向弹性行、裁切分支）**都打了标**，形状与口径见
   * 各自的注释。
   *
   * 机械门禁：tools/test-clip-guard.mjs「静态门禁 · 免检通道清零」节
   * + tools/criteria-audit.mjs「每个 risk 标必须逐个归类」。
   * ------------------------------------------------------------------
   * @returns {{kind: 'inline'|'inside'|'after', anchor?: Element,
   *            wrap?: boolean, collapsed?: boolean, reason?: string,
   *            risk?: string}}
   *   inline    —— 宿主是内联级元素：追加内联译文，不打断行盒、不新增兄弟节点
   *   inside    —— 追加到单元内部末尾：父容器子项数、`:nth-child`、相邻兄弟
   *                选择器全部不受影响
   *   after     —— 插到 anchor 之后：**只**用于「追加进去必然成为弹性/网格项」
   *                的容器（或用户显式选择的 sibling 模式）。
   *                ★P-1 起**不再**用于裁切容器★ —— 第一级不再产出任何
   *                「搬到容器之外」的决策，那条路整体归第二级的 relocate。
   *                见本函数上方「职责边界」。
   *   collapsed —— 单元位于零高度折叠层内，调用方应直接丢弃这条单元
   */
  function placementFor(el, settings) {
    /*
     * 硬约束优先于用户设置：<td> / <li> / <dt> 这类容器插兄弟节点会直接破坏
     * HTML 结构（<tr> 里多出一个非单元格子元素，浏览器会另行生成匿名单元格）。
     * 这一步必须在读取 insertMode 之前，否则「总是插到原文之后」会把它绕过去。
     *
     * 同理它也优先于裁切判定 —— <td> 里插不了兄弟节点，
     * 即使那个单元格被裁切，也只能就地追加（内容确实看不全，
     * 但把译文挂到表格外面会让归属完全错乱，代价更大）。
     */
    if (D.shouldAppendInside(el)) return { kind: 'inside' };

    var mode = (settings && settings.insertMode) || 'auto';

    // 折叠区直接不翻（内容虽在但用户看不见）
    var clip = clipInfo(el);
    if (clip.collapsed) return { kind: 'inside', collapsed: true };

    /*
     * 裁切容器：静态级**不再在这里决定「把译文搬到容器之外」**。
     * ================================================================
     * ★ P-1（2026-09-29）：免检通道清零 ★
     *
     * 旧实现：静态判到「声明了硬约束的裁切容器」就直接返回
     * `{ kind:'after', anchor: 容器外 }` —— 这是一次**不可逆的归属搬迁**，
     * 而它**不打 risk 标**，于是 verifyBatch 的 `!rec.risk → continue`
     * 把它整条跳过：这个自称「两级验真」的体系里，那条路径
     * **第二级从不回看**。整套防线的可信度因此等于那条最粗的静态判据。
     * （完整根因链见《考核处分登记-2026-09-28》§七「架构不对称」、
     *   《经验教训登记册》L-19 元教训。）
     *
     * 新实现：静态级只**打标**，「搬不搬、搬到哪」全部交给第二级 ——
     * `judgeOne` 用译文的**真实矩形**判决，`relocate` 用
     * `escapeAnchor(el, t)` 只挑**几何上确实切掉了译文**的那一层做锚点。
     * 从此**不可逆动作必有几何证据**。
     *
     * 行为等价性（由 tools/probe-clip-channel-ab.mjs 真实浏览器 A/B 钉住）：
     *   · 真诚实被裁的单元 → 第二级同样会搬，而且锚点是量出来的、更准；
     *   · 静态判据的假阳性（声明了硬约束、其实没裁到译文）→ 不再无谓搬迁。
     *
     * 「第二级几何救援不属于插入点决策」这条既有纪律不变：无论哪种
     * insertMode，被裁的译文都会被第二级搬出去；用户显式选的
     * `sibling` 仍照旧挂在单元之后。
     * ================================================================ */
    if (clip.clip) {
      if (mode === 'sibling') return { kind: 'after', anchor: el, risk: CLIP_RISK };
      return { kind: 'inside', risk: CLIP_RISK };
    }

    // 用户显式指定 → **插入点**完全照办，不做任何自动调整（用于对照与排障）。
    // 但「第二级几何救援」不属于插入点决策：译文被站点裁掉时用户什么都看不到，
    // 同样谈不上对照 —— 与上面 clip.clip 优先于 insertMode 是同一条理由。
    // 所以这里仍然打标：placement 不变，verifyBatch 有机会把真正
    // 不可见的译文量出来、搬出去。代价是显式模式下多一次 suspectRisk
    // （纯缓存读，零布局开销），换来三种 insertMode 的遮挡覆盖完全一致。
    if (mode === 'sibling') {
      var sibRisk = suspectRisk(el);
      return sibRisk ? { kind: 'after', anchor: el, risk: sibRisk }
                     : { kind: 'after', anchor: el };
    }
    if (mode === 'inside') {
      var insRisk = suspectRisk(el);
      return insRisk ? { kind: 'inside', risk: insRisk } : { kind: 'inside' };
    }

    var l = layoutOf(el);

    // ① 内联级宿主：块级译文会打断行盒（标签行被拆行、pill 被撑开）
    //
    //    v1.7.1：这一条也必须打标。内联分支在 v1.7.0 里是「直接返回」的，
    //    也就是说**内联级宿主从来不会经过第 ⑤ 步的圈选** ——
    //    而截图现场恰好就是这条路径：`<span>`/`<a>` 标题写着
    //    `white-space:nowrap`，我们追加 `.ct-trans--inl`，它因为
    //    `white-space: inherit` 被拉着永不换行，然后被站点的省略号吃掉。
    //    漏掉这里，等于把 M1 整条路径留在盲区里。
    //
    //    注意此时祖先的裁切已经由上面的 clip.clip 处理过了，
    //    走到这里还能被圈选的，是「宿主自身」的 nowrap / 定高 ——
    //    正是要靠第二级量测来分辨「放得下」与「放不下」的那一类。
    if (INLINE_LEVEL[l.display]) {
      var inlRisk = suspectRisk(el);
      if (inlRisk) return { kind: 'inline', risk: inlRisk };
      return { kind: 'inline' };
    }

    // ② 已脱离文档流的元素：内部追加不会推动任何兄弟节点，最安全
    if (l.position === 'absolute' || l.position === 'fixed') return { kind: 'inside' };

    // ③ 单元自身就是横向弹性容器：追加进去等于「再加一列」，
    //    原有子项会被平分掉宽度 —— 这正是标签行被挤变形的直接原因
    if (l.display === 'flex' && isRowDirection(l.fd)) {
      // 容器允许换行时，给译文一个"整行宽"的弹性基准即可独占新的一行，
      // 原有子项一个都不动；此时留在容器内部比挂到外面更好 ——
      // 译文与原文的归属关系还在，也不会让容器的 :nth-child 错位
      if (l.fw === 'wrap' || l.fw === 'wrap-reverse') {
        return { kind: 'inside', wrap: true };
      }
      /* ★ C-36（2026-09-29）：这一条**必须打标** ★
       * 它把译文插到 `safeAnchor(el)` 之后 —— 那个锚点可能已经**不是 el 的
       * 直接父节点**，也就是一次**跨父节点的落点变更**。在此之前它
       * **不打 risk 标**，于是 verifyBatch 的 `!rec.risk → continue` 把它整条
       * 跳过：第二级既不量它可不可见、也不量它有没有被裁 ——
       * 与 P-1 刚清掉的那条免检通道**形状完全相同**（同族第 4 次）。
       *
       * 为什么仍允许跨父插入：这是**形态**决策而不是救援决策 —— 追加进横向
       * 弹性容器会让原有子项被 N+1 平分宽度（标签行被挤变形），
       * 挂到容器之后就完全没有这个问题。所以落点保留，**只补上复核**：
       * 打标 → 第二级量一次真实矩形 → 可见就一个字节都不动（绝大多数情况），
       * 被裁/不可见才由 relocate 接手。
       *
       * 口径：这个标**不计入** rescuedFromClip —— 它不是「从裁切容器里救回来
       * 的」，是「为了不挤坏弹性行才挪的」。由 CLIP_ENTRY_RISK 之外的位置
       * 登记，并由 tools/criteria-audit.mjs 的「每个 risk 标必须逐个归类」
       * 门禁钉住。 */
      return { kind: 'after', anchor: safeAnchor(el), reason: 'flex-row', risk: FLEX_ROW_RISK };
    }

    // ④ 纵向弹性容器与网格容器都是「往下加一行」，原有子项不受影响 → 内部追加。
    //    网格容器另有 CSS 兜底（grid-column: 1 / -1），让译文横跨整行。
    if (l.display === 'flex' || l.display === 'grid') return { kind: 'inside' };

    // ⑤ 其余（普通块、列表项、表格单元格、行内块的父级…）→ 内部追加
    //    v1.7.1：在收口处打一个「值得怀疑」的标。顺序放在最后是**刻意的** ——
    //    上面五条既有分支（硬约束 / 折叠丢弃 / 裁切外挪 / 内联 / 横向弹性）
    //    优先级全部高于它，因此 v1.7.0 的决策在一个字节上都没变。
    var risk = suspectRisk(el);
    if (risk) return { kind: 'inside', risk: risk };
    return { kind: 'inside' };
  }

  /** 安全插入：优先 insertAdjacentElement，失败则退回 parentNode.insertBefore */
  /**
   * 安全插入：插到 anchor 之后
   * ------------------------------------------------------------------
   * 必须插到「我们自己那串译文块的**末尾**」，而不是紧贴 anchor。
   *
   * 一个锚点被多条单元共用是常态：横向弹性容器里的若干个单元会共用同一个
   * 上溯锚点；被裁切容器下的所有单元也会共用同一个裁切容器当锚点。
   * 若每次都插在 anchor 的 nextSibling，先后插入 A、B 会得到 anchor,B,A ——
   * **译文顺序整体颠倒**，读起来前后不接，而且极难归因。
   */
  function insertAfter(el, node) {
    if (!el || !el.parentNode) return false;
    var ref = el.nextSibling;
    // 跳过已经紧跟在这个锚点之后的、本扩展自己插进去的译文块
    while (ref && ref.nodeType === 1
      && ref.classList && ref.classList.contains(CT.TRANS_CLASS)) {
      ref = ref.nextSibling;
    }
    try {
      el.parentNode.insertBefore(node, ref);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ================================================================
   * v1.7.1 · 第二级：几何判决（用真实量测代替猜测）
   * ================================================================
   * 【为什么必须有这一级】
   * 把 M1/M2/M3 判据补全后，静态圈选的假阳性极高 —— 头像容器、清浮动的老代码、
   * 能自由变宽的药丸，全都写着 overflow:hidden / nowrap。
   * 静态判据只能回答「值得怀疑」，答不了「真的被裁了吗」。
   *
   * 而「真的被裁了吗」恰恰是可以用几何量测直接回答的：
   * 把译文的 getBoundingClientRect() 与它祖先的裁切矩形一比就知道。
   *
   * 【为什么按「批」而不是按「单元」量】
   * 量矩形会强制布局。逐单元「写一个 → 量一个」就是教科书式的布局抖动，
   * 一个长页面能抖出上百次。这里把读段与写段严格分开：
   * 一批 N 个单元全部写完 → 一次读 N 个矩形 → 再统一搬。
   * 整批只触发一次强制布局。这与「决策全部前置到采集阶段」是同一条理由。
   * ================================================================ */

  var RECT_TOL = 1;                 // 亚像素与边框带来的 1px 误差

  function rectOutOf(t, c) {
    return t.left < c.left - RECT_TOL || t.right > c.right + RECT_TOL ||
           t.top < c.top - RECT_TOL || t.bottom > c.bottom + RECT_TOL;
  }

  /**
   * 译文是否位于一条 `display:none` 的祖先之下。
   * ------------------------------------------------------------------
   * ★ C-27（2026-09-28）★
   * 站点折叠起来的下拉面板、抽屉、非活动的 tab 页都是 `display:none`，
   * 它们里面的所有矩形都恒为零。旧版 `judgeOne` 见到零矩形就判
   * `invisible` 并以「被裁掉」为由把译文搬出容器 —— 于是把一整块
   * 关着的面板里的译文全倒到了页面上（remoteok 259 条地区选项实证）。
   *
   * 「还没显示」与「被裁掉」是两件事：前者只要面板一打开就正常了，
   * 不该动它一根手指。命中这条直接放行（返回 null = 通过）。
   *
   * 用已经缓存的 layoutOf，零额外样式读取；`display:none` 的节点
   * 本来就不进 layoutCache（它随时可能被显示出来），所以不会读到过期值。
   */
  function inHiddenSubtree(node) {
    var cur = node && node.parentElement;
    var hops = 0;
    var maxHops = CLIP_HOPS + 4;
    while (cur && hops < maxHops) {
      hops++;
      if (cur === document.documentElement) break;
      if (layoutOf(cur).display === 'none') return true;
      cur = cur.parentElement;
    }
    return false;
  }

  /**
   * 越界的那一轴，在这一层是不是「可以滚回来」。
   * ------------------------------------------------------------------
   * ★ C-27（2026-09-28）★
   * `overflow-y: scroll` 的面板里，滚动条之下那些行的译文，矩形当然
   * 落在面板可视区之外 —— 但那是「滚出去」而不是「被裁掉」，滚回来
   * 就能看见。旧版按 `rectOutOf` 一律判 `spills-host` 并搬走，
   * 于是同一个面板里当前没滚到的行会被一条条倒到页面上。
   *
   * 只放过「越界的那一轴可滚」的情形；另一轴若不可滚且越界，照旧判失败。
   * @returns {boolean} true = 只是滚出视口，这一层不该判它被裁
   */
  function scrollsOutOf(pl, t, c) {
    var vOut = t.top < c.top - RECT_TOL || t.bottom > c.bottom + RECT_TOL;
    var hOut = t.left < c.left - RECT_TOL || t.right > c.right + RECT_TOL;
    if (!vOut && !hOut) return false;
    var yScroll = pl.oy === 'auto' || pl.oy === 'scroll';
    var xScroll = pl.ox === 'auto' || pl.ox === 'scroll';
    if (vOut && !yScroll) return false;   // 纵向越界且不可滚 → 真的够不着
    if (hOut && !xScroll) return false;   // 横向同理
    return true;
  }

  /**
   * 判决单条译文是否可见。返回 null 表示通过。
   * ------------------------------------------------------------------
   * 四个失败原因都是**可量测**的，没有一条依赖猜测：
   *   invisible     译文矩形为零 → 被 display:none / line-clamp 整段吃掉
   *   ellipsized    宿主正在用省略号吃内容，译文是牺牲品（→ 截图现场）
   *   clipped       译文越出某个「约束祖先」的边界 → 被裁
   *   spills-host   译文越出它**直接父元素**的边界，而父元素在裁切
   *                 → 既可能被裁，也可能压到相邻元素上（「遮挡」的另一半）
   *
   * 检查沿**译文自己的**祖先链走，而不是单元 el 的祖先链：
   * 搬移之后译文已经不在 el 里了，若还按 el 的祖先链判，
   * 会拿着它已经逃出来的那个容器继续判它「被裁」，永远判不过。
   */
  /**
   * 判决单条译文是否可见。返回 null 表示通过。
   * ------------------------------------------------------------------
   * 四个失败原因都是**可量测**的，没有一条依赖猜测：
   *   invisible     译文矩形为零 → 被 display:none / line-clamp 整段吃掉
   *   ellipsized    宿主正在用省略号吃内容，译文是牺牲品（→ 截图现场）
   *   clipped       译文越出某个**声明了硬约束**的祖先（line-clamp / max-height）
   *                 → 那一层是站点有意做「截断 + 展开」的地方，内容是真的被切了
   *   spills-host   译文越出某个只是 `overflow:hidden` 的盒子
   *                 → 可能被切，也可能压住邻居（「遮挡」的另一半）
   *
   * 为什么 clipped / spills-host 要分开：两者的处置相同（都是搬走），
   * 但归因价值不同 —— `clipped` 说明站点在这条链上做了截断，
   * 排障时该去看站点的「展开全文」；`spills-host` 说明是译文自己没排下。
   * 想区分两者就**必须**用几何量：定高裁切（height:22px）与声明式硬约束
   * 在 computed style 上区分不出来（浏览器统一解析成使用值）。
   *
   * 检查沿**译文自己的**祖先链走，而不是单元 el 的祖先链：
   * 搬移之后译文已经不在 el 里了，若还按 el 的祖先链判，
   * 会拿着它已经逃出来的那个容器继续判它「被裁」，永远判不过。
   */
  function judgeOne(el, rec) {
    var node = rec.node;
    if (!node || !node.isConnected) return null;

    var t = node.getBoundingClientRect();
    /* ★ C-27：零矩形先分辨「还没显示」与「真被吃掉」★
     * 处于 display:none 子树里的译文矩形恒为零，面板一开就正常 ——
     * 这不是缺陷现场，判它 invisible 会把整块关着的面板倒到页面上。 */
    if (t.width <= 0 || t.height <= 0) {
      if (inHiddenSubtree(node)) return null;
      return 'invisible';
    }

    /* ① 省略号最具体，优先判 —— 它就是截图里 `高级成长产…` 的成因。
     *    判据三件套：宿主有 ellipsis、内容确实溢出、宿主不换行。
     *    三个都成立才能断定「是站点的省略号在吃译文」，少一个都不算。 */
    if (node !== el && el.contains(node)) {
      var hl = layoutOf(el);
      if (hl.te === 'ellipsis' && forcesNoWrap(hl) && el.scrollWidth > el.clientWidth + 1) {
        return 'ellipsized';
      }
    }

    /* ② 沿译文自己的祖先链，逐个用几何量判「有没有越出这一层」。
     *    判据只有两件：这一层会不会裁（overflow hidden/clip）+ 译文越没越界。
     *    不再要求「越界的那一层必须是直接父元素」—— 中间隔了几层也一样会被裁，
     *    而且译文是块级普通流子项，越出非直接父元素的情形是真实存在的
     *    （nowrap 祖先、定高祖先都会造成）。 */
    var cur = node.parentElement;
    var hops = 0;
    // 直接父元素也算一跳，因此上限比 CLIP_HOPS 多两跳
    var maxHops = CLIP_HOPS + 2;
    while (cur && hops < maxHops) {
      hops++;
      if (cur === document.body || cur === document.documentElement) break;
      var pl = layoutOf(cur);
      if (hasClipContext(pl) && rectOutOf(t, cur.getBoundingClientRect())) {
        var cr = cur.getBoundingClientRect();
        // ★ C-27：只是滚出去了（越界那轴可滚）→ 这一层不算裁，继续上溯
        if (scrollsOutOf(pl, t, cr)) { cur = cur.parentElement; continue; }
        return constrainsContent(pl) ? 'clipped' : 'spills-host';
      }
      cur = cur.parentElement;
    }

    /* ③ 【这里刻意没有「译文与原文重叠」这条判据】
     * ------------------------------------------------------------------
     * 设计初期写过一条：译文矩形与原文矩形重叠超过一定比例就算遮挡。
     * 实测**必须删掉** —— 内联译文本就在宿主的行盒里，宿主的
     * getBoundingClientRect() 天然包含它，于是「重叠面积 = 译文面积」，
     * 比值恒为 1，**每一条内联译文都会被判失败**。
     * 那正是 A4（放得下就该保持内联）要保住的行为，判据一写就把自己推翻了。
     *
     * 真正的「遮挡」信号由上面两条覆盖，而且都是可量测的：
     *   ellipsized   译文被站点的省略号吃掉（截图现场）
     *   spills-host  译文越出容器边界 —— 既可能被切，也会压住邻居
     * 记在这里，免得后来的人凭直觉把它加回来。 */
    return null;
  }

  /**
   * 搬移：把已经判失败的译文挪到约束容器之外。
   * ------------------------------------------------------------------
   * 只改类名不重建节点 —— 保住 clearUnit / restoreAll / resetForModeChange
   * 三条既有清理路径零改动继续有效。重建节点会让它们全部失配。
   */
  function relocate(el, rec, reason) {
    var node = rec.node;
    // 量一次译文当前的位置，交给 escapeAnchor 去挑「确实把它裁了的那一层」。
    // 这一次读不算额外开销：本函数末尾还要复验一次，本来就是单点量测。
    var t = node.getBoundingClientRect();
    var anchor = escapeAnchor(el, t);

    if (!canPlaceAfter(anchor)) {
      // 结构上挪不出去（例如被裁的正是 <td>）→ 如实记，不静默
      stats.clipUnresolved++;
      rec.verdict = 'unresolved:' + reason;
      return false;
    }

    if (node.parentNode) node.parentNode.removeChild(node);
    // 丢掉「内部/内联/弹性换行」三个形态类，换成「锚点之后」的块级形态
    node.classList.remove('ct-trans--in');
    node.classList.remove('ct-trans--inl');
    node.classList.remove('ct-trans--wrap');
    node.classList.add('ct-trans--out');
    node.classList.add('ct-trans--moved');

    var placed = insertAfter(anchor, node);
    if (!placed) placed = insertAfter(el, node);
    if (!placed) {
      // 都插不进去 → 退回就地追加。译文至少还在 DOM 里，能在排障时看到
      el.appendChild(node);
      stats.clipUnresolved++;
      rec.verdict = 'unresolved:reattach-failed';
      return false;
    }

    rec.node = node;
    rec.placement = 'after';
    rec.moved = true;
    rec.reason = 'relocated:' + reason;
    stats.relocated++;
    if (reason === 'invisible') stats.relocatedInvisible++;
    else if (reason === 'clipped') stats.relocatedClipped++;
    else if (reason === 'ellipsized') stats.relocatedEllipsized++;
    else stats.relocatedSpills++;

    // 立即单点复验：搬走了还被裁 → 记 clipUnresolved 并如实上报。
    // 只量这一个节点，不是整批，代价可忽略。
    var again = judgeOne(el, rec);
    if (again) {
      stats.clipUnresolved++;
      rec.verdict = 'unresolved:' + again;
      return false;
    }
    rec.verdict = 'moved';
    /* ★ P-1（2026-09-29）★ 只有走到这里才算「真的被救回来了」——
     * 量测确认不可见（进了 relocate）+ 搬完复验通过（不是 unresolved）。
     * 第一级标的 `ancestor-clipped` 是入口条件，命中它且救援成功才计数。
     * 口径与理由见上方 stats 里 rescuedFromClip 的注释。 */
    if (CLIP_ENTRY_RISK[rec.risk]) stats.rescuedFromClip = (stats.rescuedFromClip || 0) + 1;
    return true;
  }

  /**
   * 批末判决：对一批刚渲染完的单元做几何验真。
   * @param {Array<Element>} els
   * @returns {number} 实际搬走的条数
   */
  function verifyBatch(els) {
    if (!els || !els.length) return 0;

    // ---- 读段：只读不写 ----
    var pending = [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var rec = registry.get(el);
      // 只有「第一级圈选过」且「尚未搬过」的单元才量。
      // 没圈选的单元永远不量 —— 因此绝大多数页面是零额外量测开销。
      if (!rec || rec.mode !== 'below' || !rec.risk || rec.moved) continue;
      var reason = judgeOne(el, rec);
      if (reason) pending.push({ el: el, rec: rec, reason: reason });
    }
    if (!pending.length) return 0;

    // ---- 写段：判决完再统一搬 ----
    var moved = 0;
    for (var j = 0; j < pending.length; j++) {
      if (relocate(pending[j].el, pending[j].rec, pending[j].reason)) moved++;
    }
    return moved;
  }

  /**
   * 可见性审计（可执行证据）
   * ------------------------------------------------------------------
   * 与第二级**同一套判据**（同一个 judgeOne），因为两套判据必然漂移。
   * 唯一差别：第二级只量圈选过的单元（省成本），审计量**全部**单元（求完整）。
   *
   * 用途：截图不足以唯一归因时，让扩展自己在现场把答案量出来。
   *
   * @param {Element} [scope] 限定范围（基准页夹具用）；缺省全文档
   * @returns {Array<{reason:string,text:string,placement:string,risk:string,moved:boolean,rect:Object}>}
   */
  function auditVisibility(scope) {
    var out = [];
    registry.forEach(function (rec, el) {
      if (rec.mode !== 'below' && rec.mode !== 'below-keep') return;
      if (!rec.node || !rec.node.isConnected) return;
      if (scope && scope !== document && !scope.contains(el)) return;
      var reason = judgeOne(el, rec);
      if (!reason) return;
      var t = rec.node.getBoundingClientRect();
      out.push({
        reason: reason,
        text: String(rec.text || '').slice(0, 60),
        placement: rec.placement || '',
        risk: rec.risk || '',
        moved: !!rec.moved,
        rect: {
          left: Math.round(t.left), top: Math.round(t.top),
          width: Math.round(t.width), height: Math.round(t.height)
        }
      });
    });
    return out;
  }

  /** 审计摘要：按原因聚合，供 #ct-debug 与基准页一眼看完 */
  function auditSummary(scope) {
    var list = auditVisibility(scope);
    var byReason = {};
    for (var i = 0; i < list.length; i++) {
      byReason[list[i].reason] = (byReason[list[i].reason] || 0) + 1;
    }
    return { total: list.length, byReason: byReason, items: list };
  }

  /**
   * 元素内是否含「必须保结构」的行内元素。
   * ------------------------------------------------------------------
   * 判据是「这个元素里有没有用户会去点、去复制、去执行的东西」：
   * 链接、按钮、表单控件、代码片段。
   *
   * 为什么不用「含任何元素就算」：`<p>文字 <b>加粗</b> 更多</p>` 里的 <b>
   * 没有交互语义，把译文整段替换掉不会损失任何功能，反而换来最干净的阅读体验。
   * 判据过宽会让大量普通段落无谓地降级成双语。
   */
  function hasProtectedInline(el) {
    if (!el || !el.querySelector) return false;
    try {
      return !!el.querySelector(INLINE_KEEP);
    } catch (e) {
      // 极老的浏览器可能不认属性选择器写法 —— 保守起见当作「含结构」，
      // 降级不是错误结果，只是呈现为双语
      return false;
    }
  }

  /* ================================================================
   * 三、清除与还原
   * ================================================================ */

  /**
   * 清除某个单元的译文
   * @param {Element} el
   * @param {boolean} dropRecord 是否同时从注册表移除（默认 true）
   */
  function clearUnit(el, dropRecord) {
    if (dropRecord === undefined) dropRecord = true;
    if (!el || el.nodeType !== 1) return;

    var rec = registry.get(el);

    /*
     * 快路径：既无登记记录、也没有任何残留标记 → 直接返回。
     * 渲染每个新单元前都会先调一次 clearUnit，首次翻译时这条路径命中数千次；
     * 旧实现每次都要跑一遍 querySelectorAll(':scope > .ct-trans') 才确认无事可做。
     */
    if (!rec
        && !el.hasAttribute('data-ct-src')
        && !(el.classList && el.classList.contains('ct-hover'))) {
      return;
    }

    if (rec) {
      // 有登记记录 → 精确移除我们插进去的那个节点，无需任何 DOM 查询。
      // below-keep 是「仅显示译文」的降级形态（元素含链接，没被替换），
      // 它的译文同样是一个外部节点，移除方式与 below 完全一致。
      if ((rec.mode === 'below' || rec.mode === 'below-keep') && rec.node && rec.node.parentNode) {
        rec.node.parentNode.removeChild(rec.node);
      } else if (rec.mode === 'replace' && typeof rec.origHTML === 'string') {
        el.innerHTML = rec.origHTML;
        el.classList.remove('ct-replaced');
      } else if (rec.mode === 'hover') {
        el.classList.remove('ct-hover');
        el.style.removeProperty('--ct-tip');
      }
      if (dropRecord) registry.delete(el);
    } else {
      // 没有登记记录却有残留标记（扩展重载 / 注册表被回收）→ 按类名兜底清扫
      var leftovers = el.querySelectorAll(':scope > .' + CT.TRANS_CLASS);
      for (var i = 0; i < leftovers.length; i++) {
        if (leftovers[i].parentNode) leftovers[i].parentNode.removeChild(leftovers[i]);
      }
    }

    el.classList.remove('ct-hover');
    el.removeAttribute('data-ct-src');
    tidyEmptyAttrs(el);
  }

  /** 还原整页：先按注册表精确还原，再全局清扫孤儿译文块 */
  function restoreAll() {
    var keys = Array.from(registry.keys());
    for (var i = 0; i < keys.length; i++) {
      var el = keys[i];
      // 已被页面移除的节点：丢掉记录即可，不必对它做任何 DOM 操作。
      // 单页应用整段替换内容后，注册表里会积压大量这类节点。
      if (el.isConnected) clearUnit(el, true);
      else registry.delete(el);
    }
    registry.clear();

    var orphans = document.querySelectorAll('.' + CT.TRANS_CLASS);
    for (var j = 0; j < orphans.length; j++) {
      if (orphans[j].parentNode) orphans[j].parentNode.removeChild(orphans[j]);
    }
    var hovered = document.querySelectorAll('.ct-hover');
    for (var k = 0; k < hovered.length; k++) {
      hovered[k].classList.remove('ct-hover');
      hovered[k].style.removeProperty('--ct-tip');
      tidyEmptyAttrs(hovered[k]);
    }
    var replaced = document.querySelectorAll('.ct-replaced');
    for (var m = 0; m < replaced.length; m++) {
      replaced[m].classList.remove('ct-replaced');
      tidyEmptyAttrs(replaced[m]);
    }

    var marked = document.querySelectorAll('[data-ct-src]');
    for (var n = 0; n < marked.length; n++) marked[n].removeAttribute('data-ct-src');

    resetStats();
  }

  /**
   * 丢弃指向已脱离文档的节点的登记记录。
   * ------------------------------------------------------------------
   * registry 是 Map<Element, Record>，键是对 DOM 节点的强引用。
   * 单页应用整段替换内容后，旧节点本可被回收，却因为仍被注册表持有而
   * 留在内存里 —— 反复切换路由就会持续增长。这里按连通性做一次清扫，
   * 由编排层在低峰时机调用（成本 O(已登记单元数)，只读属性、不碰布局）。
   * @returns {number} 清理掉的记录条数
   */
  function pruneDisconnected() {
    if (!registry.size) return 0;
    var dropped = 0;
    var keys = registry.keys();
    var el = keys.next();
    while (!el.done) {
      if (!el.value.isConnected) {
        registry.delete(el.value);
        dropped++;
      }
      el = keys.next();
    }
    return dropped;
  }

  /** 切换展示模式时：把已渲染的译文全部撤掉，等下一轮按新模式重画 */
  function resetForModeChange() {
    var keys = Array.from(registry.keys());
    for (var i = 0; i < keys.length; i++) clearUnit(keys[i], true);
    registry.clear();
    resetStats();
    // 裁切状态是站点说了算的，且随时可能被它自己的 JS 改掉（点「展开全文」）。
    // 换模式意味着整页要重来一遍，顺手把布局缓存清掉，
    // 免得拿着上一轮的 overflow / height 结论继续做决策。
    layoutCache = new WeakMap();
    clearContextCache();
  }

  /* ================================================================
   * 四、统计与状态
   * ================================================================ */

  function resetStats() {
    stats.translated = 0;
    stats.failed = 0;
    stats.skipped = 0;
    stats.units = 0;
    stats.rescuedFromClip = 0;
    stats.replaceDegraded = 0;
    stats.riskSuspect = 0;
    stats.relocated = 0;
    stats.clipUnresolved = 0;
    stats.relocatedInvisible = 0;
    stats.relocatedClipped = 0;
    stats.relocatedEllipsized = 0;
    stats.relocatedSpills = 0;
  }

  function getStats() {
    return {
      translated: stats.translated,
      failed: stats.failed,
      skipped: stats.skipped,
      units: registry.size,
      // 「从裁切容器里救回来的译文条数」。这个数不为 0 说明页面上确实有
      // 折叠/截断容器，也正是「有内容显示不全」那类反馈的量化依据。
      rescuedFromClip: stats.rescuedFromClip || 0,
      // 「仅显示译文」下，因含链接/代码而降级为双语的段落数。
      // 它是产品判断依据，不是错误计数 —— 比例为 0 才说明这个模式名不副实。
      replaceDegraded: stats.replaceDegraded || 0,

      /* ---- v1.7.1 译文可见性 ----
       * riskSuspect 是「值得怀疑」，relocated 是「量测后确认不可见、已搬走」，
       * clipUnresolved 是「搬了也没救回来」。三者必须分开报 ——
       * 合成一个数字会让排障的人分不清「误判」与「真问题」。 */
      riskSuspect: stats.riskSuspect || 0,
      relocated: stats.relocated || 0,
      relocatedInvisible: stats.relocatedInvisible || 0,
      relocatedClipped: stats.relocatedClipped || 0,
      relocatedEllipsized: stats.relocatedEllipsized || 0,
      relocatedSpills: stats.relocatedSpills || 0,
      // 不为 0 = 页面上确实存在「结构上挪不出去」的容器（`<td>` 等）。
      // 这是如实登记的已知限制，不是错误。
      clipUnresolved: stats.clipUnresolved || 0
    };
  }

  /** 供 popup / options 显示「当前页面已翻译多少段」 */
  function registrySize() {
    return registry.size;
  }

  /* ================================================================
   * 导出
   * ================================================================ */
  CT.renderer = {
    collectUnits: collectUnits,
    renderUnit: renderUnit,
    clearUnit: clearUnit,
    restoreAll: restoreAll,
    resetForModeChange: resetForModeChange,
    resetStats: resetStats,
    getStats: getStats,
    registrySize: registrySize,
    normalizeText: normalizeText,
    extractText: extractText,
    pruneDisconnected: pruneDisconnected,
    refreshFontScale: refreshFontScale,
    pageBaseFontPx: pageBaseFontPx,
    placementFor: placementFor,
    layoutOf: layoutOf,
    clipInfo: clipInfo,
    clipsContent: clipsContent,
    collapsesContent: collapsesContent,
    contextFor: contextFor,
    hasProtectedInline: hasProtectedInline,
    INLINE_KEEP: INLINE_KEEP,
    registry: registry,

    /* ---- v1.7.1 译文可见性（导出供单测与基准页使用） ---- */
    hasClipContext: hasClipContext,
    constrainsContent: constrainsContent,
    forcesNoWrap: forcesNoWrap,
    suspectRisk: suspectRisk,
    joinChildTexts: joinChildTexts,
    escapeAnchor: escapeAnchor,
    canPlaceAfter: canPlaceAfter,
    verifyBatch: verifyBatch,
    judgeOne: judgeOne,
    relocate: relocate,
    auditVisibility: auditVisibility,
    auditSummary: auditSummary
  };
})(typeof self !== 'undefined' ? self : this);
