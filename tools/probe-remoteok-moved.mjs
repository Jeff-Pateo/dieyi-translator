/*
 * 定性探针 · 「裁切容器」判据把 259 条译文搬出筛选面板（C-26 根因验证）
 * ==================================================================
 * 【假设】
 * remoteok 的 .location-filter-results 同时写着：
 *     overflow: hidden;  max-height: 500px;  overflow-y: scroll;
 * 命中布局保全第一级的「裁切容器」判据（hasClipContext + constrainsContent 都真），
 * 于是 placementFor 在「原文下方双语」模式下对这 259 个单元全部返回
 *     { kind: 'after', anchor: 面板 }   // reason: 'clipped'
 * 译文被搬到**面板之外**，成为 .container 的常规流子元素。
 * 而面板本身是 position:absolute（脱离文档流），
 * 因此这 259 个译文块就成了 .container 里**最靠前的一批常规流内容**：
 * 从容器左缘开始向下堆叠（每块约 22px），把筛选栏与职位表整体推到
 * 页面下方 —— 用户看到的就是「一条中文竖排列表 + 右侧整片空白」。
 *
 * 注意：replace（仅显示译文）模式不插入节点，所以前几版探针量不出来；
 * 必须跑 below 模式才现形。这也解释了为什么「面板自身几何量前后一致」
 * 与「页面被破坏」可以同时成立 —— 被破坏的是面板**外面**。
 *
 * 运行：NODE_PATH=<node_modules> node tools/probe-remoteok-moved.mjs [below|replace]
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
const MODE = (process.argv[2] || 'below').toLowerCase();

const DICT = {
  Worldwide: '全球', 'North America': '北美', 'Latin America': '拉丁美洲',
  Europe: '欧洲', Africa: '非洲', 'Middle East': '中东', Asia: '亚洲',
  Oceania: '大洋洲', 'United States': '美国', Canada: '加拿大',
  'United Kingdom': '英国', Australia: '澳大利亚', 'New Zealand': '新西兰',
  India: '印度', Portugal: '葡萄牙', Germany: '德国', Netherlands: '荷兰',
  Singapore: '新加坡', France: '法国', 'Hong Kong': '香港', Brazil: '巴西',
  Greece: '希腊', 'United Arab Emirates': '阿拉伯联合酋长国', Sweden: '瑞典',
  Regions: '地区', Countries: '国家', Location: '地点'
};
const t = (s) => DICT[s] || '译文';

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
              message: { role: 'a', content: JSON.stringify({ t: texts.map(t) }) } }] }));
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
  var cs = getComputedStyle(panel);
  var pr = panel.getBoundingClientRect();
  var items = [].slice.call(panel.children)
    .filter(function (c) { return !c.classList.contains('optgroup-header'); });

  var rectOf = function (e) { var r = e.getBoundingClientRect();
    return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };

  // 面板之外的译文块：与面板同父、位置在面板之后的 .ct-trans
  var outs = [];
  for (var s = panel.nextElementSibling; s; s = s.nextElementSibling) {
    if (s.classList && s.classList.contains('ct-trans')) outs.push(s);
  }
  // .container 下所有直接子级的 .ct-trans
  var cont = document.querySelector('.container');
  var contTrans = cont ? [].slice.call(cont.children)
    .filter(function (c) { return c.classList.contains('ct-trans'); }) : [];

  var board = document.querySelector('#jobsboard');
  var locFilter = document.querySelector('.location-filter');
  var banner = document.querySelector('.notice-post-job');

  return {
    panel: {
      display: cs.display, position: cs.position, width: Math.round(pr.width),
      height: Math.round(pr.height), left: Math.round(pr.left), top: Math.round(pr.top),
      overflowX: cs.overflowX, overflowY: cs.overflowY, maxHeight: cs.maxHeight,
      padding: cs.padding, backgroundColor: cs.backgroundColor
    },
    itemCount: items.length,
    transInPanel: panel.querySelectorAll('.ct-trans').length,
    outsAfterPanel: outs.length,
    outsRectFirst: outs[0] ? rectOf(outs[0]) : null,
    outsRectLast: outs.length ? rectOf(outs[outs.length - 1]) : null,
    outsSampleText: outs.slice(0, 6).map(function (e) { return (e.textContent || '').trim().slice(0, 14); }),
    containerTrans: contTrans.length,
    containerChildren: cont ? cont.children.length : null,
    banner: banner ? rectOf(banner) : null,
    locFilter: locFilter ? rectOf(locFilter) : null,
    board: board ? rectOf(board) : null,
    transTotal: document.querySelectorAll('.ct-trans').length,
    replacedTotal: document.querySelectorAll('.ct-replaced').length,
    pageScrollHeight: document.documentElement.scrollHeight
  };
}`;

const KILL_POPUP = `() => {
  var ov = document.getElementById('premium-popup-overlay');
  if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
  [].forEach.call(document.querySelectorAll('[id*=popup][id*=overlay], .modal-overlay'), function (e) {
    if (e && e.parentNode && e.id !== 'premium-popup-overlay') e.parentNode.removeChild(e);
  });
  return true;
}`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-probe-rkm-'));
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

const page = await ctx.newPage();
await page.goto('https://remoteok.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4500);
await page.waitForSelector('.ct-toggle', { timeout: 30000 });
await page.evaluate((e) => eval(e)(), KILL_POPUP);
await page.waitForTimeout(500);

/* 真点展开筛选面板 */
await page.locator('.location-filter-input').click({ timeout: 15000 });
await page.waitForTimeout(900);
await page.evaluate((e) => eval(e)(), KILL_POPUP);

const before = await page.evaluate((e) => eval(e)(), MEASURE);
console.log('\n=== 翻译前（面板已展开） ===\n' + JSON.stringify(before, null, 1));
await page.screenshot({ path: path.join(OUT, 'moved-' + MODE + '-before.png') });

const tabId = await opt.evaluate(async () => {
  const tabs = await chrome.tabs.query({ url: 'https://remoteok.com/*' });
  return tabs.length ? tabs[0].id : null;
});
const ack = await opt.evaluate(async (id) => {
  try { return JSON.stringify(await chrome.tabs.sendMessage(id, { type: 'ct:cmd', cmd: { action: 'toggle' } })); }
  catch (e) { return 'ERR ' + e.message; }
}, tabId);
console.log('\ntoggle 回执 = ' + ack);

await page.waitForFunction(() => {
  
  const b = document.querySelector('.ct-badge__text');

        const host = document.querySelector('.ct-toggle');

        const lb = host && host.shadowRoot && host.shadowRoot.querySelector('.label');

        const t = (b && b.textContent) || (lb && lb.textContent) || '';

        return /已译|翻译失败/.test(t);
}, { timeout: 300000 });
await page.waitForTimeout(2500);
await page.evaluate((e) => eval(e)(), KILL_POPUP);
await page.waitForTimeout(400);

const after = await page.evaluate((e) => eval(e)(), MEASURE);
console.log('\n=== 翻译后 ===\n' + JSON.stringify(after, null, 1));
await page.screenshot({ path: path.join(OUT, 'moved-' + MODE + '-after.png') });

console.log('\n=============== 根因验证（' + MODE + '） ===============');
console.log('面板 position/宽×高/overflow/max-height：' + after.panel.position + ' / '
  + after.panel.width + '×' + after.panel.height + ' / '
  + after.panel.overflowX + ',' + after.panel.overflowY + ' / ' + after.panel.maxHeight);
console.log('面板内 .ct-trans        ：' + before.transInPanel + '  →  ' + after.transInPanel);
console.log('★ 紧跟在面板之后的译文块 ：' + before.outsAfterPanel + '  →  ' + after.outsAfterPanel);
console.log('   首个译文块 rect       ：' + JSON.stringify(after.outsRectFirst));
console.log('   末个译文块 rect       ：' + JSON.stringify(after.outsRectLast));
console.log('   前 6 块文本           ：' + JSON.stringify(after.outsSampleText));
console.log('.container 直接子译文块  ：' + before.containerTrans + '  →  ' + after.containerTrans
  + '（.container 子级总数 ' + before.containerChildren + ' → ' + after.containerChildren + '）');
console.log('banner 位置              ：' + JSON.stringify(before.banner) + '  →  ' + JSON.stringify(after.banner));
console.log('筛选栏 .location-filter  ：' + JSON.stringify(before.locFilter) + '  →  ' + JSON.stringify(after.locFilter));
console.log('★ 职位表 #jobsboard      ：' + JSON.stringify(before.board) + '  →  ' + JSON.stringify(after.board));
console.log('页面总高                 ：' + before.pageScrollHeight + '  →  ' + after.pageScrollHeight);

await ctx.close();
