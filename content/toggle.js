/*
 * 叠译 · 页内常驻开关
 * ------------------------------------------------------------------
 * 这是一个挂在宿主页面里的浮层控件：点一下开关本页翻译，不用再去够浏览器
 * 右上角的工具栏图标。三条硬约束决定了它的实现方式：
 *
 *   1) 不得改变宿主页面布局
 *      宿主元素走 position: fixed，不进文档流，也不参与任何容器的弹性/网格
 *      计算。关键定位属性用行内样式 + !important 写死 —— 站点的 `body > div`
 *      这类选择器命中我们时也压不掉它。
 *
 *   2) 不得被站点样式污染，也不得污染站点
 *      整棵 UI 关在 Shadow DOM 里，站点 CSS 进不来，我们的 CSS 出不去。
 *      这是「控件在任意站点都长得一样」的唯一可靠做法：靠类名前缀 + !important
 *      在别人的样式表里抢优先级，永远会有抢不过的站点。
 *
 *   3) 不得被自己的翻译引擎「自噬」
 *      宿主同时打上 data-ct-skip 与 translate="no"，采集阶段直接整块跳过；
 *      同时类名 ct-toggle 登记进 isOwnNode 白名单，MutationObserver 也认它。
 *      两道闸门，任一失效都不会把「翻译」两个字本身送去翻译。
 *
 * 与编排层（content.js）的分工：本模块只负责「显示」与「用户意图」，
 * 不读设置、不发消息、不碰译文。所有决定权通过回调交回编排层 ——
 * 这样控件可以在 jsdom 里独立断言，不必把整个翻译链路跑起来。
 */
(function (root) {
  'use strict';

  var CT = (root.CT = root.CT || {});

  /** 宿主类名。content.js 的 isOwnNode 白名单依赖它，改名必须同步。 */
  var CLASS = 'ct-toggle';
  /** 与 .ct-badge / .ct-tip 同层级族 */
  var Z_INDEX = 2147483600;
  /** 默认距视口右 / 下边缘的间距 */
  var EDGE_GAP = 16;
  /** 窄屏（<480px）下改用更小的间距与尺寸 */
  var NARROW_GAP = 10;
  /** 拖动判定阈值：移动不超过它就算点击，不算拖动 */
  var DRAG_SLOP = 5;
  /** 吸附后纵向位置与视口边缘至少保留的间距 */
  var CLAMP_GAP = 8;

  /** 位置与折叠状态的存储键。刻意不进 settings —— 拖一下开关不该触发整页重扫。 */
  var UI_KEY = (CT.STORAGE && CT.STORAGE.TOGGLE_UI) || 'ct.toggleUI';

  /** 引导气泡看过没有。与位置同键存放，省一次存储往返。 */
  var GUIDE_KEY = 'guideSeen';

  /*
   * 主按钮文案：**全部写成动作**，而不是状态。
   * ------------------------------------------------------------------
   * 旧文案是「翻译」/「已译」——「已译」是个形容词，用户看到它不知道该不该点、
   * 点了会发生什么，这正是「不易察觉如何使用」。
   *
   * 改成「翻译此页」/「显示原文」之后，两个问题一起解决：
   *   · 关闭态告诉用户「点了我能做什么」
   *   · 开启态告诉用户「点了你会看到什么」
   * 后者还顺手回答了用户最担心的事 —— 点了不会把中文删掉，只是回到原文。
   *
   * mark 是图标位（目标语言标记），由 render() 按当前目标语言写入，
   * 所以同一条文案在「翻成日语」时图标是「日」，在「翻成英文」时是「EN」。
   */
  var LABELS = {
    off: { text: '翻译此页', aria: '把本页翻译成目标语言' },
    busy: { text: '翻译中', aria: '正在翻译本页' },
    on: { text: '显示原文', aria: '本页已显示译文，点击回到原文' },
    unavailable: { text: '无需翻译', aria: '当前页面不需要翻译' }
  };

  /** 图标位在拿不到目标语言时的兜底 —— 老节点与测试都依赖它 */
  var DEFAULT_MARK = '译';

  /** 菜单条目定义。顺序即展示顺序；sep:true 表示该条之前插一条分隔线。 */
  var MENU_ITEMS = [
    { id: 'never', text: '本网站不再自动翻译', icon: 'block' },
    { id: 'options', text: '打开设置…', icon: 'gear', sep: true },
    { id: 'hide', text: '隐藏这个按钮（本页）', icon: 'eye-off' },
    /* ★ C-28：持久出口。
     * 旧版只有「隐藏这个按钮」，而它是实例级内存变量 —— 刷新一下就回来，
     * 用户在页面上没法表达「以后都不要」。持久开关原本只长在设置页深处，
     * 于是用户陷入「隐藏一次、回来一次」的循环（体感：这东西重复出现）。 */
    { id: 'hideAll', text: '所有网站都不显示', icon: 'eye-off' },
    { id: 'collapse', text: '收起为圆点', icon: 'fold', sep: true }
  ];

  /* ================================================================
   * 存储读写
   * ----------------------------------------------------------------
   * chrome.storage 在两种情况下不可用：扩展上下文刚失效、以及测试沙箱。
   * 这里的失败必须无声降级 —— 位置记忆读不到就用默认位，
   * 绝不能因为一次读取失败就让控件挂不上。
   * ================================================================ */

  function safeGet(key, fallback) {
    return new Promise(function (resolve) {
      try {
        if (!chrome || !chrome.storage || !chrome.storage.local) { resolve(fallback); return; }
        chrome.storage.local.get(key, function (res) {
          void chrome.runtime.lastError;
          var v = res ? res[key] : undefined;
          resolve(v === undefined || v === null ? fallback : v);
        });
      } catch (e) {
        resolve(fallback);
      }
    });
  }

  function safeSet(obj) {
    try {
      if (!chrome || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.set(obj, function () { void chrome.runtime.lastError; });
    } catch (e) {
      // 扩展已失效，位置记忆丢失无伤大雅
    }
  }

  /* ================================================================
   * 位置模型
   * ----------------------------------------------------------------
   * { side: 'right'|'left', y: number, bottom: boolean }
   *   side   贴哪条竖直边
   *   y      贴边方向上的偏移：bottom=true 时是距底部，否则是距顶部
   *   bottom 是否锚定底边
   * 默认 bottom=true 是为了让控件在窗口高度变化时继续贴底（符合直觉）；
   * 一旦用户拖动过，就变成绝对纵坐标，不再跟着窗口走。
   * ================================================================ */

  function defaultPos() {
    return { side: 'right', y: EDGE_GAP, bottom: true };
  }

  function normalizePos(raw) {
    var d = defaultPos();
    if (!raw || typeof raw !== 'object') return d;
    var out = {
      side: raw.side === 'left' ? 'left' : 'right',
      y: Number.isFinite(raw.y) ? raw.y : d.y,
      bottom: raw.bottom !== false
    };
    return out;
  }

  function viewport() {
    var vw = root.innerWidth || (root.document && root.document.documentElement.clientWidth) || 0;
    var vh = root.innerHeight || (root.document && root.document.documentElement.clientHeight) || 0;
    return { vw: vw, vh: vh };
  }

  function gapFor(vw) {
    return vw > 0 && vw < 480 ? NARROW_GAP : EDGE_GAP;
  }

  /* ================================================================
   * 站点浮层冲突检测
   * ----------------------------------------------------------------
   * 右下角是「回到顶部」「客服气泡」「Cookie 条」的默认领地，本控件默认位
   * 正好和它们撞车。这里用一个 O(1) 的取样代替遍历全页 fixed 元素：
   * 在候选角落取一个点做 elementFromPoint，命中的若不是我们自己的宿主，
   * 就认为该角落已被占用，往上挪一格再试。
   * 取样而非遍历，是因为遍历要读每个元素的 computed position，
   * 在长页面上会强制一次大规模样式重算 —— 为一个浮层付这个代价不划算。
   * ================================================================ */

  function cornerOccupied(side, y, vw, vh) {
    try {
      if (!root.document || typeof root.document.elementFromPoint !== 'function') return false;
      var x = side === 'right' ? vw - 26 : 26;
      var py = y;
      var hit = root.document.elementFromPoint(x, py);
      if (!hit) return false;
      // 命中自身或其后代 → 角落空闲
      if (hit.classList && hit.classList.contains(CLASS)) return false;
      if (hit.closest && hit.closest('.' + CLASS)) return false;
      // html / body 视为「没有别的浮层」
      var tag = hit.tagName;
      if (tag === 'HTML' || tag === 'BODY') return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  function avoidClash(pos, vw, vh) {
    if (pos.bottom !== true) return pos;
    var next = { side: pos.side, y: pos.y, bottom: true };
    var y = vh - pos.y - 26;
    var tries = 0;
    while (tries < 3 && cornerOccupied(next.side, y, vw, vh)) {
      next.y += 56;
      y = vh - next.y - 26;
      tries++;
    }
    // 挪到上半屏就失去「贴底」的意义了，退回默认位
    if (next.y > vh * 0.6) return pos;
    return next;
  }

  /* ================================================================
   * 样式
   * ================================================================ */

  var CSS = [
    /* all: initial 斩断一切继承 —— 站点的 font-size / line-height / color
       一个都传不进来。关键定位属性另有行内 !important 兜底，见 hardenHost()。 */
    ':host {',
    '  all: initial;',
    '  position: fixed;',
    '  display: block;',
    '  z-index: ' + Z_INDEX + ';',
    '}',
    ':host([hidden]) { display: none !important; }',

    /* ---- 胶囊 ------------------------------------------------
       结构： [目标语言标记] [动作词] [⋯更多]
       副操作不再藏在 hover 里 —— 「悬停才出现」在触屏上等于不存在，
       而「不知道怎么用」正是这个控件最大的问题。 */
    '.box {',
    '  display: flex;',
    '  align-items: center;',
    '  gap: 2px;',
    '  padding: 3px;',
    '  border-radius: 999px;',
    '  border: 1px solid rgba(15, 40, 80, 0.16);',
    '  background: rgba(255, 255, 255, 0.97);',
    '  box-shadow: 0 6px 20px rgba(15, 40, 80, 0.18);',
    '  font-family: system-ui, -apple-system, "PingFang SC", "Hiragino Sans GB",',
    '               "Microsoft YaHei", sans-serif;',
    '  font-size: 12.5px;',
    '  line-height: 1;',
    '  color: #3d4a5c;',
    '  box-sizing: border-box;',
    '  transition: box-shadow 0.18s ease, border-color 0.18s ease, background 0.18s ease;',
    '}',
    '.box:hover, .box:focus-within {',
    '  box-shadow: 0 8px 26px rgba(15, 40, 80, 0.24);',
    '}',

    /* ---- 主按钮 ---- */
    '.main {',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  gap: 6px;',
    /* 桌面端不得小于 40×40，触摸目标下限 */
    '  min-width: 40px;',
    '  height: 40px;',
    '  padding: 0 10px 0 5px;',
    '  border: 0;',
    '  border-radius: 999px;',
    '  background: transparent;',
    '  color: inherit;',
    '  font: inherit;',
    '  font-weight: 500;',
    '  cursor: pointer;',
    '  user-select: none;',
    '  -webkit-user-select: none;',
    '  touch-action: none;',   /* 触摸拖动时不要被浏览器手势抢走 */
    '  box-sizing: border-box;',
    '}',
    '.main:focus-visible {',
    '  outline: 2px solid rgba(45, 125, 210, 0.85);',
    '  outline-offset: 1px;',
    '}',

    /* 图标＝目标语言标记（中 / 繁 / EN / 日…），由 JS 写进文本。
       它直接回答「点下去会翻成什么语言」—— 多语言互译下这一条比什么都重要。 */
    '.ico {',
    '  display: block;',
    '  min-width: 25px;',
    '  height: 25px;',
    '  padding: 0 5px;',
    '  box-sizing: border-box;',
    '  line-height: 23px;',
    '  text-align: center;',
    '  border-radius: 999px;',
    '  font-size: 10.5px;',
    '  font-weight: 700;',
    '  letter-spacing: 0.2px;',
    '  border: 1px solid rgba(15, 40, 80, 0.22);',
    '  color: #5a6779;',
    '  background: transparent;',
    '  transition: background 0.18s ease, color 0.18s ease, border-color 0.18s ease;',
    '}',

    '.label {',
    '  font-size: 12.5px;',
    '  white-space: nowrap;',
    '}',

    /* 状态点只在「翻译中」出现，作为进度脉冲。
       关闭态与开启态已有颜色、图标、文案三条通道区分，
       再加一个点只会让 40px 高的胶囊里塞进四个元素。 */
    '.dot {',
    '  display: none;',
    '  width: 7px;',
    '  height: 7px;',
    '  border-radius: 50%;',
    '  background: #2f7fd4;',
    '  box-sizing: border-box;',
    '  flex: 0 0 auto;',
    '}',

    /* ---- 开启态：整个胶囊换成实心品牌蓝 ----------------------------
       旧实现只改图标底色与边框颜色，两者都是浅色系，扫一眼分不出来。
       「开关设计不合理」里最直观的一条就是这个。 */
    ':host([data-status="on"]) .box {',
    '  border-color: #2f7fd4;',
    '  background: #2f7fd4;',
    '  color: #ffffff;',
    '  box-shadow: 0 6px 20px rgba(47, 127, 212, 0.34);',
    '}',
    ':host([data-status="on"]) .box:hover,',
    ':host([data-status="on"]) .box:focus-within {',
    '  box-shadow: 0 8px 26px rgba(47, 127, 212, 0.44);',
    '}',
    ':host([data-status="on"]) .ico {',
    '  color: #2f7fd4;',
    '  background: #ffffff;',
    '  border-color: #ffffff;',
    '}',
    ':host([data-status="on"]) .label { color: #ffffff; font-weight: 600; }',

    /* ---- 翻译中 ---- */
    ':host([data-status="busy"]) .dot {',
    '  display: block;',
    '  animation: ct-toggle-pulse 1.1s ease-in-out infinite;',
    '}',
    ':host([data-status="busy"]) .ico {',
    '  border-color: rgba(47, 127, 212, 0.5);',
    '  color: #2f7fd4;',
    '}',

    /* ---- 不可译（页面已是目标语言 / 站点在黑名单） ---- */
    ':host([data-status="unavailable"]) .box {',
    '  border-style: dashed;',
    '  border-color: rgba(15, 40, 80, 0.2);',
    '  box-shadow: 0 4px 14px rgba(15, 40, 80, 0.1);',
    '}',
    ':host([data-status="unavailable"]) .ico { color: #9aa5b4; border-color: rgba(15, 40, 80, 0.14); }',
    ':host([data-status="unavailable"]) .label { color: #9aa5b4; }',
    ':host([data-status="unavailable"]) .main { cursor: default; }',
    /* 什么都不用翻的时候，「⋯」里那几条命令也都不成立，一并收掉 */
    ':host([data-status="unavailable"]) .tool--more { display: none; }',

    '@keyframes ct-toggle-pulse {',
    '  0%, 100% { opacity: 0.35; }',
    '  50%      { opacity: 1; }',
    '}',

    /* ---- 操作区：常显 ---- */
    '.tools {',
    '  display: flex;',
    '  align-items: center;',
    '  gap: 2px;',
    '}',

    '.tool {',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  width: 30px;',
    '  height: 30px;',
    '  padding: 0;',
    '  border: 0;',
    '  border-radius: 50%;',
    '  background: transparent;',
    '  color: #6b7787;',
    '  cursor: pointer;',
    '  box-sizing: border-box;',
    '}',
    '.tool:hover { background: rgba(15, 40, 80, 0.08); color: #17558f; }',
    '.tool:focus-visible { outline: 2px solid rgba(45, 125, 210, 0.85); outline-offset: 1px; }',
    '.tool svg { display: block; }',
    ':host([data-status="on"]) .tool { color: rgba(255, 255, 255, 0.88); }',
    ':host([data-status="on"]) .tool:hover { background: rgba(255, 255, 255, 0.22); color: #ffffff; }',

    /* ---- 更多菜单 --------------------------------------------------
       点开才出现，而不是悬停才出现 —— 触屏上没有 hover。 */
    '.menu {',
    '  position: absolute;',
    '  right: 0;',
    '  bottom: calc(100% + 8px);',
    '  width: max-content;',
    '  min-width: 186px;',
    '  max-width: 280px;',
    '  padding: 5px;',
    '  border-radius: 12px;',
    '  border: 1px solid rgba(15, 40, 80, 0.16);',
    '  background: rgba(255, 255, 255, 0.99);',
    '  box-shadow: 0 12px 32px rgba(15, 40, 80, 0.24);',
    '  box-sizing: border-box;',
    '}',
    '.menu[hidden] { display: none; }',
    '.menu__i {',
    '  display: flex;',
    '  align-items: center;',
    '  gap: 9px;',
    '  width: 100%;',
    '  padding: 8px 10px;',
    '  border: 0;',
    '  border-radius: 8px;',
    '  background: transparent;',
    '  color: #3d4a5c;',
    '  font: inherit;',
    '  font-size: 12.5px;',
    '  line-height: 1.35;',
    '  text-align: left;',
    '  cursor: pointer;',
    '  box-sizing: border-box;',
    '}',
    '.menu__i:hover { background: rgba(15, 40, 80, 0.07); }',
    '.menu__i:focus-visible { outline: 2px solid rgba(45, 125, 210, 0.85); outline-offset: -2px; }',
    '.menu__i svg { flex: 0 0 auto; opacity: 0.7; }',
    '.menu__sep { height: 1px; margin: 4px 6px; background: rgba(15, 40, 80, 0.1); }',

    /* ---- 首次引导气泡 ----------------------------------------------
       只在第一次出现时展示一次。解决的就是「不易察觉如何使用」：
       用户装完扩展、页面上多出一个胶囊，没有任何东西告诉他这是什么、
       能不能拖、还有别的入口。 */
    '.guide {',
    '  position: absolute;',
    '  right: 0;',
    '  bottom: calc(100% + 10px);',
    '  width: max-content;',
    '  max-width: 272px;',
    '  padding: 11px 12px 10px;',
    '  border-radius: 12px;',
    '  border: 1px solid rgba(15, 40, 80, 0.16);',
    '  background: rgba(255, 255, 255, 0.99);',
    '  box-shadow: 0 12px 32px rgba(15, 40, 80, 0.24);',
    '  box-sizing: border-box;',
    '  color: #3d4a5c;',
    '}',
    '.guide[hidden] { display: none; }',
    /* 指向胶囊的小尖角，让「这个气泡在说它」一目了然 */
    '.guide::after {',
    '  content: "";',
    '  position: absolute;',
    '  right: 20px;',
    '  top: 100%;',
    '  width: 10px;',
    '  height: 10px;',
    '  margin-top: -5px;',
    '  background: rgba(255, 255, 255, 0.99);',
    '  border-right: 1px solid rgba(15, 40, 80, 0.16);',
    '  border-bottom: 1px solid rgba(15, 40, 80, 0.16);',
    '  transform: rotate(45deg);',
    '}',
    '.guide__t { margin: 0 0 6px; font-size: 13px; font-weight: 600; color: #1d2b3d; }',
    '.guide__b { margin: 0 0 9px; font-size: 12.5px; line-height: 1.55; color: #55647a; }',
    '.guide__acts { display: flex; justify-content: flex-end; }',

    /* ---- 收起态：仍保留「⋯」，否则收起之后又变成无法使用的圆点 ---- */
    ':host([data-collapsed="1"]) .label,',
    ':host([data-collapsed="1"]) .dot { display: none; }',
    ':host([data-collapsed="1"]) .main { min-width: 40px; width: 40px; padding: 0; }',

    /* ---- 窄屏 -------------------------------------------------------
       刻意**不隐藏文案**。旧实现在 480px 以下把 label 收掉、只剩一个
       「译」字圆饼，正是「不易察觉如何使用」在手机上最严重的一幕。
       宁可让胶囊宽一点。 */
    '@media (max-width: 480px) {',
    '  .box { font-size: 12px; }',
    '  .main { min-width: 38px; height: 38px; padding: 0 8px 0 4px; }',
    '  .ico { min-width: 23px; height: 23px; line-height: 21px; }',
    '  .label { font-size: 12px; }',
    '  .tool { width: 28px; height: 28px; }',
    '  :host([data-collapsed="1"]) .main { min-width: 38px; width: 38px; }',
    '}',

    /* ---- 黑名单二次确认 ---- */
    '.confirm {',
    '  position: absolute;',
    '  right: 0;',
    '  bottom: calc(100% + 8px);',
    '  width: max-content;',
    '  max-width: 260px;',
    '  padding: 10px 12px;',
    '  border-radius: 12px;',
    '  border: 1px solid rgba(15, 40, 80, 0.16);',
    '  background: rgba(255, 255, 255, 0.99);',
    '  box-shadow: 0 10px 30px rgba(15, 40, 80, 0.22);',
    '  font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;',
    '  font-size: 12.5px;',
    '  line-height: 1.5;',
    '  color: #3d4a5c;',
    '  box-sizing: border-box;',
    '}',
    '.confirm[hidden] { display: none; }',
    '.confirm__t { margin: 0 0 8px; }',
    '.confirm__acts { display: flex; gap: 6px; justify-content: flex-end; }',
    '.cbtn {',
    '  padding: 5px 11px;',
    '  border-radius: 999px;',
    '  border: 1px solid rgba(15, 40, 80, 0.18);',
    '  background: transparent;',
    '  color: #3d4a5c;',
    '  font: inherit;',
    '  font-size: 12.5px;',
    '  cursor: pointer;',
    '  box-sizing: border-box;',
    '}',
    '.cbtn:hover { background: rgba(15, 40, 80, 0.06); }',
    '.cbtn:focus-visible { outline: 2px solid rgba(45, 125, 210, 0.85); outline-offset: 1px; }',
    '.cbtn--go {',
    '  border-color: #2f7fd4;',
    '  background: #2f7fd4;',
    '  color: #ffffff;',
    '}',
    '.cbtn--go:hover { background: #2670bd; }',

    /* ---- 深色页面 ---- */
    '@media (prefers-color-scheme: dark) {',
    '  .box {',
    '    border-color: rgba(140, 175, 220, 0.26);',
    '    background: rgba(24, 30, 42, 0.97);',
    '    color: #cfe3f8;',
    '    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);',
    '  }',
    '  .ico { color: #a9bdd6; border-color: rgba(140, 175, 220, 0.3); }',
    /* 深色下也用实心高亮，但换成更亮的蓝，避免在深底上发闷 */
    '  :host([data-status="on"]) .box {',
    '    border-color: #3d8fe0;',
    '    background: #2f7fd4;',
    '    color: #ffffff;',
    '    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.55);',
    '  }',
    '  :host([data-status="on"]) .ico { color: #2f7fd4; background: #ffffff; border-color: #ffffff; }',
    '  :host([data-status="on"]) .label { color: #ffffff; }',
    '  :host([data-status="busy"]) .ico { border-color: rgba(110, 175, 240, 0.55); color: #8ec0f2; }',
    '  .tool { color: #9fb2c8; }',
    '  .tool:hover { background: rgba(140, 175, 220, 0.14); color: #cfe3f8; }',
    '  .menu, .guide {',
    '    border-color: rgba(140, 175, 220, 0.28);',
    '    background: rgba(24, 30, 42, 0.99);',
    '    color: #cfe3f8;',
    '    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.6);',
    '  }',
    '  .guide::after {',
    '    background: rgba(24, 30, 42, 0.99);',
    '    border-color: rgba(140, 175, 220, 0.28);',
    '  }',
    '  .guide__t { color: #e6f0fb; }',
    '  .guide__b { color: #a9bdd6; }',
    '  .menu__i { color: #cfe3f8; }',
    '  .menu__i:hover { background: rgba(140, 175, 220, 0.14); }',
    '  .menu__sep { background: rgba(140, 175, 220, 0.2); }',
    '  .confirm {',
    '    border-color: rgba(140, 175, 220, 0.28);',
    '    background: rgba(24, 30, 42, 0.99);',
    '    color: #cfe3f8;',
    '    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6);',
    '  }',
    '  .cbtn { color: #cfe3f8; border-color: rgba(140, 175, 220, 0.3); }',
    '  .cbtn:hover { background: rgba(140, 175, 220, 0.14); }',
    '}',

    /* ---- 打印：控件不是内容，一律隐藏（不影响译文块） ---- */
    '@media print { :host { display: none !important; } }'
  ].join('\n');

  var SVG_GEAR =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">'
    + '<circle cx="8" cy="8" r="2.3" fill="none" stroke="currentColor" stroke-width="1.3"/>'
    + '<path d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6'
    + 'M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1"'
    + ' fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

  var SVG_FOLD =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">'
    + '<path d="M3.5 8h9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

  var SVG_UNFOLD =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">'
    + '<path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

  /** 「更多」：三个点。比齿轮更能表达「这里还有别的」，因为它不预设那些是什么 */
  var SVG_MORE =
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">'
    + '<circle cx="3.2" cy="8" r="1.35" fill="currentColor"/>'
    + '<circle cx="8" cy="8" r="1.35" fill="currentColor"/>'
    + '<circle cx="12.8" cy="8" r="1.35" fill="currentColor"/></svg>';

  var SVG_BLOCK =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">'
    + '<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.4"/>'
    + '<path d="M4.2 4.2l7.6 7.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

  var SVG_EYE_OFF =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">'
    + '<path d="M2.2 8s2.3-3.6 5.8-3.6S13.8 8 13.8 8s-2.3 3.6-5.8 3.6S2.2 8 2.2 8z"'
    + ' fill="none" stroke="currentColor" stroke-width="1.3"/>'
    + '<path d="M3 3l10 10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

  var MENU_ICONS = { gear: SVG_GEAR, block: SVG_BLOCK, 'eye-off': SVG_EYE_OFF, fold: SVG_FOLD };

  /* ================================================================
   * 宿主加固
   * ----------------------------------------------------------------
   * Shadow DOM 挡的是「我们的样式出不去」，挡不住「站点的样式进不来命中
   * 宿主本身」。站点一句 `body > div { display: none }` 或
   * `* { box-sizing: border-box }` 就能让控件消失或错位。
   * 行内样式带 !important 是唯一在级联里稳赢的位置，所以定位相关的属性
   * 全部走这里；视觉表现仍交给 Shadow 内的样式表。
   * ================================================================ */

  var HARDENED = {
    position: 'fixed',
    display: 'block',
    margin: '0',
    padding: '0',
    border: '0',
    'background-color': 'transparent',
    'background-image': 'none',
    'box-shadow': 'none',
    transform: 'none',
    filter: 'none',
    opacity: '1',
    visibility: 'visible',
    'pointer-events': 'auto',
    overflow: 'visible',
    float: 'none',
    clear: 'none',
    'min-width': '0',
    'min-height': '0',
    'max-width': 'none',
    'max-height': 'none',
    width: 'auto',
    height: 'auto',
    'box-sizing': 'content-box',
    'font-size': 'initial',
    'line-height': 'initial',
    'text-align': 'initial',
    // 有些站点给 body 加 transform，会让 fixed 相对 body 定位
    'will-change': 'auto'
  };

  function hardenHost(host) {
    for (var k in HARDENED) {
      if (!Object.prototype.hasOwnProperty.call(HARDENED, k)) continue;
      host.style.setProperty(k, HARDENED[k], 'important');
    }
    host.style.setProperty('z-index', String(Z_INDEX), 'important');
  }

  /* ================================================================
   * 挂载
   * ================================================================ */

  var handle = null;

  function isMounted() {
    return !!(handle && handle.host && handle.host.isConnected);
  }

  /**
   * @param {object} opts
   *   onToggle()      用户点主按钮 → 编排层决定实际结果
   *   onMore(id)      用户点了「更多」菜单里的某条
   *                   id ∈ 'never' | 'options' | 'hide'（'collapse' 由控件自理）
   *   onCollapse(v)   收起态变化
   *   onUnblock()     黑名单确认里点「移出并翻译」
   *   onCancel()      黑名单确认里点「取消」
   *   collapsed       初始收起态
   *   mark            图标位文字（目标语言标记），默认「译」
   *   guideSeen       是否已经看过引导气泡（看过就不再弹）
   */
  function mount(opts) {
    opts = opts || {};
    if (isMounted()) return handle;

    var doc = root.document;
    if (!doc || !doc.body) return null;

    var host = doc.createElement('div');
    host.className = CLASS;
    // 双保险防自噬：采集阶段靠这两个属性整块跳过（detector 原生支持）
    host.setAttribute('data-ct-skip', 'widget');
    host.setAttribute('translate', 'no');
    host.setAttribute('data-status', 'off');
    host.setAttribute('data-collapsed', '0');
    hardenHost(host);

    var shadow = host.attachShadow({ mode: 'open' });

    var style = doc.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    var box = doc.createElement('div');
    box.className = 'box';

    var mainBtn = doc.createElement('button');
    mainBtn.type = 'button';
    mainBtn.className = 'main';
    mainBtn.setAttribute('aria-pressed', 'false');
    // 图标在文案之前 —— 读起来是「[中] 翻译此页」，
    // 先知道翻成什么语言，再知道这个按钮干什么。
    mainBtn.innerHTML = '<span class="ico" aria-hidden="true">' + DEFAULT_MARK + '</span>'
      + '<span class="label"></span>'
      + '<span class="dot" aria-hidden="true"></span>';

    var tools = doc.createElement('div');
    tools.className = 'tools';

    var btnMore = doc.createElement('button');
    btnMore.type = 'button';
    btnMore.className = 'tool tool--more';
    btnMore.setAttribute('aria-haspopup', 'menu');
    btnMore.setAttribute('aria-expanded', 'false');
    btnMore.setAttribute('aria-label', '更多操作');
    btnMore.title = '更多操作';
    btnMore.innerHTML = SVG_MORE;

    tools.appendChild(btnMore);
    box.appendChild(mainBtn);
    box.appendChild(tools);
    shadow.appendChild(box);

    /* ---- 更多菜单 ---- */
    var menu = doc.createElement('div');
    menu.className = 'menu';
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '更多操作');

    var menuButtons = {};
    for (var mi = 0; mi < MENU_ITEMS.length; mi++) {
      var item = MENU_ITEMS[mi];
      if (item.sep) {
        var sep = doc.createElement('div');
        sep.className = 'menu__sep';
        menu.appendChild(sep);
      }
      var mb = doc.createElement('button');
      mb.type = 'button';
      mb.className = 'menu__i menu__i--' + item.id;
      mb.setAttribute('role', 'menuitem');
      mb.innerHTML = (MENU_ICONS[item.icon] || '') + '<span>' + item.text + '</span>';
      menu.appendChild(mb);
      menuButtons[item.id] = mb;
    }
    shadow.appendChild(menu);

    /* ---- 首次引导气泡 ----
       这一段是「不易察觉如何使用」的正解：用户装完扩展、页面上凭空多出
       一个胶囊，必须有东西告诉他这是什么、能拖、还有别的入口。
       只在第一次出现，点掉之后不再打扰。 */
    var guide = doc.createElement('div');
    guide.className = 'guide';
    guide.hidden = true;
    guide.setAttribute('role', 'dialog');
    guide.setAttribute('aria-label', '叠译使用提示');
    guide.innerHTML =
      '<p class="guide__t">叠译已就绪</p>'
      + '<p class="guide__b">点左边那颗按钮，就能把本页翻成<b class="guide__lang"></b>；'
      + '再点一次回到原文。胶囊可以拖到任意位置，「⋯」里还有更多选项。</p>'
      // v1.7.5（C-17 F3）：体验官实测纠错功能对新用户零曝光（UX-03），补一句
      // C-51（2026-09-29）：图标从「改」改为铅笔「✎」，引导文案同步（页面零「改」字）
      + '<p class="guide__b">遇到错译？把鼠标放到译文上，点铅笔图标就能修正。</p>'
      + '<div class="guide__acts">'
      + '<button type="button" class="cbtn cbtn--ok">知道了</button>'
      + '</div>';
    shadow.appendChild(guide);

    var confirm = doc.createElement('div');
    confirm.className = 'confirm';
    confirm.hidden = true;
    confirm.setAttribute('role', 'dialog');
    confirm.setAttribute('aria-label', '本站不翻译确认');
    confirm.innerHTML =
      '<p class="confirm__t"></p>'
      + '<div class="confirm__acts">'
      + '<button type="button" class="cbtn cbtn--go"></button>'
      + '<button type="button" class="cbtn cbtn--cancel"></button>'
      + '</div>';
    shadow.appendChild(confirm);

    host.style.setProperty('position', 'fixed', 'important');
    (doc.body || doc.documentElement).appendChild(host);

    var st = {
      status: 'off',
      collapsed: !!opts.collapsed,
      busyText: '',
      blocked: false,
      confirmMode: null,
      menuOpen: false,
      guideOpen: false,
      guideSeen: !!opts.guideSeen,
      mark: opts.mark || DEFAULT_MARK,
      targetLabel: opts.targetLabel || '',
      /* C-44（v1.7.7）：终态闪现（「已译 N 段」在 label 上站 3.2s 再回落）。
       * 状态一体化设计（docs/UX设计结论-状态一体化-2026-09-29.md）：
       * 开关是状态中心，成功终态本来就是「翻译此页 → 翻译中 → 显示原文」
       * 状态机的一站，不再绕道右下角徽标。flash 活跃时 label 优先显示它。 */
      flash: null
    };
    var pos = defaultPos();
    var saveTimer = null;

    var elConfirmText = confirm.querySelector('.confirm__t');
    var elConfirmGo = confirm.querySelector('.cbtn--go');
    var elConfirmCancel = confirm.querySelector('.cbtn--cancel');
    var elGuideOk = guide.querySelector('.cbtn--ok');
    var elGuideLang = guide.querySelector('.guide__lang');
    var elIco = box.querySelector('.ico');
    var elLabel = box.querySelector('.label');

    /* ---------------- 位置 ---------------- */

    function applyPosition() {
      var vp = viewport();
      var gap = gapFor(vp.vw);
      var sideProp = pos.side === 'right' ? 'right' : 'left';
      var otherProp = pos.side === 'right' ? 'left' : 'right';

      host.style.removeProperty(otherProp);
      host.style.setProperty(sideProp, gap + 'px', 'important');

      if (pos.bottom) {
        host.style.removeProperty('top');
        host.style.setProperty('bottom', gap + 'px', 'important');
      } else {
        host.style.removeProperty('bottom');
        var max = Math.max(CLAMP_GAP, vp.vh - 48);
        var y = Math.min(Math.max(CLAMP_GAP, pos.y), max);
        host.style.setProperty('top', y + 'px', 'important');
      }
    }

    /*
     * 界面状态统一走一个写入口。
     * 之前位置与收起态各写各的，加一个 guideSeen 就必然出现
     * 「拖完位置把 guideSeen 覆盖掉」这类静默丢字段 —— 键是同一个对象。
     *
     * 初值取 opts.guideSeen：编排层已经从设置里读到「用户看过引导」时，
     * 不必再等一次存储往返才决定要不要弹。这里如果漏掉，opts 传进来的
     * 值会被静默丢弃，气泡照弹 —— 而调用方完全看不出来。
     */
    var uiState = { guideSeen: !!opts.guideSeen };

    function writeUI() {
      var payload = {};
      payload[UI_KEY] = {
        side: pos.side,
        y: Math.round(pos.y),
        bottom: pos.bottom,
        collapsed: st.collapsed,
        guideSeen: !!uiState.guideSeen
      };
      safeSet(payload);
    }

    function persistPos() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        saveTimer = null;
        writeUI();
      }, 260);
    }

    /** 拖动结束后吸附到较近的一条竖直边 */
    function snap() {
      var vp = viewport();
      var rect = host.getBoundingClientRect();
      if (!rect || !rect.width) { applyPosition(); return; }

      var cx = rect.left + rect.width / 2;
      pos.side = vp.vw > 0 && cx < vp.vw / 2 ? 'left' : 'right';
      var maxY = Math.max(CLAMP_GAP, vp.vh - rect.height - CLAMP_GAP);
      pos.y = Math.min(Math.max(CLAMP_GAP, rect.top), maxY);
      pos.bottom = false;
      applyPosition();
      persistPos();
    }

    /* ---------------- 渲染 ---------------- */

    function render() {
      host.setAttribute('data-status', st.status);
      host.setAttribute('data-collapsed', st.collapsed ? '1' : '0');

      var lb = LABELS[st.status] || LABELS.off;
      // C-44：flash 活跃时优先（终态闪现），否则 busy 显示进度、其余显示状态词
      elLabel.textContent = st.flash && st.flash.text
        ? st.flash.text
        : (st.busyText && st.status === 'busy' ? st.busyText : lb.text);
      // 图标＝目标语言标记。多语言互译下，它承担了「点下去会变成什么语言」
      // 这个信息 —— 光看「翻译此页」是不知道翻成哪国话的。
      elIco.textContent = st.mark || DEFAULT_MARK;

      // 无障碍名称把动作与目标语言一起说清楚，读屏用户拿到的信息不比视觉用户少
      var fullAria = lb.aria + (st.mark && st.mark !== DEFAULT_MARK ? '（' + st.mark + '）' : '');
      mainBtn.setAttribute('aria-label', fullAria);
      mainBtn.title = fullAria;
      // aria-pressed 只表达「开 / 未开」；翻译中与不可译都算未开
      mainBtn.setAttribute('aria-pressed', st.status === 'on' ? 'true' : 'false');
      mainBtn.setAttribute('aria-disabled', st.status === 'unavailable' ? 'true' : 'false');

      menu.hidden = !st.menuOpen;
      btnMore.setAttribute('aria-expanded', st.menuOpen ? 'true' : 'false');
      // 收起态下菜单里的「收起为圆点」要反过来变成「展开为胶囊」
      if (menuButtons.collapse) {
        menuButtons.collapse.querySelector('span').textContent =
          st.collapsed ? '展开为完整按钮' : '收起为圆点';
      }

      guide.hidden = !st.guideOpen;
      // 引导文案里点名目标语言 ——「翻成简体中文」比「翻成目标语言」有用得多，
      // 后者等于把「我不知道你的设置」写在了脸上。
      if (elGuideLang) elGuideLang.textContent = st.targetLabel || '中文';

      confirm.hidden = !st.confirmMode;
      if (st.confirmMode === 'blocked') {
        elConfirmText.textContent = '本站已在「不翻译的站点」名单里。要移出并翻译本页吗？';
        elConfirmGo.textContent = '移出并翻译';
        elConfirmCancel.textContent = '取消';
      }
    }

    /**
     * 三个悬浮层（菜单 / 引导 / 确认）互斥：同时冒出两个会显得很吵。
     * ------------------------------------------------------------------
     * v1.7 起这里有了一层外部依赖：页面上还多了划词气泡与图片菜单，
     * 它们出现在**页面任意位置**，与这三个不是同一批 DOM，靠局部状态管不了。
     * 所以「当前谁是展开的浮层」这件事收拢到 CT.layers 统一持有，
     * 这里只做本地状态的收起。
     *
     * release 是「只释放自己」的语义：若当前持有者是划词气泡，
     * 这里的 release('menu') 不会误伤它。
     */
    function closeOverlays(except) {
      if (except !== 'menu') { CT.layers.release('menu'); st.menuOpen = false; }
      if (except !== 'guide') { CT.layers.release('guide'); st.guideOpen = false; }
      if (except !== 'confirm') { CT.layers.release('confirm'); st.confirmMode = null; }
    }

    /* ---------------- 事件 ---------------- */

    var dragging = false;
    var dragMoved = false;
    var dragStart = null;
    var suppressClick = false;

    function onPointerDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      if (!e.isPrimary && e.isPrimary !== undefined) return;
      dragging = true;
      dragMoved = false;
      var rect = host.getBoundingClientRect();
      dragStart = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
      try { mainBtn.setPointerCapture(e.pointerId); } catch (err) { /* 老浏览器忽略 */ }
    }

    function onPointerMove(e) {
      if (!dragging || !dragStart) return;
      var dx = e.clientX - dragStart.x;
      var dy = e.clientY - dragStart.y;
      if (!dragMoved && Math.abs(dx) + Math.abs(dy) < DRAG_SLOP) return;
      dragMoved = true;

      // 拖动期间改为绝对坐标，避免 right/bottom 与指针方向拧着来
      host.style.removeProperty('right');
      host.style.removeProperty('left');
      host.style.removeProperty('bottom');
      host.style.setProperty('left', (dragStart.left + dx) + 'px', 'important');
      host.style.setProperty('top', (dragStart.top + dy) + 'px', 'important');
      host.style.setProperty('cursor', 'grabbing', 'important');
    }

    function onPointerUp(e) {
      if (!dragging) return;
      dragging = false;
      host.style.removeProperty('cursor');
      try { mainBtn.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }

      if (!dragMoved) return;
      // 拖过的这一次不当点击：否则用户想挪位置，结果顺手把翻译关了
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 0);
      snap();
      dragStart = null;
    }

    function onMainClick() {
      if (suppressClick) return;
      if (st.confirmMode) { setConfirm(null); return; }
      // 点主按钮 = 用户已经明白了这东西怎么用 → 引导气泡的使命结束
      dismissGuide(true);
      if (st.status === 'unavailable') return;
      if (typeof opts.onToggle === 'function') opts.onToggle();
    }

    mainBtn.addEventListener('pointerdown', onPointerDown);
    mainBtn.addEventListener('pointermove', onPointerMove);
    mainBtn.addEventListener('pointerup', onPointerUp);
    mainBtn.addEventListener('pointercancel', onPointerUp);
    mainBtn.addEventListener('click', onMainClick);
    // 拖动时不要触发浏览器原生 drag（图片/链接拖影会盖住控件）
    mainBtn.addEventListener('dragstart', function (e) { e.preventDefault(); });

    /* ---------------- 更多菜单 ---------------- */

    function toggleMenu(open) {
      var next = open === undefined ? !st.menuOpen : !!open;
      if (next) {
        closeOverlays('menu');
        // 向仲裁器申请展开权。被更高优先级的浮层占着（比如用户刚划完词、
        // 气泡还在）就直接不开 —— 而不是把对方挤掉。
        if (!CT.layers.acquire('menu', function () { st.menuOpen = false; render(); })) return;
      } else {
        CT.layers.release('menu');
      }
      st.menuOpen = next;
      render();
      if (next) {
        var first = menuButtons.never || menuButtons.options;
        try { (first || btnMore).focus(); } catch (e) { /* 忽略 */ }
      }
    }

    btnMore.addEventListener('click', function () { toggleMenu(); });

    function onMenuAction(id) {
      toggleMenu(false);
      if (id === 'collapse') {
        st.collapsed = !st.collapsed;
        render();
        snap();
        if (typeof opts.onCollapse === 'function') opts.onCollapse(st.collapsed);
        return;
      }
      if (typeof opts.onMore === 'function') opts.onMore(id);
    }

    for (var mk in menuButtons) {
      if (!Object.prototype.hasOwnProperty.call(menuButtons, mk)) continue;
      /* 闭包捕获：用 IIFE 把 mk 固化成参数，否则事件回调里读到的是最后一个键 */
      (function (id) {
        menuButtons[id].addEventListener('click', function () { onMenuAction(id); });
      })(mk);
    }

    // 点菜单之外的任何地方都要收起它 —— 否则它会一直挂在那儿挡住页面
    doc.addEventListener('pointerdown', function (e) {
      if (!st.menuOpen) return;
      var path = e.composedPath ? e.composedPath() : [];
      if (path.indexOf(host) >= 0 || path.indexOf(menu) >= 0) return;
      toggleMenu(false);
    }, true);

    /* ---------------- 引导气泡 ---------------- */

    function dismissGuide(persist) {
      if (!st.guideOpen) return;
      st.guideOpen = false;
      uiState.guideSeen = true;
      st.guideSeen = true;
      render();
      if (persist) writeUI();
    }

    /** 首次使用：把引导气泡亮出来（已看过就不再打扰） */
    function maybeShowGuide() {
      if (uiState.guideSeen) return;
      // 引导是所有浮层里优先级最低的（PRIORITY.guide = 1），
      // 任何别的东西在展开时都轮不到它 —— 这正是想要的：引导不该打断用户
      if (!CT.layers.acquire('guide', function () { st.guideOpen = false; render(); })) return;
      st.guideOpen = true;
      render();
    }

    elGuideOk.addEventListener('click', function () { dismissGuide(true); });

    /* ---------------- 黑名单确认 ---------------- */

    elConfirmGo.addEventListener('click', function () {
      setConfirm(null);
      if (typeof opts.onUnblock === 'function') opts.onUnblock();
    });

    elConfirmCancel.addEventListener('click', function () {
      setConfirm(null);
      if (typeof opts.onCancel === 'function') opts.onCancel();
    });

    // Esc 关闭最上层的那个悬浮层
    shadow.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (st.confirmMode) { e.stopPropagation(); setConfirm(null); return; }
      if (st.menuOpen) { e.stopPropagation(); toggleMenu(false); return; }
      if (st.guideOpen) { e.stopPropagation(); dismissGuide(true); return; }
    });

    function setConfirm(mode) {
      // 与菜单、引导互斥，避免三块浮层叠在一起
      if (mode) {
        closeOverlays('confirm');
        // confirm 优先级 3，高于 menu(2) 与 guide(1)：拉黑站点的确认条
        // 必须能压过用户随手点开的菜单。
        // 但低于划词气泡(5) —— 不会把刚弹出来的译文顶掉。
        if (!CT.layers.acquire('confirm', function () { st.confirmMode = null; render(); })) {
          st.confirmMode = null;
          render();
          return;
        }
      } else {
        CT.layers.release('confirm');
      }
      st.confirmMode = mode;
      render();
      if (mode) {
        var btn = mode === 'blocked' ? elConfirmGo : elConfirmCancel;
        try { btn.focus(); } catch (e) { /* 忽略 */ }
      } else {
        try { mainBtn.focus(); } catch (e) { /* 忽略 */ }
      }
    }

    /* ---------------- 装配 ---------------- */

    render();
    applyPosition();

    // 首次挂载时避开站点自己的右下角浮层（回到顶部 / 客服气泡 / Cookie 条）。
    // 用 setTimeout 推迟一拍：此刻本控件刚进 DOM，站点浮层可能还没挂上。
    setTimeout(function () {
      if (!isMounted() || pos.bottom !== true) return;
      var vp = viewport();
      var next = avoidClash(pos, vp.vw, vp.vh);
      if (next.y !== pos.y) { pos = next; applyPosition(); }
    }, 600);

    handle = {
      host: host,
      shadow: shadow,
      mainButton: mainBtn,
      moreButton: btnMore,
      menu: menu,
      guide: guide,
      status: function () { return st.status; },
      collapsed: function () { return st.collapsed; },
      menuOpen: function () { return st.menuOpen; },
      guideOpen: function () { return st.guideOpen; },
      position: function () { return { side: pos.side, y: pos.y, bottom: pos.bottom }; },
      setCollapsed: function (v) { st.collapsed = !!v; render(); applyPosition(); persistPos(); },
      showConfirm: function (mode) { setConfirm(mode || null); },
      openMenu: function (v) { toggleMenu(v); },
      showGuide: function () { maybeShowGuide(); },
      dismissGuide: dismissGuide,
      update: update,
      destroy: destroy,
      // 内部状态与重绘入口：update() 通过它们改写闭包状态，
      // 保证「状态只有一份」，不会出现 handle 与闭包各持一套而不同步
      _st: st,
      _render: render,
      _applyPosition: applyPosition
    };

    // 先把位置落一次盘，让「默认位」也成为可比较的基线；
    // 但只有用户真正拖动过才写入，避免每次开页都写一次存储。
    safeGet(UI_KEY, null).then(function (saved) {
      if (!handle || !isMounted()) return;
      if (saved) {
        pos = normalizePos(saved);
        if (saved.collapsed !== undefined) st.collapsed = !!saved.collapsed;
        // 取「或」而不是直接赋值：存储里没有记录（老版本写下的位置）时，
        // 不能把调用方明确告诉我们的「已看过」抹掉。
        uiState.guideSeen = !!(saved.guideSeen || uiState.guideSeen);
        applyPosition();
        render();
      }
      // 引导气泡只在这一步之后决定是否展示：先把位置记忆读回来，
      // 免得「先弹气泡、再被位置恢复打断」产生一次视觉抖动。
      maybeShowGuide();
    });

    return handle;
  }

  /**
   * 更新控件视觉状态。
   * @param {object} next
   *   status    'off' | 'busy' | 'on' | 'unavailable'
   *   busyText  status=busy 时主按钮上的进度文案，例如 '12 / 130'
   *   confirm   null | 'blocked'
   *   collapsed 收起态
   *   mark      图标位的目标语言标记（中 / 繁 / EN / 日…）。
   *             目标语言一改，图标就跟着变 —— 这是「翻成什么语言」的唯一视觉线索。
   *   targetLabel 目标语言全名，只在引导气泡里用
   */
  function update(next) {
    if (!isMounted()) return;
    var cur = handle._st;
    if (!cur) return;

    if (next && next.status && LABELS[next.status]) cur.status = next.status;
    if (next && typeof next.busyText === 'string') cur.busyText = next.busyText;
    if (next && next.confirm !== undefined) {
      cur.confirmMode = next.confirm || null;
      // update() 是绕过 setConfirm() 的直写通道（编排层用它推「黑名单冲突」）。
      // 互斥逻辑必须在这里也走一遍，否则会出现「菜单开着的同时弹确认条」——
      // 两块浮层叠在同一个位置，谁也点不到。
      if (cur.confirmMode) { cur.menuOpen = false; cur.guideOpen = false; }
    }
    if (next && next.collapsed !== undefined) cur.collapsed = !!next.collapsed;
    if (next && typeof next.mark === 'string' && next.mark) cur.mark = next.mark;
    if (next && typeof next.targetLabel === 'string' && next.targetLabel) cur.targetLabel = next.targetLabel;

    /* C-44：终态闪现。flashText 到来 → 站上 label flashMs 毫秒后回落；
     * 新 flash 覆盖旧 flash（计时器重置）。传 flashText:'' 显式清除。
     * 注意 update() 在 mount 作用域外：计时器挂在 st（handle._st）上，
     * 重绘走 handle._render() —— 与本函数既有模式一致。 */
    if (next && next.flashText !== undefined) {
      if (cur.flashTimer) { clearTimeout(cur.flashTimer); cur.flashTimer = null; }
      cur.flash = null;
      if (next.flashText) {
        cur.flash = { text: String(next.flashText) };
        cur.flashTimer = setTimeout(function () {
          cur.flashTimer = null;
          cur.flash = null;
          if (handle) handle._render();
        }, Math.max(400, next.flashMs || 3200));
      }
    }

    handle._render();
    handle._applyPosition();
  }

  function destroy() {
    if (!handle) return false;
    // C-44：闪现计时器随控件销毁清理（防孤儿回调摸已卸载的 DOM）。
    // destroy 在 mount 作用域外，经由 handle._st 拿计时器。
    try {
      var st0 = handle._st;
      if (st0 && st0.flashTimer) { clearTimeout(st0.flashTimer); st0.flashTimer = null; }
      if (st0) st0.flash = null;
    } catch (e) { /* 忽略 */ }
    // 把本控件的三个浮层从仲裁器里释放掉。
    // 不释放的话，新实例接管后仲裁器还以为「菜单开着」，
    // 于是拒绝展开任何浮层 —— 表现为「控件点了没反应」。
    try {
      CT.layers.release('menu');
      CT.layers.release('guide');
      CT.layers.release('confirm');
    } catch (e) { /* 忽略 */ }
    try {
      if (handle.host && handle.host.parentNode) handle.host.parentNode.removeChild(handle.host);
    } catch (e) { /* 页面已卸载 */ }
    handle = null;
    return true;
  }

  CT.toggle = {
    CLASS: CLASS,
    UI_KEY: UI_KEY,
    Z_INDEX: Z_INDEX,
    LABELS: LABELS,
    MENU_ITEMS: MENU_ITEMS,
    DEFAULT_MARK: DEFAULT_MARK,
    mount: mount,
    update: update,
    destroy: destroy,
    isMounted: isMounted,
    /* ---- 以下为可独立断言的纯逻辑 ---- */
    defaultPos: defaultPos,
    normalizePos: normalizePos,
    _cornerOccupied: cornerOccupied,
    _avoidClash: avoidClash,
    _gapFor: gapFor,
    _hardenKeys: Object.keys(HARDENED)
  };
})(typeof self !== 'undefined' ? self : this);
