/*
 * 临时校验：新的单遍分类器 vs 旧的正则表 —— 逐字符等价性比对
 * 这是本次优化风险最高的一处改动（手工转录 Unicode 区间），必须实测。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));

// 旧实现的正则表（参考基准，与被替换前的线上代码一字不差）
const SCRIPT_PATTERNS = [
  ['han', /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{2FA1F}]/gu],
  ['kana', /[\u3040-\u30FF\u31F0-\u31FF]/g],
  ['hangul', /[\u1100-\u11FF\uAC00-\uD7AF]/g],
  ['cyrillic', /[\u0400-\u04FF\u0500-\u052F]/g],
  ['arabic', /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g],
  ['hebrew', /[\u0590-\u05FF]/g],
  ['thai', /[\u0E00-\u0E7F]/g],
  ['devanagari', /[\u0900-\u097F]/g],
  ['greek', /[\u0370-\u03FF\u1F00-\u1FFF]/g],
  ['latin', /[A-Za-z\u00C0-\u024F\u1E00-\u1EFF]/g]
];

function oldStat(text) {
  const counts = {};
  let total = 0;
  const sample = text.length > 4000 ? text.slice(0, 4000) : text;
  for (const [name, re] of SCRIPT_PATTERNS) {
    re.lastIndex = 0;
    const m = sample.match(re);
    if (m && m.length) { counts[name] = m.length; total += m.length; }
  }
  return { counts, total };
}

// 载入新实现
globalThis.self = globalThis;
const src = fs.readFileSync(path.join(ROOT, 'shared/constants.js'), 'utf8')
  + '\n' + fs.readFileSync(path.join(ROOT, 'content/detector.js'), 'utf8');
new Function('self', src)(globalThis);
const D = globalThis.CT.detector;

let checked = 0, bad = 0;
const failures = [];

function cmp(label, text) {
  const a = oldStat(text);
  const b = D.scriptStats(text);
  checked++;
  const ka = Object.keys(a.counts).sort().join(',') + '|' + a.total;
  const kb = Object.keys(b.counts).sort().join(',') + '|' + b.total;
  if (ka !== kb) {
    bad++;
    if (failures.length < 12) failures.push({ label, text: text.slice(0, 40), old: ka, neu: kb });
  }
}

/* 1) 逐码元：把所有分类区间内的码元单独成串比对 */
let codeChecked = 0;
for (let cp = 1; cp < 0x30000; cp++) {
  if (cp >= 0xD800 && cp <= 0xDFFF) continue;           // 代理项不可单独出现
  const ch = String.fromCodePoint(cp);
  cmp('U+' + cp.toString(16), ch);
  codeChecked++;
}
console.log('逐码元比对：', codeChecked, '个码点');

/* 2) 混合文本：随机拼接各语种样本 */
const MIX = [
  'The delivery pipeline was rebuilt.', '你好，这是一段中文文本。',
  'これは日本語のテキストです。', '안녕하세요 한국어 텍스트입니다.',
  'Это русский текст. Українська мова: їєґі.', 'Ελληνικά κείμενο εδώ.',
  'مرحبا هذا نص عربي', 'שלום זה טקסט עברי', 'นี่คือข้อความภาษาไทย',
  'यह हिंदी पाठ है', 'Español con acentos: ñ á é í ó ú.',
  'Français: être où ça déjà.', 'Türkçe metin ğüşiöç',
  '中文English混排 with ASCII', '🎉 emoji 与符号 ©®™ ×÷',
  'Åland Ísland Ørsted'
];
for (let i = 0; i < 400; i++) {
  let s = '';
  const n = 1 + (i % 6);
  for (let k = 0; k < n; k++) s += MIX[(i * 7 + k * 3) % MIX.length] + ' ';
  cmp('mix#' + i, s);
}

/* 3) 边界：超长文本（触发 4000 字抽样）、空串、代理对 */
cmp('empty', '');
cmp('astral-han', '𠀀𠀁𠀂 中文字'.repeat(3));
cmp('long', 'abc 中文 '.repeat(3000));

/* 4) isTranslatableText 语义等价性
 *
 * 参考实现 = 优化前的完整判定链（10 段正则表 + RE_NUMERIC + RE_CODE_LIKE
 * + detectTextLanguage），被测实现 = 现网代码。
 * 只有两者对同一语料给出完全相同的 ok 值，才能认为「删掉的可达性判断」
 * 与「中文目标下跳过 scoreLatin」这两处简化是严格等价的。
 *
 * 【噪声闸门是唯一被允许的差异】
 * 后来新增了一道 looksLikeMarkup / looksLikeDataBlob，把「HTML 源码」与
 * 「序列化数据」判为不可译。这是【有意的语义变更】，不是重构，
 * 因此不能用「等价」两个字糊过去。这里的处理方式是把它精确地隔离出来：
 *
 *   · 未经闸门的语料（绝大多数）—— 新旧判定必须逐条相等，一条都不许差
 *   · 差异只允许一个方向 —— 旧说「要翻」而新说「不翻」，反向绝不允许
 *   · 差异只允许一个原因 —— reason 必须是 markup / data-blob
 *
 * 闸门本身的正确性（哪些该拦、哪些不能误伤）由 selftest 单独断言。 */
const OLD_NUMERIC = /^[\s\d\p{P}\p{S}]+$/u;
const OLD_CODE = /^[{}()<>\[\];=+\-*/|&!?~`^%$#@\\'".,:]+$/;
const RE_LETTER = /[^\s\d\p{P}\p{S}]/gu;
const OLD_HAS_LETTER = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u1100-\u11FF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/;

function oldVerdict(text, target, minLen) {
  text = String(text);
  if (!text) return false;
  minLen = minLen || 2;
  if (text.length < minLen) return false;
  if (text.length > 5000) return false;
  RE_LETTER.lastIndex = 0;
  const letters = text.match(RE_LETTER);
  if (!letters || letters.length < 2) return false;
  if (!OLD_HAS_LETTER.test(text)) return false;
  if (OLD_NUMERIC.test(text)) return false;
  if (OLD_CODE.test(text)) return false;
  if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(text)) return false;
  if (/^(https?:\/\/|www\.)\S+$/i.test(text)) return false;
  // 旧实现的最后一步：已是目标语言则不出翻译
  return !CT.settings.isSameLanguage(D.detectTextLanguage(text).lang, target);
}

/* 语料：ASCII 标点 / 数字 / 代码 / 各语种 / 混排 / 日文假名比例 / 超长 */
const BASE = [
  '12345 6789', '!!!???', '<>{}[]', '----', '____', '+-*/=', '....', ';;;',
  'https://example.com/docs/intro', 'www.test.org/a/b', 'http://a.cn',
  'hello@example.com', 'a@b.c', 'x.y@z.co',
  'Build reliable pipelines.', 'A', '', ' ', '  ', '\n\t ', '　',
  '©®™', '·', '，。！', '（一）', '第 1 页 / 共 3 页', '①②③', '→←↑↓',
  '★☆', '……', '——', '、、', '¶§', '†‡', '№', '℃', '‰',
  '404', 'v1.2.3', 'ok', 'ok!', '3.5s → 1.75s', '下降 30%', 'A/B 测试',
  '#hashtag', '@mention', 'console.log(x)', 'const a = 1;', '<div class="x">',
  '&& ||', 'a=b', 'if (x) { y() }', 'SELECT * FROM t',
  'Hello — world’s “best”', 'Café São Paulo', 'Straße', 'naïve façade',
  '日本語です', 'こんにちは世界', 'カタカナテスト', '漢字とかなの混在テキストです',
  '漢字主体の日本語文章ですが仮名が少ない', '한국어 텍스트', 'Русский текст',
  'Українська мова: їєґі', 'Српски: ђјљњћ', 'العربية نص', 'עברית טקסט',
  'ข้อความภาษาไทย', 'हिन्दी पाठ', 'Ελληνικά κείμενο', 'Ünïcödé',
  'ﬀ ligature', '½ ⅓ ¾', 'Ⅷ Ⅸ', '𝔘𝔫𝔦𝔠𝔬𝔡𝔢', '中文English混排 with ASCII',
  '🎉 emoji 与符号', '𠀀𠀁 扩展汉字', '\uF900\uF901 兼容表意',
  '这是一段中文文本，不应该被翻译。', '你好世界', '简体中文内容',
  '繁體中文內容', '中英混 排 mixed 文本 content',
  'The 会议 will 开始 at 三点'.replace(/ /g, ' '),
  // 噪声闸门的靶子：HTML 源码与序列化数据
  '</p></li><li><p>Move fast, build for the masses.</p></li></ol></div>',
  '<div class="job"><p>Own the end to end experience.</p></div><p>Apply now</p>',
  '<li><p>Turn raw events into decisions.</p></li><li><p>Ship weekly.</p></li>',
  '{"@type":"JobPosting","datePosted":"2026-09-11","baseSalary":150000}',
  '{"name":"Ada","role":"engineer","team":"platform","city":"Nanjing"}',
  // 反例：正文里合法出现的尖括号与引号，不能被误伤
  'A ratio of 3 < 5 and 7 > 2 is common in prose with angle brackets.',
  'Use the <div> element to group related content together.',
  'She said "hello" and later "goodbye" to the whole platform team.'
];

const CASES = BASE.slice();
// 随机拼贴：覆盖多语种混排与长文本
for (let i = 0; i < 1200; i++) {
  let s = '';
  const n = 1 + (i % 7);
  for (let k = 0; k < n; k++) s += BASE[(i * 13 + k * 5) % BASE.length] + ['', ' ', '\n'][(i + k) % 3];
  CASES.push(s);
}
CASES.push('abc 中文 '.repeat(1200));          // 超长 → 触发 4000 字抽样
CASES.push('word '.repeat(2000));
CASES.push('中'.repeat(6000));

let vChecked = 0;       // 全部比对条数
let vBad = 0;           // 未经闸门却出现差异 —— 任何一个都是 bug
let vGated = 0;         // 被噪声闸门拦下、旧实现本来要翻的条数（预期差异）
let vReverse = 0;       // 旧说不翻、新说要翻 —— 任何情况下都不允许

for (const target of ['zh-CN', 'zh-TW', 'en', 'ja']) {
  for (const c of CASES) {
    const text = String(c);
    const a = oldVerdict(text, target, 2);
    const now = D.isTranslatableText(text, target, 2);
    const b = now.ok;

    const gated = now.reason === 'markup' || now.reason === 'data-blob';

    vChecked++;
    if (a === b) continue;

    if (a === false && b === true) {
      vReverse++;
      if (failures.length < 12) {
        failures.push({ label: 'reverse/' + target, text: JSON.stringify(text.slice(0, 60)), old: a, neu: b });
      }
    } else if (gated) {
      vGated++;                       // 允许：噪声闸门的确定性结果
    } else {
      vBad++;
      if (failures.length < 12) {
        failures.push({ label: 'verdict/' + target, text: JSON.stringify(text.slice(0, 60)), old: a, neu: b, reason: now.reason });
      }
    }
  }
}

console.log('文本串比对：', checked, '条，差异', bad, '条');
console.log('可译性判定比对：', vChecked, '条');
console.log('  · 未经噪声闸门的差异：', vBad, '条（必须为 0）');
console.log('  · 被噪声闸门拦下（预期差异）：', vGated, '条');
console.log('  · 反向差异（不翻 → 要翻）：', vReverse, '条（必须为 0）');
if (failures.length) {
  console.log('--- 差异样本 ---');
  for (const f of failures) console.log(' ', JSON.stringify(f));
}
const okAll = bad === 0 && vBad === 0 && vReverse === 0;
console.log(okAll
  ? '\n结果：除噪声闸门之外完全等价 ✔（闸门本身的行为由 selftest 单独断言）'
  : '\n结果：存在非预期差异 ✘');
process.exit(okAll ? 0 : 1);
