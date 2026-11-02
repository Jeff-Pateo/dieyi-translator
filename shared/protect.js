/*
 * 叠译 · 不可译片段保护 + 术语表
 * ------------------------------------------------------------------
 * 「部分翻译不正确」里有一类不是引擎水平问题，而是**送进引擎的东西本身
 * 就不该被翻**，或者**必须翻成指定说法**。典型症状：
 *
 *   1) URL 被翻：`https://example.com/user/profile` → 中文里出现「用户/个人资料」
 *   2) 代码标识符被翻：`getUserById` → 「通过ID获取用户」，粘回代码就报错
 *   3) 模板占位符被翻或被改写：`{name}` → 「{名称}」，渲染时直接丢值
 *   4) 版本号/型号被翻：`v1.2.3` → 「v1.2.3版本」，`RTX 4090` → 「RTX4090」
 *   5) 专有名词每次翻得不一样：同一个 `Prompt` 有时「提示」有时「提示词」
 *
 * 修法不是「让引擎更聪明」，而是**把不该翻的东西先摘出来**：
 *
 *   原文 A ──protect──▶ 掩码文本 A′（片段换成私用区占位符）
 *        └─▶ 引擎 ─▶ 译文 B′
 *                  └─restore──▶ 译文 B（占位符还原成指定说法）
 *
 * 这样对**所有引擎**都成立 —— Google 免费接口无法注入提示词，DeepL 也不支持
 * 术语表参数，但两者都**不会改写私用区字符**（U+E000–U+F8FF，字体里通常没字形，
 * 引擎的 tokenizer 把它当噪声原样透传）。
 *
 * 三条纪律：
 *   · 占位符必须可容错还原 —— 引擎偶尔会吞掉一个不可见字符或插入空格，
 *     还原时要允许「两侧符号缺一个」「中间有空白」。
 *   · 还原失败**绝不把占位符泄漏给用户** —— 退回原文片段是唯一可接受的降级。
 *   · 占位符数量必须守恒。数量对不上说明引擎合并/拆分了条目，
 *     这一条要标记为「不可缓存」，否则一次错译会被缓存粘住。
 *
 * 本模块是纯字符串函数，不碰 chrome.*、不读 DOM，可在 selftest 里直接断言。
 */
(function (root) {
  'use strict';

  var CT = (root.CT = root.CT || {});
  var P = (CT.protect = CT.protect || {});

  /** 占位符两侧的哨兵：私用区字符，正常文本里不可能出现 */
  var OPEN = '\uE000';
  var CLOSE = '\uE001';
  P.OPEN = OPEN;
  P.CLOSE = CLOSE;

  /* ================================================================
   * 一、不可译模式
   * ----------------------------------------------------------------
   * 全部要求**高精确率**而不是高召回：漏保护一个 URL 只是不够好，
   * 误保护一个正常词会让那个词永远不翻，症状更明显也更难解释。
   * 因此每一条都要有明确的「形状」，不靠猜。
   * ================================================================ */
  var PATTERNS = [
    // URL。
    // ------------------------------------------------------------------
    // 只看字符集不足以把 URL 切对：ASCII 的 `. , ; :` 既可能是 URL 的一部分
    // （`a.b/c`），也可能是紧随其后的句读（`见 https://a.com/b.`）。
    // 所以正则先贪心地吃下整段，再由 trimUrlTail() 把**结尾**的句读还回去。
    // 括号类（`(` `)` `【】`）直接从字符集里排除：它们要么是包裹 URL 的句读，
    // 要么（维基式 `.../Foo_(bar)`）在结尾——前者该剥、后者该留，
    // 靠左/右括号计数去猜收益不抵复杂度，统一按「结束」处理。
    /https?:\/\/[^\s<>"'`（）()【】\[\]，。；、]+/g,
    // 邮箱
    /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
    // 模板占位符：{{var}} / ${var} / {name}
    /\{\{[^{}\n]{1,60}\}\}/g,
    /\$\{[^{}\n]{1,60}\}/g,
    /\{[A-Za-z_][A-Za-z0-9_.]{0,39}\}/g,
    // printf 风格：%s %d %i %f %1$s
    /%\d+\$[sdif]|%[sdif]/g,
    // 版本号：v1 / V2.3 / v1.2.3-beta
    /\b[vV]\d+(?:\.\d+){0,3}(?:-[\w.]+)?\b/g,
    // 十六进制颜色 / 长哈希
    /#[0-9A-Fa-f]{3,8}\b/g,
    /\b[0-9a-f]{7,40}\b/g,
    // 路径必须先于文件名。
    // 反过来的话 `src/utils/helper.js` 会先被文件名模式吃掉 `helper.js`，
    // 路径模式随后只能吃到 `src/utils/` —— 两个占位符拼回来虽然一字不差，
    // 但引擎看到的是一段普通文本夹着一个残缺路径，比整段留原样更难保形。
    //
    // 要求**至少两个斜杠**是刻意的精度取舍：像 `input/output`、`and/or`、
    // `client/server` 这类「词/词」在英文技术文里极常见，它们该被翻译；
    // 而真正的路径（`en/docs/intro`、`src/utils/helper.js`）几乎不会只有一个斜杠。
    // 单斜杠 + 带扩展名的情况由下面的文件名模式兜住（`folder/file.txt` 里的
    // `file.txt` 会被保护，只有前缀那一段留在句子里）。
    /\b[\w.-]+(?:\/[\w.-]+){2,}/g,
    /\b[\w-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|json5|css|scss|less|html|htm|py|rb|go|rs|java|kt|c|h|cpp|cs|php|sh|bat|ps1|yml|yaml|toml|ini|env|md|txt|xml|sql|exe|msi|zip|tar|gz|png|jpg|jpeg|gif|webp|svg|ico|mp3|mp4|pdf|docx|xlsx|pptx)\b/gi,
    // 常量风格标识符：全大写下划线，至少两段（USER_ID 这类），单段全大写词太容易误伤
    /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g,
    // 驼峰/下划线函数名：至少含一个内部大写或下划线，排除普通英文词
    /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g,
    /\b[a-zA-Z][a-zA-Z0-9]*_[a-zA-Z0-9_]+\b/g
  ];

  /* ================================================================
   * 二、保护
   * ================================================================ */

  /**
   * 把 URL 末尾的句读符号剥下来，交给占位符之外。
   * ------------------------------------------------------------------
   * `见 https://a.com/b.` 里那个句号是句读，不是 URL 的一部分。
   * 若不剥，占位符会把句号一起包进去，还原后句号仍在原位 —— 文本没错，
   * 但送进引擎的「URL」带着一个从别处粘来的标点，语义上不干净。
   * 只剥 `. , ; : ! ?`：这几个排在 URL 结尾时几乎必然是句读；
   * 而 `https://example.com/v1.2.3` 这类结尾是字母数字，不会被误剥。
   * 括号与引号在字符集层面已被排除，这里不必再管。
   */
  var URL_TAIL_RE = /[.,;:!?]+$/;

  function trimUrlTail(hit) {
    var m = hit.match(URL_TAIL_RE);
    if (!m) return { body: hit, tail: '' };
    // 不必担心剥空：能进这个钩子的匹配都以 `https://` 开头，
    // 切尾永远至少剩下协议部分。
    return { body: hit.slice(0, hit.length - m[0].length), tail: m[0] };
  }

  /**
   * 与 PATTERNS 同下标的「切尾」钩子：把命中切成 { body, tail }，
   * body 进占位符、tail 原样留在原文里。
   */
  var TAIL_HOOKS = [trimUrlTail];

  /** 把 glossary 里的 from 按长度降序 —— 长词优先，否则 'User' 会先吃掉 'User ID' 的前半 */
  function sortTerms(glossary) {
    var out = [];
    if (!glossary || !glossary.length) return out;
    for (var i = 0; i < glossary.length; i++) {
      var t = glossary[i];
      if (!t) continue;
      var from = String(t.from == null ? '' : t.from);
      var to = String(t.to == null ? '' : t.to);
      // 只有 from 有值才有效；to 为空视为「保持原样不翻」，这也是合理用法
      if (!from.trim()) continue;
      out.push({ from: from, to: to, len: from.length });
    }
    out.sort(function (a, b) { return b.len - a.len; });
    return out;
  }
  P.sortTerms = sortTerms;

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * 术语正则缓存（v1.7.3，C-11 H2）。
   * ------------------------------------------------------------------
   * 正则只取决于 term.from 与「是否整词匹配」，与被处理文本无关；
   * 而 mask 每条文本调用一次 —— 缓存前每波要为同一批术语重复编译
   * 近万次 RegExp（实测 24ms/波）。模块级 Map 一次编译终身复用。
   *
   * 全局正则跨调用共享是否安全？String.prototype.replace 对带 /g 的
   * 正则在替换前后都会把 lastIndex 归零，且 replace 是同步操作，
   * 因此共享实例不会泄漏匹配状态（test-perf 有连续调用一致性断言）。
   *
   * 缓存键必须含 wordy 位：同一个 from 的整词/子串两种形态互斥。
   * 容量上限 512：术语表是有限集（基座 94 + 用户表），正常永远触不到；
   * 触到就整体清空 —— 比逐条淘汰简单，且冷编译只发生在下一轮。
   */
  var RE_CACHE = new Map();
  function termRegex(term) {
    var wordy = /[A-Za-z0-9]/.test(term.from);
    var key = (wordy ? 'W\u0001' : 'S\u0001') + term.from;
    var hit = RE_CACHE.get(key);
    if (hit) return hit;
    var body = escapeRe(term.from);
    var re = wordy
      ? new RegExp('(^|[^A-Za-z0-9_])(' + body + ')(?![A-Za-z0-9_])', 'gi')
      : new RegExp(body, 'g');
    var out = { re: re, wordy: wordy };
    if (RE_CACHE.size >= 512) RE_CACHE.clear();
    RE_CACHE.set(key, out);
    return out;
  }

  /**
   * 把一个片段登记进占位符表并返回它的占位符
   * @param {Array<{text: string}>} table
   * @param {string} text 原始片段（保护用）或替换值（术语用）
   */
  function push(table, text) {
    var idx = table.length;
    table.push({ text: text });
    return OPEN + idx.toString(36) + CLOSE;
  }

  /**
   * 保护一段原文
   * @param {string} text
   * @param {{glossary?: Array, protectUntranslatable?: boolean}} opts
   * @returns {{masked: string, table: Array<{text: string, kind: string}>}}
   */
  P.mask = function (text, opts) {
    opts = opts || {};
    var table = [];
    // 术语命中次数。v1.7.1 新增：它是「术语基座到底有没有在起作用」的
    // 唯一直接证据 —— 没有这个数，术语表只能靠肉眼在页面上找。
    // 加在返回值里而不是单独再算一遍：再算一遍就要把匹配逻辑复制第二份，
    // 两份必然漂移。
    var termHits = 0;
    if (!text) return { masked: text || '', table: table, termHits: termHits };

    var out = String(text);

    // ① 先保护不可译片段。
    //    必须在术语之前：术语通常在 URL 里不会出现，但反过来
    //    （术语命中了 URL 的某一段）会破坏 URL 的完整性。
    if (opts.protectUntranslatable !== false) {
      for (var i = 0; i < PATTERNS.length; i++) {
        var hook = TAIL_HOOKS[i];
        out = out.replace(PATTERNS[i], function (hit) {
          var tail = '';
          if (hook) {
            var cut = hook(hit);
            hit = cut.body;
            tail = cut.tail;
          }
          return push(table, hit) + tail;
        });
      }
    }

    // ② 再替换术语。
    //    此时文本里已经含占位符，但占位符只由私用区字符 + 36 进制数字组成，
    //    与自然语言的术语不会互相命中，因此这一轮是安全的。
    var terms = sortTerms(opts.glossary);
    for (var j = 0; j < terms.length; j++) {
      var term = terms[j];
      var re = termRegex(term);
      var wordy = re.wordy;
      // 捕获前缀的写法避免用 lookbehind（Safari 15 之前不支持），
      // 替换时把前缀原样拼回去
      out = out.replace(re.re, function (hit, pre, core) {
        // to 为空串 = 「保持原文不动」，这是术语表里合法且常见的一档
        var value = term.to !== '' ? term.to : (wordy ? core : hit);
        var ph = push(table, value);
        termHits++;
        return (wordy ? pre : '') + ph;
      });
    }

    return { masked: out, table: table, termHits: termHits };
  };

  /** 掩码里是否含有占位符（没有则完全不必走还原，省一次正则） */
  P.hasMask = function (s) {
    if (!s) return false;
    return s.indexOf(OPEN) >= 0 || s.indexOf(CLOSE) >= 0;
  };

  /**
   * 还原占位符
   * ------------------------------------------------------------------
   * 这里的正则**必须要求至少一个哨兵字符在场**。
   * 写成 `OPEN? 数字 CLOSE?` 看着更宽容，实际上是灾难：译文里本来就有
   * 普通数字（「第 1 章」「3 个步骤」），那个 1 会被当成占位符 #1，
   * 于是整段文字被替换成表里的某个片段 —— 越修越错，而且完全静默。
   *
   * 因此分两轮，都要求哨兵在场：
   *   A) 标称形式：OPEN + 编号 + CLOSE
   *   B) 缺尾形式：OPEN + 编号（引擎吞掉了一个不可见字符，这是唯一现实的破损）
   * 「缺头有尾」不单独处理 —— 那种形式与裸数字无法区分，宁可留作残留降级。
   *
   * @param {string} text 引擎返回的译文
   * @param {Array<{text: string}>} table mask 返回的表
   * @returns {{text: string, residue: boolean}}
   *   residue=true 表示还原后仍有无法归属的哨兵，调用方应当**不要缓存**这一条。
   */
  P.restore = function (text, table) {
    var out = String(text == null ? '' : text);
    if (!P.hasMask(out)) {
      // 干净输出：没有哨兵就不可能有占位符需要还原
      return { text: out, residue: false };
    }
    if (!table || !table.length) {
      // 有哨兵却没有表 —— 说明掩码与还原不是同一次配对，只能清掉
      return { text: out.split(OPEN).join('').split(CLOSE).join(''), residue: true };
    }

    function fill(i) {
      return (i >= 0 && i < table.length) ? table[i].text : null;
    }

    // A) 标称形式
    out = out.replace(new RegExp(OPEN + '\\s*([0-9a-z]{1,3})\\s*' + CLOSE, 'g'), function (hit, code) {
      var v = fill(parseInt(code, 36));
      return v === null ? hit : v;
    });

    // B) 缺尾形式
    out = out.replace(new RegExp(OPEN + '\\s*([0-9a-z]{1,3})', 'g'), function (hit, code) {
      var v = fill(parseInt(code, 36));
      return v === null ? hit : v;
    });

    // 还留着哨兵 → 有归属不明的占位符，属降级
    var residue = P.hasMask(out);
    if (residue) {
      // 走到这里的只可能是「编号越界」的占位符（合法编号在上一轮已经换掉了）。
      // 先把整段占位符连同它的编号一起抹掉，再清掉裸露的哨兵 ——
      // 只清哨兵的话会留下编号字符（`链接 ␟z␡` → `链接 z`），
      // 那个 `z` 对用户来说是无来由的乱码，还不如整个消失。
      out = out
        .replace(new RegExp(OPEN + '\\s*[0-9a-z]{1,3}\\s*' + CLOSE, 'g'), '')
        .replace(new RegExp(OPEN + '\\s*[0-9a-z]{1,3}', 'g'), '')
        .split(OPEN).join('')
        .split(CLOSE).join('');
    }
    return { text: out, residue: residue };
  };

  /**
   * 占位符数量守恒校验。
   * 数量对不上 = 引擎合并或拆分了条目，这一条不该进缓存。
   * 同样要求至少一个哨兵在场，否则会把译文里所有数字都数成占位符。
   */
  P.countMasks = function (s) {
    if (!s || !P.hasMask(s)) return 0;
    var re = new RegExp(
      OPEN + '\\s*[0-9a-z]{1,3}\\s*' + CLOSE +   // 完整形式
      '|' + OPEN + '\\s*[0-9a-z]{1,3}' +          // 缺尾
      '|' + OPEN + '|' + CLOSE,                   // 裸露哨兵
      'g'
    );
    var m = String(s).match(re);
    return m ? m.length : 0;
  };

  /**
   * 对一批文本做「送翻前掩码」的批量包装
   * ------------------------------------------------------------------
   * 只返回 masked 与 tables 两个平行数组，**不返回原文** ——
   * 调用方（service-worker）手里本来就有原文，再复制一份纯属浪费内存，
   * 而且两份副本一旦不同步就会引出极难查的错。
   * tables[i] 为 null 表示这一条完全没掩码，还原时可整条跳过。
   *
   * @param {string[]} texts
   * @param {object} opts 同 mask
   * @returns {{masked: string[], tables: Array<Array<{text:string}>|null>}}
   */
  P.maskAll = function (texts, opts) {
    var masked = [];
    var tables = [];
    for (var i = 0; i < texts.length; i++) {
      var r = P.mask(texts[i], opts);
      // 完全没掩码的条目把表置空，后续省掉还原开销
      masked.push(r.masked);
      tables.push(r.table.length ? r.table : null);
    }
    return { masked: masked, tables: tables };
  };

  /**
   * @param {string[]} translations 引擎返回的译文
   * @param {Array} tables maskAll 的表
   * @param {string[]} [maskedInputs] maskAll 产出的掩码文本，用于数量守恒校验
   * @returns {{texts: string[], unclean: boolean[]}}
   *   unclean[i] = true 表示这一条还原不干净（残留哨兵 / 数量不守恒），
   *   调用方应当**跳过缓存** —— 否则一次错译会被缓存长期粘住。
   */
  P.restoreAll = function (translations, tables, maskedInputs) {
    var texts = [];
    var unclean = [];
    for (var i = 0; i < translations.length; i++) {
      var t = translations[i];
      var table = tables[i];
      if (!table) {
        texts.push(t == null ? '' : String(t));
        unclean.push(false);
        continue;
      }
      var r = P.restore(t, table);
      var bad = r.residue;
      if (!bad && maskedInputs && maskedInputs[i] != null) {
        // 数量守恒：送出去几个占位符，就该还原回几个
        if (P.countMasks(maskedInputs[i]) !== P.countMasks(String(t == null ? '' : t))) bad = true;
      }
      texts.push(r.text);
      unclean.push(bad);
    }
    return { texts: texts, unclean: unclean };
  };
})(typeof self !== 'undefined' ? self : this);
