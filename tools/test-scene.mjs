/*
 * 双语助手 · 场景识别自检 —— v1.7.2
 * ==================================================================
 * 背景：remoteok 截图 Apply→应用（红框）、Executive→行政。
 * 多义单词在招聘语境下明明可消歧，但基座没有「场景」概念 ——
 * 治理规则 G1 只能一刀切不收，错译留给引擎。
 *
 * shared/scene.js 的 detect() 是**纯函数**（输入 {url,title,text} 描述
 * 对象，不碰 DOM），所以本套测试不需要 jsdom —— 直接钉信号阈值。
 *
 * 钉三件事：
 *   一 强信号（URL / 标题）直接判定；
 *   二 弱信号（正文关键词）必须 ≥4 个【不同】词才判定，防单词巧合；
 *   三 无关页面（文档 / 博客 / 电商）不得误识别 —— 误识别的代价是
 *      「应用」变「申请」出现在不该出现的页面。
 *
 * 运行：node tools/test-scene.mjs
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
  passed++;
  if (!cond) failures.push(label + (detail !== undefined ? '  → ' + detail : ''));
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (cond ? '' : '  → ' + detail));
}
function eq(label, actual, expected) {
  // detect() 返回数组，[] === [] 恒为 false —— 统一深比较
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(label, a === b, '期望 ' + b + ' / 实际 ' + a);
}
function section(t) { console.log('\n' + t); }

/* UMD 装载：Node 顶级 this 是 undefined，先补 self */
globalThis.self = globalThis;
const CT = {};
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'shared/scene.js'), 'utf8'), { filename: 'shared/scene.js' });
const S = globalThis.CT.scene;

/* ================================================================== */
section('一、强信号：URL 与标题');
{
  eq('remoteok.com URL 直接命中', S.detect({ url: 'https://remoteok.com/' }), ['recruiting']);
  eq('/jobs 路径命中', S.detect({ url: 'https://example.com/jobs' }), ['recruiting']);
  eq('/job/123 详情页命中', S.detect({ url: 'https://example.com/job/123' }), ['recruiting']);
  eq('/careers 命中', S.detect({ url: 'https://example.com/careers' }), ['recruiting']);
  eq('/hiring 命中', S.detect({ url: 'https://example.com/hiring' }), ['recruiting']);
  eq('标题含 Jobs 命中', S.detect({ title: 'Remote Jobs in Programming' }), ['recruiting']);
  eq('标题含 Hiring 命中', S.detect({ title: 'We are Hiring!' }), ['recruiting']);
  eq('标题命中可以无视正文', S.detect({ title: 'Careers', text: 'cooking recipes' }), ['recruiting']);
}

/* ================================================================== */
section('二、弱信号：正文关键词阈值（≥4 个不同词）');
{
  const words = (n) => ['apply', 'senior', 'engineer', 'manager', 'remote', 'salary']
    .slice(0, n).join(' ');
  eq('0 个词不识别', S.detect({ text: '' }), []);
  eq('1 个词不识别（任何页面都可能有 Manager）', S.detect({ text: words(1) }), []);
  eq('2 个词不识别', S.detect({ text: words(2) }), []);
  eq('3 个词不识别', S.detect({ text: words(3) }), []);
  eq('4 个不同词 → 识别', S.detect({ text: words(4) }), ['recruiting']);
  eq('同一词重复 4 次不识别（要的是不同词）',
    S.detect({ text: 'apply apply apply apply' }), []);
  eq('整词匹配：application 不算 Apply 命中',
    S.detect({ text: 'application senior engineer manager' }), []);
  eq('大小写不敏感', S.detect({ text: 'APPLY SENIOR ENGINEER MANAGER' }), ['recruiting']);
  eq('URL 不命中时正文阈值才生效',
    S.detect({ url: 'https://example.com/blog/post', text: words(4) }), ['recruiting']);
}

/* ================================================================== */
section('三、无关页面不得误识别');
{
  eq('文档页', S.detect({ url: 'https://docs.example.com/guide/intro', text: 'install the package and run the command' }), []);
  eq('博客页', S.detect({ url: 'https://blog.example.com/my-trip', title: 'My Trip', text: 'food travel photos' }), []);
  eq('电商页', S.detect({ url: 'https://shop.example.com/cart', title: 'Cart', text: 'price total checkout' }), []);
  eq('空描述', S.detect({}), []);
  eq('无参调用不抛错', (function () { try { S.detect(); return S.detect({}); } catch (e) { return 'throw'; } })(), []);
  eq('null 字段安全', S.detect({ url: null, title: null, text: null }), []);
}

/* ================================================================== */
section('四、countKeywordHits（排障辅助）');
{
  const hits = S.countKeywordHits('Apply now! Senior Engineer, remote, great salary');
  ok('命中数组非空', hits.length === 1 && hits[0].id === 'recruiting', JSON.stringify(hits));
  ok('不同词计数正确（apply/senior/engineer/remote/salary = 5）', hits[0].keywordHits === 5,
    String(hits[0] && hits[0].keywordHits));
  eq('无关文本零命中', S.countKeywordHits('just a recipe for cake').length, 0);
}

console.log('\n────────────────────────────────────────────────────');
if (failures.length) {
  console.error('失败 ' + failures.length + ' 项：');
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log('全部通过：' + passed + ' 项断言');
