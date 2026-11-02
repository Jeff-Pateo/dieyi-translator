/*
 * 双语助手 · 设置页自检
 * ------------------------------------------------------------------
 * 为什么设置页值得单独一套测试：
 *   它此前完全没有覆盖 —— 因为绝大部分控件走的是「声明式绑定」
 *   （给控件加 data-setting 就自动读写 + 保存），几乎不会写错。
 *
 *   但 v1.7 新增的「页内快捷键录制器」不是声明式的：它要捕获按键、归一化、
 *   查冲突、再写回一个对象型设置。这类逻辑的失败模式是「录了但没保存」
 *   或「保存了但存成了别的动作的组合键」，而这两种在界面上看起来都正常
 *   （pill 会上显示组合键）—— 只有真的去页面上按一下才会发现没反应。
 *
 * 用 jsdom 是为了真实执行 options.js 的初始化流程，而不是只做静态检查。
 * chrome.* 全部用桩替换，桩同时充当「保存通道」的观测点。
 *
 * 运行：
 *   node tools/test-options.mjs
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
/* 轮询等待：重载 options.js 后 init() 里有多个异步回包（GET_SETTINGS /
 * CACHE_STATS / BUILTIN_AVAILABILITY…），固定 sleep 靠猜，
 * 猜短了就是**假红**。这里等到条件成立或超时 —— 超时后仍不成立就是真红灯。 */
async function waitFor(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 800)) {
    if (fn()) return true;
    await sleep(10);
  }
  return fn();
}

/* ------------------------------------------------------------------ */
/* 装配：真实 options.html + 真实 options.js + chrome 桩                */
/* ------------------------------------------------------------------ */

const HTML = fs.readFileSync(path.join(ROOT, 'options/options.html'), 'utf8');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;

/** 记录所有发给后台的消息，作为「是否真的保存了」的观测点 */
const sent = [];
/** 捕获到的 SET_SETTINGS patch，按时间顺序 */
const patches = [];
function makeEnv() {
  const dom = new JSDOM(HTML, {
    url: 'chrome-extension://abcdefghijklmnop/options/options.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const w = dom.window;
  const ctx = dom.getInternalVMContext();

  // 先跑 constants（拿到默认设置），再决定桩里怎么回答 GET_SETTINGS
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'shared/constants.js'), 'utf8'), ctx, { filename: 'shared/constants.js' });
  const settings = Object.assign({}, w.CT.DEFAULT_SETTINGS);

  w.chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: VERSION }),
      sendMessage: (msg, cb) => {
        sent.push(msg);
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
          case w.CT.MSG.CACHE_STATS:
            res = { ok: true, stats: { entries: 0, approxBytes: 0, maxEntries: 20000 } };
            break;
          case w.CT.MSG.BUILTIN_AVAILABILITY:
            res = { ok: true, availability: 'available' };
            break;
          default:
            res = { ok: true };
        }
        if (cb) setTimeout(() => cb(res), 0);
        return Promise.resolve(res);
      }
    },
    storage: { local: { remove: () => Promise.resolve() } }
  };

  // 顺序与 options.html 里的 <script> 一致
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'shared/terminology.js'), 'utf8'), ctx, { filename: 'shared/terminology.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'content/keymap.js'), 'utf8'), ctx, { filename: 'content/keymap.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'options/options.js'), 'utf8'), ctx, { filename: 'options/options.js' });
  // jsdom 没有 createObjectURL：导出功能桩化，供点击路径跑通
  w.URL.createObjectURL = () => 'blob:fake';
  w.URL.revokeObjectURL = () => {};

  return { dom, w, doc: w.document, settings, ctx };
}

function key(doc, init) {
  const e = new doc.defaultView.KeyboardEvent('keydown', Object.assign({
    bubbles: true, cancelable: true
  }, init));
  doc.dispatchEvent(e);
  return e;
}

const { w, doc, settings, ctx } = makeEnv();
// 页面上下文里的 CT 命名空间（terminology 挂在它上面）
const CT = w.CT;
const $ = (id) => doc.getElementById(id);
const shortRows = () => Array.from($('shortcutRows').querySelectorAll('.row'));

await sleep(30);   // 等 init() 的三个异步回包落地

/* ================================================================== */
/* 一、初始化                                                          */
/* ================================================================== */

section('一、初始化');

{
  eq('页脚版本号来自 manifest（不写死在 HTML 里）',
    $('versionLabel').textContent, '叠译 v' + VERSION);

  ok('已向后台请求设置', sent.some((m) => m.type === w.CT.MSG.GET_SETTINGS));

  /*
   * M2 回填（2026-10-13，D-B2-02 + C-63/C-65）：
   * 原断言「分组数量 = 4 / 可见卡片数量 = 11」是**裸计数**，早已与页面不符
   * ——C-59 增「高级设置」组后组数即变 5，改动前可见卡片已是 12 张，本批再 +2
   * （#cardMyDict / #cardEngineChoice）→ 14。把数字从 11 改成 14 只会把既存漂移一起
   * 掩盖（数量对得上、卡片却可能被换掉）。
   * 故改为**按 id 白名单断言必备控件存在**（分区聚合，缺谁点名谁），
   * 并把 D-B2-02 裁定的常用区卡片顺序一并固化进门禁。
   */
  const REQUIRED_HOOKS = [
    ['常用区·翻译行为', ['enabled', 'displayMode', 'sourceLang', 'targetLang', 'insertMode', 'transStyle', 'fontSizeScale']],
    ['常用区·我的词典', ['cardMyDict', 'dictList', 'glossary', 'dictAdv']],
    ['常用区·翻译方式', ['cardEngineChoice', 'engineChoice']],
    ['常用区·划词/页内开关', ['selectionEnabled', 'toggleVisible']],
    ['高级区', ['groupAdvanced', 'provider', 'concurrency', 'openaiApiKey']],
    ['译文质量', ['termBaseEnabled', 'protectUntranslatable', 'cacheEnabled']],
    ['范围与进阶', ['blocklist', 'skipSelectors', 'iframeEnabled', 'shadowDomEnabled', 'pdfEnabled', 'shortcutRows']],
    ['配置迁移', ['groupMigration', 'btnExportSettings', 'btnImportSettings']]
  ];
  for (const [region, ids] of REQUIRED_HOOKS) {
    const missing = ids.filter((id) => !doc.getElementById(id));
    ok('必备控件齐全 · ' + region + '（' + ids.length + ' 项）',
      missing.length === 0, '缺失：' + missing.join(', '));
  }

  // D-B2-02（2026-10-13）裁定固化：常用区前三张 = 翻译行为（含 #enabled 总开关）
  //   → 我的词典 → 翻译方式。总开关权重最高，不得被新增内容卡挤到下方。
  const commonCards = Array.from(
    doc.querySelector('details.group').querySelectorAll(':scope > .card'));
  ok('常用区首卡是「翻译行为」且含总开关 #enabled（D-B2-02）',
    !!(commonCards[0] && !commonCards[0].id && commonCards[0].contains(doc.getElementById('enabled'))),
    commonCards.slice(0, 3).map((c) => c.id || '(翻译行为)').join(' , '));
  eq('常用区第 2 张 = #cardMyDict', commonCards[1] && commonCards[1].id, 'cardMyDict');
  eq('常用区第 3 张 = #cardEngineChoice', commonCards[2] && commonCards[2].id, 'cardEngineChoice');

  // 新增的四类控件都渲染出来了
  for (const id of ['selectionEnabled', 'selectionTrigger', 'selectionMinLen', 'selectionMaxLen',
    'selectionOnlyWithModifier', 'iframeEnabled', 'shadowDomEnabled', 'pdfEnabled', 'shortcutRows']) {
    ok('存在控件 ' + id, !!$(id));
  }

  eq('触发方式下拉有 2 项（auto / icon）', $('selectionTrigger').options.length, w.CT.SELECTION_TRIGGERS.length);
  eq('默认选中 auto', $('selectionTrigger').value, 'auto');
  eq('最短长度取自设置', $('selectionMinLen').value, String(settings.selectionMinLen));
  eq('最长长度取自设置', $('selectionMaxLen').value, String(settings.selectionMaxLen));
  eq('「启用划词翻译」默认勾选', $('selectionEnabled').checked, true);
  eq('「内嵌框架」默认勾选', $('iframeEnabled').checked, true);
  eq('「组件内文本」默认勾选', $('shadowDomEnabled').checked, true);
  eq('「PDF 对照」默认勾选', $('pdfEnabled').checked, true);
}

/* ================================================================== */
/* 二、划词控件的联动                                                  */
/* ================================================================== */

section('二、划词控件联动');

{
  const deps = ['selectionTrigger', 'selectionMinLen', 'selectionMaxLen', 'selectionOnlyWithModifier'];

  eq('主开关打开时依赖项可用', deps.every((id) => $(id).disabled === false), true);

  $('selectionEnabled').checked = false;
  $('selectionEnabled').dispatchEvent(new w.Event('change', { bubbles: true }));
  ok('关掉主开关后依赖项全部禁用', deps.every((id) => $(id).disabled === true),
    deps.map((id) => id + '=' + $(id).disabled).join(' '));

  $('selectionEnabled').checked = true;
  $('selectionEnabled').dispatchEvent(new w.Event('change', { bubbles: true }));
  ok('重新打开后依赖项恢复可用', deps.every((id) => $(id).disabled === false));
}

/* ================================================================== */
/* 三、页内快捷键录制器                                                */
/* ================================================================== */

section('三、页内快捷键录制器');

{
  eq('每个可绑定动作一行', shortRows().length, w.CT.BINDABLE_ACTIONS.length);
  eq('  行数等于 CT.BINDABLE_ACTIONS 长度', shortRows().length, 3);

  const rowOf = (actionId) => {
    const idx = w.CT.BINDABLE_ACTIONS.findIndex((a) => a.id === actionId);
    return shortRows()[idx];
  };
  const pillOf = (id) => rowOf(id).querySelector('.pill');
  const btnOf = (id, text) => Array.from(rowOf(id).querySelectorAll('button')).find((b) => b.textContent === text);

  // --- 初始态 ---
  eq('初始显示「未设置」', pillOf('toggle').textContent, '未设置');
  ok('  未设置时给警告色（不能是中性色，否则用户不会注意到没配）',
    pillOf('toggle').classList.contains('pill--warn'));
  ok('每个动作都有「录制」按钮',
    w.CT.BINDABLE_ACTIONS.every((a) => !!btnOf(a.id, '录制')));
  ok('未设置时没有「清除」按钮', !btnOf('toggle', '清除'));

  // --- 进入录制 ---
  btnOf('selection', '录制').click();
  eq('进入录制后提示文案', pillOf('selection').textContent, '请按下组合键…');
  eq('  按钮变为「取消」', !!btnOf('selection', '取消'), true);

  // --- 只按字母：必须被拒（否则会和正常打字抢键）---
  key(doc, { key: 'a' });
  eq('裸字母被拒，仍在录制态', pillOf('selection').textContent, '请按下组合键…');
  ok('  给出「缺少修饰键」的说明', $('saveState').textContent.indexOf('缺少') >= 0,
    $('saveState').textContent);

  // --- 只有 Shift + 字母：同样不够 ---
  key(doc, { key: 'A', shiftKey: true });
  eq('只有 Shift 也被拒', pillOf('selection').textContent, '请按下组合键…');

  // --- 与全局快捷键冲突 ---
  const reserved = w.CT.RESERVED_COMBOS[0];   // 'Alt+Shift+T'
  key(doc, { key: 'T', altKey: true, shiftKey: true });
  eq('与全局键 ' + reserved + ' 冲突被拒，仍在录制态',
    pillOf('selection').textContent, '请按下组合键…');
  ok('  给出冲突说明', $('saveState').textContent.indexOf('全局') >= 0, $('saveState').textContent);

  // --- 合法组合：Alt+Shift+S ---
  key(doc, { key: 's', altKey: true, shiftKey: true });
  eq('合法组合被接受', pillOf('selection').textContent, 'Alt+Shift+S');
  ok('  出现「清除」按钮', !!btnOf('selection', '清除'));
  ok('  录制态结束（按钮回到「录制」）', !!btnOf('selection', '录制'));

  // --- 归一化：(Shift+Alt+s) 与 (Alt+Shift+S) 必须是同一个串 ---
  //     这正是必须复用 content/keymap.js 的 comboOf 的理由
  const normalized = w.CT.keymap.comboOf({ key: 's', altKey: true, shiftKey: true });
  eq('keymap.comboOf 的归一化结果与录入的一致', normalized, 'Alt+Shift+S');

  // --- 保存确实发生了 ---
  await sleep(600);   // queueSave 有 420ms 防抖
  const last = patches[patches.length - 1];
  ok('已通过 SET_SETTINGS 落盘', !!last && !!last.customShortcuts);
  eq('  存进的是对象型设置', typeof last.customShortcuts, 'object');
  eq('  存的是 selection 这个动作', last.customShortcuts.selection, 'Alt+Shift+S');
  eq('  对象里只有这一个动作', Object.keys(last.customShortcuts).length, 1);

  // --- 同一个组合不能再绑给另一个动作 ---
  btnOf('mode', '录制').click();
  key(doc, { key: 's', altKey: true, shiftKey: true });
  eq('重复组合被拒，仍在录制态', pillOf('mode').textContent, '请按下组合键…');
  ok('  说明里点名了已占用的动作', $('saveState').textContent.indexOf('划词') >= 0, $('saveState').textContent);

  // --- Esc 取消 ---
  key(doc, { key: 'Escape' });
  eq('Esc 退出录制后 mode 仍是未设置', pillOf('mode').textContent, '未设置');

  // --- Backspace 清除已有绑定 ---
  btnOf('selection', '录制').click();
  key(doc, { key: 'Backspace' });
  eq('Backspace 清除后回到未设置', pillOf('selection').textContent, '未设置');
  await sleep(600);
  const cleared = patches[patches.length - 1];
  eq('  清除也落盘了', cleared.customShortcuts && cleared.customShortcuts.selection, undefined);

  // --- 录制期间按键必须被吞掉（preventDefault）---
  btnOf('toggle', '录制').click();
  const ev = key(doc, { key: 'x', ctrlKey: true });
  eq('录制期间的按键被 preventDefault', ev.defaultPrevented, true);
  ok('  Ctrl+X 被接受', pillOf('toggle').textContent, 'Ctrl+X');
  await sleep(600);

  // 录制结束后不再吞键 —— 否则设置页里所有键盘操作都会失灵
  // （注意：接受 Ctrl+X 之后按钮已回到「录制」，此时不能再点它 —— 那会重新进入录制，
  //   必须用 Esc 明确退出，这也是用户实际的操作路径）
  const esc = key(doc, { key: 'Escape' });
  eq('非录制状态下 Esc 不被拦截', esc.defaultPrevented, false);
  eq('  确认已退出录制（按钮回到「录制」）', !!btnOf('toggle', '录制'), true);
  const after = key(doc, { key: 'y', ctrlKey: true });
  eq('非录制状态下不拦截按键', after.defaultPrevented, false);
  eq('  非录制状态下的按键不会被记成新绑定', pillOf('toggle').textContent, 'Ctrl+X');

  // --- 最终状态：两个动作各有一个绑定，且互不相同 ---
  const finalMap = patches[patches.length - 1].customShortcuts;
  eq('toggle 绑到 Ctrl+X', finalMap.toggle, 'Ctrl+X');
  ok('两个绑定不重复', Object.keys(finalMap).length === new Set(Object.values(finalMap)).size);
  ok('所有绑定都含强修饰键',
    Object.values(finalMap).every((c) => ['Ctrl', 'Alt', 'Meta'].some((m) => c.split('+').indexOf(m) >= 0)),
    JSON.stringify(finalMap));
  ok('没有绑定落在全局保留组合上',
    Object.values(finalMap).every((c) => w.CT.RESERVED_COMBOS.indexOf(c) < 0));
}

/* ================================================================== */
/* 四、声明式控件仍然照常工作                                          */
/* ================================================================== */

section('四、声明式控件');

{
  const before = patches.length;
  $('iframeEnabled').checked = false;
  $('iframeEnabled').dispatchEvent(new w.Event('change', { bubbles: true }));
  await sleep(600);
  eq('复选框通过 data-setting 自动落盘', patches[patches.length - 1].iframeEnabled, false);

  $('selectionMinLen').value = '3';
  $('selectionMinLen').dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(600);
  eq('数字输入被转成 number', patches[patches.length - 1].selectionMinLen, 3);
  eq('  类型确实是 number（不是字符串）', typeof patches[patches.length - 1].selectionMinLen, 'number');

  ok('合并保存时不会把新键丢掉（patch 是增量的）', patches.length > before);
}

/* ================================================================== */
/* 五、术语基座面板                                                     */
/* ================================================================== */
/*
 * 这一块是 v1.7.1 新增的**非声明式**逻辑（分域勾选框由 JS 现渲染、
 * 「全选」要存成空数组），因此必须有断言锁住。
 *
 * 最要命的一条是「全选存什么」：保存链路会丢弃值为 null 的补丁字段，
 * 所以全选不能存 null；而若把「全部勾选」也存成一个显式数组，
 * 用户就被永久锁死在「当前这几个域」上，日后基座新增的域不会自动纳入。
 */
section('五、术语基座面板');

{
  const before = patches.length;
  const box = $('termDomains');
  const boxes = Array.from(box.querySelectorAll('input[type="checkbox"]'));

  ok('分域面板已按基座定义渲染', boxes.length > 0, String(boxes.length));
  eq('域数量与 CT.terminology.DOMAINS 一致', boxes.length, CT.terminology.DOMAINS.length);
  ok('  每个域都带条目数', box.querySelectorAll('.domain__count').length === boxes.length);
  ok('  面板默认全选（termDomains 为空 = 全开）', boxes.every((b) => b.checked));

  ok('显示了基座治理版本号', $('termBaseVersion').textContent.indexOf(CT.terminology.VERSION) >= 0,
    $('termBaseVersion').textContent);
  ok('显示了当前语向下的生效条数', /生效 \d+ \/ \d+ 条/.test($('termBaseCount').textContent),
    $('termBaseCount').textContent);

  /* --- 取消一个域 → 存显式数组 --- */
  boxes[0].checked = false;
  boxes[0].dispatchEvent(new w.Event('change', { bubbles: true }));
  await sleep(600);
  const patch1 = patches[patches.length - 1].termDomains;
  eq('取消一个域后存成显式数组', Array.isArray(patch1), true);
  eq('  数组里不包含被取消的域', patch1.indexOf(boxes[0].value), -1);
  eq('  数组长度 = 总数 - 1', patch1.length, boxes.length - 1);

  /* --- 全部勾回 → 必须存空数组（而不是 null、也不是显式全量数组）--- */
  boxes.forEach((b) => { b.checked = true; });
  boxes[0].dispatchEvent(new w.Event('change', { bubbles: true }));
  await sleep(600);
  const patch2 = patches[patches.length - 1].termDomains;
  eq('全部勾选存成空数组（而不是 null，也不是写死的全量数组）', Array.isArray(patch2) && patch2.length, 0);
  ok('  空数组在基座语义里等于「全开」（日后新增域会自动纳入）',
    CT.terminology.mergeGlossary([], { targetLang: 'zh-CN', domains: patch2 }).length ===
    /* v1.7.2：无场景信息时场景条目不生效，因此「全开」= 非场景条目数 */
    CT.terminology.BASE.filter((e) => !e.scenes || !e.scenes.length).length);

  /* --- 关掉基座开关 → 面板置灰，而不是消失 --- */
  ok('基座面板默认可用', !box.classList.contains('is-off'));
  $('termBaseEnabled').checked = false;
  $('termBaseEnabled').dispatchEvent(new w.Event('change', { bubbles: true }));
  await sleep(80);
  ok('关掉基座后分域面板置灰（不隐藏，便于归因）', box.classList.contains('is-off'));
  $('termBaseEnabled').checked = true;
  $('termBaseEnabled').dispatchEvent(new w.Event('change', { bubbles: true }));
  await sleep(80);
  ok('重新打开后恢复可用', !box.classList.contains('is-off'));

  /* --- 切目标语言 → 面板数字跟着变（给出译名的条目按语向过滤）--- */
  /*
   * 两条断言测的是**两件不同的事**，所以等待时间不一样：
   *   ① 数字变化：渲染是同步的（change 处理器里现读 DOM 立刻重渲染），
   *      理论上不等也能过 —— 但这里仍等一个微任务，确保测试不会因为
   *      「处理器恰好排在事件派发之后」而变成偶发绿。
   *   ② 落盘：走 queueSave 的 420ms 防抖，必须等到 flush 才看得见补丁。
   *      早先这里只等 120ms（小于防抖窗口），补丁还没出生就断言，
   *      于是假失败 —— 断言本身没错，是等待时间错了。
   */
  const zhText = $('termBaseCount').textContent;
  $('targetLang').value = 'ja';
  $('targetLang').dispatchEvent(new w.Event('change', { bubbles: true }));
  await sleep(600);
  const jaText = $('termBaseCount').textContent;
  ok('切到日语后生效条数变化（中文译名被按语向过滤）', zhText !== jaText, zhText + ' → ' + jaText);
  ok('  切换目标语言本身会落盘', patches.some((p) => p.targetLang === 'ja'));

  ok('术语基座相关改动确实产生了补丁', patches.length > before);
}

/* ================================================================== */
/* 十一、配置迁移（导出 / 导入）                                        */
/* ================================================================== */

section('十一、配置迁移');

{
  // 导出：点击跑通即可（Blob/URL 已桩化）
  let exportErr = null;
  try { $('btnExportSettings').click(); await sleep(10); } catch (e) { exportErr = e; }
  ok('导出设置点击不抛错', !exportErr, exportErr && exportErr.message);

  // 导入：点击应触发文件选择器
  let picked = false;
  $('importFile').click = () => { picked = true; };
  $('btnImportSettings').click();
  ok('导入设置点击触发文件选择器', picked);

  // v1.8.0：商业层已整体删除 —— 页面上不得再残留任何激活/trial 控件
  for (const id of ['groupPro', 'licenseCode', 'btnActivate', 'btnRemoveLicense', 'licenseState',
    'trialState', 'activateConfirm', 'devTrialPanel']) {
    ok('商业层控件已移除 · #' + id, !doc.getElementById(id));
  }
  ok('顶部 Pro 跳转锚点已移除 · #jumpPro', !doc.getElementById('jumpPro'));
}

/* ================================================================== */
/* 十二、隐私开关（匿名统计 opt-out）                                   */
/* ================================================================== */
/*
 * v1.8.0：产品免费后只剩一条后台交互 = 匿名埋点。
 * 合规底线：用户关掉开关后**一个包都不发**（worker 侧 outboundAllowed 短路），
 * 且设置页必须说人话、明确"不含任何网页内容"。
 */

section('十二、隐私开关（匿名统计 opt-out）');

{
  const cb = $('telemetryOn');
  ok('隐私开关存在', !!cb);
  ok('默认勾选（telemetryOptOut=false）', !!cb && cb.checked === true);

  const label = cb && cb.closest('label');
  ok('开关文案含「发送匿名使用统计（不包含任何网页内容）」',
    !!label && label.textContent.indexOf('发送匿名使用统计（不包含任何网页内容）') >= 0,
    label && label.textContent.trim());

  const card = $('cardPrivacy');
  const cardText = card ? card.textContent.replace(/\s+/g, '') : '';
  ok('卡片说明含「不含原文、译文、网址或账号信息」',
    cardText.indexOf('不含原文、译文、网址或账号信息') >= 0,
    cardText.slice(0, 120));

  // 取消勾选 → telemetryOptOut=true 落盘
  patches.length = 0;
  cb.checked = false;
  cb.dispatchEvent(new w.Event('change', { bubbles: true }));
  await sleep(600);
  ok('取消勾选后落盘 telemetryOptOut=true',
    patches.some((x) => x.telemetryOptOut === true), JSON.stringify(patches));
  ok('取消勾选后出现「已关闭」状态说明',
    $('privacyState').textContent.indexOf('已关闭') >= 0, $('privacyState').textContent);

  // 重新勾选 → telemetryOptOut=false
  patches.length = 0;
  cb.checked = true;
  cb.dispatchEvent(new w.Event('change', { bubbles: true }));
  await sleep(600);
  ok('重新勾选后落盘 telemetryOptOut=false',
    patches.some((x) => x.telemetryOptOut === false), JSON.stringify(patches));

  // 产品源码层面：不得再引用已删除的商业层对象
  const optSrc = fs.readFileSync(path.join(ROOT, 'options/options.js'), 'utf8');
  const optCode = optSrc
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, '');
  const hits = optCode.split('\n')
    .map((ln, i) => ({ ln, i: i + 1 }))
    .filter((x) => /CT\.license|CT\.TRIAL|CT\.TERMS|GET_TRIAL_STATE|SAVE_LICENSE|REMOVE_LICENSE|FREE_TERM_LIMIT/.test(x.ln));
  ok('options.js 不再引用 license/trial/TERMS 任何符号', hits.length === 0,
    hits.map((x) => x.i + ': ' + x.ln.trim()).join(' | '));

  /* 措辞纪律（沿用 v1.7.7 E-11）：产品侧不再用「免费版」指本产品档位。
   * DeepL 的 Free 档是官方档位名（api-free / 每月 50 万字符），属**例外**。
   * 先剥注释再扫：注释里可能在**讨论**这件事，不剥就是扫自己。 */
  const freeHits = [];
  for (const [file, src] of [
    ['options.js', optSrc],
    ['options.html', fs.readFileSync(path.join(ROOT, 'options/options.html'), 'utf8')]
  ]) {
    src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/\/\/.*$/gm, '')
      .split('\n')
      .forEach((ln, i) => {
        if (ln.indexOf('免费版') >= 0 && !/deepl|DeepL|api-free|每月 50 万|value="free"/.test(ln)) {
          freeHits.push(file + ':' + (i + 1) + ' ' + ln.trim());
        }
      });
  }
  ok('★ 产品侧不再用「免费版」指本产品档位（DeepL 官方档位名除外）',
    freeHits.length === 0, freeHits.join(' | '));
}

/* ------------------------------------------------------------------ */

console.log('\n' + '─'.repeat(52));
if (failures.length) {
  console.log('失败 ' + failures.length + ' 项，通过 ' + passed + ' 项');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('全部通过：' + passed + ' 项断言');
