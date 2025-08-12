// ==UserScript==
// @name         AO3 标签预览面板 (优化版) - 长按模式可切换
// @namespace    http://tampermonkey.net/
// @version      2.3
// @description  AO3 标签预览面板，iOS防误触，并可用长按模式开关点触无动作、仅长按打开。
// @author       Your Name
// @match        https://archiveofourown.org/*
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    ui: {
      swipeThreshold: 8,
      scrollThreshold: 2,
      maxTapDuration: 220,
      confirmDelay: 80,
      longPressDuration: 450 // 长按判定时间(ms)
    }
  };

  const state = {
    currentTag: null,
    scrollPosition: 0,
    isInitialized: false,
    onlyLongPress: false, // 仅长按模式
    touchStartTime: 0,
    touchStartX: 0,
    touchStartY: 0,
    scrollStartY: 0,
    moved: false,
    intentScroll: false,
    longPressTimer: null
  };

  function toggleLongPressMode() {
    state.onlyLongPress = !state.onlyLongPress;
    alert(`AO3 标签预览 - 仅长按模式: ${state.onlyLongPress ? '已开启' : '已关闭'}`);
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand("切换仅长按模式", toggleLongPressMode);
  }

  const utils = {
    supportsTouch() {
      return 'ontouchstart' in window || (navigator && navigator.maxTouchPoints > 0);
    }
  };

  const panel = {
    elements: {},
    create() {
      const overlay = document.createElement('div');
      overlay.className = 'ao3-overlay';
      const panelEl = document.createElement('div');
      panelEl.className = 'ao3-tag-panel';
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
      panelEl.appendChild(tagContent);
      panelEl.appendChild(btnGroup);
      panelEl.appendChild(copyHint);

      document.body.appendChild(overlay);
      document.body.appendChild(panelEl);

      this.elements = { panel: panelEl, overlay, tagContent, copyBtn, openBtn, copyHint };
      overlay.onclick = () => this.hide();
    },
    show(tagEl) {
      state.currentTag = tagEl;
      const tagText = tagEl.textContent.trim();
      const tagLink = tagEl.href;
      this.elements.tagContent.textContent = tagText;
      this.elements.copyBtn.onclick = () => navigator.clipboard.writeText(tagText);
      this.elements.openBtn.onclick = () => { window.open(tagLink, '_blank'); this.hide(); };
      this.elements.overlay.classList.add('show');
      this.elements.panel.classList.add('show');
    },
    hide() {
      this.elements.overlay.classList.remove('show');
      this.elements.panel.classList.remove('show');
      state.currentTag = null;
    }
  };

  const tagRecognizer = {
    isTagLink(el) {
      if (!el || el.tagName !== 'A' || !el.href) return false;
      return el.href.includes('/tags/');
    }
  };

  function tryActivate(target, e) {
    let el = target;
    while (el && el !== document) {
      if (tagRecognizer.isTagLink(el)) {
        e.preventDefault();
        e.stopPropagation();
        panel.show(el);
        return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  const eventHandler = {
    handleTouchStart(e) {
      const t = e.touches[0];
      state.touchStartTime = Date.now();
      state.touchStartX = t.clientX;
      state.touchStartY = t.clientY;
      state.scrollStartY = window.pageYOffset || 0;
      state.moved = false;
      state.intentScroll = false;

      if (state.onlyLongPress) {
        // 仅长按模式下设置长按计时器
        state.longPressTimer = setTimeout(() => {
          const touch = e.touches[0];
          const target = document.elementFromPoint(touch.clientX, touch.clientY);
          if (!state.intentScroll && !state.moved) {
            tryActivate(target, e);
          }
        }, CONFIG.ui.longPressDuration);
      }
    },
    handleTouchMove(e) {
      const t = e.touches[0];
      const dx = Math.abs(t.clientX - state.touchStartX);
      const dy = Math.abs(t.clientY - state.touchStartY);
      const dScroll = Math.abs((window.pageYOffset || 0) - state.scrollStartY);
      if (dx > CONFIG.ui.swipeThreshold || dy > CONFIG.ui.swipeThreshold || dScroll > CONFIG.ui.scrollThreshold) {
        state.moved = true;
        state.intentScroll = true;
        if (state.longPressTimer) {
          clearTimeout(state.longPressTimer);
          state.longPressTimer = null;
        }
      }
    },
    handleTouchEnd(e) {
      if (state.longPressTimer) {
        clearTimeout(state.longPressTimer);
        state.longPressTimer = null;
      }
      if (state.onlyLongPress) {
        // 仅长按模式下，短按直接不处理，不跳转
        if (!state.moved) e.preventDefault();
        return;
      }
      // 正常模式下，短按判定
      const duration = Date.now() - state.touchStartTime;
      if (!state.intentScroll && !state.moved && duration <= CONFIG.ui.maxTapDuration) {
        const touch = e.changedTouches[0];
        const target = document.elementFromPoint(touch.clientX, touch.clientY);
        tryActivate(target, e);
      }
    },
    init() {
      if (utils.supportsTouch()) {
        document.addEventListener('touchstart', this.handleTouchStart, { passive: false });
        document.addEventListener('touchmove', this.handleTouchMove, { passive: false });
        document.addEventListener('touchend', this.handleTouchEnd, { passive: false });
      } else {
        document.addEventListener('click', (e) => tryActivate(e.target, e), true);
      }
    }
  };

  function init() {
    if (state.isInitialized) return;
    panel.create();
    eventHandler.init();
    state.isInitialized = true;
  }

  init();
})();
