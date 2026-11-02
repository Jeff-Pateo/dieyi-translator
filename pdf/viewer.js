/*
 * 叠译 · PDF 查看器
 * ------------------------------------------------------------------
 * 链路：DNR 把 .pdf 导航重定向到这里 → pdf.js 解析（文件不出本机）
 *      → 按坐标把文本碎片聚成行 → 批量翻译 → 在每行下方叠译文
 *
 * 两个刻意的简化（首期边界，写在代码里而不是只写文档）：
 *
 * 1) **不渲染 pdf.js 的 textLayer。**
 *    那是它的内部实现，跨大版本会变（6.x 的 TextLayer 类与旧版
 *    renderTextLayer 接口完全不同）。首期宁可不做「在译文上选中原文」，
 *    也不去绑一个随时会变的内部结构 —— 需要复制文字时，右上角有
 *    「用原生查看器打开」这个出口。译文的定位改由我们按坐标自己算。
 *
 * 2) **只做单栏。** 双栏重排需要判断「哪些行跨栏」，猜测失败会让阅读顺序
 *    整体错乱，代价远大于「不做」。pdf-layout.js 里已预留 splitColumns，
 *    等有可靠的判据再开。
 *
 * 扫描版 PDF 直接明确提示并停止 —— 绝不落回 OCR
 * （桌面版 Chrome 没有可用的 TextDetector，本地 WASM 要背 13–19MB）。
 */
import * as pdfjsLib from './vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf/vendor/pdf.worker.min.mjs');

const CT = window.CT;
const L = CT.pdfLayout;

/* ---------------- DOM ---------------- */

const $ = (id) => document.getElementById(id);

const el = {
  fileName: $('fileName'),
  btnPrev: $('btnPrev'),
  btnNext: $('btnNext'),
  pageNum: $('pageNum'),
  pageCount: $('pageCount'),
  btnZoomIn: $('btnZoomIn'),
  btnZoomOut: $('btnZoomOut'),
  zoomLabel: $('zoomLabel'),
  chkTrans: $('chkTrans'),
  btnNative: $('btnNative'),
  progress: $('progress'),
  pageWrap: $('pageWrap'),
  canvas: $('canvas'),
  transLayer: $('transLayer'),
  panel: $('panel'),
  panelTitle: $('panelTitle'),
  panelDesc: $('panelDesc'),
  panelActions: $('panelActions')
};

/* ---------------- 状态 ---------------- */

const state = {
  url: '',
  doc: null,
  pageNum: 1,
  pageCount: 0,
  scale: 1.4,
  settings: null,
  /** 当前页的译文缓存：行文本 → 译文 */
  cache: new Map(),
  rendering: false,
  /** 当前页渲染代号 —— 用户快速翻页时，旧的一轮要能识别出自己已过期 */
  token: 0,
  /** 最近一次渲染出来的行与它们的盒子，供重绘译文用 */
  lastRows: null
};

const BATCH = 40;          // 单批条数，留一点余量给 2500 字符上限
const MIN_FONT = 9;        // 译文最小字号
const FONT_RATIO = 0.62;   // 译文相对原文字高的比例

/* ---------------- 提示面板 ---------------- */

function showPanel(title, desc, kind, actions) {
  el.panelTitle.textContent = title;
  el.panelDesc.textContent = desc || '';
  el.panel.className = 'panel' + (kind ? ' ' + kind : '');
  el.panel.hidden = false;

  el.panelActions.innerHTML = '';
  if (actions && actions.length) {
    el.panelActions.hidden = false;
    actions.forEach(function (a) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = a.label;
      if (a.primary) b.className = 'primary';
      b.addEventListener('click', a.onClick);
      el.panelActions.appendChild(b);
    });
  } else {
    el.panelActions.hidden = true;
  }
}

function hidePanel() {
  el.panel.hidden = true;
  el.panelActions.innerHTML = '';
}

function showProgress(on) {
  el.progress.classList.toggle('on', !!on);
}

/**
 * 回到 Chrome 自带的 PDF 查看器。
 * ------------------------------------------------------------------
 * 这不是「退出」，是「换一种看法」—— 想看原文排版、想选中复制文字时用。
 *
 * 有个必须处理的死循环：我们注册的 DNR 规则会把所有 .pdf 导航拦到本页面，
 * 直接跳回去又会被拦回来。所以顺序必须是
 *   先请后台撤掉规则 → 确认撤掉 → 再跳
 * 跳走之后本页面销毁，后台会在该标签页开始加载时把规则恢复。
 */
async function openNative() {
  if (!state.url) return;
  try {
    await chrome.runtime.sendMessage({ type: CT.MSG.PDF_NATIVE, url: state.url });
  } catch (e) {
    // 后台没应答也照样跳 —— 大不了被拦回来看器一次，再点一次就好
  }
  location.replace(state.url);
}

/* ---------------- 设置 ---------------- */

async function loadSettings() {
  try {
    const res = await chrome.runtime.sendMessage({ type: CT.MSG.GET_SETTINGS });
    state.settings = (res && res.settings) || CT.DEFAULT_SETTINGS;
  } catch (e) {
    state.settings = CT.DEFAULT_SETTINGS;
  }
  return state.settings;
}

/* ---------------- 翻译 ---------------- */

/**
 * 批量翻译若干行。
 * 走的是与网页翻译完全相同的后台通道 —— 因此掩码保护（URL/代码/版本号）、
 * 用户术语表、译文缓存三样全部继承，一行都不用重写。
 */
async function translateLines(texts) {
  const out = new Array(texts.length).fill('');
  if (!texts.length) return out;

  const s = state.settings || CT.DEFAULT_SETTINGS;

  // 先吃掉本地缓存（同一页反复翻页时不重复请求）
  const pending = [];
  const pendingIdx = [];
  for (let i = 0; i < texts.length; i++) {
    const hit = state.cache.get(texts[i]);
    if (hit !== undefined) out[i] = hit;
    else { pending.push(texts[i]); pendingIdx.push(i); }
  }
  if (!pending.length) return out;

  for (let start = 0; start < pending.length; start += BATCH) {
    const slice = pending.slice(start, start + BATCH);
    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: CT.MSG.TRANSLATE,
        source: s.sourceLang || 'auto',
        target: s.targetLang || 'zh-CN',
        frameArea: 0,
        // ctx 给「PDF」这个线索：短标签（页眉、图注）脱离语境容易翻错，
        // 告诉 LLM 引擎它来自 PDF 文档有助于选词
        items: slice.map(function (t) { return { text: t, ctx: 'PDF 文档正文' } })
      });
    } catch (e) {
      res = null;
    }

    if (!res || !res.ok) {
      // 整批失败：这一批留空，不抛错 —— 部分页面有译文总好过整页空白
      continue;
    }

    const arr = res.translations || [];
    for (let k = 0; k < slice.length; k++) {
      const one = arr[k];
      const val = typeof one === 'string' ? one : (one && (one.text || one.t)) || '';
      if (val) {
        state.cache.set(slice[k], val);
        out[pendingIdx[start + k]] = val;
      }
    }
  }

  return out;
}

/* ---------------- 渲染 ---------------- */

async function renderPage(num) {
  if (!state.doc) return;

  const token = ++state.token;
  state.rendering = true;
  showProgress(true);

  let page;
  try {
    page = await state.doc.getPage(num);
  } catch (e) {
    showProgress(false);
    state.rendering = false;
    return;
  }
  if (token !== state.token) return;   // 用户已经翻到别页

  const viewport = page.getViewport({ scale: state.scale });

  // canvas 用设备像素比放大，文字才不会糊
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  el.canvas.width = Math.floor(viewport.width * dpr);
  el.canvas.height = Math.floor(viewport.height * dpr);
  el.canvas.style.width = Math.floor(viewport.width) + 'px';
  el.canvas.style.height = Math.floor(viewport.height) + 'px';

  // 页面容器与 canvas 同尺寸；译文层叠在上面，坐标系也就对齐了
  el.pageWrap.style.width = Math.floor(viewport.width) + 'px';
  el.pageWrap.style.height = Math.floor(viewport.height) + 'px';
  el.transLayer.style.width = Math.floor(viewport.width) + 'px';
  el.transLayer.style.height = Math.floor(viewport.height) + 'px';

  const ctx = el.canvas.getContext('2d', { alpha: false });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  try {
    await page.render({ canvasContext: ctx, viewport: viewport }).promise;
  } catch (e) {
    // 渲染被取消（翻页太快）是正常现象，不当错误处理
    showProgress(false);
    state.rendering = false;
    return;
  }

  if (token !== state.token) return;

  el.pageWrap.hidden = false;
  el.transLayer.innerHTML = '';

  // ---- 提取文本并聚行 ----
  let rows = [];
  let scanned = false;
  try {
    const content = await page.getTextContent();
    scanned = L.isScanned(content);
    if (!scanned) rows = L.clusterIntoLines(content.items);
  } catch (e) {
    rows = [];
  }

  if (token !== state.token) return;

  if (scanned) {
    state.lastRows = null;
    showProgress(false);
    state.rendering = false;
    showPanel(
      '这是扫描件，没有文本层',
      '这一份 PDF 的每一页都是图片，没有可提取的文字，因此无法做对照翻译。' +
      '（本扩展不内置 OCR：桌面版 Chrome 目前没有可用的文字识别接口，' +
      '本地识别又要额外下载十几兆的模型。）',
      'warn',
      [{ label: '用原生查看器打开', onClick: openNative, primary: true }]
    );
    return;
  }

  if (!rows.length) {
    state.lastRows = null;
    showProgress(false);
    state.rendering = false;
    hidePanel();
    return;
  }

  // ---- 计算每行的盒子（在 canvas 坐标系里）----
  const boxes = rows.map(function (r) { return L.lineBox(r, viewport.transform); });

  // 只翻「值得翻」的行；同时跳过纯数字页眉、页码这类
  const targets = [];
  const targetIdx = [];
  rows.forEach(function (r, i) {
    if (!L.isTranslatableLine(r.text, 2)) return;
    targets.push(r.text);
    targetIdx.push(i);
  });

  state.lastRows = { rows: rows, boxes: boxes, viewport: viewport };

  if (state.settings && state.settings.enabled === false) {
    showProgress(false);
    state.rendering = false;
    hidePanel();
    return;
  }

  // ---- 翻译 ----
  let texts = [];
  try {
    texts = await translateLines(targets);
  } catch (e) {
    texts = [];
  }

  if (token !== state.token) return;

  showProgress(false);
  state.rendering = false;
  hidePanel();

  if (el.chkTrans.checked) {
    paintTranslations(rows, boxes, targetIdx, texts);
  }
}

/**
 * 把译文逐行叠到原文下方。
 * ------------------------------------------------------------------
 * 位置算法：取该行的外接盒，译文放在盒子底部再往下一点。
 * 字号取原文字高的 0.62 倍并设 9px 下限 —— 太小读不了，太大盖住下一行。
 *
 * 诚实说明一个固有代价：PDF 的行间距是固定的，放不下就必然与相邻行重叠。
 * 所以译文块带半透明底色 + 左侧色条，保证重叠时仍然可读；
 * 不想看时把工具栏的「双语对照」关掉即可。
 */
function paintTranslations(rows, boxes, targetIdx, texts) {
  el.transLayer.innerHTML = '';
  const width = parseInt(el.transLayer.style.width, 10) || 0;

  for (let k = 0; k < targetIdx.length; k++) {
    const i = targetIdx[k];
    const text = texts[k];
    const box = boxes[i];
    if (!text || !box) continue;

    const d = document.createElement('div');
    d.className = 'tr';
    d.textContent = text;

    const fs = Math.max(MIN_FONT, Math.round(box.fontSize * FONT_RATIO));
    d.style.fontSize = fs + 'px';
    d.style.left = Math.max(0, Math.round(box.left)) + 'px';
    // 压在行底：+0.8 个字高，让它骑在行间空白上而不是盖住本行文字
    d.style.top = Math.round(box.top + box.height * 0.8) + 'px';
    // 宽度取行宽与最小可读宽度里较大的那个（短行的译文换行太频繁）
    d.style.width = Math.max(120, Math.min(Math.round(box.width) + 24, width - box.left - 8)) + 'px';

    el.transLayer.appendChild(d);
  }
}

/** 只重绘译文（不重新渲染 canvas），用于切换「双语对照」开关 */
function repaint() {
  const last = state.lastRows;
  if (!last) return;
  if (!el.chkTrans.checked) { el.transLayer.innerHTML = ''; return; }

  // 从缓存里取译文重新画一遍 —— 缓存里没有的行就是上一轮没翻成功的
  const texts = last.rows.map(function (r) { return state.cache.get(r.text) || ''; });
  const targetIdx = [];
  const targetTexts = [];
  last.rows.forEach(function (r, i) {
    if (!L.isTranslatableLine(r.text, 2)) return;
    targetIdx.push(i);
    targetTexts.push(texts[i]);
  });
  paintTranslations(last.rows, last.boxes, targetIdx, targetTexts);
}

/* ---------------- 导航 ---------------- */

function goto(num) {
  if (!state.doc) return;
  const n = Math.min(Math.max(1, num | 0), state.pageCount || 1);
  state.pageNum = n;
  el.pageNum.value = String(n);
  el.btnPrev.disabled = n <= 1;
  el.btnNext.disabled = n >= state.pageCount;
  el.transLayer.innerHTML = '';
  renderPage(n);
}

function setScale(next) {
  state.scale = Math.min(3, Math.max(0.5, Math.round(next * 100) / 100));
  el.zoomLabel.textContent = Math.round(state.scale / 1.4 * 100) + '%';
  state.cache.clear();          // 排版变了，行也跟着变，缓存的行文本不再对应
  renderPage(state.pageNum);
}

/* ---------------- 启动 ---------------- */

async function boot() {
  await loadSettings();

  el.zoomLabel.textContent = Math.round(state.scale / 1.4 * 100) + '%';

  const url = CT.pdfRules.parseFileParam(location.search);
  state.url = url;

  if (!url) {
    showPanel(
      '没有拿到 PDF 地址',
      '这个页面需要从 PDF 链接进入。你可以直接在地址栏打开一个 .pdf 链接，' +
      '或者从书签 / 历史记录里重新点开。',
      'warn',
      [{ label: '打开设置页', onClick: function () { chrome.runtime.openOptionsPage(); } }]
    );
    return;
  }

  el.fileName.textContent = decodeURIComponent(url.split('/').pop().split('?')[0] || 'PDF');
  el.fileName.title = url;

  showProgress(true);

  let doc;
  try {
    // 扩展页面带 host_permissions 时不受 CORS 限制，但**带 Cookie 的跨站 PDF
    // 仍可能受 SameSite 限制**而取不到（比如银行账单、付费论文）。
    // 这种情况必须明确告诉用户，而不是转圈或空白。
    const task = pdfjsLib.getDocument({
      url: url,
      withCredentials: true,
      // 缺字体时不要让整份文档加载失败 —— 缺字只是观感问题
      disableFontFace: false,
      isEvalSupported: false
    });
    doc = await task.promise;
  } catch (e) {
    showProgress(false);
    const msg = String((e && e.message) || e);
    const isAuth = /403|401|Missing|Unauthorized|Forbidden/i.test(msg);
    showPanel(
      isAuth ? '这份 PDF 取不到内容' : 'PDF 加载失败',
      isAuth
        ? '它可能需要登录或带有访问限制。出于隐私考虑，扩展不会带上你的登录状态去重新下载它。' +
          '你可以用浏览器自带的查看器打开它。'
        : '解析时出了点问题：' + msg.slice(0, 200),
      'err',
      [{ label: '用原生查看器打开', onClick: openNative, primary: true }]
    );
    return;
  }

  state.doc = doc;
  state.pageCount = doc.numPages;
  el.pageCount.textContent = String(doc.numPages);
  el.pageNum.max = String(doc.numPages);
  el.pageWrap.hidden = false;
  hidePanel();
  showProgress(false);

  goto(1);
}

/* ---------------- 事件 ---------------- */

el.btnPrev.addEventListener('click', function () { goto(state.pageNum - 1); });
el.btnNext.addEventListener('click', function () { goto(state.pageNum + 1); });

el.pageNum.addEventListener('change', function () {
  goto(parseInt(el.pageNum.value, 10) || 1);
});

el.btnZoomIn.addEventListener('click', function () { setScale(state.scale + 0.2); });
el.btnZoomOut.addEventListener('click', function () { setScale(state.scale - 0.2); });

el.chkTrans.addEventListener('change', repaint);

el.btnNative.addEventListener('click', openNative);

document.addEventListener('keydown', function (e) {
  if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goto(state.pageNum - 1); }
  else if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); goto(state.pageNum + 1); }
  else if (e.key === '+' || e.key === '=') { e.preventDefault(); setScale(state.scale + 0.2); }
  else if (e.key === '-') { e.preventDefault(); setScale(state.scale - 0.2); }
});

// 设置变更（比如用户换了目标语言）→ 清缓存重画，不必刷新页面
if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (!changes.settings) return;
    if (area !== 'sync' && area !== 'local') return;
    state.settings = CT.settings.merge(CT.DEFAULT_SETTINGS, changes.settings.newValue || {});
    state.cache.clear();
    renderPage(state.pageNum);
  });
}

boot().catch(function (e) {
  showProgress(false);
  showPanel('出错了', String((e && e.message) || e), 'err');
});
