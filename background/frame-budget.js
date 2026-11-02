/*
 * 叠译 · 每页 frame 配额
 * ------------------------------------------------------------------
 * frame 自评（content/frame-gate.js）挡掉的是「明显不是正文」的 frame。
 * 但真实页面里会有一批「面积够大、也有文字、但依然不值得翻」的 frame
 * （跨域评论区、嵌入的第三方文档、广告落地页预览）。
 *
 * 这一层是**兜底闸门**：按标签页统计已放行的 frame 数，超过上限就不再放行。
 * 名额满了之后不是简单拒绝，而是**按面积顶替** —— 面积更大的 frame 更可能是
 * 正文，让它挤掉当前最小的那个。这样即使配额很小，也能保证「最重要的那个
 * frame 一定在名单里」。
 *
 * 注意这里是纯内存状态（Map），不做持久化：frame 是页面级的瞬态资源，
 * 页面一关就没有意义了。service worker 被回收时这份状态会丢 —— 这是可接受的，
 * 重新放行只会多花一点翻译费用，不会出错。
 */
(function (root) {
  'use strict';

  var CT = (root.CT = root.CT || {});

  /** 每个标签页最多多少个非顶层 frame 参与翻译 */
  var MAX_FRAMES_PER_TAB = 20;

  /** tabId -> Map<frameId, {area: number, allowed: boolean}> */
  var tabs = new Map();

  function bucket(tabId) {
    var rec = tabs.get(tabId);
    if (!rec) {
      rec = new Map();
      tabs.set(tabId, rec);
    }
    return rec;
  }

  function countAllowed(rec) {
    var n = 0;
    rec.forEach(function (v) { if (v.allowed) n++; });
    return n;
  }

  /**
   * 申请一个 frame 的翻译额度。
   * @param {number} tabId
   * @param {number} frameId     顶层为 0
   * @param {number} area        frame 的可视面积（来自 content 侧的 frameGate.assess()）
   * @returns {boolean} 是否允许翻译
   */
  function admit(tabId, frameId, area) {
    if (frameId === 0 || frameId === undefined || frameId === null) {
      // 顶层永远是 0，且永远有额度 —— 用户打开这一页就是要翻这一页
      return true;
    }
    if (tabId === undefined || tabId === null) return true;

    var rec = bucket(tabId);
    var prev = rec.get(frameId);
    if (prev) {
      // 这个 frame 之前申请过：沿用上次结论，只把面积更新成观测到的较大值
      // （frame 被拉伸后面积会变大，但「要不要翻」不该因此反复翻转）
      prev.area = Math.max(prev.area, area || 0);
      return prev.allowed;
    }

    var allowed = countAllowed(rec) < MAX_FRAMES_PER_TAB;

    if (!allowed) {
      // 名额满：找当前最小的已放行者，面积更大才顶替
      var victimId = null;
      var victimArea = Infinity;
      rec.forEach(function (v, k) {
        if (v.allowed && v.area < victimArea) {
          victimArea = v.area;
          victimId = k;
        }
      });
      if (victimId !== null && (area || 0) > victimArea) {
        rec.get(victimId).allowed = false;
        allowed = true;
      }
    }

    rec.set(frameId, { area: area || 0, allowed: allowed });
    return allowed;
  }

  /** 标签页导航或关闭时清空 */
  function reset(tabId) {
    tabs.delete(tabId);
  }

  /** 统计，用于调试与上报 */
  function stats(tabId) {
    var rec = tabs.get(tabId);
    if (!rec) return { total: 0, allowed: 0, denied: 0 };
    var allowed = countAllowed(rec);
    return { total: rec.size, allowed: allowed, denied: rec.size - allowed };
  }

  /** 仅供测试 */
  function _reset() {
    tabs.clear();
  }

  CT.frameBudget = {
    admit: admit,
    reset: reset,
    stats: stats,
    MAX_FRAMES_PER_TAB: MAX_FRAMES_PER_TAB,
    _reset: _reset
  };
})(typeof self !== 'undefined' ? self : this);
