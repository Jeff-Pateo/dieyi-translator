/*
 * 叠译 · 术语基座与治理
 * ==================================================================
 * 【为什么需要这一层】
 * 现场截图：`Senior Growth Product Manager AI Native`
 *      被译成 → 高级**成长**产品经理
 *      （应是 高级**增长**产品经理）
 *
 * 这不是引擎的 bug。**在没有术语约束时，把 Growth 取成「成长」是必然的默认行为** ——
 * 通用翻译模型按「高频义」取词，而 Growth 在通用语料里最高频的义项就是「成长」。
 * 要让它在 Growth Hacking / Growth PM 语境里落到「增长」，只有一条路：
 * **在送翻之前把搭配整体摘出来，用占位符锁死译名**。
 *
 * 而这套机制早在 shared/protect.js 里就实现了（掩码 → 送翻 → 还原）。
 * 问题在于 CT.DEFAULT_SETTINGS.glossary 的默认值是 `[]`：
 * **能力早就有了，数据是零。** 本文件补的就是数据。
 *
 * ==================================================================
 * 【三条硬约束 —— 数据治理口径，不是个人偏好】
 *
 * ① 只收「无歧义搭配」与「专有名词」，**不收多义单词**
 *    `Growth` 单独收进来，会把 "personal growth" 译成「个人增长」，
 *    用一个新的错译换掉一个旧的错译。基座里 Growth 只以
 *    `Growth Product Manager` / `Growth Marketing` 这类搭配出现。
 *    被有意排除的多义词统一登记在 CT.AMBIGUOUS，留痕可查 —— 见下方。
 *
 * ② 指定译名**必须声明目标语言**
 *    这是最容易酿成灾难的一条：若不声明，用户把目标语言设成日语时，
 *    `Product Manager` 会被硬替换成中文「产品经理」。
 *    因此：`to === ''`（保持原样）对**任何**目标语言成立，记 `tgt: '*'`；
 *    给出具体译名的，必须显式写 `tgt`。
 *
 * ③ `to === ''` 表示「保持原样不翻」，不是「删除」
 *    用于品牌名、代号、缩写（Magic Eden / NFT / Kubernetes / KPI）。
 *    截图的 `Magic Eden 魔法伊甸园` 就是这条缺失的直接后果。
 *
 * ==================================================================
 * 【与缓存的关系 —— 一条本轮修掉的真实缺陷】
 * background/cache.js 的键是 `provider|source|target|原文哈希`，
 * **刻意不含术语表**（原注释：「掩码只是传输层的临时形态，绝不能进入缓存键，
 * 否则换了术语表就全部失效」）。
 * 这个取舍的后果是：**用户改了术语表，旧译文照样命中缓存** ——
 * 表现就是「怎么改都不生效」，而这正是「翻译不准确」投诉里最难自证的一类。
 * 本轮改为把**术语基座哈希**（而非全表文本）并进缓存键：
 * 术语不变 → 哈希不变 → 缓存照常命中；术语变了 → 哈希变 → 旧译文自然失效。
 */
(function (root) {
  'use strict';

  var CT = (root.CT = root.CT || {});

  /* ==================================================================
   * 一、治理版本与分域
   * ================================================================== */

  /*
   * 基座版本号。**改动基座必须同时改这里** —— 它参与 termHash，
   * 因此一次版本号提升会自动让全站旧译文失效并重译。
   * 格式：YYYY.MM.DD-序号
   */
  CT.TERMINOLOGY_VERSION = '2026.09.27-2';

  CT.TERM_DOMAINS = [
    { id: 'recruiting', label: '招聘与职位' },
    { id: 'product', label: '产品与互联网' },
    { id: 'tech', label: '技术与工程' },
    { id: 'business', label: '商务与组织' },
    { id: 'proper', label: '专有名词（保持原样）' }
  ];

  /* ==================================================================
   * 二、被有意排除的多义词（治理留痕）
   * ----------------------------------------------------------------
   * 这张表**不参与翻译**，只用于两件事：
   *   1) 审计时输出 —— 说明「为什么这个词没在基座里」，避免后续维护者
   *      凭直觉把它加进来，把问题重新引入；
   *   2) 给设置页的术语提示做素材。
   * ================================================================== */
  CT.AMBIGUOUS = [
    { word: 'Growth', why: '单独出现时通用义是「成长」，仅在产品/营销搭配下才是「增长」。因此只收搭配。' },
    { word: 'Executive', why: '可能是「高管」也可能是「行政」。v1.7.2 起在招聘场景下收场景限定条目 Executive→高管（见 scenes 字段）；无场景信息时仍不收。' },
    { word: 'Promotion', why: '职场语境是「晋升」，营销语境是「促销」。需搭配才可判定。' },
    { word: 'Retention', why: '人力语境是「员工留存」，产品语境是「用户留存」，法规语境是「留存期限」。' },
    { word: 'Onboarding', why: '员工入职 vs 用户引导，含义完全不同。只收 Employee Onboarding / User Onboarding。' },
    { word: 'Equity', why: '薪酬语境是「股权」，金融语境是「权益」/「净资产」。基座只收薪酬搭配。' },
    { word: 'Roadmap', why: '多为「路线图」，但单独出现时归属不明（产品/技术/学习）。保留为通用词，交由引擎处理。' },
    { word: 'Runway', why: '创业语境是「现金跑道」，时尚语境是「T 台」。只收 Cash Runway。' },
    { word: 'Crypto', why: '当前语境多为「加密货币」，但密码学语境是「加密」。不收。' },
    { word: 'Framework', why: '技术/法律/管理三个语境都成立且译名相同（框架），无歧义风险，故也未必要收。' }
  ];

  /* ==================================================================
   * 三、术语基座
   * ----------------------------------------------------------------
   * 字段：
   *   from   原词/搭配（必填）。含拉丁字母的走「整词 + 忽略大小写」匹配，
   *          纯 CJK 走子串匹配（见 shared/protect.js#mask）
   *   to     目标译名。空串 = 保持原样不翻
   *   domain 所属域，用于分域开关
   *   scenes 可选。限定条目只在哪些场景下生效（如 ['recruiting']）。
   *          缺省 = 全场景生效。多义单词靠它消歧后才能收进基座 ——
   *          这是治理规则 G1 的延伸而不是违反：无场景信息时依然不生效。
   *   tgt    目标语言。省略时默认 'zh-CN'；`to === ''` 的条目自动视为 '*'
   *   note   译法依据（只给人看，不参与匹配）
   *
   * 排序无关紧要：protect.js 的 sortTerms 会按 from 长度降序重排，
   * 长搭配优先命中，因此 `Growth Product Manager` 必然先于 `Product Manager`。
   * ================================================================== */
  CT.TERMINOLOGY = [
    /* ---------------- 招聘与职位 ---------------- */
    { from: 'Growth Product Manager', to: '增长产品经理', domain: 'recruiting', note: '截图现场词。Growth 在此为「增长」，非「成长」。' },
    { from: 'Growth Marketing', to: '增长营销', domain: 'recruiting' },
    { from: 'Growth Hacker', to: '增长黑客', domain: 'recruiting' },
    { from: 'Growth Hacking', to: '增长黑客', domain: 'recruiting' },
    { from: 'Senior Product Manager', to: '高级产品经理', domain: 'recruiting' },
    { from: 'Technical Product Manager', to: '技术产品经理', domain: 'recruiting' },
    { from: 'Associate Product Manager', to: '产品经理（初级）', domain: 'recruiting' },
    { from: 'Product Manager', to: '产品经理', domain: 'recruiting', note: '截图标签行原词。' },
    { from: 'Product Designer', to: '产品设计师', domain: 'recruiting' },
    { from: 'Data Analyst', to: '数据分析师', domain: 'recruiting' },
    { from: 'Data Scientist', to: '数据科学家', domain: 'recruiting' },
    { from: 'Software Engineer', to: '软件工程师', domain: 'recruiting' },
    { from: 'Marketing Manager', to: '市场经理', domain: 'recruiting' },
    { from: 'Marketing', to: '市场营销', domain: 'recruiting', note: '截图标签行原词。英文 Marketing 兼指「市场」与「营销」，中文职场习惯合称「市场营销」。' },
    { from: 'Full Stack', to: '全栈', domain: 'recruiting' },
    { from: 'Frontend', to: '前端', domain: 'recruiting' },
    { from: 'Backend', to: '后端', domain: 'recruiting' },
    { from: 'Job Description', to: '职位描述', domain: 'recruiting' },
    { from: 'Compensation', to: '薪酬', domain: 'recruiting' },
    { from: 'Notice Period', to: '通知期', domain: 'recruiting' },
    { from: 'Probation', to: '试用期', domain: 'recruiting' },
    { from: 'Severance', to: '离职补偿', domain: 'recruiting' },
    { from: 'Performance Review', to: '绩效评估', domain: 'recruiting' },
    { from: 'Remote Work', to: '远程办公', domain: 'recruiting' },
    { from: 'Hybrid Work', to: '混合办公', domain: 'recruiting' },
    { from: 'Employee Onboarding', to: '员工入职', domain: 'recruiting' },

    /* --- v1.7.2：场景限定条目（scenes 字段）---
     * 多义单词只在特定场景下收，消歧条件写进数据 —— 这是 G1 的延伸
     * 而不是违反：无场景信息时它们依然不生效（mergeGlossary 过滤）。
     * 现场依据：docs/测试反馈-v1.7.2.md F4/F5/F8。 */
    { from: 'Apply', to: '申请', domain: 'recruiting', scenes: ['recruiting'],
      note: '职位卡行动按钮。通用语境 Apply=应用（应用设置/应用滤镜），仅在招聘场景锁定为「申请」。' },
    { from: 'Executive', to: '高管', domain: 'recruiting', scenes: ['recruiting'],
      note: '招聘标签 = 职能层级。现场被译为「行政」。无场景时不生效（歧义留痕见 AMBIGUOUS）。' },
    { from: 'Senior', to: '高级', domain: 'recruiting', scenes: ['recruiting'],
      note: '招聘标签 = 资历层级。与基座既有搭配（Senior Product Manager→高级产品经理）的「高级」保持一致。' },
    { from: 'Junior', to: '初级', domain: 'recruiting', scenes: ['recruiting'] },
    { from: 'Medical', to: '医疗', domain: 'recruiting', scenes: ['recruiting'],
      note: '招聘标签指医疗领域。' },
    { from: 'Communications', to: '传播', domain: 'recruiting', scenes: ['recruiting'],
      note: '职位语境 = 传播/公关，非「通信」。技术语境（通信工程）不受影响 —— 场景限定。' },

    /* --- v1.7.2：整句高频 UI 文案 ---
     * 现场依据：F7「Upgrade to Premium to s…」被译成「升级到保要查看薪水」。
     * 截断短文本交给引擎必乱，整句条目是术语粒度的合理延伸。
     * 用 scenes 限定，避免其他站点偶现的同形文本误命中。 */
    { from: 'Upgrade to Premium to see salary', to: '升级到 Premium 查看薪水',
      domain: 'recruiting', scenes: ['recruiting'], note: 'remoteok 高频 UI 文案。' },

    /* ---------------- 产品与互联网 ---------------- */
    { from: 'Product Requirement Document', to: '产品需求文档', domain: 'product' },
    { from: 'Product Roadmap', to: '产品路线图', domain: 'product' },
    { from: 'North Star Metric', to: '北极星指标', domain: 'product' },
    { from: 'User Story', to: '用户故事', domain: 'product' },
    { from: 'User Retention', to: '用户留存', domain: 'product' },
    { from: 'User Onboarding', to: '用户引导', domain: 'product' },
    { from: 'Churn Rate', to: '流失率', domain: 'product' },
    { from: 'Conversion Rate', to: '转化率', domain: 'product' },
    { from: 'A/B Testing', to: 'A/B 测试', domain: 'product' },
    { from: 'A/B Test', to: 'A/B 测试', domain: 'product' },
    { from: 'Feature Flag', to: '功能开关', domain: 'product' },
    { from: 'Release Notes', to: '更新日志', domain: 'product' },
    { from: 'Design System', to: '设计系统', domain: 'product' },
    { from: 'Landing Page', to: '落地页', domain: 'product' },

    /* ---------------- 技术与工程 ---------------- */
    { from: 'Pull Request', to: '拉取请求', domain: 'tech' },
    { from: 'Stack Trace', to: '堆栈跟踪', domain: 'tech' },
    { from: 'Unit Test', to: '单元测试', domain: 'tech' },
    { from: 'Rate Limit', to: '限流', domain: 'tech' },
    { from: 'Rate Limiting', to: '限流', domain: 'tech' },
    { from: 'Throughput', to: '吞吐量', domain: 'tech' },
    { from: 'Refactoring', to: '重构', domain: 'tech' },
    { from: 'Open Source', to: '开源', domain: 'tech' },
    { from: 'Deployment', to: '部署', domain: 'tech' },
    { from: 'Latency', to: '延迟', domain: 'tech' },
    { from: 'Rollback', to: '回滚', domain: 'tech' },
    { from: 'Containerization', to: '容器化', domain: 'tech' },

    /* ---------------- 商务与组织 ---------------- */
    { from: 'Stakeholder', to: '利益相关方', domain: 'business' },
    { from: 'Headcount', to: '编制', domain: 'business' },
    { from: 'Due Diligence', to: '尽职调查', domain: 'business' },
    { from: 'Term Sheet', to: '投资条款清单', domain: 'business' },
    { from: 'Cash Runway', to: '现金跑道', domain: 'business' },
    { from: 'Burn Rate', to: '烧钱率', domain: 'business' },
    { from: 'Gross Margin', to: '毛利率', domain: 'business' },
    { from: 'Series A', to: 'A 轮', domain: 'business' },
    { from: 'Series B', to: 'B 轮', domain: 'business' },
    { from: 'Equity Compensation', to: '股权激励', domain: 'business' },
    { from: 'Vesting', to: '归属', domain: 'business' },

    /* ---------------- 专有名词（保持原样） ----------------
     * to 为空串 = 送翻前摘出来、送翻后原样放回。
     * 这一档同时覆盖「产品名」「代号」「业内通用缩写」。 */
    { from: 'Magic Eden', to: '', domain: 'proper', note: '截图现场：被译为「魔法伊甸园」。品牌名不应意译。' },
    /* --- v1.7.2 补充品牌（现场依据：docs/测试反馈-v1.7.2.md F1–F3）--- */
    { from: 'GiveWell', to: '', domain: 'proper', note: '公益机构品牌。现场被译为「让步」，语义完全错误。' },
    { from: 'Sticker Mule', to: '', domain: 'proper', note: '公司名。现场被逐字直译为「贴纸骡子」。' },
    { from: 'Harper', to: '', domain: 'proper', note: '公司名。现场被音译为「哈珀」。' },
    { from: 'RemoteOK', to: '', domain: 'proper', note: '站点名。' },
    { from: 'TLM', to: '', domain: 'proper', note: '职位名缩写（Tech Lead Manager 等），保持原样。' },
    { from: 'NFT', to: '', domain: 'proper' },
    { from: 'DeFi', to: '', domain: 'proper' },
    { from: 'Web3', to: '', domain: 'proper' },
    { from: 'TypeScript', to: '', domain: 'proper' },
    { from: 'JavaScript', to: '', domain: 'proper' },
    { from: 'Kubernetes', to: '', domain: 'proper' },
    { from: 'Docker', to: '', domain: 'proper' },
    { from: 'GitHub', to: '', domain: 'proper' },
    { from: 'Golang', to: '', domain: 'proper' },
    { from: 'Rust', to: '', domain: 'proper', note: '语言名，与「铁锈」同形。保持原样可同时规避误译。' },
    { from: 'CI/CD', to: '', domain: 'proper' },
    { from: 'KPI', to: '', domain: 'proper', note: '中文职场普遍直接说 KPI。' },
    { from: 'OKR', to: '', domain: 'proper' },
    { from: 'PRD', to: '', domain: 'proper', note: '中文产品圈普遍直接说 PRD。' },
    { from: 'API', to: '', domain: 'proper' },
    { from: 'SDK', to: '', domain: 'proper' },
    { from: 'SQL', to: '', domain: 'proper' },
    { from: 'SaaS', to: '', domain: 'proper' }
  ];

  /* ==================================================================
   * 四、哈希
   * ----------------------------------------------------------------
   * 只用于「判断术语集合有没有变」，不用于安全用途。
   * 必须把 TERMINOLOGY_VERSION 一起拌进去：否则基座新增了一条术语、
   * 但用户 glossary 未动时，哈希不变 → 缓存里那条错译永远不被纠正。
   * ================================================================== */
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

  /**
   * @param {Array<{from:string,to:string}>} list 已合并的生效术语表
   * @returns {string} 短哈希
   */
  function termHash(list) {
    var parts = [];
    if (list && list.length) {
      for (var i = 0; i < list.length; i++) {
        parts.push(String(list[i].from) + '\u0000' + String(list[i].to));
      }
    }
    // 排序后再哈希：合并顺序变化不应导致缓存整体失效
    parts.sort();
    return fnv1a(CT.TERMINOLOGY_VERSION + '\u0001' + parts.join('\u0002'));
  }

  /* ==================================================================
   * 五、合并：用户术语表 + 基座 → 生效术语表
   * ----------------------------------------------------------------
   * 优先级：**用户 > 基座**。
   * 实现方式：用户表先入、基座后入，同名（忽略大小写）先到先得。
   * 因此用户写 `{ from: 'Product Manager', to: '产品负责人' }`
   * 会整体覆盖基座里的「产品经理」，不会被基座反向覆盖。
   *
   * 若用户想「关掉」基座某条术语，把 to 写成空串即可 ——
   * 语义是「保持原样不翻」，与删除效力相当但更明确。
   * ================================================================== */
  function normKey(from) {
    return String(from == null ? '' : from).trim().toLowerCase();
  }

  /**
   * @param {Array} [userGlossary] settings.glossary
   * @param {{targetLang?:string, domains?:Array<string>|null}} [opts]
   *        domains 省略 / null / **空数组** = 启用全部域
   *
   * 为什么要接受空数组：设置页存不了 null —— 保存链路用的合并函数
   * 会丢弃值为 null / undefined 的补丁字段。于是「全选」只能用空数组表达。
   * 若把空数组当成「一个域都不开」，用户点一下「全选」就会得到零术语，
   * 症状是「基座开着但完全没生效」。因此这里把空数组与 null 归一。
   *
   * @returns {Array<{from:string,to:string}>} 可直接交给 protect.mask 的表
   */
  function mergeGlossary(userGlossary, opts) {
    opts = opts || {};
    var target = opts.targetLang || 'zh-CN';
    var domains = (opts.domains && opts.domains.length) ? opts.domains : null;
    // 场景：请求方（content 探测后）随翻译请求携带。空 = 无场景信息，
    // 此时带 scenes 字段的条目一律不生效 —— G1 的保守性由这里兜底。
    var scenes = (opts.scenes && opts.scenes.length) ? opts.scenes : null;
    var out = [];
    var seen = Object.create(null);

    function add(from, to) {
      var f = String(from == null ? '' : from);
      if (!f.trim()) return false;                 // 空 from 无意义
      var key = normKey(f);
      if (seen[key]) return false;                 // 先到先得 = 高优先级先入
      seen[key] = true;
      out.push({ from: f, to: String(to == null ? '' : to) });
      return true;
    }

    // ① 用户表优先
    if (Array.isArray(userGlossary)) {
      for (var i = 0; i < userGlossary.length; i++) {
        var t = userGlossary[i];
        if (t) add(t.from, t.to);
      }
    }

    // ② 基座（受分域开关、目标语言、场景三层过滤）
    var base = CT.TERMINOLOGY;
    for (var j = 0; j < base.length; j++) {
      var e = base[j];
      if (!e) continue;
      if (domains && domains.indexOf(e.domain) < 0) continue;
      // 场景过滤：条目声明了 scenes 但当前场景不在其中 → 不生效。
      // 过滤放在域开关之后：用户关掉整个域，场景条目同样被关 —— 用户设置优先。
      if (e.scenes && e.scenes.length) {
        if (!scenes) continue;
        var scHit = false;
        for (var si = 0; si < e.scenes.length; si++) {
          if (scenes.indexOf(e.scenes[si]) >= 0) { scHit = true; break; }
        }
        if (!scHit) continue;
      }
      // 保持原样的条目对所有目标语言都成立；给出译名的必须匹配目标语言
      var keepAsIs = e.to === '';
      var tgt = e.tgt || 'zh-CN';
      if (!keepAsIs && tgt !== target) continue;
      add(e.from, e.to);
    }

    return out;
  }

  /* ==================================================================
   * 六、审计：把「数据质量问题」变成可执行结论
   * ----------------------------------------------------------------
   * 为什么必须自动化：术语表是**沉默生效**的 —— 一条写错的术语不会报错，
   * 只会安静地把所有页面上的某个词译错。等用户发现时，问题已经扩散到
   * 整站、整缓存。因此每次保存术语表前都该跑一遍本函数。
   * ================================================================== */
  var PUA_OPEN = '\uE000';
  var PUA_CLOSE = '\uE001';

  /** 是否含拉丁字母或数字 */
  function hasLatin(s) { return /[A-Za-z0-9]/.test(s); }
  /** 是否含 CJK（含扩展区与兼容区） */
  function hasCJK(s) { return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(s); }

  /**
   * @param {Array} list 待审计的表（通常是用户 glossary，或合并后的全表）
   * @returns {{errors:Array, warnings:Array, stats:Object}}
   */
  function auditGlossary(list) {
    var errors = [];
    var warnings = [];
    var stats = {
      total: 0, keepAsIs: 0, translated: 0,
      byDomain: Object.create(null), byTgt: Object.create(null)
    };
    var seen = Object.create(null);

    if (!Array.isArray(list)) {
      errors.push({ from: null, code: 'not-array', msg: '术语表不是数组' });
      return { errors: errors, warnings: warnings, stats: stats };
    }

    for (var i = 0; i < list.length; i++) {
      var t = list[i] || {};
      var from = String(t.from == null ? '' : t.from);
      var to = String(t.to == null ? '' : t.to);
      stats.total++;

      if (!from.trim()) {
        errors.push({ from: from, code: 'empty-from', msg: '第 ' + (i + 1) + ' 条 from 为空，会被静默丢弃' });
        continue;
      }
      if (to.indexOf(PUA_OPEN) >= 0 || to.indexOf(PUA_CLOSE) >= 0) {
        errors.push({ from: from, code: 'pua-in-to', msg: '译名含占位符专用私用区字符（U+E000/U+E001），会破坏还原逻辑' });
      }
      if (!hasLatin(from) && hasCJK(from) && from.trim().length < 2) {
        errors.push({ from: from, code: 'cjk-too-short', msg: '纯 CJK 且长度 < 2，按子串匹配会大面积误伤，拒绝启用' });
      }
      // 两个字母以内的拉丁词留给人工复核。protect.mask 已经加了词边界，
      // 因此 `Go` 不会命中 `Google`；但 `AI` / `IT` / `HR` 这类词在不同
      // 语境里是不是同一个概念，机器判不了 —— 报出来让人看一眼，比静默收下好。
      if (hasLatin(from) && from.trim().length > 0 && from.trim().length < 3) {
        warnings.push({ from: from, code: 'latin-too-short', msg: '拉丁词长度 ≤ 2，覆盖范围容易被低估（如 Go / AI / IT），建议复核' });
      }
      if (to === '') {
        stats.keepAsIs++;
      } else {
        stats.translated++;
        if (to.indexOf('\n') >= 0 || to.indexOf('\t') >= 0) {
          warnings.push({ from: from, code: 'newline-in-to', msg: '译名含换行/制表符，会影响译文排版' });
        }
        if (to.length > 12 && to.length > from.length * 3) {
          warnings.push({ from: from, code: 'length-bloat', msg: '译名长度是原文 3 倍以上且超过 12 字，可能在窄容器里造成排版膨胀' });
        }
      }

      var key = normKey(from);
      if (seen[key]) {
        var prev = seen[key];
        if (prev.to !== to) {
          warnings.push({ from: from, code: 'conflict', msg: '与第 ' + prev.at + ' 条同词不同译（' + prev.to + ' / ' + to + '），先到者生效' });
        } else {
          warnings.push({ from: from, code: 'duplicate', msg: '与第 ' + prev.at + ' 条重复' });
        }
      } else {
        seen[key] = { to: to, at: i + 1 };
      }

      if (t.domain) stats.byDomain[t.domain] = (stats.byDomain[t.domain] || 0) + 1;
      var tk = to === '' ? '*' : (t.tgt || 'zh-CN');
      stats.byTgt[tk] = (stats.byTgt[tk] || 0) + 1;
    }

    return { errors: errors, warnings: warnings, stats: stats };
  }

  /**
   * 记念化的「合并 + 哈希」打包（v1.7.3，C-11 H4）。
   * ------------------------------------------------------------------
   * 同一次翻译会话里，mergeGlossary 的全部输入（用户表、目标语言、
   * 域开关、场景）逐波不变，但 worker 的 handleTranslate 每波都会
   * 重算一遍 merge + hash。这里按输入指纹缓存结果 ——
   * 指纹必须含**全部**输入，少一项就是「设置改了还返回旧缓存」。
   *
   * 容量上限 8：设置组合的合法变化只有几种（语言 × 域开关 × 场景），
   * 越界直接清空重建，比 LRU 简单且足够。
   */
  var bundleCache = new Map();
  function glossaryBundle(userGlossary, opts) {
    opts = opts || {};
    var key = JSON.stringify([opts.targetLang || null, opts.domains || null, opts.scenes || null, userGlossary || null]);
    var hit = bundleCache.get(key);
    if (hit) return hit;
    var list = mergeGlossary(userGlossary, opts);
    var out = { list: list, hash: list.length ? termHash(list) : '0' };
    if (bundleCache.size >= 8) bundleCache.clear();
    bundleCache.set(key, out);
    return out;
  }

  /* ==================================================================
   * 七、目标侧同语言跨度（B2-1，C-63；口径依 D-B2-01 §2.2 G1）
   * ----------------------------------------------------------------
   * `extractTargetSpan(prev, to)`：prev 与 to **同为中文**，求唯一连续
   * 改动跨度 {removed:R, added:A}。纯函数：不碰 chrome.*、不读 DOM。
   *
   * 用途：worker 的 deriveLearnCandidate 先在此拿到「改掉了什么（R）/
   * 换成了什么（A）」，再做源侧反查（G2）/ 短单元回退（G3）。
   *
   * 判定：
   *   ① 前缀 + 后缀剥离 → 唯一改动块（R 与 A）。
   *   ② 词级多段收口：R、A 按空白分词、剥共同词前后缀后两侧仍含共同词
   *      → ≥2 段 → null。（**已知边界**：无空格纯 CJK 的双改动无法切分，
   *      按单跨度处理 —— D-B2-01 §5② 已登记，v1 接受。）
   *   ③ 逐侧长度阈值（目标侧；空侧=纯增/删跳过）：含字母 → ≥3 或含空格；
   *      纯 CJK → ≥2；既非字母亦非 CJK（纯数字/符号）→ 不学。
   *   ④ 不含换行。
   *
   * 注意：与旧 `extractCorrectionSpan(from,to)` 不同 —— 旧签名吃的是
   * 「源语原文 → 目标语译文」跨语言对，已作废（D-B2-01 §1）。本函数
   * 只吃**同语言**的 (prev, to)。
   *
   * @param {string} prev 该单元当前/旧译文（中文）
   * @param {string} to   用户新译文（中文）
   * @returns {{removed:string,added:string}|null}
   * ================================================================== */
  function extractTargetSpan(prev, to) {
    var p = String(prev == null ? '' : prev);
    var t = String(to == null ? '' : to);
    if (!p || !t || p === t) return null;

    var pl = p.length;
    var tl = t.length;
    var max = Math.min(pl, tl);

    var pfx = 0;
    while (pfx < max && p.charAt(pfx) === t.charAt(pfx)) pfx++;
    var sfx = 0;
    while (sfx < (max - pfx) && p.charAt(pl - 1 - sfx) === t.charAt(tl - 1 - sfx)) sfx++;

    var R = p.slice(pfx, pl - sfx);
    var A = t.slice(pfx, tl - sfx);
    if (!R && !A) return null;

    // ② 词级多段收口（纯 CJK 无空格 → 单跨度，见已知边界）
    if (R && A) {
      var rw = R.split(/\s+/).filter(function (x) { return x; });
      var aw = A.split(/\s+/).filter(function (x) { return x; });
      var wp = 0;
      while (wp < rw.length && wp < aw.length && normKey(rw[wp]) === normKey(aw[wp])) wp++;
      var ws = 0;
      while (
        ws < (rw.length - wp) && ws < (aw.length - wp) &&
        normKey(rw[rw.length - 1 - ws]) === normKey(aw[aw.length - 1 - ws])
      ) ws++;
      var rRest = rw.slice(wp, rw.length - ws);
      var aRest = aw.slice(wp, aw.length - ws);
      if (rRest.length && aRest.length) {
        var seen = Object.create(null);
        for (var i = 0; i < rRest.length; i++) seen[normKey(rRest[i])] = true;
        for (var j = 0; j < aRest.length; j++) {
          if (seen[normKey(aRest[j])]) return null;
        }
      }
    }

    R = R.trim();
    A = A.trim();
    if (!R && !A) return null;

    // ④ 换行
    if (/[\r\n]/.test(R) || /[\r\n]/.test(A)) return null;

    // ③ 逐侧长度阈值
    function sideOk(s) {
      if (!s) return true;
      var latin = /[A-Za-z]/.test(s);
      var cjk = hasCJK(s);
      if (!latin && !cjk) return false;
      if (latin) return s.length >= 3 || /\s/.test(s);
      return s.length >= 2;
    }
    if (!sideOk(R) || !sideOk(A)) return null;

    return { removed: R, added: A };
  }

  /* ---------------- 导出 ---------------- */
  CT.terminology = {
    VERSION: CT.TERMINOLOGY_VERSION,
    DOMAINS: CT.TERM_DOMAINS,
    BASE: CT.TERMINOLOGY,
    AMBIGUOUS: CT.AMBIGUOUS,
    mergeGlossary: mergeGlossary,
    termHash: termHash,
    glossaryBundle: glossaryBundle,
    auditGlossary: auditGlossary,
    extractTargetSpan: extractTargetSpan,
    _internals: { normKey: normKey, fnv1a: fnv1a, hasLatin: hasLatin, hasCJK: hasCJK }
  };
})(typeof self !== 'undefined' ? self : this);
