/*
 * 双语助手 · 弹窗自检
 * ------------------------------------------------------------------
 * 弹窗是「最后一公里」：用户遇到问题时第一个打开的界面，也是唯一能在
 * 当前页面上下文里一键关掉某项能力的地方。它的失败模式很隐蔽 ——
 * 开关状态看着变了，但没下发指令，于是当前页面仍挂着旧状态：
 *   · 关掉划词后气泡照样弹（监听器还在）
 *   · 关掉 iframe 后框架里的译文照样在
 * 这两条只有真的去页面上试才会发现，所以这里断言的重点是
 * 「是否真的发出了 SET_SETTINGS + applySettings」，而不只是界面状态。
 *
 * 运行：
 *   node tools/test-popup.mjs
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { loadJsdom } from './_jsdom.mjs';

const JSDOM = loadJsdom();
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 装配                                                                */
/* ------------------------------------------------------------------ */

const HTML = fs.readFileSync(path.join(ROOT, 'popup/popup.html'), 'utf8');

const patches = [];     // 所有 SET_SETTINGS 的 patch
const cmds = [];        // 所有 SEND_COMMAND 的 cmd
let openedOptions = 0;

/** @param {Object} [override] 覆盖初始设置，用于测「老版本升级缺键」的场景 */
function makeEnv(override) {
  const dom = new JSDOM(HTML, {
    url: 'chrome-extension://abcdefghijklmnop/popup/popup.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const w = dom.window;
  const ctx = dom.getInternalVMContext();

  vm.runInContext(fs.readFileSync(path.join(ROOT, 'shared/constants.js'), 'utf8'), ctx, { filename: 'shared/constants.js' });

  const settings = Object.assign({}, w.CT.DEFAULT_SETTINGS, override || {});

  w.chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: '1.7.0' }),
      openOptionsPage: () => { openedOptions++; },
      sendMessage: (msg, cb) => {
        let res = { ok: true };
        switch (msg.type) {
          case w.CT.MSG.GET_SETTINGS:
            res = { ok: true, settings: Object.assign({}, settings) };
            break;
          case w.CT.MSG.SET_SETTINGS:
            patches.push(Object.assign({}, msg.patch));
            Object.assign(settings, msg.patch);
            res = { ok: true, settings: Object.assign({}, settings) };
            break;
          case w.CT.MSG.SEND_COMMAND:
            cmds.push(Object.assign({ tabId: msg.tabId }, msg.cmd));
            // ping 回来时带上内容脚本实测到的状态
            res = msg.cmd && msg.cmd.action === 'ping'
              ? { ok: true, stats: { translated: 12 }, sourceLang: 'en' }
              : { ok: true };
            break;
          case w.CT.MSG.GET_TAB_STATS:
            res = { ok: true, stats: { provider: 'google-free', phase: 'done' } };
            break;
          default:
            res = { ok: true };
        }
        if (cb) setTimeout(() => cb(res), 0);
        return Promise.resolve(res);
      }
    },
    tabs: {
      query: () => Promise.resolve([
        { id: 7, url: 'https://docs.example.com/guide/intro', title: 'Guide' }
      ])
    }
  };

  vm.runInContext(fs.readFileSync(path.join(ROOT, 'popup/popup.js'), 'utf8'), ctx, { filename: 'popup/popup.js' });
  return { dom, w, doc: w.document, settings };
}

/* ================================================================== */
/* 一、初始化与状态回填                                                */
/* ================================================================== */

section('一、初始化');

const env = makeEnv();
const { w, doc, settings } = env;
const $ = (id) => doc.getElementById(id);
// init() 是一条 4 跳的异步链：tabs.query → GET_SETTINGS → ping → GET_TAB_STATS。
// 每一跳都走一次 setTimeout(0)，jsdom 下实际落地时间会被定时器合并放大，
// 所以这里留足余量，避免变成「跑得快就过、跑得慢就挂」的抖动断言。
await sleep(150);

{
  eq('页头显示当前域名', $('pageInfo').textContent, 'docs.example.com');

  eq('总开关反映设置', $('enabled').checked, true);
  eq('自动翻译反映设置（默认不自动翻译）', $('autoTranslate').checked, false);
  eq('划词开关反映设置', $('selectionEnabled').checked, true);
  eq('内嵌框架开关反映设置', $('iframeEnabled').checked, true);

  const checked = doc.querySelector('#modeSeg input:checked');
  eq('显示方式单选反映设置', checked && checked.value, settings.displayMode);

  eq('统计格显示已译条数', $('statTranslated').textContent, '12');
  eq('统计格显示语言对', $('statLang').textContent, '英语→简体中文');
  eq('统计格显示生效引擎', $('statProvider').textContent, 'Google');

  ok('已向内容脚本 ping 过', cmds.some((c) => c.action === 'ping'));

  // 上下拉框都被填充
  eq('目标语言下拉非空', $('targetLang').options.length > 0, true);
  eq('源语言下拉含「自动检测」', $('sourceLang').options[0].value, 'auto');
}

/* ================================================================== */
/* 二、两个新开关必须真的下发指令                                      */
/* ================================================================== */

section('二、划词 / 内嵌框架开关');

{
  const before = cmds.length;
  $('iframeEnabled').checked = false;
  $('iframeEnabled').dispatchEvent(new w.Event('change', { bubbles: true }));
  await sleep(40);

  const p = patches[patches.length - 1];
  eq('排除内嵌框架写进了设置', p.iframeEnabled, false);
  ok('  并且向当前标签页下发了 applySettings',
    cmds.slice(before).some((c) => c.action === 'applySettings' && c.tabId === 7),
    JSON.stringify(cmds.slice(before)));
  ok('  给出可见提示', $('notice').hidden === false
    && $('notice').textContent.indexOf('顶层文档') >= 0, $('notice').textContent);

  // 关掉划词：必须下发指令，否则当前页面还挂着划词监听
  const before2 = cmds.length;
  $('selectionEnabled').checked = false;
  $('selectionEnabled').dispatchEvent(new w.Event('change', { bubbles: true }));
  await sleep(40);

  eq('关闭划词写进了设置', patches[patches.length - 1].selectionEnabled, false);
  ok('  并且下发了 applySettings（否则气泡照样弹）',
    cmds.slice(before2).some((c) => c.action === 'applySettings'),
    JSON.stringify(cmds.slice(before2)));

  // 恢复
  $('selectionEnabled').checked = true;
  $('selectionEnabled').dispatchEvent(new w.Event('change', { bubbles: true }));
  await sleep(40);
  eq('重新打开划词写进了设置', patches[patches.length - 1].selectionEnabled, true);

  // 再次打开内嵌框架：提示语要换成正向文案
  $('iframeEnabled').checked = true;
  $('iframeEnabled').dispatchEvent(new w.Event('change', { bubbles: true }));
  await sleep(40);
  ok('开启时提示语不同', $('notice').textContent.indexOf('重新加载') >= 0, $('notice').textContent);
}

/* ================================================================== */
/* 三、既有行为不被打破                                                */
/* ================================================================== */

section('三、既有行为');

{
  // 显示方式切换需要下发 applySettings（重画译文）
  const before = cmds.length;
  const radio = doc.querySelector('#modeSeg input[value="hover"]');
  radio.checked = true;
  doc.querySelector('#modeSeg').dispatchEvent(new w.Event('change', { bubbles: true }));
  await sleep(40);
  eq('切换显示方式写进设置', patches[patches.length - 1].displayMode, 'hover');
  ok('  并下发 applySettings', cmds.slice(before).some((c) => c.action === 'applySettings'));

  // 拉黑站点
  eq('按钮初始文案', $('btnBlockSite').textContent, '此站点不再翻译');
  $('btnBlockSite').click();
  await sleep(40);
  const list = patches[patches.length - 1].blocklist;
  ok('拉黑后域名进入 blocklist', Array.isArray(list) && list.indexOf('docs.example.com') >= 0,
    JSON.stringify(list));
  eq('  按钮文案变为恢复', $('btnBlockSite').textContent, '恢复此站点翻译');

  // 再点一次撤销
  $('btnBlockSite').click();
  await sleep(40);
  const list2 = patches[patches.length - 1].blocklist;
  ok('再点一次把域名移出 blocklist', Array.isArray(list2) && list2.indexOf('docs.example.com') < 0,
    JSON.stringify(list2));
  eq('  按钮文案回到拉黑', $('btnBlockSite').textContent, '此站点不再翻译');

  // 打开设置页
  $('btnOptions').click();
  eq('「全部设置」会打开选项页', openedOptions, 1);

  // 还原原文 / 立即翻译 两条指令
  const before2 = cmds.length;
  $('btnTranslate').click();
  await sleep(40);
  ok('「立即翻译」下发 translateNow', cmds.slice(before2).some((c) => c.action === 'translateNow'));
  const before3 = cmds.length;
  $('btnRestore').click();
  await sleep(40);
  ok('「还原原文」下发 restore', cmds.slice(before3).some((c) => c.action === 'restore'));
}

/* ================================================================== */
/* 四、老版本升级：设置里缺新键时的兜底                                */
/* ================================================================== */

section('四、缺键兜底');

{
  // 模拟「从 v1.6.0 升上来」：settings 里根本没有 selectionEnabled / iframeEnabled。
  // 这两项的正确默认值是「开」，所以判定必须写成 !== false，而不是 !!v ——
  // 写成 !!undefined 会让所有老用户升级后这两个功能静默失效。
  const old = makeEnv({ selectionEnabled: undefined, iframeEnabled: undefined });
  await sleep(40);
  const od = old.doc;

  eq('缺 selectionEnabled 时视为开启', od.getElementById('selectionEnabled').checked, true);
  eq('缺 iframeEnabled 时视为开启', od.getElementById('iframeEnabled').checked, true);

  old.w.close();
}

/* ================================================================== */

/* ------------------------------------------------------------------
 * 五、样式静态门禁（C-24）：主按钮悬停「白字白底」缺陷防回归
 * ------------------------------------------------------------------
 * 现场：.btn:hover 把背景刷成 --bg-sunken（近白 #eef2f7），而主按钮
 * 文字是白色 --accent-fg；.btn--primary:hover 当年只写了 filter、
 * 没重新声明 background —— 悬停瞬间白字白底 = 按钮视觉空白，
 * 用户以为「点不了」（真实站点 remoteok.com 用户实测反馈）。
 * jsdom 不做级联计算，这类缺陷逻辑测试永远抓不到 —— 只能静态盯 CSS：
 * 主按钮 :hover 规则必须自己声明 background / color（不依赖继承顺序）。
 */
section('五、样式静态门禁（C-24 主按钮悬停可读性）');

{
  const css = fs.readFileSync(path.join(ROOT, 'popup/popup.css'), 'utf8');

  const hoverIdx = css.indexOf('.btn:hover');
  const primaryHoverIdx = css.indexOf('.btn--primary:hover');
  ok('.btn:hover 规则存在', hoverIdx >= 0);
  ok('.btn--primary:hover 规则存在', primaryHoverIdx >= 0);

  if (primaryHoverIdx >= 0) {
    // 取 .btn--primary:hover 的规则体（到下一个 '}' 为止）
    const body = css.slice(css.indexOf('{', primaryHoverIdx), css.indexOf('}', primaryHoverIdx));
    ok('主按钮 :hover 重新声明了 background（防白字白底）', /background\s*:/.test(body));
    ok('主按钮 :hover 重新声明了 color（防前景被继承翻转）', /color\s*:/.test(body));
    ok('主按钮 :hover 声明在 .btn:hover 之后（级联胜出）', primaryHoverIdx > hoverIdx);
  }

  // 暗色主题下 accent-fg 是深色（#0f1620）、bg-sunken 是深色（#161b23）：
  // 同样的缺陷在暗色下表现为「深字深底」，同类门禁一并覆盖。
  ok('主按钮默认态声明了 color（--accent-fg）',
    /\.btn--primary\s*\{[^}]*color\s*:\s*var\(--accent-fg\)/.test(css));
}

/* ------------------------------------------------------------------ */

w.close();   // 收掉轮询定时器，避免进程挂住

console.log('\n' + '─'.repeat(52));
if (failures.length) {
  console.log('失败 ' + failures.length + ' 项，通过 ' + passed + ' 项');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('全部通过：' + passed + ' 项断言');
