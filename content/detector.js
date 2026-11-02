/*
 * 叠译 · 语言检测器
 * ------------------------------------------------------------------
 * 职责：
 *   1) 判定一段文本属于哪种文字系统（Han / Kana / Hangul / Cyrillic / Latin ...）
 *   2) 拉丁文字系统内部再用停用词打分，区分 en / fr / de / es / pt / it / nl ...
 *   3) 综合 <html lang>、meta、正文抽样，给出整页语言结论
 *   4) 提供「这段文本值不值得翻」与「这个元素要不要跳过」的判定
 *
 * 设计原则：零依赖、纯同步、可被 content script 在主线程安全调用。
 */
(function (root) {
  'use strict';

  var CT = (root.CT = root.CT || {});

  /* ================================================================
   * 一、文字系统判定
   * ================================================================ */

  // 说明：各文字系统的 Unicode 区间集中定义在下方 classifyCode()，
  // 不再保留第二份正则表 —— 两份表会漂移，是维护陷阱。

  /**
   * 单个 UTF-16 码元属于哪个文字系统。
   * ------------------------------------------------------------------
   * 这是全模块最热的函数：每个翻译单元至少调用一次，一页数千次。
   *
   * 早期实现对 SCRIPT_PATTERNS 逐个跑 `String.match(/g)`：一次判定要扫
   * 10 遍字符串，每遍都分配一个匹配数组。改成「按码元单次分类」后，
   * 扫描次数从 10 降到 1，且完全不分配数组。
   *
   * 分支顺序按真实页面的字符分布排列：ASCII 与 CJK 两跳命中，
   * 后面的小语种区间只是兜底。
   *
   * @param {number} c 字符码（charCodeAt 的结果）
   * @param {number} low 紧随其后的低代理项（非代理对时为 0）
   * @returns {string|null}
   */
  function classifyCode(c, low) {
    // ASCII：英文正文压倒性多数，第一个分支必须最快
    if (c < 0x80) {
      return (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) ? 'latin' : null;
    }
    // 拉丁扩展 A/B（含重音字母）
    if (c < 0x250) return c >= 0xC0 ? 'latin' : null;
    // CJK 统一表意 + 扩展 A + 兼容表意（中文页面命中率极高）
    if (c >= 0x4E00 && c <= 0x9FFF) return 'han';
    if (c >= 0x3400 && c <= 0x4DBF) return 'han';
    if (c >= 0xF900 && c <= 0xFAFF) return 'han';
    if (c >= 0x3040 && c <= 0x30FF) return 'kana';
    if (c >= 0x31F0 && c <= 0x31FF) return 'kana';
    if (c >= 0xAC00 && c <= 0xD7AF) return 'hangul';
    if (c >= 0x1100 && c <= 0x11FF) return 'hangul';
    if (c >= 0x400 && c <= 0x52F) return 'cyrillic';
    if (c >= 0x370 && c <= 0x3FF) return 'greek';
    if (c >= 0x1F00 && c <= 0x1FFF) return 'greek';
    if (c >= 0x590 && c <= 0x5FF) return 'hebrew';
    if (c >= 0x600 && c <= 0x6FF) return 'arabic';
    if (c >= 0x750 && c <= 0x77F) return 'arabic';
    if (c >= 0x8A0 && c <= 0x8FF) return 'arabic';
    if (c >= 0x900 && c <= 0x97F) return 'devanagari';
    if (c >= 0xE00 && c <= 0xE7F) return 'thai';
    if (c >= 0x1E00 && c <= 0x1EFF) return 'latin';
    // 星号平面的 CJK 扩展 B 及以上（U+20000–U+2FA1F）：
    // 用高代理项判定，低代理项不落在任何区间，因此每个字仍只计一次。
    // 边界必须精确到「高代理项 + 低代理项」，否则会多算 U+2FA20 之后
    // 的 1504 个未分配码点（等价性测试会立刻发现）。
    if (c >= 0xD840 && c < 0xD87E) return 'han';
    if (c === 0xD87E) return (low >= 0xDC00 && low <= 0xDE1F) ? 'han' : null;
    return null;
  }

  // 西里尔字母的语种区分标记
  var UK_MARKERS = /[\u0456\u0457\u0454\u0491]/; // і ї є ґ
  var SR_MARKERS = /[\u0452\u0458\u0459\u045A\u045B\u045C\u045E\u045F]/; // ђ ј љ њ ћ ќ ў џ

  /**
   * 统计文本中各文字系统的字符数
   * ------------------------------------------------------------------
   * 单次线性扫描，按码元分类。旧实现跑 10 次全局正则，本函数在
   * 2500 块的页面上会被调用 2000+ 次，是「采集」阶段的主要成本之一。
   *
   * @param {string} text
   * @returns {{counts: Object, total: number}}
   */
  function scriptStats(text) {
    var counts = null;
    var total = 0;
    // 长文本只抽样前 4000 字符，避免大页面卡顿
    var n = text.length > 4000 ? 4000 : text.length;
    for (var i = 0; i < n; i++) {
      var c = text.charCodeAt(i);
      // 只在高代理项区间才去读下一个码元，普通文本不付这个代价
      var name = (c >= 0xD800 && c <= 0xDBFF)
        ? classifyCode(c, i + 1 < n ? text.charCodeAt(i + 1) : 0)
        : classifyCode(c, 0);
      if (name === null) continue;
      if (counts === null) counts = {};
      counts[name] = (counts[name] || 0) + 1;
      total++;
    }
    return { counts: counts || {}, total: total };
  }

  /* ================================================================
   * 二、拉丁语种停用词打分
   * ================================================================ */

  var STOPWORDS = {
    en: 'the and of to in is that for it with as was on are be this by from at or an not have has you we they will can more about which their there been if would when what so no up out one all were her his its than them then into only other such may should'.split(' '),
    fr: 'le la les des du un une et est que qui dans pour pas sur avec plus par au ce il elle nous vous ils sont etre avoir cette aux ou mais comme tout fait deux aussi peut ces son sa leur dont entre encore'.split(' '),
    de: 'der die das und ist von den mit sich des auf fur nicht sind eine einem einen ein auch als aus dem werden wird bei nach noch nur uber kann oder aber wie wir sie ich zur zum diese dieser dass dann schon wurden wurde'.split(' '),
    es: 'el la los las de del y es en que por con para una uno un se no su al como mas pero sus le ya o este si porque cuando muy sin sobre tambien tiene puede todos esta entre desde hasta'.split(' '),
    pt: 'de a o que e do da em um para com nao os no se na por mais as dos como mas foi ao ele das tem seu sua ou ser quando muito tambem esta entre'.split(' '),
    it: 'di che e la il un per in non con una sono da come si le piu anche questo della del ha ma gli hanno nel alla dei su essere molto quando tutti'.split(' '),
    nl: 'de het een en van is in dat op te voor met zijn niet aan er om ook als maar bij of uit dan door over wordt kan meer deze was alle'.split(' '),
    id: 'yang dan di itu dengan untuk tidak ini dari dalam akan pada juga saya ke karena tersebut bisa ada mereka lebih kata tahun sudah atau oleh kita'.split(' '),
    tr: 'bir ve bu icin ile de da olarak en daha var olan gibi kadar sonra ama ya ki mi ise cok her sey kendi tum ancak'.split(' '),
    vi: 'cua va cac co duoc trong la cho khong voi nay mot da theo tu nhung khi de tren ra den se ve nguoi tai'.split(' '),
    pl: 'nie sie jest ze na do od to tak jak ale lub po za z w i o dla przez jego ich byc moze tylko oraz przy'.split(' '),
    sv: 'och att det som en ett ar pa for med av den till inte har de om der sa kan men vi han hon'.split(' '),
    da: 'og i at det er en et pa for med af den til ikke har de om der som sa kan men vi'.split(' '),
    no: 'og i at det er en et pa for med av den til ikke har de om som sa kan men vi jeg'.split(' '),
    fi: 'ja on ei se etta oli en han joka ovat kun myos tai vain mutta niin kuin sen siita'.split(' '),
    cs: 'a se na je ze v to s z do o ale jako po za od pro jsou byl byla tak take nebo'.split(' '),
    ro: 'si de la in este care cu pe un o au sau mai din pentru lui nu dar ca se ce sunt'.split(' '),
    hu: 'es a az hogy nem is egy meg van de mint csak mar vagy azt aki volt lesz meg ha'.split(' ')
  };

  // 归一化：去掉变音符号，便于把 CJK/环境差异带来的重音统一处理
  var RE_NON_ASCII = /[^\x00-\x7F]/;
  var RE_COMBINING = /[\u0300-\u036f]/g;

  /**
   * 去变音符号。
   * ------------------------------------------------------------------
   * `String.normalize('NFD')` 是 Unicode 规范化，成本远高于普通正则替换。
   * 而英语正文里绝大多数单词是纯 ASCII，对它们做规范化纯属浪费 ——
   * 先用一次 ASCII 探测挡掉，这是本模块性价比最高的单点优化。
   */
  function stripAccents(s) {
    if (!RE_NON_ASCII.test(s)) return s;
    return s.normalize ? s.normalize('NFD').replace(RE_COMBINING, '') : s;
  }

  // 预编译停用词索引：{ normalizedWord: [lang, ...] }
  var STOPWORD_INDEX = (function () {
    var index = {};
    for (var lang in STOPWORDS) {
      if (!Object.prototype.hasOwnProperty.call(STOPWORDS, lang)) continue;
      var list = STOPWORDS[lang];
      for (var i = 0; i < list.length; i++) {
        var w = stripAccents(list[i]);
        if (!index[w]) index[w] = [];
        if (index[w].indexOf(lang) === -1) index[w].push(lang);
      }
    }
    return index;
  })();

  /**
   * 对拉丁文本做语种打分
   * @param {string} text
   * @returns {{lang: string, score: number}}
   */
  function scoreLatin(text) {
    var sample = text.length > 4000 ? text.slice(0, 4000) : text;
    var words = sample.toLowerCase().match(/[a-z\u00c0-\u024f\u1e00-\u1eff']+/g) || [];
    if (!words.length) return { lang: 'en', score: 0 };

    var scores = {};
    var tokens = 0;
    for (var i = 0; i < words.length; i++) {
      var w = stripAccents(words[i]);
      tokens++;
      var langs = STOPWORD_INDEX[w];
      if (!langs) continue;
      for (var j = 0; j < langs.length; j++) {
        scores[langs[j]] = (scores[langs[j]] || 0) + 1;
      }
    }

    var best = 'en';
    var bestScore = 0;
    for (var lang in scores) {
      if (!Object.prototype.hasOwnProperty.call(scores, lang)) continue;
      var s = scores[lang] / tokens;
      if (s > bestScore) { bestScore = s; best = lang; }
    }

    // 置信阈值：低于 6% 的命中率就退回英语（互联网上最可能的兜底）
    if (bestScore < 0.06) return { lang: 'en', score: bestScore, lowConfidence: true };
    return { lang: best, score: bestScore };
  }

  /* ================================================================
   * 三、单段文本语言判定
   * ================================================================ */

  /**
   * 取主导文字系统（供「是否已是目标语言」与整页判定复用）
   * @param {string} text
   * @returns {{name: string, counts: Object, total: number}|null}
   */
  function dominantScript(text) {
    var stats = scriptStats(text);
    if (!stats.total) return null;

    var counts = stats.counts;
    var best = null;
    var bestN = 0;
    for (var name in counts) {
      if (!Object.prototype.hasOwnProperty.call(counts, name)) continue;
      if (counts[name] > bestN) { bestN = counts[name]; best = name; }
    }
    return { name: best, counts: counts, total: stats.total };
  }

  /**
   * @param {string} text
   * @returns {{lang: string, confidence: number}}
   */
  function detectTextLanguage(text) {
    if (!text) return { lang: 'unknown', confidence: 0 };
    var d = dominantScript(text);
    if (!d) return { lang: 'unknown', confidence: 0 };

    var counts = d.counts;
    var dominant = d.name;
    var ratio = counts[dominant] / d.total;

    switch (dominant) {
      case 'han':
        // 日文常常是「假名 + 汉字」混排，假名比例可观则判为日语
        if (counts.kana && counts.kana / (counts.han + counts.kana) > 0.12) {
          return { lang: 'ja', confidence: 0.9 };
        }
        return { lang: 'zh', confidence: ratio };
      case 'kana':
        return { lang: 'ja', confidence: ratio };
      case 'hangul':
        return { lang: 'ko', confidence: ratio };
      case 'cyrillic':
        if (UK_MARKERS.test(text)) return { lang: 'uk', confidence: 0.7 };
        if (SR_MARKERS.test(text)) return { lang: 'sr', confidence: 0.6 };
        return { lang: 'ru', confidence: 0.7 };
      case 'arabic':
        return { lang: 'ar', confidence: ratio };
      case 'hebrew':
        return { lang: 'he', confidence: ratio };
      case 'thai':
        return { lang: 'th', confidence: ratio };
      case 'devanagari':
        return { lang: 'hi', confidence: ratio };
      case 'greek':
        return { lang: 'el', confidence: ratio };
      case 'latin': {
        var r = scoreLatin(text);
        return { lang: r.lang, confidence: r.score ? Math.min(0.95, 0.35 + r.score) : 0.4 };
      }
      default:
        return { lang: 'unknown', confidence: 0 };
    }
  }

  /**
   * 这段文本是否已经是目标语言（用于逐段筛掉不必翻译的内容）
   * ------------------------------------------------------------------
   * 关键取舍：这里只回答「要不要翻」，不回答「它是哪种语言」。
   *
   * 旧实现走 detectTextLanguage → 对拉丁文本调用 scoreLatin，
   * 用停用词给 en / fr / de / es … 打分。但对「翻成中文」这个目标而言，
   * 拉丁语系内部究竟是哪一种**完全不影响结论** —— 只要不是中文就得翻。
   * 于是整轮分词 + 打分（含一次整串小写拷贝与逐词查表）可以跳过。
   *
   * 这不是近似：目标语言为中文时，旧路径对拉丁主导文本必然返回
   * 「非同一语言」，与本函数的判断完全一致。目标语言非中文时仍走完整判定。
   *
   * @param {string} text
   * @param {string} targetLang
   * @returns {boolean}
   */
  function isAlreadyTargetLanguage(text, targetLang) {
    if (!text) return false;
    var t = CT.settings.normalizeLang(targetLang);

    if (t === 'zh-CN' || t === 'zh-TW') {
      var d = dominantScript(text);
      if (!d || d.name !== 'han') return false;      // 非汉字主导 → 必然要翻
      var han = d.counts.han || 0;
      var kana = d.counts.kana || 0;
      // 假名占比高 → 是日语，仍要翻
      return !(kana && kana / (han + kana) > 0.12);
    }

    // 其他目标语言：仍需区分拉丁语系内部语言
    return CT.settings.isSameLanguage(detectTextLanguage(text).lang, t);
  }

  /* ================================================================
   * 四、整页语言判定
   * ================================================================ */

  var PAGE_SAMPLE_SELECTOR = 'article, main, [role="main"], .content, #content, p, h1, h2, h3, li, td';

  /**
   * @returns {{lang: string, confidence: number, method: string, variant: string}}
   *   variant —— 中文页面的正字法：'hans' 简体 / 'hant' 繁体 / 'unknown'。
   *   整页开关要靠它区分「简体页 + 目标繁体」这种必须真翻的组合，
   *   否则「把目标语言设成繁体中文」在简体页面上会永远不生效。
   */
  function detectPageLanguage() {
    // 1) <html lang="...">
    var htmlLang = (document.documentElement && document.documentElement.getAttribute('lang')) || '';
    htmlLang = htmlLang.trim();

    // 2) <meta http-equiv="content-language"> / <meta name="language">
    var metaLang = '';
    try {
      var meta = document.querySelector('meta[http-equiv="content-language" i], meta[name="language" i]');
      if (meta) metaLang = (meta.getAttribute('content') || '').trim();
    } catch (e) { /* 某些页面 DOM 异常，忽略 */ }

    // 3) 正文抽样
    var sample = samplePageText();
    var detected = detectTextLanguage(sample);
    var variant = detected.lang === 'zh' ? CT.settings.scriptVariant(sample) : '';

    // 抽样得分足够高时，以抽样为准（lang 属性写错的站点很常见）
    if (detected.lang !== 'unknown' && detected.confidence >= 0.5) {
      return { lang: detected.lang, confidence: detected.confidence, method: 'content', variant: variant };
    }
    if (htmlLang) {
      var hl = CT.settings.normalizeLang(htmlLang);
      return { lang: hl, confidence: 0.6, method: 'html-lang', variant: hl.indexOf('zh') === 0 ? variant : '' };
    }
    if (metaLang) {
      var ml = CT.settings.normalizeLang(metaLang);
      return { lang: ml, confidence: 0.5, method: 'meta', variant: ml.indexOf('zh') === 0 ? variant : '' };
    }
    var fb = detected.lang === 'unknown' ? 'en' : detected.lang;
    return { lang: fb, confidence: 0.25, method: 'fallback', variant: fb === 'zh' ? variant : '' };
  }

  function samplePageText() {
    var buf = [];
    var total = 0;
    var nodes;
    try {
      nodes = document.querySelectorAll(PAGE_SAMPLE_SELECTOR);
    } catch (e) {
      nodes = [];
    }
    for (var i = 0; i < nodes.length && total < 3000; i++) {
      var el = nodes[i];
      if (shouldSkipElement(el, null)) continue;
      var t = el.textContent || '';
      if (t.length < 10) continue;
      buf.push(t.slice(0, 400));
      total += t.length;
    }
    if (!buf.length) {
      var body = document.body ? document.body.textContent || '' : '';
      return body.slice(0, 3000);
    }
    return buf.join(' ').slice(0, 3000);
  }

  /* ================================================================
   * 五、元素与文本的过滤规则
   * ================================================================ */

  // 这些标签内部的内容一律不翻
  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, LINK: 1, META: 1, HEAD: 1,
    CODE: 1, PRE: 1, KBD: 1, SAMP: 1, VAR: 1, TT: 1,
    TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1, OPTGROUP: 1, BUTTON: 1,
    SVG: 1, CANVAS: 1, MATH: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, VIDEO: 1, AUDIO: 1,
    MAP: 1, AREA: 1, TRACK: 1, SOURCE: 1, PICTURE: 1, IMG: 1,
    RUBY: 1, RT: 1, RP: 1
  };

  // 内联元素：不会单独构成翻译单元，要和兄弟节点合并到最近的块级祖先里
  var INLINE_TAGS = {
    A: 1, ABBR: 1, ACRONYM: 1, B: 1, BDI: 1, BDO: 1, BIG: 1, BR: 1, CITE: 1,
    DATA: 1, DFN: 1, EM: 1, FONT: 1, I: 1, KBD: 1, LABEL: 1, MARK: 1, NOBR: 1,
    Q: 1, S: 1, SAMP: 1, SMALL: 1, SPAN: 1, STRIKE: 1, STRONG: 1, SUB: 1,
    SUP: 1, TIME: 1, TT: 1, U: 1, VAR: 1, WBR: 1
  };

  // 译文块只能内嵌进的容器（作为兄弟节点插入会破坏 HTML 结构）
  var APPEND_INSIDE = {
    TD: 1, TH: 1, LI: 1, DT: 1, DD: 1, FIGCAPTION: 1, SUMMARY: 1, OPTION: 1, LABEL: 1, CAPTION: 1,
    SELECT: 1, UL: 1, OL: 1, DL: 1, TABLE: 1, TBODY: 1, THEAD: 1, TFOOT: 1, TR: 1
  };

  // 整块语义容器：允许作为单元，但内部还有块级子元素时继续下钻
  var CONTAINER_TAGS = {
    DIV: 1, SECTION: 1, ARTICLE: 1, ASIDE: 1, MAIN: 1, HEADER: 1, FOOTER: 1, NAV: 1,
    FORM: 1, FIELDSET: 1, DETAILS: 1, BODY: 1, BLOCKQUOTE: 1, FIGURE: 1
  };

  /**
   * 该元素是否应整体跳过
   * @param {Element} el
   * @param {string[]|null} extraSelectors 用户自定义跳过的选择器
   */
  function shouldSkipElement(el, extraSelectors) {
    if (!el || el.nodeType !== 1) return true;
    var tag = el.tagName;
    if (SKIP_TAGS[tag]) return true;

    // 已经是我们自己插入的节点
    if (el.classList && el.classList.contains(CT.TRANS_CLASS)) return true;
    if (el.classList && el.classList.contains('notranslate')) return true;
    if (el.getAttribute && el.getAttribute('translate') === 'no') return true;
    if (el.hasAttribute && el.hasAttribute('data-ct-skip')) return true;

    // 可编辑区域不翻（避免破坏用户输入）
    if (el.isContentEditable) return true;

    // 显式隐藏。aria-hidden 常被用在小图标上，若按它整块跳过会误伤正文，
    // 因此只认 hidden 属性与内联 display:none。
    if (el.hasAttribute && el.hasAttribute('hidden')) return true;
    if (el.style && el.style.display === 'none') return true;

    if (extraSelectors && extraSelectors.length) {
      for (var i = 0; i < extraSelectors.length; i++) {
        var sel = String(extraSelectors[i] || '').trim();
        if (!sel) continue;
        try {
          if (el.matches && el.matches(sel)) return true;
          if (el.closest && el.closest(sel)) return true;
        } catch (e) { /* 非法选择器忽略 */ }
      }
    }
    return false;
  }

  /** 判断元素是否属于内联显示（用标签近似，避免对每个元素调用 getComputedStyle） */
  function isInlineElement(el) {
    return !!INLINE_TAGS[el.tagName];
  }

  /** 该元素是否应该把译文追加到内部（而不是插到后面当兄弟节点） */
  function shouldAppendInside(el) {
    return !!APPEND_INSIDE[el.tagName];
  }

  /** 是否是可以承载翻译单元的容器类标签 */
  function isContainerElement(el) {
    return !!CONTAINER_TAGS[el.tagName];
  }

  // ---------------------------------------------------------------
  // 文本可译性判定
  // ---------------------------------------------------------------

  var RE_HAS_LETTER = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u1100-\u11FF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/;
  var RE_EMAIL = /^[\w.+-]+@[\w-]+\.[\w.-]+$/;
  var RE_URL = /^(https?:\/\/|www\.)\S+$/i;
  // 上面三条正则原为「纯数字 / 纯符号」判定所配，现已删除 —— 见 isTranslatableText 的说明。

  /* ---------------------------------------------------------------
   * 噪声文本：HTML 源码与序列化数据
   * ---------------------------------------------------------------
   * 真实页面（招聘聚合站、论坛、CMS）里经常出现「把 HTML 源码或多段 JSON
   * 当正文显示」的字段：第三方接口未解码、富文本被双重转义、JSON-LD 被塞进
   * 容器再渲染出来。这类文本有两重危害：
   *   1) 翻译没有意义 —— 模型会照着把标签一起搬进译文，读者看到的是乱码；
   *   2) 体积极大 —— 一个单元就能撑爆容器，落在窄列里会拉成一根竖条，
   *      看起来就像「整页被压变形」。
   * 因此在判定阶段直接拦掉，而不是等渲染出来再补救。
   */

  // 标签形态。属性段限长，避免在畸形文本上退化成灾难性回溯
  var RE_TAG = /<\/?[A-Za-z][A-Za-z0-9-]{0,20}(?:\s[^<>]{0,120})?\/?>/g;
  // 强信号：闭合标签紧跟开标签。正常散文里几乎不可能出现这种拼接形态
  var RE_ADJACENT_TAGS = /<\/[A-Za-z][A-Za-z0-9-]*>\s*<[A-Za-z]/;
  // JSON-LD / 结构化数据的特征键
  var RE_DATA_KEY = /"@(?:type|context)"\s*:|\bbaseSalary\b|\bMonetaryAmount\b|\bdatePosted\b/;

  /** 统计子串出现次数，最多数到 cap 次就停 */
  function countOccurrences(text, needle, cap) {
    var n = 0;
    var i = 0;
    while (n < cap) {
      i = text.indexOf(needle, i);
      if (i < 0) break;
      n++;
      i += needle.length;
    }
    return n;
  }

  /**
   * 这段文本是不是一段 HTML 源码（而不是渲染后的正文）
   * ------------------------------------------------------------------
   * 两条判据，从严到宽：
   *   · 出现「闭合标签紧跟开标签」，且至少有 2 个标签 → 源码拼接的独有形态，直接判是
   *   · 标签个数 ≥ 3 且标签字符占全串 ≥ 20% → 标签密度够高，判是
   * 正文里合法出现的 `<`（"a < b"、数学式、表情符号）不会构成标签形态，
   * 因此不会被误伤。
   */
  function looksLikeMarkup(text) {
    if (text.indexOf('<') < 0) return false;   // 廉价前置：没有尖括号就不可能
    if (RE_ADJACENT_TAGS.test(text)) {
      var strong = text.match(RE_TAG);
      if (strong && strong.length >= 2) return true;
    }
    var tags = text.match(RE_TAG);
    if (!tags || tags.length < 3) return false;
    var chars = 0;
    for (var i = 0; i < tags.length; i++) chars += tags[i].length;
    return chars * 5 >= text.length;
  }

  /**
   * 这段文本是不是一段序列化数据（JSON / JSON-LD）
   * ------------------------------------------------------------------
   * 「引号紧跟冒号」是序列化对象独有的形态：正常散文里出现一次是引号加冒号
   * 连着写，出现四次几乎不可能。
   */
  function looksLikeDataBlob(text) {
    if (text.length < 24) return false;
    if (text.indexOf('"') < 0) return false;    // 廉价前置
    if (RE_DATA_KEY.test(text)) return true;
    return countOccurrences(text, '":', 4) >= 4;
  }

  /**
   * 至少含 N 个「可见文字」字符
   * ------------------------------------------------------------------
   * 旧用 `text.match(/[^\s\d\p{P}\p{S}]/gu)` 取全部匹配再判长度，
   * 会为一个 5000 字的单元分配一个含上千个元素的数组。
   * 这里改为最多执行 N 次 exec，分配量降为常数。
   */
  var RE_LETTER_LIKE = /[^\s\d\p{P}\p{S}]/gu;
  function hasLetterLike(text, need) {
    RE_LETTER_LIKE.lastIndex = 0;
    var n = 0;
    while (n < need && RE_LETTER_LIKE.test(text)) n++;
    return n >= need;
  }

  /**
   * 这段文本是否值得送去翻译
   * ------------------------------------------------------------------
   * 判定顺序按「代价从低到高」排列，且尽量用前置条件消掉后续判定：
   *
   *   · 若已确认存在 ≥2 个「非空白、非数字、非标点、非符号」字符，
   *     那么「整串都由空白/数字/标点/符号构成」与「整串都由
   *     代码符号构成」这两种情况在逻辑上已不可能成立 ——
   *     RE_NUMERIC 与 RE_CODE_LIKE 因此是恒不可达的死代码，已删除。
   *     （相关字符在 Unicode 中要么是 \p{P} 要么是 \p{S}，已被上面的
   *      计数排除；测试只断言最终 ok 值，语义完全保持。）
   *
   * @param {string} text 已归一化（空白折叠）的文本
   * @param {string} targetLang
   * @param {number} minLen
   * @returns {{ok: boolean, reason?: string}}
   */
  function isTranslatableText(text, targetLang, minLen) {
    if (!text) return { ok: false, reason: 'empty' };
    minLen = minLen || 2;
    if (text.length < minLen) return { ok: false, reason: 'too-short' };
    if (text.length > CT.MAX_TEXT_PER_UNIT) return { ok: false, reason: 'too-long' };

    // 至少要有两个字母/文字，纯数字或纯符号在此被挡掉
    if (!hasLetterLike(text, 2)) return { ok: false, reason: 'no-letters' };
    if (!RE_HAS_LETTER.test(text)) return { ok: false, reason: 'no-letter-script' };
    if (RE_EMAIL.test(text)) return { ok: false, reason: 'email' };
    if (RE_URL.test(text)) return { ok: false, reason: 'url' };

    // 噪声：HTML 源码 / 序列化数据。
    // 刻意放在语言判定之前 —— 这两类文本往往很长，让它们走完整条判定链
    // （含一次整串码元分类）再被丢掉是纯浪费。
    if (looksLikeMarkup(text)) return { ok: false, reason: 'markup' };
    if (looksLikeDataBlob(text)) return { ok: false, reason: 'data-blob' };

    // 已经是目标语言 → 不需要翻译
    if (isAlreadyTargetLanguage(text, targetLang)) {
      return { ok: false, reason: 'already-target' };
    }

    // 单字母 / 纯标点组合（如 "·"、"A"）已在上方被过滤
    return { ok: true };
  }

  /**
   * 判断文本的主要语言是否与目标语言不同（用于「仅显示译文」模式下逐段判断）
   */
  function isTargetLanguage(text, targetLang) {
    return isAlreadyTargetLanguage(text, targetLang);
  }

  /* ================================================================
   * 导出
   * ================================================================ */
  CT.detector = {
    scriptStats: scriptStats,
    dominantScript: dominantScript,
    scoreLatin: scoreLatin,
    detectTextLanguage: detectTextLanguage,
    detectPageLanguage: detectPageLanguage,
    isTranslatableText: isTranslatableText,
    looksLikeMarkup: looksLikeMarkup,
    looksLikeDataBlob: looksLikeDataBlob,
    isAlreadyTargetLanguage: isAlreadyTargetLanguage,
    isTargetLanguage: isTargetLanguage,
    shouldSkipElement: shouldSkipElement,
    isInlineElement: isInlineElement,
    shouldAppendInside: shouldAppendInside,
    isContainerElement: isContainerElement,
    SKIP_TAGS: SKIP_TAGS,
    INLINE_TAGS: INLINE_TAGS
  };
})(typeof self !== 'undefined' ? self : this);
