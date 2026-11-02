/*
 * 叠译 · 场景识别
 * ==================================================================
 * 【为什么需要这一层】
 * 现场截图（remoteok.com）：
 *      Apply（职位卡行动按钮）被译成 → 应用（应是 申请）
 *      Executive（职能标签）  被译成 → 行政（应是 高管）
 *
 * 这两个词都被治理规则 G1（不收多义单词）挡在术语基座外 —— 规则本身
 * 是对的：不加约束地收 `Apply → 申请`，会把「应用设置」这类普通页面
 * 的 Apply 也错译。但规则有个隐含假设：**我们手里没有别的消歧信息**。
 *
 * 实际上有 —— 页面自己就是语境。职位卡、薪资行、Apply 按钮、
 * "16d posted"，这些都是强场景信号。本文件把「场景」变成一等公民：
 *
 *   探测（本文件，纯函数） → 随翻译请求携带 → worker 按场景过滤术语
 *
 * 场景条目在 shared/terminology.js 里以 `scenes: ['recruiting']` 声明，
 * 只在对应场景下进入生效术语集。这样 G1 的保守性保住了（无场景信息
 * 时多义词依然不收），招聘页的正确性也拿回来了。
 *
 * 【设计约束】
 * - detect() 是纯函数：输入 {url,title,text} 描述对象，不碰 DOM ——
 *   node 测试无需 jsdom，信号阈值可回归。
 * - 宁可不识别，不可误识别：阈值取高（见下）。
 * - 场景不覆盖用户设置：termDomains 是用户显式选择，场景只决定
 *   「场景限定条目」是否启用，分域开关语义不变。
 * ================================================================== */
(function (root) {
  'use strict';
  var CT = root.CT = root.CT || {};

  /*
   * 场景定义。
   * ------------------------------------------------------------------
   * urlPatterns / titlePatterns：强信号，命中任意一条即判定。
   * textKeywords：弱信号，需要 ≥ TEXT_THRESHOLD 个【不同】词命中
   * （按 \b 整词、忽略大小写）—— 单个词的巧合太容易
   * （任何页面都可能有 "Manager" 或 "Apply"）。
   */
  CT.TERM_SCENES = [
    {
      id: 'recruiting',
      label: '招聘与求职',
      urlPatterns: [
        /\/jobs?\b/i, /\/job\//i, /\/careers?\b/i, /\/hiring\b/i,
        /remoteok\.com/i, /\/we-are-hiring/i
      ],
      titlePatterns: [/\bjobs?\b/i, /\bhiring\b/i, /\bcareers?\b/i],
      textKeywords: [
        'Apply', 'Senior', 'Junior', 'Engineer', 'Manager', 'Remote',
        'Salary', 'Full-Time', 'Part-Time', 'Posted', 'Resume', 'Hiring',
        'Internship', 'Benefits', 'Department', 'Perks', 'Job Description'
      ]
    }
  ];

  /** 弱信号的阈值：不同关键词至少命中几个才算场景成立 */
  var TEXT_THRESHOLD = 4;

  function countKeywordHits(text) {
    var hits = [];
    var s = String(text || '');
    for (var i = 0; i < CT.TERM_SCENES.length; i++) {
      var sc = CT.TERM_SCENES[i];
      var n = 0;
      for (var k = 0; k < sc.textKeywords.length; k++) {
        var re = new RegExp('\\b' + sc.textKeywords[k].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
        if (re.test(s)) n++;
      }
      if (n > 0) hits.push({ id: sc.id, keywordHits: n });
    }
    return hits;
  }

  /**
   * 场景探测。
   * @param {{url?:string, title?:string, text?:string}} desc 页面描述
   * @returns {string[]} 命中的场景 id 列表（可能为空数组）
   */
  function detect(desc) {
    desc = desc || {};
    var url = String(desc.url || '');
    var title = String(desc.title || '');
    var text = String(desc.text || '');
    var out = [];

    for (var i = 0; i < CT.TERM_SCENES.length; i++) {
      var sc = CT.TERM_SCENES[i];
      var strong = false;
      for (var u = 0; u < sc.urlPatterns.length; u++) {
        if (sc.urlPatterns[u].test(url)) { strong = true; break; }
      }
      if (!strong) {
        for (var t = 0; t < sc.titlePatterns.length; t++) {
          if (sc.titlePatterns[t].test(title)) { strong = true; break; }
        }
      }
      if (strong) { out.push(sc.id); continue; }

      // 弱信号：不同关键词命中数达到阈值
      var hits = countKeywordHits(text);
      for (var h = 0; h < hits.length; h++) {
        if (hits[h].id === sc.id && hits[h].keywordHits >= TEXT_THRESHOLD) {
          out.push(sc.id);
          break;
        }
      }
    }
    return out;
  }

  CT.scene = {
    SCENES: CT.TERM_SCENES,
    THRESHOLD: TEXT_THRESHOLD,
    detect: detect,
    countKeywordHits: countKeywordHits
  };
})(typeof self !== 'undefined' ? self : this);
