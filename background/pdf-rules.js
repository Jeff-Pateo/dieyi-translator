/*
 * 叠译 · PDF 导航拦截规则
 * ------------------------------------------------------------------
 * 目标：用户点开一个 .pdf，不要让 Chrome 用它内置的查看器打开 —— 那个查看器
 * 是独立的插件文档，content script **无法注入**（MDN 在 scripting.executeScript()
 * 文档里点名 PDF viewer），所以我们没有机会在它上面做双语对照。
 * 做法是把它重定向到扩展自带的 pdf.js 查看器。
 *
 * 为什么用**动态规则**而不是静态 rules.json：
 *   redirect.extensionPath 虽然不需要扩展 ID，但它**带不上原始 URL** ——
 *   重定向后查看器不知道要加载哪个文件。
 *   而 regexSubstitution 需要写成完整的 chrome-extension://<id>/... 形式，
 *   <id> 只有运行时才知道（除非在 manifest 里写死 key）。
 *   所以规则在 service worker 启动时用 chrome.runtime.getURL 拼出来再注册。
 *
 * 代价（如实记录）：动态规则需要 service worker 至少启动过一次。
 * 扩展安装 / 浏览器启动时 SW 都会被唤醒，正常情况下不影响；
 * 极端的「刚装好立刻打开 PDF」场景可能漏掉一次，刷新即可。
 */
(function (root) {
  'use strict';

  var CT = (root.CT = root.CT || {});

  /** 规则 id。用一个大常数，避免与将来可能新增的规则撞号 */
  var RULE_ID = 9001;

  /** 查看器页面路径（相对扩展根） */
  var VIEWER_PATH = 'pdf/viewer.html';

  /**
   * 构建重定向规则。
   * @param {string} viewerUrl chrome.runtime.getURL('pdf/viewer.html')
   * @returns {Object} DNR 规则
   */
  function build(viewerUrl) {
    return {
      id: RULE_ID,
      // 低优先级：用户自己配的 DNR 规则应该能盖过这一条
      priority: 1,
      action: {
        type: 'redirect',
        redirect: {
          // \\0 = 整个匹配到的 URL。查看器用 file 参数把它取回来。
          regexSubstitution: viewerUrl + '?file=\\0'
        }
      },
      condition: {
        // 必须匹配**整个** URL（DNR 的 regexFilter 是整串匹配）。
        // 同时覆盖 https?:// 与 file:// —— file:// 是否真能被拦下未核实，
        // 拦不下也不算错，只是退回 Chrome 原生查看器。
        regexFilter: '^(https?|file)://.*\\.pdf(\\?.*)?$',
        resourceTypes: ['main_frame']
      }
    };
  }

  /**
   * 从查看器页面的 search 串里取回原始 PDF 地址。
   * ------------------------------------------------------------------
   * 这里刻意【不用】URLSearchParams：
   * DNR 的 regexSubstitution 插入的是**未编码**的原始 URL，
   * 形如 `?file=https://a.com/x.pdf?a=1&b=2`。
   * URLSearchParams 会把 PDF 自带的 `&` 当成参数分隔符，把地址截断。
   * 因为构造时只放 file 一个参数，直接读到串尾即是完整地址。
   *
   * @param {string} search location.search
   * @returns {string} 原始 URL，取不到返回空串
   */
  function parseFileParam(search) {
    var s = String(search || '');
    if (s.charAt(0) === '?') s = s.slice(1);
    var i = s.indexOf('file=');
    if (i < 0) return '';
    var raw = s.slice(i + 5);
    if (!raw) return '';
    try {
      return decodeURIComponent(raw);
    } catch (e) {
      // 未编码的 URL 里可能出现孤立的 % —— decode 会抛，此时原样使用更安全
      return raw;
    }
  }

  /** 判断一个地址是不是 PDF（用于查看器侧做二次确认） */
  function looksLikePdf(url) {
    return /\.pdf(\?.*)?$/i.test(String(url || ''));
  }

  CT.pdfRules = {
    RULE_ID: RULE_ID,
    VIEWER_PATH: VIEWER_PATH,
    build: build,
    parseFileParam: parseFileParam,
    looksLikePdf: looksLikePdf
  };
})(typeof self !== 'undefined' ? self : this);
