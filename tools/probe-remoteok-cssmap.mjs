/*
 * 取证探针 · remoteok 样式表归属图（C-26 归因）
 * ==================================================================
 * 目的：回答「面板 .location-filter-results 的样式来自哪里」——
 *   是内联 <style>（首屏关键样式，几乎不会加载失败）
 *   还是外部 <link rel=stylesheet>（网络抖动就会整体失效）。
 *
 * 方法：加载页面后遍历 document.styleSheets，逐个报告
 *   · href（null = 内联 <style>）
 *   · 规则条数
 *   · 是否含 .location-filter-results / .container / .job 的规则
 *   · 面板关键样式（width/height/display/padding/position）分别由哪张表给出
 *
 * 运行：NODE_PATH=<node_modules> node tools/probe-remoteok-cssmap.mjs
 */
import fs from 'node:fs';
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-probe-cssmap-'));
fs.mkdirSync(OUT, { recursive: true });

const ctx = await chromium.launchPersistentContext(profile, {
  headless: false, executablePath: CHROME, viewport: { width: 1400, height: 900 },
  args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT,
    '--disable-features=DisableLoadExtensionCommandLineSwitch', '--no-first-run']
});

const page = await ctx.newPage();
const cssRequests = [];
page.on('response', (r) => {
  const ct = (r.headers()['content-type'] || '');
  if (ct.includes('text/css')) cssRequests.push({ url: r.url(), status: r.status() });
});
await page.goto('https://remoteok.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);

const map = await page.evaluate(() => {
  const out = [];
  const probeSel = ['.location-filter-results', '.container', 'tr.job', '.page',
    '.job', 'body'];
  for (let i = 0; i < document.styleSheets.length; i++) {
    const ss = document.styleSheets[i];
    let rules = null; let err = null;
    try { rules = ss.cssRules; } catch (e) { err = String(e.message || e); }
    let n = 0; const hits = {};
    if (rules) {
      n = rules.length;
      const walk = (list) => {
        for (let j = 0; j < list.length; j++) {
          const r = list[j];
          /* ★ 先判 selectorText 再判 cssRules ★
           * Chrome 129+ 起 CSSStyleRule 也带 cssRules（CSS 嵌套），
           * 若先判 cssRules，所有样式规则都会被当成"容器"跳过，
           * 命中统计恒为 0 —— 第一版就是这么写错的。 */
          if (!r.selectorText) {
            if (r.cssRules) walk(r.cssRules);
            continue;
          }
          for (const s of probeSel) {
            if (r.selectorText.indexOf(s) >= 0) {
              hits[s] = (hits[s] || 0) + 1;
              if (!hits['__sel_' + s]) hits['__sel_' + s] = [];
              if (hits['__sel_' + s].length < 4) {
                hits['__sel_' + s].push(r.selectorText.slice(0, 90) + ' { ' +
                  (r.style && r.style.cssText ? r.style.cssText.slice(0, 110) : '') + ' }');
              }
            }
          }
        }
      };
      walk(rules);
    }
    const inline = ss.ownerNode && ss.ownerNode.tagName === 'STYLE';
    out.push({
      idx: i,
      href: ss.href || null,
      inlineStyleTag: !!inline,
      media: ss.media && ss.media.mediaText || '',
      ruleCount: n,
      error: err,
      matchCounts: Object.keys(hits).filter((k) => k.indexOf('__sel_') !== 0)
        .reduce((a, k) => (a[k] = hits[k], a), {}),
      samples: Object.keys(hits).filter((k) => k.indexOf('__sel_') === 0)
        .reduce((a, k) => { a[k.replace('__sel_', '')] = hits[k]; return a; }, {})
    });
  }
  // 关键属性到底由谁给：逐条查
  const panel = document.querySelector('.location-filter-results');
  const props = {};
  if (panel) {
    const cs = getComputedStyle(panel);
    ['display', 'position', 'width', 'height', 'padding', 'borderRadius',
      'backgroundColor', 'overflowY'].forEach((p) => { props[p] = cs[p]; });
    const inline = panel.getAttribute('style') || '';
    props.inlineStyle = inline;
  }
  return {
    sheets: out,
    linkTags: [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.href),
    styleTagCount: document.querySelectorAll('style').length,
    styleTagSizes: [...document.querySelectorAll('style')].map((s) => (s.textContent || '').length),
    panelComputed: props
  };
});

console.log('=== 网络层捕获到的 CSS 响应 ===');
console.log(JSON.stringify(cssRequests, null, 1));
console.log('\n=== <link rel=stylesheet> ===');
console.log(JSON.stringify(map.linkTags, null, 1));
console.log('\n=== <style> 数量 / 体积 ===');
console.log('数量 = ' + map.styleTagCount + '  体积 = ' + JSON.stringify(map.styleTagSizes));
console.log('\n=== 逐表归属 ===');
map.sheets.forEach((s) => {
  console.log('[' + s.idx + '] ' + (s.inlineStyleTag ? '<style> 内联' : s.href)
    + '  media="' + s.media + '"  规则数=' + s.ruleCount + (s.error ? '  ERR=' + s.error : ''));
  console.log('     命中：' + JSON.stringify(s.matchCounts));
  Object.keys(s.samples).forEach((k) => {
    console.log('     样本 ' + k + '：');
    s.samples[k].forEach((x) => console.log('        ' + x));
  });
});
console.log('\n=== 面板 computed（未展开状态） ===');
console.log(JSON.stringify(map.panelComputed, null, 1));

/* —— 附加：各表是否含面板/容器/职位表的选择器 —— */
console.log('\n=== 关键选择器归属速查 ===');
const KEYS = ['.location-filter-results', '.location-filter', '.container', '.page',
  'tr.job', '#jobsboard', 'optgroup-header'];
KEYS.forEach((k) => {
  const owners = map.sheets.filter((s) => s.matchCounts[k]).map((s) =>
    (s.inlineStyleTag ? '<style>#' + s.idx : s.href));
  console.log('  ' + k.padEnd(26, ' ') + ' → ' + (owners.length ? owners.join(' | ') : '（未命中）'));
});
console.log('\n  样本摘录：');
map.sheets.forEach((s) => {
  Object.keys(s.samples).forEach((k) => {
    if (KEYS.indexOf(k) < 0) return;
    console.log('   [' + (s.inlineStyleTag ? '<style>#' + s.idx : s.href) + '] ' + k);
    s.samples[k].forEach((x) => console.log('      ' + x));
  });
});

await ctx.close();
