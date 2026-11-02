/*
 * 【对抗组 · R16 收紧版：抖动守卫真站复现（唯一归因）】（gate-audit-2，2026-10-16）
 * ==================================================================
 * 权威口径 = team-lead 派单；本工具按其 R16 收紧项实现：
 *   1) 6 次开合，间隔 ≥700ms（保证每次成一次 flush），**6 次 flush 全部 ≤30s 窗内**（跨度>30s 判无效）
 *   2) 归因必须唯一：被标记元素必须**落在被开合的元素上**，逐元素核对 + 与被点击元素做同一性比对
 *   3) 断言修正：**禁止** `[data-ct-skip].length>0` 这类写法；排除扩展自身的 `widget`/`ct-toggle` 标记
 *   4) 判定三条件：① 被开合元素被标记 ② 其后译文数=0 ③ 同页另一未被开合元素仍正常翻译（对照）
 * 站点：remoteok.com（职位行展开容器）+ getbootstrap.com/docs/5.3/components/collapse/（class 折叠）
 * 纪律：真点击（locator.click）、无 dispatchEvent；本地 mock 引擎、零出网；真仓只读。
 * 运行：CT_EXT_ROOT=<扩展根> NODE_PATH=<nm> node tools/probe-jitter-r16.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT = process.env.CT_EXT_ROOT || HERE;
const CHROME = process.env.CT_E2E_CHROME
  || 'C:/Users/Administrator/.workbuddy/binaries/cft/chrome-win64/chrome.exe';

const SHOT_DIR = path.join(HERE, 'adv-shots');
try { fs.mkdirSync(SHOT_DIR, { recursive: true }); } catch (e) { /* ignore */ }
async function shot(page, name) {
  const p = path.join(SHOT_DIR, name + '.png');
  await page.screenshot({ path: p, fullPage: false }).catch(() => {});
  console.log('    [shot] ' + p);
  return p;
}

/* mock 引擎（零出网） */
function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url.split('?')[0] === '/v1/chat/completions') {
      let body = ''; req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const p = JSON.parse(body);
          const user = p.messages[p.messages.length - 1].content;
          const texts = JSON.parse(user).map((x) => (typeof x === 'string' ? x : x.s));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 'm', object: 'chat.completion', created: 1, model: 'mock',
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ t: texts.map((s) => '【译】' + s) }) } }],
            usage: { prompt_tokens: 0, completion_tokens: 0 } }));
        } catch (e) { res.writeHead(500); res.end(String(e)); }
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

/* 页内：把元素转成可读选择器 */
const SEL_OF = `(function(){
  window.__ctSelOf = function(el){
    if(!el||el.nodeType!==1) return '(none)';
    if(el.id) return el.tagName.toLowerCase()+'#'+el.id;
    var parts=[], n=el, d=0;
    while(n && n.nodeType===1 && d<4){
      var s=n.tagName.toLowerCase();
      if(n.className && typeof n.className==='string'){ var c=n.className.trim().split(/\\s+/).slice(0,3).join('.'); if(c) s+='.'+c; }
      parts.unshift(s); n=n.parentElement; d++;
    }
    return parts.join('>');
  };
})()`;

/** 收集页内 data-ct-skip（排除扩展自身 widget/ct-toggle），并给出宿主选择器与"是否含目标" */
async function skipReport(page, targetSel) {
  return page.evaluate((sel) => {
    const selOf = (el) => {
      if (!el || el.nodeType !== 1) return '(none)';
      if (el.id) return el.tagName.toLowerCase() + '#' + el.id;
      const parts = []; let n = el, d = 0;
      while (n && n.nodeType === 1 && d < 4) {
        let s = n.tagName.toLowerCase();
        if (n.className && typeof n.className === 'string') {
          const c = n.className.trim().split(/\s+/).slice(0, 3).join('.');
          if (c) s += '.' + c;
        }
        parts.unshift(s); n = n.parentElement; d++;
      }
      return parts.join('>');
    };
    const target = document.querySelector(sel);
    const out = [];
    for (const el of document.querySelectorAll('[data-ct-skip]')) {
      const val = el.getAttribute('data-ct-skip');
      const isExt = el.classList && (el.classList.contains('ct-toggle') || el.classList.contains('ct-badge') || el.classList.contains('ct-trans'));
      const rel = !target ? 'no-target'
        : (el === target ? 'SAME(===target)' : (el.contains(target) ? 'ANCESTOR_OF_TARGET' : (target.contains(el) ? 'DESCENDANT_OF_TARGET' : 'UNRELATED')));
      out.push({ sel: selOf(el), val, ext: !!isExt, rel });
    }
    return out;
  }, targetSel);
}

async function attack(page, cfg, log) {
  // cfg: { triggerSel, targetSel, label }
  const { triggerSel, targetSel, label } = cfg;
  console.log('\n── ' + label + ' ──');
  console.log('  被点击 = ' + triggerSel + ' ；被开合容器 = ' + targetSel);

  const pre = await page.evaluate((sel) => {
    const t = document.querySelector(sel);
    if (!t) return { exists: false };
    const cs = getComputedStyle(t);
    return { exists: true, display: cs.display, cls: t.className,
      trans: t.querySelectorAll('.ct-trans').length };
  }, targetSel);
  console.log('  攻击前：' + JSON.stringify(pre));
  if (!pre.exists) return { ok: false, reason: 'target 不存在' };
  if (pre.trans > 0) console.log('  ⚠️ 攻击前该容器已有译文 —— 会削弱②的判定力，请留意');

  const t0 = Date.now();
  const cycle = [];
  let classToggled = 0, lastCls = pre.cls;
  const preClick = cfg.beforeEach || (async () => {});
  for (let i = 0; i < 6; i++) {
    const openT = Date.now() - t0;
    await preClick();
    await page.locator(triggerSel).click({ timeout: 10000 });
    await page.waitForTimeout(250);
    const closeT = Date.now() - t0;
    await preClick();
    await page.locator(triggerSel).click({ timeout: 10000 });
    await page.waitForTimeout(1000);
    const afterCls = await page.evaluate((s) => (document.querySelector(s) || {}).className, targetSel);
    if (afterCls !== lastCls) classToggled++;
    lastCls = afterCls;
    // 估计 flush 时刻 = 本周期最后一次点击 + 700ms 防抖
    cycle.push({ i: i + 1, openT: +(openT / 1000).toFixed(2), closeT: +(closeT / 1000).toFixed(2),
      flushEst: +((closeT + 700) / 1000).toFixed(2) });
  }
  const flushSpan = cycle[5].flushEst - cycle[0].flushEst;
  console.log('  逐周期时间戳（秒）：' + cycle.map((c) => `#${c.i}:open${c.openT}/close${c.closeT}/flush≈${c.flushEst}`).join(' '));
  console.log('  估计 flush 跨度 = ' + flushSpan.toFixed(2) + 's ；目标元素 class 实际变化次数 = ' + classToggled);
  const timingValid = flushSpan <= 30 && classToggled >= 4;
  console.log('  时序有效性 = ' + (timingValid ? '有效（≤30s 且 class 确被反复切）' : '无效/可疑（跨度>30s 或 class 未反复切换）'));

  const rep = await skipReport(page, targetSel);
  const jitterHits = rep.filter((r) => r.val === 'jitter' && !r.ext);
  const onTargetJitter = jitterHits.filter((r) => r.rel === 'SAME(===target)' || r.rel === 'ANCESTOR_OF_TARGET' || r.rel === 'DESCENDANT_OF_TARGET');
  console.log('  data-ct-skip 全量（已标 ext=扩展自身）：' + JSON.stringify(rep));
  console.log('  jitter 命中（非扩展）= ' + jitterHits.length + ' ；其中与目标相关 = ' + onTargetJitter.length);

  // 永久性：展开并**保持展开**，等 >30s（JITTER_WINDOW_MS）后读数
  await preClick();
  await page.locator(triggerSel).click({ timeout: 10000 });   // 打开并保持
  await page.waitForTimeout(33000);
  const post = await page.evaluate((sel) => {
    const t = document.querySelector(sel);
    return { display: t ? getComputedStyle(t).display : null,
      trans: t ? t.querySelectorAll('.ct-trans').length : -1,
      marked: t ? t.getAttribute('data-ct-skip') : null,
      src: t ? t.querySelectorAll('[data-ct-src]').length : -1 };
  }, targetSel);
  console.log('  展开并等待 33s 后：' + JSON.stringify(post));
  return { ok: true, timingValid, flushSpan, classToggled, jitterHits, onTargetJitter, pre, post, cycle };
}

async function main() {
  const server = await startServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-r16-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false, executablePath: CHROME, viewport: { width: 1300, height: 950 },
    args: ['--disable-extensions-except=' + ROOT, '--load-extension=' + ROOT,
      '--disable-features=DisableLoadExtensionCommandLineSwitch', '--no-first-run', '--no-default-browser-check']
  });
  try {
    let sw = null;
    for (let i = 0; i < 40 && !sw; i++) { sw = ctx.serviceWorkers().find((w) => w.url().includes('service-worker.js')) || null; if (!sw) await new Promise((r) => setTimeout(r, 250)); }
    if (!sw) throw new Error('扩展未加载');
    const extId = sw.url().split('/')[2];
    const opt = await ctx.newPage();
    await opt.goto('chrome-extension://' + extId + '/options/options.html', { waitUntil: 'domcontentloaded' });
    await opt.evaluate((patch) => new Promise((res) => { chrome.runtime.sendMessage({ type: 'ct:set-settings', patch }, (r) => res(r && r.settings ? r.settings : r)); }),
      { provider: 'openai', openaiBaseUrl: base + '/v1', openaiApiKey: 'k', openaiModel: 'mock',
        autoTranslate: true, cacheEnabled: false, selectionEnabled: false, maxUnitsPerPage: 20000 });
    await opt.close();
    console.log('ROOT(扩展包)=' + ROOT);

    /* ---------- 站点 1：getbootstrap.com collapse（class 折叠，归因最干净） ---------- */
    const bp = await ctx.newPage();
    try {
      await bp.goto('https://getbootstrap.com/docs/5.3/components/collapse/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await bp.evaluate(SEL_OF);
      await bp.waitForSelector('.ct-toggle', { timeout: 20000 });
      await bp.evaluate(() => { const h = document.querySelector('.ct-toggle'); const ok = h && h.shadowRoot.querySelector('.cbtn--ok'); if (ok) ok.click(); });
      await bp.locator('.ct-toggle button.main').click({ timeout: 6000 }).catch(() => {});
      for (let i = 0; i < 40; i++) { await bp.waitForTimeout(500); const n = await bp.evaluate(() => document.querySelectorAll('.ct-trans').length).catch(() => 0); if (n > 5) break; }
      // 选第一个 bootstrap collapse 演示：按钮 data-bs-target 指向 .collapse
      const pick = await bp.evaluate(() => {
        // 优先 bootstrap 文档里的标准 collapse 演示（id 以 collapse 开头）
        const btns = [...document.querySelectorAll('[data-bs-target^="#collapse"]')]
          .concat([...document.querySelectorAll('[data-bs-toggle="collapse"][data-bs-target]')]);
        for (const b of btns) {
          const tgt = b.getAttribute('data-bs-target');
          if (!tgt || !tgt.startsWith('#')) continue;
          const t = document.querySelector(tgt);
          if (t && (t.textContent || '').trim().length > 30 && t.querySelectorAll('.ct-trans').length === 0)
            return { trigger: '[data-bs-target="' + tgt + '"]', target: tgt };
        }
        return null;
      });
      console.log('bootstrap collapse 选取：' + JSON.stringify(pick));
      if (pick) {
        const r = await attack(bp, { triggerSel: pick.trigger, targetSel: pick.target, label: 'bootstrap collapse #1（6 周期）' }, null);
        await shot(bp, 'JITTER-R16-bootstrap');
        // 对照：同页另一个未被开合的 collapse —— 打开一次应正常翻译
        const ctl = await bp.evaluate(() => {
          const btns = [...document.querySelectorAll('[data-bs-toggle="collapse"], [data-bs-target]')];
          for (const b of btns) {
            const tgt = b.getAttribute('data-bs-target') || b.getAttribute('href');
            if (!tgt || !tgt.startsWith('#')) continue;
            const t = document.querySelector(tgt);
            if (t && (t.textContent || '').trim().length > 30 && !t.getAttribute('data-ct-skip') && t.querySelectorAll('.ct-trans').length === 0)
              return { trigger: '[data-bs-target="' + tgt + '"]', target: tgt };
          }
          return null;
        });
        if (ctl) {
          await bp.locator(ctl.trigger).click({ timeout: 8000 }).catch(() => {});
          await bp.waitForTimeout(6000);
          const cr = await bp.evaluate((s) => ({ trans: (document.querySelector(s) || { querySelectorAll: () => [] }).querySelectorAll('.ct-trans').length }), ctl.target);
          console.log('  对照（未开合过的 collapse ' + ctl.target + '）打开一次 → 译文数 = ' + cr.trans);
        } else { console.log('  对照：未找到合适的第二个 collapse'); }
        if (r && r.ok) {
          console.log('  >>> bootstrap 判定：' + ((r.onTargetJitter.length > 0 && r.post.trans === 0 && r.timingValid) ? '复现（目标被标记且永久不翻）' : '见上（未达成三条件）'));
        }
      } else { console.log('  未定位到 bootstrap collapse 演示元素'); }
    } catch (e) { console.log('bootstrap 失败：' + e.message); }

    /* ---------- 站点 2：remoteok 职位行展开容器 ---------- */
    const rp = await ctx.newPage();
    let rok = false;
    for (let a = 0; a < 4 && !rok; a++) {
      await rp.goto('https://remoteok.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      try { await rp.waitForSelector('tr.job:not(.placeholder)', { state: 'attached', timeout: 40000 }); rok = true; }
      catch (e) { await rp.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}); }
    }
    if (!rok) { console.log('remoteok 未取到职位行 → 判「未跑（站点侧）」'); }
    else {
      await rp.evaluate(SEL_OF);
      // 站点偶发营销浮层会拦截指针事件 —— 移除遮挡层（障�碍物清理，非测试对象）
      const clearOverlays = async () => {
        await rp.evaluate(() => {
          document.querySelectorAll('#premium-popup-overlay, [id*="popup-overlay"], [class*="premium-popup"]')
            .forEach((e) => e.remove());
        }).catch(() => {});
      };
      await clearOverlays();
      // 等首轮收敛
      for (let i = 0; i < 30; i++) { await rp.waitForTimeout(500); const n = await rp.evaluate(() => document.querySelectorAll('[data-ct-src]').length).catch(() => 0); if (n > 20) break; }
      await clearOverlays();
      // 找第 3 个职位行及其紧随的 expand 容器（避开页头筛选控件）
      const found = await rp.evaluate(() => {
        const rows = [...document.querySelectorAll('tr.job:not(.placeholder)')];
        for (let i = 3; i < Math.min(rows.length, 12); i++) {
          const exp = rows[i].nextElementSibling;
          if (exp && exp.classList && exp.classList.contains('expand')) {
            rows[i].id = rows[i].id || ('ctRow' + i);
            exp.id = exp.id || ('ctExp' + i);
            return { rowId: '#' + rows[i].id, expId: '#' + exp.id,
              expCls: exp.className, rowCls: rows[i].className };
          }
        }
        return null;
      });
      console.log('remoteok 选取：' + JSON.stringify(found));
      if (found) {
        const trigger = found.rowId + ' td.position';
        const r = await attack(rp, { triggerSel: trigger, targetSel: found.expId, label: 'remoteok 职位行展开容器（6 周期）', beforeEach: clearOverlays }, null).catch((e) => { console.log('  remoteok 攻击异常：' + e.message); return null; });
        await shot(rp, 'JITTER-R16-remoteok');
        if (r && r.ok) {
          console.log('  >>> remoteok 判定：' + ((r.onTargetJitter.length > 0 && r.post.trans === 0 && r.timingValid) ? '复现' : '未复现/归因不成立'));
        }
        // 条件③ 对照：同页另一个**未被开合过**的 expand 容器，展开一次应正常翻译
        const ctlIdx = await rp.evaluate(() => {
          const rows = [...document.querySelectorAll('tr.job:not(.placeholder)')];
          for (let i = 20; i < rows.length; i++) {
            const exp = rows[i].nextElementSibling;
            if (exp && exp.classList && exp.classList.contains('expand') && !exp.getAttribute('data-ct-skip')
              && exp.querySelectorAll('.ct-trans').length === 0) { exp.id = exp.id || ('ctExpCtl' + i); return { rowId: rows[i].id || (rows[i].id = 'ctRowCtl' + i), expId: exp.id }; }
          }
          return null;
        });
        if (ctlIdx) {
          await clearOverlays();
          await rp.locator('#' + ctlIdx.rowId + ' td.position').click({ timeout: 10000 }).catch(() => {});
          await rp.waitForTimeout(8000);
          const cRes = await rp.evaluate((s) => ({ trans: (document.querySelector(s) || { querySelectorAll: () => [] }).querySelectorAll('.ct-trans').length,
            marked: (document.querySelector(s) || { getAttribute: () => null }).getAttribute('data-ct-skip') }), '#' + ctlIdx.expId);
          console.log('  条件③ 对照（未开合过的 ' + ctlIdx.expId + '）展开一次 → 译文数 = ' + cRes.trans + ' marked=' + cRes.marked);
        } else { console.log('  条件③ 对照：未找到合适的第二个 expand 容器'); }
      } else { console.log('remoteok 未定位到可用的 row+expand 对'); }
    }

    console.log('\n（本工具只做逐元素归因判定，不做汇总 PASS/FAIL —— 结论由报告 §8 依三条件裁定）');
  } finally { await ctx.close(); server.close(); fs.rmSync(profile, { recursive: true, force: true }); }
}

main().catch((e) => { console.error(e); process.exit(1); });
