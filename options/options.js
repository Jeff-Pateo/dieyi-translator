/*
 * 叠译 · 设置页逻辑
 * ------------------------------------------------------------------
 * 表单与设置对象之间采用「声明式绑定」：给控件加 data-setting="键名" 即可，
 * 读写、类型转换、保存全都由这里统一处理，避免为新选项写重复代码。
 */
'use strict';

(function () {
  const CT = window.CT;

  let settings = null;
  let pendingPatch = {};
  let saveTimer = null;
  let stateTimer = null;
  // 最近一次读到的缓存条数，供「清空缓存」的确认文案使用（-1 = 读取失败，未知）
  let cacheEntries = 0;
  // B1（DL-36 / 方案②′，用户已批准）：**学得来源索引** —— ct.corrStats 中
  // `learned === true` 的键集合（键格式 = normKey(from) | to | tgt，与 worker 的
  // corrStatsKey 同构）。**只读 local**：不新增存储键、不给 glossary 条目加字段。
  //   · 命中 ⇒ 该「我的词典」条目为**学得** ⇒ 显示来源 pill「自动」；
  //   · 未命中（手填 / 被 pruneCorrStats 淘汰 / 已清空 corrStats）⇒ **静默不标**。
  // 口径说明（覆盖率）：标记仅为**近似** —— 依据 ct.corrStats 的存活窗口；候选被
  // 上限（STATS_MAX:200）淘汰后无法判定，按产品/详设要求**显式接受此边界**（静默
  // 不标，不猜不兜底）。**未达「探针 + 线上实测」阈值前，对外一律按「近似」表述**
  // （**不得**写「精确来源」）。
  let learnedIndex = new Set();

  const $ = (id) => document.getElementById(id);

  /* ---------------------------------------------------------------- */

  function send(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (res) => {
        void chrome.runtime.lastError;
        resolve(res);
      });
    });
  }

  function setState(text, kind) {
    const el = $('saveState');
    el.textContent = text;
    el.className = kind ? 'pill pill--' + kind : 'muted';
    el.style.fontSize = '12.5px';
    if (stateTimer) clearTimeout(stateTimer);
    if (kind) {
      stateTimer = setTimeout(() => {
        el.textContent = '—';
        el.className = 'muted';
      }, 2600);
    }
  }

  function setPill(el, text, kind) {
    el.textContent = text;
    el.hidden = false;
    el.className = 'pill' + (kind ? ' pill--' + kind : '');
  }

  /* ---------------------------------------------------------------- */
  /* 表单填充                                                          */
  /* ---------------------------------------------------------------- */

  function fillSelect(select, items, current) {
    select.innerHTML = '';
    for (const it of items) {
      const opt = document.createElement('option');
      opt.value = it.id;
      opt.textContent = it.label;
      if (it.id === current) opt.selected = true;
      select.appendChild(opt);
    }
  }

  function applyToForm() {
    fillSelect($('provider'), CT.PROVIDERS, settings.provider);
    fillSelect($('displayMode'), CT.DISPLAY_MODES, settings.displayMode);
    fillSelect($('insertMode'), CT.INSERT_MODES, settings.insertMode || 'auto');
    fillSelect($('transStyle'), CT.TRANS_STYLES, settings.transStyle || 'plain');
    fillSelect($('targetLang'), CT.TARGET_LANGS, settings.targetLang);
    fillSelect($('sourceLang'), CT.SOURCE_LANGS, settings.sourceLang);
    fillSelect($('selectionTrigger'), CT.SELECTION_TRIGGERS, settings.selectionTrigger || 'auto');

    for (const el of document.querySelectorAll('[data-setting]')) {
      const key = el.dataset.setting;
      const val = settings[key];
      if (el.type === 'checkbox') el.checked = !!val;
      else if (val !== undefined && val !== null) el.value = val;
    }

    $('blocklist').value = (settings.blocklist || []).join('\n');
    $('skipSelectors').value = (settings.skipSelectors || []).join('\n');
    $('glossary').value = formatGlossary(settings.glossary);
    renderTermBase(settings);

    updateFontSizeLabel();
    updateProviderHint();
    updateInsertHint();
    updateTransStyleHint();
    syncToggleControls();
    syncSelectionControls();
    syncSwap();
    renderShortcuts();
    renderMyDict();
    syncEngineChoice();
    syncPrivacy();

    // 升级场景：storage 里没有的新键由默认值补齐，这里回写一次保证三处一致
    $('providerHint').dataset.provider = settings.provider;
  }

  /* ---------------------------------------------------------------- */
  /* 术语表
   * ----------------------------------------------------------------
   * 界面上是一段多行文本（与「不翻译的站点」「跳过的区域」同一套交互），
   * 存储里是 [{ from, to }]。不做成「一行一个输入框 + 增删按钮」的表格，
   * 是因为术语表常常是从文档里整段粘进来的，textarea 才能一次粘完。
   * ---------------------------------------------------------------- */

  /** 文本 → 术语数组。`术语 = 译名`；右侧留空 = 保持原文不译；`#` 开头跳过 */
  function parseGlossary(text) {
    const out = [];
    for (const raw of String(text || '').split('\n')) {
      const line = raw.trim();
      if (!line || line.charAt(0) === '#') continue;
      // 先找 `=>` 再找 `=`：`a => b` 若先被 `=` 命中会切出 `a =` 这种残渣
      let idx = line.indexOf('=>');
      let skip = 2;
      if (idx < 0) { idx = line.indexOf('='); skip = 1; }
      if (idx < 0) { idx = line.indexOf('\t'); skip = 1; }

      const from = (idx < 0 ? line : line.slice(0, idx)).trim();
      const to = idx < 0 ? '' : line.slice(idx + skip).trim();
      if (from) out.push({ from: from, to: to });
    }
    return out;
  }

  /** 术语数组 → 文本（与 parseGlossary 严格互逆，保证来回一趟不变形） */
  function formatGlossary(list) {
    return (Array.isArray(list) ? list : [])
      .filter((x) => x && x.from)
      .map((x) => x.from + ' = ' + (x.to || ''))
      .join('\n');
  }

  /* ---------------------------------------------------------------- */
  /* 我的词典（C-63 · B2-1 · D3 双入口）                                */
  /* ----------------------------------------------------------------
   * settings.glossary 为唯一真源。两条入口（条目级增删改 / 进阶编辑批量）
   * 共用同一写入通道 writeGlossary()；写前统一过 auditGlossary（errors 空）
   * + capTerms 预判（capTerms 本体零改动，仅调用）。
   * 来源标签 v1 不落字段、不展示 —— glossary 条目经 parse/format 往返会
   * 剥掉未知字段（CTO §7.4），故只留视觉位。
   * ---------------------------------------------------------------- */

  /** 归一化键：复用 shared/terminology.js 的既有 normKey（未导出时降级等价实现） */
  function normKeyOf(from) {
    const api = CT.terminology;
    if (api && api._internals && api._internals.normKey) return api._internals.normKey(from);
    return String(from == null ? '' : from).trim().toLowerCase();
  }

  function glossaryOf() {
    return Array.isArray(settings && settings.glossary) ? settings.glossary : [];
  }

  /** auditGlossary 包装：未加载时降级为「无错误」 */
  function auditOf(list) {
    const api = CT.terminology;
    if (api && api.auditGlossary) return api.auditGlossary(list);
    return { errors: [], warnings: [], stats: {} };
  }

  function announceDict(text) {
    const live = $('dictLive');
    if (live) live.textContent = text;
  }

  /** 条目级删除按钮的垃圾桶图标（14px 线性、currentColor） */
  function trashIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('fill', 'currentColor');
    p.setAttribute('d', 'M6.2 1.8h3.6l.4 1H13v1.4H3V2.8h2.8l.4-1zM4 5.2h8l-.6 8.1a1.2 1.2 0 0 1-1.2 1.1H5.8a1.2 1.2 0 0 1-1.2-1.1L4 5.2zm2.3 1.6v6h1.1v-6H6.3zm2.3 0v6h1.1v-6H8.6z');
    svg.appendChild(p);
    return svg;
  }

  /**
   * B1（DL-36 方案②′）：**只读** ct.corrStats，重建「已学得」键索引。
   * 仅收 `learned === true` 的条目 ⇒ 拒绝（dismissed）不会被计入（根除假阳性）。
   * 【红线纪律】只读 —— 不做任何 local 写入、不新增存储键（本文件 local 写入面为 0）。
   * 读失败 / 键缺失 ⇒ 空索引 ⇒ 全部静默不标（不猜、不兜底）。
   */
  async function refreshLearnedIndex() {
    const next = new Set();
    try {
      if (chrome.storage && chrome.storage.local && CT.STORAGE && CT.STORAGE.CORR_STATS) {
        const r = await new Promise((res) => {
          chrome.storage.local.get(CT.STORAGE.CORR_STATS, (v) => res(v || {}));
        });
        const stats = r && r[CT.STORAGE.CORR_STATS];
        if (stats && typeof stats === 'object') {
          for (const k of Object.keys(stats)) {
            const e = stats[k];
            // ②′：以**条目内 learned 布尔**判定（非前缀反查；代方案②〞不启用）
            if (e && e.learned === true) next.add(k);
          }
        }
      }
    } catch (e) { /* 只读失败 → 空索引 */ }
    learnedIndex = next;
    renderMyDict();
  }

  /**
   * 该 (from,to) 是否判为「学得」：精确键命中（normKey(from)|to|tgt）。
   * tgt 取 CT.LEARNING.TGT（v1 恒 'zh-CN'）—— 与 worker 的 corrStatsKey 同构。
   * 命中不到（手填 / 被淘汰 / 已清空）⇒ false ⇒ 不标。
   */
  function isLearnedEntry(from, to) {
    const tgt = (CT.LEARNING && CT.LEARNING.TGT) || 'zh-CN';
    return learnedIndex.has(normKeyOf(from) + '|' + to + '|' + tgt);
  }

  /**
   * 渲染「我的词典」列表（唯一真源 settings.glossary）。条目数不设上限。
   */
  function renderMyDict() {
    const box = $('dictList');
    if (!box) return;
    const list = glossaryOf();
    box.innerHTML = '';

    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'dict-list__empty';
      li.textContent = '还没有条目。你在页面上修正译文后，这里会自动多一条。';
      box.appendChild(li);
    } else {
      list.forEach((item, idx) => {
        const from = String(item && item.from != null ? item.from : '');
        const to = String(item && item.to != null ? item.to : '');

        const li = document.createElement('li');
        li.className = 'dict-item';

        const pair = document.createElement('span');
        pair.className = 'dict-item__pair';
        const f = document.createElement('span');
        f.className = 'dict-item__from';
        f.textContent = from;
        const arrow = document.createElement('span');
        arrow.className = 'dict-item__arrow';
        arrow.textContent = '→';
        const t = document.createElement('span');
        // 译文为空 = 保持原文：右槽显示「保持原文」，不写「改」字
        t.className = to ? 'dict-item__to' : 'dict-item__keep';
        t.textContent = to || '保持原文';
        pair.appendChild(f);
        pair.appendChild(arrow);
        pair.appendChild(t);

        // 来源标记（B1 / DL-36 方案②′，用户已批准）：据 ct.corrStats 条目的
        // `learned === true` 判定 —— 学得条目显示「自动」；手填条目 / 未命中
        // （被 pruneCorrStats 淘汰 或 已清空 corrStats）保持 hidden ⇒ 静默不标。
        // 【守 CTO §7.4】来源只来自 corrStats，不给 glossary 条目加字段。
        const pill = document.createElement('span');
        pill.className = 'pill';
        pill.hidden = !isLearnedEntry(from, to);
        pill.textContent = '自动';

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'dict-item__del';
        del.setAttribute('aria-label', '删除 ' + from + ' 的条目');
        del.appendChild(trashIcon());
        del.addEventListener('click', () => deleteDictEntry(idx));

        li.appendChild(pair);
        li.appendChild(pill);
        li.appendChild(del);
        box.appendChild(li);
      });
    }
  }

  /**
   * 统一写入通道：auditGlossary（errors 空）→
   * 既有 SET_SETTINGS{patch:{glossary}} → saveSettings。
   * 两条入口（条目级 / 批量）都只走这一条路。
   */
  function writeGlossary(next, okMsg) {
    const audit = auditOf(next);
    if (audit.errors && audit.errors.length) {
      setState('没保存：' + audit.errors[0].msg, 'err');
      return false;
    }
    settings.glossary = next;
    renderMyDict();
    queueSave('glossary', next);
    if (okMsg) setState(okMsg, 'ok');
    return true;
  }

  function deleteDictEntry(idx) {
    const list = glossaryOf();
    const item = list[idx];
    if (!item) return;
    const next = list.filter((_, i) => i !== idx);
    // 先本地同步、再落盘：避免 420ms 防抖窗口内列表与设置不一致
    settings.glossary = next;
    renderMyDict();
    queueSave('glossary', next);
    announceDict('已删除 ' + String(item.from || ''));
  }

  function openDictAdd() {
    const row = $('dictAddRow');
    if (!row) return;
    row.hidden = false;
    const f = $('dictNewFrom');
    const t = $('dictNewTo');
    if (f) { f.value = ''; f.focus(); }
    if (t) t.value = '';
  }

  function closeDictAdd() {
    const row = $('dictAddRow');
    if (row) row.hidden = true;
  }

  function saveDictAdd() {
    const from = String($('dictNewFrom').value || '').trim();
    const to = String($('dictNewTo').value || '').trim();
    if (!from) { setState('请先填原文', 'err'); return; }
    // 同词去重（normKey 归一）：同名以新填为准，避免「加了没生效」
    const key = normKeyOf(from);
    const next = glossaryOf().filter((x) => normKeyOf(x && x.from) !== key);
    next.push({ from: from, to: to });
    if (writeGlossary(next, '已加入我的词典')) closeDictAdd();
  }

  /**
   * 批量 diff 计数（B-方⑤）：按 normKey(from) 归一后比对 oldMap/newMap（值 = to）。
   *   N（将覆盖/写入）= 新增条数 A + 变更条数 C
   *   M（删除）       = 仅在旧表存在的条数
   */
  function glossaryDiff(oldList, newList) {
    const oldMap = new Map();
    const newMap = new Map();
    for (const it of oldList) {
      const k = normKeyOf(it && it.from);
      if (k && !oldMap.has(k)) oldMap.set(k, String(it && it.to != null ? it.to : ''));
    }
    for (const it of newList) {
      const k = normKeyOf(it && it.from);
      if (k && !newMap.has(k)) newMap.set(k, String(it && it.to != null ? it.to : ''));
    }
    let add = 0, chg = 0, del = 0;
    for (const [k, v] of newMap) {
      if (!oldMap.has(k)) add++;
      else if (oldMap.get(k) !== v) chg++;
    }
    for (const k of oldMap.keys()) if (!newMap.has(k)) del++;
    return { N: add + chg, M: del };
  }

  /** 批量保存第一步：diff 校验 + 弹「本次将覆盖 N 条、删除 M 条」确认（不静默丢条目） */
  let pendingGlossary = null;

  function onGlossaryBatchSave() {
    const next = parseGlossary($('glossary').value);
    const audit = auditOf(next);
    if (audit.errors && audit.errors.length) {
      setState('没保存：' + audit.errors[0].msg, 'err');
      return;
    }
    const d = glossaryDiff(glossaryOf(), next);
    if (!d.N && !d.M) { setState('术语表没有变化', null); return; }
    pendingGlossary = next;
    const txt = $('dictConfirmText');
    if (txt) txt.textContent = '本次将覆盖 ' + d.N + ' 条、删除 ' + d.M + ' 条';
    const bar = $('dictConfirm');
    if (bar) bar.hidden = false;
  }

  function applyGlossaryBatch() {
    if (!pendingGlossary) return;
    const ok = writeGlossary(pendingGlossary, '术语表已保存');
    pendingGlossary = null;
    const bar = $('dictConfirm');
    if (bar) bar.hidden = true;
    if (ok) $('glossary').value = formatGlossary(glossaryOf());
  }

  function cancelGlossaryBatch() {
    pendingGlossary = null;
    const bar = $('dictConfirm');
    if (bar) bar.hidden = true;
    setState('已取消，词典未改动', null);
  }

  /* ---------------------------------------------------------------- */
  /* 翻译方式二选一（C-65 · B2-3）                                      */
  /* ----------------------------------------------------------------
   * 单一数据源 = settings.provider，与高级区 #provider 双向绑定同一字段。
   * 只读映射（B-方⑦）：chrome-builtin→更私密；google-free→更准确；
   *   auto→更私密（不写库）；deepl/openai→更准确态（不改写该值）。
   * 写值时机：仅当用户点击二选一时写 settings.provider 单字段。
   * ---------------------------------------------------------------- */

  function providerToChoice(p) {
    if (p === 'google-free' || p === 'deepl' || p === 'openai') return 'google-free';
    return 'chrome-builtin';
  }

  function syncEngineChoice() {
    const seg = $('engineChoice');
    if (!seg) return;
    const want = providerToChoice(settings && settings.provider);
    for (const r of seg.querySelectorAll('input[type="radio"]')) r.checked = (r.value === want);
  }

  function onEngineChoiceChange(e) {
    const el = e.target;
    if (!el || el.type !== 'radio' || !el.checked) return;
    // 仅在用户点击（或键盘方向键切换）时写库；加载/渲染阶段绝不写
    queueSave('provider', el.value);
    const adv = $('provider');
    if (adv) adv.value = el.value;
    updateProviderHint();
  }

  /* ---------------------------------------------------------------- */
  /* 语言对互换                                                        */
  /* ---------------------------------------------------------------- */

  function syncSwap() {
    const btn = $('btnSwapLang');
    if (!btn) return;
    const src = CT.settings.normalizeLang($('sourceLang').value);
    const tgt = CT.settings.normalizeLang($('targetLang').value);
    const ok = src !== 'auto' && src !== tgt;
    btn.disabled = !ok;
    btn.title = ok
      ? '互换：由「' + CT.langShort(src) + ' → ' + CT.langShort(tgt)
        + '」变为「' + CT.langShort(tgt) + ' → ' + CT.langShort(src) + '」'
      : (src === 'auto'
        ? '源语言是「自动检测」—— 先选定一个具体语言才能互换'
        : '源语言与目标语言相同，无需互换');
  }

  function onSwapLang() {
    const src = $('sourceLang').value;
    const tgt = $('targetLang').value;
    if (src === 'auto' || src === tgt) return;
    // 直接改 select 的 value 不会触发 change，正好 —— 避免和下面的 queueSave 重复入队
    $('sourceLang').value = tgt;
    $('targetLang').value = src;
    queueSave('sourceLang', tgt);
    queueSave('targetLang', src);
    syncSwap();
    setTimeout(refreshBuiltin, 300);
  }

  /**
   * 页内开关这几项的联动：控件整体隐藏时，它的形态与位置设置都没有意义，
   * 直接禁用比让用户改完发现没反应要好。
   */
  function syncToggleControls() {
    var visible = $('toggleVisible').checked;
    $('toggleDefaultCollapsed').disabled = !visible;
    $('btnResetTogglePos').disabled = !visible;
  }

  async function onResetTogglePos() {
    try {
      if (!chrome.storage || !chrome.storage.local) throw new Error('存储不可用');
      // 位置与收起态走独立存储键（刻意不放进 settings，
      // 否则拖一下开关就会触发所有页面重扫一遍）
      await chrome.storage.local.remove(CT.STORAGE.TOGGLE_UI);
      setState('已把页内开关恢复到默认位置', 'ok');
    } catch (e) {
      setState('重置失败：' + (e && e.message ? e.message : e), 'err');
    }
  }

  /**
   * 划词翻译这几项的联动：主开关关掉后，触发方式与长度阈值都没有意义，
   * 直接禁用比让用户改完发现没反应要好（与上面页内开关同一套做法）。
   */
  function syncSelectionControls() {
    var on = $('selectionEnabled').checked;
    for (const id of ['selectionTrigger', 'selectionMinLen', 'selectionMaxLen', 'selectionOnlyWithModifier']) {
      const el = $(id);
      if (el) el.disabled = !on;
    }
  }

  /* ---------------------------------------------------------------- */
  /* 页内自定义快捷键                                                  */
  /* ---------------------------------------------------------------- */
  /*
   * 为什么要有这一层：
   *   chrome.commands 的全局快捷键体验更好（页面不用聚焦），但 Chrome 不允许
   *   扩展程序化修改它 —— 用户只能自己去 chrome://extensions/shortcuts 改。
   *   所以这里提供第二层「页内捕获」，绑定表存在 settings.customShortcuts 里。
   *
   * 归一化一律走 CT.keymap.comboOf（与内容脚本同一份实现，见 options.html 的注释）。
   */

  /** 当前正在录制的动作 id，null 表示没有在录制 */
  let recording = null;

  /** 至少一个强修饰键。只用字母或只加 Shift 会和正常打字抢键 */
  function hasStrongModifier(combo) {
    return ['Ctrl', 'Alt', 'Meta'].some((m) => combo.split('+').indexOf(m) >= 0);
  }

  /** 返回冲突说明；无冲突返回空串 */
  function shortcutConflict(combo, exceptId) {
    if (CT.RESERVED_COMBOS.indexOf(combo) >= 0) {
      return combo + ' 已被浏览器的全局快捷键占用，换个组合';
    }
    const map = settings.customShortcuts || {};
    for (const id of Object.keys(map)) {
      if (id === exceptId || map[id] !== combo) continue;
      const act = (CT.BINDABLE_ACTIONS || []).find((x) => x.id === id);
      return combo + ' 已经分配给「' + (act ? act.label : id) + '」了';
    }
    return '';
  }

  function saveShortcut(id, combo) {
    const next = Object.assign({}, settings.customShortcuts || {});
    if (combo) next[id] = combo;
    else delete next[id];
    settings.customShortcuts = next;
    queueSave('customShortcuts', next);
    renderShortcuts();
  }

  function toggleRecord(id) {
    if (recording === id) {
      recording = null;
      renderShortcuts();
      setState('已取消录制', null);
      return;
    }
    recording = id;
    renderShortcuts();
    setState('请按下要绑定的组合键…（Esc 取消，Backspace 清除）', 'warn');
  }

  /** 录制期间在文档上捕获按键。捕获阶段 + preventDefault，避免触发页面自身行为 */
  function onRecordKeydown(e) {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();

    const id = recording;
    if (e.key === 'Escape') {
      recording = null;
      renderShortcuts();
      setState('已取消录制', null);
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      recording = null;
      saveShortcut(id, '');
      setState('已清除该动作的页内快捷键', 'ok');
      return;
    }

    const combo = CT.keymap.comboOf(e);
    if (!combo) return;   // 纯修饰键自己不构成组合，继续等

    if (!hasStrongModifier(combo)) {
      setState(combo + ' 缺少 Ctrl / Alt / Cmd，会和正常打字抢键', 'err');
      return;
    }
    const clash = shortcutConflict(combo, id);
    if (clash) { setState(clash, 'err'); return; }

    recording = null;
    saveShortcut(id, combo);
    setState('已绑定 ' + combo, 'ok');
  }

  function renderShortcuts() {
    const box = $('shortcutRows');
    if (!box) return;
    box.innerHTML = '';

    const map = settings.customShortcuts || {};

    for (const action of (CT.BINDABLE_ACTIONS || [])) {
      const combo = map[action.id];
      const isRec = recording === action.id;

      const row = document.createElement('div');
      row.className = 'row';

      const k = document.createElement('span');
      k.className = 'row__k';
      k.textContent = action.label;

      const v = document.createElement('div');
      v.className = 'row__v';

      const line = document.createElement('div');
      line.className = 'inline';

      const pill = document.createElement('span');
      pill.className = 'pill pill--mono' + (isRec ? ' pill--warn' : (combo ? '' : ' pill--warn'));
      pill.setAttribute('role', 'status');
      pill.setAttribute('aria-live', 'polite');
      pill.textContent = isRec ? '请按下组合键…' : (combo || '未设置');

      const btnRec = document.createElement('button');
      btnRec.type = 'button';
      btnRec.className = 'btn btn--sm';
      btnRec.textContent = isRec ? '取消' : '录制';
      btnRec.addEventListener('click', () => toggleRecord(action.id));

      line.appendChild(pill);
      line.appendChild(btnRec);

      if (combo && !isRec) {
        const btnClear = document.createElement('button');
        btnClear.type = 'button';
        btnClear.className = 'btn btn--sm';
        btnClear.textContent = '清除';
        btnClear.addEventListener('click', () => saveShortcut(action.id, ''));
        line.appendChild(btnClear);
      }

      v.appendChild(line);
      row.appendChild(k);
      row.appendChild(v);
      box.appendChild(row);
    }
  }

  /* ----------------------------------------------------------------
   * 内置术语基座
   * ----------------------------------------------------------------
   * 这一块的全部数据都来自 shared/terminology.js —— 域清单、条目数、
   * 治理版本号、语向过滤结果都是**现算**的，绝不在这里抄一份。
   *
   * 抄一份的代价在别处已经付过一次：content.css 与 shadow-walk 的 TRANS_CSS
   * 是两份样式，必须靠人工记得同步。凡是可以现算的，就不要复制。
   * ---------------------------------------------------------------- */

  /** 拿基座 API；未加载时降级（老版本 options.html 被缓存时会出现） */
  function termApi() {
    return (CT.terminology && CT.terminology.mergeGlossary) ? CT.terminology : null;
  }

  /**
   * 各域在当前语向下真正生效的条目数。
   * 用 mergeGlossary 的真实过滤结果来数，而不是直接数 BASE ——
   * 因为「给出译名」的条目只在匹配的语向下生效，
   * 目标语言是日语时那一批会被整批过滤掉，数字必须跟着变。
   */
  function domainCounts(targetLang) {
    const api = termApi();
    const out = {};
    if (!api) return out;
    for (const d of api.DOMAINS) {
      out[d.id] = api.mergeGlossary([], { targetLang: targetLang, domains: [d.id] }).length;
    }
    return out;
  }

  function renderTermBase(settings) {
    const box = $('termDomains');
    const api = termApi();
    if (!box) return;
    if (!api) {
      box.innerHTML = '';
      $('termBaseCount').textContent = '（基座数据未加载，请重新加载设置页）';
      return;
    }

    const target = settings.targetLang || 'zh-CN';
    const counts = domainCounts(target);
    const picked = settings.termDomains;   // null / 空数组 = 全开

    box.innerHTML = '';
    for (const d of api.DOMAINS) {
      const label = document.createElement('label');
      label.className = 'check';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = d.id;
      cb.checked = !picked || !picked.length || picked.indexOf(d.id) >= 0;
      cb.addEventListener('change', saveTermDomains);

      const span = document.createElement('span');
      span.appendChild(document.createTextNode(d.label + ' '));
      const cnt = document.createElement('span');
      cnt.className = 'domain__count';
      cnt.textContent = String(counts[d.id] || 0);
      span.appendChild(cnt);

      label.appendChild(cb);
      label.appendChild(span);
      box.appendChild(label);
    }

    // 生效条数按当前语向现算：目标语言不是中文时绝大多数条目会被过滤掉，
    // 不明说会让人以为基座坏了
    const active = api.mergeGlossary([], { targetLang: target }).length;
    $('termBaseCount').textContent = '（当前语向下生效 ' + active + ' / ' + api.BASE.length + ' 条）';
    $('termBaseVersion').textContent = '　治理版本 ' + api.VERSION + '。';

    syncTermBase();
  }

  function saveTermDomains() {
    const api = termApi();
    if (!api) return;
    const boxes = Array.prototype.slice.call($('termDomains').querySelectorAll('input[type="checkbox"]'));
    const picked = boxes.filter((b) => b.checked).map((b) => b.value);
    // 全选存空数组而不是 null：保存链路会丢弃值为 null 的补丁字段，
    // 存 null 等于「这个改动没发生」。空数组在 mergeGlossary 里与 null 同义，
    // 于是日后基座新增的域会自动纳入，而不是把用户锁死在当前这几个域上。
    queueSave('termDomains', picked.length === boxes.length ? [] : picked);
  }

  /** 基座关掉时置灰分域面板（不隐藏 —— 隐藏会让「谁让它消失的」难以归因） */
  function syncTermBase() {
    const box = $('termDomains');
    const sw = $('termBaseEnabled');
    if (!box || !sw) return;
    box.classList.toggle('is-off', !sw.checked);
  }

  function updateFontSizeLabel() {
    const v = Number($('fontSizeScale').value || 0.8);
    $('fontSizeVal').textContent = Math.round(v * 100) + '%';
  }

  const PROVIDER_HINTS = {
    auto: '推荐。优先用 Chrome 内置本地模型，检测不到时自动降级到 Google 翻译公开接口。',
    'chrome-builtin': '优先在本机处理（免费、无额度限制），首次使用需要下载语言包。中文表达略生硬。',
    'google-free': '覆盖语言最广、无需任何 Key。⚠ 非官方公开接口，仅供个人研究用途，随时可能失效或限流，商业稳定场景请使用 DeepL / OpenAI 兼容接口。',
    deepl: '中文质量最好的一档，需要 API Key。免费版每月 50 万字符。',
    openai: '可自定义翻译提示词，术语一致性最好，按 token 计费，长页面成本会明显上升。'
  };

  function updateProviderHint() {
    $('providerHint').textContent = PROVIDER_HINTS[$('provider').value] || '';
  }

  /* 插入方式说明。这一段是两种取舍的直接对照 —— 用户选错了会立刻看到
     「卡片被挤成好几列」，所以把代价写清楚，而不是只写优点。 */
  const INSERT_HINTS = {
    auto:
      '推荐。按宿主的实际排版方式自动选择插入点：普通段落追加在段内末尾；' +
      '标签行这类横向弹性容器改插到容器之后（直接追加会被平分宽度、整行被挤变形）；' +
      '内联元素用内联译文，不打断行盒。目标是「不做任何让页面上其他元素的宽度或横向位置发生变化的事」。',
    inside:
      '一律追加到原文单元内部末尾，页面里不会多出新的兄弟节点 —— ' +
      '卡片列表、表格、列表项的子项数不变，`:nth-child` 与 `p + p` 这类相邻兄弟样式也照常生效。' +
      '代价是当单元本身就是横向弹性容器时，译文会成为新的弹性项并挤掉原有子项的宽度。' +
      '留给排障与对照用。',
    sibling:
      '译文作为同级节点插到原文之后，原文元素自身的盒子绝对不变（背景、边框、内边距都原样保留）。' +
      '代价是父容器的子项数会翻倍：父容器是 flex / grid 时译文会挤成一列，' +
      '相邻兄弟选择器与 `:nth-child` 也会跟着错位。'
  };

  function updateInsertHint() {
    const el = $('insertModeHint');
    if (el) el.textContent = INSERT_HINTS[$('insertMode').value] || '';
  }

  /* 译文样式说明：装饰本身就是对页面外观的改动，所以默认关闭。 */
  const TRANS_STYLE_HINTS = {
    plain:
      '推荐。不加边框、不加背景、不加「译」标记，只把字号调小、透明度略降，颜色跟随页面本身。' +
      '对宿主页面的观感改动降到最低，深色页与彩色底上都不会糊掉。',
    accent:
      '左侧一条竖线 + 淡色「译」标记，一眼能区分原文与译文。' +
      '代价是这两样装饰本身就是对页面外观的改动 —— 在紧凑的卡片与标签上会比较显眼。'
  };

  function updateTransStyleHint() {
    const el = $('transStyleHint');
    if (el) el.textContent = TRANS_STYLE_HINTS[$('transStyle').value] || '';
  }

  /* ---------------------------------------------------------------- */
  /* 保存                                                              */
  /* ---------------------------------------------------------------- */

  function readValue(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'number' || el.type === 'range') {
      const n = Number(el.value);
      return Number.isFinite(n) ? n : undefined;
    }
    return el.value;
  }

  function queueSave(key, value) {
    pendingPatch[key] = value;
    setState('编辑中…');

    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { flush(); }, 420);
  }

  async function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const patch = pendingPatch;
    pendingPatch = {};
    if (!Object.keys(patch).length) return settings;

    const res = await send({ type: CT.MSG.SET_SETTINGS, patch });
    if (!res || !res.ok) {
      setState('保存失败', 'err');
      return settings;
    }
    settings = res.settings;
    setState('已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }), 'ok');
    return settings;
  }

  function bindForm() {
    for (const el of document.querySelectorAll('[data-setting]')) {
      const key = el.dataset.setting;
      const kind = (el.tagName === 'SELECT' || el.type === 'checkbox') ? 'change' : 'input';

      el.addEventListener(kind, () => {
        const v = readValue(el);
        if (v !== undefined) queueSave(key, v);

        if (key === 'fontSizeScale') updateFontSizeLabel();
        if (key === 'provider') updateProviderHint();
        if (key === 'insertMode') updateInsertHint();
        if (key === 'transStyle') updateTransStyleHint();
      });
    }

    const toList = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);

    $('blocklist').addEventListener('input', () => queueSave('blocklist', toList($('blocklist').value)));
    $('skipSelectors').addEventListener('input', () => queueSave('skipSelectors', toList($('skipSelectors').value)));

    /* 我的词典（C-63 · D3 双入口）：不再「输入即存」；
       批量保存走显式 diff 确认，两条入口共用 writeGlossary()。 */
    const taGlossary = $('glossary');
    if (taGlossary) taGlossary.addEventListener('input', () => {
      // 编辑文本域即视为放弃上一次未确认的批量修改
      pendingGlossary = null;
      const bar = $('dictConfirm');
      if (bar) bar.hidden = true;
    });
    const bindClick = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    bindClick('btnDictAdd', openDictAdd);
    bindClick('btnDictAddSave', saveDictAdd);
    bindClick('btnDictAddCancel', closeDictAdd);
    bindClick('btnGlossarySave', onGlossaryBatchSave);
    bindClick('btnDictConfirmApply', applyGlossaryBatch);
    bindClick('btnDictConfirmCancel', cancelGlossaryBatch);

    $('btnProbe').addEventListener('click', onProbe);
    $('btnPrepareModel').addEventListener('click', onPrepareModel);
    $('btnClearCache').addEventListener('click', onClearCache);
    $('btnResetTogglePos').addEventListener('click', onResetTogglePos);
    $('btnSwapLang').addEventListener('click', onSwapLang);

    // 通用循环负责保存，这里只补一层 UI 联动
    $('toggleVisible').addEventListener('change', syncToggleControls);
    $('selectionEnabled').addEventListener('change', syncSelectionControls);
    $('sourceLang').addEventListener('change', syncSwap);
    $('targetLang').addEventListener('change', syncSwap);

    // B2-3：二选一 ↔ settings.provider 双向绑定同一字段
    const seg = $('engineChoice');
    if (seg) seg.addEventListener('change', onEngineChoiceChange);
    // 高级区手选引擎 → 常用区二选一显示态跟随（不改写值，只刷新显示）
    $('provider').addEventListener('change', syncEngineChoice);
    // 基座开关只影响分域面板的可用态；保存由上面的通用循环负责
    $('termBaseEnabled').addEventListener('change', syncTermBase);
    // 目标语言变了 → 基座生效条数跟着变（给出译名的条目按语向过滤），
    // 必须重渲染，否则面板上会一直显示上一个语向的数字。
    //
    // 注意：这里的目标语言必须从 DOM 现读，不能直接用闭包里的 settings ——
    // settings 是 flush() 异步回写后才更新的，change 事件触发的这一刻它还是旧值，
    // 用它渲染出来的就是上一个语向的条数（数字看着没变，但其实该变）。
    $('targetLang').addEventListener('change', () => {
      if (!CT.terminology) return;
      renderTermBase(Object.assign({}, settings, { targetLang: $('targetLang').value }));
    });

    // B2 动作记录（C-68 拟）：隐私区开关与「重置匿名标识」。
    // 开关勾选 = 允许上报（telemetryOptOut=false），**语义与内联 data-setting 相反**，
    // 故不挂 data-setting，改为显式绑定 —— 否则会被通用循环把极性写反。
    const privacyCb = $('telemetryOn');
    if (privacyCb) privacyCb.addEventListener('change', onTelemetryToggle);
    const resetBtn = $('btnResetAnonId');
    if (resetBtn) resetBtn.addEventListener('click', onResetAnonId);

    // 页内快捷键录制：用捕获阶段拦下按键，避免被设置页自身的表单行为吃掉
    document.addEventListener('keydown', onRecordKeydown, true);
  }

  /* ---------------------------------------------------------------- */
  /* 隐私：匿名统计开关 + 重置匿名标识（B2 / C-68 拟）                  */
  /* ---------------------------------------------------------------- */

  function syncPrivacy() {
    const cb = $('telemetryOn');
    if (cb) cb.checked = !settings.telemetryOptOut;
    renderPrivacyState(!!settings.telemetryOptOut);
  }

  function renderPrivacyState(optOut) {
    const el = $('privacyState');
    if (!el) return;
    // 关闭后说明（文案取自变更单 §7.1，非规范；P1-E 补足：明示已清除本机匿名标识与本地汇总）
    el.textContent = optOut
      ? '已关闭。不会再上报任何统计；此前上报的是匿名汇总，无法定位到你。并已清除本机的匿名标识与本地汇总，历史数据已无法与本机关联。'
      : '';
  }

  async function onTelemetryToggle() {
    const cb = $('telemetryOn');
    if (!cb) return;
    const optOut = !cb.checked;             // 勾选 = 允许上报
    pendingPatch.telemetryOptOut = optOut;
    await flush();
    renderPrivacyState(optOut);
    if (optOut) {
      // 退出语义（契约 §4.3）：立即清空本地聚合 + 删除安装盐。
      // worker 侧 report.js 亦会在下次读到时短路；此处即时落盘，双保险。
      try {
        await chrome.storage.local.remove([CT.STORAGE.REPORT_AGG, CT.STORAGE.REPORT_SALT]);
      } catch (e) { /* 忽略：不影响开关本身 */ }
    }
  }

  async function onResetAnonId() {
    // 重置匿名标识（契约 §4.3）：删除 installSalt ⇒ worker 下次派生即生成新盐，
    // 切断历史 tok/anon 的可拼接性。
    try {
      await chrome.storage.local.remove(CT.STORAGE.REPORT_SALT);
      const el = $('privacyResetState');
      if (el) el.textContent = '已重置。本机将使用新的匿名标识。';
    } catch (e) { /* 忽略 */ }
  }

  /* ---------------------------------------------------------------- */
  /* 内置模型状态                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * 拿哪个源语言去问内置模型？
   * ------------------------------------------------------------------
   * 「内置模型是否覆盖这个语向」必须用一个**具体**语言去问。
   * 源语言是「自动检测」时退回到英语 —— 它只是个探针，
   * 不参与真正的翻译（真翻译时用的是页面上检测出的语言）。
   */
  function probeSource() {
    const s = settings && settings.sourceLang;
    return s && s !== 'auto' ? s : 'en';
  }

  async function refreshBuiltin() {
    const res = await send({
      type: CT.MSG.BUILTIN_AVAILABILITY,
      source: probeSource(),
      target: settings ? settings.targetLang : 'zh-CN'
    });

    const state = res && res.ok ? res.availability : 'unsupported';
    const map = {
      available: ['语言包已就绪，可使用', 'ok'],
      downloadable: ['需要下载语言包（点右侧按钮）', 'warn'],
      downloading: ['语言包下载中…', 'warn'],
      unavailable: ['该语向暂不支持内置模型', 'err'],
      unsupported: ['当前浏览器不支持（需 Chrome 138+）', 'err']
    };
    const [text, kind] = map[state] || map.unsupported;
    setPill($('builtinState'), text, kind);
    $('btnPrepareModel').disabled = (state === 'available' || state === 'unavailable' || state === 'unsupported');
  }

  async function onPrepareModel() {
    const btn = $('btnPrepareModel');
    btn.disabled = true;
    setPill($('builtinState'), '正在下载语言包，请稍候…', 'warn');
    const res = await send({
      type: CT.MSG.PREPARE_MODEL,
      source: probeSource(),
      target: settings ? settings.targetLang : 'zh-CN'
    });
    setPill($('builtinState'), res && res.message ? res.message : '下载结束', res && res.ok ? 'ok' : 'err');
    setTimeout(refreshBuiltin, 1200);
  }

  /* ---------------------------------------------------------------- */
  /* 引擎自检                                                          */
  /* ---------------------------------------------------------------- */

  async function onProbe() {
    const btn = $('btnProbe');
    btn.disabled = true;
    setPill($('probeResult'), '正在测试…', 'warn');

    // 先落盘，否则刚填入的 Key 还没生效
    await flush();

    const res = await send({ type: CT.MSG.PROBE_PROVIDER });
    btn.disabled = false;

    if (res && res.ok) {
      setPill($('probeResult'), '成功 · ' + res.provider + '：「' + res.translated + '」', 'ok');
    } else {
      setPill($('probeResult'), '失败：' + ((res && res.error) || '未知错误'), 'err');
    }
  }

  /* ---------------------------------------------------------------- */
  /* 缓存                                                              */
  /* ---------------------------------------------------------------- */

  function setCachePill(text, kind) {
    const el = $('cacheState');
    el.hidden = false;
    el.className = 'pill pill--mono' + (kind ? ' pill--' + kind : '');
    el.textContent = text;
  }

  async function refreshCache() {
    const res = await send({ type: CT.MSG.CACHE_STATS });
    if (!res || !res.ok) {
      cacheEntries = -1;
      setCachePill('读取失败', 'err');
      return;
    }
    const s = res.stats;
    cacheEntries = s.entries;
    // 空态要有明确结论，而不是显示「0 条 · 0.00 MB」这种需要用户自己解读的读数
    if (s.entries === 0) { setCachePill('暂无缓存'); return; }
    const mb = (s.approxBytes / 1024 / 1024).toFixed(2);
    setCachePill(s.entries.toLocaleString('zh-CN') + ' 条 · 约 ' + mb
      + ' MB（上限 ' + s.maxEntries.toLocaleString('zh-CN') + '）');
  }

  async function onClearCache() {
    // 清空缓存不可逆，且会让后续浏览重新消耗接口额度 —— 属于必须确认的破坏性操作
    if (cacheEntries === 0) { setState('当前没有缓存可清空', 'warn'); return; }
    const n = cacheEntries > 0 ? '这 ' + cacheEntries.toLocaleString('zh-CN') + ' 条' : '全部';
    const ok = window.confirm(
      '确定要清空' + n + '翻译缓存吗？\n\n'
      + '清空后这些句子的译文会被遗忘，再次浏览时需要重新请求翻译接口，'
      + '会消耗接口额度，且无法恢复。'
    );
    if (!ok) { setState('已取消', null); return; }

    const btn = $('btnClearCache');
    btn.disabled = true;
    const res = await send({ type: CT.MSG.CACHE_CLEAR });
    btn.disabled = false;
    if (res && res.ok) setState('已清空 ' + res.removed + ' 条缓存', 'ok');
    else setState('清空失败', 'err');
    refreshCache();
  }

  async function onExportSettings() {
    const res = await send({ type: CT.MSG.GET_SETTINGS });
    if (!res || !res.ok) { setState('导出失败：读不到设置', 'err'); return; }
    const blob = new Blob([JSON.stringify(res.settings, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'bilingual-helper-settings-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    setState('设置已导出', 'ok');
  }

  function onImportPick() { $('importFile').click(); }

  async function onImportFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let patch;
    try {
      patch = JSON.parse(await file.text());
    } catch (err) {
      setState('导入失败：不是有效的设置文件', 'err');
      return;
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      setState('导入失败：文件内容不是设置对象', 'err');
      return;
    }
    const res = await send({ type: CT.MSG.SET_SETTINGS, patch: patch });
    if (!res || !res.ok) { setState('导入失败：' + ((res && res.error) || '未知错误'), 'err'); return; }
    settings = res.settings;
    applyToForm();
    setState('设置已导入', 'ok');
  }

  /* ---------------------------------------------------------------- */
  /* 入口                                                              */
  /* ---------------------------------------------------------------- */

  async function init() {
    // 版本号从 manifest 现读，不在 HTML 里写死。
    // 写死的代价是每次发版都要记得改，漏一次页脚就会长期显示错误版本。
    const verEl = $('versionLabel');
    if (verEl) {
      try {
        verEl.textContent = '叠译 v' + chrome.runtime.getManifest().version;
      } catch (e) {
        verEl.textContent = '叠译';
      }
    }

    if (new URLSearchParams(location.search).get('welcome')) {
      $('welcome').hidden = false;
    }

    const res = await send({ type: CT.MSG.GET_SETTINGS });
    if (!res || !res.ok) {
      setState('无法读取设置，请重新加载扩展', 'err');
      return;
    }
    settings = res.settings;

    applyToForm();
    bindForm();
    // B1（DL-36 方案②′）：只读 ct.corrStats 建「已学得」索引（异步）→
    // 命中后在 renderMyDict 内点亮来源 pill「自动」（未命中静默不标）。
    refreshLearnedIndex();
    refreshCache();
    refreshBuiltin();

    $('btnExportSettings').addEventListener('click', onExportSettings);
    $('btnImportSettings').addEventListener('click', onImportPick);
    $('importFile').addEventListener('change', onImportFile);

    // 语向变了，内置模型的支持情况与所需语言包都会变，需要重查
    $('targetLang').addEventListener('change', () => setTimeout(refreshBuiltin, 300));
    $('sourceLang').addEventListener('change', () => setTimeout(refreshBuiltin, 300));
  }

  init().catch((e) => setState('初始化失败：' + (e && e.message ? e.message : e), 'err'));
})();
