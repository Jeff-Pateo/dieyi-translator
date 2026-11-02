/*
 * 复现探针 v5 · remoteok 筛选面板「竖排 + 右侧空白」（C-26）
 * ==================================================================
 * 【前两版失败点，都已定位】
 *   v4：点「翻译」按钮是真的鼠标点击 → 筛选输入框失焦 → 站点把
 *       .location-filter-results 收成 display:none → 采集时面板不可见，
 *       量到 transNodesInPanel = 0。不是「没翻译」，是「没采到」。
 *   v5-a：`page.evaluate(HOLD)` 传字符串只求值不调用，守卫从未运行；
 *       且 `ct:set-settings` 广播本身会触发 content script 的
 *       applySettings（无条件 state.enabled = true + run('settings')），
 *       页面在我发 toggle 之前已经整页翻完，我的 toggle 反而把它关掉了。
 *
 * 【本版（v5-b）的时序设计】
 *   ① 先开扩展页 → 改设置（autoTranslate:false）→ 此时还没有目标页，
 *      广播打不到任何 content script；
 *   ② 再开 remoteok → boot 走 autoTranslate=false 分支，enabled=false，
 *      页面保持原文（干净的基线）；
 *   ③ 真实鼠标点击 .location-filter-input 展开筛选面板（此刻已无失焦顾虑，
 *      因为触发翻译改走消息通道，不再点按钮）；
 *   ④ 量基线 + 截图；
 *   ⑤ 从扩展页发 chrome.tabs.sendMessage({type:'ct:cmd',cmd:{action:'toggle'}})
 *      → 零鼠标/零焦点事件，面板全程保持展开；
 *   ⑥ 量终态 + 截图。
 *
 * 【取证重点】
 *   · 面板底色实测 rgba(251,250,248,0.95) —— 与页面底色 rgb(251,250,248)
 *     几乎同色，「白底消失」是错觉，不是缺陷；
 *   · 真正要量的是：面板背后的职位卡数量、面板宽/项宽/行数是否被我方改动。
 *
 * 运行：NODE_PATH=<node_modules> node tools/probe-remoteok-panel-hold.mjs [replace|below]
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXT = ROOT;
const CHROME = process.env.CT_E2E_CHROME
  || 'C:/Users/Administrator/.workbuddy/binaries/cft/chrome-win64/chrome.exe';
const OUT = path.join(ROOT, 'tools', 'bench-results');
const MODE = (process.argv[2] || 'replace').toLowerCase();

const DICT = {
  Worldwide: '全球', 'North America': '北美', 'Latin America': '拉丁美洲',
  Europe: '欧洲', Africa: '非洲', 'Middle East': '中东', Asia: '亚洲',
  Oceania: '大洋洲', 'United States': '美国', Canada: '加拿大',
  'United Kingdom': '英国', Australia: '澳大利亚', 'New Zealand': '新西兰',
  India: '印度', Portugal: '葡萄牙', Germany: '德国', Netherlands: '荷兰',
  Singapore: '新加坡', France: '法国', 'Hong Kong': '香港', Brazil: '巴西',
  Greece: '希腊', 'United Arab Emirates': '阿拉伯联合酋长国', Sweden: '瑞典',
  REGIONS: '地区', COUNTRIES: '国家', Location: '地点'
};
function fakeTranslate(s) { return DICT[s] || '译文'; }

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const p = JSON.parse(body);
          const texts = JSON.parse(p.messages[p.messages.length - 1].content)
            .map((x) => (typeof x === 'string' ? x : x.s));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 'm', object: 'c', created: 1, model: 'm',
            choices: [{ index: 0, finish_reason: 'stop',
              message: { role: 'a', content: JSON.stringify({ t: texts.map(fakeTranslate) }) } }] }));
        } catch (e) { res.writeHead(500); res.end('{}'); }
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const MEASURE = `() => {
  var panel = document.querySelector('.location-filter-results');
  if (!panel) return { err: 'panel missing' };
  var cs = getComputedStyle(panel);
  var pr = panel.getBoundingClientRect();
  var kids = [].slice.call(panel.children);
  var items = kids.filter(function (c) { return !c.classList.contains('optgroup-header'); });
  var tops = {};
  kids.forEach(function (c) { tops[Math.round(c.getBoundingClientRect().top)] = 1; });
  var widths = items.map(function (c) { return Math.round(c.getBoundingClientRect().width); });

  var bgOwner = null;
  for (var n = panel; n; n = n.parentElement) {
    var b = getComputedStyle(n).backgroundColor;
    if (b && b !== 'rgba(0, 0, 0, 0)' && b !== 'transparent') {
      bgOwner = { tag: n.tagName, cls: String(n.className).slice(0, 50), bg: b };
      break;
    }
  }

  var jobRows = [].slice.call(document.querySelectorAll('tr.job'));
  var jobVisible = jobRows.filter(function (r) { return r.getBoundingClientRect().height > 2; }).length;
  var board = document.querySelector('#jobsboard') || document.querySelector('table');

  return {
    visible: cs.display !== 'none' && pr.width > 0,
    activeEl: document.activeElement
      ? document.activeElement.tagName + '.' + String(document.activeElement.className).slice(0, 36)
      : null,
    panel: {
      display: cs.display, position: cs.position, width: Math.round(pr.width),
      height: Math.round(pr.height), left: Math.round(pr.left), top: Math.round(pr.top),
      backgroundColor: cs.backgroundColor, borderRadius: cs.borderRadius,
      padding: cs.padding, margin: cs.margin,
      scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth,
      inlineStyle: (panel.getAttribute('style') || '').slice(0, 160)
    },
    bgOwner: bgOwner,
    itemCount: items.length, rowCount: Object.keys(tops).length,
    itemWidth: { min: Math.min.apply(null, widths), max: Math.max.apply(null, widths) },
    firstItem: items[0] ? {
      display: getComputedStyle(items[0]).display,
      width: Math.round(items[0].getBoundingClientRect().width),
      height: Math.round(items[0].getBoundingClientRect().height),
      text: (items[0].textContent || '').trim().slice(0, 30)
    } : null,
    sampleTexts: items.slice(0, 6).map(function (c) { return (c.textContent || '').trim().slice(0, 16); }),
    replacedInPanel: panel.querySelectorAll('.ct-replaced').length,
    transInPanel: panel.querySelectorAll('.ct-trans').length,
    replacedTotal: document.querySelectorAll('.ct-replaced').length,
    transTotal: document.querySelectorAll('.ct-trans').length,
    jobRows: jobRows.length, jobRowsVisible: jobVisible,
    board: board ? { w: Math.round(board.getBoundingClientRect().width),
      h: Math.round(board.getBoundingClientRect().height),
      display: getComputedStyle(board).display } : null,
    pageScrollHeight: document.documentElement.scrollHeight,
    viewport: { w: window.innerWidth, h: window.innerHeight }
  };
}`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-probe-rl5-'));
const server = await startServer();
const base = 'http://127.0.0.1:' + server.address().port;
fs.mkdirSync(OUT, { recursive: true });

const ctx = await chromium.launchPersistentContext(profile, {
  headless: false, executablePath: CHROME, viewport: { width: 1400, height: 900 },
  args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT,
    '--disable-features=DisableLoadExtensionCommandLineSwitch', '--no-first-run']
});
let sw = null;
for (let i = 0; i < 40 && !sw; i++) {
  sw = ctx.serviceWorkers().find((w) => w.url().includes('service-worker.js'));
  if (!sw) await new Promise((r) => setTimeout(r, 250));
}
const extId = sw.url().split('/')[2];

/* ① 先改设置（此刻还没有目标页，广播不会误触发翻译） */
const opt = await ctx.newPage();
await opt.goto('chrome-extension://' + extId + '/options/options.html', { waitUntil: 'domcontentloaded' });
await opt.evaluate((arg) => new Promise((res) => {
  chrome.runtime.sendMessage({ type: 'ct:set-settings', patch: {
    provider: 'openai', openaiBaseUrl: arg.base + '/v1', openaiApiKey: 'k', openaiModel: 'm',
    autoTranslate: false, siteMemory: false, cacheEnabled: false, selectionEnabled: false,
    displayMode: arg.mode, insertMode: 'auto', transStyle: 'plain'
  } }, () => res());
}), { base, mode: MODE });
console.log('displayMode = ' + MODE + '（已在目标页打开前写入）');

/* ② 再开目标页：走 autoTranslate=false 分支，保持原文基线 */
const page = await ctx.newPage();
await page.goto('https://remoteok.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);
await page.waitForSelector('.ct-toggle', { timeout: 30000 });

/* ③ 真实鼠标点击展开筛选面板 */
const input = page.locator('.location-filter-input');
let openHow = 'none';
try {
  await input.click({ timeout: 8000 });
  openHow = 'click:input';
} catch (e) {
  await page.locator('.location-filter').first().click({ timeout: 8000 }).catch(() => {});
  openHow = 'click:box';
}
await page.waitForTimeout(900);
let b0 = await page.evaluate((e) => eval(e)(), MEASURE);
if (!b0.visible) {
  // 兜底：面板没被真实交互打开时，强制展开并注明（只影响探针，不改产品代码）
  await page.evaluate(() => {
    const p = document.querySelector('.location-filter-results');
    if (p) p.style.setProperty('display', 'block', 'important');
  });
  await page.waitForTimeout(600);
  openHow += ' +force';
  b0 = await page.evaluate((e) => eval(e)(), MEASURE);
}
console.log('展开方式：' + openHow);

const shotBefore = path.join(OUT, 'panel-v5-' + MODE + '-before.png');
await page.screenshot({ path: shotBefore });
console.log('\n—— 面板展开（翻译前 · 基线） ——\n' + JSON.stringify(b0, null, 1));

/* ⑤ 零鼠标事件触发翻译 */
const tabId = await opt.evaluate(async () => {
  const tabs = await chrome.tabs.query({ url: 'https://remoteok.com/*' });
  return tabs.length ? tabs[0].id : null;
});
const ack = await opt.evaluate(async (id) => {
  try {
    return JSON.stringify(await chrome.tabs.sendMessage(id, { type: 'ct:cmd', cmd: { action: 'toggle' } }));
  } catch (e) { return 'ERR ' + e.message; }
}, tabId);
console.log('\n目标标签 id = ' + tabId + ' · toggle 回执 = ' + ack);

await page.waitForFunction(() => {
  const b = document.querySelector('.ct-badge__text');
  return b && /已译|翻译失败/.test(b.textContent || '');
}, { timeout: 300000 });
await page.waitForTimeout(2500);

const after = await page.evaluate((e) => eval(e)(), MEASURE);
const shotAfter = path.join(OUT, 'panel-v5-' + MODE + '-after.png');
await page.screenshot({ path: shotAfter });
console.log('\n—— 面板展开（翻译后） ——\n' + JSON.stringify(after, null, 1));

console.log('\n================ 判定（displayMode=' + MODE + '）================');
console.log('面板可见     ：' + b0.visible + ' → ' + after.visible
  + '   activeElement：' + b0.activeEl + ' → ' + after.activeEl);
console.log('面板 display/position：' + b0.panel.display + '/' + b0.panel.position
  + ' → ' + after.panel.display + '/' + after.panel.position);
console.log('面板宽／高   ：' + b0.panel.width + '×' + b0.panel.height
  + ' → ' + after.panel.width + '×' + after.panel.height);
console.log('面板左／上   ：' + b0.panel.left + '/' + b0.panel.top + ' → ' + after.panel.left + '/' + after.panel.top);
console.log('面板底色     ：' + b0.panel.backgroundColor + ' → ' + after.panel.backgroundColor);
console.log('项数／行数   ：' + b0.itemCount + '/' + b0.rowCount + ' → ' + after.itemCount + '/' + after.rowCount);
console.log('项宽 min~max ：' + b0.itemWidth.min + '~' + b0.itemWidth.max
  + ' → ' + after.itemWidth.min + '~' + after.itemWidth.max);
console.log('首项         ：' + JSON.stringify(b0.firstItem) + '\n           →  ' + JSON.stringify(after.firstItem));
console.log('面板内 .ct-trans/.ct-replaced：' + b0.transInPanel + '/' + b0.replacedInPanel
  + ' → ' + after.transInPanel + '/' + after.replacedInPanel);
console.log('全页 .ct-trans/.ct-replaced：' + b0.transTotal + '/' + b0.replacedTotal
  + ' → ' + after.transTotal + '/' + after.replacedTotal);
console.log('职位行数     ：' + b0.jobRows + '（可见 ' + b0.jobRowsVisible + '） → '
  + after.jobRows + '（可见 ' + after.jobRowsVisible + '）');
console.log('职位表尺寸   ：' + JSON.stringify(b0.board) + ' → ' + JSON.stringify(after.board));
console.log('页面总高     ：' + b0.pageScrollHeight + ' → ' + after.pageScrollHeight);
console.log('截图：' + shotBefore + '\n      ' + shotAfter);

await ctx.close();
