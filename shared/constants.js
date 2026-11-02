/*
 * 叠译 · 共享常量
 * ------------------------------------------------------------------
 * 本文件同时被两种运行环境加载：
 *   1) content script —— 普通脚本，多个文件共享同一个 isolated world 全局作用域
 *   2) service worker —— ES Module（manifest 中 "type": "module"）
 *
 * 为兼容两者，这里采用 UMD 风格：不使用 import / export，
 * 只把常量挂载到全局 CT 命名空间上。
 * service worker 侧通过 `import '../shared/constants.js'` 触发副作用即可。
 */
(function (root) {
  'use strict';

  var CT = (root.CT = root.CT || {});

  /* ---------------- 消息协议 ---------------- */
  CT.MSG = {
    // content <-> background
    GET_SETTINGS: 'ct:get-settings',
    SET_SETTINGS: 'ct:set-settings',
    TRANSLATE: 'ct:translate',
    // v1.7.4（C-13 Q3）：页内纠错。content 的译文悬停「改」入口提交修正译文，
    // 后台存进 settings.corrections（整句精确匹配，组批前短路）。
    SAVE_CORRECTION: 'ct:save-correction',
    // v1.8.0（B2-1，C-63）：个人词典学习闭环。
    //   LEARN_PATTERN  —— 用户在确认卡点「加入/替换并加入」后，把词级候选写进 glossary。
    //   DISMISS_PATTERN —— 用户点「不用了」，按候选键记 dismissed，同候选不再弹。
    LEARN_PATTERN: 'ct:learn-pattern',
    DISMISS_PATTERN: 'ct:dismiss-pattern',
    PROBE_PROVIDER: 'ct:probe-provider',
    PREPARE_MODEL: 'ct:prepare-model',
    CACHE_STATS: 'ct:cache-stats',
    CACHE_CLEAR: 'ct:cache-clear',
    REPORT: 'ct:report',            // content -> background 上报本页统计
    GET_TAB_STATS: 'ct:get-tab-stats',
    // popup/options -> content
    CMD: 'ct:cmd',
    PING: 'ct:ping',
    // popup/options -> background 的辅助接口
    SEND_COMMAND: 'ct:send-command',
    BUILTIN_AVAILABILITY: 'ct:builtin-availability',
    // content（页内开关）-> background：content script 里没有
    // chrome.runtime.openOptionsPage，必须由后台代为打开
    OPEN_OPTIONS: 'ct:open-options',
    // PDF 查看器 -> background：用户想改用浏览器自带的查看器。
    // 后台需要先撤掉重定向规则，否则用户一跳转又被拦回查看器 —— 死循环。
    PDF_NATIVE: 'ct:pdf-native'
  };

  /* ---------------- 翻译引擎 ---------------- */
  CT.PROVIDERS = [
    { id: 'auto', label: '自动（优先本地模型，不可用时降级 Google）' },
    { id: 'chrome-builtin', label: 'Chrome 内置翻译模型（本地 · 免费 · 不出网）' },
    { id: 'google-free', label: 'Google 翻译公开接口（免费 · 无需 Key）' },
    { id: 'deepl', label: 'DeepL（需 API Key · 质量高）' },
    { id: 'openai', label: 'OpenAI 兼容接口（需 Base URL + Key · 可自定义提示词）' }
  ];

  /* ---------------- 展示模式 ----------------
   * 文案里刻意【不写「中文」】。目标语言现在有 41 种可选，
   * 「只显示中文」「悬停查看中文」在 en→ja、zh→en 这些语向下就是错的 ——
   * 用户看到的是日语却被提示「悬停查看中文」。
   */
  CT.DISPLAY_MODES = [
    { id: 'below', label: '原文下方双语（推荐）' },
    { id: 'replace', label: '仅显示译文（原文可一键还原）' },
    { id: 'hover', label: '悬停查看译文' }
  ];

  /* ---------------- 译文插入方式（仅「原文下方双语」模式有效） ---------------- */
  CT.INSERT_MODES = [
    { id: 'auto', label: '智能分流（推荐 · 按容器类型自动选择插入点）' },
    { id: 'inside', label: '总是追加到原文单元内部' },
    { id: 'sibling', label: '总是插到原文之后（原文元素盒子完全不变）' }
  ];

  /* ---------------- 译文样式 ---------------- */
  CT.TRANS_STYLES = [
    { id: 'plain', label: '素净（推荐 · 不加边框、不加标记，仅字号略小）' },
    { id: 'accent', label: '标注（左侧竖线 + 「译」标记）' }
  ];

  /* ---------------- 划词触发方式 ---------------- */
  CT.SELECTION_TRIGGERS = [
    { id: 'auto', label: '松开鼠标即翻译（最直接，每次划词都会请求）' },
    { id: 'icon', label: '先显示小图标，点击才翻译（省接口额度）' }
  ];

  /* ---------------- 页内可绑定动作 ----------------
   * 这一层与 chrome.commands 的全局快捷键是两回事：
   *   全局键在 chrome://extensions/shortcuts 改，作用于所有标签页，页面无需聚焦；
   *   页内键在这里改，只在当前页面获得焦点时生效。
   * 之所以必须有第二层，是因为 Chrome 不允许扩展程序化修改全局快捷键。
   */
  CT.BINDABLE_ACTIONS = [
    { id: 'toggle', label: '开启 / 关闭当前页面翻译' },
    { id: 'mode', label: '循环切换显示方式' },
    { id: 'selection', label: '用当前选区触发划词翻译' }
  ];

  /**
   * 全局快捷键（chrome.commands）。页内绑定若与这些冲突会被自动剔除 ——
   * 否则一次按键会同时触发全局与页内两条路径。
   * 这里的字面量必须与 manifest.json 的 commands 保持一致。
   */
  CT.RESERVED_COMBOS = ['Alt+Shift+T', 'Alt+Shift+Y'];

  /* ---------------- 语言表 ----------------
   * 一张表同时供三处使用：源语言下拉、目标语言下拉、以及译文上的语种标记。
   * 刻意做成「单一数据源」—— 之前把源语言列了 16 种、目标语言只列了 2 种
   * （简体/繁体），于是「多语言互译」在界面上根本无从选起。
   *
   * mark 是译文块左上角那个小标记的字面量（标注样式下显示）。
   * 中文用单字（中/繁），拉丁与西里尔用两字母大写，其他用母语首字 —— 都要能
   * 在 12px 见方的位置上一眼认出来。
   */
  CT.LANGS = [
    { id: 'zh-CN', label: '简体中文', mark: '中' },
    { id: 'zh-TW', label: '繁体中文', mark: '繁' },
    { id: 'en', label: '英语 English', mark: 'EN' },
    { id: 'ja', label: '日语 日本語', mark: '日' },
    { id: 'ko', label: '韩语 한국어', mark: '한' },
    { id: 'fr', label: '法语 Français', mark: 'FR' },
    { id: 'de', label: '德语 Deutsch', mark: 'DE' },
    { id: 'es', label: '西班牙语 Español', mark: 'ES' },
    { id: 'pt', label: '葡萄牙语 Português', mark: 'PT' },
    { id: 'it', label: '意大利语 Italiano', mark: 'IT' },
    { id: 'ru', label: '俄语 Русский', mark: 'RU' },
    { id: 'ar', label: '阿拉伯语 العربية', mark: 'ع' },
    { id: 'th', label: '泰语 ไทย', mark: 'ไทย' },
    { id: 'vi', label: '越南语 Tiếng Việt', mark: 'VI' },
    { id: 'nl', label: '荷兰语 Nederlands', mark: 'NL' },
    { id: 'pl', label: '波兰语 Polski', mark: 'PL' },
    { id: 'tr', label: '土耳其语 Türkçe', mark: 'TR' },
    { id: 'id', label: '印尼语 Bahasa Indonesia', mark: 'ID' },
    { id: 'ms', label: '马来语 Bahasa Melayu', mark: 'MS' },
    { id: 'hi', label: '印地语 हिन्दी', mark: 'हि' },
    { id: 'bn', label: '孟加拉语 বাংলা', mark: 'বাং' },
    { id: 'ta', label: '泰米尔语 தமிழ்', mark: 'த' },
    { id: 'fa', label: '波斯语 فارسی', mark: 'FA' },
    { id: 'he', label: '希伯来语 עברית', mark: 'ע' },
    { id: 'uk', label: '乌克兰语 Українська', mark: 'UK' },
    { id: 'el', label: '希腊语 Ελληνικά', mark: 'EL' },
    { id: 'sv', label: '瑞典语 Svenska', mark: 'SV' },
    { id: 'da', label: '丹麦语 Dansk', mark: 'DA' },
    { id: 'nb', label: '挪威语 Norsk', mark: 'NB' },
    { id: 'fi', label: '芬兰语 Suomi', mark: 'FI' },
    { id: 'cs', label: '捷克语 Čeština', mark: 'CS' },
    { id: 'sk', label: '斯洛伐克语 Slovenčina', mark: 'SK' },
    { id: 'hu', label: '匈牙利语 Magyar', mark: 'HU' },
    { id: 'ro', label: '罗马尼亚语 Română', mark: 'RO' },
    { id: 'bg', label: '保加利亚语 Български', mark: 'BG' },
    { id: 'hr', label: '克罗地亚语 Hrvatski', mark: 'HR' },
    { id: 'sr', label: '塞尔维亚语 Српски', mark: 'SR' },
    { id: 'lt', label: '立陶宛语 Lietuvių', mark: 'LT' },
    { id: 'lv', label: '拉脱维亚语 Latviešu', mark: 'LV' },
    { id: 'et', label: '爱沙尼亚语 Eesti', mark: 'ET' },
    { id: 'sl', label: '斯洛文尼亚语 Slovenščina', mark: 'SL' }
  ];

  CT.SOURCE_LANGS = [{ id: 'auto', label: '自动检测（推荐）' }].concat(CT.LANGS);
  CT.TARGET_LANGS = CT.LANGS;

  /** 语言 id → 显示名。找不到就原样返回 id（而不是空串，避免界面上出现空白） */
  CT.langLabel = function (id) {
    var n = CT.settings && CT.settings.normalizeLang ? CT.settings.normalizeLang(id) : id;
    for (var i = 0; i < CT.LANGS.length; i++) {
      if (CT.LANGS[i].id === n || CT.LANGS[i].id === id) return CT.LANGS[i].label;
    }
    return String(id || '');
  };

  /** 语言 id → 译文块上那个两三个字符的小标记 */
  CT.langMark = function (id) {
    var n = CT.settings && CT.settings.normalizeLang ? CT.settings.normalizeLang(id) : id;
    for (var i = 0; i < CT.LANGS.length; i++) {
      if (CT.LANGS[i].id === n || CT.LANGS[i].id === id) return CT.LANGS[i].mark;
    }
    return '译';
  };

  /**
   * 语言 id → 短名（去掉后面的母语原文）。
   * ------------------------------------------------------------------
   * 语言对要挤在弹窗一格统计里显示（如「英语 → 简体中文」），
   * 直接用 label 会把「英语 English」这种双语串塞进去，格子立刻溢出。
   * 只认第一个空格 —— 简体中文 / 日语 这类本来就没有空格。
   */
  CT.langShort = function (id) {
    if (id === 'auto') return '自动';
    var s = CT.langLabel(id);
    var sp = s.indexOf(' ');
    return sp > 0 ? s.slice(0, sp) : s;
  };

  /* ---------------- 默认设置 ---------------- */
  CT.DEFAULT_SETTINGS = {
    enabled: true,             // 总开关
    // 默认不自动翻译：打开页面后等用户手动触发（页内开关 / 弹窗「立即翻译」/
    // 右键菜单 / 快捷键）。想恢复「打开页面即翻译」的旧行为，在弹窗或设置页打开。
    // 站点记忆不受此影响：在 A 站手动开过一次，A 站仍会自动启动（后者优先）。
    autoTranslate: false,
    sourceLang: 'auto',
    targetLang: 'zh-CN',
    displayMode: 'below',
    provider: 'auto',

    minTextLength: 2,          // 少于该长度的文本不翻译
    maxUnitsPerPage: 4000,     // 单页翻译单元上限（防止跑飞）
    concurrency: 4,            // 同一时间在途的翻译请求数
    // 译文相对【原文单元】的字号比例。0.95 会让译文和原文几乎一样大，
    // 整页视觉重量翻倍；0.80 才是「明显小一号但仍然好读」的读数。
    // 上限另由页面基准字号封顶。
    fontSizeScale: 0.8,
    // 译文插到哪：
    //   auto    = 智能分流。按宿主的 computed display 决定插入点：内联级宿主用
    //             内联译文，横向 flex 容器改用「容器之后」，其余内部追加
    //   inside  = 一律追加进原文单元内部（旧默认，页面被挤坏时切回来对照）
    //   sibling = 一律插为原文的下一个兄弟（原文元素自身盒子完全不变）
    insertMode: 'auto',
    // 译文长什么样：
    //   plain  = 素净。不加边框、不加背景、不加「译」标记，只把字号调小、
    //            透明度略降。对宿主页面的观感改动降到最低
    //   accent = 标注。左侧竖线 + 淡色「译」标记，一眼能区分原文与译文
    transStyle: 'plain',
    keepOriginalWhenReplaced: false, // 「仅显示译文」模式下是否加原文 tooltip

    // ---- 页内常驻开关 ----
    // 这个开关挂在页面里（右下角），点一下即可开关本页翻译，不必去够工具栏图标。
    toggleVisible: true,           // 是否在页面里显示该控件
    toggleDefaultCollapsed: false, // 首次进入时是否已收起为圆点
    // 是否按站点记住开关状态：在 A 站关掉翻译，下次打开 A 站仍是关的。
    // 与「本页临时开关」不同，后者只活在当前页面会话里、不写任何存储。
    siteMemory: false,
    // 再次点开本页时是否还显示那颗一次性引导气泡（默认显示一次后记下，不再打扰）
    toggleGuideDone: false,

    // ---- 划词翻译 ----
    // 选中一段文字就弹气泡显示译文。与整页翻译共用同一条翻译通道，
    // 因此自动继承掩码保护、术语表与缓存。
    selectionEnabled: true,
    // 'auto' = 松开鼠标即翻译；'icon' = 先出小图标、点击才翻（省额度）
    selectionTrigger: 'auto',
    selectionMinLen: 2,            // 少于该长度不触发（默认 2，等价于「至少一个字母」）
    selectionMaxLen: 1200,         // 超过该长度不触发 —— 那已经不是「划词」而是「划段」
    // 必须按住 Alt 才触发。默认关。
    // 存在的意义：有的站点自己也有划词弹层（词典、wiki 脚注），
    // 用户可能只想用站点的，这时需要一个「让出赛道」的开关。
    selectionOnlyWithModifier: false,

    // ---- 覆盖范围 ----
    // iframe 内的正文。开着才能翻嵌入的文章、评论组件、老式 frame 布局站点，
    // 代价是每个 frame 都要跑一次注入与自评（有 frame 预算兜底）。
    iframeEnabled: true,
    // shadow root 内的内容。只覆盖 mode:'open' 的根 ——
    // closed 根在架构上拿不到（两个 world 不共享 JS 对象），已记为已知限制。
    shadowDomEnabled: true,

    // ---- PDF ----
    // 拦截 .pdf 导航，改用自己的阅读器渲染，从而能在文本层上叠译文。
    // 关掉后 PDF 恢复交给 Chrome 原生查看器（那样就没法对照翻译）。
    pdfEnabled: true,

    // ---- 页内自定义快捷键 ----
    // { action: combo }，action 见 CT.BINDABLE_ACTIONS
    customShortcuts: {},

    // ---- 译文准确性 ----
    // 术语表：[{ from: 'Prompt', to: '提示词' }]
    // 命中的术语会被换成占位符送出，返回后还原成用户指定的译名 ——
    // 这样「无论用哪个引擎、无论引擎怎么翻」都能得到一致的专有名词。
    //
    // 【v1.7.1】这里的空数组曾是「翻译不准确」的主因：
    // 机制早就实现了，数据是零。现在由 shared/terminology.js 提供内置基座兜底。
    // 用户表优先级高于基座（同名忽略大小写，用户先入先得）。
    glossary: [],
    // 是否启用内置术语基座。关掉后退回 v1.7.0 的行为（纯引擎取义），
    // 用于对照排障 —— 「同一句话开/关基座」是验证术语有效性的最直接方法。
    termBaseEnabled: true,
    // 启用哪些术语域（见 CT.TERM_DOMAINS）。null / 省略 = 全部启用。
    // 之所以要分域：招聘页上把技术缩写全摘出来是净收益，
    // 但在纯技术文档站上把「Marketing」也锁成「市场营销」就是噪音。
    termDomains: null,
    // 是否保护 URL / 邮箱 / 代码标识符 / 变量占位符 / 版本号不被翻译
    protectUntranslatable: true,

    // v1.7.4（C-13 Q3）：用户纠错表。[{ from: '整句原文', to: '修正译文', at: 时间戳 }]
    // 与 glossary 的区别：整句**精确匹配**（不做正则），组批前短路 —— 命中即终审，
    // 不查缓存、不送引擎。由页内译文悬停「改」入口写入；独立键存储的理由
    // 见 service-worker.js handleTranslate 内 correctionsMap 注释。
    corrections: [],

    skipSelectors: [],         // 额外跳过的 CSS 选择器
    blocklist: [],             // 站点黑名单（域名，支持 *.example.com）

    deeplApiKey: '',
    deeplPlan: 'free',         // free | pro

    openaiBaseUrl: 'https://api.openai.com/v1',
    openaiApiKey: '',
    openaiModel: 'gpt-4o-mini',

    cacheEnabled: true,
    cacheMaxEntries: 8000,

    // v1.8.0（B2 / C-68）：匿名埋点的**退出开关**（true = 退出）。
    // 落 settings（sync）而非 local：退出是**用户偏好**（随账号跨设备一致），
    // 且清 local / 重装**不会**静默重开遥测（落 local 会构成隐私事故，契约 §4.3）。
    // 默认 false = 未退出（opt-out 口径）。真正的出站还受 CT.REPORT.ENABLED
    // 总闸与 CT.REPORT.ALLOWED_HOSTS 白名单二次校验（见 report.js outboundAllowed）。
    telemetryOptOut: false
  };

  /* ---------------- 常量 ---------------- */
  CT.TRANS_CLASS = 'ct-trans';          // 译文块根类名
  CT.TOGGLE_CLASS = 'ct-toggle';        // 页内常驻开关的宿主类名
  CT.UNIT_FLAG = 'ctUnit';              // 已作为翻译单元处理过的标记
  CT.SRC_ATTR = 'ctSrc';                // 上次翻译时的原文指纹
  CT.MODE_ATTR = 'ctMode';

  /* ---------------- 存储键 ----------------
   * 这两个键刻意【不放进 settings】。它们属于界面状态，不是翻译设置：
   * 放进 settings 的话，用户拖一下开关就会触发 storage.onChanged，
   * 进而驱动 content 重扫整页 —— 为了记住一个坐标付一次全页扫描不划算。
   */
  CT.STORAGE = {
    TOGGLE_UI: 'ct.toggleUI',     // { side, y, bottom, collapsed } 控件位置与收起态
    SITE_STATE: 'ct.siteState',   // { 'example.com': true|false } 站点级开关记忆

    /*
     * v1.8.0（B2-1，C-62）：纠错频次计数。
     * ------------------------------------------------------------------
     * 与 REPORT_SALT 同类（非用户偏好、随纠错频繁写、机器本机事实），
     * 因此同样【落独立 local 键而非 settings】。理由见 service-worker.js
     * 内 loadCorrStats 顶部注释：content.js 的 storage.onChanged 是
     * `if (!changes.settings) return;`，写 settings 即无条件整页重扫重译。
     * 形状：{ '<normKey(from)>|<to>|<tgt>': { n, first, last, dismissed } }。
     * 不参与 termHash（不进 mergeGlossary 的 list）。
     */
    CORR_STATS: 'ct.corrStats',

    /*
     * v1.8.0（B2-5，C-67）：能力边界一次性说明的抑制位。
     * ------------------------------------------------------------------
     * 形状 { iframe?:true, shadow?:true }，两类各占独立位、不共用；
     * 作用域 = 全局（本机安装，不分 tab / 站点，local 不同步）。
     * 【检测（瞬态 framesSkipped）与抑制（本持久键）必须分离】——
     * 抑制只认本键，绝不用随 worker 重启归零的瞬态计数替代（否则重启即重弹）。
     * 同样落 local 而非 settings（写 settings 会触发整页重扫）。
     */
    CAP_NOTICE: 'ct.capNoticeSeen',

    /*
     * v1.8.0（B2 / C-68 拟）：动作记录上报（双通道）的两个 local 键。
     * ------------------------------------------------------------------
     * REPO_SALT  installSalt = 32B CSPRNG，**高敏感本地机密、永不出机**
     *            （派生通道 A tok / 通道 B anon；泄漏面见契约 §2.6）。
     *            「重置匿名标识」= 重新生成本键（切断历史 tok/anon 可拼接性）。
     * AGG        两通道共用的**本地聚合 rollup + 有界离线队列**（仅含 P0 字段）。
     * 两者均落 local（机器本机事实）而非 settings：写 settings 会触发
     * content.js 的 `if (!changes.settings) return;` → 无条件整页重扫重译。
     * 退出开关 telemetryOptOut 则相反，落 **settings（sync）**——理由见契约 §4.3。
     */
    REPORT_SALT: 'ct.reportSalt',
    REPORT_AGG: 'ct.reportAgg',

    /*
     * v1.8.0：安装事件「只报一次」的幂等守卫位。
     * ------------------------------------------------------------------
     * 落 local（本机安装事实）而非 settings：写 settings 会触发 content.js 的
     * `if (!changes.settings) return;` → 无条件整页重扫重译。
     * 形状：true（已报过）。缺失即未报。
     */
    INSTALL_REPORTED: 'ct.installReported',

    /*
     * v1.8.0：安装期固定设备标识 did（anonymous device id）。
     * ------------------------------------------------------------------
     * 为什么需要：bid 是**批次级**（每条帧 / 每条日批各一个），拿它算
     *   DAU/WAU/MAU 会随活跃天数线性虚高（7 天最多放大 7 倍）。
     * 形状：crypto.randomUUID() 生成的 UUIDv4 字符串，安装生命周期内恒定，
     *   **不随日期轮换、不进 sync**（跨设备同步会把两台机器算成一台）。
     * 隐私：纯随机、与身份无关、不可逆；可与 installSalt 同源但必须独立键。
     * 落 local：机器本机事实；写 settings 会触发 content 整页重扫。
     */
    DID: 'ct.did'
  };

  /*
   * 个人词典学习闭环参数（B2-1，C-62/C-63）。
   * ------------------------------------------------------------------
   * 阈值与容量集中定义（CTO §4④：不得散落字面量、不得调成 1 或 2）。
   *   THRESHOLD          同一词级候选「去重后独立命中」达该次数方可出确认卡
   *   STATS_MAX          ct.corrStats 条目上限，超限按 last 升序淘汰
   *   SPAN_MAX           **候选源词 `from` 的字符长度上限**（不是整键长度）；
   *                      超限放弃，**绝不截断**（D-B2-01 §2.2 钉死；值 40）
   *   SESSION_MAX_CARDS  每会话最多弹卡数，达上限停止弹、候选留待下次会话
   *   TGT                v1 仅英→中；目标语言非此值时不提炼（规避跨语种泄漏）
   *   CORR_STATS_WRITE_MS  n>THRESHOLD 后 local 写入的节流窗口
   */
  CT.LEARNING = {
    THRESHOLD: 3,
    STATS_MAX: 200,
    SPAN_MAX: 40,
    SESSION_MAX_CARDS: 2,
    TGT: 'zh-CN',
    CORR_STATS_WRITE_MS: 600000
  };

  /*
   * 动作记录上报参数（B2 双通道，v1.8.0）。
   * ------------------------------------------------------------------
   * 【唯一权威】传输/信封/退避 = 契约 v2.3 §1；事件枚举/props = #4 v2.2 §2/§3。
   * 【产品口径 v1.8.0】产品完整免费 ⇒ 只保留**匿名埋点**一条后台交互，
   *   事件收敛为 install / online / translate_round 三类，仅用于统计安装量与使用量。
   * 【总闸】ENABLED 已由主理人批准开启（true）；真正发送还须 host 命中
   *   ALLOWED_HOSTS，且用户未关闭匿名统计（三重条件见 report.js outboundAllowed）。
   * 【域标签】DOMAIN_TOK / DOMAIN_ANON 为常量，**不得复用于其它派生**
   *   （去掉标签即丢失 tok↔anon 的密码学域分离，DL-17③ / 契约 §2.0）。
   */
  CT.REPORT = {
    // ⚠ ENDPOINT 必须是**完整请求 URL**（含 /telemetry/actions），不是基址：
    //   report.js 的 endpointUrl() 原样返回本值并直接 fetch，**不会拼接路径**。
    //   （v1.8.0 之前默认值写 http://127.0.0.1:7791/api 是个从未暴露的 bug ——
    //    因为总闸一直关着，一次都没真发过；开启后才发现会打到根路径 404。）
    // 生产：nginx 反代 → 127.0.0.1:7791（仅监听本机）。
    // 后台看板：https://createive.cn/dieyi/
    ENDPOINT: 'https://createive.cn/api/telemetry/actions',
    // 出站 host 白名单（唯一判据；不在表内一律不发）。
    // 本机三项保留：本地联调仍可用 http://127.0.0.1:7791/api 覆盖验证。
    ALLOWED_HOSTS: ['createive.cn', '127.0.0.1', 'localhost', '[::1]'],
    PROD: 'dieyi',
    CLIENT: 'dieyi-ext-1.8',                   // 头 X-Dieyi-Client（version-scoped 公开 token，非密钥；随协议代次 1.8）
    EXT_FALLBACK: '1.8.0',                     // manifest.version 读不到时的兜底
    // 通道 A 帧窗（≤15min，对齐窗桶；DL-17②/契约 §1.4）
    FRAME_MS: 15 * 60 * 1000,
    // 批量与体积上限（任一先到切批；契约 §1.7）
    BATCH_MAX: 50,
    BYTES_MAX: 65536,
    // 有界离线队列（任一先到 FIFO 丢最旧；契约 §1.8）
    QUEUE_MAX_ITEMS: 200,
    QUEUE_MAX_BYTES: 262144,
    CELLS_MAX: 200,                            // 本地聚合 cell 上界
    // 退避：基 30s、×2、±25% 抖动、cap 30min、最多 8 次（契约 §1.8）
    RETRY_BASE_MS: 30000,
    RETRY_FACTOR: 2,
    RETRY_JITTER: 0.25,
    RETRY_CAP_MS: 30 * 60 * 1000,
    RETRY_MAX: 8,
    TIMEOUT_MS: 8000,                          // AbortSignal.timeout（契约 §1.2）
    // ★ 总闸：主理人已批准启用（仅统计安装量/使用量；文案见设置页隐私区）
    ENABLED: true,
    // k-匿名硬底（单维展示；契约 §4.4）
    K_MIN: 10,
    // 域分离常量标签（前缀式；不得复用）
    DOMAIN_TOK: 'w:',
    DOMAIN_ANON: 'd:'
  };

  CT.MAX_TEXT_PER_UNIT = 5000;          // 单个翻译单元最大字符数
  // 单批的条数上限只是兜底，真正起约束作用的是 BATCH_MAX_CHARS；
  // 各引擎实际使用的批大小见 background/providers.js 的 BATCH_HINT。
  CT.BATCH_MAX_ITEMS = 60;
  CT.BATCH_MAX_CHARS = 2500;            // 单批最大字符数

  /*
   * 每批翻译的超时保护（C-21，v1.7.6）。
   * 真实站点（remoteok.com 2396 段）实测出现过「翻译中 224 / 2396」永久卡死：
   * 引擎侧一个请求挂起（网络停滞 / 内置模型限流 / 服务器不响应）而
   * providers.js 没有任何 AbortSignal —— mapLimit 的 runner 永远阻塞，
   * badge 永远停在「翻译中 N / M」。这里按引擎给每批一个上限，超时转为
   * 明确报错，走既有的失败计数收尾（badge 落到「已译 N 段（M 段失败）」）。
   * 取值依据：google 一次一段正常 1~3s；内置模型批内串行本地推理；LLM 大批最慢。
   */
  CT.TRANSLATE_TIMEOUT_MS = {
    'google-free': 30000,
    'chrome-builtin': 90000,
    'deepl': 40000,
    'openai': 120000,
    DEFAULT: 90000
  };

  /*
   * 引擎熔断阈值（C-23，v1.7.6）：同一次翻译请求内，连续失败达到该批数
   * 即判定引擎不可用（挂起/不可达/限流风暴），未开跑的批次直接中止，
   * 响应落明确终态「已译 N 段（M 段失败）」+ 中止原因。
   * 没有它：国内网络下 google-free 不可达时，285 批 × 30s 超时 ÷ 并发
   * 仍要烧 20+ 分钟才收尾——技术上「会结束」，用户视角就是假卡死。
   */
  CT.ENGINE_CIRCUIT_BREAKER_FAILS = 6;



  CT.GOOGLE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
  CT.DEEPL_ENDPOINT_FREE = 'https://api-free.deepl.com/v2/translate';
  CT.DEEPL_ENDPOINT_PRO = 'https://api.deepl.com/v2/translate';

  /* ---------------- 小工具 ---------------- */
  CT.settings = CT.settings || {};

  /** 语言码归一化：en-US -> en，zh-Hant -> zh-tw 之类 */
  CT.settings.normalizeLang = function (lang) {
    if (!lang) return 'auto';
    var l = String(lang).trim().toLowerCase().replace(/_/g, '-');
    if (l === 'auto' || l === '') return 'auto';
    if (l.indexOf('zh') === 0) {
      if (/tw|hk|hant|mo/.test(l)) return 'zh-TW';
      return 'zh-CN';
    }
    return l.split('-')[0];
  };

  /** 判断源语言与目标语言是否同属一种语言（同语言则整页跳过）
   *  注意：中文简繁之间也算「同语言」—— 这是**逐段**判定用的宽松口径，
   *  因为把一段简体文字「翻」成繁体在逐段层面本就无从判断该不该做。 */
  CT.settings.isSameLanguage = function (a, b) {
    var x = CT.settings.normalizeLang(a);
    var y = CT.settings.normalizeLang(b);
    if (x === 'auto' || y === 'auto') return false;
    if (x === y) return true;
    if (x.indexOf('zh') === 0 && y.indexOf('zh') === 0) return true;
    return false;
  };

  /** 严格口径：简繁算不同语言。
   *  整页开关用这个 —— 用户把目标语言设成「繁体中文」，在简体页面上
   *  就该真的转一遍，否则「多语言互译」里的简繁这一格是死的。 */
  CT.settings.isSameLanguageStrict = function (a, b) {
    var x = CT.settings.normalizeLang(a);
    var y = CT.settings.normalizeLang(b);
    if (x === 'auto' || y === 'auto') return false;
    return x === y;
  };

  /* 简繁判定锚点。
   * 不做完整映射表（那是一本字典），只取一批**只在某一侧出现**的高频字来投票。
   * 写成「成对」的形式，是为了保证两侧一一对应 —— 手写两条字串时极容易
   * 一侧多一个、另一侧少一个，那种失衡不会报错，只会让判定悄悄偏向一侧。
   * 见 tools/selftest.mjs 里对配对的断言。
   * 注意：这对锚点必须是「简体形 ≠ 繁体形」的字。
   * 例：会/會 ✓、说/說 ✓；而 面/面 ✗、器/器 ✗ 两侧同形，放进来只会稀释判定。 */
  var VARIANT_PAIRS = [
    ['們', '们'], ['這', '这'], ['個', '个'], ['為', '为'], ['說', '说'],
    ['時', '时'], ['會', '会'], ['對', '对'], ['開', '开'], ['關', '关'],
    ['東', '东'], ['車', '车'], ['馬', '马'], ['書', '书'], ['門', '门'],
    ['問', '问'], ['間', '间'], ['電', '电'], ['語', '语'], ['譯', '译'],
    ['學', '学'], ['國', '国'], ['體', '体'], ['龍', '龙'], ['鳥', '鸟'],
    ['寫', '写'], ['讀', '读'], ['聽', '听'], ['見', '见'], ['覺', '觉'],
    ['讓', '让'], ['從', '从'], ['來', '来'], ['過', '过'], ['還', '还'],
    ['進', '进'], ['遠', '远'], ['邊', '边'], ['塊', '块'], ['條', '条'],
    ['錢', '钱'], ['銀', '银'], ['鐵', '铁'], ['鋼', '钢'], ['長', '长'],
    ['場', '场'], ['壞', '坏'], ['買', '买'], ['賣', '卖'], ['貴', '贵'],
    ['費', '费'], ['資', '资'], ['產', '产'], ['業', '业'], ['務', '务'],
    ['員', '员'], ['團', '团'], ['隊', '队'], ['點', '点'], ['線', '线'],
    ['級', '级'], ['統', '统'], ['總', '总'], ['計', '计'], ['議', '议'],
    ['論', '论'], ['認', '认'], ['識', '识'], ['講', '讲'], ['話', '话'],
    ['詞', '词'], ['義', '义'], ['無', '无'], ['與', '与'], ['萬', '万'],
    ['歲', '岁'], ['兒', '儿'], ['頭', '头'], ['風', '风'], ['飛', '飞'],
    ['雲', '云'], ['網', '网'], ['觀', '观'], ['記', '记'], ['訓', '训'],
    ['試', '试'], ['輸', '输'], ['轉', '转'], ['輪', '轮'], ['軟', '软'],
    ['輕', '轻'], ['載', '载'], ['適', '适'], ['應', '应'], ['選', '选'],
    ['邏', '逻'], ['輯', '辑'], ['復', '复'], ['雜', '杂'], ['簡', '简'],
    ['單', '单'], ['雙', '双'], ['該', '该'], ['術', '术'], ['圖', '图'],
    ['標', '标'], ['準', '准'], ['類', '类'], ['數', '数'], ['據', '据'],
    ['庫', '库'], ['構', '构'], ['結', '结'], ['設', '设'], ['編', '编'],
    ['碼', '码'], ['頁', '页'], ['鍵', '键'], ['盤', '盘'], ['寬', '宽']
  ];
  CT.VARIANT_PAIRS = VARIANT_PAIRS;

  var HANT_ANCHORS = VARIANT_PAIRS.map(function (p) { return p[0]; }).join('');
  var HANS_ANCHORS = VARIANT_PAIRS.map(function (p) { return p[1]; }).join('');

  /**
   * 判断一段中文是简体还是繁体（非中文返回 'unknown'）
   * @param {string} text
   * @returns {'hans'|'hant'|'unknown'}
   */
  CT.settings.scriptVariant = function (text) {
    if (!text) return 'unknown';
    var trad = 0;
    var simp = 0;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (HANT_ANCHORS.indexOf(ch) >= 0) trad++;
      else if (HANS_ANCHORS.indexOf(ch) >= 0) simp++;
    }
    // 两边都没命中 → 不足以判断（纯数字、纯专有名词、字数太少的短标签）
    if (trad === 0 && simp === 0) return 'unknown';
    if (trad === simp) return 'unknown';
    return trad > simp ? 'hant' : 'hans';
  };

  /** 目标语言对应的正字法：zh-CN -> hans，zh-TW -> hant，其余 '' */
  CT.settings.targetVariant = function (lang) {
    var n = CT.settings.normalizeLang(lang);
    if (n === 'zh-CN') return 'hans';
    if (n === 'zh-TW') return 'hant';
    return '';
  };

  /**
   * 整页开关：这一页到底需不需要翻？
   * ------------------------------------------------------------------
   * 这是「多语言互译」的入口判据，比逐个 isSameLanguage 判断更准：
   *
   *   · 源语言未知（auto 且检测不出）→ 试一次，交给逐段判定兜住
   *   · 源 ≠ 目标                     → 要翻（en→ja、ja→en、zh→en 都是这条）
   *   · 源 = 目标 且都是中文          → 再看正字法：简体页配「目标繁体」要真翻，
   *                                     否则用户把目标设成繁体中文永远没反应
   *   · 源 = 目标 且非中文            → 不翻
   *
   * @param {string} sourceLang 已知的页面语言（不是 'auto'）
   * @param {string} targetLang
   * @param {string} [variant]  中文页面的正字法 'hans'|'hant'|'unknown'
   * @returns {boolean}
   */
  CT.settings.needsPageTranslation = function (sourceLang, targetLang, variant) {
    var s = CT.settings.normalizeLang(sourceLang);
    var t = CT.settings.normalizeLang(targetLang);
    if (t === 'auto' || !t) return false;
    if (s === 'auto') return true;
    if (s !== t) return true;
    var tv = CT.settings.targetVariant(t);
    if (tv && variant && variant !== 'unknown') return variant !== tv;
    return false;
  };

  /** 域名黑名单匹配，支持 *.example.com 写法 */
  CT.settings.isBlockedHost = function (host, blocklist) {
    if (!host || !blocklist || !blocklist.length) return false;
    host = host.toLowerCase();
    for (var i = 0; i < blocklist.length; i++) {
      var rule = String(blocklist[i] || '').trim().toLowerCase();
      if (!rule) continue;
      if (rule.indexOf('*.') === 0) {
        var suffix = rule.slice(1); // ".example.com"
        if (host.length > suffix.length && host.slice(-suffix.length) === suffix) return true;
      } else if (rule.indexOf('*') >= 0) {
        var re = new RegExp('^' + rule.split('*').map(CT_settings_escape).join('.*') + '$');
        if (re.test(host)) return true;
      } else if (host === rule) {
        return true;
      }
    }
    return false;
  };

  function CT_settings_escape(s) {
    return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }

  /** 稳定 32 位哈希，用于缓存键与内容指纹 */
  CT.settings.hash = function (str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36) + '_' + str.length.toString(36);
  };

  /** 设置合并（浅合并 + 数组深拷贝），保证新增字段有默认值 */
  CT.settings.merge = function (base, patch) {
    var out = {};
    var k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    if (patch) {
      for (k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k) && patch[k] !== undefined && patch[k] !== null) {
          out[k] = patch[k];
        }
      }
    }
    return out;
  };
})(typeof self !== 'undefined' ? self : this);
