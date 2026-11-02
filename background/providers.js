/*
 * 叠译 · 翻译引擎适配层
 * ------------------------------------------------------------------
 * 统一的引擎契约：
 *     translateBatch({ texts, source, target, settings }) -> { translations, provider }
 *
 * 已实现四种：
 *   chrome-builtin  Chrome 内置本地翻译模型（免费、不出网、质量中上）
 *   google-free     Google 翻译公开接口（免费、无需 Key、覆盖面最广）
 *   deepl           DeepL API（需 Key、中文质量最好）
 *   openai          OpenAI 兼容接口（自建/中转/本地模型均可）
 *
 * 分层原则：引擎只负责「把 N 段文本换成 N 段中文」，不关心缓存、并发与 DOM。
 */
'use strict';

import '../shared/constants.js';

const CT = self.CT;

/* ------------------------------------------------------------------
 * 每个引擎「一次调用能吃下多少段」的建议值。
 *
 * 这个值决定了上层怎么切批：
 *   - 值为 1  → 引擎是严格「一次一段」（免费的 Google 接口），
 *               上层就切成 1 段一批，让「并发请求数」这个设置真正决定并行度
 *   - 值较大 → 引擎本身支持批量（DeepL 的多 text 参数、OpenAI 的 JSON 数组、
 *               本地模型串行跑一次），切大批能显著减少往返次数
 * ------------------------------------------------------------------ */
export const BATCH_HINT = {
  'google-free': 1,
  'deepl': 40,
  'openai': 30,
  'chrome-builtin': 60
};

export function batchHintFor(provider) {
  return BATCH_HINT[provider] || 12;
}

/* ==================================================================
 * 一、内置本地模型
 * ================================================================== */

/** 缓存 Translator 实例：创建一次成本较高，按语向复用 */
const builtinPool = new Map();

function getBuiltinApi() {
  if (self.Translator && typeof self.Translator.create === 'function') return self.Translator;
  if (self.ai && self.ai.translator && typeof self.ai.translator.create === 'function') return self.ai.translator;
  if (self.translation && typeof self.translation.createTranslator === 'function') return self.translation;
  return null;
}

/** 查询内置模型对某语向的可用状态
 *
 * 这个查询会走一次浏览器的内置翻译服务，是异步的。
 * 它的答案在同一语向、同一分钟内不会变，而调用方是「每批一次」——
 * 一个长页面可能切成上百批，那就是上百次多余的异步查询。
 * 因此做 60 秒记忆；语言包下载成功后由 prepareBuiltinModel 主动失效。 */
const availabilityMemo = new Map();   // 'src->tgt' -> { v, at }
const AVAILABILITY_TTL_MS = 60000;

export async function builtinAvailability(source, target) {
  const api = getBuiltinApi();
  if (!api || typeof api.availability !== 'function') return 'unsupported';

  const key = source + '->' + target;
  const now = Date.now();
  const hit = availabilityMemo.get(key);
  if (hit && now - hit.at < AVAILABILITY_TTL_MS) return hit.v;

  let v;
  try {
    v = await api.availability({ sourceLanguage: source, targetLanguage: target });
  } catch (e) {
    v = 'unsupported';
  }
  availabilityMemo.set(key, { v: v, at: now });
  return v;
}

/** 使某语向的可用状态记忆失效（语言包下载完成后调用） */
export function invalidateAvailability(source, target) {
  availabilityMemo.delete(source + '->' + target);
}

async function getBuiltinTranslator(source, target) {
  const api = getBuiltinApi();
  if (!api) return null;

  const poolKey = source + '->' + target;
  if (builtinPool.has(poolKey)) return builtinPool.get(poolKey);

  const availability = await builtinAvailability(source, target);
  if (availability === 'unavailable' || availability === 'unsupported') return null;

  // availability === 'downloadable' 时会触发模型下载，通常需要用户手势；
  // 由设置页的「下载语言模型」按钮先完成这一步，这里只做兜底尝试。
  const translator = await api.create({
    sourceLanguage: source,
    targetLanguage: target,
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => {
        // 下载进度仅在设置页可见，这里静默处理
        void e;
      });
    }
  });
  builtinPool.set(poolKey, translator);
  return translator;
}

async function builtinBatch(texts, source, target) {
  const translator = await getBuiltinTranslator(source, target);
  if (!translator) {
    throw new Error('内置模型不可用（语言包未就绪或浏览器版本不支持）');
  }
  const out = [];
  // 本地推理走串行更稳：并发反而会争抢同一份模型资源
  for (const t of texts) {
    out.push(await translator.translate(t));
  }
  return out;
}

/* ==================================================================
 * 二、Google 翻译公开接口
 * ------------------------------------------------------------------
 * 关键设计取舍：这里【刻意不做】「多段拼成一次请求」的合并优化。
 *
 * 曾经试过的方案是把 N 段用换行拼成一个 q，回来后按换行切分。问题是
 * 返回的换行数并不保证与输入一致：一旦不一致就得降级重试（反而更慢），
 * 而万一「凑巧行数相同但切分位置错位」，就会把 A 段的译文写到 B 段上 ——
 * 这种静默错位比慢几秒严重得多，用户根本无从察觉。
 *
 * 因此改为「一次请求一段」，把并发交给上层统一的并发控制去管。
 * 想让长页面翻得更快，调高设置里的「并发请求」即可。
 * ================================================================== */

async function googleBatch(texts, source, target) {
  const out = [];
  for (const t of texts) {
    out.push((await googleRequest(t, source, target)).trim());
  }
  return out;
}

async function googleRequest(text, source, target) {
  const body = new URLSearchParams();
  body.set('client', 'gtx');
  body.set('sl', source && source !== 'auto' ? source : 'auto');
  body.set('tl', target);
  body.set('dt', 't');
  body.set('q', text);

  const res = await fetch(CT.GOOGLE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: body.toString(),
    credentials: 'omit'
  });

  if (!res.ok) {
    throw new Error('Google 翻译接口返回 HTTP ' + res.status + (res.status === 429 ? '（请求过于频繁，请降低并发或稍后重试）' : ''));
  }

  const data = await res.json();
  const segs = data && data[0];
  if (!Array.isArray(segs)) throw new Error('Google 翻译返回结构异常');

  // 响应格式：[[["译文片段","原文片段",...], ...], ...]
  let out = '';
  for (const seg of segs) {
    if (seg && typeof seg[0] === 'string') out += seg[0];
  }
  return out;
}

/* ==================================================================
 * 三、DeepL
 * ================================================================== */

const DEEPL_SOURCE_MAP = {
  en: 'EN', ja: 'JA', ko: 'KO', fr: 'FR', de: 'DE', es: 'ES',
  pt: 'PT', it: 'IT', ru: 'RU', nl: 'NL', pl: 'PL', tr: 'TR',
  zh: 'ZH', id: 'ID', sv: 'SV', da: 'DA', nb: 'NB', fi: 'FI',
  cs: 'CS', sk: 'SK', hu: 'HU', ro: 'RO', bg: 'BG', el: 'EL',
  lt: 'LT', lv: 'LV', et: 'ET', sl: 'SL', uk: 'UK'
};

/*
 * DeepL 的目标语言码与 BCP-47 不是一套东西，而且**只有它自己认识的那几种**。
 * 之前的实现是 `target.toUpperCase().indexOf('TW') >= 0 ? 'ZH-HANT' : 'ZH'`
 * —— 也就是无论目标是什么，都翻成中文。这是「多语言互译」在 DeepL 层的直接原因。
 * 这里补全映射，并对不支持的语向给出明确报错（而不是静默翻成中文）。
 */
const DEEPL_TARGET_MAP = {
  'zh-CN': 'ZH', 'zh': 'ZH', 'zh-TW': 'ZH-HANT',
  en: 'EN-US', ja: 'JA', ko: 'KO', fr: 'FR', de: 'DE', es: 'ES',
  pt: 'PT-PT', it: 'IT', ru: 'RU', nl: 'NL', pl: 'PL', tr: 'TR',
  id: 'ID', sv: 'SV', da: 'DA', nb: 'NB', fi: 'FI',
  cs: 'CS', sk: 'SK', hu: 'HU', ro: 'RO', bg: 'BG', el: 'EL',
  lt: 'LT', lv: 'LV', et: 'ET', sl: 'SL', uk: 'UK'
};

function deeplTargetCode(target) {
  const raw = String(target || '');
  if (DEEPL_TARGET_MAP[raw]) return DEEPL_TARGET_MAP[raw];
  const n = CT.settings && CT.settings.normalizeLang ? CT.settings.normalizeLang(raw) : raw;
  return DEEPL_TARGET_MAP[n] || '';
}

async function deeplBatch(texts, source, target, settings) {
  const key = (settings.deeplApiKey || '').trim();
  if (!key) throw new Error('未配置 DeepL API Key');

  const targetCode = deeplTargetCode(target);
  if (!targetCode) {
    // 诚实报错，而不是退回「翻成中文」—— 后者用户根本无从察觉
    throw new Error('DeepL 暂不支持翻译成「' + (CT.langLabel ? CT.langLabel(target) : target)
      + '」，请改用「自动选择」或换一个引擎');
  }

  const url = settings.deeplPlan === 'pro' ? CT.DEEPL_ENDPOINT_PRO : CT.DEEPL_ENDPOINT_FREE;
  const body = new URLSearchParams();
  for (const t of texts) body.append('text', t);
  body.set('target_lang', targetCode);
  if (source && source !== 'auto' && DEEPL_SOURCE_MAP[source]) {
    body.set('source_lang', DEEPL_SOURCE_MAP[source]);
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'DeepL-Auth-Key ' + key,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
    },
    body: body.toString()
  });

  if (!res.ok) {
    const tip = res.status === 403 ? '（Key 无效或套餐不符）'
      : res.status === 456 ? '（额度已用尽）'
      : '';
    throw new Error('DeepL 返回 HTTP ' + res.status + tip);
  }

  const data = await res.json();
  if (!data || !Array.isArray(data.translations)) throw new Error('DeepL 返回结构异常');
  return data.translations.map((x) => (x && x.text) || '');
}

/* ==================================================================
 * 四、OpenAI 兼容接口
 * ================================================================== */

/** 目标语言 → 给模型看的自然语言名。模型对「Chinese」的把握远不如对
 *  「简体中文（中国大陆用语习惯）」—— 中文名能同时锁定语种与用词习惯。 */
const LANG_PROMPT_NAME = {
  'zh-CN': '简体中文（中国大陆用语习惯）',
  'zh-TW': '繁体中文（台湾用语习惯）',
  zh: '中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  pt: 'Português',
  it: 'Italiano',
  ru: 'Русский',
  ar: 'العربية',
  th: 'ภาษาไทย',
  vi: 'Tiếng Việt',
  nl: 'Nederlands',
  pl: 'Polski',
  tr: 'Türkçe',
  id: 'Bahasa Indonesia',
  ms: 'Bahasa Melayu',
  hi: 'हिन्दी',
  bn: 'বাংলা',
  ta: 'தமிழ்',
  fa: 'فارسی',
  he: 'עברית',
  uk: 'Українська',
  el: 'Ελληνικά',
  sv: 'Svenska',
  da: 'Dansk',
  nb: 'Norsk',
  fi: 'Suomi',
  cs: 'Čeština',
  sk: 'Slovenčina',
  hu: 'Magyar',
  ro: 'Română',
  bg: 'Български',
  hr: 'Hrvatski',
  sr: 'Српски',
  lt: 'Lietuvių',
  lv: 'Latviešu',
  et: 'Eesti',
  sl: 'Slovenščina'
};

function promptLangName(lang) {
  const n = CT.settings && CT.settings.normalizeLang ? CT.settings.normalizeLang(lang) : lang;
  return LANG_PROMPT_NAME[n] || LANG_PROMPT_NAME[lang] || String(lang || '');
}

/**
 * 构造系统提示词
 * ------------------------------------------------------------------
 * 之前的版本把目标语言写死成中文（"翻译成简体中文"、"服务对象是中文母语读者"），
 * 于是无论用户把目标语言选成什么，走 OpenAI 引擎时都只会得到中文 ——
 * 这是「多语言互译」在引擎层的直接原因。
 *
 * 另外补了三条与准确性直接相关的约束：
 *   · 条目之间彼此独立，禁止合并、拆分、增删（否则返回数组长度会对不上，
 *     而错位是「部分翻译不正确」里最致命的一种：译文跑到别的段落去了）
 *   · 保留占位符（送进来的文本里已经用私用区字符掩掉了 URL / 代码 / 术语）
 *   · 提供同页上下文，让 "Home"、"Back" 这类短词按所在位置取义
 */
/*
 * 场景提示词（C-12 Q1b）：scene id → 注入 system prompt 的场景说明。
 * 只描述「这个场景里多义词该怎么取义」，绝不动 1–8 条硬性要求 ——
 * 场景识别有误时最坏结果是多一段多余提示，不可能造成错位。
 * 与 shared/scene.js 的场景清单保持同步（新增场景时两处都要加）。
 */
const SCENE_PROMPTS = {
  recruiting: '本页是招聘/求职页面：按钮与链接里的 "Apply" 指提交职位申请（译作「申请」）；"Executive / Senior / Junior" 是职级（译作「高管 / 高级 / 初级」）；公司名、人名、技术名词保持原文。'
};

function buildOpenAISystemPrompt(target, source, contexts, scenes) {
  const tgt = promptLangName(target);
  const src = source && source !== 'auto' ? promptLangName(source) : '（自动判断）';

  const lines = [
    '你是一个专业的网页翻译引擎。',
    '源语言：' + src + '。目标语言：' + tgt + '。',
    '',
    '你会收到一个 JSON 字符串数组，每一项是网页上的一段文本。翻译每一项。',
    '',
    '硬性要求：',
    '1. 只输出一个 JSON 对象：{"t": ["译文1", "译文2", ...]}。不要解释，不要代码块标记。',
    '2. 输出数组的长度与顺序必须与输入**逐项一一对应**。',
    '   绝不合并相邻项，绝不拆分一项，绝不跳过任何一项，绝不新增项。',
    '3. 数组里的文本是**同一网页的片段**，术语与口吻要前后一致。',
    '4. 原文里出现的 \\uE000…\\uE001 这样的占位符（由不可见字符包住）必须在译文中',
    '   原样保留、位置对应、一个都不能少也不能多。它们代表已被替换掉的 URL、',
    '   代码、专有名词，你在译文中保留它们即可，不要翻译、不要改写、不要补全。',
    '5. 保留原文中的数字、单位、版本号、模型名、品牌名。',
    '6. 译文要符合' + tgt + '的表达习惯，通顺自然，不要逐字硬译。',
    '7. 如果某一项本身已经是' + tgt + '、或者是纯符号/纯数字/代码片段，原样返回。',
    '8. 不要输出任何"以下是译文"之类的引导语或收尾语。'
  ];

  if (contexts && contexts.some((c) => c)) {
    lines.push('');
    lines.push('关于上下文：每一项后面附带的可选字段 c 是该片段在页面中的位置线索');
    lines.push('（通常是「页面标题 › 区块标题」链），仅用于帮助你判断词义，不要把它翻译出来，也不要并进译文。');
  }

  // 场景提示（C-12 Q1b）：只对 LLM 引擎生效；无场景或未知场景时不追加任何内容。
  if (Array.isArray(scenes) && scenes.length) {
    const hints = [];
    for (const s of scenes) {
      if (SCENE_PROMPTS[s]) hints.push(SCENE_PROMPTS[s]);
    }
    if (hints.length) {
      lines.push('');
      lines.push('场景提示：' + hints.join(' '));
    }
  }

  return lines.join('\n');
}

/** 打包单条待译文本：有上下文线索时用对象形式，否则保持纯字符串（省 token） */
function packItem(text, ctx) {
  if (!ctx) return text;
  return { s: text, c: ctx };
}

async function openaiBatch(texts, source, target, settings, contexts, scenes) {
  const key = (settings.openaiApiKey || '').trim();
  if (!key) throw new Error('未配置 OpenAI 兼容接口的 API Key');

  const base = (settings.openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = settings.openaiModel || 'gpt-4o-mini';

  const hasCtx = Array.isArray(contexts) && contexts.some((c) => c);
  const userContent = JSON.stringify(
    hasCtx ? texts.map((t, i) => packItem(t, contexts[i])) : texts
  );

  const payload = {
    model: model,
    temperature: 0,
    messages: [
      { role: 'system', content: buildOpenAISystemPrompt(target, source, hasCtx ? contexts : null, scenes) },
      { role: 'user', content: userContent }
    ]
  };

  let data = await postChat(base, key, Object.assign({ response_format: { type: 'json_object' } }, payload));

  // 部分兼容服务不支持 response_format，去掉后重试一次
  if (!data) {
    data = await postChat(base, key, payload);
  }
  if (!data) throw new Error('OpenAI 兼容接口调用失败');

  const content = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content : '';
  if (!content) throw new Error('模型返回为空');

  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(content));
  } catch (e) {
    throw new Error('模型未按要求返回 JSON');
  }

  const arr = Array.isArray(parsed) ? parsed : (parsed.t || parsed.translations || parsed.result);
  if (!Array.isArray(arr)) throw new Error('模型返回缺少译文数组');
  if (arr.length !== texts.length) {
    throw new Error('模型返回条目数不匹配（期望 ' + texts.length + '，实际 ' + arr.length + '）');
  }
  return arr.map((x) => (typeof x === 'string' ? x : String(x)));
}

async function postChat(base, key, payload) {
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // response_format 不被支持时返回 null，交给调用方重试
    if (payload.response_format && (res.status === 400 || res.status === 422)) return null;
    throw new Error('模型接口返回 HTTP ' + res.status + (text ? '：' + text.slice(0, 160) : ''));
  }
  return res.json();
}

function stripCodeFence(s) {
  let t = String(s).trim();
  if (t.indexOf('```') === 0) {
    t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '');
  }
  return t.trim();
}

/* ==================================================================
 * 五、调度：自动选择引擎
 * ================================================================== */

/**
 * 解析出真正要使用的引擎 id
 * @returns {Promise<{provider: string, reason?: string}>}
 */
export async function resolveProvider(settings, source, target) {
  const want = settings.provider || 'auto';

  if (want !== 'auto') {
    if (want === 'chrome-builtin') {
      const a = await builtinAvailability(source, target);
      if (a === 'unavailable' || a === 'unsupported') {
        // C-60（Z5）：这条 reason 会经 notice 直接上屏给用户看，
        // 因此不写「模型」「降级」这类术语，只说发生了什么 + 现在在用哪条通道。
        return { provider: 'google-free', reason: '已自动改用 Google 翻译（本机翻译在你这版浏览器上不可用）' };
      }
    }
    return { provider: want };
  }

  // auto：优先本地模型（免费 + 隐私），不可用则 Google
  const a = await builtinAvailability(source, target);
  if (a === 'available' || a === 'downloadable' || a === 'downloading') {
    return { provider: 'chrome-builtin' };
  }
  return { provider: 'google-free' };
}

/**
 * 统一入口
 * @param {{texts: string[], source: string, target: string, settings: Object,
 *          provider?: string, contexts?: string[], scenes?: string[]}} args
 *        provider 可由调用方预先解析后传入，避免为每一批重复解析引擎
 *        contexts 与 texts 等长的位置线索（通常是所属标题），仅 LLM 引擎使用 ——
 *        Google / DeepL / 内置模型的接口都只接受纯文本，塞进去只会污染译文
 *        scenes 本页场景 id 列表（v1.7.4 C-12 Q1b），仅 LLM 引擎消费 ——
 *        拼进 system prompt 的场景提示，帮助多义词在特定场景下取义
 * @returns {Promise<{translations: string[], provider: string, notice?: string}>}
 */

/* C-21：批级超时保护。
 * 引擎侧挂起（fetch 永不返回 / 内置模型 translate 永不 resolve）时，
 * 上层 mapLimit 的 runner 会永远阻塞，页面 badge 卡在「翻译中 N / M」。
 * 这里给每个引擎批次套一个上限，超时抛出明确错误 ——
 * service worker 的批次级 try/catch 会把它计入 failures，管线正常收尾。 */
function batchTimeoutMs(provider) {
  const map = (CT && CT.TRANSLATE_TIMEOUT_MS) || {};
  return map[provider] || map.DEFAULT || 90000;
}

function withTimeout(promise, ms, provider) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('引擎 ' + provider + ' 超过 ' + Math.round(ms / 1000)
        + ' 秒无响应，本批已中断（稍后重试或降低并发可恢复）'));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

export async function translateBatch({ texts, source, target, settings, provider: preset, contexts, scenes }) {
  if (!Array.isArray(texts) || !texts.length) return { translations: [], provider: settings.provider };

  const resolved = preset ? { provider: preset } : await resolveProvider(settings, source, target);
  const { provider, reason } = resolved;

  // 本地模型要求指定明确的源语言，'auto' 无法创建
  const effectiveSource = source && source !== 'auto' ? source : 'en';

  let translations;
  switch (provider) {
    case 'chrome-builtin':
      translations = await withTimeout(
        builtinBatch(texts, effectiveSource, target), batchTimeoutMs(provider), provider);
      break;
    case 'deepl':
      translations = await withTimeout(
        deeplBatch(texts, source, target, settings), batchTimeoutMs(provider), provider);
      break;
    case 'openai':
      translations = await withTimeout(
        openaiBatch(texts, source, target, settings, contexts, scenes), batchTimeoutMs(provider), provider);
      break;
    case 'google-free':
    default:
      translations = await withTimeout(
        googleBatch(texts, source && source !== 'auto' ? source : 'auto', target),
        batchTimeoutMs(provider), provider);
      break;
  }

  if (!Array.isArray(translations) || translations.length !== texts.length) {
    throw new Error('译文条数与原文不匹配，已放弃这一批');
  }

  const result = { translations, provider };
  if (reason) result.notice = reason;
  return result;
}

/**
 * 连通性自检：翻译一个短句，用于设置页的「测试」按钮
 * ------------------------------------------------------------------
 * 探测句必须与目标语言**不同**。旧实现固定用一句英文去探，于是当
 * 目标语言被设成英语时，探针等于让引擎把英文翻成英文，返回原文，
 * 用户看到的是「测试通过但译文没变」，没法判断引擎到底通不通。
 */
export async function probe(settings) {
  const target = settings.targetLang || 'zh-CN';
  const tNorm = CT.settings.normalizeLang(target);
  const englishTarget = tNorm === 'en';
  const r = await translateBatch({
    texts: [englishTarget
      ? '你好，这是一句用于检测连通性的测试文本。'
      : 'Hello, world. This is a connectivity test.'],
    source: englishTarget ? 'zh-CN' : 'en',
    target,
    settings
  });
  return { provider: r.provider, translated: r.translations[0], notice: r.notice };
}

/** 主动下载内置语言模型（需要用户手势，从设置页调用） */
export async function prepareBuiltinModel(source, target) {
  const api = getBuiltinApi();
  if (!api) return { ok: false, message: '当前浏览器不支持内置翻译模型（需 Chrome 138+）' };

  const availability = await builtinAvailability(source, target);
  if (availability === 'unsupported') {
    return { ok: false, message: '当前浏览器不支持内置翻译模型' };
  }
  if (availability === 'unavailable') {
    return { ok: false, message: '该语向暂不支持内置模型：' + source + ' → ' + target };
  }
  if (availability === 'available') {
    return { ok: true, message: '语言包已就绪，无需下载' };
  }

  try {
    const t = await api.create({ sourceLanguage: source, targetLanguage: target });
    builtinPool.set(source + '->' + target, t);
    // 语言包已就绪，之前记下的 downloadable/unsupported 结论立即作废
    invalidateAvailability(source, target);
    return { ok: true, message: '语言包下载完成（' + source + ' → ' + target + '）' };
  } catch (e) {
    return { ok: false, message: '下载失败：' + (e && e.message ? e.message : String(e)) };
  }
}
