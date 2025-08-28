// ==UserScript==
// @name         AO3 优化脚本 (移动端/桌面端) - 持久化版
// @namespace    http://tampermonkey.net/
// @version      2.7
// @description  优化AO3阅读和浏览体验：移动端阅读字号放大；在所有作品列表页高亮字数和Kudos并移到标题旁（字数以“万”为单位）；通过菜单项管理关键词屏蔽，屏蔽词使用 GM/cookie/localStorage 多重持久化，避免被站点清理误删。
// @author       Gemini (patched)
// @match        https://archiveofourown.org/*
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  /** -----------------------------
   *  SafeStore：屏蔽词的安全持久化
   *  优先 GM_* → 退到 cookie（不会被你那条清理书签删除）→ 再退 localStorage
   *  ----------------------------- */
  const AO3_KEY = 'ao3-block-keywords';

  const SafeStore = (() => {
    const hasGM = typeof GM_setValue === 'function' && typeof GM_getValue === 'function';

    function getCookie(name) {
      const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()\\[\\]\\\\/+^])/g, '\\$1') + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : '';
    }
    function setCookie(name, value, days = 3650) { // 10 年
      try {
        const exp = new Date(Date.now() + days * 864e5).toUTCString();
        document.cookie = `${name}=${encodeURIComponent(value)}; expires=${exp}; path=/; SameSite=Lax`;
      } catch { /* iOS 某些场景可能限制写 cookie（很少见） */ }
    }
    function delCookie(name) {
      try { document.cookie = `${name}=; Max-Age=0; path=/; SameSite=Lax`; } catch {}
    }

    return {
      get() {
        if (hasGM) return String(GM_getValue(AO3_KEY, '') || '');
        // localStorage 先试；若被禁用/爆配额，则回退 cookie
        try {
          const v = localStorage.getItem(AO3_KEY);
          if (v != null) return v;
        } catch {}
        return getCookie(AO3_KEY) || '';
      },
      set(v) {
        if (hasGM) { GM_setValue(AO3_KEY, v); }
        else {
          let wroteLS = false;
          try { localStorage.setItem(AO3_KEY, v); wroteLS = true; } catch { /* Quota 或禁用 */ }
          if (!wroteLS) setCookie(AO3_KEY, v); // localStorage 不可写时用 cookie
        }
        // 冗余一份到 cookie，避免未来再次清站点数据导致丢失
        setCookie(AO3_KEY, v);
      },
      remove() {
        if (hasGM && typeof GM_deleteValue === 'function') GM_deleteValue(AO3_KEY);
        try { localStorage.removeItem(AO3_KEY); } catch {}
        delCookie(AO3_KEY);
      }
    };
  })();

  /** --------------------------------------
   * 功能 1：移动端阅读字体优化（<=768px）
   * -------------------------------------- */
  GM_addStyle(`
    @media screen and (max-width: 768px) {
      div#workskin .userstuff {
        font-size: 130% !important;
        line-height: 1.8 !important;
      }
    }
  `);

  /** ----------------------------------------------------
   * 功能 2：在作品列表页把字数/Kudos 高亮并移到标题旁
   * ---------------------------------------------------- */
  const works = document.querySelectorAll('li.work.blurb, li.bookmark.blurb');
  if (works.length > 0) {
    GM_addStyle(`
      .stat-highlight {
        background-color: #ffe45e !important;
        color: #333 !important;
        font-weight: bold !important;
        padding: 3px 8px !important;
        border-radius: 5px !important;
        border: 1px solid #d4af37 !important;
        display: inline-block !important;
        margin-left: 8px;
        font-size: 0.9em;
        vertical-align: middle;
        white-space: nowrap;
      }
      dl.stats dt.words, dl.stats dd.words,
      dl.stats dt.kudos, dl.stats dd.kudos {
        display: none !important;
      }
    `);

    works.forEach(work => {
      const titleHeading = work.querySelector('h4.heading');
      if (!titleHeading || titleHeading.querySelector('.stat-highlight')) return;

      // 字数
      const wordsElement = work.querySelector('dd.words');
      if (wordsElement) {
        const wordsText = wordsElement.textContent.trim().replace(/,/g, '');
        const wordsCount = parseInt(wordsText, 10);
        if (!Number.isNaN(wordsCount)) {
          const wordsInWan = (wordsCount / 10000).toFixed(1);
          const newWordsSpan = document.createElement('span');
          newWordsSpan.textContent = `${wordsInWan}万`;
          newWordsSpan.classList.add('stat-highlight');
          titleHeading.appendChild(newWordsSpan);
        }
      }

      // Kudos
      const kudosElement = work.querySelector('dd.kudos');
      if (kudosElement) {
        const kudosText = kudosElement.textContent.trim();
        const newKudosSpan = document.createElement('span');
        newKudosSpan.textContent = `❤️ ${kudosText}`;
        newKudosSpan.classList.add('stat-highlight');
        titleHeading.appendChild(newKudosSpan);
      }
    });
  }

  /** ------------------------------------------------
   * 功能 3：关键词屏蔽（弹窗 + 菜单 + 导出/导入）
   * ------------------------------------------------ */
  (function buildKeywordPanel() {
    // 样式
    GM_addStyle(`
      .ao3-modal-overlay {
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.6); z-index: 10000;
        display: none; align-items: center; justify-content: center;
      }
      .ao3-modal-overlay.show { display: flex; }
      .ao3-modal {
        background: #fff; border-radius: 8px; width: 90%; max-width: 500px;
        max-height: 90vh; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        font-family: -apple-system,BlinkMacSystemFont,'Segoe UI','Roboto',sans-serif;
      }
      .ao3-modal-header { padding: 24px 28px 16px; border-bottom: 1px solid #e5e7eb; position: relative; }
      .ao3-modal-title { margin: 0; font-size: 20px; font-weight: 600; color: #111827; line-height: 1.3; }
      .ao3-modal-close {
        position: absolute; right: 20px; top: 20px; width: 32px; height: 32px;
        border: none; background: #f3f4f6; border-radius: 8px; display: flex; align-items: center; justify-content: center;
        cursor: pointer; color: #6b7280; font-size: 16px;
      }
      .ao3-modal-close:hover { background: #e5e7eb; color: #374151; }
      .ao3-modal-body { padding: 24px 28px; }
      .ao3-input-group { margin-bottom: 20px; }
      .ao3-input-label { display: block; font-size: 14px; font-weight: 500; color: #374151; margin-bottom: 8px; }
      .ao3-textarea {
        width: 100%; min-height: 100px; padding: 12px 16px; border: 2px solid #e5e7eb; border-radius: 8px;
        font-size: 14px; font-family: inherit; resize: vertical; box-sizing: border-box; transition: border-color .2s, box-shadow .2s;
        background: #fafafa;
      }
      .ao3-textarea:focus { outline: none; border-color: #3b82f6; background: #fff; box-shadow: 0 0 0 3px rgba(59,130,246,.1); }
      .ao3-input-hint { font-size: 12px; color: #6b7280; margin-top: 6px; }
      .ao3-modal-footer {
        padding: 16px 28px 24px; display: flex; justify-content: flex-end; gap: 12px; border-top: 1px solid #e5e7eb; background: #fafafa;
      }
      .ao3-btn { padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 500; border: 1px solid; cursor: pointer; }
      .ao3-btn:focus { outline: none; box-shadow: 0 0 0 3px rgba(59,130,246,.1); }
      .ao3-btn-secondary { background: #fff; border-color: #d1d5db; color: #374151; }
      .ao3-btn-secondary:hover { background: #f9fafb; border-color: #9ca3af; }
      .ao3-btn-danger { background: #fff; border-color: #fca5a5; color: #dc2626; }
      .ao3-btn-danger:hover { background: #fef2f2; border-color: #f87171; }
      .ao3-btn-primary { background: #3b82f6; border-color: #3b82f6; color: #fff; }
      .ao3-btn-primary:hover { background: #2563eb; border-color: #2563eb; }
      @media (max-width: 640px) {
        .ao3-modal { width: 95%; margin: 20px; }
        .ao3-modal-header, .ao3-modal-body { padding-left: 20px; padding-right: 20px; }
        .ao3-modal-footer { padding: 16px 20px 20px; flex-wrap: wrap; }
        .ao3-btn { flex: 1; min-width: 80px; }
      }
    `);

    // DOM
    const overlay = document.createElement('div');
    overlay.className = 'ao3-modal-overlay';
    overlay.innerHTML = `
      <div class="ao3-modal">
        <div class="ao3-modal-header">
          <h3 class="ao3-modal-title">🚫 关键词屏蔽设置</h3>
          <button class="ao3-modal-close" type="button">✕</button>
        </div>
        <div class="ao3-modal-body">
          <div class="ao3-input-group">
            <label class="ao3-input-label" for="ao3-keywords-input">屏蔽关键词</label>
            <textarea id="ao3-keywords-input" class="ao3-textarea"
              placeholder="请输入需要屏蔽的关键词，用英文逗号分隔\n\n例如：怀孕, AU, 现代AU, 斜线\n\n支持中英文关键词，不区分大小写"
              rows="5"></textarea>
            <div class="ao3-input-hint">💡 输入关键词后点击“应用”即可屏蔽包含这些词的作品</div>
          </div>
        </div>
        <div class="ao3-modal-footer">
          <button class="ao3-btn ao3-btn-danger" id="ao3-clear-btn">🗑️ 清空</button>
          <button class="ao3-btn ao3-btn-secondary" id="ao3-cancel-btn">取消</button>
          <button class="ao3-btn ao3-btn-primary" id="ao3-save-btn">✅ 应用</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const modal = overlay.querySelector('.ao3-modal');
    const closeBtn = overlay.querySelector('.ao3-modal-close');
    const textarea = overlay.querySelector('#ao3-keywords-input');
    const clearBtn = overlay.querySelector('#ao3-clear-btn');
    const cancelBtn = overlay.querySelector('#ao3-cancel-btn');
    const saveBtn = overlay.querySelector('#ao3-save-btn');

    // 过滤逻辑
    function doBlock(rawList) {
      const keywords = String(rawList || '')
        .split(',')
        .map(k => k.trim().toLowerCase())
        .filter(k => k);
      // 扫描列表
      document.querySelectorAll('li.work.blurb, li.bookmark.blurb').forEach(li => {
        const shouldHide = keywords.length && keywords.some(k => li.textContent.toLowerCase().includes(k));
        li.style.display = shouldHide ? 'none' : '';
      });
    }

    // 弹窗开关
    function showModal() {
      const storedKeywords = SafeStore.get();
      textarea.value = storedKeywords;
      overlay.classList.add('show');
      setTimeout(() => { try { textarea.focus(); } catch {} }, 100);
    }
    function hideModal() { overlay.classList.remove('show'); }

    // 事件
    saveBtn.addEventListener('click', () => {
      const keywords = textarea.value.trim();
      SafeStore.set(keywords);
      doBlock(keywords);
      hideModal();
    });

    clearBtn.addEventListener('click', () => {
      if (confirm('确定要清空所有屏蔽关键词吗？')) {
        SafeStore.remove();
        textarea.value = '';
        doBlock('');
      }
    });

    cancelBtn.addEventListener('click', hideModal);
    closeBtn.addEventListener('click', hideModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) hideModal(); });
    modal.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay.classList.contains('show')) hideModal(); });

    // 菜单项（有 GM_registerMenuCommand 时注册）
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('🚫 AO3 关键词屏蔽设置', showModal);

      // 导出
      GM_registerMenuCommand('📤 导出屏蔽词到剪贴板', async () => {
        const text = SafeStore.get().trim();
        try { await navigator.clipboard.writeText(text); alert('已复制到剪贴板'); }
        catch { prompt('复制下面这段（手动复制）：', text); }
      });

      // 导入
      GM_registerMenuCommand('📥 从剪贴板导入屏蔽词', async () => {
        let text = '';
        try { text = await navigator.clipboard.readText(); } catch {}
        if (!text) text = prompt('粘贴屏蔽词（英文逗号分隔）：', '') || '';
        text = text.trim();
        SafeStore.set(text);
        doBlock(text);
        alert('已导入并应用');
      });
    } else {
      console.warn('AO3 优化脚本：GM_registerMenuCommand 不可用；已仍然启用加载时自动屏蔽，但无法通过菜单打开设置。');
    }

    // 页面加载时应用已保存的规则（无论是否有菜单，都执行）
    const stored = SafeStore.get();
    if (stored) doBlock(stored);
  })();
})();
