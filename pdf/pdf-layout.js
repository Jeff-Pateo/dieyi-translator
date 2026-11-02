/*
 * 叠译 · PDF 文本层排版
 * ------------------------------------------------------------------
 * PDF 里的文字不是「段落」，而是一堆带坐标的碎片（textItem）。
 * 一个句子里每个词都可能是独立的 item，甚至每个字符一个。
 * 要送进翻译引擎，必须先按坐标把它们拼回「行」。
 *
 * 坐标系（pdf.js 的约定）：
 *   transform[4] = x，从左到右
 *   transform[5] = y，**从下往上**（原点在页面左下角）
 *   所以「同一行」的判断是 y 接近，而行的输出顺序要按 y 从大到小。
 *
 * 这一层全是纯函数，不碰 DOM、不碰 pdf.js ——
 * 只有这样才能在 Node 里穷举断言（见 tools/test-pdf.mjs）。
 */
(function (root) {
  'use strict';

  var CT = (root.CT = root.CT || {});

  /** 同一行的 y 容差系数：取 0.5 倍行高 */
  var ROW_TOLERANCE = 0.5;
  /** 行内间隙超过这个倍数的字号，视为分隔（表格列 / 多列）而不是空格 */
  var GAP_RATIO = 0.3;
  /** 一页里的 item 少于这个数，判定为扫描件（没有文本层） */
  var SCANNED_MAX_ITEMS = 5;

  function itemHeight(it, fallback) {
    var h = Math.abs(it.height);
    if (!h) h = Math.abs((it.transform && it.transform[3]) || 0);
    return h || fallback || 10;
  }

  /**
   * 把一页的 textItem 聚成若干「行」。
   * @param {Array} items pdf.js 的 content.items
   * @returns {Array<{text:string, y:number, items:Array, indexes:Array<number>}>}
   *          indexes 是这一行用到的原始 item 下标，渲染译文时用来定位 textLayer span
   */
  function clusterIntoLines(items) {
    if (!items || !items.length) return [];

    // 只保留真正有字符的 item：pdf.js 会插入纯空格的占位项，它们不构成文本
    var valid = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || typeof it.str !== 'string') continue;
      if (!it.transform || it.transform.length < 6) continue;
      if (!it.str.length) continue;
      valid.push({ it: it, idx: i });
    }
    if (!valid.length) return [];

    // 先按 y 降序（从上到下），同 y 按 x 升序（从左到右）
    valid.sort(function (a, b) {
      var dy = b.it.transform[5] - a.it.transform[5];
      if (Math.abs(dy) > 0.01) return dy;
      return a.it.transform[4] - b.it.transform[4];
    });

    var rows = [];
    for (var k = 0; k < valid.length; k++) {
      var cur = valid[k];
      var y = cur.it.transform[5];
      var h = itemHeight(cur.it);

      var row = null;
      for (var r = 0; r < rows.length; r++) {
        if (Math.abs(rows[r].y - y) <= Math.max(h, rows[r].h) * ROW_TOLERANCE) {
          row = rows[r];
          break;
        }
      }
      if (row) {
        row.items.push(cur);
        // 行的 y 取该行所有 item 的加权中心，避免被个别偏移的 item 带跑
        row.y = (row.y * (row.items.length - 1) + y) / row.items.length;
      } else {
        rows.push({ y: y, h: h, items: [cur] });
      }
    }

    // 行内按 x 排序后拼文本
    var out = [];
    for (var m = 0; m < rows.length; m++) {
      var rg = rows[m];
      rg.items.sort(function (a, b) { return a.it.transform[4] - b.it.transform[4]; });

      var text = '';
      var prevRight = null;
      var fs = rg.h || 10;

      for (var n = 0; n < rg.items.length; n++) {
        var node = rg.items[n];
        var item = node.it;

        if (prevRight !== null) {
          var gap = item.transform[4] - prevRight;
          var size = itemHeight(item, fs);
          // 宽间隙 → 制表符（表格列、多栏），窄间隙 → 空格。
          // 用制表符而不是一串空格，是为了让掩码保护与术语表
          // 依然能把「列」看成结构，而不是一段连续文本。
          text += gap > size * GAP_RATIO ? '\t' : ' ';
        }
        text += item.str;
        prevRight = item.transform[4] + (item.width || 0);
      }

      var trimmed = text.replace(/[ \t]+$/, '').replace(/^[ \t]+/, '');
      if (!trimmed) continue;

      out.push({
        text: trimmed,
        y: rg.y,
        items: rg.items,
        indexes: rg.items.map(function (x) { return x.idx; })
      });
    }

    return out;
  }

  /**
   * 判定这一页是不是扫描件（没有文本层）。
   * 扫描版 PDF 的 getTextContent() 会返回空数组，或只剩零星几个 item。
   * @param {Object} content pdf.js 的 getTextContent() 结果
   * @returns {boolean}
   */
  function isScanned(content) {
    if (!content || !content.items) return true;
    var n = 0;
    for (var i = 0; i < content.items.length; i++) {
      var it = content.items[i];
      if (it && typeof it.str === 'string' && it.str.trim().length) n++;
    }
    return n < SCANNED_MAX_ITEMS;
  }

  /**
   * 按 x 的中位数把这一页切成左右两栏。
   * ------------------------------------------------------------------
   * ⚠️ 这是**启发式**，会被跨栏标题、跨栏脚注、居中的页眉页码打破。
   * 所以只在「左右两簇各自占比接近且中间有明显空隙」时才认定是双栏，
   * 否则按单栏处理 —— 猜错的代价（阅读顺序全乱）比不做（按 y 排序）
   * 大得多。首期只做单栏，这个函数先落地为下一轮的接入点。
   *
   * @returns {{left:Array, right:Array, fullWidth:Array}|null} null = 不是双栏
   */
  function splitColumns(items, pageWidth) {
    if (!items || items.length < 12 || !pageWidth) return null;

    var mid = pageWidth / 2;
    var span = pageWidth * 0.06;   // 中线附近这一段视作「全宽」
    var left = [], right = [], full = [];

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || !it.transform) continue;
      var x0 = it.transform[4];
      var x1 = x0 + (it.width || 0);
      if (x0 < mid - span && x1 <= mid + span) left.push(it);
      else if (x0 >= mid - span && x1 > mid + span) right.push(it);
      else if (x0 < mid - span && x1 > mid + span) full.push(it);
      else (x0 < mid ? left : right).push(it);
    }

    var min = Math.max(4, Math.floor(items.length * 0.2));
    // 一边空缺说明根本不是双栏（比如整页一张大表）
    if (left.length < min || right.length < min) return null;
    // 两侧悬殊过大也说明不是对称双栏
    var ratio = left.length / right.length;
    if (ratio < 0.4 || ratio > 2.5) return null;

    return { left: left, right: right, fullWidth: full };
  }

  /** 一行是否值得送去翻译（纯数字、纯符号、过短的不要） */
  function isTranslatableLine(text, minLen) {
    var t = String(text || '').trim();
    if (!t) return false;
    if (t.length < (minLen === undefined ? 2 : minLen)) return false;
    if (!/[\p{L}]/u.test(t)) return false;
    return true;
  }

  /* ================================================================
   * 坐标换算
   * ================================================================
   * PDF 坐标（原点左下、单位点）→ 视口坐标（原点左上、单位像素）。
   * 换算靠 pdf.js 的 viewport.transform 做矩阵乘。
   * 这里自己实现那次乘法（三个乘加），而不是调 pdfjsLib.Util.transform ——
   * 目的是让这一层保持「零 pdf.js 依赖」，从而可以在 Node 里直接断言。
   */

  /** 两个 6 元仿射矩阵相乘（与 pdf.js Util.transform 同序） */
  function mtx(m1, m2) {
    return [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
    ];
  }

  /**
   * 求一行在视口坐标系里的外接盒。
   * 注意基线：pdf.js 的 transform[5] 是**基线** y，不是上边缘，
   * 所以上边缘要再减掉一个字高，否则译文会压在原文字身上。
   *
   * @param {Object} row clusterIntoLines 的产物
   * @param {Array<number>} viewportTransform pdf.js 的 viewport.transform
   * @returns {{left:number, top:number, width:number, height:number, fontSize:number}}
   */
  function lineBox(row, viewportTransform) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (var i = 0; i < row.items.length; i++) {
      var node = row.items[i];
      var it = node.it || node;
      if (!it || !it.transform) continue;

      var tx = mtx(viewportTransform, it.transform);
      var fh = Math.hypot(tx[2], tx[3]) || 10;   // 缩放后的字高
      var x = tx[4];
      var y = tx[5] - fh;                        // 基线 → 上边缘
      var w = it.width || 0;

      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + w > maxX) maxX = x + w;
      if (y + fh * 1.2 > maxY) maxY = y + fh * 1.2;
    }

    if (!isFinite(minX)) return null;

    return {
      left: minX,
      top: minY,
      width: Math.max(0, maxX - minX),
      height: Math.max(0, maxY - minY),
      fontSize: Math.max(0, maxY - minY)
    };
  }

  CT.pdfLayout = {
    clusterIntoLines: clusterIntoLines,
    isScanned: isScanned,
    splitColumns: splitColumns,
    isTranslatableLine: isTranslatableLine,
    mtx: mtx,
    lineBox: lineBox,
    ROW_TOLERANCE: ROW_TOLERANCE,
    GAP_RATIO: GAP_RATIO,
    SCANNED_MAX_ITEMS: SCANNED_MAX_ITEMS
  };
})(typeof self !== 'undefined' ? self : this);
