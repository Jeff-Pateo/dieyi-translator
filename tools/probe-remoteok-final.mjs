/*
 * 收口探针 · remoteok 筛选面板「竖排 + 右侧空白」终局取证（C-26）
 * ==================================================================
 * 产出一组「同视口、同路径、同裁切」的前后对照图（1400×900，另存
 * 1093×699 的对照裁切，与用户截图同规格），并顺带查清：
 *   · 运行时页面里到底注入了几个 <style>，各自内容是什么
 *     （服务端 HTML 只有 1 个 51 字节的 chatbase 样式，
 *       运行时有 5 个 —— 多出来的 4 个是谁注入的，必须点名）
 *   · 面板 259 项在翻译前后的几何量与环境量
 *
 * 时序（沿用已修正的 v5 方案）：
 *   ① 先写设置（autoTranslate:false）→ ② 开页面（保持原文基线）
 *   → ③ 真点 .location-filter-input 展开面板 → ④ 量基线/截图
 *   → ⑤ 消息通道触发翻译（零鼠标事件，面板不失焦）
 *   → ⑥ 关掉站点自己的弹窗 → ⑦ 量终态/截图
 *
 * 运行：NODE_PATH=<node_modules> node tools/probe-remoteok-final.mjs [replace|below]
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
  Regions: '地区', Countries: '国家', Location: '地点', 'Remote OK': '远程 OK'
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
  var kids = [].slice.call(panel.children);
  var items = kids.filter(function (c) { return !c.classList.contains('optgroup-header'); });
  var heads = kids.filter(function (c) { return c.classList.contains('optgroup-header'); });
  var widths = items.map(function (c) { return Math.round(c.getBoundingClientRect().width); });
  var heights = items.slice(0, 30).map(function (c) { return Math.round(c.getBoundingClientRect().height); });
  var topsArr = items.slice(0, 8).map(function (c) { return c.getBoundingClientRect().top; });
  var gaps = [];
  for (var i = 1; i < topsArr.length; i++) gaps.push(Math.round(topsArr[i] - topsArr[i - 1]));
  var f = items[0];
  var h0 = heads[0];
  return {
    panel: {
      display: cs.display, position: cs.position, width: Math.round(pr.width),
      height: Math.round(pr.height), left: Math.round(pr.left), top: Math.round(pr.top),
      padding: cs.padding, borderRadius: cs.borderRadius,
      backgroundColor: cs.backgroundColor, overflowY: cs.overflowY,
      scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth
    },
    itemCount: items.length, headCount: heads.length,
    itemWidth: { min: Math.min.apply(null, widths), max: Math.max.apply(null, widths) },
    itemHeightSample: heights.slice(0, 6),
    itemGaps: gaps,
    firstItem: f ? { display: getComputedStyle(f).display, padding: getComputedStyle(f).padding,
      fontSize: getComputedStyle(f).fontSize, fontWeight: getComputedStyle(f).fontWeight,
      w: Math.round(f.getBoundingClientRect().width), h: Math.round(f.getBoundingClientRect().height),
      text: (f.textContent || '').trim().slice(0, 24) } : null,
    firstHead: h0 ? { fontSize: getComputedStyle(h0).fontSize,
      fontWeight: getComputedStyle(h0).fontWeight,
      h: Math.round(h0.getBoundingClientRect().height),
      text: (h0.textContent || '').trim().slice(0, 16) } : null,
    jobRows: document.querySelectorAll('tr.job').length,
    boardW: (function () {
      var b = document.querySelector('#jobsboard');
      return b ? Math.round(b.getBoundingClientRect().width) : null;
    })(),
    containerLeft: Math.round(document.querySelector('.container').getBoundingClientRect().left),
    containerW: Math.round(document.querySelector('.container').getBoundingClientRect().width),
    replacedTotal: document.querySelectorAll('.ct-replaced').length,
    transTotal: document.querySelectorAll('.ct-trans').length,
    styleTags: [].slice.call(document.querySelectorAll('style')).map(function (s) {
      return { len: (s.textContent || '').length, head: (s.textContent || '').trim().slice(0, 200) };
    }),
    linkSheets: [].slice.call(document.querySelectorAll('link[rel=stylesheet]'))
      .map(function (l) { return l.href; }),
    pageScrollHeight: document.documentElement.scrollHeight
  };
}`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-probe-rkf-'));
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

const page = await ctx.newPage();
await page.goto('https://remoteok.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4500);
await page.waitForSelector('.ct-toggle', { timeout: 30000 });
await page.locator('.location-filter-input').click({ timeout: 10000 });
await page.waitForTimeout(900);

const before = await page.evaluate((e) => eval(e)(), MEASURE);
const shotB = path.join(OUT, 'final-' + MODE + '-before.png');
await page.screenshot({ path: shotB });
console.log('=== 翻译前（面板已展开） ===\n' + JSON.stringify({
  panel: before.panel, itemCount: before.itemCount, itemWidth: before.itemWidth,
  itemHeightSample: before.itemHeightSample, itemGaps: before.itemGaps,
  firstItem: before.firstItem, firstHead: before.firstHead,
  jobRows: before.jobRows, containerLeft: before.containerLeft, containerW: before.containerW
}, null, 1));

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

/* 站点自己的升级弹窗会盖住画面 —— 关掉它，保证对照图干净 */
for (let i = 0; i < 3; i++) {
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const btn = document.querySelector('.close, .modal .close, [class*="close"]');
    if (btn && btn.click) btn.click();
  });
  await page.waitForTimeout(400);
}
await page.evaluate(() => {
  const p = document.querySelector('.location-filter-results');
  if (p && p.scrollTop) p.scrollTop = 0;
});
await page.waitForTimeout(400);

const after = await page.evaluate((e) => eval(e)(), MEASURE);
const shotA = path.join(OUT, 'final-' + MODE + '-after.png');
await page.screenshot({ path: shotA });
console.log('\n=== 翻译后（面板保持展开） ===\n' + JSON.stringify({
  panel: after.panel, itemCount: after.itemCount, itemWidth: after.itemWidth,
  itemHeightSample: after.itemHeightSample, itemGaps: after.itemGaps,
  firstItem: after.firstItem, firstHead: after.firstHead,
  jobRows: after.jobRows, containerLeft: after.containerLeft, containerW: after.containerW,
  replacedTotal: after.replacedTotal, transTotal: after.transTotal,
  pageScrollHeight: after.pageScrollHeight
}, null, 1));

console.log('\n=== 运行时的 <style> 注入清单 ===');
after.styleTags.forEach((s, i) => console.log('[' + i + '] len=' + s.len + ' :: ' + s.head.replace(/\s+/g, ' ')));
console.log('\n=== <link rel=stylesheet> ===\n' + JSON.stringify(after.linkSheets, null, 1));

console.log('\n================ 前后对比（' + MODE + '）================');
console.log('面板 宽×高   ：' + before.panel.width + '×' + before.panel.height
  + '  →  ' + after.panel.width + '×' + after.panel.height);
console.log('面板 padding/圆角/底色：' + before.panel.padding + ' / ' + before.panel.borderRadius
  + ' / ' + before.panel.backgroundColor);
console.log('面板 左/上   ：' + before.panel.left + '/' + before.panel.top
  + '  →  ' + after.panel.left + '/' + after.panel.top);
console.log('项数         ：' + before.itemCount + '  →  ' + after.itemCount);
console.log('项宽 min~max ：' + before.itemWidth.min + '~' + before.itemWidth.max
  + '  →  ' + after.itemWidth.min + '~' + after.itemWidth.max);
console.log('前 6 项高    ：' + JSON.stringify(before.itemHeightSample)
  + '  →  ' + JSON.stringify(after.itemHeightSample));
console.log('前 7 项行距  ：' + JSON.stringify(before.itemGaps) + '  →  ' + JSON.stringify(after.itemGaps));
console.log('首项         ：' + JSON.stringify(before.firstItem) + '\n            → ' + JSON.stringify(after.firstItem));
console.log('首项（表头）  ：' + JSON.stringify(before.firstHead) + '\n            → ' + JSON.stringify(after.firstHead));
console.log('职位行数     ：' + before.jobRows + '  →  ' + after.jobRows);
console.log('container 左/宽：' + before.containerLeft + '/' + before.containerW
  + '  →  ' + after.containerLeft + '/' + after.containerW);
console.log('截图：' + shotB + '\n      ' + shotA);

/* 另存与用户截图同规格的裁切（1093×699），便于并排比对 */
const { execFileSync } = require('node:child_process');
console.log('\n（用 tools/_img 下的 python 脚本可裁切比对；本探针只负责产出整幅）');

await ctx.close();
