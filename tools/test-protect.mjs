/*
 * 双语助手 · 不可译片段保护 + 术语表 自检
 * ------------------------------------------------------------------
 * 「部分翻译不正确」里的很大一部分不是引擎水平问题，而是**送进引擎的东西
 * 本身就不该被翻**（URL、代码标识符、模板占位符、版本号），或者
 * **必须翻成指定说法**（术语表）。
 *
 * 修法是把这些片段在送翻前摘出来换成私用区占位符，返回后再还原。
 * 这条链有两个**静默失效**的方向，都不会报错：
 *
 *   A) 漏保护  → URL 被翻成中文，症状是「译文里冒出奇怪的中文路径」
 *   B) 过度保护 → 普通词永远不翻，症状更隐蔽，用户只会觉得「怎么有英文没译」
 *   C) 还原写宽 → 译文里的普通数字被当成占位符编号替换掉，整段文字被换成
 *                 表里某个片段。**越修越错**，而且看起来像是「引擎乱翻」
 *
 * C 是这里最危险的一条，所以「正则必须要求至少一个哨兵在场」被专门钉了一组断言。
 *
 * 运行：
 *   npm run test:protect
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
function eqj(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(label + '（期望 ' + b + '，实际 ' + a + '）', a === b);
}
function section(t) { console.log('\n' + t); }

/* ------------------------------------------------------------------ */
/* 装配：protect.js 是 UMD 风格普通脚本，在全局上下文里执行              */
/* ------------------------------------------------------------------ */

globalThis.self = globalThis;
vm.runInThisContext(
  fs.readFileSync(path.join(ROOT, 'shared/protect.js'), 'utf8'),
  { filename: 'shared/protect.js' }
);

const P = globalThis.CT.protect;
const O = P.OPEN;
const C = P.CLOSE;

/** 把私用区哨兵换成可见的 <>，便于失败时看清掩码长什么样 */
const show = (s) => String(s).replace(/\uE000/g, '<').replace(/\uE001/g, '>');

/** 只开「不可译片段保护」，不挂术语表 */
const maskOnly = (s) => P.mask(s, { protectUntranslatable: true });
const textsOf = (r) => r.table.map((t) => t.text);

/* ================================================================== */
/* 一、不可译片段的识别                                                */
/* ================================================================== */

section('一、不可译片段的识别');
{
  const cases = [
    ['URL', 'Visit https://example.com/a?b=1 now', 'https://example.com/a?b=1'],
    ['邮箱', 'Mail me at john.doe@example.com please', 'john.doe@example.com'],
    ['Mustache 占位符', 'Hello {{user_name}}', '{{user_name}}'],
    ['模板字符串占位符', 'Total is ${count} items', '${count}'],
    ['花括号占位符', 'Replace {name} here', '{name}'],
    ['printf 占位符', 'printf: %s done', '%s'],
    ['带位置参数的 printf', 'printf: %1$s done', '%1$s'],
    ['版本号', 'Version v1.2.3-beta released', 'v1.2.3-beta'],
    ['大写版本号', 'Got V2 today', 'V2'],
    ['十六进制颜色', 'color #a1b2c3 used', '#a1b2c3'],
    ['长哈希', 'commit 9f8e7d6c5b4a3210 landed', '9f8e7d6c5b4a3210'],
    ['文件名', 'Open app.js now', 'app.js'],
    ['多段路径', 'Read en/docs/intro first', 'en/docs/intro'],
    ['常量风格标识符', 'Set USER_ID here', 'USER_ID'],
    ['驼峰函数名', 'call getUserById now', 'getUserById'],
    ['下划线标识符', 'pass user_name in', 'user_name']
  ];
  for (const [name, input, expected] of cases) {
    const r = maskOnly(input);
    ok(name + ' 被摘出：' + expected, textsOf(r).indexOf(expected) >= 0,
      '实际表 = ' + JSON.stringify(textsOf(r)));
  }

  // 一句里多个片段要各自占一个占位符，不能合并
  const multi = maskOnly('Set USER_ID and call getUserById with user_name');
  eqj('一句里三个片段各自独立', textsOf(multi),
    ['USER_ID', 'getUserById', 'user_name']);
  eq('掩码里占位符数量与表一致', P.countMasks(multi.masked), 3);
}

/* ------------------------------------------------------------------ */

section('二、URL 尾部的句读要留在占位符之外');
{
  const r = maskOnly('See https://a.com/b. Then read more.');
  eqj('句号不被吞进 URL', textsOf(r), ['https://a.com/b']);
  eq('句号留在原文里', r.masked.indexOf(O) >= 0 && r.masked.charAt(r.masked.indexOf(C) + 1), '.');
  eq('还原后与原文逐字一致', P.restore(r.masked, r.table).text, 'See https://a.com/b. Then read more.');

  eqj('中文句读同样不吞', textsOf(maskOnly('见 https://a.com/b。然后继续')), ['https://a.com/b']);
  eqj('右括号不吞（字符集层面排除）', textsOf(maskOnly('(see https://a.com/b)')), ['https://a.com/b']);
  eqj('结尾是路径斜杠时保留斜杠', textsOf(maskOnly('go https://a.com/b/ now')), ['https://a.com/b/']);
  // 畸形 URL 也照常处理：能进切尾钩子的匹配一定以 `https://` 开头，
  // 所以切尾永远不会把匹配剥空
  eqj('畸形 URL 切尾后剩下的仍是完整协议前缀',
    textsOf(maskOnly('bad https://. end')), ['https://']);
}

/* ================================================================== */
/* 三、精度：普通文本不能被误保护                                       */
/* ================================================================== */

section('三、精度：普通文本不被误保护');
{
  const untouched = [
    ['普通英文句子', 'The quick brown fox jumps over 3 lazy dogs.'],
    ['含普通数字', 'Step 1 of 3 is done in 2026.'],
    ['单个全大写简称', 'OK, the API is fine.'],
    ['普通专有名词', 'Go is fast, Google is bigger.'],
    ['词/词 形式的英文搭配', 'Choose input/output and either/or and he/she'],
    ['单斜杠短片段', 'Use a/b here'],
    ['纯中文', '这是一段普通的中文，包含数字 3 与标点。']
  ];
  for (const [name, input] of untouched) {
    const r = maskOnly(input);
    eq(name + ' 完全不被改动', r.masked, input);
    eq('  ↳ 表为空', r.table.length, 0);
  }

  // 单斜杠 + 扩展名：只保护文件名，不把前缀当路径 —— 这是刻意的取舍
  const half = maskOnly('Use folder/file.txt and a/b');
  eqj('单斜杠路径只保护其中的文件名', textsOf(half), ['file.txt']);
}

/* ================================================================== */
/* 四、术语表                                                          */
/* ================================================================== */

section('四、术语表');
{
  const g = [
    { from: 'User', to: '用户' },
    { from: 'User ID', to: '用户编号' },
    { from: 'Go', to: 'Go 语言' },
    { from: 'Kubernetes', to: '' }
  ];
  const input = 'User ID and User and Go and Google and Kubernetes';
  const r = P.mask(input, { glossary: g, protectUntranslatable: true });

  eq('长术语优先（User ID 不被 User 吃掉）',
    P.restore(r.masked, r.table).text.indexOf('用户编号') >= 0, true);
  eq('命中的术语被换成指定译名', P.restore(r.masked, r.table).text.indexOf('用户') >= 0, true);

  // 整词匹配：Go 不能命中 Google
  const after = P.restore(r.masked, r.table).text;
  eq('Go 不命中 Google（Google 原样保留）', after.indexOf('Google') >= 0, true);
  eq('Google 没被替换成「Go 语言ogle」', after.indexOf('Go 语言ogle') < 0, true);
  eq('Go 自己命中', after.indexOf('Go 语言') >= 0, true);

  // to === '' 表示「保持原文不译」
  eq('to 为空串 → 保持原文', after.indexOf('Kubernetes') >= 0, true);
  eqj('to 为空串时表里存的是原文本身', textsOf(r)[textsOf(r).indexOf('Kubernetes')], 'Kubernetes');

  // 纯 CJK 术语走子串匹配（无词边界概念）
  const cjk = P.mask('这个提示词很有用', { glossary: [{ from: '提示词', to: 'Prompt' }] });
  eq('纯 CJK 术语能命中', P.restore(cjk.masked, cjk.table).text, '这个Prompt很有用');

  // 无效条目被忽略
  eq('from 为空白的条目被忽略',
    P.mask('hello', { glossary: [{ from: '  ', to: 'x' }] }).table.length, 0);
  eq('null 条目被忽略',
    P.mask('hello', { glossary: [null, undefined] }).table.length, 0);
  eq('glossary 为 null 不报错', P.mask('hello', { glossary: null }).table.length, 0);

  // sortTerms 的可见行为：长词一定排在短词前面
  const sorted = P.sortTerms([{ from: 'a', to: '1' }, { from: 'abcd', to: '2' }]);
  eqj('sortTerms 按长度降序', sorted.map((x) => x.from), ['abcd', 'a']);
}

/* ================================================================== */
/* 五、还原纪律：正则必须要求哨兵在场                                   */
/* ================================================================== */

section('五、还原纪律（译文本来的数字不能被当成占位符）');
{
  // 掩码里只有一个占位符，编号为 0
  const r = maskOnly('The URL is https://a.com/x');
  eq('掩码里恰好一个占位符', P.countMasks(r.masked), 1);

  // ★ 核心断言：译文里出现普通数字，绝不能被替换
  const engine = '网址是 ' + O + '0' + C + '，共 3 节，第 1 章';
  const back = P.restore(engine, r.table);
  eq('译文里的普通数字原样保留', back.text, '网址是 https://a.com/x，共 3 节，第 1 章');
  eq('还原干净（无残留）', back.residue, false);

  // 反证：如果正则写成「两个哨兵都可选」，下面这条会退化成「第 1 章」→「第 https://a.com/x 章」
  const plain = P.restore('第 1 章共 3 节', r.table);
  eq('压根不含哨兵的文本完全不被动', plain.text, '第 1 章共 3 节');
  eq('不含哨兵的文本残留标记为 false', plain.residue, false);
  eq('countMasks 对普通数字返回 0', P.countMasks('第 1 章共 3 节'), 0);
}

section('六、还原的容错形式');
{
  const r = maskOnly('The URL is https://a.com/x');
  eq('标称形式', P.restore('链接 ' + O + '0' + C, r.table).text, '链接 https://a.com/x');
  eq('缺尾形式（引擎吞了一个不可见字符）',
    P.restore('链接 ' + O + '0', r.table).text, '链接 https://a.com/x');
  eq('中间被插入空格', P.restore('链接 ' + O + ' 0 ' + C, r.table).text, '链接 https://a.com/x');
  eq('同一占位符出现两次都还原',
    P.restore('A ' + O + '0' + C + ' B ' + O + '0' + C, r.table).text,
    'A https://a.com/x B https://a.com/x');
}

/* ================================================================== */
/* 七、降级：绝不把哨兵泄漏给用户                                       */
/* ================================================================== */

section('七、降级时绝不泄漏哨兵');
{
  const r = maskOnly('The URL is https://a.com/x');

  const outOfRange = P.restore('链接 ' + O + 'z' + C, r.table);
  eq('编号越界 → 标记为降级', outOfRange.residue, true);
  eq('编号越界 → 哨兵被清掉', P.hasMask(outOfRange.text), false);
  // 连编号字符一起抹掉：只清哨兵会留下无来由的 `z`
  eq('编号越界 → 整段占位符一起消失', outOfRange.text, '链接 ');

  const noTable = P.restore('链接 ' + O + '0' + C, null);
  eq('有哨兵却无表 → 标记为降级', noTable.residue, true);
  eq('有哨兵却无表 → 哨兵被清掉', P.hasMask(noTable.text), false);
  eq('有哨兵却无表 → 结果不含私用区字符',
    /[\uE000-\uF8FF]/.test(noTable.text), false);

  const bare = P.restore('链接 ' + O + ' 与 ' + C, r.table);
  eq('裸哨兵 → 标记为降级', bare.residue, true);
  eq('裸哨兵 → 结果不含私用区字符', /[\uE000-\uF8FF]/.test(bare.text), false);

  // 空表也一样
  const emptyTable = P.restore('链接 ' + O + '0' + C, []);
  eq('空表 → 降级', emptyTable.residue, true);
  eq('空表 → 哨兵被清掉', P.hasMask(emptyTable.text), false);

  // 恶意/异常输入不该抛
  eq('null 译文退化为空串', P.restore(null, r.table).text, '');
  eq('undefined 译文退化为空串', P.restore(undefined, r.table).text, '');
  eq('null 文本 mask 退化为空串', P.mask(null, {}).masked, '');
  eq('非字符串 mask 会被转成字符串', P.mask(123, {}).masked, '123');
}

/* ================================================================== */
/* 八、数量守恒与 unclean                                              */
/* ================================================================== */

section('八、数量守恒（引擎合并/拆分条目要能被发现）');
{
  eq('countMasks 完整形式', P.countMasks(O + '0' + C + O + '1' + C), 2);
  eq('countMasks 缺尾形式', P.countMasks(O + '0' + O + '1'), 2);
  eq('countMasks 裸哨兵', P.countMasks(O + '0'), 1);
  eq('countMasks 空串', P.countMasks(''), 0);
  eq('countMasks 不含哨兵', P.countMasks('abc 123'), 0);

  const batch = ['Open app.js in src/utils/helper.js', 'See https://a.com/b. Done', 'plain text'];
  const ma = P.maskAll(batch, { protectUntranslatable: true });

  eq('maskAll 的 masked 与 tables 等长', ma.masked.length === ma.tables.length, true);
  eq('无掩码的条目表为 null', ma.tables[2], null);
  ok('有掩码的条目表非空', Array.isArray(ma.tables[0]) && ma.tables[0].length > 0);

  // 引擎原样回显 → 恒等还原
  const id = P.restoreAll(ma.masked, ma.tables, ma.masked);
  eqj('原样回显时逐字还原原文', id.texts, batch);
  eqj('原样回显时没有一条 unclean', id.unclean, [false, false, false]);

  // 引擎吞掉一个占位符 → 数量不守恒 → unclean
  const noMask = ma.masked[0].replace(new RegExp(O + '[0-9a-z]{1,3}' + C), '');
  const eaten = P.restoreAll([noMask], [ma.tables[0]], [ma.masked[0]]);
  eqj('吞掉占位符 → 该条 unclean（不能进缓存）', eaten.unclean, [true]);

  // 引擎把某个占位符换成别的东西（编号越界）→ 残留 → unclean
  const garbage = P.restoreAll(['链接 ' + O + 'zz' + C], [ma.tables[0]], ['x' + O + '0' + C]);
  eqj('占位符被改成越界编号 → unclean', garbage.unclean, [true]);

  // 没有表的条目不参与守恒校验，永远不是 unclean
  const noTable = P.restoreAll(['任意译文 3 条'], [null], [null]);
  eqj('无表条目不参与校验', noTable.unclean, [false]);
  eqj('无表条目原样返回', noTable.texts, ['任意译文 3 条']);

  // 缺 maskedInputs 时只按残留判定，不做守恒校验
  const noInputs = P.restoreAll(ma.masked, ma.tables);
  eq('缺 maskedInputs 时不报 unclean', noInputs.unclean.indexOf(true), -1);
}

/* ================================================================== */
/* 九、恒等往返：真实语料一批走完                                        */
/* ================================================================== */

section('九、恒等往返（掩码 → 还原 = 逐字不变）');
{
  const corpus = [
    'Visit https://example.com/a?b=1 now',
    'See https://a.com/b. Then read more.',
    'Mail me at john.doe@example.com please',
    'Use {{user_name}} and ${count} and {name}',
    'printf: %s and %1$s done',
    'Version v1.2.3-beta released',
    'color #a1b2c3 and hash 9f8e7d6c5b4a3210',
    'Open app.js in src/utils/helper.js',
    'Set USER_ID and call getUserById with user_name',
    'The quick brown fox jumps over 3 lazy dogs.',
    'OK, the API is fine.',
    '这是一段中文，含 URL https://a.cn/x 与数字 2026。',
    ''
  ];
  const ma = P.maskAll(corpus, { protectUntranslatable: true });
  const back = P.restoreAll(ma.masked, ma.tables, ma.masked);
  let mismatch = -1;
  for (let i = 0; i < corpus.length; i++) {
    if (back.texts[i] !== corpus[i]) { mismatch = i; break; }
  }
  eq('全部逐字还原', mismatch, -1);
  eq('全批没有 unclean', back.unclean.indexOf(true), -1);
  eq('掩码里只有私用区字符是「非原文」的（数量守恒）',
    ma.masked.every((s, i) => P.countMasks(s) === P.countMasks(ma.masked[i])), true);

  // 私用区哨兵不会凭空出现在正常文本里
  eq('正常文本 hasMask = false', P.hasMask(corpus[9]), false);
  eq('空串 hasMask = false', P.hasMask(''), false);
}

/* ================================================================== */
/* 十、开关：protectUntranslatable=false 时只走术语表                   */
/* ================================================================== */

section('十、protectUntranslatable 开关');
{
  const input = 'Visit https://a.com/b and set USER_ID';
  const off = P.mask(input, { protectUntranslatable: false });
  eq('关掉保护后 URL / 标识符原样留在原文里', off.masked, input);
  eq('关掉保护后表为空', off.table.length, 0);

  // 关掉保护不影响术语表
  const both = P.mask(input, {
    protectUntranslatable: false,
    glossary: [{ from: 'USER_ID', to: '用户标识' }]
  });
  eq('关掉保护时术语表仍然生效', P.restore(both.masked, both.table).text,
    'Visit https://a.com/b and set 用户标识');

  // 缺省（undefined）视为开启
  const dflt = P.mask(input, {});
  ok('缺省时保护是开启的', P.countMasks(dflt.masked) >= 2);
}

console.log('\n' + '─'.repeat(52));
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  · ' + f);
  console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
  process.exit(1);
}
console.log('全部通过：' + passed + ' 项断言');
