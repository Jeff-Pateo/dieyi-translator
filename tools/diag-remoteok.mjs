import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.CT_E2E_CHROME || 'C:/Users/Administrator/.workbuddy/binaries/cft/chrome-win64/chrome.exe';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-diag4-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false, executablePath: CHROME, viewport: { width: 1400, height: 900 },
  args: ['--no-first-run', '--no-default-browser-check']
});
const page = await ctx.newPage();
await page.goto('https://remoteok.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);

const out = await page.evaluate(() => {
  const res = [];
  for (const el of document.querySelectorAll('*')) {
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') continue; // 只找可见
    const t = el.textContent || '';
    if (t.indexOf('North America') < 0 || t.indexOf('Oceania') < 0) continue;
    if (el.children.length < 6 || el.children.length > 120) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const kids = [...el.children].slice(0, 4).map((c) => {
      const kcs = getComputedStyle(c);
      const kr = c.getBoundingClientRect();
      return { tag: c.tagName, cls: String(c.className).slice(0, 22), display: kcs.display,
        w: Math.round(kr.width), top: Math.round(kr.top),
        text: (c.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 22) };
    });
    res.push({
      tag: el.tagName, cls: String(el.className).slice(0, 34), id: el.id || '',
      display: cs.display, flexWrap: cs.flexWrap, columnCount: cs.columnCount,
      width: Math.round(r.width), height: Math.round(r.height),
      top: Math.round(r.top), left: Math.round(r.left),
      childCount: el.children.length, kids,
      childDisplayDist: (() => {
        const d = {}; for (const c of el.children) { const x = getComputedStyle(c).display; d[x] = (d[x] || 0) + 1; } return d;
      })()
    });
  }
  res.sort((a, b) => a.childCount - b.childCount);
  return { visibleCandidates: res.length, top: res.slice(0, 3) };
});
console.log(JSON.stringify(out, null, 1));
await ctx.close();
