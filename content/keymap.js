/*
 * 叠译 · 页内自定义快捷键
 * ------------------------------------------------------------------
 * 为什么需要这一层：
 *   chrome.commands 提供的全局快捷键（Alt+Shift+T / Alt+Shift+Y）确实更好用 ——
 *   页面不用聚焦也能触发。但 Chrome **不允许扩展程序化修改全局快捷键**，
 *   用户只能自己去 chrome://extensions/shortcuts 改。这是平台限制，不是能力缺失。
 *
 *   所以这里提供第二层：页内捕获。页面获得焦点时生效，绑定表由用户在设置页里定，
 *   存在 storage.sync 里随账号同步。两层各司其职，设置页也分别呈现。
 *
 * 与输入框的关系：
 *   在 <input> / <textarea> / contenteditable 里打字时【不劫持】——
 *   否则用户没法输入含 Alt 的字符，也打不出某些键盘布局下的组合键。
 *
 * comboOf / match 是纯函数，可以直接在 Node 里穷举断言，不需要浏览器。
 */
(function (root) {
  'use strict';

  var CT = (root.CT = root.CT || {});

  /** 纯修饰键自己不构成快捷键 */
  var MODIFIER_KEYS = { Control: 1, Alt: 1, Shift: 1, Meta: 1, AltGraph: 1, CapsLock: 1 };

  /**
   * 把 KeyboardEvent 归一化成可比较的组合串，如 'Alt+Shift+T'。
   * 顺序固定为 Ctrl → Alt → Shift → Meta，缺一不可写死 ——
   * 否则同一组键会因为有两条不同顺序的字符串而匹配不上。
   * @param {KeyboardEvent} e
   * @returns {string} 空串表示这不是一个有效的组合（纯修饰键、无 key）
   */
  function comboOf(e) {
    if (!e || !e.key) return '';
    var k = e.key;
    if (MODIFIER_KEYS[k]) return '';

    var parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Meta');

    // 单字符统一大写：按 Shift+A 时 key 是 'A'，不按是 'a'，
    // 而 shiftKey 已经体现在修饰键列表里，所以这里必须归一
    if (k.length === 1) k = k.toUpperCase();

    parts.push(k);
    return parts.join('+');
  }

  /**
   * 在绑定表里找命中的动作。
   * @param {Object} bindings  { action: combo }
   * @param {string} combo
   * @returns {string|null}
   */
  function match(bindings, combo) {
    if (!combo || !bindings) return null;
    var keys = Object.keys(bindings);
    for (var i = 0; i < keys.length; i++) {
      if (bindings[keys[i]] && bindings[keys[i]] === combo) return keys[i];
    }
    return null;
  }

  /** 把绑定表里与全局键冲突的项剔掉 —— 否则一次按键会触发两次 */
  function withoutReserved(bindings, reserved) {
    var out = {};
    var keys = Object.keys(bindings || {});
    for (var i = 0; i < keys.length; i++) {
      var combo = bindings[keys[i]];
      if (!combo) continue;
      if (reserved && reserved.indexOf(combo) >= 0) continue;
      out[keys[i]] = combo;
    }
    return out;
  }

  /** 当前焦点是否在可编辑区域 */
  function inEditable(target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    var tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  /**
   * 挂载页内快捷键。
   * @param {Function} getBindings  返回 { action: combo }
   * @param {Function} dispatch     收到动作名后执行
   * @param {string[]} [reserved]   需要避开的组合（来自 chrome.commands）
   * @returns {Function} detach
   */
  function attach(getBindings, dispatch, reserved) {
    function onKeydown(e) {
      if (e.defaultPrevented) return;
      if (inEditable(e.target)) return;

      var combo = comboOf(e);
      if (!combo) return;

      var bindings = withoutReserved(getBindings() || {}, reserved || []);
      var action = match(bindings, combo);
      if (!action) return;

      e.preventDefault();
      e.stopPropagation();
      try {
        dispatch(action);
      } catch (err) {
        if (root.console && console.warn) console.warn('[叠译] 页内快捷键执行失败：', err);
      }
    }

    document.addEventListener('keydown', onKeydown, true);
    return function detach() {
      document.removeEventListener('keydown', onKeydown, true);
    };
  }

  CT.keymap = {
    comboOf: comboOf,
    match: match,
    withoutReserved: withoutReserved,
    inEditable: inEditable,
    attach: attach,
    MODIFIER_KEYS: MODIFIER_KEYS
  };
})(typeof self !== 'undefined' ? self : this);
