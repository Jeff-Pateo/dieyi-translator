/*
 * 叠译 · frame 自我评估
 * ------------------------------------------------------------------
 * manifest 里把 all_frames 打开之后，本脚本会跑在**每一个**命中 matches 的
 * frame 里 —— 包括广告位、统计像素、评论插件、视频播放器。
 *
 * 实测规模：新闻站 10–30 个 iframe、电商详情页 20–50 个，而跨域广告 iframe
 * 的 URL 必然是 https://，**必然命中 matches**。所以「要不要翻译这个 frame」
 * 必须由 frame 自己先判断一次，把绝大多数无意义的 frame 挡在门外。
 *
 * 性能纪律（这条最重要）：
 *   只读 innerWidth / innerHeight / innerText —— 全部不触发样式重算。
 *   这里【绝不】调用 getComputedStyle。整页采集已经付过一次样式重算，
 *   而 frame 评估跑在每个 frame 里，成本会被 frame 数放大。
 */
(function (root) {
  'use strict';

  var CT = (root.CT = root.CT || {});

  /** 可视面积小于 8 万 px²（约 350×230）的 frame 基本不可能是正文 */
  var MIN_AREA = 80 * 1000;
  /** 可见文本少于 200 字符的 frame 不值得翻 —— 一个导航条、一个按钮不构成阅读需求 */
  var MIN_TEXT = 200;

  /** 广告容器特征。用启发式而不是黑名单 —— 广告域名列表永远不全 */
  var AD_SELECTOR = [
    'meta[name="ad.size"]',
    'ins.adsbygoogle',
    '[id^="google_ads_iframe"]',
    '[id^="aswift_"]',
    '[id^="dsq-"]',              // Disqus 评论（跨域，正文在父文档里通常也有）
    'iframe[name^="google_ads"]'
  ].join(',');

  /** 本脚本是否跑在顶层文档。跨域时访问 root.top 会抛，所以必须 try */
  function isTop() {
    try {
      return root.top === root;
    } catch (e) {
      return false;
    }
  }

  /** 读取可见文本量。innerText 是纯读，不用 textContent（后者会把 script/style 也算进去） */
  function visibleTextLength() {
    try {
      var body = document.body;
      if (!body) return 0;
      return String(body.innerText || '').trim().length;
    } catch (e) {
      return 0;
    }
  }

  /**
   * 决定本 frame 是否参与翻译。
   * @returns {{ok: boolean, reason: string, area: number, textLength: number}}
   */
  function assess() {
    var area = 0;
    try {
      area = (root.innerWidth || 0) * (root.innerHeight || 0);
    } catch (e) {
      area = 0;
    }

    if (isTop()) {
      // 顶层永远参与 —— 它是「这个页面」的代表，不能因为面积小（比如
      // 开发者工具停靠在侧边导致视口极窄）就拒绝翻译
      return { ok: true, reason: 'top', area: area, textLength: -1 };
    }

    if (area < MIN_AREA) {
      return { ok: false, reason: 'small-area', area: area, textLength: -1 };
    }

    // 广告判定放在面积之后：面积是零成本判断，能挡掉大部分
    try {
      if (document.querySelector(AD_SELECTOR)) {
        return { ok: false, reason: 'ad-container', area: area, textLength: -1 };
      }
    } catch (e) {
      // 选择器在极老浏览器上可能不被支持 —— 不能因此拒绝翻译
    }

    var textLength = visibleTextLength();
    if (textLength < MIN_TEXT) {
      return { ok: false, reason: 'no-text', area: area, textLength: textLength };
    }

    return { ok: true, reason: 'content', area: area, textLength: textLength };
  }

  /**
   * 调试用：把判定结果打一行日志。
   * 只在 URL 带 #ct-debug 时输出，避免污染正常页面的 Console。
   */
  function maybeLog() {
    try {
      if (String(root.location && root.location.hash || '').indexOf('ct-debug') < 0) return;
      var r = assess();
      console.log('[叠译] frame 自评：', r.ok ? '参与' : '跳过', '（' + r.reason + '）',
        'area=' + r.area, 'text=' + r.textLength, root.location.href);
    } catch (e) { /* 忽略 */ }
  }

  CT.frameGate = {
    isTop: isTop,
    assess: assess,
    visibleTextLength: visibleTextLength,
    maybeLog: maybeLog,
    MIN_AREA: MIN_AREA,
    MIN_TEXT: MIN_TEXT,
    AD_SELECTOR: AD_SELECTOR
  };
})(typeof self !== 'undefined' ? self : this);
