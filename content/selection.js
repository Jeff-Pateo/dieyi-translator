/*
 * 叠译 · 划词翻译
 * ------------------------------------------------------------------
 * 形态：选中一段文本 → 松开鼠标 → 选区旁弹出气泡显示译文。
 *
 * 架构上最重要的一条决定：
 *   划词**不新开翻译通道**，它复用 CT.MSG.TRANSLATE（采样规模 = 1 的整页翻译）。
 *   于是它白拿三样东西，一样都不用重写：
 *     · URL / 代码 / 版本号的掩码保护（shared/protect.js）——
 *       选中一个链接不会把域名翻掉
 *     · 用户术语表 —— 划词与整页对同一个术语给出一致的译名
 *     · 缓存 —— 划词过的句子，整页翻译时直接命中；反之亦然
 *
 * 定位是这一块唯一真正的难点（也是竞品公开的弱点：气泡跑屏外）。
 * 做法是「先量后放」：先隐藏挂载量出尺寸，再算最终坐标。
 * 直接放在锚点旁边、量出越界再挪，会让用户看到一次可见的跳动。
 */
(function (root) {
  'use strict';

  var CT = (root.CT = root.CT || {});

  var Z_INDEX = 2147483600;
  var GAP = 8;        // 气泡与选区的间距
  var EDGE = 12;      // 与视口边缘的最小留白
  var MAX_SRC_LINES = 3;
  var MAX_SRC_CHARS = 300;
  var SCROLL_CLOSE = 40;   // 未固定时，滚动超过这个距离就收起

  /* ================================================================
   * 纯函数区（可在 jsdom / Node 里直接断言）
   * ================================================================ */

  /**
   * 气泡定位：保证完整落在视口内。
   * ------------------------------------------------------------------
   * @param {{left:number, top:number, right:number, bottom:number}} anchor 选区矩形
   * @param {{width:number, height:number}} size 气泡尺寸（已量出）
   * @param {{width:number, height:number}} viewport
   * @param {{gap?:number, edge?:number}} [opts]
   * @returns {{left:number, top:number, flipped:boolean}}
   */
  function computePosition(anchor, size, viewport, opts) {
    opts = opts || {};
    var gap = opts.gap === undefined ? GAP : opts.gap;
    var edge = opts.edge === undefined ? EDGE : opts.edge;

    var vw = viewport.width;
    var vh = viewport.height;
    var bw = size.width;
    var bh = size.height;

    // ---- 水平 ----
    // 优先与选区起点左对齐（读起来顺）；右边放不下就改为右对齐选区终点。
    var left = anchor.left;
    if (left + bw + edge > vw) left = anchor.right - bw;
    if (left < edge) left = edge;
    // 气泡比视口还宽（长文本）时只能贴边，此时左边界胜出
    if (left + bw + edge > vw) left = Math.max(edge, vw - bw - edge);

    // ---- 垂直 ----
    // 优先放在选区下方；下方不够就翻到上方；上下都不够就选空间大的一侧。
    var top = anchor.bottom + gap;
    var flipped = false;

    if (top + bh + edge > vh) {
      var above = anchor.top === undefined ? anchor.bottom : anchor.top;
      if (above - gap - bh >= edge) {
        top = above - gap - bh;
        flipped = true;
      } else {
        var spaceBelow = vh - anchor.bottom - gap - edge;
        var spaceAbove = above - gap - edge;
        if (spaceAbove > spaceBelow) {
          top = Math.max(edge, above - gap - bh);
          flipped = true;
        } else {
          top = Math.max(edge, vh - bh - edge);
        }
      }
    }

    if (top < edge) top = edge;

    return { left: Math.round(left), top: Math.round(top), flipped: flipped };
  }

  /**
   * 从 Range 提取锚点与文本。
   * ------------------------------------------------------------------
   * 用 getClientRects() 而不是 getBoundingClientRect()：
   * 跨元素的选区，getBoundingClientRect() 返回的是把整个选区包住的**外接矩形**，
   * 可能横跨半屏；而 rects 列表才是真实的逐行覆盖范围。
   * 取最后一行（rects 末尾）作为锚点 —— 气泡贴住选区末尾最符合直觉。
   *
   * @param {Range} range
   * @returns {{text:string, anchor:Object}|null}
   */
  function rectFromRange(range) {
    if (!range) return null;

    var rects;
    try {
      rects = range.getClientRects();
    } catch (e) {
      return null;
    }
    if (!rects || !rects.length) return null;

    // 过滤掉零尺寸矩形（换行处会产生 width=0 的伪矩形）
    var valid = [];
    for (var i = 0; i < rects.length; i++) {
      if (rects[i].width > 0 || rects[i].height > 0) valid.push(rects[i]);
    }
    if (!valid.length) return null;

    var first = valid[0];
    var last = valid[valid.length - 1];

    var text = '';
    try {
      text = String(range.toString() || '');
    } catch (e) {
      return null;
    }

    return {
      text: text,
      anchor: {
        left: first.left,
        top: first.top,
        right: last.right,
        bottom: last.bottom
      }
    };
  }

  /**
   * 判定节点是否属于本扩展注入的 DOM。
   * ------------------------------------------------------------------
   * 必须用 getRootNode() 上溯：shadow root 内的译文节点，
   * parentElement 链在 root 边界处就断了，只有 getRootNode().host 能穿过去。
   * 不处理这一条，用户划自己页面里的译文就会再弹一个气泡出来。
   */
  function isOwnNode(n, ownClasses) {
    var cls = ownClasses || ['ct-trans', 'ct-toggle', 'ct-sel', 'ct-badge', 'ct-tip'];
    var el = n && (n.nodeType === 1 ? n : n.parentElement);

    // 文本节点可能直接挂在 shadow root 上（没有 parentElement）
    if (!el && n && typeof n.getRootNode === 'function') {
      var r0 = n.getRootNode();
      if (r0 && r0.host) el = r0.host;
    }

    var guard = 0;
    while (el && guard++ < 60) {
      if (el.classList) {
        for (var i = 0; i < cls.length; i++) {
          if (el.classList.contains(cls[i])) return true;
        }
      }
      if (el.hasAttribute && (el.hasAttribute('data-ct-skip') || el.hasAttribute('data-ct-bubble'))) return true;

      var r = el.getRootNode ? el.getRootNode() : null;
      if (r && r.host) { el = r.host; continue; }   // 穿过 shadow 边界

      el = el.parentElement;
    }
    return false;
  }

  /**
   * 这段选区该不该触发气泡。
   * @param {Object} ctx { text, settings, ownNode, anchorValid }
   * @returns {{ok:boolean, reason:string}}
   */
  function shouldTrigger(ctx) {
    var s = ctx.settings || {};
    var text = String(ctx.text || '').trim();

    if (ctx.ownNode) return { ok: false, reason: 'own-dom' };
    if (!text) return { ok: false, reason: 'empty' };
    if (!ctx.anchorValid) return { ok: false, reason: 'no-rect' };

    var min = s.selectionMinLen === undefined ? 2 : s.selectionMinLen;
    if (text.length < min) return { ok: false, reason: 'too-short' };

    var max = s.selectionMaxLen === undefined ? 1200 : s.selectionMaxLen;
    if (text.length > max) return { ok: false, reason: 'too-long' };

    // 纯数字 / 纯符号没有翻译价值（"2024"、"---" 这类）
    if (!/[\p{L}]/u.test(text)) return { ok: false, reason: 'no-letter' };

    return { ok: true, reason: 'ok' };
  }

  /* ================================================================
   * 气泡 DOM
   * ================================================================ */

  var BUBBLE_CSS = [
    ':host{all:initial;}',
    '*{box-sizing:border-box;margin:0;padding:0;}',
    '.b{',
    '  position:fixed;z-index:' + Z_INDEX + ';',
    '  max-width:min(420px,86vw);min-width:180px;',
    '  background:#fff;color:#1c1f23;',
    '  border:1px solid rgba(15,23,42,.12);border-radius:10px;',
    '  box-shadow:0 8px 28px rgba(15,23,42,.18);',
    '  font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;',
    '  font-size:13px;line-height:1.6;overflow:hidden;',
    '}',
    '.src{',
    '  padding:8px 10px;max-height:' + (MAX_SRC_LINES * 1.6) + 'em;overflow:hidden;',
    '  color:#5b6470;background:#f6f7f9;border-bottom:1px solid rgba(15,23,42,.08);',
    '  display:-webkit-box;-webkit-line-clamp:' + MAX_SRC_LINES + ';-webkit-box-orient:vertical;',
    '}',
    '.dst{padding:9px 10px;white-space:pre-wrap;word-break:break-word;}',
    '.dst[data-state="loading"]{color:#8a93a0;}',
    '.dst[data-state="error"]{color:#b3261e;}',
    '.dst[data-state="same"]{color:#8a93a0;font-style:italic;}',
    '.foot{',
    '  display:flex;align-items:center;gap:4px;justify-content:flex-end;',
    '  padding:5px 6px;border-top:1px solid rgba(15,23,42,.08);background:#fafbfc;',
    '}',
    'button{',
    '  all:unset;cursor:pointer;font:inherit;font-size:12px;color:#4a5461;',
    '  padding:3px 7px;border-radius:6px;white-space:nowrap;',
    '}',
    'button:hover{background:rgba(15,23,42,.07);color:#1c1f23;}',
    'button:focus-visible{outline:2px solid #2f7fd4;outline-offset:1px;}',
    'button[aria-pressed="true"]{background:#2f7fd4;color:#fff;}',
    '.sp{width:1px;height:14px;background:rgba(15,23,42,.12);margin:0 2px;}',
    '@media (prefers-color-scheme:dark){',
    '  .b{background:#22262c;color:#e8eaed;border-color:rgba(255,255,255,.14);box-shadow:0 8px 28px rgba(0,0,0,.5);}',
    '  .src{color:#9aa3af;background:#2b3037;border-bottom-color:rgba(255,255,255,.1);}',
    '  .foot{background:#252a30;border-top-color:rgba(255,255,255,.1);}',
    '  button{color:#aab3bf;}',
    '  button:hover{background:rgba(255,255,255,.1);color:#fff;}',
    '}'
  ].join('');

  /* ================================================================
   * 实例
   * ================================================================ */

  var host = null;
  var shadow = null;
  var bubble = null;
  var srcEl = null;
  var dstEl = null;
  var btnPin = null;
  var state = 'idle';          // idle | loading | ready
  var current = null;          // { text, range, anchor, translation }
  var pinned = false;
  var opts = {};
  var attached = false;
  var lastScrollY = 0;
  var bubbleSize = { width: 0, height: 0 };

  function setState(s) { state = s; }

  function build() {
    if (host) return true;
    var doc = root.document;
    if (!doc || !doc.body) return false;

    host = doc.createElement('div');
    host.className = 'ct-sel';
    host.setAttribute('data-ct-bubble', '');
    host.setAttribute('data-ct-skip', 'bubble');
    host.setAttribute('translate', 'no');
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('left', '0', 'important');
    host.style.setProperty('top', '0', 'important');
    host.style.setProperty('width', '0', 'important');
    host.style.setProperty('height', '0', 'important');
    host.style.setProperty('z-index', String(Z_INDEX), 'important');
    host.style.setProperty('pointer-events', 'none', 'important');

    shadow = host.attachShadow({ mode: 'open' });
    var style = doc.createElement('style');
    style.textContent = BUBBLE_CSS;
    shadow.appendChild(style);

    bubble = doc.createElement('div');
    bubble.className = 'b';
    bubble.style.display = 'none';
    // 只有气泡本体接收指针事件 —— 宿主是 0×0，不会挡住页面任何东西
    bubble.style.pointerEvents = 'auto';
    bubble.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    bubble.addEventListener('mousedown', function (e) { e.stopPropagation(); });

    srcEl = doc.createElement('div');
    srcEl.className = 'src';

    dstEl = doc.createElement('div');
    dstEl.className = 'dst';

    var foot = doc.createElement('div');
    foot.className = 'foot';

    var btnCopy = doc.createElement('button');
    btnCopy.type = 'button';
    btnCopy.textContent = '复制';
    btnCopy.addEventListener('click', onCopy);

    btnPin = doc.createElement('button');
    btnPin.type = 'button';
    btnPin.textContent = '固定';
    btnPin.setAttribute('aria-pressed', 'false');
    btnPin.addEventListener('click', onTogglePin);

    var sep = doc.createElement('div');
    sep.className = 'sp';

    var btnClose = doc.createElement('button');
    btnClose.type = 'button';
    btnClose.textContent = '关闭';
    btnClose.addEventListener('click', function () { hide(true); });

    foot.appendChild(btnCopy);
    foot.appendChild(btnPin);
    foot.appendChild(sep);
    foot.appendChild(btnClose);

    bubble.appendChild(srcEl);
    bubble.appendChild(dstEl);
    bubble.appendChild(foot);
    shadow.appendChild(bubble);

    doc.documentElement.appendChild(host);
    return true;
  }

  /** 把气泡摆到锚点旁：先量后放 */
  function applyPosition() {
    if (!bubble || !current) return;

    bubble.style.visibility = 'hidden';
    bubble.style.display = '';
    bubble.style.left = '0px';
    bubble.style.top = '0px';

    var w = bubble.offsetWidth;
    var h = bubble.offsetHeight;
    bubbleSize = { width: w, height: h };

    var pos = computePosition(current.anchor, bubbleSize, {
      width: root.innerWidth || 0,
      height: root.innerHeight || 0
    });

    bubble.style.left = pos.left + 'px';
    bubble.style.top = pos.top + 'px';
    bubble.style.visibility = '';
    current.placed = pos;
  }

  /* ---------------- 行为 ---------------- */

  function onCopy() {
    var text = current && current.translation;
    if (!text) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
      } else {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      flash(dstEl, '已复制');
    } catch (e) { /* 复制失败不打断阅读 */ }
  }

  function flash(el, text) {
    if (!el || el.querySelector('.flash')) return;
    var tag = document.createElement('span');
    tag.className = 'flash';
    tag.textContent = ' · ' + text;
    tag.style.cssText = 'color:#2f7fd4;font-size:11px;';
    el.appendChild(tag);
    setTimeout(function () { if (tag.parentNode) tag.parentNode.removeChild(tag); }, 1400);
  }

  function onTogglePin() {
    pinned = !pinned;
    if (btnPin) {
      btnPin.textContent = pinned ? '取消固定' : '固定';
      btnPin.setAttribute('aria-pressed', pinned ? 'true' : 'false');
    }
  }

  function show() {
    if (!build()) return;
    if (!CT.layers.acquire('selection', function () { hide(false); })) return;

    setState('loading');
    srcEl.textContent = current.text.length > MAX_SRC_CHARS
      ? current.text.slice(0, MAX_SRC_CHARS) + '…'
      : current.text;
    dstEl.textContent = '翻译中…';
    dstEl.setAttribute('data-state', 'loading');
    current.translation = '';

    applyPosition();
    requestTranslate();
  }

  function hide(manual) {
    if (bubble) bubble.style.display = 'none';
    setState('idle');
    pinned = false;
    if (btnPin) {
      btnPin.textContent = '固定';
      btnPin.setAttribute('aria-pressed', 'false');
    }
    CT.layers.release('selection');
    // manual 时保留 current（用户可能只是关掉气泡，选区还在，再划一次能命中缓存）
    if (manual) current = null;
  }

  async function requestTranslate() {
    if (!current || !opts.translate) return;
    var mine = current;

    var res;
    try {
      res = await opts.translate(mine.text);
    } catch (e) {
      res = { ok: false, error: (e && e.message) || '请求失败' };
    }

    // 期间用户已经划了别的词 / 关掉气泡 → 这次结果作废，不要覆盖新内容
    if (mine !== current) return;

    if (!res || !res.ok) {
      var why = (res && (res.error || res.notice)) || '翻译失败';
      dstEl.textContent = why;
      dstEl.setAttribute('data-state', 'error');
      setState('ready');
      return;
    }

    if (res.same) {
      dstEl.textContent = '这段文字已经是目标语言。';
      dstEl.setAttribute('data-state', 'same');
      mine.translation = '';
      setState('ready');
      return;
    }

    var text = String(res.text || '').trim();
    if (!text) {
      dstEl.textContent = '没有返回译文。';
      dstEl.setAttribute('data-state', 'error');
      setState('ready');
      return;
    }

    dstEl.textContent = text;
    dstEl.removeAttribute('data-state');
    mine.translation = text;
    setState('ready');
    // 译文比「翻译中…」长，尺寸变了要重新摆一次
    applyPosition();
  }

  /* ---------------- 事件 ---------------- */

  function onMouseUp(e) {
    var conf = opts.getSettings ? opts.getSettings() : {};
    if (!conf || conf.selectionEnabled === false) return;
    if (e && e.button !== undefined && e.button !== 0) return;

    // 「必须按住 Alt」模式：给那些站点自带划词弹层的场景一个让出赛道的开关。
    // 默认关闭，因为多按一个键对多数用户是净负担。
    if (conf.selectionOnlyWithModifier && !e.altKey) return;

    // 等浏览器把选区状态落定再读 —— mouseup 那一刻 selection 可能还没更新
    setTimeout(function () {
      var sel = root.getSelection ? root.getSelection() : null;
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        // 选区被清空（用户在空白处点了一下）→ 收起
        if (state !== 'idle' && !pinned) hide(false);
        return;
      }

      var range = sel.getRangeAt(0);
      var info = rectFromRange(range);
      var text = '';
      try { text = String(sel.toString() || ''); } catch (err) { text = ''; }

      var own = false;
      try { own = isOwnNode(range.commonAncestorContainer); } catch (err) { own = false; }

      var verdict = shouldTrigger({
        text: text,
        settings: conf,
        ownNode: own,
        anchorValid: !!info
      });

      if (!verdict.ok) {
        if (verdict.reason === 'own-dom' && state !== 'idle' && !pinned) hide(false);
        return;
      }

      current = {
        text: text.trim(),
        // 存一份 range 副本：滚动跟随重算位置时还要用
        range: range.cloneRange(),
        anchor: info.anchor,
        translation: '',
        placed: null
      };

      if (conf.selectionTrigger === 'icon') {
        showTriggerIcon();
        return;
      }
      show();
    }, 0);
  }

  /**
   * 「点击图标才翻译」模式。
   * 存在的理由是接口额度：有的用户只想在看不懂时才翻，不希望每次划词都发请求。
   */
  var iconEl = null;
  function showTriggerIcon() {
    if (!build()) return;
    if (!CT.layers.acquire('selection', function () { removeIcon(); })) return;

    if (!iconEl) {
      iconEl = document.createElement('button');
      iconEl.type = 'button';
      iconEl.className = 'ct-sel-icon';
      iconEl.textContent = '译';
      iconEl.style.cssText = [
        'position:fixed', 'z-index:' + Z_INDEX, 'width:26px', 'height:26px',
        'border-radius:50%', 'border:0', 'cursor:pointer', 'padding:0',
        'background:#2f7fd4', 'color:#fff', 'font-size:13px', 'line-height:26px',
        'box-shadow:0 2px 8px rgba(15,23,42,.28)', 'pointer-events:auto'
      ].join(';');
      iconEl.addEventListener('click', function (e) {
        e.stopPropagation();
        removeIcon();
        // 图标点击时选区可能已被清除 —— 用之前存下的文本，不重新读选区
        show();
      });
      shadow.appendChild(iconEl);
    }

    var anchor = current.anchor;
    iconEl.style.visibility = 'hidden';
    iconEl.style.display = '';
    var sz = { width: 26, height: 26 };
    var pos = computePosition(anchor, sz, { width: root.innerWidth || 0, height: root.innerHeight || 0 });
    iconEl.style.left = pos.left + 'px';
    iconEl.style.top = pos.top + 'px';
    iconEl.style.visibility = '';
  }

  function removeIcon() {
    if (iconEl) iconEl.style.display = 'none';
  }

  function onDocPointerDown(e) {
    if (!host) return;
    // 点在气泡或图标上 → 不收起（它们自己处理）
    var path = e.composedPath ? e.composedPath() : [];
    for (var i = 0; i < path.length; i++) {
      if (path[i] === host || path[i] === bubble || path[i] === iconEl) return;
    }
    removeIcon();
    if (!pinned && state !== 'idle') hide(false);
  }

  function onScroll() {
    if (state === 'idle') return;
    if (pinned) {
      // 固定态：滚动时跟随选区重算，而不是关掉
      if (current && current.range) {
        var info = rectFromRange(current.range);
        if (info) { current.anchor = info.anchor; applyPosition(); }
      }
      return;
    }
    if (Math.abs((root.scrollY || 0) - lastScrollY) > SCROLL_CLOSE) hide(false);
  }

  function onKeydown(e) {
    if (e.key !== 'Escape') return;
    if (state === 'idle' && (!iconEl || iconEl.style.display === 'none')) return;
    e.stopPropagation();
    removeIcon();
    hide(true);
  }

  function onResize() {
    if (state !== 'idle') applyPosition();
  }

  /* ---------------- 生命周期 ---------------- */

  function init(options) {
    opts = options || {};
    if (attached) return;
    attached = true;

    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('pointerdown', onDocPointerDown, true);
    root.addEventListener('scroll', onScroll, true);
    root.addEventListener('resize', onResize);
    document.addEventListener('keydown', onKeydown, true);

    if (root.chrome && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (!changes.settings) return;
        if (area !== 'sync' && area !== 'local') return;
        var s = CT.settings.merge(CT.DEFAULT_SETTINGS, changes.settings.newValue || {});
        if (s.selectionEnabled === false) hide(true);
      });
    }
  }

  function destroy() {
    if (!attached) return;
    attached = false;
    document.removeEventListener('mouseup', onMouseUp, true);
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    root.removeEventListener('scroll', onScroll, true);
    root.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKeydown, true);
    removeIcon();
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = shadow = bubble = srcEl = dstEl = btnPin = iconEl = null;
    current = null;
    setState('idle');
  }

  CT.selection = {
    init: init,
    destroy: destroy,
    hide: hide,
    // 供测试与调试
    computePosition: computePosition,
    rectFromRange: rectFromRange,
    isOwnNode: isOwnNode,
    shouldTrigger: shouldTrigger,
    state: function () { return state; },
    isPinned: function () { return pinned; },
    currentText: function () { return current && current.text; },
    placed: function () { return current && current.placed; },
    _setBubbleSize: function (w, h) { bubbleSize = { width: w, height: h }; }
  };
})(typeof self !== 'undefined' ? self : this);
