// ==UserScript==
// @name         AO3 标签预览面板 (优化版) - 长按模式&iOS稳健版
// @namespace    http://tampermonkey.net/
// @version      2.4
// @description  AO3 标签预览面板；仅长按模式下点触不动作；iOS 防误触/幽灵点击；可菜单切换且持久化；点击遮罩可关闭。
// @author       Your Name
// @match        https://archiveofourown.org/*
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'ao3_tag_preview_onlyLongPress';

  const CONFIG = {
    ui: {
      // 手势阈值（iOS 友好）
      swipeThreshold: 8,      // 手指位移阈值(px)
      scrollThreshold: 2,     // 页面滚动阈值(px)
      maxTapDuration: 200,    // 非长按模式下，点按最大时长(ms)
      confirmDelay: 90,       // 非长按模式下，touchend 后延时确认(ms)
      longPressDuration: 450, // 长按判定时间(ms)
      ignoreClickWindow: 450, // touchend 后屏蔽 click 的窗口(ms)
      animationDuration: 240,
      copyHintDuration: 1600,
      vibrationDuration: 20
    },
    panel: {
      width: '85%',
      maxWidth: '360px',
      minWidth: '280px',
      zIndex: 2147483647
    }
  };

  const state = {
    currentTag: null,
    scrollPosition: 0,
    // 模式
    onlyLongPress: readOnlyLongPressFromStorage(),
    // 触摸状态
    touchStartTime: 0,
    touchStartX: 0,
    touchStartY: 0,
    scrollStartY: 0,
    moved: false,
    intentScroll: false,
    longPressTimer: null,
    longPressTriggered: false,
    pendingConfirmTimer: null,
    scrolledRecently: false,
    ignoreClickUntil: 0,
  };

  // —— 工具 —— //
  function supportsTouch() {
    return 'ontouchstart' in window || (navigator && navigator.maxTouchPoints > 0);
  }
  function readOnlyLongPressFromStorage() {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch { return false; }
  }
  function writeOnlyLongPressToStorage(v) {
    try { localStorage.setItem(STORAGE_KEY, v ? '1' : '0'); } catch {}
  }
  function safeRemove(el) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  // —— 样式 —— //
  GM_addStyle(`
    .ao3-overlay{
      position:fixed!important; inset:0!important; background:rgba(0,0,0,.35)!important;
      z-index:${CONFIG.panel.zIndex - 1}!important; display:none!important;
      -webkit-tap-highlight-color:transparent!important;
    }
    .ao3-overlay.show{ display:block!important; }
    .ao3-tag-panel{
      position:fixed!important; top:50%!important; left:50%!important; transform:translate(-50%,-50%) scale(.95)!important;
      background:#fff!important; border:1px solid #e0e0e0!important; border-radius:12px!important; padding:20px!important;
      box-shadow:0 8px 32px rgba(0,0,0,.12)!important; z-index:${CONFIG.panel.zIndex}!important;
      width:${CONFIG.panel.width}!important; max-width:${CONFIG.panel.maxWidth}!important; min-width:${CONFIG.panel.minWidth}!important;
      box-sizing:border-box!important; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif!important;
      display:none!important; opacity:0!important; transition:all ${CONFIG.ui.animationDuration}ms cubic-bezier(.4,0,.2,1)!important;
    }
    .ao3-tag-panel.show{ display:block!important; opacity:1!important; transform:translate(-50%,-50%) scale(1)!important; }
    .ao3-tag-panel .tag-content{
      background:#f8f9fa!important; border:1px solid #e9ecef!important; border-radius:8px!important; padding:16px!important; margin-bottom:16px!important;
      word-wrap:break-word!important; font-size:15px!important; line-height:1.5!important; color:#333!important; user-select:text!important;
    }
    .ao3-tag-panel .tag-content::before{
      content:"标签内容"!important; display:block!important; margin-bottom:8px!important; color:#666!important; font-size:12px!important; font-weight:600!important; letter-spacing:.3px!important;
    }
    .ao3-tag-panel .button-group{ display:flex!important; gap:10px!important; margin-top:4px!important; }
    .ao3-tag-panel button{
      flex:1!important; padding:11px 16px!important; border:none!important; border-radius:8px!important; cursor:pointer!important;
      font-size:14px!important; font-weight:600!important; transition:transform .12s ease!important;
      -webkit-tap-highlight-color:rgba(0,0,0,.08)!important; touch-action:manipulation!important; min-height:40px!important;
    }
    .ao3-tag-panel .copy-btn{ background:#4a90e2!important; color:#fff!important; }
    .ao3-tag-panel .copy-btn:active{ transform:scale(.98)!important; }
    .ao3-tag-panel .open-btn{ background:#7b68ee!important; color:#fff!important; }
    .ao3-tag-panel .open-btn:active{ transform:scale(.98)!important; }
    .ao3-tag-panel .copy-hint{
      text-align:center!important; color:#4a90e2!important; font-size:13px!important; margin-top:12px!important; opacity:0!important;
      transition:opacity .25s ease!important; padding:6px 10px!important; background:#e8f0fe!important; border-radius:4px!important; font-weight:600!important;
    }
    .ao3-tag-panel .copy-hint.show{ opacity:1!important; }
  `);

  // —— 面板 —— //
  const panel = {
    elements: {},
    create() {
      const overlay = document.createElement('div');
      overlay.className = 'ao3-overlay';

      const wrap = document.createElement('div');
      wrap.className = 'ao3-tag-panel';

      const tagContent = document.createElement('div');
      tagContent.className = 'tag-content';

      const btnGroup = document.createElement('div');
      btnGroup.className = 'button-group';

      const copyBtn = document.createElement('button');
      copyBtn.className = 'copy-btn';
      copyBtn.textContent = '复制标签';

      const openBtn = document.createElement('button');
      openBtn.className = 'open-btn';
      openBtn.textContent = '打开链接';

      const copyHint = document.createElement('div');
      copyHint.className = 'copy-hint';
      copyHint.textContent = '已复制到剪贴板';

      btnGroup.appendChild(copyBtn);
      btnGroup.appendChild(openBtn);
      wrap.appendChild(tagContent);
      wrap.appendChild(btnGroup);
      wrap.appendChild(copyHint);

      document.body.appendChild(overlay);
      document.body.appendChild(wrap);

      overlay.addEventListener('click', () => this.hide(), { passive: true });

      this.elements = { overlay, panel: wrap, tagContent, copyBtn, openBtn, copyHint };
    },
    show(tagEl) {
      state.currentTag = tagEl;
      const tagText = tagEl.textContent.trim();
      const tagLink = tagEl.href;

      // 锁定滚动（避免背景误触）
      state.scrollPosition = window.pageYOffset || document.documentElement.scrollTop || 0;
      document.body.style.overflow = 'hidden';
      document.body.style.position = 'fixed';
      document.body.style.width = '100%';
      document.body.style.top = `-${state.scrollPosition}px`;

      this.elements.tagContent.textContent = tagText;
      this.elements.copyBtn.onclick = async () => {
        try { await navigator.clipboard.writeText(tagText); } catch {}
        this.elements.copyHint.classList.add('show');
        setTimeout(() => this.elements.copyHint.classList.remove('show'), CONFIG.ui.copyHintDuration);
      };
      this.elements.openBtn.onclick = () => { window.open(tagLink, '_blank'); this.hide(); };

      this.elements.overlay.classList.add('show');
      this.elements.panel.classList.add('show');

      if (navigator.vibrate) navigator.vibrate(CONFIG.ui.vibrationDuration);
    },
    hide() {
      this.elements.panel.classList.remove('show');
      this.elements.overlay.classList.remove('show');

      // 恢复滚动
      document.body.style.overflow = '';
      document.body.style.position = '';
      document.body.style.width = '';
      const y = state.scrollPosition || 0;
      document.body.style.top = '';
      window.scrollTo(0, y);

      state.currentTag = null;
    }
  };

  // —— 标签识别 —— //
  const tagRecognizer = {
    isTagLink(el) {
      if (!el || el.tagName !== 'A' || !el.href) return false;
      // 更安全：必须含 /tags/ 且不是新建/搜索/feed
      const href = el.href;
      if (href.includes('/tags/') && !href.includes('/tags/search') && !href.includes('/tags/new') && !href.includes('/tags/feed')) {
        return true;
      }
      // 兼容 works? 的 tag 过滤链接
      if (href.includes('/works?')) {
        if (href.includes('page=') || href.includes('show=')) return false;
        const hasTagParam =
          href.includes('tag_id=') ||
          href.includes('work_search%5Btag_ids%5D%5B%5D=') ||
          href.includes('work_search%5Bfreeform_ids%5D%5B%5D=') ||
          href.includes('work_search%5Bcharacter_ids%5D%5B%5D=') ||
          href.includes('work_search%5Brelationship_ids%5D%5B%5D=') ||
          href.includes('work_search%5Bfandom_ids%5D%5B%5D=');
        const hasNonTagParam =
          href.includes('sort_column=') || href.includes('sort_direction=') ||
          href.includes('query=') || href.includes('work_search%5Bquery%5D=');
        return hasTagParam && !hasNonTagParam;
      }
      return false;
    }
  };

  function openPanelForTarget(target, evToStop) {
    let el = target;
    while (el && el !== document) {
      if (tagRecognizer.isTagLink(el)) {
        evToStop?.preventDefault?.();
        evToStop?.stopPropagation?.();
        panel.show(el);
        return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  // —— 事件 —— //
  const onTouchStart = (e) => {
    const t = e.touches[0];
    state.touchStartTime = Date.now();
    state.touchStartX = t.clientX;
    state.touchStartY = t.clientY;
    state.scrollStartY = window.pageYOffset || document.documentElement.scrollTop || 0;
    state.moved = false;
    state.intentScroll = false;
    state.longPressTriggered = false;

    // 仅长按模式：设置长按计时器（手指未移动、未滚动时才触发）
    if (state.onlyLongPress) {
      clearTimeout(state.longPressTimer);
      state.longPressTimer = setTimeout(() => {
        // finger still down?
        if (state.moved || state.intentScroll) return;
        const touch = e.touches[0];
        if (!touch) return; // 已经松手了
        const target = document.elementFromPoint(touch.clientX, touch.clientY);
        state.longPressTriggered = openPanelForTarget(target, e);
      }, CONFIG.ui.longPressDuration);
      // 阻止 iOS 长按弹选择菜单/预览（必要时）
      e.preventDefault();
    }
  };

  const onTouchMove = (e) => {
    const t = e.touches[0];
    const dx = Math.abs(t.clientX - state.touchStartX);
    const dy = Math.abs(t.clientY - state.touchStartY);
    const dScroll = Math.abs((window.pageYOffset || document.documentElement.scrollTop || 0) - state.scrollStartY);
    if (dx > CONFIG.ui.swipeThreshold || dy > CONFIG.ui.swipeThreshold || dScroll > CONFIG.ui.scrollThreshold) {
      state.moved = true;
      state.intentScroll = true;
      clearTimeout(state.longPressTimer);
      state.longPressTimer = null;
    }
  };

  const onTouchEnd = (e) => {
    // 屏蔽幽灵点击
    state.ignoreClickUntil = Date.now() + CONFIG.ui.ignoreClickWindow;

    if (state.onlyLongPress) {
      clearTimeout(state.longPressTimer);
      state.longPressTimer = null;
      // 仅长按模式：未触发长按 -> 点按不做任何事，且不跳转
      if (!state.longPressTriggered) {
        // 如果是 tag，阻止默认跳转
        let el = e.target;
        while (el && el !== document) {
          if (tagRecognizer.isTagLink(el)) {
            e.preventDefault();
            e.stopPropagation();
            break;
          }
          el = el.parentElement;
        }
      }
      return;
    }

    // 非长按模式：严格的“点按开启”判定 + 延时确认（避免惯性滚动）
    const duration = Date.now() - state.touchStartTime;
    if (state.intentScroll || state.moved || duration > CONFIG.ui.maxTapDuration) return;

    const touch = e.changedTouches && e.changedTouches[0];
    const endX = touch ? touch.clientX : 0;
    const endY = touch ? touch.clientY : 0;
    const endTarget = touch ? document.elementFromPoint(endX, endY) : e.target;
    const endScrollY = window.pageYOffset || document.documentElement.scrollTop || 0;

    clearTimeout(state.pendingConfirmTimer);
    state.pendingConfirmTimer = setTimeout(() => {
      const afterY = window.pageYOffset || document.documentElement.scrollTop || 0;
      if (Math.abs(afterY - endScrollY) > 0) return; // 期间发生滚动，取消
      openPanelForTarget(endTarget, e);
    }, CONFIG.ui.confirmDelay);
  };

  // 捕获阶段 click 拦截（双保险）：仅长按模式下，点击 tag 一律不跳转不打开
  const onClickCapture = (e) => {
    // 避免 touchend 后的幽灵点击
    if (Date.now() < state.ignoreClickUntil) {
      e.preventDefault(); e.stopPropagation(); return;
    }
    if (!state.onlyLongPress) return;
    let el = e.target;
    while (el && el !== document) {
      if (tagRecognizer.isTagLink(el)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      el = el.parentElement;
    }
  };

  // 最近滚动标记（用于一些取消判定）
  let scrollFlagTimer = null;
  const onScrollPassive = () => {
    state.scrolledRecently = true;
    clearTimeout(scrollFlagTimer);
    scrollFlagTimer = setTimeout(() => { state.scrolledRecently = false; }, 120);
  };

  // —— 菜单 —— //
  function updateMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    GM_registerMenuCommand(
      `切换仅长按模式（当前：${state.onlyLongPress ? '开启' : '关闭'}）`,
      () => {
        state.onlyLongPress = !state.onlyLongPress;
        writeOnlyLongPressToStorage(state.onlyLongPress);
        alert(`仅长按模式：${state.onlyLongPress ? '已开启' : '已关闭'}`);
      }
    );
  }

  // —— 初始化 —— //
  function init() {
    panel.create();
    updateMenu();

    window.addEventListener('scroll', onScrollPassive, { passive: true });

    if (supportsTouch()) {
      document.addEventListener('touchstart', onTouchStart, { passive: false, capture: true });
      document.addEventListener('touchmove', onTouchMove, { passive: true, capture: true });
      document.addEventListener('touchend', onTouchEnd, { passive: false, capture: true });
      document.addEventListener('click', onClickCapture, true); // 捕获阶段拦截点击
    } else {
      // 桌面端：click 打开（保持原功能）
      document.addEventListener('click', (e) => {
        // 仅长按模式下，桌面端也不让点击打开/跳转
        if (state.onlyLongPress) return onClickCapture(e);
        openPanelForTarget(e.target, e);
      }, true);
    }

    // ESC 关闭
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.currentTag) panel.hide();
    }, true);
  }

  init();
})();
