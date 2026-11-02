/*
 * 叠译 · 弹窗逻辑
 * ------------------------------------------------------------------
 * 弹窗不直接操作页面 DOM，一律通过消息走通：
 *   改设置 → background（写 storage）→ storage.onChanged → content 自动生效
 *   发指令 → background 转发（含「内容脚本未注入时补注入」兜底）→ content 执行
 */
'use strict';

(function () {
  const CT = window.CT;

  const el = {
    pageInfo: document.getElementById('pageInfo'),
    enabled: document.getElementById('enabled'),
    autoTranslate: document.getElementById('autoTranslate'),
    selectionEnabled: document.getElementById('selectionEnabled'),
    iframeEnabled: document.getElementById('iframeEnabled'),
    notice: document.getElementById('notice'),
    statTranslated: document.getElementById('statTranslated'),
    statLang: document.getElementById('statLang'),
    statProvider: document.getElementById('statProvider'),
    btnTranslate: document.getElementById('btnTranslate'),
    btnRestore: document.getElementById('btnRestore'),
    btnBlockSite: document.getElementById('btnBlockSite'),
    btnOptions: document.getElementById('btnOptions'),
    modeSeg: document.getElementById('modeSeg'),
    targetLang: document.getElementById('targetLang'),
    sourceLang: document.getElementById('sourceLang'),
    btnSwapLang: document.getElementById('btnSwapLang'),
    provider: document.getElementById('provider')
  };

  let tabId = null;
  let host = '';
  let settings = null;
  let pageSupported = true;
  let pollTimer = null;
  /** 最近一次 ping 回来的内容脚本状态（含它实际用的源语言） */
  let lastPing = null;
  /** 当前翻译相位，决定轮询快慢（working 时更密） */
  let pollPhase = 'done';

  /* ---------------------------------------------------------------- */

  function send(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (res) => {
        void chrome.runtime.lastError;
        resolve(res);
      });
    });
  }

  function notice(text, kind) {
    if (!text) { el.notice.hidden = true; return; }
    el.notice.textContent = text;
    el.notice.className = 'notice' + (kind ? ' notice--' + kind : '');
    el.notice.hidden = false;
  }

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

  function providerLabel(id) {
    if (!id) return '–';
    const hit = CT.PROVIDERS.find((p) => p.id === id);
    if (!hit) return id;
    if (id === 'chrome-builtin') return '本地模型';
    if (id === 'google-free') return 'Google';
    if (id === 'deepl') return 'DeepL';
    if (id === 'openai') return 'OpenAI';
    return hit.label;
  }

  /* ---------------------------------------------------------------- */
  /* 翻译方向                                                          */
  /* ---------------------------------------------------------------- */
  /* 为什么要有这一段：
   * 多语言互译下，「源语言」一栏可能是 auto —— 此时用户看到的是一个抽象选项，
   * 并不知道这一页实际被当成哪国语言。互换按钮更是无从下手：拿什么去换？
   * 所以这里把「实际生效的源语言」从内容脚本的 ping 里取回来，
   * 统计格里直接显示「英语 → 简体中文」，互换按钮也据此决定能不能点。 */

  /** 内容脚本实际在用的源语言（从未识别出 → ''） */
  function detectedLang() {
    const s = lastPing && lastPing.sourceLang;
    if (!s) return '';
    const n = CT.settings.normalizeLang(s);
    return n === 'auto' ? '' : n;
  }

  /** 生效的源语言：用户手选优先，否则用内容脚本检测出来的 */
  function effectiveSource() {
    const sel = settings && settings.sourceLang;
    if (sel && sel !== 'auto') return CT.settings.normalizeLang(sel);
    return detectedLang();
  }

  /** 把「源 → 目标」与互换按钮的可用性一次性刷新 */
  function renderDir() {
    if (!settings) return;
    const src = effectiveSource();
    const tgt = CT.settings.normalizeLang(settings.targetLang);

    if (!src) {
      el.statLang.textContent = '未检测';
      el.statLang.title = '尚未识别出页面语言';
    } else {
      // 统计格只有 ~88px 宽：短名紧贴箭头（「英语→简体中文」≈80px），
      // 完整名称留给 title —— 加空格就会被省略号吃掉后者。
      el.statLang.textContent = CT.langShort(src) + '→' + CT.langShort(tgt);
      el.statLang.title = CT.langLabel(src) + ' → ' + CT.langLabel(tgt);
    }

    const swappable = !!src && src !== tgt;
    el.btnSwapLang.disabled = !swappable;
    el.btnSwapLang.title = swappable
      ? '互换源语言与目标语言：' + CT.langShort(tgt) + ' → ' + CT.langShort(src)
      : (src ? '源语言与目标语言相同，无需互换' : '先识别出页面语言才能互换');
  }

  /* ---------------------------------------------------------------- */
  /* 初始化                                                            */
  /* ---------------------------------------------------------------- */

  async function init() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      tabId = tab.id;
      try { host = tab.url ? new URL(tab.url).hostname : ''; } catch (e) { host = ''; }
      el.pageInfo.textContent = host || tab.title || '当前页面';
    }

    const res = await send({ type: CT.MSG.GET_SETTINGS });
    if (!res || !res.ok) {
      notice('无法读取扩展设置，请重新加载扩展。', 'err');
      return;
    }
    settings = res.settings;

    fillSelect(el.sourceLang, CT.SOURCE_LANGS, settings.sourceLang);
    fillSelect(el.targetLang, CT.TARGET_LANGS, settings.targetLang);
    fillSelect(el.provider, CT.PROVIDERS, settings.provider);

    el.enabled.checked = !!settings.enabled;
    el.autoTranslate.checked = !!settings.autoTranslate;
    el.selectionEnabled.checked = settings.selectionEnabled !== false;
    el.iframeEnabled.checked = settings.iframeEnabled !== false;
    const radio = el.modeSeg.querySelector('input[value="' + settings.displayMode + '"]');
    if (radio) radio.checked = true;

    const blocked = CT.settings.isBlockedHost(host, settings.blocklist);
    el.btnBlockSite.textContent = blocked ? '恢复此站点翻译' : '此站点不再翻译';

    // 互换按钮的最终状态由 refresh() → renderDir() 定；这里只给个「还没读到页面语言」
    // 的过渡态，免得按钮在首帧看起来像是可点的。
    el.btnSwapLang.disabled = true;
    el.btnSwapLang.title = '正在读取页面语言…';

    bindEvents();
    await refresh();
    schedulePoll();
  }

  /* ---------------------------------------------------------------- */
  /* 状态刷新                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * 自适应轮询：不再固定 1.2 秒一次。
   * ------------------------------------------------------------------
   * 弹窗每轮刷新要发两条消息（向内容脚本 ping、向后台取标签页统计），
   * 而弹窗打开时绝大多数时间页面状态是静止的 —— 固定间隔等于持续空转。
   * 这里改为按相位调整：翻译进行中 800ms 一次（进度需要跟手），
   * 其余情况 4 秒一次（只是兜底，用户操作后本来就会主动刷新）。
   */
  const POLL_BUSY_MS = 800;
  const POLL_IDLE_MS = 4000;

  function schedulePoll() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (!pageSupported) return;                 // 页面不支持注入 → 不再轮询
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      const phase = await refresh();
      if (phase !== 'stopped') schedulePoll();
    }, pollPhase === 'working' ? POLL_BUSY_MS : POLL_IDLE_MS);
  }

  async function refresh() {
    if (tabId === null) return 'idle';

    const prevPhase = pollPhase;
    const ping = await send({ type: CT.MSG.SEND_COMMAND, tabId, cmd: { action: 'ping' } });

    if (ping && ping.ok && ping.stats) {
      pageSupported = true;
      lastPing = ping;
      el.statTranslated.textContent = ping.stats.translated > 0 ? String(ping.stats.translated) : '0';
      renderDir();
    } else if (ping && ping.ok === false) {
      pageSupported = false;
      pollPhase = 'stopped';
      lastPing = null;
      el.statTranslated.textContent = '不可用';
      el.statLang.textContent = '不可用';
      el.statLang.title = '';
      el.btnSwapLang.disabled = true;
      el.btnSwapLang.title = '当前页面不支持扩展注入';
      notice(ping.error || '当前页面不支持扩展注入。', 'warn');
      // 已经确定这个页面注入不了（浏览器内置页、应用商店页等），
      // 停掉轮询，别反复去撞同一面南墙。
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
      return 'stopped';
    }

    const st = await send({ type: CT.MSG.GET_TAB_STATS, tabId });
    if (st && st.ok && st.stats) {
      el.statProvider.textContent = providerLabel(st.stats.provider);
      pollPhase = st.stats.phase || 'done';
    } else {
      el.statProvider.textContent = settings && settings.provider === 'auto' ? '自动' : providerLabel(settings && settings.provider);
      pollPhase = 'done';
    }

    // 相位发生变化就立刻重排下一次轮询：
    // 否则「用户刚点翻译」之后可能要空等满一个空闲周期才切到密集轮询。
    if (pollPhase !== prevPhase && tabId !== null && pollTimer) schedulePoll();

    return pollPhase;
  }

  /* ---------------------------------------------------------------- */
  /* 事件绑定                                                          */
  /* ---------------------------------------------------------------- */

  async function patchSettings(patch, cmdAction) {
    const res = await send({ type: CT.MSG.SET_SETTINGS, patch });
    if (!res || !res.ok) { notice('设置保存失败。', 'err'); return null; }
    settings = res.settings;
    if (cmdAction && tabId !== null) {
      await send({ type: CT.MSG.SEND_COMMAND, tabId, cmd: cmdAction });
    }
    return settings;
  }

  function bindEvents() {
    el.enabled.addEventListener('change', async () => {
      await patchSettings({ enabled: el.enabled.checked }, { action: 'applySettings' });
      await refresh();
    });

    el.autoTranslate.addEventListener('change', async () => {
      await patchSettings({ autoTranslate: el.autoTranslate.checked });
    });

    /* 划词翻译：改完要下发 applySettings，否则当前页面还挂着上一个状态的
     * 划词监听（关掉之后还是会弹气泡，用户会以为开关没生效）。 */
    el.selectionEnabled.addEventListener('change', async () => {
      await patchSettings({ selectionEnabled: el.selectionEnabled.checked }, { action: 'applySettings' });
      await refresh();
    });

    /* 内嵌框架：这是**逃生舱**。某些站点用框架承载正文，也有站点用框架承载
     * 广告或客服组件；一旦发现某个站点被翻坏（框架里的译文把版面撑开），
     * 用户需要在弹窗里就能一键把框架排除掉，而不是去设置页翻三屏。 */
    el.iframeEnabled.addEventListener('change', async () => {
      await patchSettings({ iframeEnabled: el.iframeEnabled.checked }, { action: 'applySettings' });
      notice(el.iframeEnabled.checked
        ? '已开启内嵌框架翻译，重新加载页面后生效。'
        : '已排除内嵌框架，只翻译顶层文档。');
      await refresh();
    });

    el.modeSeg.addEventListener('change', async () => {
      const picked = el.modeSeg.querySelector('input[name="mode"]:checked');
      if (!picked) return;
      // 切换展示模式会撤掉已渲染译文并按新模式重画，进度条会重新走一遍
      await patchSettings({ displayMode: picked.value }, { action: 'applySettings' });
      await refresh();
    });

    el.targetLang.addEventListener('change', async () => {
      await patchSettings({ targetLang: el.targetLang.value }, { action: 'applySettings' });
      await refresh();
    });

    el.sourceLang.addEventListener('change', async () => {
      await patchSettings({ sourceLang: el.sourceLang.value }, { action: 'applySettings' });
      await refresh();
    });

    /* 互换源语言与目标语言。
     * 若源语言是「自动检测」，就拿内容脚本检测出的那个语言当源 ——
     * 这正是用户点这颗按钮时想表达的意思（「把当前方向反过来」）。
     * 代价是互换之后源语言会被钉成具体语言、不再自动跟随页面，
     * 所以互换后给一条明确的提示，别让用户以为自动检测坏了。 */
    el.btnSwapLang.addEventListener('click', async () => {
      const src = effectiveSource();
      const tgt = CT.settings.normalizeLang(settings.targetLang);
      if (!src || src === tgt) return;

      el.btnSwapLang.disabled = true;
      const next = await patchSettings(
        { sourceLang: tgt, targetLang: src },
        { action: 'applySettings' }
      );
      if (!next) { await refresh(); return; }

      if (el.sourceLang.value !== next.sourceLang) el.sourceLang.value = next.sourceLang;
      if (el.targetLang.value !== next.targetLang) el.targetLang.value = next.targetLang;

      notice('已互换：' + CT.langShort(tgt) + ' → ' + CT.langShort(src));
      await refresh();
      renderDir();
    });

    el.provider.addEventListener('change', async () => {
      await patchSettings({ provider: el.provider.value }, { action: 'applySettings' });
      await refresh();
    });

    el.btnTranslate.addEventListener('click', async () => {
      el.btnTranslate.disabled = true;
      const r = await send({ type: CT.MSG.SEND_COMMAND, tabId, cmd: { action: 'translateNow' } });
      el.btnTranslate.disabled = false;
      if (r && r.ok === false) notice(r.error, 'err');
      else notice('已开始翻译当前页面。');
      await refresh();
    });

    el.btnRestore.addEventListener('click', async () => {
      await send({ type: CT.MSG.SEND_COMMAND, tabId, cmd: { action: 'restore' } });
      notice('已还原为原文。');
      await refresh();
    });

    el.btnBlockSite.addEventListener('click', async () => {
      if (!host) return;
      const list = Array.isArray(settings.blocklist) ? settings.blocklist.slice() : [];
      const idx = list.indexOf(host);
      let msg;
      if (idx >= 0) {
        list.splice(idx, 1);
        msg = '已恢复 ' + host + ' 的翻译。';
      } else {
        list.push(host);
        msg = '已把 ' + host + ' 加入不翻译名单。';
      }
      el.btnBlockSite.textContent = idx >= 0 ? '此站点不再翻译' : '恢复此站点翻译';
      await patchSettings({ blocklist: list }, { action: 'applySettings' });
      notice(msg);
      await refresh();
    });

    el.btnOptions.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });

    window.addEventListener('unload', () => {
      if (pollTimer) clearTimeout(pollTimer);
    });
  }

  init().catch((e) => {
    notice('初始化失败：' + (e && e.message ? e.message : e), 'err');
  });
})();
