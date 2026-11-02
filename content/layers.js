/*
 * 叠译 · 浮层仲裁
 * ------------------------------------------------------------------
 * 页面上可能同时存在五类浮层：页内开关的菜单、首次引导气泡、黑名单确认条、
 * 划词气泡、图片右键菜单。它们分散在三个模块里，如果不集中仲裁，就会退化成
 * 「每个模块自己判断其他四个在不在」的 N² 组合，而且必然有漏判断的路径。
 *
 * 这里把「当前谁是展开的」收敛成**唯一一份状态**，任何模块开浮层都必须先申请。
 *
 * 与「抢占」的差别（这条是刻意的）：
 *   高优先级占用时，低优先级申请**被拒绝**而不是把对方挤掉。
 *   用户正在读黑名单确认条时划了一下词，不该把确认条顶掉 ——
 *   正确行为是「这次不弹气泡」，用户再划一次就正常了。
 */
(function (root) {
  'use strict';

  var CT = (root.CT = root.CT || {});

  /**
   * 登记顺序即优先级，数字大的在冲突中胜出。
   * 取值理由：
   *   guide 1  —— 一次性引导，最不紧急，任何东西都能把它挤掉
   *   menu  2  —— 用户主动点开的菜单，但可以重开
   *   learn 2.5 —— 个人词典确认卡（B2-1）。介于 menu 与 confirm 之间：
   *                可关可再触发（不属于「必须做完」），但比普通菜单更该被看到
   *   confirm 3 —— 涉及改设置（拉黑站点），必须做完
   *   tip   4  —— 悬停提示，轻量
   *   selection / imageMenu 5 —— 用户刚做的动作产生的反馈，最该被看到
   */
  var PRIORITY = {
    guide: 1,
    menu: 2,
    learn: 2.5,
    confirm: 3,
    tip: 4,
    selection: 5,
    imageMenu: 5
  };

  var open = null;          // { id, onClose } —— 当前展开者
  var listeners = [];

  function notify() {
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](open && open.id);
      } catch (e) {
        // 订阅者自己的异常不能扩散 —— 否则一个模块的 bug 会让仲裁器失去通知能力
        if (root.console && console.warn) console.warn('[叠译] layers 订阅者异常：', e);
      }
    }
  }

  /**
   * 申请展开。
   * @param {string} id  PRIORITY 里的键
   * @param {Function} [onClose]  被更高优先级挤掉时调用，用来真正把 DOM 收起来
   * @returns {boolean} 是否拿到展开权
   */
  function acquire(id, onClose) {
    if (open && open.id === id) {
      // 同一个浮层重复申请：刷新 onClose 引用即可，不触发通知，
      // 否则「重开同一个菜单」会先让订阅者收到一次关闭再收到一次打开
      if (onClose) open.onClose = onClose;
      return true;
    }

    if (open && (PRIORITY[open.id] || 0) > (PRIORITY[id] || 0)) {
      return false;
    }

    var victim = open;
    open = { id: id, onClose: onClose || null };

    if (victim && victim.onClose) {
      try {
        victim.onClose();
      } catch (e) {
        if (root.console && console.warn) console.warn('[叠译] 关闭上一浮层失败：', e);
      }
    }

    notify();
    return true;
  }

  /** 主动释放。只有当前持有者能释放自己 —— 避免 A 把 B 的浮层关掉 */
  function release(id) {
    if (!open || open.id !== id) return;
    open = null;
    notify();
  }

  /** 是否正被指定浮层占用 */
  function isOpen(id) {
    return !!(open && open.id === id);
  }

  /**
   * 关掉所有浮层（保留 except）。
   * 用于：整页翻译开始、页面滚动、按 Esc、切换页面模式。
   */
  function closeAll(except) {
    if (!open || open.id === except) return;
    var victim = open;
    open = null;
    if (victim.onClose) {
      try {
        victim.onClose();
      } catch (e) {
        if (root.console && console.warn) console.warn('[叠译] 关闭浮层失败：', e);
      }
    }
    notify();
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  /** 当前展开者的 id（无则 null） */
  function current() {
    return open ? open.id : null;
  }

  /** 仅供测试：把状态清空，不做任何 onClose 回调 */
  function _reset() {
    open = null;
    listeners.length = 0;
  }

  CT.layers = {
    acquire: acquire,
    release: release,
    isOpen: isOpen,
    closeAll: closeAll,
    onChange: onChange,
    current: current,
    PRIORITY: PRIORITY,
    _reset: _reset
  };
})(typeof self !== 'undefined' ? self : this);
