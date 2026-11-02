/*
 * 双语助手 · 术语基座与治理自检 —— v1.7.1
 * ==================================================================
 * 背景：截图现场 `Senior Growth Product Manager AI Native`
 *       被译成 → 高级**成长**产品经理（应是「增长」）。
 *
 * 这不是引擎的 bug —— 无约束时把 Growth 取成「成长」是必然的默认行为。
 * 机制（掩码 → 送翻 → 还原）早在 shared/protect.js 就实现了，
 * 缺的是**数据**：settings.glossary 的默认值是空数组。
 *
 * 本套断言钉四件事：
 *   一 基座本身是不是干净的数据（结构、域、字段）
 *   二 合并规则（用户 > 基座、分域、**目标语言隔离**）
 *   三 审计器能不能把坏数据认出来（六类 error 的**正例与反例**都要）
 *   四 端到端：真实句子走一遍 mask → restore，术语真的落地
 *
 * 【为什么第三节要测「反例」】
 * 只测「坏数据被报出来」不够 —— 一个把所有输入都报错的审计器同样能通过。
 * 必须同时断言「好数据一条警告都不报」，否则审计器一上线就会被当噪音忽略。
 *
 * 【为什么第二节要专测目标语言隔离】
 * 这是最容易酿成灾难的一条：若中文译名不受 targetLang 过滤，
 * 用户把目标语言设成日语时，`Product Manager` 会被硬替换成中文「产品经理」。
 * 它不是「翻得不好」，是把另一种语言塞进了译文里。
 *
 * 运行：
 *   npm run test:terminology
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let passed = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + label); }
  else { failures.push(label); console.log('  \u2717 ' + label + (detail ? '  → ' + detail : '')); }
}
function eq(label, actual, expected) {
  ok(label + '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）',
    actual === expected);
}
function section(t) { console.log('\n' + t); }

/* 三个 UMD 普通脚本，在全局上下文里执行（顺序同 content_scripts） */
globalThis.self = globalThis;
for (const rel of ['shared/constants.js', 'shared/terminology.js', 'shared/protect.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), { filename: rel });
}
const CT = globalThis.CT;
const T = CT.terminology;
const P = CT.protect;

const codes = (list) => list.map((x) => x.code);
const find = (list, code) => list.filter((x) => x.code === code).length;

/* ================================================================== */
/* 一、基座数据本身                                                     */
/* ================================================================== */

section('一、基座结构');
{
  ok('基座非空', T.BASE.length > 0, String(T.BASE.length));
  ok('基座规模已到「有实用价值」的量级（≥ 60 条）', T.BASE.length >= 60, String(T.BASE.length));
  eq('治理版本号是可读的日期式', /^\d{4}\.\d{2}\.\d{2}-\d+$/.test(T.VERSION), true);

  /* 域定义完整 */
  const ids = T.DOMAINS.map((d) => d.id);
  for (const want of ['recruiting', 'product', 'tech', 'business', 'proper']) {
    ok('域 ' + want + ' 已定义', ids.indexOf(want) >= 0, JSON.stringify(ids));
  }
  for (const d of T.DOMAINS) {
    ok('  域 ' + d.id + ' 有中文标签', typeof d.label === 'string' && d.label.length > 0);
  }

  /* 每条都落在已定义的域里，且必填字段齐备 */
  let badDomain = 0;
  let badField = 0;
  let badTo = 0;
  for (const e of T.BASE) {
    if (ids.indexOf(e.domain) < 0) badDomain++;
    if (!e.from || typeof e.from !== 'string' || !e.from.trim()) badField++;
    if (typeof e.to !== 'string') badTo++;
  }
  eq('所有条目落在已定义的域内', badDomain, 0);
  eq('所有条目都有非空 from', badField, 0);
  eq('所有条目的 to 都是字符串（空串 = 保持原样）', badTo, 0);

  /* 保持原样的条目只应出现在 proper 域里 ——
   * 其它域里写 to:'' 多半是漏填，不是本意 */
  const keepAsIsOutsideProper = T.BASE.filter((e) => e.to === '' && e.domain !== 'proper');
  eq('「保持原样」条目全部归在 proper 域', keepAsIsOutsideProper.length, 0);

  /* 截图现场的三个词必须在基座里 */
  const froms = T.BASE.map((e) => e.from);
  ok('含 Growth Product Manager（截图现场词）', froms.indexOf('Growth Product Manager') >= 0);
  ok('含 Product Manager（截图标签行）', froms.indexOf('Product Manager') >= 0);
  ok('含 Magic Eden（截图品牌，须保持原样）', froms.indexOf('Magic Eden') >= 0);
  eq('  Magic Eden 的 to 是空串（保持原样，不意译）',
    (T.BASE.find((e) => e.from === 'Magic Eden') || {}).to, '');

  /* 被有意排除的多义词必须有留痕 */
  ok('多义词留痕表非空', T.AMBIGUOUS.length > 0, String(T.AMBIGUOUS.length));
  ok('  Growth 被登记为有意排除',
    T.AMBIGUOUS.some((a) => a.word === 'Growth'));
  ok('  留痕带原因说明', T.AMBIGUOUS.every((a) => typeof a.why === 'string' && a.why.length > 8));

  /* 留痕里被排除的多义词，**不得**以「无条件下」的裸词形式出现在基座里。
   * 这是治理规则 G1 的可执行表达：收了就等于把新旧错译对调。
   * v1.7.2 起：带 scenes 字段的条目 = 已声明消歧条件，允许存在 ——
   * 但必须真的带非空 scenes，否则视同裸词（用测试把口子钉死）。 */
  for (const a of T.AMBIGUOUS) {
    const naked = T.BASE.filter((e) => e.from === a.word);
    const unconstrained = naked.filter((e) => !e.scenes || !e.scenes.length);
    eq('  「' + a.word + '」未被无条件下收进基座', unconstrained.length, 0);
    for (const e of naked) {
      ok('  场景条目「' + a.word + '」带非空 scenes（消歧条件写入数据）',
        Array.isArray(e.scenes) && e.scenes.length > 0, JSON.stringify(e.scenes));
    }
  }
}

/* ================================================================== */
/* 二、合并规则                                                        */
/* ================================================================== */

section('二、mergeGlossary');
{
  /* v1.7.2 起：无场景信息时带 scenes 字段的条目不生效。
   * 基座全长 = BASE.length；无场景合并长度 = 非场景条目数。
   * 期望值一律从基座推导，不再硬编码 —— 基座增删时测试自然跟随。 */
  const noSceneLen = T.BASE.filter((e) => !e.scenes || !e.scenes.length).length;
  const sceneLen = T.BASE.filter((e) => e.scenes && e.scenes.length).length;

  /* --- 空输入 --- */
  eq('无参调用返回基座全长（场景条目除外）', T.mergeGlossary().length, noSceneLen);
  eq('null 用户表不报错', T.mergeGlossary(null).length, noSceneLen);
  eq('非数组用户表不报错', T.mergeGlossary('nope').length, noSceneLen);

  /* --- 用户 > 基座 --- */
  const merged = T.mergeGlossary([{ from: 'Product Manager', to: '产品负责人' }], { targetLang: 'zh-CN' });
  eq('用户同名条目覆盖基座译名',
    (merged.find((t) => t.from === 'Product Manager') || {}).to, '产品负责人');
  eq('  总条数不变（是覆盖，不是追加）', merged.length, noSceneLen);

  /* --- 大小写不敏感地判重 --- */
  const caseDup = T.mergeGlossary([{ from: 'product manager', to: 'A' }, { from: 'PRODUCT MANAGER', to: 'B' }]);
  eq('大小写不同视为同一条，只入场一次',
    caseDup.filter((t) => t.from.toLowerCase() === 'product manager').length, 1);
  eq('  先到者生效', (caseDup.find((t) => t.from.toLowerCase() === 'product manager') || {}).to, 'A');

  /* --- 空 from 被丢弃 --- */
  const dirty = T.mergeGlossary([{ from: '   ', to: 'x' }, null, { to: 'y' }]);
  eq('空 from / 空条目被静默丢弃', dirty.length, noSceneLen);

  /* --- 分域过滤 --- */
  const onlyTech = T.mergeGlossary([], { domains: ['tech'] });
  const techCount = T.BASE.filter((e) => e.domain === 'tech' && e.to !== '').length +
    T.BASE.filter((e) => e.domain === 'tech' && e.to === '').length;
  eq('只开 tech 域时条数等于该域条数', onlyTech.length, techCount);
  ok('  不含 recruiting 的词', !onlyTech.some((t) => t.from === 'Product Manager'));

  const twoDomains = T.mergeGlossary([], { domains: ['tech', 'proper'] });
  eq('开两个域时条数相加',
    twoDomains.length,
    T.BASE.filter((e) => e.domain === 'tech' || e.domain === 'proper').length);

  /* 带场景的合并 = 非场景条目 + 场景条目（招聘场景下恰好是全基座） */
  eq('domains 为 null = 全开（含场景条目）',
    T.mergeGlossary([], { domains: null, scenes: ['recruiting'] }).length,
    noSceneLen + sceneLen);
  /* 空数组必须与 null 同义：设置页存不了 null（合并函数丢弃 null 补丁字段），
   * 「全选」只能用空数组表达。若把空数组当成「零个域」，点一下全选就没术语了。 */
  eq('domains 为空数组 = 同样全开（设置页「全选」的表达方式）',
    T.mergeGlossary([], { domains: [], scenes: ['recruiting'] }).length,
    noSceneLen + sceneLen);

  /* --- 用户表不受分域开关影响（用户写了就算数） --- */
  const userKept = T.mergeGlossary([{ from: 'Xyz', to: '某词' }], { domains: ['tech'] });
  ok('关掉所有含它的域，用户条目仍然生效',
    userKept.some((t) => t.from === 'Xyz' && t.to === '某词'));
}

section('二·补 目标语言隔离（最容易酿成灾难的一条）');
{
  const keepAsIs = T.BASE.filter((e) => e.to === '').length;

  const ja = T.mergeGlossary([], { targetLang: 'ja' });
  const fr = T.mergeGlossary([], { targetLang: 'fr' });
  const de = T.mergeGlossary([], { targetLang: 'de' });

  eq('日语语向下只剩「保持原样」条目', ja.length, keepAsIs);
  eq('法语语向同上', fr.length, keepAsIs);
  eq('德语语向同上', de.length, keepAsIs);

  const cjk = /[\u3400-\u4DBF\u4E00-\u9FFF]/;
  eq('日语语向里没有任何中文译名', ja.filter((t) => cjk.test(t.to)).length, 0);
  eq('法语语向里没有任何中文译名', fr.filter((t) => cjk.test(t.to)).length, 0);

  ok('  Product Manager 不在日语语向里',
    !ja.some((t) => t.from === 'Product Manager'));
  ok('  但保持原样的 NFT 仍在（它对任何目标语言都成立）',
    ja.some((t) => t.from === 'NFT'));

  /* 未声明 targetLang 时默认 zh-CN（长度 = 非场景条目数，从基座推导） */
  eq('缺省 targetLang 视为 zh-CN', T.mergeGlossary([]).length,
    T.BASE.filter((e) => !e.scenes || !e.scenes.length).length);

  /* 显式声明了非中文语向的条目，应当**只**在那个语向里生效。
   * 临时插一条 tgt:ja 的条目来验证 —— 这是基座唯一允许跨语向的例外路径。 */
  T.BASE.push({ from: 'Fixture Ja Only', to: 'テスト用', domain: 'recruiting', tgt: 'ja' });
  try {
    ok('声明 tgt:ja 的条目出现在日语语向',
      T.mergeGlossary([], { targetLang: 'ja' }).some((t) => t.from === 'Fixture Ja Only'));
    ok('  不出现在中文语向',
      !T.mergeGlossary([], { targetLang: 'zh-CN' }).some((t) => t.from === 'Fixture Ja Only'));
  } finally {
    T.BASE.pop();
  }
}

/* ================================================================== */
/* 三、哈希：顺序不敏感，变更敏感                                       */
/* ================================================================== */

section('三、termHash（缓存键的一致性依据）');
{
  const zh = T.mergeGlossary([], { targetLang: 'zh-CN' });
  const h1 = T.termHash(zh);
  const h2 = T.termHash(zh.slice().reverse());
  eq('顺序颠倒后哈希不变（否则合并顺序变化会让缓存整体失效）', h1 === h2, true);

  const hAdd = T.termHash(zh.concat([{ from: 'Fixture Only', to: '仅测试' }]));
  eq('新增一条术语 → 哈希变化', h1 !== hAdd, true);

  const hEdit = T.termHash(zh.map((t) => (t.from === 'Product Manager' ? { from: t.from, to: '产品负责人' } : t)));
  eq('改一条译名 → 哈希变化', h1 !== hEdit, true);

  const hDel = T.termHash(zh.slice(1));
  eq('删一条术语 → 哈希变化', h1 !== hDel, true);

  eq('空表也有稳定哈希', T.termHash([]), T.termHash([]));
  eq('空表与 null 同值', T.termHash([]), T.termHash(null));

  /* 版本号参与哈希 —— 否则基座新增术语而用户表未动时哈希不变，
   * 缓存里那条错译永远不被纠正 */
  const before = T.termHash(zh);
  const saved = CT.TERMINOLOGY_VERSION;
  CT.TERMINOLOGY_VERSION = '9999.01.01-9';
  const after = T.termHash(zh);
  CT.TERMINOLOGY_VERSION = saved;
  eq('治理版本号变化 → 哈希变化（基座升级才能淘汰旧错译）', before !== after, true);
  eq('  恢复版本号后哈希回到原值', T.termHash(zh), before);

  /* 与 cache.js 的键拼接约定一致：哈希不能含分隔符，否则键结构会串位 */
  ok('哈希不含 | 分隔符', h1.indexOf('|') < 0, h1);
  ok('哈希是短字符串（不撑大存储键）', h1.length <= 16, h1 + '（' + h1.length + '）');
}

/* ================================================================== */
/* 四、审计器：error 六类 + warning 五类，正反例都要                    */
/* ================================================================== */

section('四、auditGlossary');
{
  /* --- 反例优先：干净数据必须一条都不报 --- */
  const clean = T.auditGlossary(T.BASE);
  eq('基座本身 errors = 0', clean.errors.length, 0, JSON.stringify(clean.errors));
  eq('基座本身 warnings = 0', clean.warnings.length, 0, JSON.stringify(clean.warnings));

  const cleanUser = T.auditGlossary([
    { from: 'Prompt', to: '提示词' },
    { from: 'User ID', to: '用户标识' },
    { from: 'Magic Eden', to: '' }
  ]);
  eq('正常用户表 errors = 0', cleanUser.errors.length, 0, JSON.stringify(cleanUser.errors));
  eq('正常用户表 warnings = 0', cleanUser.warnings.length, 0, JSON.stringify(cleanUser.warnings));
  eq('  统计到 2 条给出译名', cleanUser.stats.translated, 2);
  eq('  统计到 1 条保持原样', cleanUser.stats.keepAsIs, 1);

  /* --- 结构异常 --- */
  const notArray = T.auditGlossary('not-an-array');
  eq('非数组 → not-array', find(notArray.errors, 'not-array'), 1);

  const struct = T.auditGlossary([
    { from: '   ', to: '空词' },                                  // empty-from
    { from: 'OK', to: '好\uE000' },                               // pua-in-to
    { from: '的', to: 'x' },                                      // cjk-too-short
    { from: 'Go', to: 'Golang' },                                 // latin-too-short（warning）
    { from: 'Multi', to: '第一行\n第二行' },                        // newline-in-to（warning）
    { from: 'Tiny', to: '这是一个明显长于原文三倍且超过十二个字的译名' },  // length-bloat（warning）
    { from: 'Prompt', to: '提示词' },
    { from: 'prompt', to: '提示语' }                               // conflict（warning）
  ]);
  eq('空 from → empty-from', find(struct.errors, 'empty-from'), 1);
  eq('译名含私用区字符 → pua-in-to', find(struct.errors, 'pua-in-to'), 1);
  eq('单字 CJK 术语 → cjk-too-short', find(struct.errors, 'cjk-too-short'), 1);
  eq('error 总数 = 3', struct.errors.length, 3);
  const shortLatin = struct.warnings.filter((w) => w.code === 'latin-too-short').map((w) => w.from).sort();
  eq('两个字母以内的拉丁词逐条报出来（Go 与 OK 各一条）', shortLatin.join(','), 'Go,OK');
  eq('  三字母的 PRD 不报（词边界已足够保护它）',
    find(T.auditGlossary([{ from: 'PRD', to: '需求文档' }]).warnings, 'latin-too-short'), 0);
  eq('译名含换行 → newline-in-to 警告', find(struct.warnings, 'newline-in-to'), 1);
  eq('译名过长 → length-bloat 警告', find(struct.warnings, 'length-bloat'), 1);
  eq('同词不同译 → conflict 警告', find(struct.warnings, 'conflict'), 1);

  /* 完全重复只报 duplicate，不报 conflict */
  const dup = T.auditGlossary([
    { from: 'Prompt', to: '提示词' },
    { from: 'prompt', to: '提示词' }
  ]);
  eq('完全重复 → duplicate', find(dup.warnings, 'duplicate'), 1);
  eq('  不误报 conflict', find(dup.warnings, 'conflict'), 0);

  /* --- 统计口径 --- */
  const stats = T.auditGlossary([
    { from: 'A', to: '甲' },
    { from: 'B', to: '' },
    { from: 'C', to: '丙' }
  ]);
  eq('total 统计含全部条目（连被丢弃的也算进来）', stats.stats.total, 3);
  eq('已译 / 保持原样分开统计', stats.stats.translated + stats.stats.keepAsIs, 3);

  /* --- 边界：不应抛错 --- */
  let threw = false;
  try {
    T.auditGlossary([null, undefined, {}, { from: null, to: null }]);
  } catch (e) { threw = true; }
  eq('垃圾条目不抛错', threw, false);

  const empty = T.auditGlossary([]);
  eq('空表 errors = 0', empty.errors.length, 0);
  eq('空表 warnings = 0', empty.warnings.length, 0);
}

/* ================================================================== */
/* 五、端到端：mask → restore，术语真的落地                             */
/* ================================================================== */

section('五、端到端（截图现场）');
{
  const zh = T.mergeGlossary([], { targetLang: 'zh-CN' });

  /** 模拟「引擎什么都没改」：把掩码串直接当译文。
   *  这样失败一定出自**我们自己的判据**，而不是引擎行为 —— 归因干净。 */
  function pipeline(text, glossary) {
    const r = P.mask(text, { protectUntranslatable: true, glossary });
    const out = P.restore(r.masked, r.table);
    return { masked: r.masked, out: out.text, terms: r.table.map((t) => t.text), hits: r.termHits };
  }

  {
    const r = pipeline('Senior Growth Product Manager AI Native', zh);
    ok('截图标题命中「增长产品经理」', r.terms.indexOf('增长产品经理') >= 0, JSON.stringify(r.terms));
    ok('  短搭配 Product Manager 不再独立入场（长搭配已吃掉它）',
      r.terms.indexOf('产品经理') < 0, JSON.stringify(r.terms));
    eq('  termHits 计数与表长一致', r.hits, r.terms.length);
    ok('  还原后原文结构完整', r.out.indexOf('Senior') >= 0 && r.out.indexOf('AI Native') >= 0, r.out);
  }

  {
    const r = pipeline('Product Manager  Marketing  Executive', zh);
    ok('截图标签行命中 产品经理 + 市场营销',
      r.terms.indexOf('产品经理') >= 0 && r.terms.indexOf('市场营销') >= 0, JSON.stringify(r.terms));
    ok('  Executive 未被硬替换（它是被有意排除的多义词）',
      r.terms.indexOf('高管') < 0, JSON.stringify(r.terms));
  }

  {
    const r = pipeline('Magic Eden is hiring on Web3', zh);
    ok('品牌名被摘出并原样放回', r.terms.indexOf('Magic Eden') >= 0, JSON.stringify(r.terms));
    ok('  Web3 同样保持原样', r.terms.indexOf('Web3') >= 0, JSON.stringify(r.terms));
    ok('  品牌名没有被意译成「魔法伊甸园」', r.out.indexOf('魔法伊甸园') < 0, r.out);
  }

  /* --- 反例：多义词不得误伤 --- */
  {
    const r = pipeline('personal growth matters', zh);
    eq('Growth 单独出现时不命中（不收多义单词的收益）', r.terms.length, 0, JSON.stringify(r.terms));
  }
  {
    const r = pipeline('ask for a promotion', zh);
    eq('Promotion 不在基座内', r.terms.length, 0, JSON.stringify(r.terms));
  }
  {
    const r = pipeline('Running costs money', zh);
    eq('Runway 的收窄版本（Cash Runway）不误伤裸词', r.terms.length, 0, JSON.stringify(r.terms));
  }

  /* --- 大小写与词边界 --- */
  {
    const r = pipeline('product manager and PRODUCT MANAGER', zh);
    ok('大小写不敏感命中', r.terms.indexOf('产品经理') >= 0, JSON.stringify(r.terms));
    eq('  两处都命中', r.terms.filter((t) => t === '产品经理').length, 2);
  }
  {
    /* Rust 保持原样 —— 若不设词边界，'Rust' 会命中 'Rusty' 里的前四个字母 */
    const r = pipeline('The Rusty nail and the Rust compiler', zh);
    eq('词边界生效：Rusty 不触发 Rust 术语', r.terms.filter((t) => t === 'Rust').length, 1,
      JSON.stringify(r.terms));
  }

  /* --- 关掉基座时应当退回 v1.7.0 行为（纯引擎取义） --- */
  {
    const r = pipeline('Senior Growth Product Manager AI Native', []);
    eq('空术语表 → 零命中（对照基线）', r.terms.length, 0, JSON.stringify(r.terms));
  }

  /* --- 用户自定义术语与基座共存 --- */
  {
    const custom = T.mergeGlossary([{ from: 'hiring', to: '招聘中' }], { targetLang: 'zh-CN' });
    const r = pipeline('Product Manager hiring now', custom);
    ok('基座与用户术语同时命中',
      r.terms.indexOf('产品经理') >= 0 && r.terms.indexOf('招聘中') >= 0, JSON.stringify(r.terms));
  }
}

/* ================================================================== */

/* ================================================================== */
/* 六、场景条目（v1.7.2）                                              */
/* ================================================================== */
section('六、场景条目');
{
  /* --- 无场景信息时：场景条目一律不生效（G1 保守性兜底） --- */
  const noScene = T.mergeGlossary([], { targetLang: 'zh-CN' });
  const findIn = (list, from) => list.find((e) => e.from === from);
  eq('无场景 → Apply 不出表', findIn(noScene, 'Apply'), undefined);
  eq('无场景 → Executive 不出表', findIn(noScene, 'Executive'), undefined);
  eq('无场景 → Senior 不出表', findIn(noScene, 'Senior'), undefined);

  /* --- 招聘场景：场景条目生效 --- */
  const recruiting = T.mergeGlossary([], { targetLang: 'zh-CN', scenes: ['recruiting'] });
  eq('招聘场景 → Apply=申请', (findIn(recruiting, 'Apply') || {}).to, '申请');
  eq('招聘场景 → Executive=高管', (findIn(recruiting, 'Executive') || {}).to, '高管');
  eq('招聘场景 → Senior=高级', (findIn(recruiting, 'Senior') || {}).to, '高级');
  eq('招聘场景 → Medical=医疗', (findIn(recruiting, 'Medical') || {}).to, '医疗');
  eq('招聘场景 → Communications=传播', (findIn(recruiting, 'Communications') || {}).to, '传播');
  ok('招聘场景 → 整句 UI 文案命中',
    (findIn(recruiting, 'Upgrade to Premium to see salary') || {}).to === '升级到 Premium 查看薪水');

  /* --- 其他场景 / 未知场景：不生效 --- */
  const blog = T.mergeGlossary([], { targetLang: 'zh-CN', scenes: ['blog'] });
  eq('未知场景 → Apply 不出表', findIn(blog, 'Apply'), undefined);
  const emptyScenes = T.mergeGlossary([], { targetLang: 'zh-CN', scenes: [] });
  eq('空场景数组 = 无场景 → Apply 不出表', findIn(emptyScenes, 'Apply'), undefined);

  /* --- 场景条目同样受域开关约束（用户设置优先于场景） --- */
  const domainOff = T.mergeGlossary([], { targetLang: 'zh-CN', scenes: ['recruiting'], domains: ['tech'] });
  eq('关掉 recruiting 域 → 场景条目也不出表', findIn(domainOff, 'Apply'), undefined);
  const domainOn = T.mergeGlossary([], { targetLang: 'zh-CN', scenes: ['recruiting'], domains: ['recruiting'] });
  ok('只开 recruiting 域 → 场景条目出表', !!findIn(domainOn, 'Apply'));

  /* --- 品牌保持原样（F1–F3 现场词） --- */
  const base = T.mergeGlossary([], { targetLang: 'zh-CN' });
  for (const brand of ['GiveWell', 'Sticker Mule', 'Harper', 'RemoteOK', 'TLM']) {
    eq('品牌保持原样：' + brand, (findIn(base, brand) || {}).to, '');
  }

  /* --- 长搭配优先不被新条目破坏：Senior 单词在长搭配之后命中 --- */
  const spm = findIn(recruiting, 'Senior Product Manager');
  ok('Senior Product Manager 搭配仍在基座', !!spm && spm.to === '高级产品经理');

  /* --- 场景条目参与目标语言隔离 --- */
  const ja = T.mergeGlossary([], { targetLang: 'ja', scenes: ['recruiting'] });
  eq('日语目标 → Apply（中文译名）不出表', findIn(ja, 'Apply'), undefined);
  eq('日语目标 → GiveWell（保持原样）仍在表', (findIn(ja, 'GiveWell') || {}).to, '');
}

/* ================================================================== */

console.log('\n' + '─'.repeat(52));
if (failures.length) {
  console.log('失败 ' + failures.length + ' 项，通过 ' + passed + ' 项');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('全部通过：' + passed + ' 项断言');
