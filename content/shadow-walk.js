/*
 * 叠译 · Shadow DOM 遍历（仅开放根）
 * ------------------------------------------------------------------
 * 能力边界（如实写在代码里，而不是藏在文档里）：
 *   只处理 mode:'open' 的 shadow root。
 *   closed 根需要 world:'MAIN' 补丁 Element.prototype.attachShadow，
 *   而两个 world 之间【不共享 JS 对象】—— root 引用根本传不回 isolated world，
 *   只能把纯文本序列化后 postMessage 过来，成本与收益完全不匹配。
 *   另外 <input> / <img> 这类内置元素的 UA shadow root 恒为 closed，
 *   即使打了补丁也拿不到内部 —— 这是「做不全」的硬证据。
 *
 * 两个必踩的坑（会导致「看起来生效、实际漏翻」）：
 *   1) 页面级 CSS 不穿透 shadow 边界。译文插进去了但没有任何样式，
 *      表现是「译文出来了但和原文一样大、没有间距」。→ ensureStyle()
 *   2) shadow tree 是独立树，它内部的变化【不会】触发父文档的 MutationObserver。
 *      而且自定义元素通常在 connectedCallback 里才调 attachShadow，
 *      宿主插入文档的那一刻 shadowRoot 可能还是 null。→ 重试队列
 */
(function (root) {
  'use strict';

  var CT = (root.CT = root.CT || {});

  /** 一次 idle 回调处理多少个 root —— 切片是为了不让长任务卡住页面 */
  var SLICE = 8;

  /**
   * 注入到 shadow root 内的译文样式。
   * ------------------------------------------------------------------
   * 这是 content/content.css 的**精简副本**，只保留译文块的核心规则。
   *
   * 为什么必须单独一份：页面级 CSS（包括 manifest 里 content_scripts.css
   * 注入的那份）**不穿透 shadow 边界**。直接指望 content.css 的话，
   * shadow 里的译文会「插进去了但完全没样式」—— 字号没收小、没有上方间距，
   * 和原文糊在一起，看起来像功能没生效。
   *
   * 只抄核心规则而不是整份 content.css，是为了控制注入体积：
   * 这份文本会按「每个 shadow root 一份」注入。
   */
  var TRANS_CSS = [
    '.ct-trans{display:block!important;box-sizing:border-box!important;',
    'margin:2px 0 0!important;padding:0!important;border:0!important;',
    'border-radius:0!important;background:transparent!important;box-shadow:none!important;',
    'font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif!important;',
    'font-weight:400!important;font-style:normal!important;line-height:1.55!important;',
    'font-size:80%!important;',
    'font-size:min(var(--ct-scale,80%),var(--ct-cap,100%))!important;',
    'color:inherit!important;text-align:left!important;letter-spacing:0!important;',
    'text-transform:none!important;text-shadow:none!important;text-decoration:none!important;',
    'white-space:normal!important;word-break:break-word!important;overflow-wrap:anywhere;',
    'max-width:100%!important;min-width:0!important;',
    'position:static!important;float:none!important;clear:none!important;}',
    '.ct-trans.ct-s-plain{color:inherit!important;opacity:.82;}',
    '.ct-trans.ct-s-accent{border-left:2px solid currentColor!important;padding-left:8px!important;opacity:.92;}',
    '.ct-trans.ct-s-accent::before{content:attr(data-ct-mark);}',
    /* ---- 形态类（v1.7.1 补齐）----
     * 此前这份精简副本只带了基类与两个样式修饰，没带形态类。
     * 后果是：shadow root 内所有译文都是基类的 display:block ——
     * 内联宿主的译文会打断行盒（pill 被撑成两行），
     * 而 v1.7.1 新增的「搬移后」形态若不在这里声明，搬进来的 <span>
     * 会带着残留的 --inl 继续内联，白搬一趟。
     * 两份样式必须同步演进，否则 shadow 内的表现与 light DOM 会悄悄分叉。 */
    '.ct-trans.ct-trans--in{width:100%!important;grid-column:1/-1!important;}',
    '.ct-trans.ct-trans--inl{display:inline!important;width:auto!important;',
    'margin:0 0 0 .45em!important;line-height:inherit!important;',
    'white-space:inherit!important;vertical-align:baseline!important;text-overflow:clip!important;}',
    '.ct-trans.ct-trans--wrap{flex:0 0 100%!important;}',
    '.ct-trans.ct-trans--out,.ct-trans.ct-trans--moved{display:block!important;',
    'width:100%!important;margin:3px 0 0!important;position:static!important;float:none!important;}',
    '.ct-trans.ct-trans--moved::before{content:none!important;}'
  ].join('');

  var QUEUE = [];
  var running = false;
  var scanned = 0;
  /** C-70 D3：契约缺失（CT.content.translateRoots 不存在）只 `console.warn` 一次，不重复刷。 */
  var warnedMissing = false;
  /** C-72（已签）：因**宿主标记**被整根跳过的 root 数（扩展自身 UI，见 `pump()` 内判据）。 */
  var skippedOwn = 0;

  /**
   * 迭代式（非递归）查找范围内的开放 shadow root。
   * 用显式栈而不是递归：深层嵌套的自定义元素（ServiceNow 那类多层 shadow）
   * 递归写法有爆栈风险。
   *
   * @param {Node} scope 起点，默认 document
   * @returns {ShadowRoot[]}
   */
  function findRoots(scope) {
    var out = [];
    var start = scope || document;
    var stack = [start];

    while (stack.length) {
      var node = stack.pop();
      if (!node || typeof node.querySelectorAll !== 'function') continue;

      var els;
      try {
        els = node.querySelectorAll('*');
      } catch (e) {
        continue;
      }

      for (var i = 0; i < els.length; i++) {
        var sr = els[i].shadowRoot;   // closed 在这里恒为 null
        if (sr) {
          out.push(sr);
          stack.push(sr);             // 继续往这一层里面找
        }
      }
    }
    return out;
  }

  /** 判断一个节点是否在某个 shadow root 内（用于跳过重复扫描） */
  function rootOf(node) {
    if (!node || typeof node.getRootNode !== 'function') return null;
    var r = node.getRootNode();
    return (r && r.host) ? r : null;
  }

  /**
   * 把样式注入 shadow root 内部。
   * 优先 adoptedStyleSheets（Chrome 73+，不产生额外 DOM 节点），
   * 失败退化到插 <style>。两条路都试不通就放弃这个 root（不抛错）。
   *
   * @param {ShadowRoot} root
   * @param {string} cssText
   * @returns {boolean}
   */
  function ensureStyle(root, cssText) {
    if (!root || root.__ctStyle) return !!root;
    var css = cssText || TRANS_CSS;
    if (!css) return false;

    try {
      if (root.adoptedStyleSheets && typeof CSSStyleSheet === 'function') {
        var sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        root.adoptedStyleSheets = (root.adoptedStyleSheets || []).concat([sheet]);
        root.__ctStyle = sheet;
        return true;
      }
    } catch (e) {
      // 继续走 <style> 分支
    }

    try {
      var st = document.createElement('style');
      st.setAttribute('data-ct-shadow-style', '');
      st.textContent = css;
      root.appendChild(st);
      root.__ctStyle = st;
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 入队待扫描的 root（去重） */
  function enqueue(r) {
    if (!r || r.__ctQueued) return;
    r.__ctQueued = true;
    QUEUE.push(r);
    pump();
  }

  /** 把一批 root 一次性入队 */
  function enqueueAll(roots) {
    for (var i = 0; i < roots.length; i++) enqueue(roots[i]);
  }

  /**
   * 按 idle 时间片消费队列。
   * 每次只处理 SLICE 个 root：shadow 内的采集同样是 DOM 读操作，
   * 一次处理太多会让单帧超时，用户感知到卡顿。
   */
  function pump() {
    if (running || !QUEUE.length) return;
    running = true;

    var idle = root.requestIdleCallback
      ? function (cb) { return root.requestIdleCallback(cb); }
      : function (cb) { return setTimeout(function () { cb(null); }, 16); };

    idle(function (deadline) {
      var n = 0;
      while (QUEUE.length && n < SLICE) {
        if (deadline && typeof deadline.timeRemaining === 'function' && deadline.timeRemaining() <= 4 && n > 0) break;
        var r = QUEUE.shift();
        n++;
        /*
         * C-72（已签 · `C-70` 后续子项 · 方案 A）：**「根归属」这一层**先按**宿主标记**
         * 整根跳过**扩展自身的 UI**。
         * ------------------------------------------------------------------
         * 页内开关把整棵 UI 放在 `host.attachShadow()` 里（`content/toggle.js:686`；
         * 其内造 `style`(`:689`)/`div.box`(`:693`)/`div.menu`(`:724`)/`div.guide`(`:752`)/
         * `div.confirm`(`:769`)）。这个 **open shadow root** 会被 `findRoots(document)`
         * 找到 ⇒ 经 `Option E` 的 `translateRoots(r.children)` 送进采集管线 —— 即
         * **扩展把自己的 UI 当页面内容采走**（自噬面；`isOwnNode` 守卫的是 observer 三支，
         * **不在**这条路径上，故本层必须自己判）。
         *
         * 判据读**宿主元素**上的标记（闸门本就打在宿主上）：`data-ct-skip` ／
         * `translate="no"` ／ `CT.TOGGLE_CLASS`（`'ct-toggle'`）任一命中 ⇒ **整根跳过**。
         * **整根**（而非逐子节点）⇒ 天然覆盖经 `findRoots(r)` 递归入队的内层 root，
         * 且开销最低。
         *
         * 【边界 · 单内已登记】经 `findRoots(document)` **独立入队**的内层 root
         * （非本 root 的后代）不在本覆盖范围；方案 B 最小形态亦已登记，**本批不实施**。
         * 【硬约束】跳过路径**只 `continue`**，**绝不触碰 `scanned`** —— 否则重演
         * `C-70` `D3` 刚消除的「虚假成功计数」。
         */
        var hostEl = r && r.host;
        if (hostEl && hostEl.nodeType === 1 && (
          hostEl.hasAttribute('data-ct-skip')
          || hostEl.getAttribute('translate') === 'no'
          || (CT.TOGGLE_CLASS && hostEl.classList && hostEl.classList.contains(CT.TOGGLE_CLASS))
        )) {
          skippedOwn++;
          r.__ctQueued = false;
          continue;
        }
        try {
          /*
           * C-70（S-13 · Option E）：**不把 ShadowRoot 当 root 传**，而是枚举它的
           * **元素子节点**（`ShadowRoot` 继承 `DocumentFragment` ⇒ 实现 `ParentNode`
           * ⇒ 有 `.children`），交给 `CT.content.translateRoots` **直连既有管线**
           * `run('mutation', roots)`。传真 `Element` ⇒ `renderer.collectUnits` 的
           * root 守卫（`renderer.js:359`）天然放行 ⇒ shadow 内容才能真正被翻译。
           *
           * D3：`scanned++` **只在"真实执行之后"**（旧写法把它放在 `if` 之外 ⇒
           * 契约缺失也 +1，制造"虚假成功计数"，即 `U-1` 的现象）；契约缺失**必须
           * 显式失败**（`console.warn` 一次、不计数），不得静默。
           */
          var tr = CT.content && CT.content.translateRoots;
          if (typeof tr === 'function') {
            var kids = r.children;
            var arr = [];
            for (var k = 0; k < kids.length; k++) arr.push(kids[k]);
            if (arr.length) tr(arr);
            // 嵌套 shadow：内层根重新入本模块队列（复用既有 findRoots / enqueueAll）
            var inner = findRoots(r);
            if (inner.length) enqueueAll(inner);
            scanned++;
          } else if (!warnedMissing) {
            warnedMissing = true;
            if (root.console && console.warn) {
              console.warn('[叠译] shadow 采集入口缺失（CT.content.translateRoots）');
            }
          }
        } catch (e) {
          // 单个 root 的采集失败不能拖垮整轮 —— 站点里的自定义元素千奇百怪，
          // 抛异常是常态而不是异常情况
          if (root.console && console.warn) console.warn('[叠译] shadow 采集失败：', e);
        }
        r.__ctQueued = false;
      }
      running = false;
      if (QUEUE.length) pump();
    });
  }

  /**
   * 观察到宿主元素被插入后调用。
   * 关键：延迟到下一帧再读 shadowRoot —— 自定义元素通常在 connectedCallback
   * 里才调 attachShadow，此刻读必然拿到 null。
   * @returns {ShadowRoot|null}
   */
  function rootOfHostSoon(host) {
    if (!host || !host.shadowRoot) return null;
    return host.shadowRoot;
  }

  function stats() {
    return { queued: QUEUE.length, scanned: scanned, running: running, skippedOwn: skippedOwn };
  }

  function reset() {
    QUEUE.length = 0;
    running = false;
    scanned = 0;
    skippedOwn = 0;
  }

  CT.shadow = {
    findRoots: findRoots,
    rootOf: rootOf,
    ensureStyle: ensureStyle,
    enqueue: enqueue,
    enqueueAll: enqueueAll,
    rootOfHostSoon: rootOfHostSoon,
    stats: stats,
    reset: reset,
    TRANS_CSS: TRANS_CSS,
    SLICE: SLICE
  };
})(typeof self !== 'undefined' ? self : this);
