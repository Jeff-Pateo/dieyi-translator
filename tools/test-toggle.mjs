/*
 * 双语助手 · 页内常驻开关自检
 * ------------------------------------------------------------------
 * 这个控件要同时满足三件互相拉扯的事，任何一件都容易在实现里被牺牲掉：
 *
 *   1) 常驻可见、可点、可拖动、可收起
 *   2) 对宿主页面零影响（不进文档流、不被采集、不被站点样式污染）
 *   3) 对读屏与键盘可用
 *
 * 前两件在真实浏览器里靠肉眼与 DevTools 验；这里把能确定的部分钉死：
 * 宿主属性、Shadow DOM 结构、状态机、aria 语义、拖动吸附的坐标计算、
 * 以及「拖过之后不能把这一次当点击」这条最容易写漏的边界。
 *
 * 运行：
 *   npm run test:toggle
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 装配                                                                */
/* ------------------------------------------------------------------ */

/** 起一个 jsdom 页面并把 constants + toggle 装进去 */
function boot(opts) {
  opts = opts || {};
  const dom = new JSDOM(
    '<!DOCTYPE html><html lang="en"><head><title>t</title></head>'
    + '<body><main><p>Hello world, this is a page.</p></main></body></html>',
    { url: 'https://example.com/article', runScripts: 'outside-only', pretendToBeVisual: true }
  );
  const ctx = dom.getInternalVMContext();
  const win = dom.window;

  const writes = [];
  let stored = opts.stored || {};

  ctx.chrome = {
    runtime: { lastError: null, getManifest: () => ({ version: '1.6.0' }) },
    storage: {
      local: {
        get(key, cb) {
          const res = {};
          if (stored && Object.prototype.hasOwnProperty.call(stored, key)) res[key] = stored[key];
          if (cb) cb(res);
        },
        set(obj, cb) {
          writes.push(obj);
          stored = Object.assign({}, stored, obj);
          if (cb) cb();
        }
      },
      onChanged: { addListener() {} }
    }
  };
  // jsdom 没有 elementFromPoint：控件里的角落冲突检测会走它的容错分支
  ctx.document.elementFromPoint = undefined;

  // layers.js 必须排在 toggle.js 之前：v1.7 起控件的三个悬浮层
  // （菜单 / 引导 / 确认）都要向中央仲裁器申请展开权
  for (const rel of ['shared/constants.js', 'content/layers.js', 'content/toggle.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), ctx, { filename: rel });
  }

  return { dom, win, doc: win.document, CT: ctx.CT, writes };
}

/** 造一个指针事件（jsdom 没有 PointerEvent 构造器） */
function pointer(win, type, x, y) {
  const e = new win.Event(type, { bubbles: true, cancelable: true });
  e.clientX = x;
  e.clientY = y;
  e.pointerId = 1;
  e.isPrimary = true;
  e.button = 0;
  return e;
}

/** 让 getBoundingClientRect 反映 host 上的 left/top，否则 jsdom 全返回 0 */
function makeRectLive(host) {
  host.getBoundingClientRect = function () {
    const l = parseFloat(host.style.getPropertyValue('left'));
    const t = parseFloat(host.style.getPropertyValue('top'));
    const left = Number.isFinite(l) ? l : 0;
    const top = Number.isFinite(t) ? t : 0;
    return {
      left: left, top: top, width: 60, height: 44,
      right: left + 60, bottom: top + 44, x: left, y: top
    };
  };
}

/* ================================================================== */
/* 一、挂载与宿主属性                                                  */
/* ================================================================== */

section('一、挂载与宿主');
{
  const { doc, CT } = boot();
  const T = CT.toggle;

  eq('挂载前未挂载', T.isMounted(), false);

  const calls = { toggle: 0, more: [], collapse: [], opts: 0 };
  const handle = T.mount({
    collapsed: false,
    guideSeen: true,
    onToggle: () => { calls.toggle++; },
    onMore: (id) => { calls.more.push(id); if (id === 'options') calls.opts++; },
    onCollapse: (v) => { calls.collapse.push(v); }
  });

  ok('mount 返回句柄', !!handle);
  eq('挂载后 isMounted 为 true', T.isMounted(), true);

  const host = doc.querySelector('.' + T.CLASS);
  ok('宿主挂在 document.body 下', !!host && host.parentElement === doc.body);
  eq('宿主带 data-ct-skip（采集阶段整块跳过）', host.getAttribute('data-ct-skip'), 'widget');
  eq('宿主带 translate=no（第二道防自噬闸门）', host.getAttribute('translate'), 'no');
  eq('宿主类名与 CT.TOGGLE_CLASS 一致', host.className, CT.TOGGLE_CLASS);

  // 关键定位属性必须走行内 !important：站点的 `body > div { position: static }`
  // 这类选择器会在级联里赢过 :host，只有行内样式 + important 才稳
  eq('position 走行内 important',
    host.style.getPropertyValue('position') + '|' + host.style.getPropertyPriority('position'),
    'fixed|important');
  // CSSOM 会把 "0" 规范化成 "0px"，所以比数值而不是字符串
  ok('margin 被清零以防站点留白',
    parseFloat(host.style.getPropertyValue('margin')) === 0,
    host.style.getPropertyValue('margin'));

  // 控件是 fixed 定位的独立浮层，正文容器的子元素数一个都不该多
  eq('正文容器子元素数不受控件影响', doc.querySelector('main').children.length, 1);
  eq('正文容器内没有控件（不会挤进任何 flex/grid 布局）',
    doc.querySelector('main').querySelector('.' + CT.TOGGLE_CLASS), null);

  eq('宿主初始状态为 off', host.getAttribute('data-status'), 'off');
  eq('宿主初始未收起', host.getAttribute('data-collapsed'), '0');

  // ---- Shadow DOM ----
  ok('宿主有 open shadow root', !!host.shadowRoot);
  const main = host.shadowRoot.querySelector('.main');
  ok('主控件是原生 <button>（天然可 Tab 聚焦 + Enter/Space 触发）', !!main && main.tagName === 'BUTTON');
  eq('主控件 type=button（不在 form 里当提交按钮）', main.getAttribute('type'), 'button');
  eq('初始 aria-pressed=false', main.getAttribute('aria-pressed'), 'false');
  ok('初始可访问名称说明了动作',
    (main.getAttribute('aria-label') || '').indexOf('翻译') >= 0,
    main.getAttribute('aria-label'));
  ok('图标为文字「译」（不依赖图标字体）',
    host.shadowRoot.querySelector('.ico').textContent === '译');
  ok('样式表被关进 Shadow DOM（不污染站点）',
    host.shadowRoot.querySelector('style').textContent.indexOf(':host') >= 0);

  /* ---- 「不易察觉如何使用」的正面断言 ---- */
  const root = host.shadowRoot;
  const box = root.querySelector('.box');
  const more = root.querySelector('.tool--more');
  ok('胶囊容器存在（主按钮 + 更多按钮）', !!box);
  ok('「更多」按钮常显（不是 hover 才出现）', !!more && more.tagName === 'BUTTON');
  eq('「更多」声明了 aria-haspopup=menu', more.getAttribute('aria-haspopup'), 'menu');
  eq('菜单初始收起', root.querySelector('.menu').hidden, true);
  ok('副按钮只有一枚（旧设计里齿轮与收起都挤在 hover 区）',
    root.querySelectorAll('.tool').length === 1,
    String(root.querySelectorAll('.tool').length));
  ok('菜单里带了四条命令',
    root.querySelectorAll('.menu__i').length >= 4,
    String(root.querySelectorAll('.menu__i').length));
  ok('菜单项带 role=menuitem（读屏可识别为菜单）',
    root.querySelector('.menu__i').getAttribute('role') === 'menuitem');
  ok('胶囊里有动作文案节点',
    !!root.querySelector('.label'));

  T.destroy();
  eq('destroy 后宿主从 body 移除', doc.querySelector('.' + T.CLASS), null);
  eq('destroy 后 isMounted 为 false', T.isMounted(), false);
}

/* ================================================================== */
/* 一之二、首次引导气泡                                                */
/* ================================================================== */

section('一之二、首次引导气泡');
{
  const { doc, CT } = boot();
  const T = CT.toggle;

  // 气泡的展示要先等一次存储读取（位置与「看过没有」在同一个键里），
  // 所以必须让出一个宏任务再断言 —— 不然断言的是「还没轮到它」，
  // 而不是「它该不该出现」。
  const settle = () => new Promise((r) => setTimeout(r, 0));

  // 没传 guideSeen → 首次使用，气泡应当自动亮出来
  T.mount({ targetLabel: '简体中文' });
  await settle();
  let host = doc.querySelector('.' + T.CLASS);
  let root = host.shadowRoot;
  eq('首次挂载自动弹出引导气泡', root.querySelector('.guide').hidden, false);
  ok('引导文案点名了目标语言（而不是「目标语言」四个字）',
    root.querySelector('.guide__lang').textContent === '简体中文',
    root.querySelector('.guide__lang').textContent);
  ok('引导文案说了点它会怎样',
    root.querySelector('.guide__b').textContent.indexOf('翻成') >= 0);
  ok('引导文案说了可以拖动',
    root.querySelector('.guide__b').textContent.indexOf('拖') >= 0);
  ok('引导文案指向了「⋯」入口',
    root.querySelector('.guide__b').textContent.indexOf('⋯') >= 0);

  root.querySelector('.cbtn--ok').dispatchEvent(new (doc.defaultView.Event)('click', { bubbles: true }));
  eq('点「知道了」后气泡收起', root.querySelector('.guide').hidden, true);

  // 同一页面里重挂载 —— 上一步已经把它写进存储了，不该再弹。
  // 这一条同时验证了「记住已看过」这件事真的落了盘，而不只是内存里的一个变量。
  T.destroy();
  T.mount({ targetLabel: '简体中文' });
  await settle();
  eq('记住之后重挂载不再弹（已落盘，不只是内存标志）',
    doc.querySelector('.' + T.CLASS).shadowRoot.querySelector('.guide').hidden, true);
  T.destroy();
}

{
  const { doc, CT } = boot();
  const T = CT.toggle;
  const settle = () => new Promise((r) => setTimeout(r, 0));

  // 显式 guideSeen: true → 不打扰
  T.mount({ guideSeen: true });
  await settle();
  eq('已看过（显式传入）就不再弹',
    doc.querySelector('.' + T.CLASS).shadowRoot.querySelector('.guide').hidden, true);
  T.destroy();
}

{
  const { doc, CT } = boot();
  const T = CT.toggle;
  const settle = () => new Promise((r) => setTimeout(r, 0));

  // 点主按钮也算「用户已经明白了」，顺手关掉气泡
  T.mount({});
  await settle();
  const host = doc.querySelector('.' + T.CLASS);
  const root = host.shadowRoot;
  // 先确认这一次**真的**弹了 —— 否则下面那条断言会因为「本来就是隐藏的」而恒真
  eq('（前置）这一次挂载确实弹出了气泡', root.querySelector('.guide').hidden, false);
  root.querySelector('.main').dispatchEvent(new (doc.defaultView.Event)('click', { bubbles: true }));
  eq('点主按钮也会收起引导气泡', root.querySelector('.guide').hidden, true);
  T.destroy();
}

{
  const { doc, CT } = boot();
  const T = CT.toggle;
  const settle = () => new Promise((r) => setTimeout(r, 0));

  // Esc 同样可以关掉，键盘用户不会被困在气泡里
  T.mount({});
  await settle();
  const host = doc.querySelector('.' + T.CLASS);
  const root = host.shadowRoot;
  eq('（前置）气泡确实在', root.querySelector('.guide').hidden, false);
  root.dispatchEvent(new (doc.defaultView.KeyboardEvent)('keydown', { key: 'Escape', bubbles: true }));
  eq('Esc 关掉引导气泡', root.querySelector('.guide').hidden, true);
  T.destroy();
}

/* ================================================================== */
/* 二、状态机与三通道区分                                              */
/* ================================================================== */

section('二、状态机');
{
  const { doc, CT } = boot();
  const T = CT.toggle;
  const handle = T.mount({});
  const host = doc.querySelector('.' + T.CLASS);
  const root = host.shadowRoot;
  const main = root.querySelector('.main');

  T.update({ status: 'on' });
  eq('on → data-status=on', host.getAttribute('data-status'), 'on');
  eq('on → aria-pressed=true', main.getAttribute('aria-pressed'), 'true');
  ok('on → 可访问名称说明点击会回到原文',
    (main.getAttribute('aria-label') || '').indexOf('原文') >= 0,
    main.getAttribute('aria-label'));
  // 三通道里至少两通道可辨：颜色与图标由 CSS 的 [data-status] 选择器驱动，
  // 文案由 aria-label 驱动。这里断言的是「CSS 有对应规则」这件事的前提 ——
  // 属性确实写在宿主上，选择器才可能命中。
  ok('状态写在宿主属性上（CSS 三通道选择器的前提）',
    host.hasAttribute('data-status'));
  eq('on → 主文案是动作「显示原文」', root.querySelector('.label').textContent, '显示原文');
  ok('开启态把整个胶囊改成实心底（两态一眼可辨）',
    host.shadowRoot.querySelector('style').textContent
      .indexOf(':host([data-status="on"]) .box') >= 0);

  T.update({ status: 'busy', busyText: '12 / 130' });
  eq('busy → data-status=busy', host.getAttribute('data-status'), 'busy');
  eq('busy → 显示进度文案', root.querySelector('.label').textContent, '12 / 130');
  eq('busy → aria-pressed 仍为 false（只表达开/未开）',
    main.getAttribute('aria-pressed'), 'false');

  T.update({ status: 'off' });
  eq('off → data-status=off', host.getAttribute('data-status'), 'off');
  eq('off → 主文案是动作「翻译此页」', root.querySelector('.label').textContent, '翻译此页');

  // 图标＝目标语言标记，回答「翻成什么语言」
  T.update({ mark: '日' });
  eq('mark 更新后图标跟着变', root.querySelector('.ico').textContent, '日');
  ok('aria 名称带上目标语言标记',
    (main.getAttribute('aria-label') || '').indexOf('日') >= 0,
    main.getAttribute('aria-label'));
  T.update({ mark: '译' });
  eq('mark 复原', root.querySelector('.ico').textContent, '译');

  T.update({ status: 'unavailable' });
  eq('unavailable → aria-disabled=true', main.getAttribute('aria-disabled'), 'true');
  eq('unavailable → data-status=unavailable', host.getAttribute('data-status'), 'unavailable');
  eq('unavailable → 文案是「无需翻译」而非「翻译」',
    root.querySelector('.label').textContent, '无需翻译');
  ok('unavailable → CSS 收掉「更多」按钮（此时那些命令都不成立）',
    host.shadowRoot.querySelector('style').textContent
      .indexOf(':host([data-status="unavailable"]) .tool--more') >= 0);

  // 非法状态值不应污染控件
  T.update({ status: 'nonsense' });
  eq('非法状态被忽略（保持上一个合法值）', host.getAttribute('data-status'), 'unavailable');

  T.destroy();
}

/* ================================================================== */
/* 三、交互                                                            */
/* ================================================================== */

section('三、交互');
{
  const { doc, CT } = boot();
  const T = CT.toggle;
  const calls = { toggle: 0, more: [], collapse: [], unblock: 0, cancel: 0 };
  T.mount({
    guideSeen: true,
    onToggle: () => { calls.toggle++; },
    onMore: (id) => { calls.more.push(id); },
    onCollapse: (v) => { calls.collapse.push(v); },
    onUnblock: () => { calls.unblock++; },
    onCancel: () => { calls.cancel++; }
  });
  const host = doc.querySelector('.' + T.CLASS);
  const root = host.shadowRoot;
  const main = root.querySelector('.main');
  const click = (el) => el.dispatchEvent(new (doc.defaultView.Event)('click', { bubbles: true }));

  click(main);
  eq('点主按钮触发 onToggle', calls.toggle, 1);

  /* ---- 更多菜单 ---- */
  const menu = root.querySelector('.menu');
  const moreBtn = root.querySelector('.tool--more');
  eq('菜单初始是收起的', menu.hidden, true);

  click(moreBtn);
  eq('点「⋯」展开菜单', menu.hidden, false);
  eq('展开后 aria-expanded=true', moreBtn.getAttribute('aria-expanded'), 'true');

  click(moreBtn);
  eq('再点一次收起', menu.hidden, true);

  click(moreBtn);
  click(root.querySelector('.menu__i--never'));
  eq('菜单里点「本站不再翻译」把命令交回编排层', calls.more.join(','), 'never');
  eq('执行命令后菜单自动收起', menu.hidden, true);

  click(moreBtn);
  click(root.querySelector('.menu__i--options'));
  eq('点「打开设置」透传 options 命令', calls.more.join(','), 'never,options');

  click(moreBtn);
  click(root.querySelector('.menu__i--hide'));
  eq('点「隐藏按钮」透传 hide 命令', calls.more.join(','), 'never,options,hide');

  /* ★ C-28：菜单必须同时提供**持久**出口。
   *   旧版只有「隐藏这个按钮」，而它是实例级内存变量 —— 刷新一次就回来了，
   *   用户在页面上根本表达不出「以后都不要」，于是陷入
   *   「隐藏一次、回来一次」的循环（用户体感：这东西为什么重复出现）。 */
  ok('菜单里有「所有网站都不显示」（持久出口）',
    root.querySelector('.menu__i--hideAll') !== null);
  ok('  且文案写清是「所有网站」（与「本页」区分开）',
    /所有网站/.test(root.querySelector('.menu__i--hideAll').textContent),
    root.querySelector('.menu__i--hideAll').textContent);
  ok('  「本页隐藏」的文案也点明了作用域（不再含糊成「隐藏这个按钮」）',
    /本页/.test(root.querySelector('.menu__i--hide').textContent),
    root.querySelector('.menu__i--hide').textContent);
  click(moreBtn);
  click(root.querySelector('.menu__i--hideAll'));
  eq('点「所有网站都不显示」透传 hideAll 命令（由编排层落盘）',
    calls.more.join(','), 'never,options,hide,hideAll');

  // ---- 收起：命令由控件自己执行，不再外发 ----
  click(moreBtn);
  click(root.querySelector('.menu__i--collapse'));
  eq('菜单里点「收起为圆点」→ data-collapsed=1', host.getAttribute('data-collapsed'), '1');
  eq('收起回调收到 true', calls.collapse[0], true);
  eq('内部动作不外发给编排层', calls.more.join(','), 'never,options,hide,hideAll');
  ok('收起后仍在原地常显，「⋯」仍在（收起不等于失能）',
    root.querySelector('.tool--more') !== null);

  click(moreBtn);
  const collapseItem = root.querySelector('.menu__i--collapse');
  eq('收起后菜单文案变成「展开为完整按钮」',
    collapseItem.querySelector('span').textContent, '展开为完整按钮');
  click(collapseItem);
  eq('再点一次展开', host.getAttribute('data-collapsed'), '0');
  eq('展开回调收到 false', calls.collapse[1], false);

  // ---- 菜单互斥：开着菜单弹确认条，菜单要让位 ----
  click(moreBtn);
  T.update({ confirm: 'blocked' });
  eq('确认条出现时菜单收起（浮层互斥）', menu.hidden, true);
  T.update({ confirm: null });

  // ---- 不可译态下点不动 ----
  T.update({ status: 'unavailable' });
  const before = calls.toggle;
  click(main);
  eq('unavailable 态点击不触发开关（页面本来就无需翻译）', calls.toggle, before);
  T.update({ status: 'off' });

  // ---- 黑名单二次确认 ----
  T.update({ confirm: 'blocked' });
  const confirmEl = root.querySelector('.confirm');
  eq('确认条可见', confirmEl.hidden, false);
  ok('确认文案点名了「不翻译」名单',
    confirmEl.querySelector('.confirm__t').textContent.indexOf('不翻译') >= 0,
    confirmEl.querySelector('.confirm__t').textContent);
  eq('确认按钮文案', confirmEl.querySelector('.cbtn--go').textContent, '移出并翻译');

  // 确认条开着时点主按钮 = 收起确认，而不是又切一次翻译
  const beforeCancel = calls.toggle;
  main.dispatchEvent(new (doc.defaultView.Event)('click', { bubbles: true }));
  eq('确认条开着时点主按钮不触发翻译', calls.toggle, beforeCancel);
  eq('确认条被收起', confirmEl.hidden, true);

  // 走确认流程
  T.update({ confirm: 'blocked' });
  confirmEl.querySelector('.cbtn--go').dispatchEvent(new (doc.defaultView.Event)('click', { bubbles: true }));
  eq('点「移出并翻译」触发 onUnblock', calls.unblock, 1);
  eq('确认条随之关闭', confirmEl.hidden, true);

  T.update({ confirm: 'blocked' });
  confirmEl.querySelector('.cbtn--cancel').dispatchEvent(new (doc.defaultView.Event)('click', { bubbles: true }));
  eq('点「取消」触发 onCancel', calls.cancel, 1);

  T.destroy();
}

/* ================================================================== */
/* 四、拖动与吸附                                                      */
/* ================================================================== */

section('四、拖动与吸附');
{
  const { doc, win, CT, writes } = boot();
  const T = CT.toggle;
  const calls = { toggle: 0 };
  const handle = T.mount({ onToggle: () => { calls.toggle++; } });

  const host = doc.querySelector('.' + T.CLASS);
  makeRectLive(host);
  const main = host.shadowRoot.querySelector('.main');

  eq('重复 mount 是幂等的（返回同一个句柄）', T.mount({}), handle);

  // 把控件摆到一个已知位置。视口 1024×768，控件 60×44。
  host.style.setProperty('left', '700px', 'important');
  host.style.setProperty('top', '300px', 'important');

  main.dispatchEvent(pointer(win, 'pointerdown', 710, 310));
  main.dispatchEvent(pointer(win, 'pointermove', 708, 310));   // 位移 2px，低于 5px 阈值
  eq('位移未超阈值时不算拖动，位置不动', host.style.getPropertyValue('left'), '700px');

  main.dispatchEvent(pointer(win, 'pointermove', 200, 320));   // 真正拖动
  eq('拖动中改用绝对 left', host.style.getPropertyValue('left'), '190px');
  eq('拖动中 top 跟随指针', host.style.getPropertyValue('top'), '310px');
  eq('拖动中清掉 right（两个定位方向不能并存）', host.style.getPropertyValue('right'), '');

  main.dispatchEvent(pointer(win, 'pointerup', 200, 320));

  const p = handle.position();
  eq('松手后吸附到左侧', p.side, 'left');
  eq('纵向位置停在释放点', p.y, 310);
  eq('拖动后不再贴底', p.bottom, false);
  eq('吸附后 left 变为左侧边缘间距 16px', host.style.getPropertyValue('left'), '16px');
  eq('吸附后 top 保留', host.style.getPropertyValue('top'), '310px');

  // ★ 这条最容易写漏：拖动结束时浏览器还会补发一次 click。
  //   不吞掉它，用户每挪一次位置就会顺手把翻译关掉。
  main.dispatchEvent(new win.Event('click', { bubbles: true }));
  eq('拖动后的那次 click 被吞掉（不会顺手把翻译关了）', calls.toggle, 0);

  // 位置写盘有 260ms 节流
  await wait(340);
  const saved = writes.map((w) => w[CT.STORAGE.TOGGLE_UI]).filter(Boolean).pop();
  ok('位置被写入存储', !!saved, JSON.stringify(writes));
  if (saved) {
    eq('写入的 side', saved.side, 'left');
    eq('写入的 y', saved.y, 310);
    eq('写入的 bottom', saved.bottom, false);
  }

  T.destroy();
}

/* ================================================================== */
/* 五、位置记忆与纯函数                                                */
/* ================================================================== */

section('五、位置记忆与纯逻辑');
{
  const T = boot().CT.toggle;

  eq('默认位置贴右下', JSON.stringify(T.defaultPos()), JSON.stringify({ side: 'right', y: 16, bottom: true }));
  eq('宽屏边缘间距 16', T._gapFor(1200), 16);
  eq('窄屏边缘间距收窄到 10', T._gapFor(400), 10);

  eq('normalizePos 丢弃脏数据、回落到默认位',
    JSON.stringify(T.normalizePos({ side: 'diagonal', y: 'abc', bottom: 'nope' })),
    JSON.stringify({ side: 'right', y: 16, bottom: true }));
  eq('normalizePos 保留合法值',
    JSON.stringify(T.normalizePos({ side: 'left', y: 123, bottom: false })),
    JSON.stringify({ side: 'left', y: 123, bottom: false }));

  // 角落冲突：jsdom 没有 elementFromPoint → 一律视为空闲（容错分支）
  eq('无法探测时视为角落空闲（不能因为探测失败就不挂控件）',
    T._cornerOccupied('right', 700, 1024, 768), false);
  eq('角落空闲时不偏移', T._avoidClash({ side: 'right', y: 16, bottom: true }, 1024, 768).y, 16);

  // 加固属性必须覆盖会「让控件消失或错位」的那一批
  const keys = T._hardenKeys.join(',');
  for (const k of ['position', 'display', 'margin', 'padding', 'border', 'width', 'height',
    'max-width', 'opacity', 'visibility', 'pointer-events', 'transform', 'box-sizing']) {
    ok('加固清单包含 ' + k, keys.indexOf(k) >= 0);
  }

  // 从存储恢复位置：模拟「用户上次把控件拖到左边、并收起过」
  const { doc, CT } = boot({
    stored: { 'ct.toggleUI': { side: 'left', y: 240, bottom: false, collapsed: true } }
  });
  const handle = CT.toggle.mount({});
  await wait(20);
  const p = handle.position();
  eq('恢复贴左边', p.side, 'left');
  eq('恢复纵向坐标', p.y, 240);
  eq('恢复非贴底状态', p.bottom, false);

  const host = doc.querySelector('.' + CT.toggle.CLASS);
  eq('恢复收起态', host.getAttribute('data-collapsed'), '1');

  CT.toggle.destroy();
}

console.log('\n' + '─'.repeat(52));
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  · ' + f);
  console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
  process.exit(1);
}
console.log('全部通过：' + passed + ' 项断言');
