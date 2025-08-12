// ==UserScript==
// @name         AO3 标签预览面板 (优化版) - 稳定长按&防误触
// @namespace    http://tampermonkey.net/
// @version      2.5
// @description  AO3 标签预览面板；“仅长按模式”下点触无动作；正常滑动不被阻塞；点击遮罩可关闭；iOS 幽灵点击规避。
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
      swipeThreshold: 8,      // 手指位移阈值(px)
      scrollThreshold: 2,     // 页面滚动阈值(px)
      tapMaxDuration: 200,    // 普通模式下点按最大时长(ms)
      tapConfirmDelay: 90,    // 普通模式 touchend 后延时确认(ms)
      longPressDuration: 500, // 长按判定时间(ms)
      ignoreClickWindow: 450, // touchend 后屏蔽 click 的窗口(ms)
      animationDuration: 220,
      copyHintDuration: 1400,
      vibrationDuration: 15
    },
    panel: {
      width: '85%',
      maxWidth: '360px',
      minWidth: '280px',
      zIndex: 2147483647
    }
  };

  const state = {
    onlyLongPress: readOnlyLongPress(),
    currentTag: null,
    scrollLockY: 0,

    // 手势
    startX: 0, startY: 0, startScrollY: 0, startTime: 0,
    moved: false, intentScroll: false,
    longPressTimer: null, longPressFired: false,
    confirmTimer: null,
    ignoreClickUntil: 0
  };

  // ---------- Utils ----------
  function supportsTouch() { return 'ontouchstart' in window || (navigator && navigator.maxTouchPoints > 0); }
  function readOnlyLongPress() { try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; } }
  function writeOnlyLongPress(v){ try { localStorage.setItem(STORAGE_KEY, v ? '1' : '0'); } catch {} }
  function isTagLink(el) {
    if (!el || el.tagName !== 'A' || !el.href) return false;
    const href = el.href;
    if (href.includes('/tags/') && !href.includes('/tags/search') && !href.includes('/tags/feed') && !href.includes('/tags/new')) return true;
    if (href.includes('/works?')) {
      if (href.includes('page=') || href.includes('show=')) return false;
      const hasTag = href.includes('tag_id=') ||
        href.includes('work_search%5Btag_ids%5D%5B%5D=') ||
        href.includes('work_search%5Bfreeform_ids%5D%5B%5D=') ||
        href.includes('work_search%5Bcharacter_ids%5D%5B%5D=') ||
        href.includes('work_search%5Brelationship_ids%5D%5B%5D=') ||
        href.includes('work_search%5Bfandom_ids%5D%5B%5D=');
      const hasNonTag = href.includes('sort_column=') || href.includes('sort_direction=') ||
        href.includes('query=') || href.includes('work_search%5Bquery%5D=');
      return hasTag && !hasNonTag;
    }
    return false;
  }
  function findTagFrom(target){
    let el = target;
    while (el && el !== document) {
      if (isTagLink(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  // ---------- Styles ----------
  GM_addStyle(`
    .ao3-overlay{
      position:fixed!important; inset:0!important; background:rgba(0,0,0,.35)!important;
      z-index:${CONFIG.panel.zIndex - 1}!important; display:none!important; pointer-events:auto!important;
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
      content:"标签内容"!important; display:block!important; margin-bottom:8px!important; color:#666!important; font-size:12px!important; font-weight:600!important;
    }
    .ao3-tag-panel .button-group{ display:flex!important; gap:10px!important; margin-top:4px!important; }
    .ao3-tag-panel button{
      flex:1!important; padding:11px 16px!important; border:none!important; border-radius:8px!important; cursor:pointer!important;
      font-size:14px!important; font-weight:600!important; transition:transform .12s ease!important;
      -webkit-tap-highlight-color:rgba(0,0,0,.08)!important; touch-action:manipulation!important; min-height:40px!important;
    }
    .ao3-tag-panel .copy-btn{ background:#4a90e2!important; color:#fff!important; }
    .ao3-tag-panel .open-btn{ background:#7b68ee!important; color:#fff!important; }
    .ao3-tag-panel .copy-btn:active,.ao3-tag-panel .open-btn:active{ transform:scale(.98)!important; }
    .ao3-tag-panel .copy-hint{
      text-align:center!important; color:#4a90e2!important; font-size:13px!important; margin-top:12px!important; opacity:0!important;
      transition:opacity .25s ease!important; padding:6px 10px!important; background:#e8f0fe!important; border-radius:4px!important; font-weight:600!important;
    }
    .ao3-tag-panel .copy-hint.show{ opacity:1!important; }
  `);

  // ---------- Panel ----------
  const panel = {
    el: null, overlay: null, txt: null, copyBtn: null, openBtn: null, hint: null,
    create(){
      this.overlay = document.createElement('div');
      this.overlay.className = 'ao3-overlay';
      this.el = document.createElement('div');
      this.el.className = 'ao3-tag-panel';
      this.txt = document.createElement('div');
      this.txt.className = 'tag-content';
      const group = document.createElement('div'); group.className = 'button-group';
      this.copyBtn = document.createElement('button'); this.copyBtn.className = 'copy-btn'; this.copyBtn.textContent = '复制标签';
      this.openBtn = document.createElement('button'); this.openBtn.className = 'open-btn'; this.openBtn.textContent = '打开链接';
      this.hint = document.createElement('div'); this.hint.className = 'copy-hint'; this.hint.textContent = '已复制到剪贴板';
      group.appendChild(this.copyBtn); group.appendChild(this.openBtn);
      this.el.appendChild(this.txt); this.el.appendChild(group); this.el.appendChild(this.hint);
      document.body.appendChild(this.overlay); document.body.appendChild(this.el);

      this.overlay.addEventListener('click', () => this.hide(), { passive: true });
    },
    show(tag){
      state.currentTag = tag;
      const text = tag.textContent.trim();
      const link = tag.href;

      // 锁滚动
      state.scrollLockY = window.pageYOffset || document.documentElement.scrollTop || 0;
      document.body.style.overflow = 'hidden';
      document.body.style.position = 'fixed';
      document.body.style.width = '100%';
      document.body.style.top = `-${state.scrollLockY}px`;

      this.txt.textContent = text;
      this.copyBtn.onclick = async () => {
        try { await navigator.clipboard.writeText(text); } catch {}
        this.hint.classList.add('show');
        setTimeout(() => this.hint.classList.remove('show'), CONFIG.ui.copyHintDuration);
      };
      this.openBtn.onclick = () => { window.open(link, '_blank'); this.hide(); };

      this.overlay.classList.add('show');
      this.el.classList.add('show');
      if (navigator.vibrate) navigator.vibrate(CONFIG.ui.vibrationDuration);
    },
    hide(){
      this.el.classList.remove('show');
      this.overlay.classList.remove('show');

      // 解锁滚动
      document.body.style.overflow = '';
      document.body.style.position = '';
      document.body.style.width = '';
      const y = state.scrollLockY || 0;
      document.body.style.top = '';
      window.scrollTo(0, y);

      state.currentTag = null;
    }
  };
  panel.create();

  // ---------- Menu ----------
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand(`切换仅长按模式（当前：${state.onlyLongPress ? '开启' : '关闭'}）`, () => {
      state.onlyLongPress = !state.onlyLongPress;
      writeOnlyLongPress(state.onlyLongPress);
      alert(`仅长按模式：${state.onlyLongPress ? '已开启' : '已关闭'}`);
    });
  }

  // ---------- Events ----------
  // 捕获阶段 click 拦截：仅长按模式下一律阻止对 tag 的点击（双保险 + 阻止导航）
  document.addEventListener('click', (e) => {
    // 幽灵点击窗口内的一律拦
    if (Date.now() < state.ignoreClickUntil) { e.preventDefault(); e.stopPropagation(); return; }
    if (!state.onlyLongPress) return;
    const tag = findTagFrom(e.target);
    if (tag) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  if (supportsTouch()) {
    // 不在 touchstart 上阻止默认，避免阻塞滚动
    document.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      state.startTime = Date.now();
      state.startX = t.clientX; state.startY = t.clientY;
      state.startScrollY = window.pageYOffset || document.documentElement.scrollTop || 0;
      state.moved = false; state.intentScroll = false; state.longPressFired = false;

      if (state.onlyLongPress) {
        clearTimeout(state.longPressTimer);
        state.longPressTimer = setTimeout(() => {
          // 若仍然按住且没移动/滚动，则触发长按
          const curTouch = e.touches[0];
          if (!curTouch || state.moved || state.intentScroll) return;
          const target = document.elementFromPoint(curTouch.clientX, curTouch.clientY);
          const tag = findTagFrom(target);
          if (tag) {
            // 只有真正要开面板时才阻止默认
            e.preventDefault();
            e.stopPropagation();
            state.longPressFired = true;
            panel.show(tag);
          }
        }, CONFIG.ui.longPressDuration);
      }
    }, { passive: true, capture: true });

    document.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      const dx = Math.abs(t.clientX - state.startX);
      const dy = Math.abs(t.clientY - state.startY);
      const dScroll = Math.abs((window.pageYOffset || document.documentElement.scrollTop || 0) - state.startScrollY);
      if (dx > CONFIG.ui.swipeThreshold || dy > CONFIG.ui.swipeThreshold || dScroll > CONFIG.ui.scrollThreshold) {
        state.moved = true; state.intentScroll = true;
        clearTimeout(state.longPressTimer); state.longPressTimer = null;
      }
    }, { passive: true, capture: true });

    document.addEventListener('touchend', (e) => {
      state.ignoreClickUntil = Date.now() + CONFIG.ui.ignoreClickWindow;
      clearTimeout(state.longPressTimer); state.longPressTimer = null;

      if (state.onlyLongPress) {
        // 仅长按模式：若没触发长按，则对 tag 的短按什么都不做且阻止跳转
        if (!state.longPressFired) {
          const touch = e.changedTouches && e.changedTouches[0];
          const target = touch ? document.elementFromPoint(touch.clientX, touch.clientY) : e.target;
          const tag = findTagFrom(target);
          if (tag) { e.preventDefault(); e.stopPropagation(); }
        }
        return;
      }

      // 普通模式：严格点按判定 + 延时确认
      const duration = Date.now() - state.startTime;
      if (state.moved || state.intentScroll || duration > CONFIG.ui.tapMaxDuration) return;

      const touch = e.changedTouches && e.changedTouches[0];
      const endX = touch ? touch.clientX : 0, endY = touch ? touch.clientY : 0;
      const endTarget = touch ? document.elementFromPoint(endX, endY) : e.target;
      const endScrollY = window.pageYOffset || document.documentElement.scrollTop || 0;

      clearTimeout(state.confirmTimer);
      state.confirmTimer = setTimeout(() => {
        const afterY = window.pageYOffset || document.documentElement.scrollTop || 0;
        if (Math.abs(afterY - endScrollY) > 0) return; // 惯性滚动发生，放弃
        const tag = findTagFrom(endTarget);
        if (tag) { e.preventDefault(); e.stopPropagation(); panel.show(tag); }
      }, CONFIG.ui.tapConfirmDelay);
    }, { passive: false, capture: true });
  } else {
    // 桌面端：普通模式点击开面板；仅长按模式下点击无动作
    document.addEventListener('click', (e) => {
      if (Date.now() < state.ignoreClickUntil) { e.preventDefault(); e.stopPropagation(); return; }
      const tag = findTagFrom(e.target);
      if (!tag) return;
      if (state.onlyLongPress) { e.preventDefault(); e.stopPropagation(); return; }
      e.preventDefault(); e.stopPropagation(); panel.show(tag);
    }, true);
  }

  // ESC 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.currentTag) panel.hide();
  }, true);
})();
