/*
 * 对照探针 · remoteok 在「站点样式表未就绪」下的样子（C-26 归因实验）
 * ==================================================================
 * 用户截图的关键异常（相对我方实测基线的偏差）：
 *   · 面板列表行距 22px（站点原生 35px）
 *   · 面板无内边距 / 无底色 / 无圆角 / 无描边
 *   · 列表文本从 container 最左缘开始（x≈150），右侧整片空
 *   · 筛选栏整行、职位卡整表都不在
 *   而顶部 banner 白卡片仍有样式。
 *
 * 假设：这不是布局被破坏，而是【部分站点样式表未生效】——
 *   服务端渲染的 HTML 直接按浏览器默认样式排版：
 *     - div 无 padding → 行距回到默认 line-height（15px × ~1.47 ≈ 22px）✓
 *     - block 宽度 100%，文本左对齐、内容短 → 右侧大片空白 ✓
 *     - .location-filter-results 靠 CSS 里的 display:none 隐藏，
 *       样式没了 → 默认 display:block → 面板自己就显示出来了 ✓
 *     - 职位表由站点 JS 渲染 → 未渲染 → 右侧/下方没有卡 ✓
 *     - banner 白卡片靠内联关键样式 → 仍有样式 ✓
 *
 * 本探针用「阻断 stylesheet 请求」来复现，并给出量测对比。
 * 若量测与用户截图特征吻合（行距≈22、面板无 padding、列表贴左缘），
 * 即可判定该现象是环境侧（站点资源未就绪）而非我方布局破坏。
 *
 * 运行：NODE_PATH=<node_modules> node tools/probe-remoteok-nocss.mjs [all|third]
 *   all   = 阻断全部 stylesheet
 *   third = 只阻断第三方域 stylesheet（保留 remoteok 自身）
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
const HOW = (process.argv[2] || 'all').toLowerCase();

const DICT = {
  Worldwide: '全球', 'North America': '北美', 'Latin America': '拉丁美洲',
  Europe: '欧洲', Africa: '非洲', 'Middle East': '中东', Asia: '亚洲',
  Oceania: '大洋洲', 'United States': '美国', Canada: '加拿大',
  'United Kingdom': '英国', Australia: '澳大利亚', 'New Zealand': '新西兰',
  REGIONS: '地区', COUNTRIES: '国家'
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
  var out = { err: null };
  if (!panel) { out.err = 'panel missing'; return out; }
  var cs = getComputedStyle(panel);
  var pr = panel.getBoundingClientRect();
  var kids = [].slice.call(panel.children);
  var items = kids.filter(function (c) { return !c.classList.contains('optgroup-header'); });
  var tops = {};
  kids.forEach(function (c) { tops[Math.round(c.getBoundingClientRect().top)] = 1; });
  var f = items[0];
  var fr = f ? f.getBoundingClientRect() : null;
  var jobRows = document.querySelectorAll('tr.job').length;
  var board = document.querySelector('#jobsboard') || document.querySelector('table');

  // 行距：取前 6 项矩形 top 的差
  var topsArr = items.slice(0, 6).map(function (c) { return c.getBoundingClientRect().top; });
  var gaps = [];
  for (var i = 1; i < topsArr.length; i++) gaps.push(Math.round(topsArr[i] - topsArr[i - 1]));

  return {
    panel: {
      display: cs.display, position: cs.position, width: Math.round(pr.width),
      height: Math.round(pr.height), left: Math.round(pr.left),
      padding: cs.padding, borderRadius: cs.borderRadius,
      backgroundColor: cs.backgroundColor, boxShadow: cs.boxShadow.slice(0, 40)
    },
    itemCount: items.length,
    rowCount: Object.keys(tops).length,
    itemGaps: gaps,
    firstItem: f ? { display: getComputedStyle(f).display, width: Math.round(fr.width),
      height: Math.round(fr.height), padding: getComputedStyle(f).padding,
      fontSize: getComputedStyle(f).fontSize, lineHeight: getComputedStyle(f).lineHeight,
      text: (f.textContent || '').trim().slice(0, 24) } : null,
    panelOffsetLeft: Math.round(pr.left),
    containerLeft: (function () {
      var c = document.querySelector('.container');
      return c ? Math.round(c.getBoundingClientRect().left) : null;
    })(),
    jobRows: jobRows,
    board: board ? { w: Math.round(board.getBoundingClientRect().width), display: getComputedStyle(board).display } : null,
    replacedTotal: document.querySelectorAll('.ct-replaced').length,
    transTotal: document.querySelectorAll('.ct-trans').length,
    bodyFontSize: getComputedStyle(document.body).fontSize,
    styleSheets: document.styleSheets.length,
    pageScrollHeight: document.documentElement.scrollHeight
  };
}`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-probe-nocss-'));
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
    displayMode: 'replace', insertMode: 'auto', transStyle: 'plain'
  } }, () => res());
}), { base });

const page = await ctx.newPage();
let blocked = 0;
await page.route('**/*', (route) => {
  const req = route.request();
  if (req.resourceType() !== 'stylesheet') return route.continue();
  if (HOW === 'third') {
    const host = new URL(req.url()).hostname;
    if (/remoteok\.com$/.test(host)) return route.continue();
  }
  blocked++;
  return route.abort();
});

await page.goto('https://remoteok.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);
console.log('阻断的 stylesheet 请求数 = ' + blocked + '（模式 ' + HOW + '）');

const before = await page.evaluate((e) => eval(e)(), MEASURE);
console.log('\n—— 阻断后（翻译前） ——\n' + JSON.stringify(before, null, 1));
await page.screenshot({ path: path.join(OUT, 'nocss-' + HOW + '-before.png') });

await page.waitForSelector('.ct-toggle', { timeout: 30000 }).catch(() => {});
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
  return b && /已译|翻译失败/.test(b.textContent || '');
}, { timeout: 300000 }).catch(() => console.log('（等待徽标超时，仍继续量测）'));
await page.waitForTimeout(2500);

const after = await page.evaluate((e) => eval(e)(), MEASURE);
console.log('\n—— 阻断后（翻译后） ——\n' + JSON.stringify(after, null, 1));
await page.screenshot({ path: path.join(OUT, 'nocss-' + HOW + '-after.png') });

console.log('\n================ 与用户截图特征比对（模式 ' + HOW + '）================');
console.log('面板 display   ：' + before.panel.display + ' → ' + after.panel.display
  + '（用户截图：面板自己就显示出来）');
console.log('面板 padding   ：' + JSON.stringify(before.panel.padding) + ' → ' + JSON.stringify(after.panel.padding)
  + '（用户截图：无内边距）');
console.log('面板 borderRadius：' + before.panel.borderRadius + '（用户截图：无圆角）');
console.log('面板宽×高      ：' + before.panel.width + '×' + before.panel.height
  + ' → ' + after.panel.width + '×' + after.panel.height + '（用户截图：文本贴左、右侧大片空）');
console.log('面板 left      ：' + before.panel.left + '   container left：' + before.containerLeft
  + '（用户截图：列表从 container 左缘起）');
console.log('前 5 项行距    ：' + JSON.stringify(before.itemGaps) + ' → ' + JSON.stringify(after.itemGaps)
  + '（用户截图：≈22px；站点原生 35px）');
console.log('首项           ：' + JSON.stringify(before.firstItem) + '\n              → ' + JSON.stringify(after.firstItem));
console.log('职位行数       ：' + before.jobRows + ' → ' + after.jobRows + '（用户截图：0）');
console.log('职位表         ：' + JSON.stringify(before.board));
console.log('body 字号      ：' + before.bodyFontSize + '   样式表数：' + before.styleSheets);
console.log('翻译量         ：.ct-replaced ' + before.replacedTotal + ' → ' + after.replacedTotal
  + '；.ct-trans ' + before.transTotal + ' → ' + after.transTotal);

await ctx.close();
