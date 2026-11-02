/*
 * 公共断言 · 「确认卡打开态零『改』字」（B2 迭代 A2 · G-9 盲区补齐）
 * ==================================================================
 * 背景（C-51 契约 + G-9）
 * ------------------------------------------------------------------
 * CTO §C-51 契约：**页面可见文本零「改」字（含引导气泡）**。确认卡由
 * content 脚本注入 `document.body`（content.js:1692）⇒ 属「页面可见文本」。
 * 但此前两支探针对确认卡**打开态**双双漏网：
 *   · tools/probe-corr-hint-click.mjs:164-165 —— 只在普通翻译页扫 body.innerText，
 *     **从不触发确认卡路径**；
 *   · tools/probe-personal-dictionary.mjs:316-323 —— 自标「卡**未打开**态」。
 * 而旧卡标题「检测到你把 X 一直改成 Y」本身含「改」字 ⇒ 违规长期漏网。
 *
 * A2 把卡文案改为提议式（零「改」字）后，**两支探针各补一条本断言**
 * （“两条调用点均须存在”），并各带**变异验证**（卡内塞「改」⇒ 必红）。
 *
 * 用法（真实浏览器探针，Playwright Page）
 * ------------------------------------------------------------------
 *   import { scanOpenLearnCardNoGai } from './_learn-card-gai.mjs';
 *   // 前置：调用方须已让 .ct-learn-card **处于打开态**（真实触发卡路径）。
 *   const r = await scanOpenLearnCardNoGai(page);
 *   check('确认卡打开态零「改」字', r.opened && !r.hasGai, ...);
 *
 * 返回：{ opened, hasGai, cardText }
 *   · opened=false ⇒ 卡未打开，调用方应判红（避免"卡没开也算过"的假绿）。
 *   · hasGai = 卡内 textContent 或页面可见 innerText **含「改」字**。
 * ==================================================================
 */
'use strict';

export async function scanOpenLearnCardNoGai(page) {
  return page.evaluate(() => {
    const card = document.querySelector('.ct-learn-card');
    if (!card) return { opened: false, hasGai: false, cardText: '' };
    const cardText = card.textContent || '';
    const bodyText = (document.body && document.body.innerText) || '';
    return {
      opened: true,
      hasGai: cardText.indexOf('\u6539') >= 0 || bodyText.indexOf('\u6539') >= 0,
      cardText: cardText.slice(0, 140)
    };
  });
}
