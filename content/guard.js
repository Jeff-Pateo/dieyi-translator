/*
 * 叠译 · 重复注入守卫
 * ------------------------------------------------------------------
 * 同一个页面上，内容脚本可能被注入多次：
 *   · 用户点右键菜单「翻译此页面」时，background 的兜底链会 executeScript 一次
 *   · 扩展安装 / 更新后，background 会对所有已打开标签页主动补注入一次
 *   · popup 在内容脚本尚未就绪时也会走同一条兜底链
 * 重复执行必须幂等 —— 否则页面上会挂着两份 MutationObserver、两套定时器、
 * 两个页内开关，翻译请求也会翻倍。
 *
 * 但「幂等」的老写法有一个致命缺陷。它把两件事混为一谈：
 *
 *     if (window.__CT_BOOTED__) return;      // 旧实现
 *     window.__CT_BOOTED__ = true;
 *
 * 这一行只回答了「这个页面被注入过吗」，没有回答「注入的是哪个版本」以及
 * 「那个实例现在还活着吗」。扩展【更新】之后，页面里那个布尔值还挂在那里，
 * 而旧实例的活动上下文已经在更新时被 Chrome 作废（此后它调用任何 chrome.*
 * 都会抛 "Extension context invalidated"）。于是：
 *
 *     新版本脚本被旧标记拦在门外 → 不初始化
 *     旧版本实例调用 chrome.* 全失败 → 不翻译
 *     页面永久卡在中间态，既不自愈也无法解释，只能靠用户手动刷新
 *
 * 这就是「更新后必须刷新页面」的第二处根因，也是更隐蔽的一处：补注入链路
 * 明明成功了，症状却和「根本没修」一模一样。
 *
 * 所以守卫必须同时掌握两件事：打了标记的是哪个版本、那个实例是否还活着。
 *   · 版本相同且实例存活  → 重复注入，直接退出（幂等）
 *   · 版本不同或实例失活  → 接管：先让旧实例退场，再正常初始化
 *
 * 本模块只做纯判定与 DOM 清理，不碰 chrome.*、不建立任何监听，
 * 因此可以脱离浏览器直接断言。真正的「退场动作」（停观察器、卸控件）
 * 由 content.js 提供，并以 window.__CT_TEARDOWN__ 的形式交换。
 */
(function (root) {
  'use strict';

  var CT = (root.CT = root.CT || {});

  /** 标记本实例身份的全局键 */
  var BOOTED_KEY = '__CT_BOOTED__';
  /** 退场钩子的全局键（旧实例写给新实例调用） */
  var TEARDOWN_KEY = '__CT_TEARDOWN__';

  /**
   * 需要清理的「孤儿浮层」选择器。
   * ------------------------------------------------------------------
   * 刻意【不含】.ct-trans —— 译文块不清理。
   * 旧实例渲染出的译文是有效内容，清掉会让页面先闪回英文再重译一遍，
   * 观感比留着更糟；而且 renderer 的还原逻辑本来就带类名兜底，
   * 能识别并管理这些「不是本实例登记的」译文块。
   * 这里只清徽标与悬停浮层：它们是瞬时 UI，脱离实例后只会变成垃圾。
   *
   * ★ C-28（2026-09-28）：把 .ct-toggle 补进来。
   * ------------------------------------------------------------------
   * 页内开关的宿主同样是「脱离实例就没有意义」的 UI，为什么当初没列进来？
   * 因为它在正常路径上由 teardown() 里的 state.toggle.destroy() 摘掉 ——
   * 但正常路径之外还有两种情形：
   *   ① 旧实例的 teardown 抛错（destroy 内部异常被 try/catch 吞掉），
   *      宿主留在 DOM 里，state.toggle 却已置 null；
   *   ② 新实例走的是 fresh 分支（== 页面里没有任何标记）时，压根不调 clearOrphans。
   * 结果是**孤儿胶囊精确地叠在新胶囊上面**（toggle 的冲突避让用
   * elementFromPoint 取样，命中自身一律视为「角落空闲」，所以自己从不避让自己），
   * 用户视觉上仍是一颗，但 DOM 里在累积、事件监听是双份。
   * 这类「重叠的重复实例」是最难被目视发现的一类缺陷，必须靠类名兜底清掉。
   */
  var ORPHAN_SELECTOR = '.ct-badge, .ct-tip, .ct-toggle';

  /**
   * 读取扩展版本号。
   * 取不到时返回 'unknown' —— 退化行为与旧版一致（不会比旧版更糟），
   * 真实 Chrome 环境下 getManifest() 一定可用。
   */
  function readVersion() {
    try {
      var m = chrome.runtime.getManifest();
      if (m && m.version) return String(m.version);
    } catch (e) {
      // 扩展上下文已失效（这正是「旧实例已死」的信号），或处于测试沙箱
    }
    return 'unknown';
  }

  /**
   * 决定新注入的实例该怎么做。
   *
   * @param {*} prev     页面上已有的 __CT_BOOTED__ 值（可能是布尔、对象或 undefined）
   * @param {string} version 本次注入脚本所属的扩展版本
   * @returns {'skip'|'takeover'|'fresh'}
   *   skip     —— 同版本且旧实例存活，本次注入直接退出
   *   takeover —— 存在旧标记但不可信（版本不同 / 已失活 / 是老式裸布尔），
   *               必须先让旧实例退场再初始化，否则就是永久死页
   *   fresh    —— 页面上没有任何标记，正常首次初始化
   */
  function decide(prev, version) {
    if (!prev) return 'fresh';

    // 老式裸布尔（或任何非对象值）：拿不到版本信息，一律当作不可信标记接管。
    // 这一条正是为了让「从旧版本升级上来」的页面不必刷新。
    if (typeof prev !== 'object') return 'takeover';

    if (prev.version !== version) return 'takeover';

    // 版本一致还不够：上一次初始化可能中途失败（alive 仍为 false），
    // 这时跳过就等于把页面锁死，所以只有明确存活才允许 skip。
    return prev.alive === true ? 'skip' : 'takeover';
  }

  /**
   * 清掉旧实例留下的孤儿浮层。
   * 新实例的模块级变量指向不到旧实例创建的节点，只能按类名从 DOM 上找。
   * @returns {number} 实际移除的节点数
   */
  function clearOrphans(doc) {
    var removed = 0;
    try {
      var list = doc.querySelectorAll(ORPHAN_SELECTOR);
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (el.parentNode) {
          el.parentNode.removeChild(el);
          removed++;
        }
      }
    } catch (e) {
      // 页面可能正在卸载，忽略
    }
    return removed;
  }

  /** 写入本实例标记。alive 由实例自己维护，默认视为已就绪。 */
  function markBooted(win, version) {
    win[BOOTED_KEY] = { version: String(version), alive: true };
  }

  /** 更新存活位。实例被接管或主动退场后置 false，允许后续注入重新接管。 */
  function markAlive(win, alive) {
    var cur = win[BOOTED_KEY];
    if (cur && typeof cur === 'object') {
      cur.alive = !!alive;
      return true;
    }
    return false;
  }

  /** 读取当前存活位（供排障与测试使用） */
  function isAlive(win) {
    var cur = win[BOOTED_KEY];
    return !!(cur && typeof cur === 'object' && cur.alive === true);
  }

  /** 取出旧实例登记的退场钩子；没有则返回 null */
  function takeTeardown(win) {
    var fn = win[TEARDOWN_KEY];
    return typeof fn === 'function' ? fn : null;
  }

  /** 登记本实例的退场钩子，供下一次注入调用 */
  function setTeardown(win, fn) {
    win[TEARDOWN_KEY] = fn;
  }

  CT.guard = {
    BOOTED_KEY: BOOTED_KEY,
    TEARDOWN_KEY: TEARDOWN_KEY,
    ORPHAN_SELECTOR: ORPHAN_SELECTOR,
    readVersion: readVersion,
    decide: decide,
    clearOrphans: clearOrphans,
    markBooted: markBooted,
    markAlive: markAlive,
    isAlive: isAlive,
    takeTeardown: takeTeardown,
    setTeardown: setTeardown
  };
})(typeof self !== 'undefined' ? self : this);
