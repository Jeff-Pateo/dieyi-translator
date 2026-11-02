/*
 * 双语助手 · 翻译引擎适配层测试
 * ------------------------------------------------------------------
 * providers.js 是纯逻辑模块（只依赖 fetch 与 self.CT），因此可以在 Node 里
 * 通过打桩 fetch 直接验证：请求次数、请求体、响应解析、降级路径是否正确。
 *
 * 运行：
 *   node tools/test-providers.js
 */
'use strict';

// providers.js / constants.js 都以 self 为全局根，Node 里先把它指到 globalThis
globalThis.self = globalThis;

/* ------------------------------------------------------------------ */
/* 断言工具                                                            */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + label); }
  else { failed++; console.log('  \u2717 ' + label + (detail ? '  → ' + detail : '')); }
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(label, a === b, '实际 ' + a + '，期望 ' + b);
}

function section(t) { console.log('\n' + t); }

/* ------------------------------------------------------------------ */
/* fetch 打桩                                                          */
/* ------------------------------------------------------------------ */

const calls = [];

function jsonRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

/** 安装一个按「URL 关键词 → 处理函数」分发的假 fetch */
function stubFetch(routes) {
  calls.length = 0;
  globalThis.fetch = async (url, init) => {
    const entry = { url: String(url), init: init || {} };
    calls.push(entry);
    for (const [key, handler] of routes) {
      if (entry.url.indexOf(key) >= 0) return handler(entry);
    }
    throw new Error('测试未覆盖的请求地址：' + entry.url);
  };
}

/* ------------------------------------------------------------------ */
/* 载入被测模块                                                        */
/* ------------------------------------------------------------------ */

(async function main() {
  const P = await import('../background/providers.js');
  const CT = globalThis.CT;

  const baseSettings = Object.assign({}, CT.DEFAULT_SETTINGS);

  /* ============================ 批大小提示 ============================ */
  section('一、批大小提示');
  eq('Google 一次一段', P.batchHintFor('google-free'), 1);
  ok('DeepL 可批量', P.batchHintFor('deepl') > 1);
  ok('OpenAI 可批量', P.batchHintFor('openai') > 1);
  ok('未知引擎有兜底值', P.batchHintFor('nope') > 0);

  /* ============================ 引擎选择 ============================ */
  section('二、引擎选择（auto 降级逻辑）');

  delete globalThis.Translator;
  let r = await P.resolveProvider(Object.assign({}, baseSettings, { provider: 'auto' }), 'en', 'zh-CN');
  eq('无内置模型时 auto → google-free', r.provider, 'google-free');

  globalThis.Translator = {
    availability: async () => 'available',
    create: async () => ({ translate: async (t) => '译:' + t, destroy() {} })
  };
  r = await P.resolveProvider(Object.assign({}, baseSettings, { provider: 'auto' }), 'en', 'zh-CN');
  eq('内置模型可用时 auto → chrome-builtin', r.provider, 'chrome-builtin');

  globalThis.Translator = { availability: async () => 'unavailable' };
  r = await P.resolveProvider(Object.assign({}, baseSettings, { provider: 'chrome-builtin' }), 'en', 'zh-CN');
  eq('强制内置但不可用 → 降级 google-free', r.provider, 'google-free');
  ok('  并给出降级原因', typeof r.reason === 'string' && r.reason.length > 0);

  eq('显式指定 deepl 时不被改写',
    (await P.resolveProvider(Object.assign({}, baseSettings, { provider: 'deepl' }), 'en', 'zh-CN')).provider, 'deepl');

  /* ============================ Google ============================ */
  section('三、Google 免费接口');
  delete globalThis.Translator;

  stubFetch([['translate.googleapis.com', () => jsonRes(200, [[['你好', 'Hello']], null, 'en'])]]);
  let out = await P.translateBatch({
    texts: ['Hello', 'World', 'Again'],
    source: 'auto',
    target: 'zh-CN',
    settings: Object.assign({}, baseSettings, { provider: 'google-free' })
  });
  eq('3 段发起 3 次请求（不做有风险的合并）', calls.length, 3);
  eq('每段各自拿到译文', out.translations, ['你好', '你好', '你好']);
  eq('返回使用的引擎', out.provider, 'google-free');

  const firstBody = calls[0].init.body || '';
  ok('请求带 client=gtx', firstBody.indexOf('client=gtx') >= 0);
  ok('请求带目标语言 tl=zh-CN', firstBody.indexOf('tl=zh-CN') >= 0);
  ok('请求带原文', decodeURIComponent(firstBody).indexOf('q=Hello') >= 0);

  stubFetch([['translate.googleapis.com', () => jsonRes(429, {})]]);
  let threw = null;
  try {
    await P.translateBatch({
      texts: ['Hello'], source: 'en', target: 'zh-CN',
      settings: Object.assign({}, baseSettings, { provider: 'google-free' })
    });
  } catch (e) { threw = e; }
  ok('429 会抛出错误', !!threw);
  ok('  错误信息提示了限流', !!threw && threw.message.indexOf('429') >= 0);

  stubFetch([['translate.googleapis.com', () => jsonRes(200, { unexpected: true })]]);
  threw = null;
  try {
    await P.translateBatch({
      texts: ['Hello'], source: 'en', target: 'zh-CN',
      settings: Object.assign({}, baseSettings, { provider: 'google-free' })
    });
  } catch (e) { threw = e; }
  ok('返回结构异常时抛错而不是静默返回空', !!threw && threw.message.indexOf('结构异常') >= 0);

  /* ============================ DeepL ============================ */
  section('四、DeepL');

  stubFetch([['deepl.com', () => jsonRes(200, {
    translations: [{ text: '甲' }, { text: '乙' }, { text: '丙' }]
  })]]);
  out = await P.translateBatch({
    texts: ['one', 'two', 'three'],
    source: 'en',
    target: 'zh-TW',
    settings: Object.assign({}, baseSettings, { provider: 'deepl', deeplApiKey: 'k:test', deeplPlan: 'free' })
  });
  eq('DeepL 三段只发一次请求', calls.length, 1);
  eq('译文顺序对齐', out.translations, ['甲', '乙', '丙']);

  const dBody = calls[0].init.body || '';
  ok('繁体目标映射为 ZH-HANT', dBody.indexOf('target_lang=ZH-HANT') >= 0);
  // 源语言用 EN 而不是 EN-GB：DeepL 的 source_lang 只认 EN（不区分英美），
  // EN-GB / EN-US 是 target_lang 才有的细分。写 EN-GB 会被接口拒绝。
  ok('英文源映射为 EN', dBody.indexOf('source_lang=EN&') >= 0 || dBody.endsWith('source_lang=EN'));
  ok('Key 走 Authorization 头', String(calls[0].init.headers.Authorization).indexOf('DeepL-Auth-Key') >= 0);
  ok('免费版走 api-free 域名', calls[0].url.indexOf('api-free') >= 0);

  stubFetch([['deepl.com', () => jsonRes(456, {})]]);
  threw = null;
  try {
    await P.translateBatch({
      texts: ['one'], source: 'en', target: 'zh-CN',
      settings: Object.assign({}, baseSettings, { provider: 'deepl', deeplApiKey: 'k' })
    });
  } catch (e) { threw = e; }
  ok('456 提示额度用尽', !!threw && threw.message.indexOf('额度') >= 0);

  threw = null;
  try {
    await P.translateBatch({
      texts: ['one'], source: 'en', target: 'zh-CN',
      settings: Object.assign({}, baseSettings, { provider: 'deepl', deeplApiKey: '' })
    });
  } catch (e) { threw = e; }
  ok('缺 Key 时提前报错', !!threw && threw.message.indexOf('Key') >= 0);

  /* ============================ OpenAI ============================ */
  section('五、OpenAI 兼容接口');

  stubFetch([['/chat/completions', () => jsonRes(200, {
    choices: [{ message: { content: '```json\n{"t": ["壹", "贰"]}\n```' } }]
  })]]);
  out = await P.translateBatch({
    texts: ['alpha', 'beta'],
    source: 'auto',
    target: 'zh-CN',
    settings: Object.assign({}, baseSettings, { provider: 'openai', openaiApiKey: 'sk-x', openaiBaseUrl: 'https://api.openai.com/v1/' })
  });
  eq('剥离 ```json 代码块后解析成功', out.translations, ['壹', '贰']);
  ok('Base URL 末尾斜杠被规整', calls[0].url.indexOf('/v1//chat') < 0 && calls[0].url.indexOf('/v1/chat/completions') >= 0);
  ok('提示词要求输出 JSON 且长度一致',
    JSON.parse(calls[0].init.body).messages[0].content.indexOf('逐项一一对应') >= 0);

  /* ---- 多语言互译：提示词里的目标语言必须真的跟着 targetLang 走 ---- */
  let sysZh = JSON.parse(calls[0].init.body).messages[0].content;
  ok('中文目标的提示词用中文语种名', sysZh.indexOf('简体中文') >= 0);

  stubFetch([['/chat/completions', () => jsonRes(200, {
    choices: [{ message: { content: '{"t": ["one", "two"]}' } }]
  })]]);
  await P.translateBatch({
    texts: ['甲', '乙'], source: 'zh-CN', target: 'ja',
    settings: Object.assign({}, baseSettings, { provider: 'openai', openaiApiKey: 'sk-x' })
  });
  const sysJa = JSON.parse(calls[0].init.body).messages[0].content;
  // 注意：源语言是 zh-CN，所以提示词里**本来就会出现**「简体中文」——
  // 那是在说明源语言。要断言的是「目标语言」那一格不再是中文。
  ok('日语目标的提示词指向日本語', sysJa.indexOf('目标语言：日本語') >= 0);
  ok('日语目标不再把目标语言写成中文', sysJa.indexOf('目标语言：简体中文') < 0);
  ok('日语目标不再出现「中文表达习惯」', sysJa.indexOf('中文表达习惯') < 0);

  /* ---- 位置线索：短文本才带 ctx，且只在 LLM 引擎上传 ---- */
  stubFetch([['/chat/completions', () => jsonRes(200, {
    choices: [{ message: { content: '{"t": ["首页"]}' } }]
  })]]);
  await P.translateBatch({
    texts: ['Home'], source: 'en', target: 'zh-CN', contexts: ['导航'],
    settings: Object.assign({}, baseSettings, { provider: 'openai', openaiApiKey: 'sk-x' })
  });
  const userMsg = JSON.parse(calls[0].init.body).messages[1].content;
  ok('带上下文时用户消息改成对象数组', userMsg.indexOf('"c":"导航"') >= 0);
  ok('提示词说明了 c 字段的含义',
    JSON.parse(calls[0].init.body).messages[0].content.indexOf('位置线索') >= 0);

  /* ---- 场景提示（v1.7.4 C-12 Q1b）：scene 只注入 LLM 引擎的 system prompt ---- */
  stubFetch([['/chat/completions', () => jsonRes(200, {
    choices: [{ message: { content: '{"t": ["申请"]}' } }]
  })]]);
  await P.translateBatch({
    texts: ['Apply'], source: 'en', target: 'zh-CN', scenes: ['recruiting'],
    settings: Object.assign({}, baseSettings, { provider: 'openai', openaiApiKey: 'sk-x' })
  });
  const sysScene = JSON.parse(calls[0].init.body).messages[0].content;
  ok('招聘场景提示被注入 system prompt',
    sysScene.indexOf('场景提示') >= 0 && sysScene.indexOf('申请') >= 0);
  ok('场景提示不碰硬性要求（1–8 条原样在）',
    sysScene.indexOf('逐项一一对应') >= 0);

  await P.translateBatch({
    texts: ['Apply'], source: 'en', target: 'zh-CN', scenes: [],
    settings: Object.assign({}, baseSettings, { provider: 'openai', openaiApiKey: 'sk-x' })
  });
  ok('无场景时不追加场景提示',
    JSON.parse(calls[calls.length - 1].init.body).messages[0].content.indexOf('场景提示') < 0);

  await P.translateBatch({
    texts: ['Apply'], source: 'en', target: 'zh-CN', scenes: ['unknown-scene'],
    settings: Object.assign({}, baseSettings, { provider: 'openai', openaiApiKey: 'sk-x' })
  });
  ok('未知场景 id 同样不追加（宁缺勿滥）',
    JSON.parse(calls[calls.length - 1].init.body).messages[0].content.indexOf('场景提示') < 0);

  /* ---- DeepL 不支持的目标语言必须明确报错，而不是悄悄翻成中文 ---- */
  stubFetch([['deepl.com', () => jsonRes(200, { translations: [{ text: 'x' }] })]]);
  let deeplErr = null;
  try {
    await P.translateBatch({
      texts: ['hello'], source: 'en', target: 'th',
      settings: Object.assign({}, baseSettings, { provider: 'deepl', deeplApiKey: 'dk-x' })
    });
  } catch (e) { deeplErr = e; }
  ok('DeepL 不支持的语向明确报错', !!deeplErr && deeplErr.message.indexOf('暂不支持') >= 0);
  ok('报错时没有发出请求', calls.length === 0);

  // response_format 不被支持时，应去掉该参数重试一次
  let n = 0;
  stubFetch([['/chat/completions', () => {
    n++;
    if (n === 1) return jsonRes(400, { error: 'unsupported parameter' });
    return jsonRes(200, { choices: [{ message: { content: '{"t": ["甲"]}' } }] });
  }]]);
  out = await P.translateBatch({
    texts: ['alpha'], source: 'auto', target: 'zh-CN',
    settings: Object.assign({}, baseSettings, { provider: 'openai', openaiApiKey: 'sk-x' })
  });
  eq('400 后自动去掉 response_format 重试', out.translations, ['甲']);
  eq('  确实发出了两次请求', calls.length, 2);
  ok('  第一次带了 response_format', !!JSON.parse(calls[0].init.body).response_format);
  ok('  第二次没带 response_format', !JSON.parse(calls[1].init.body).response_format);

  // 条数不匹配必须报错，绝不能错位写入
  stubFetch([['/chat/completions', () => jsonRes(200, {
    choices: [{ message: { content: '{"t": ["只有一条"]}' } }]
  })]]);
  threw = null;
  try {
    await P.translateBatch({
      texts: ['a', 'b', 'c'], source: 'auto', target: 'zh-CN',
      settings: Object.assign({}, baseSettings, { provider: 'openai', openaiApiKey: 'sk-x' })
    });
  } catch (e) { threw = e; }
  ok('模型少返回条目时抛错（防止译文错位）', !!threw && threw.message.indexOf('条目数不匹配') >= 0);

  // 返回非 JSON
  stubFetch([['/chat/completions', () => jsonRes(200, {
    choices: [{ message: { content: '抱歉，我无法完成。' } }]
  })]]);
  threw = null;
  try {
    await P.translateBatch({
      texts: ['a'], source: 'auto', target: 'zh-CN',
      settings: Object.assign({}, baseSettings, { provider: 'openai', openaiApiKey: 'sk-x' })
    });
  } catch (e) { threw = e; }
  ok('模型返回非 JSON 时抛错', !!threw && threw.message.indexOf('JSON') >= 0);

  /* ============================ 内置模型 ============================ */
  section('六、Chrome 内置本地模型');

  const seen = [];
  globalThis.Translator = {
    availability: async () => 'available',
    create: async () => {
      seen.push('create');
      return {
        translate: async (t) => { seen.push(t); return '【' + t + '】'; },
        destroy() {}
      };
    }
  };
  out = await P.translateBatch({
    texts: ['one', 'two'],
    source: 'en',
    target: 'zh-CN',
    settings: Object.assign({}, baseSettings, { provider: 'auto' })
  });
  eq('auto 命中内置模型', out.provider, 'chrome-builtin');
  eq('逐段翻译且顺序正确', out.translations, ['【one】', '【two】']);
  eq('翻译器实例被复用（只 create 一次）', seen.filter((x) => x === 'create').length, 1);

  const av = await P.builtinAvailability('en', 'zh-CN');
  eq('可用性查询透传', av, 'available');

  const prepareCalls = [];
  globalThis.Translator = {
    availability: async () => 'downloadable',
    create: async (opts) => {
      prepareCalls.push(opts);
      return { translate: async (t) => t, destroy() {} };
    }
  };
  const prep = await P.prepareBuiltinModel('en', 'ja');
  ok('downloadable 状态会尝试创建（触发下载）', prep.ok === true, prep.message);
  eq('  创建时带上了正确的语向', prepareCalls.length === 1 ? prepareCalls[0].languagePair || prepareCalls[0].sourceLanguage : null, 'en');

  delete globalThis.Translator;
  const prep2 = await P.prepareBuiltinModel('en', 'ja');
  ok('无内置模型时给出明确提示', prep2.ok === false && prep2.message.indexOf('不支持') >= 0);

  /* ============================ 连通性自检 ============================ */
  section('七、连通性自检');

  stubFetch([['translate.googleapis.com', () => jsonRes(200, [[['你好，世界。这是一次连通性测试。', 'x']], null, 'en'])]]);
  const probe = await P.probe(Object.assign({}, baseSettings, { provider: 'google-free' }));
  eq('probe 返回引擎名', probe.provider, 'google-free');
  ok('probe 返回译文', typeof probe.translated === 'string' && probe.translated.length > 0);

  /* ============================ 空输入 ============================ */
  section('八、边界情况');
  const callsBefore = calls.length;
  out = await P.translateBatch({ texts: [], source: 'en', target: 'zh-CN', settings: baseSettings });
  eq('空输入直接返回空数组', out.translations, []);
  eq('空输入不发请求', calls.length - callsBefore, 0);

  /* ============================ 批级超时保护（C-21） ============================
   * 真实站点（remoteok.com）出现「翻译中 224 / 2396」永久卡死：引擎请求挂起
   * 而无超时 → mapLimit 永远阻塞。这里用「永不 resolve 的 fetch 桩」复现挂起，
   * 把超时临时调短，断言：超时必须转为明确报错，且计时器被清理（不泄漏）。 */
  section('九、批级超时保护（C-21）');

  // 1) 配置可见性：四个引擎 + DEFAULT 都有超时常量
  const tmap = CT.TRANSLATE_TIMEOUT_MS || {};
  ok('google-free 有超时配置', tmap['google-free'] === 30000);
  ok('chrome-builtin 有超时配置', tmap['chrome-builtin'] === 90000);
  ok('deepl 有超时配置', tmap['deepl'] === 40000);
  ok('openai 有超时配置', tmap['openai'] === 120000);
  ok('DEFAULT 兜底存在', tmap.DEFAULT === 90000);

  // 2) 挂起引擎 → 超时报错（临时把 google-free 超时调到 300ms）
  const realTimeout = tmap['google-free'];
  tmap['google-free'] = 300;
  let hangResolved = false;
  stubFetch([
    ['translate.googleapis.com', () => new Promise(() => { /* 永不 resolve —— 模拟引擎挂起 */ })]
  ]);
  let hangErr = null;
  const t0 = Date.now();
  try {
    await P.translateBatch({ texts: ['hello'], source: 'en', target: 'zh-CN',
      settings: Object.assign({}, baseSettings, { provider: 'google-free' }), provider: 'google-free' });
    hangResolved = true;
  } catch (e) {
    hangErr = e;
  }
  const elapsed = Date.now() - t0;
  ok('挂起引擎不会永久等待（超时转为报错）', !hangResolved && !!hangErr);
  ok('报错信息可懂（含引擎名与秒数）', hangErr && String(hangErr.message).indexOf('google-free') >= 0
    && /\d+ 秒/.test(String(hangErr.message)), hangErr ? hangErr.message : '(无错误)');
  ok('超时按配置生效（300ms 档，实测 ' + elapsed + 'ms）', elapsed >= 250 && elapsed < 3000);
  tmap['google-free'] = realTimeout;

  // 3) 超时后计时器必须被清理：正常请求仍能成功（若计时器泄漏，Node 进程会挂住不退出）
  stubFetch([['translate.googleapis.com', () => jsonRes(200, [[['你好。', 'x']], null, 'en'])]]);
  out = await P.translateBatch({ texts: ['hello'], source: 'en', target: 'zh-CN',
    settings: Object.assign({}, baseSettings, { provider: 'google-free' }), provider: 'google-free' });
  eq('超时恢复后正常批次照常翻译', out.translations, ['你好。']);
  await new Promise((r) => setTimeout(r, 350)); // 若超时计时器泄漏，此处的挂起定时器会让进程无法正常退出

  console.log('\n' + '─'.repeat(52));
  console.log(failed === 0
    ? '全部通过：' + passed + ' 项断言'
    : '失败 ' + failed + ' 项，通过 ' + passed + ' 项');
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n测试脚本异常终止：', e);
  process.exit(1);
});
