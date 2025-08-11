// ==UserScript==
// @name         AO3 全文翻译（移动端 Safari / Tampermonkey）
// @namespace    https://ao3-translate.example
// @version      0.4.9
// @description  精确tiktoken计数；英→中默认输出≈0.7×输入；最大化单次输入、最小化请求数；首块实测动态校准并对未启动块合包；有序流式不跳动；OpenAI-compatible；流式/非流式；finish_reason智能；红白优雅UI；计划面板显示真实in tokens。
// @match        https://archiveofourown.org/works/*
// @match        https://archiveofourown.org/chapters/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  /* ================= Settings & Utils ================= */
  const NS = 'ao3_full_translate_v039';

  // Optimized LRU Cache with better performance
  class LRUCache {
    constructor(maxSize = 100) {
      this.maxSize = maxSize;
      this.cache = new Map();
    }

    get(key) {
      if (this.cache.has(key)) {
        // Move to end by re-setting
        const value = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
      }
      return null;
    }

    set(key, value) {
      if (this.cache.has(key)) {
        this.cache.delete(key);
      } else if (this.cache.size >= this.maxSize) {
        // Remove first (least recently used)
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }
      this.cache.set(key, value);
    }

    delete(key) {
      this.cache.delete(key);
    }

    clear() {
      this.cache.clear();
    }

    size() {
      return this.cache.size;
    }

    keys() {
      return Array.from(this.cache.keys());
    }
  }

  // Enhanced debounce with immediate execution option
  function debounceEnhanced(fn, wait, immediate = false) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        timeout = null;
        if (!immediate) fn(...args);
      };
      const callNow = immediate && !timeout;
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
      if (callNow) fn(...args);
    };
  }

  // Throttle function for performance optimization
  function throttle(fn, limit) {
    let inThrottle;
    return function(...args) {
      if (!inThrottle) {
        fn(...args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  }

  // Performance monitoring
  const PerfMonitor = {
    marks: new Map(),
    measures: new Map(),

    mark(name) {
      this.marks.set(name, performance.now());
    },

    measure(name, startMark, endMark) {
      const start = this.marks.get(startMark) || 0;
      const end = this.marks.get(endMark) || performance.now();
      const duration = end - start;
      this.measures.set(name, duration);
      return duration;
    },

    getMeasure(name) {
      return this.measures.get(name) || 0;
    },

    clear() {
      this.marks.clear();
      this.measures.clear();
    }
  };

  // DOM batch update utilities
  const DOMBatch = {
    updates: new Map(),
    scheduled: false,

    add(element, property, value) {
      const key = `${element.tagName}_${element.className || ''}_${property}`;
      if (!this.updates.has(key)) {
        this.updates.set(key, { element, updates: {} });
      }
      this.updates.get(key).updates[property] = value;
      this.schedule();
    },

    schedule() {
      if (!this.scheduled) {
        this.scheduled = true;
        requestAnimationFrame(() => this.flush());
      }
    },

    flush() {
      this.updates.forEach(({ element, updates }) => {
        Object.assign(element, updates);
      });
      this.updates.clear();
      this.scheduled = false;
    },

    updateHTML(element, html) {
      if (element.innerHTML !== html) {
        element.innerHTML = html;
      }
    }
  };
  // Optimized settings with caching
  const settings = {
    defaults: {
      api: { baseUrl: '', path: 'v1/chat/completions', key: '' },
      model: { id: '', contextWindow: 8192 },
      gen: { maxTokens: 2048, temperature: 0.2, top_p: 1 },
      prompt: {
        system: '你是专业的文学翻译助手。请保持 AO3 文本结构、段落层次、行内格式（粗体、斜体、链接），名字与术语一致，语气自然流畅。',
        userTemplate: '请将以下 AO3 正文完整翻译为中文，保持 HTML 结构与行内标记，仅替换可见文本内容：\n{{content}}\n（请直接返回 HTML 片段，不要使用代码块或转义。）'
      },
      stream: { enabled: true, minFrameMs: 40 },
      concurrency: 3,
      debug: false,
      ui: { fontSize: 16 }, // 译文字体大小
      planner: {
        reserve: 384,
        trySingleShotOnce: true,
        singleShotSlackRatio: 0.15,
        packSlack: 0.95,          // 更激进一点
        ratioOutPerIn: 0.7        // ★ 英->中常见：输出token约为输入的70%
      },
      watchdog: { idleMs: 10000, hardMs: 90000, maxRetry: 1 }
    },
    _cache: null,
    _cacheTime: 0,
    _cacheDuration: 5000, // Cache for 5 seconds

    get() {
      const now = Date.now();
      if (this._cache && (now - this._cacheTime) < this._cacheDuration) {
        return this._cache;
      }

      try {
        const saved = GM_Get(NS);
        this._cache = saved ? deepMerge(structuredClone(this.defaults), saved) : structuredClone(this.defaults);
      } catch {
        this._cache = structuredClone(this.defaults);
      }
      this._cacheTime = now;
      return this._cache;
    },

    set(p) {
      this._cache = null; // Invalidate cache
      const merged = deepMerge(this.get(), p);
      GM_Set(NS, merged);
      this._cache = merged;
      this._cacheTime = Date.now();
      return merged;
    },

    invalidateCache() {
      this._cache = null;
      this._cacheTime = 0;
    }
  };
  function GM_Get(k){ try{ return GM_getValue(k); }catch{ try{ return JSON.parse(localStorage.getItem(k)||'null'); }catch{ return null; } } }
  function GM_Set(k,v){ try{ GM_setValue(k,v); }catch{ try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} } }

  const d = (...args) => { if (settings.get().debug) console.log('[AO3X]', ...args); };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $all = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const trimSlash = (s) => s.replace(/\/+$/, '');
  function deepMerge(a,b){ if(!b) return a; const o=Array.isArray(a)?[...a]:{...a}; for(const k in b){ o[k]=(b[k]&&typeof b[k]==='object'&&!Array.isArray(b[k]))?deepMerge(a[k]||{},b[k]):b[k]; } return o; }
  function sanitizeHTML(html) {
    const tmp = document.createElement('div'); tmp.innerHTML = html;
    tmp.querySelectorAll('script, style, iframe, object, embed').forEach(n => n.remove());
    tmp.querySelectorAll('*').forEach(el => {
      [...el.attributes].forEach(attr => {
        const name = attr.name.toLowerCase(), val = String(attr.value || '');
        if (name.startsWith('on')) el.removeAttribute(attr.name);
        if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(val)) el.removeAttribute(attr.name);
      });
    });
    return tmp.innerHTML;
  }
  function stripHtmlToText(html){ const div=document.createElement('div'); div.innerHTML=html; return (div.textContent||'').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\n+/g, ' ').replace(/\t+/g, ' '); }
  function escapeHTML(s){ return s.replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }

  /* ================= Heuristic Token Estimator (local, no external deps) ================= */
  const TKT = {
    // Keep the same public interface but use a local heuristic only.
    model2enc() { return 'heuristic'; },
    async load() { /* no-op */ },
    async countTextTokens(text /*, modelId */) {
      return heuristicCount(text);
    },
    async countPromptTokens(messages /*, modelId */) {
      // Rough overhead for role/formatting. Keep small and stable.
      const structuralOverhead = 8;
      const joined = messages.map(m => m && typeof m.content === 'string' ? m.content : '').join('\n');
      return heuristicCount(joined) + structuralOverhead;
    }
  };
  function heuristicCount(text){
    const s = (text || '');
    if (!s) return 0;
    // Heuristic: English-like ~1 token per 4 chars; Chinese-like ~1 per 1.7 chars.
    // Use the max of both to be conservative, and add 10% headroom.
    const chars = s.length;
    const estEN = Math.ceil(chars / 4);
    const estZH = Math.ceil(chars / 1.7);
    return Math.ceil(Math.max(estEN, estZH) * 1.1);
  }
  async function estimateTokensForText(text){ const s=settings.get(); return await TKT.countTextTokens(text, s.model.id); }
  async function estimatePromptTokensFromMessages(messages){ const s=settings.get(); return await TKT.countPromptTokens(messages, s.model.id); }

  /* ================= Helper Functions ================= */
  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36);
  }

  function calculateSimilarity(str1, str2) {
    // Simple similarity calculation based on common words
    const words1 = (str1.toLowerCase().match(/\b\w+\b/g) || []).slice(0, 20); // Take first 20 words
    const words2 = (str2.toLowerCase().match(/\b\w+\b/g) || []).slice(0, 20);

    if (words1.length === 0 || words2.length === 0) return 0;

    const intersection = words1.filter(word => words2.includes(word));
    const union = [...new Set([...words1, ...words2])];

    return intersection.length / union.length; // Jaccard similarity
  }

  /* ================= AO3 DOM Select ================= */
  function getHostElement(){ return $('#chapters') || $('#workskin') || document.body; }
  function collectChapterUserstuffSmart() {
    const EXCLUDE_SEL = '.preface, .summary, .notes, .endnotes, .afterword, .work.meta, .series, .children';
    let nodes = [];
    const chapters = $('#chapters');
    if (chapters) nodes = $all('.chapter .userstuff', chapters).filter(n => !n.closest(EXCLUDE_SEL));
    if (!nodes.length) nodes = $all('.userstuff').filter(n => !n.closest(EXCLUDE_SEL));
    return nodes;
  }
  let SelectedNodes = [];
  function markSelectedNodes(nodes) { SelectedNodes.forEach(n => n.removeAttribute('data-ao3x-target')); SelectedNodes = nodes; nodes.forEach(n => n.setAttribute('data-ao3x-target', '1')); }

  /* ================= UI ================= */
  const UI = {
    init() {
      GM_AddCSS();
      const wrap = document.createElement('div');
      wrap.className = 'ao3x-fab-wrap';
      const btnTranslate = document.createElement('button'); btnTranslate.className = 'ao3x-btn'; btnTranslate.textContent = '🌐';
      const btnMain = document.createElement('button'); btnMain.className = 'ao3x-btn'; btnMain.textContent = '⚙️';
      btnTranslate.addEventListener('click', () => Controller.startTranslate());
      btnMain.addEventListener('click', () => UI.openPanel());
      wrap.appendChild(btnTranslate); wrap.appendChild(btnMain); document.body.appendChild(wrap);
      UI.buildPanel(); UI.buildToolbar(); UI.ensureToast();
    },
    ensureToast(){ if(!$('#ao3x-toast')){ const t=document.createElement('div'); t.id='ao3x-toast'; t.className='ao3x-toast'; document.body.appendChild(t); } },
    toast(msg){ const t=$('#ao3x-toast'); if(!t) return; const n=document.createElement('div'); n.className='item'; n.textContent=msg; t.appendChild(n); setTimeout(()=>{ n.style.opacity='0'; n.style.transition='opacity .3s'; setTimeout(()=>n.remove(),300); }, 1400); },
    buildPanel() {
      const mask = document.createElement('div'); mask.className = 'ao3x-panel-mask'; mask.addEventListener('click', () => UI.closePanel());
      const panel = document.createElement('div'); panel.className = 'ao3x-panel';
      panel.innerHTML = `
        <div class="ao3x-panel-header">
          <h3>AO3 翻译设置</h3>
          <button class="ao3x-panel-close" id="ao3x-close-x">×</button>
        </div>
        <div class="ao3x-panel-body">
          <div class="ao3x-section">
            <h4 class="ao3x-section-title">API 配置</h4>
            <div class="ao3x-field">
              <label>Base URL</label>
              <input id="ao3x-base" type="text" placeholder="https://api.example.com"/>
            </div>
            <div class="ao3x-field">
              <label>API Path</label>
              <input id="ao3x-path" type="text" placeholder="v1/chat/completions"/>
              <span class="ao3x-hint">若 Base 已含 /v1/... 将忽略此项</span>
            </div>
            <div class="ao3x-field">
              <label>API Key</label>
              <input id="ao3x-key" type="password" placeholder="sk-..." autocomplete="off"/>
            </div>
          </div>

          <div class="ao3x-section">
            <h4 class="ao3x-section-title">模型设置</h4>
            <div class="ao3x-field">
              <label>模型名称</label>
              <div class="ao3x-input-group">
                <input id="ao3x-model" type="text" placeholder="gpt-4o-mini"/>
                <button id="ao3x-fetch-models" class="ao3x-btn-secondary">获取列表</button>
              </div>
              <span class="ao3x-hint">手动输入模型名称或点击获取列表选择</span>
            </div>
            <div id="ao3x-model-browser" class="ao3x-model-browser" style="display:none">
              <div class="ao3x-field">
                <label>搜索模型</label>
                <input id="ao3x-model-q" type="text" placeholder="输入关键词筛选模型..." class="ao3x-model-search"/>
              </div>
              <div class="ao3x-model-list" id="ao3x-model-list"></div>
            </div>
            <div class="ao3x-field-group">
              <div class="ao3x-field">
                <label>上下文窗口</label>
                <input id="ao3x-cw" type="number" min="2048" value="8192"/>
              </div>
              <div class="ao3x-field">
                <label>Max Tokens <span class="ao3x-hint">-1=不限制</span></label>
                <input id="ao3x-maxt" type="number" min="-1" value="2048" placeholder="留空或-1为不限制"/>
              </div>
            </div>
            <div class="ao3x-field">
              <label>温度 <span class="ao3x-badge">0-2</span></label>
              <input id="ao3x-temp" type="number" step="0.1" min="0" max="2" value="0.2"/>
            </div>
          </div>

          <div class="ao3x-section">
            <h4 class="ao3x-section-title">提示词设置</h4>
            <div class="ao3x-field">
              <label>System Prompt</label>
              <textarea id="ao3x-sys" rows="3"></textarea>
            </div>
            <div class="ao3x-field">
              <label>User 模板 <span class="ao3x-hint">使用 {{content}} 作为占位符</span></label>
              <textarea id="ao3x-user" rows="3"></textarea>
            </div>
          </div>

          <div class="ao3x-section">
            <h4 class="ao3x-section-title">高级选项</h4>
            <div class="ao3x-field-group">
              <div class="ao3x-field">
                <label>并发数</label>
                <input id="ao3x-conc" type="number" min="1" max="8" value="3"/>
              </div>
              <div class="ao3x-field">
                <label>译文/原文比</label>
                <input id="ao3x-ratio" type="number" step="0.05" min="0.3" value="0.7"/>
              </div>
            </div>
            <div class="ao3x-field-group">
              <div class="ao3x-field">
                <label>空闲超时 <span class="ao3x-hint">ms，-1禁用</span></label>
                <input id="ao3x-idle" type="number" placeholder="10000"/>
              </div>
              <div class="ao3x-field">
                <label>硬超时 <span class="ao3x-hint">ms，-1禁用</span></label>
                <input id="ao3x-hard" type="number" placeholder="90000"/>
              </div>
            </div>
            <div class="ao3x-field-group">
              <div class="ao3x-field">
                <label>最大重试</label>
                <input id="ao3x-retry" type="number" min="0" max="3" value="1"/>
              </div>
              <div class="ao3x-field">
                <label>刷新间隔 <span class="ao3x-hint">ms</span></label>
                <input id="ao3x-stream-minframe" type="number" min="0" placeholder="40"/>
              </div>
            </div>
            <div class="ao3x-field">
              <label>译文字体大小 <span class="ao3x-hint">px</span></label>
              <input id="ao3x-font-size" type="number" min="12" max="24" value="16"/>
            </div>
            <div class="ao3x-switches">
              <label class="ao3x-switch">
                <input id="ao3x-stream" type="checkbox" checked/>
                <span class="ao3x-switch-slider"></span>
                <span class="ao3x-switch-label">流式传输</span>
              </label>
              <label class="ao3x-switch">
                <input id="ao3x-debug" type="checkbox"/>
                <span class="ao3x-switch-slider"></span>
                <span class="ao3x-switch-label">调试模式</span>
              </label>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(mask); document.body.appendChild(panel);
      panel.addEventListener('click', e => e.stopPropagation());
      $('#ao3x-close-x', panel).addEventListener('click', UI.closePanel);

      const fetchBtn = $('#ao3x-fetch-models', panel);
      const browserBox = $('#ao3x-model-browser', panel);
      fetchBtn.addEventListener('click', async () => {
        browserBox.style.display = 'block';
        await ModelBrowser.fetchAndRender(panel, true); // Force refresh
        UI.toast('模型列表已刷新');
      });
      $('#ao3x-model-q', panel).addEventListener('input', () => ModelBrowser.filter(panel));

      const autosave = throttle(() => {
        PerfMonitor.mark('autosave_start');
        settings.set(collectPanelValues(panel));
        applyFontSize();
        saveToast();
        PerfMonitor.mark('autosave_end');
        const duration = PerfMonitor.measure('autosave_duration', 'autosave_start', 'autosave_end');
        if (duration > 100) {
          d('Autosave performance warning:', duration + 'ms');
        }
      }, 500); // Throttle to prevent rapid saves

      panel.addEventListener('input', debounceEnhanced(autosave, 300), true);
      panel.addEventListener('change', autosave, true);

      // Use passive event listener for better performance
      panel.addEventListener('blur', (e)=>{
        if(panel.contains(e.target)) {
          requestAnimationFrame(() => autosave());
        }
      }, { passive: true, capture: true });

      UI._panel = panel; UI._mask = mask; UI.syncPanel();
    },
    openPanel() { UI.syncPanel(); UI._mask.style.display = 'block'; UI._panel.style.display = 'block'; UI.hideFAB(); },
    closePanel() { UI._mask.style.display = 'none'; UI._panel.style.display = 'none'; UI.showFAB(); },
    hideFAB() { const fab = $('.ao3x-fab-wrap'); if (fab) fab.classList.add('hidden'); },
    showFAB() { const fab = $('.ao3x-fab-wrap'); if (fab) fab.classList.remove('hidden'); },
    syncPanel() {
      const s = settings.get();
      $('#ao3x-base').value = s.api.baseUrl; $('#ao3x-path').value = s.api.path; $('#ao3x-key').value = s.api.key;
      $('#ao3x-model').value = s.model.id; $('#ao3x-cw').value = s.model.contextWindow; $('#ao3x-maxt').value = s.gen.maxTokens;
      $('#ao3x-temp').value = s.gen.temperature; $('#ao3x-sys').value = s.prompt.system; $('#ao3x-user').value = s.prompt.userTemplate;
      $('#ao3x-stream').checked = !!s.stream.enabled; $('#ao3x-stream-minframe').value = String(s.stream.minFrameMs ?? 40);
      $('#ao3x-debug').checked = !!s.debug; $('#ao3x-conc').value = String(s.concurrency);
      $('#ao3x-idle').value = String(s.watchdog.idleMs); $('#ao3x-hard').value = String(s.watchdog.hardMs); $('#ao3x-retry').value = String(s.watchdog.maxRetry);
      $('#ao3x-ratio').value = String(s.planner.ratioOutPerIn);
      $('#ao3x-font-size').value = String(s.ui?.fontSize || 16);
    },
    buildToolbar() {
      const bar = document.createElement('div');
      bar.className = 'ao3x-toolbar';
      bar.innerHTML = `<button data-mode="trans" class="active">仅译文</button><button data-mode="orig">仅原文</button><button data-mode="bi">双语对照</button><button id="ao3x-retry-incomplete" data-action="retry" style="display: none;">重试未完成</button><button id="ao3x-clear-cache" data-action="clear-cache" style="display: none;">清理缓存</button>`;
      bar.addEventListener('click', (e) => {
        const btn = e.target.closest('button'); if (!btn) return;
        const action = btn.getAttribute('data-action');
        if (action === 'retry') { Controller.retryIncomplete(); return; }
        if (action === 'clear-cache') { UI.clearTranslationCache(); return; }
        [...bar.querySelectorAll('button')].forEach(b => { if (!b.getAttribute('data-action')) b.classList.remove('active', 'highlight'); });
        if (!action) { btn.classList.add('active'); View.setMode(btn.getAttribute('data-mode')); }
      });
      document.body.appendChild(bar); UI._toolbar = bar;
    },
    showToolbar() { UI._toolbar.style.display = 'flex'; },
    hideToolbar() { UI._toolbar.style.display = 'none'; },
    updateToolbarState() {
      const retryBtn = $('#ao3x-retry-incomplete');
      const biBtn = $('[data-mode="bi"]', UI._toolbar);
      const clearCacheBtn = $('#ao3x-clear-cache');

      // 检查是否有需要重试的段落（只有真正失败的才显示重试按钮）
      const incompleteIndices = Controller.collectIncompleteIndices();
      let hasFailedBlocks = false;
      if (incompleteIndices.length > 0) {
        // 只有当存在真正失败的块（包含失败消息）时才显示重试按钮
        hasFailedBlocks = incompleteIndices.some(i => {
          const html = TransStore.get(String(i)) || '';
          return /\[该段失败：|\[请求失败：/.test(html);
        });
      }
      if (retryBtn) {
        retryBtn.style.display = hasFailedBlocks ? '' : 'none';
      }

      // 检查是否有翻译缓存，显示清理缓存按钮
      if (clearCacheBtn) {
        const hasCache = TransStore._completedCount > 0 && TransStore._cache.size() > 0;
        clearCacheBtn.style.display = hasCache ? '' : 'none';
      }

      // 检查翻译是否全部完成，高亮双语对照按钮
      if (biBtn) {
        const isAllComplete = TransStore.allDone(RenderState.total || 0) && (RenderState.total || 0) > 0;
        if (isAllComplete) {
          biBtn.classList.add('highlight');
        } else {
          biBtn.classList.remove('highlight');
        }
      }
    },

    // 清理翻译缓存
    clearTranslationCache() {
      if (confirm('确定要清理所有翻译缓存吗？此操作不可撤销。')) {
        // 记录清理前的状态
        const cacheSize = TransStore._cache.size();
        const completedCount = TransStore._completedCount;

        // 清理缓存
        TransStore.clear();

        // 清理持久化存储
        GM_Set('ao3_trans_cache', null);

        // 清理渲染状态
        RenderState.nextToRender = 0;
        RenderState.total = 0;
        RenderState.lastApplied = Object.create(null);

        // 隐藏工具栏
        UI.hideToolbar();

        // 重新加载页面内容
        const container = $('#ao3x-render');
        if (container) {
          container.innerHTML = '';
        }

        // 显示提示
        UI.toast(`已清理 ${completedCount} 个已完成的翻译和 ${cacheSize} 个缓存条目`);

        // 记录调试信息
        d('cache:cleared', {
          cacheSize,
          completedCount,
          timestamp: Date.now()
        });

        // 更新工具栏状态
        UI.updateToolbarState();

        // 可选：重新标记当前页面的节点
        setTimeout(() => {
          const nodes = collectChapterUserstuffSmart();
          if (nodes.length > 0) {
            markSelectedNodes(nodes);
          }
        }, 100);
      }
    }
  };
  const saveToast = (()=>{ let t; return ()=>{ clearTimeout(t); t=setTimeout(()=>UI.toast('已保存'), 120); }; })();

  // 应用字体大小设置
  function applyFontSize() {
    const s = settings.get();
    const fontSize = s.ui?.fontSize || 16;
    document.documentElement.style.setProperty('--translation-font-size', `${fontSize}px`);
  }

  function GM_AddCSS(){
    GM_addStyle(`
      :root{
        --c-bg:#fafafa; --c-fg:#0b0b0d; --c-card:#ffffff; --c-muted:#6b7280;
        --c-accent:#b30000; --c-accent-weak:#e74a4a;
        --c-border:#e5e5e5; --c-soft:#f7f7f8;
        --radius:12px; --radius-full:999px;
      }

      /* FAB按钮组 */
      .ao3x-fab-wrap{position:fixed;right:12px;top:50%;transform:translateY(-50%);z-index:99999;display:flex;flex-direction:column;gap:8px;opacity:0.6;transition:opacity .3s}
      .ao3x-fab-wrap:hover{opacity:1}
      .ao3x-fab-wrap.hidden{opacity:0;pointer-events:none}
      .ao3x-btn{background:rgba(255,255,255,.9);color:var(--c-accent);border:1px solid rgba(229,229,229,.8);border-radius:var(--radius-full);padding:10px 14px;font-size:13px;font-weight:500;box-shadow:0 2px 8px rgba(0,0,0,.08);cursor:pointer;transition:all .2s;backdrop-filter:blur(8px)}
      .ao3x-btn:hover{background:rgba(255,255,255,.95);box-shadow:0 4px 12px rgba(179,0,0,.15);transform:translateY(-1px)}
      .ao3x-btn:active{transform:scale(.98)}

      /* 面板遮罩 */
      .ao3x-panel-mask{position:fixed;inset:0;background:rgba(0,0,0,.4);backdrop-filter:blur(4px);z-index:99997;display:none}

      /* 设置面板 - 移动端优化 */
      .ao3x-panel{
        position:fixed;bottom:0;left:0;right:0;
        max-height:90vh;overflow:hidden;
        border-radius:var(--radius) var(--radius) 0 0;
        background:var(--c-card);color:var(--c-fg);z-index:99998;
        display:none;animation:slideUp .3s ease;
        box-shadow:0 -4px 20px rgba(0,0,0,.15);
      }
      @media (min-width:768px){
        .ao3x-panel{
          left:50%;bottom:auto;top:50%;
          transform:translate(-50%,-50%);
          width:min(90vw,720px);max-height:85vh;
          border-radius:var(--radius);
        }
      }
      @keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}

      /* 面板头部 */
      .ao3x-panel-header{
        display:flex;align-items:center;justify-content:space-between;
        padding:16px 20px;border-bottom:1px solid var(--c-border);
        position:sticky;top:0;background:var(--c-card);z-index:10;
      }
      .ao3x-panel-header h3{margin:0;font-size:16px;font-weight:600;color:var(--c-accent)}
      .ao3x-panel-close{
        width:28px;height:28px;border-radius:var(--radius-full);
        background:var(--c-soft);border:none;color:var(--c-muted);
        font-size:20px;line-height:1;cursor:pointer;transition:all .2s
      }
      .ao3x-panel-close:hover{background:var(--c-accent);color:white}

      /* 面板主体 */
      .ao3x-panel-body{
        padding:16px;overflow-y:auto;max-height:calc(90vh - 80px);
        -webkit-overflow-scrolling:touch;box-sizing:border-box;
      }
      @media (min-width:768px){
        .ao3x-panel-body{padding:20px;max-height:calc(85vh - 140px)}
      }

      /* 面板底部 - 移动端隐藏 */
      .ao3x-panel-footer{
        display:none;
      }
      @media (min-width:768px){
        .ao3x-panel-footer{
          display:flex;gap:12px;padding:16px 20px;
          border-top:1px solid var(--c-border);
          position:sticky;bottom:0;background:var(--c-card);
        }
      }

      /* 分组样式 */
      .ao3x-section{margin-bottom:24px}
      .ao3x-section:last-child{margin-bottom:0}
      .ao3x-section-title{
        font-size:13px;font-weight:600;color:var(--c-muted);
        text-transform:uppercase;letter-spacing:.5px;
        margin:0 0 12px;padding-bottom:8px;
        border-bottom:1px solid var(--c-border);
      }

      /* 表单字段 */
      .ao3x-field{margin-bottom:16px}
      .ao3x-field:last-child{margin-bottom:0}
      .ao3x-field label{
        display:block;font-size:13px;color:var(--c-fg);
        margin-bottom:6px;font-weight:500;
      }
      .ao3x-field input[type="text"],
      .ao3x-field input[type="number"],
      .ao3x-field input[type="password"],
      .ao3x-field textarea{
        width:100%;padding:10px 12px;
        border:1px solid var(--c-border);border-radius:var(--radius);
        background:var(--c-soft);color:var(--c-fg);
        font-size:14px;transition:all .2s;box-sizing:border-box;
      }
      .ao3x-field input:focus,
      .ao3x-field textarea:focus{
        outline:none;border-color:var(--c-accent);
        background:white;box-shadow:0 0 0 3px rgba(179,0,0,.1);
      }
      .ao3x-field textarea{min-height:80px;resize:vertical;font-family:inherit}

      /* 提示文字 */
      .ao3x-hint{
        font-size:11px;color:var(--c-muted);margin-top:4px;
        display:inline-block;
      }
      .ao3x-badge{
        display:inline-block;padding:2px 6px;
        background:var(--c-soft);border-radius:6px;
        font-size:10px;color:var(--c-muted);
      }

      /* 字段组 */
      .ao3x-field-group{
        display:grid;grid-template-columns:1fr 1fr;gap:12px;
        margin-bottom:16px;
      }
      @media (max-width:480px){
        .ao3x-field-group{grid-template-columns:1fr}
      }

      /* 输入组 */
      .ao3x-input-group{
        display:flex;gap:8px;align-items:stretch;
      }
      .ao3x-input-group input{flex:1}

      /* 按钮样式统一 */
      .ao3x-btn-primary,
      .ao3x-btn-ghost,
      .ao3x-btn-secondary{
        padding:10px 20px;border-radius:var(--radius-full);
        font-size:14px;font-weight:500;cursor:pointer;
        transition:all .2s;border:1px solid;
      }
      .ao3x-btn-primary{
        background:var(--c-accent);color:white;
        border-color:var(--c-accent);
      }
      .ao3x-btn-primary:hover{
        background:#9a0000;transform:translateY(-1px);
        box-shadow:0 4px 12px rgba(179,0,0,.25);
      }
      .ao3x-btn-ghost{
        background:transparent;color:var(--c-fg);
        border-color:var(--c-border);
      }
      .ao3x-btn-ghost:hover{
        background:var(--c-soft);
      }
      .ao3x-btn-secondary{
        background:var(--c-soft);color:var(--c-accent);
        border-color:var(--c-border);padding:8px 14px;
        font-size:13px;
      }
      .ao3x-btn-secondary:hover{
        background:var(--c-accent);color:white;
      }

      /* 开关组件 */
      .ao3x-switches{display:flex;gap:16px;flex-wrap:wrap;justify-content:center}
      .ao3x-switch{
        display:flex;align-items:center;cursor:pointer;
        position:relative;padding-left:48px;min-height:24px;
      }
      .ao3x-switch input{
        position:absolute;opacity:0;width:0;height:0;
      }
      .ao3x-switch-slider{
        position:absolute;left:0;top:0;
        width:40px;height:24px;border-radius:12px;
        background:var(--c-border);transition:all .3s;
      }
      .ao3x-switch-slider::after{
        content:'';position:absolute;left:2px;top:2px;
        width:20px;height:20px;border-radius:10px;
        background:white;transition:all .3s;
        box-shadow:0 2px 4px rgba(0,0,0,.2);
      }
      .ao3x-switch input:checked + .ao3x-switch-slider{
        background:var(--c-accent);
      }
      .ao3x-switch input:checked + .ao3x-switch-slider::after{
        transform:translateX(16px);
      }
      .ao3x-switch-label{
        font-size:14px;color:var(--c-fg);user-select:none;
      }

      /* 模型浏览器 */
      .ao3x-model-browser{
        margin-top:16px;margin-bottom:16px;padding:16px;border:1px solid var(--c-border);
        border-radius:var(--radius);background:var(--c-soft);
        box-shadow:0 1px 3px rgba(0,0,0,.05);
      }
      .ao3x-model-search{
        width:100%;padding:10px 12px;
        border:1px solid var(--c-border);border-radius:var(--radius);
        background:var(--c-card);color:var(--c-fg);
        font-size:14px;transition:all .2s;box-sizing:border-box;
      }
      .ao3x-model-search:focus{
        outline:none;border-color:var(--c-accent);
        background:white;box-shadow:0 0 0 3px rgba(179,0,0,.1);
      }
      .ao3x-model-list{
        border:1px solid var(--c-border);border-radius:var(--radius);
        background:var(--c-card);max-height:240px;overflow-y:auto;
        margin-top:12px;box-shadow:0 1px 3px rgba(0,0,0,.05);
      }
      .ao3x-model-list:empty{
        display:flex;align-items:center;justify-content:center;
        min-height:60px;color:var(--c-muted);font-size:13px;
      }
      .ao3x-model-list:empty::after{
        content:'暂无可用模型，请点击"获取列表"按钮';
      }
      .ao3x-model-item{
        display:flex;align-items:center;justify-content:space-between;
        padding:12px 16px;font-size:14px;cursor:pointer;
        border-bottom:1px solid var(--c-border);transition:all .2s;
        color:var(--c-fg);
      }
      .ao3x-model-item:last-child{border-bottom:none}
      .ao3x-model-item:hover{
        background:var(--c-soft);color:var(--c-accent);
        transform:translateX(2px);
      }
      .ao3x-model-item:active{
        transform:translateX(1px);background:var(--c-accent);
        color:white;
      }
      .ao3x-model-item .model-name{
        font-weight:500;flex:1;
      }
      .ao3x-model-item .model-info{
        font-size:12px;color:var(--c-muted);
        margin-left:8px;
      }
      @media (max-width:480px){
        .ao3x-model-browser{margin-top:12px;padding:12px}
        .ao3x-model-list{max-height:200px}
        .ao3x-model-item{padding:10px 12px;font-size:13px}
        .ao3x-model-item .model-info{display:none}
      }

      /* 工具栏 */
      .ao3x-toolbar{
        position:fixed;left:50%;top:12px;transform:translateX(-50%);
        z-index:99996;background:white;border-radius:var(--radius-full);
        padding:4px;display:none;gap:4px;
        border:1px solid var(--c-border);
        box-shadow:0 2px 12px rgba(0,0,0,.1);
      }
      .ao3x-toolbar button{
        background:transparent;color:var(--c-fg);border:none;
        padding:8px 14px;border-radius:var(--radius-full);
        font-size:13px;font-weight:500;cursor:pointer;
        transition:all .2s;
      }
      .ao3x-toolbar button:hover{background:var(--c-soft)}
      .ao3x-toolbar button.active{
        background:var(--c-accent);color:white;
      }
      .ao3x-toolbar button.highlight{
        animation:highlight-pulse 2s infinite;
        box-shadow:0 0 0 2px var(--c-accent);
      }
      @keyframes highlight-pulse{
        0%,100%{box-shadow:0 0 0 2px var(--c-accent)}
        50%{box-shadow:0 0 0 4px var(--c-accent-weak)}
      }

      /* Toast提示 */
      .ao3x-toast{
        position:fixed;right:12px;top:12px;
        display:flex;flex-direction:column;gap:8px;z-index:99999;
      }
      .ao3x-toast .item{
        background:var(--c-accent);color:white;
        padding:10px 16px;border-radius:var(--radius);
        font-size:13px;font-weight:500;
        box-shadow:0 4px 12px rgba(179,0,0,.25);
        animation:slideInRight .3s ease;
      }
      @keyframes slideInRight{from{transform:translateX(100%);opacity:0}}

      /* 内容区域 */
      .ao3x-render{margin:0 auto;max-width:900px;padding:0 16px}
      .ao3x-translation{line-height:1.7;min-height:1em}
      .ao3x-block{margin-bottom:1em}
      .ao3x-muted{opacity:.5;font-style:italic}
      .ao3x-small{font-size:12px;color:var(--c-muted)}

      /* 引用块样式 */
      .ao3x-translation blockquote{
        margin:1em 0;padding-left:1em;border-left:4px solid var(--c-border);
        color:var(--c-muted);font-style:italic;background:var(--c-soft);
      }

      /* 动态字体大小 */
      .ao3x-translation{font-size:var(--translation-font-size,16px)}

      /* 双语对照 */
      .ao3x-pair{
        padding:12px 16px;margin:12px 0;
        border:1px solid var(--c-border);border-radius:var(--radius);
        background:white;box-shadow:0 1px 3px rgba(0,0,0,.05);
      }
      .ao3x-pair .orig{color:#374151;line-height:1.6}
      .ao3x-pair .trans{
        color:#111;line-height:1.7;margin-top:12px;padding-top:12px;
        border-top:1px dashed var(--c-border);
        font-size:var(--translation-font-size,16px);
      }

      /* 计划面板 */
      .ao3x-plan{
        border:1px solid var(--c-border);background:white;
        border-radius:var(--radius);padding:12px 16px;margin:16px 0;
      }
      .ao3x-plan h4{
        margin:0 0 12px;font-size:14px;font-weight:600;
        color:var(--c-accent);
      }
      .ao3x-plan .row{
        font-size:12px;color:#4b5563;padding:8px 0;
        border-top:1px solid var(--c-border);
        transition:all 0.3s ease;
      }
      .ao3x-plan .row:hover{
        background:rgba(0,0,0,0.02);
      }
      .ao3x-status-completed{
        border-left:3px solid #10b981;
        padding-left:8px;
      }
      .ao3x-status-failed{
        border-left:3px solid #ef4444;
        padding-left:8px;
      }
      .ao3x-status-in-progress{
        border-left:3px solid #3b82f6;
        padding-left:8px;
      }
      .ao3x-status-pending{
        border-left:3px solid #6b7280;
        padding-left:8px;
      }
      .ao3x-error-info{
        color:#ef4444;
        font-size:11px;
        background:rgba(239,68,68,0.1);
        padding:2px 6px;
        border-radius:4px;
        margin-left:8px;
        cursor:help;
      }
      .ao3x-finish-reason{
        color:#6366f1;
        font-size:11px;
        background:rgba(99,102,241,0.1);
        padding:2px 6px;
        border-radius:4px;
        margin-left:4px;
        cursor:help;
      }
      .ao3x-plan .row:first-of-type{border-top:none}

      /* KV显示 */
      .ao3x-kv{
        display:flex;gap:8px;flex-wrap:wrap;
        font-size:11px;margin-top:12px;
      }
      .ao3x-kv span{
        background:var(--c-soft);padding:4px 8px;
        border-radius:6px;color:var(--c-muted);
      }
    `);
  }
  function debounce(fn, wait){ let t; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), wait); }; }
  function collectPanelValues(panel) {
    const cur = settings.get();
    return {
      api: { baseUrl: $('#ao3x-base', panel).value.trim(), path: $('#ao3x-path', panel).value.trim(), key: $('#ao3x-key', panel).value.trim() },
      model: { id: $('#ao3x-model', panel).value.trim(), contextWindow: parseInt($('#ao3x-cw', panel).value, 10) || cur.model.contextWindow },
      gen: { maxTokens: parseInt($('#ao3x-maxt', panel).value, 10) === -1 ? -1 : parseInt($('#ao3x-maxt', panel).value, 10) || cur.gen.maxTokens, temperature: parseFloat($('#ao3x-temp', panel).value) || cur.gen.temperature },
      prompt: { system: $('#ao3x-sys', panel).value, userTemplate: $('#ao3x-user', panel).value },
      stream: { enabled: $('#ao3x-stream', panel).checked, minFrameMs: Math.max(0, parseInt($('#ao3x-stream-minframe', panel).value||String(cur.stream.minFrameMs||40),10)) },
      concurrency: Math.max(1, Math.min(8, parseInt($('#ao3x-conc', panel).value, 10) || cur.concurrency)),
      debug: $('#ao3x-debug', panel).checked,
      planner: {
        ...cur.planner,
        ratioOutPerIn: Math.max(0.3, parseFloat($('#ao3x-ratio', panel).value || cur.planner.ratioOutPerIn))
      },
      watchdog: {
        idleMs: (function(){ const v = parseInt($('#ao3x-idle', panel).value || cur.watchdog.idleMs, 10); return v === -1 ? -1 : Math.max(5000, v); })(),
        hardMs: (function(){ const v = parseInt($('#ao3x-hard', panel).value || cur.watchdog.hardMs, 10); return v === -1 ? -1 : Math.max(10000, v); })(),
        maxRetry: Math.max(0, Math.min(3, parseInt($('#ao3x-retry', panel).value || cur.watchdog.maxRetry, 10)))
      },
      ui: {
        fontSize: Math.max(12, Math.min(24, parseInt($('#ao3x-font-size', panel).value || cur.ui?.fontSize || 16, 10)))
      }
    };
  }

  /* ================= Render Container & Plan ================= */
  let renderContainer = null;
  function ensureRenderContainer() {
    if (renderContainer) return renderContainer;
    const c = document.createElement('div'); c.id = 'ao3x-render'; c.className = 'ao3x-render';
    const first = SelectedNodes && SelectedNodes[0];
    if (first && first.parentNode) first.parentNode.insertBefore(c, first);
    else (getHostElement() || document.body).appendChild(c);
    renderContainer = c; return c;
  }
  function renderPlanSummary(plan){
    const c=ensureRenderContainer();
    let box = $('#ao3x-plan', c);
    if(!box){ box=document.createElement('div'); box.id='ao3x-plan'; box.className='ao3x-plan'; c.appendChild(box); }
    const rows = plan.map((p,i)=>{
      const text = stripHtmlToText(p.text||p.html);
      const head = text.slice(0,48); const tail = text.slice(-48);
      const estIn = p.inTok != null ? p.inTok : 0;

      // Status indicator
      let statusIndicator = '';
      let statusClass = '';
      if (p.status === 'completed') {
        statusIndicator = '✅';
        statusClass = 'ao3x-status-completed';
      } else if (p.status === 'failed') {
        statusIndicator = '❌';
        statusClass = 'ao3x-status-failed';
      } else if (p.status === 'in_progress') {
        statusIndicator = '⏳';
        statusClass = 'ao3x-status-in-progress';
      } else {
        statusIndicator = '⏸️';
        statusClass = 'ao3x-status-pending';
      }

      // Error and finish reason info
      let extraInfo = '';
      if (p.error) {
        extraInfo = ` <span class="ao3x-error-info" title="${escapeHTML(p.error)}">❌${escapeHTML(p.error.substring(0, 30))}${p.error.length > 30 ? '...' : ''}</span>`;
      }
      if (p.finishReason) {
        extraInfo += ` <span class="ao3x-finish-reason" title="Finish reason: ${p.finishReason}">🏁${p.finishReason}</span>`;
      }

      return `<div class="row ${statusClass}"><b>#${i}</b> ${statusIndicator} <span class="ao3x-small">in≈${estIn}</span> ｜ <span class="ao3x-small">开头：</span>${escapeHTML(head)} <span class="ao3x-small">…结尾：</span>${escapeHTML(tail)}${extraInfo}</div>`;
    }).join('');
    box.innerHTML = `<h4>切块计划：共 ${plan.length} 块</h4>${rows}<div class="ao3x-kv" id="ao3x-kv"></div>`;
  }
  function updateKV(kv){ const k=$('#ao3x-kv'); if(!k) return; k.innerHTML = Object.entries(kv).map(([k,v])=>`<span>${k}: ${escapeHTML(String(v))}</span>`).join(''); }

  /* ================= Token-aware Packing (precise) ================= */
  async function packIntoChunks(htmlList, budgetTokens){
    const s = settings.get();
    const plan=[]; let cur=[]; let curTok=0;

    async function tokOf(html){
      const t = stripHtmlToText(html);
      return await TKT.countTextTokens(t, s.model.id);
    }
    async function flush(){
      if(cur.length){
        const html = cur.join('\n');
        const text = stripHtmlToText(html);
        const inTok = await TKT.countTextTokens(text, s.model.id);
        plan.push({html, text, inTok, status: 'pending', error: null, finishReason: null});
        cur = []; curTok = 0;
      }
    }

    for (const h of htmlList){
      const tTok = await tokOf(h);
      if (tTok > budgetTokens){
        const parts = segmentSentencesFromHTML(h);
        for (const p of parts){
          const pTok = await tokOf(p);
          if (pTok > budgetTokens){
            const txt = stripHtmlToText(p);
            const byPunc = txt.split(/([。！？!?…]+["”』）】]*\s*)/);
            let accum=''; let accumTok=0;
            for (let i=0;i<byPunc.length;i+=2){
              const chunk=(byPunc[i]||'')+(byPunc[i+1]||''); if(!chunk) continue;
              const test = accum + chunk;
              const testTok = await TKT.countTextTokens(test, s.model.id);
              if (curTok + testTok > budgetTokens){
                if (accum){
                  const aTok = await TKT.countTextTokens(accum, s.model.id);
                  if (curTok + aTok > budgetTokens) await flush();
                  cur.push(accum); curTok += aTok;
                }
                accum = chunk; accumTok = await TKT.countTextTokens(accum, s.model.id);
              } else {
                accum = test; accumTok = testTok;
              }
            }
            if (accum){
              if (curTok + accumTok > budgetTokens) await flush();
              cur.push(accum); curTok += accumTok;
            }
          } else {
            if (curTok + pTok > budgetTokens) await flush();
            cur.push(p); curTok += pTok;
          }
        }
      } else {
        if (curTok + tTok > budgetTokens) await flush();
        cur.push(h); curTok += tTok;
      }
    }
    await flush();
    return plan.map((p,i)=>({index:i, html:p.html, text:p.text, inTok:p.inTok}));
  }
  function segmentSentencesFromHTML(html){
    const tmp=document.createElement('div'); tmp.innerHTML=html; const parts=[];
    // 只选择顶层元素，避免重复处理嵌套的块级元素
    const blocks=Array.from(tmp.children).filter(el =>
      el.matches('p, div, blockquote, li, pre')
    );
    if(!blocks.length){ parts.push(html); return parts; }
    for(const b of blocks) parts.push(b.outerHTML);
    return parts;
  }

  /* ================= OpenAI-compatible + SSE ================= */
  // Compiled regex patterns for better performance
  const THINKING_PATTERNS = [
    /<thinking(?:\s[^>]*)?>[\s\S]*?<\/thinking>/gi,
    /<reasoning(?:\s[^>]*)?>[\s\S]*?<\/reasoning>/gi,
    /<thought(?:\s[^>]*)?>[\s\S]*?<\/thought>/gi,
    /<think(?:\s[^>]*)?>[\s\S]*?<\/think>/gi,
    /<analysis(?:\s[^>]*)?>[\s\S]*?<\/analysis>/gi,
    /<internal(?:\s[^>]*)?>[\s\S]*?<\/internal>/gi
  ];

  const MULTI_NEWLINE_PATTERN = /\n\s*\n\s*\n/g;
  const CONSERVATIVE_THINKING_PATTERN = /<thinking[^>]*?>[\s\S]*?<\/thinking>/gi;
  const CONSERVATIVE_REASONING_PATTERN = /<reasoning[^>]*?>[\s\S]*?<\/reasoning>/gi;

  // 过滤思考模型中的思考内容，只保留实际回复
  function filterThinkingContent(content) {
    if (!content || typeof content !== 'string') return content;

    let filtered = content;

    // 使用预编译的正则表达式模式进行过滤
    for (const pattern of THINKING_PATTERNS) {
      filtered = filtered.replace(pattern, '');
    }

    // 清理多余空行
    filtered = filtered.replace(MULTI_NEWLINE_PATTERN, '\n\n');

    // 验证过滤后的内容是否有效（防止过度过滤）
    if (filtered.length === 0 && content.length > 0) {
      // 使用更保守的过滤方式
      filtered = content;
      filtered = filtered.replace(CONSERVATIVE_THINKING_PATTERN, '');
      filtered = filtered.replace(CONSERVATIVE_REASONING_PATTERN, '');

      // 只在调试模式下输出警告
      if (settings.get().debug) {
        console.warn('filterThinkingContent: 内容被完全过滤，使用保守模式', {
          original: content.substring(0, 200) + '...',
          filtered: filtered.substring(0, 200) + '...'
        });
      }
    }

    return filtered;
  }
  // 从推理内容中提取译文（针对GLM-4.5-air等模型）
  function extractContentFromReasoning(reasoningContent) {
    if (!reasoningContent || typeof reasoningContent !== 'string') return '';

    // 查找译文部分（通常在代码块中或特定标记后）
    const patterns = [
      /Translation:\s*```\s*([\s\S]*?)\s*```/gi,  // Translation: ```译文```
      /译文：\s*```\s*([\s\S]*?)\s*```/gi,        // 译文：```译文```
      /```\s*([\s\S]*?)\s*```/gi,                  // 直接的代码块
      /<p>\s*([\s\S]*?)\s*<\/p>/gi,                 // HTML段落
    ];

    for (const pattern of patterns) {
      const match = pattern.exec(reasoningContent);
      if (match && match[1]) {
        const content = match[1].trim();
        if (content && content.length > 10) { // 避免提取到短片段
          return content;
        }
      }
    }

    // 特殊处理：尝试提取HTML标签中的内容（针对你的响应格式）
    const htmlMatches = reasoningContent.match(/<p>\s*<span>([\s\S]*?)<\/span>\s*<\/p>/gi);
    if (htmlMatches) {
      const allHtmlContent = htmlMatches.map(match => {
        const spanMatch = match.match(/<span>([\s\S]*?)<\/span>/i);
        return spanMatch ? spanMatch[1] : '';
      }).filter(content => content.trim().length > 0);

      if (allHtmlContent.length > 0) {
        return allHtmlContent.join('\n');
      }
    }

    // 如果没有找到明确的译文标记，尝试从英文后提取中文内容
    const chineseContent = reasoningContent.replace(/[\s\S]*?(?=[\u4e00-\u9fff])/gi, '');
    if (chineseContent && chineseContent.length > 10) {
      return chineseContent;
    }

    // 最后尝试：提取所有中文字符
    const chineseChars = reasoningContent.match(/[\u4e00-\u9fff]+/g);
    if (chineseChars && chineseChars.length > 0) {
      return chineseChars.join('');
    }

    return '';
  }
  function resolveEndpoint(baseUrl, apiPath){ if(!baseUrl) throw new Error('请在设置中填写 Base URL'); const hasV1=/\/v1\//.test(baseUrl); return hasV1? baseUrl : `${trimSlash(baseUrl)}/${trimSlash(apiPath||'v1/chat/completions')}`; }
  function resolveModelsEndpoint(baseUrl){ if(!baseUrl) throw new Error('请填写 Base URL'); const m=baseUrl.match(/^(.*?)(\/v1\/.*)$/); return m? `${m[1]}/v1/models` : `${trimSlash(baseUrl)}/v1/models`; }
  async function fetchJSON(url, key, body){
    const res = await fetch(url, { method:'POST', headers:{'content-type':'application/json', ...(key?{'authorization':`Bearer ${key}`}:{})}, body: JSON.stringify(body) });
    if(!res.ok){ const t=await res.text(); throw new Error(`HTTP ${res.status}: ${t.slice(0,500)}`); }
    return await res.json();
  }
  function supportsStreamingFetch(){ try{ return !!(window.ReadableStream && window.TextDecoder && window.AbortController); } catch{ return false; } }

  async function postChatWithRetry({ endpoint, key, payload, stream, onDelta, onDone, onError, onFinishReason, label, onRetry }){
    const cfg = settings.get().watchdog; let attempt = 0;
    while (true) {
      attempt++;
      try {
        d('chat:start', {label, attempt, stream});
        await postChatOnce({ endpoint, key, payload, stream, onDelta, onDone, onFinishReason, label, idleMs: cfg.idleMs, hardMs: cfg.hardMs });
        d('chat:done', {label, attempt});
        return;
      } catch (e) {
        d('chat:error', {label, attempt, error: e.message});
        if (attempt > (cfg.maxRetry||0)) { onError && onError(e); return; }
        d('chat:retrying', {label, attemptNext: attempt+1});
        // Call onRetry callback if provided (for cache clearing)
        if (onRetry) onRetry();
        await sleep(500 + Math.random()*700);
      }
    }
  }
  async function postChatOnce({ endpoint, key, payload, stream, onDelta, onDone, onFinishReason, label, idleMs, hardMs }){
    if(stream && supportsStreamingFetch()){
      await fetchSSEWithAbort(endpoint, key, payload, onDelta, onFinishReason, {label, idleMs, hardMs});
      onDone && onDone();
    } else {
      const full=await fetchJSON(endpoint, key, payload);
      const content=full?.choices?.[0]?.message?.content || '';
      const reasoningContent=full?.choices?.[0]?.message?.reasoning_content || '';
      const fr = full?.choices?.[0]?.finish_reason || null;

      let finalContent = '';

      // 优先使用content字段
      if (content) {
        finalContent = filterThinkingContent(content);
      }
      // 如果content为空，尝试从reasoning_content中提取
      else if (reasoningContent) {
        finalContent = extractContentFromReasoning(reasoningContent);
      }

      onDelta && onDelta(finalContent); onFinishReason && onFinishReason(fr); onDone && onDone();
    }
  }
  async function fetchSSEWithAbort(url, key, body, onDelta, onFinishReason, {label='chunk', idleMs=10000, hardMs=90000} = {}){
    const ac = new AbortController(); const startedAt = performance.now(); let lastTick = startedAt;
    let bytes = 0, events = 0; let finishReason = null;

    const useIdle = !(idleMs != null && idleMs < 0);
    const useHard = !(hardMs != null && hardMs < 0);
    const idleTimer = useIdle ? setInterval(()=>{
      const now = performance.now();
      if (now - lastTick > idleMs) { if (useIdle) clearInterval(idleTimer); if (useHard) clearTimeout(hardTimer); d('sse:idle-timeout', {label, ms: now - lastTick}); ac.abort(new Error('idle-timeout')); }
    }, Math.max(2000, Math.floor((idleMs || 0)/4) || 2000)) : null;
    const hardTimer = useHard ? setTimeout(()=>{ if (useIdle && idleTimer) clearInterval(idleTimer); d('sse:hard-timeout', {label, ms: hardMs}); ac.abort(new Error('hard-timeout')); }, hardMs) : null;

    try{
      const res = await fetch(url, { method:'POST', headers:{ 'content-type':'application/json', ...(key?{'authorization':`Bearer ${key}`}:{}) }, body: JSON.stringify(body), signal: ac.signal });
      if(!res.ok){ const t=await res.text(); throw new Error(`HTTP ${res.status}: ${t}`); }

      const reader = res.body.getReader(); const td=new TextDecoder('utf-8');
      let buf=''; let eventBuf=[];
      const flushEvent = () => {
        if (!eventBuf.length) return;
        const joined = eventBuf.join('\n'); eventBuf = [];
        try{
          const j = JSON.parse(joined);
          const choice = j?.choices?.[0];
          const delta = choice?.delta?.content ?? choice?.text ?? '';
          const reasoningDelta = choice?.delta?.reasoning_content ?? '';
          if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;

          // 处理实际内容（content字段）
          if(delta){
            const filteredDelta = filterThinkingContent(delta);
            if(filteredDelta){
              onDelta(filteredDelta);
              lastTick = performance.now();
              bytes += filteredDelta.length;
              events++;
            }
          }

          // 处理推理内容（reasoning_content字段）- 如果其中包含译文，尝试提取
          if(reasoningDelta){
            // 尝试从reasoning_content中提取译文（某些模型可能在reasoning_content中包含译文）
            const extractedContent = extractContentFromReasoning(reasoningDelta);
            if(extractedContent){
              onDelta(extractedContent);
              lastTick = performance.now();
              bytes += extractedContent.length;
              events++;
            }
          }
        }catch{}
      };

      while(true){
        const {value, done} = await reader.read();
        if(done) break;
        const chunk = td.decode(value, {stream:true});
        buf += chunk; lastTick = performance.now(); bytes += chunk.length;
        const lines = buf.split(/\r?\n/); buf = lines.pop() || '';
        for(const line of lines){
          if(line.startsWith('data:')){
            const data=line.slice(5).trim(); if(data==='[DONE]'){ flushEvent(); break; }
            eventBuf.push(data);
          } else if(line.trim()===''){ flushEvent(); }
        }
      }
      if (eventBuf.length) flushEvent();
      d('sse:complete', {label, ms: Math.round(performance.now()-startedAt), bytes, events, finishReason});
      onFinishReason && onFinishReason(finishReason);
    } finally { if (idleTimer) clearInterval(idleTimer); if (hardTimer) clearTimeout(hardTimer); }
  }

  async function getModels(){
    const s=settings.get(); const url=resolveModelsEndpoint(s.api.baseUrl);
    const res=await fetch(url,{ headers:{...(s.api.key?{'authorization':`Bearer ${s.api.key}`}:{})} });
    if(!res.ok){ const t=await res.text(); throw new Error(`HTTP ${res.status}: ${t}`); }
    const j=await res.json(); const list=j?.data || j?.models || [];
    return list.map(m=> typeof m === 'string' ? {id:m} : m);
  }
  const ModelBrowser = {
    all: [],
    _sessionCache: null, // Session cache (cleared on refresh)

    async fetchAndRender(panel, forceRefresh = false){
      try{
        // Try to use session cache first unless force refresh
        if (!forceRefresh && this._sessionCache) {
          this.all = this._sessionCache;
          this.render(panel, this._sessionCache);
          return;
        }

        const list=await getModels();
        this.all=list;
        this._sessionCache = list; // Cache for this session
        this.render(panel, list);
      } catch(e){
        UI.toast('获取模型失败：'+e.message);
      }
    },
    render(panel, list){
      const box=$('#ao3x-model-list', panel); box.innerHTML='';
      list.forEach(m=>{
        const div=document.createElement('div'); div.className='ao3x-model-item';
        div.textContent=m.id||m.name||JSON.stringify(m);
        div.addEventListener('click', ()=>{ $('#ao3x-model', panel).value = m.id || m.name; settings.set(collectPanelValues(panel)); saveToast(); });
        box.appendChild(div);
      });
      $('#ao3x-model-browser', panel).style.display = 'block';
    },
    filter(panel){ const q=($('#ao3x-model-q', panel).value||'').toLowerCase(); const list=!q? this.all : this.all.filter(m=>(m.id||'').toLowerCase().includes(q)); this.render(panel, list); }
  };

  /* ================= View / Render State (ordered) ================= */
  const TransStore = {
    _cache: new LRUCache(50), // Limit to 50 cached translations
    _done: Object.create(null),
    _completedCount: 0,
    _currentUrl: window.location.href,

    set(i, html){
      this._cache.set(String(i), html);
      // Clean up old entries if cache is getting full
      if (this._cache.size() > 40) {
        this.cleanupOldEntries();
      }
    },

    get(i){
      return this._cache.get(String(i)) || '';
    },

    markDone(i){
      const key = String(i);
      if (!this._done[key]) {
        this._done[key] = true;
        this._completedCount++;
        // Auto-save when new chunk completed
        this.saveToPersistent();
      }
    },

    allDone(total){
      return this._completedCount >= total;
    },

    clear(){
      this._cache.clear();
      this._done = Object.create(null);
      this._completedCount = 0;
      this._originalNodeInfo = {};
    },

    // Save original node information for better cache matching
    saveOriginalNodeInfo(nodes) {
      this._originalNodeInfo = {};
      nodes.forEach((node, index) => {
        const content = node.getAttribute('data-original-html') || node.innerHTML;
        this._originalNodeInfo[String(index)] = {
          hash: simpleHash(content),
          length: content.length,
          preview: content.slice(0, 200),
          words: content.toLowerCase().match(/\b\w+\b/g)?.slice(0, 50) || []
        };
      });
      d('cache:save_original_node_info', { nodeCount: nodes.length });
    },

    // Save current translation to persistent storage
    saveToPersistent() {
      const data = {
        url: this._currentUrl,
        cache: Array.from(this._cache.cache.entries()),
        done: this._done,
        completedCount: this._completedCount,
        // Save original node information for better matching
        originalNodeInfo: this._originalNodeInfo || {},
        timestamp: Date.now()
      };
      d('cache:save', { url: data.url, cacheSize: data.cache.length, doneCount: Object.keys(data.done).length });
      GM_Set('ao3_trans_cache', data);
    },

    // Load translation from persistent storage
    loadFromPersistent() {
      const saved = GM_Get('ao3_trans_cache');
      d('cache:load_attempt', { saved: !!saved, savedUrl: saved?.url, currentUrl: this._currentUrl, cacheSize: saved?.cache?.length });
      if (saved && saved.url === this._currentUrl) {
        this._cache.cache = new Map(saved.cache);
        this._cache.keys = saved.cache.map(([key]) => key);
        this._done = saved.done || Object.create(null);
        this._completedCount = saved.completedCount || 0;
        this._originalNodeInfo = saved.originalNodeInfo || {};
        d('cache:load_success', {
          cacheSize: this._cache.size(),
          doneCount: Object.keys(this._done).length,
          hasOriginalNodeInfo: !!saved.originalNodeInfo,
          originalNodeCount: Object.keys(saved.originalNodeInfo || {}).length
        });
        return true;
      }
      return false;
    },

    // Check if URL changed and clear if needed
    checkUrl() {
      if (this._currentUrl !== window.location.href) {
        this.clear();
        this._currentUrl = window.location.href;
        return true; // URL changed
      }
      return false; // URL same
    },

    cleanupOldEntries() {
      // Clean up entries for completed chunks beyond the last 20
      const keys = this._cache.keys.slice(0, -20);
      keys.forEach(key => {
        const idx = parseInt(key);
        if (this._done[key] && idx < (this._completedCount - 20)) {
          this._cache.delete(key);
        }
      });
    },

    getCompletedCount() {
      return this._completedCount;
    }
  };

  const RenderState = {
    nextToRender: 0, total: 0, lastApplied: Object.create(null),
    _domCache: new Map(), // Cache DOM elements to avoid repeated queries

    setTotal(n){
      this.total = n;
      this.nextToRender = 0;
      this.lastApplied = Object.create(null);
      this._domCache.clear();
    },

    canRender(i){ return i === this.nextToRender; },

    _getTranslationElement(i) {
      const cacheKey = `trans_${i}`;
      if (this._domCache.has(cacheKey)) {
        return this._domCache.get(cacheKey);
      }

      const c = ensureRenderContainer();
      const anchor = c.querySelector(`[data-chunk-id="${i}"]`);
      if (!anchor) return null;

      let transDiv = anchor.parentElement.querySelector('.ao3x-translation');
      if (!transDiv) {
        transDiv = document.createElement('div');
        transDiv.className = 'ao3x-translation';
        anchor.insertAdjacentElement('afterend', transDiv);
      }

      this._domCache.set(cacheKey, transDiv);
      return transDiv;
    },

    applyIncremental(i, cleanHtml){
      const transDiv = this._getTranslationElement(i);
      if (!transDiv) return;

      const prev = this.lastApplied[i] || '';
      const hasPlaceholder = /\(待译\)/.test(transDiv.textContent || '');

      if (!prev || hasPlaceholder) {
        DOMBatch.updateHTML(transDiv, cleanHtml || '<span class="ao3x-muted">（待译）</span>');
        this.lastApplied[i] = cleanHtml;
        return;
      }

      if (cleanHtml.startsWith(prev)) {
        const tail = cleanHtml.slice(prev.length);
        if (tail) {
          // Use DocumentFragment for better performance
          const fragment = document.createRange().createContextualFragment(tail);
          transDiv.appendChild(fragment);
        }
      } else {
        DOMBatch.updateHTML(transDiv, cleanHtml);
      }
      this.lastApplied[i] = cleanHtml;
    },
    finalizeCurrent(){
      // Advance rendering pointer and drain any already-finished chunks in order.
      while (this.nextToRender < this.total) {
        const i = this.nextToRender;
        const live = (typeof Streamer!=='undefined' && Streamer.getCleanNow)
          ? Streamer.getCleanNow(i) : '';
        const cached = TransStore.get(String(i)) || '';
        const best = live || cached;
        if (best) this.applyIncremental(i, best);
        // If this chunk is fully done, move to the next and continue draining.
        const isDone = !!(TransStore && TransStore._done && TransStore._done[i]);
        if (isDone) {
          this.nextToRender++;
          continue;
        }
        // Current chunk not finished; stop here and wait for more delta/done.
        break;
      }
    }
  };

  const View = {
    mode: 'trans',
    ensure(){ return ensureRenderContainer(); },
    info(msg){ let n=$('#ao3x-info'); if(!n){ n=document.createElement('div'); n.id='ao3x-info'; n.className='ao3x-small'; this.ensure().prepend(n); } n.textContent=msg; },
    clearInfo(){ const n=$('#ao3x-info'); if(n) n.remove(); },
    setMode(m){ this.mode=m; this.applyHostVisibility(); this.refresh(true); },
    applyHostVisibility(){ const container = this.ensure(); if(this.mode==='trans' || this.mode==='bi'){ SelectedNodes.forEach(n=> n.style.display='none'); container.style.display=''; } else { SelectedNodes.forEach(n=> n.style.display=''); container.style.display='none'; } },
    refresh(initial=false){
      if(this.mode==='bi' && Bilingual.canRender()){ this.renderBilingual(); return; }
      const c=this.ensure();
      if (initial) {
        const next = RenderState.nextToRender || 0;
        c.querySelectorAll('.ao3x-block').forEach(block=>{
          const idxStr = block.getAttribute('data-index');
          const i = Number(idxStr);
          const orig = block.getAttribute('data-original-html') || '';
          if(this.mode==='trans'){
            let contentHTML = '';
            if (i < next) {
              // Already rendered; keep lastApplied or cached
              contentHTML = (RenderState.lastApplied[i]) || TransStore.get(idxStr) || '';
            } else if (i === next) {
              // Current chunk: show live snapshot if any, else cached, else placeholder
              const live = (typeof Streamer!=='undefined' && Streamer.getCleanNow) ? Streamer.getCleanNow(i) : '';
              contentHTML = live || TransStore.get(idxStr) || '';
            } else {
              // Future chunks stay as placeholder to avoid out-of-order leakage
              contentHTML = '';
            }
            const transHTML = contentHTML || '<span class="ao3x-muted">（待译）</span>';
            block.innerHTML = `<span class="ao3x-anchor" data-chunk-id="${idxStr}"></span><div class="ao3x-translation">${transHTML}</div>`;
            // Only sync lastApplied for already-rendered/current chunk
            if (typeof RenderState !== 'undefined' && RenderState.lastApplied) {
              if (i <= next) RenderState.lastApplied[i] = contentHTML || '';
            }
          } else if(this.mode==='orig'){
            block.innerHTML = `<span class="ao3x-anchor" data-chunk-id="${idxStr}"></span>${orig}`;
          }
          block.setAttribute('data-original-html', orig);
        });
      }
    },
    renderBilingual(){
      const c=this.ensure(); const blocks = Array.from(c.querySelectorAll('.ao3x-block'));
      d('bilingual:render_start', { blockCount: blocks.length, mode: this.mode });
      
      blocks.forEach(block=>{
        const idx = block.getAttribute('data-index');
        const orig = block.getAttribute('data-original-html') || '';
        const trans = TransStore.get(idx);
        
        d('bilingual:processing_block', { 
          index: idx, 
          hasOriginal: !!orig, 
          hasTranslation: !!trans, 
          originalLength: orig.length,
          translationLength: trans ? trans.length : 0
        });
        
        const pairs = Bilingual.pairByParagraph(orig, trans);
        const html = pairs.map(p => `<div class="ao3x-pair"><div class="orig">${p.orig}</div><div class="trans">${p.trans||'<span class="ao3x-muted">（无译文）</span>'}</div></div>`).join('');
        block.innerHTML = `<span class="ao3x-anchor" data-chunk-id="${idx}"></span>${html}`;
      });
    },
    setBlockTranslation(idx, html){
      TransStore.set(String(idx), html);
      if (RenderState.canRender(Number(idx))) {
        RenderState.applyIncremental(Number(idx), html);
      }
      if(this.mode==='bi' && Bilingual.canRender()){ this.renderBilingual(); }
    }
  };
  const Bilingual = {
    canRender(){ return this._total != null && TransStore.allDone(this._total); },
    setTotal(n){ this._total = n; }, _total: null,
    splitParagraphs(html){
      const div = document.createElement('div'); div.innerHTML = html; const out = [];
      // 只选择顶层元素，避免重复处理嵌套的块级元素
      Array.from(div.children).filter(el =>
        el.matches('p, li, blockquote, pre, div')
      ).forEach(el=>{
        const text=el.textContent||'';
        // 保留所有段落，包括只有空格的段落
        out.push(el.outerHTML);
      });

      // 如果没有找到块级元素，尝试多种分割方式
      if(!out.length){
        // 首先尝试用 <br> 分割，保留空内容
        const raw=(div.innerHTML||'').split(/<br\s*\/?>/i);
        if(raw.length > 1){
          return raw.map(x=>`<p>${x}</p>`);
        }

        // 如果还是只有一段，检查是否有换行符，保留空行
        const textContent = div.textContent || '';
        // 尝试用换行符分割，保留空行
        const lines = textContent.split(/\n+/);
        if(lines.length > 1){
          return lines.map(line => `<p>${line}</p>`);
        }

        // 如果还是只有一段，直接包装成 <p>
        return [`<p>${textContent}</p>`];
      }

      return out;
    },
    pairByParagraph(origHTML, transHTML){
      // 尝试智能段落匹配
      const o = this.splitParagraphs(origHTML);
      const t = this.splitParagraphs(transHTML);
      
      // 如果段落数量不匹配，使用顺序匹配策略
      if (o.length !== t.length) {
        return this.sequentialPairFallback(origHTML, transHTML);
      }
      
      // 段落数量匹配，正常配对
      const m = Math.max(o.length, t.length);
      const pairs = new Array(m);
      for (let i = 0; i < m; i++) {
        pairs[i] = { orig: o[i] || '', trans: t[i] || '' };
      }
      return pairs;
    },
    
    // 兜底策略：顺序匹配，确保1对1对应
    sequentialPairFallback(origHTML, transHTML){
      const o = this.splitParagraphs(origHTML);
      const t = this.splitParagraphs(transHTML);
      const m = Math.max(o.length, t.length);
      const pairs = new Array(m);
      
      for (let i = 0; i < m; i++) {
        pairs[i] = { 
          orig: o[i] || '', 
          trans: t[i] || '' 
        };
      }
      
      console.log('Bilingual: Using sequential fallback pairing', {
        origParagraphs: o.length,
        transParagraphs: t.length,
        totalPairs: m
      });
      
      return pairs;
    },
  };

  function renderPlanAnchors(plan){
    const c = ensureRenderContainer(); c.innerHTML='';
    const box = document.createElement('div'); box.id='ao3x-plan'; box.className='ao3x-plan'; c.appendChild(box);
    const rows = plan.map((p,i)=>{
      const text = stripHtmlToText(p.text||p.html);
      const head = text.slice(0,48); const tail = text.slice(-48);
      return `<div class="row"><b>#${i}</b> <span class="ao3x-small">in≈${p.inTok||0}</span> ｜ <span class="ao3x-small">开头：</span>${escapeHTML(head)} <span class="ao3x-small">…结尾：</span>${escapeHTML(tail)}</div>`;
    }).join('');
    box.innerHTML = `<h4>切块计划：共 ${plan.length} 块</h4>${rows}<div class="ao3x-kv" id="ao3x-kv"></div>`;

    plan.forEach((p,i)=>{
      const wrapper=document.createElement('div'); wrapper.className='ao3x-block'; wrapper.setAttribute('data-index', String(i)); wrapper.setAttribute('data-original-html', p.html);
      const anchor=document.createElement('span'); anchor.className='ao3x-anchor'; anchor.setAttribute('data-chunk-id', String(i)); wrapper.appendChild(anchor);
      const div=document.createElement('div'); div.className='ao3x-translation'; div.innerHTML='<span class="ao3x-muted">（待译）</span>';
      wrapper.appendChild(div);
      c.appendChild(wrapper);
    });
  }
  function appendPlanAnchorsFrom(plan, startIndex){
    const c = ensureRenderContainer();
    let box = c.querySelector('#ao3x-plan');
    if (!box){ box=document.createElement('div'); box.id='ao3x-plan'; box.className='ao3x-plan'; c.prepend(box); }
    // Update plan header count
    const rows = plan.slice(startIndex).map((p,i)=>{
      const idx = startIndex + i;
      const text = stripHtmlToText(p.text||p.html);
      const head = text.slice(0,48); const tail = text.slice(-48);
      return `<div class="row"><b>#${idx}</b> <span class="ao3x-small">in≈${p.inTok||0}</span> ｜ <span class="ao3x-small">开头：</span>${escapeHTML(head)} <span class="ao3x-small">…结尾：</span>${escapeHTML(tail)}</div>`;
    }).join('');
    const kv = `<div class="ao3x-kv" id="ao3x-kv"></div>`;
    const headHtml = `<h4>切块计划：共 ${plan.length} 块</h4>`;
    const fixed = Array.from(box.querySelectorAll('.row')).slice(0, startIndex).map(n=>n.outerHTML).join('');
    box.innerHTML = headHtml + fixed + rows + kv;

    for (let i=startIndex; i<plan.length; i++){
      if (c.querySelector(`[data-chunk-id="${i}"]`)) continue; // already exists
      const p = plan[i];
      const wrapper=document.createElement('div'); wrapper.className='ao3x-block'; wrapper.setAttribute('data-index', String(i)); wrapper.setAttribute('data-original-html', p.html);
      const anchor=document.createElement('span'); anchor.className='ao3x-anchor'; anchor.setAttribute('data-chunk-id', String(i)); wrapper.appendChild(anchor);
      const div=document.createElement('div'); div.className='ao3x-translation'; div.innerHTML='<span class="ao3x-muted">（待译）</span>';
      wrapper.appendChild(div);
      c.appendChild(wrapper);
    }
  }

  /* ================= Planner helpers (dynamic coalesce) ================= */
  async function coalescePlanForRemaining(plan, startIndex, budgetTokens){
    // 把“未开始”的块尽量合并，减少请求次数
    const remain = plan.slice(startIndex).map(x => x.html);
    if (!remain.length) return plan;
    const packed = await packIntoChunks(remain, budgetTokens);
    // 重新编号并拼回
    const head = plan.slice(0, startIndex);
    const reindexed = packed.map((p, idx) => ({...p, index: head.length + idx}));
    return head.concat(reindexed);
  }

  /* ================= Controller ================= */
  const Controller = {
    // 直接应用到已有 DOM（不受顺序指针限制），用于重试/修复历史块
    applyDirect(i, html){
      const c = document.querySelector('#ao3x-render'); if (!c) return;
      const anchor = c.querySelector(`[data-chunk-id="${i}"]`); if (!anchor) return;
      let transDiv = anchor.parentElement.querySelector('.ao3x-translation');
      if (!transDiv) { transDiv = document.createElement('div'); transDiv.className='ao3x-translation'; anchor.insertAdjacentElement('afterend', transDiv); }
      transDiv.innerHTML = html || '<span class="ao3x-muted">（待译）</span>';
      if (RenderState && RenderState.lastApplied) RenderState.lastApplied[i] = html || '';
    },

    // 收集“未完成/失败”的索引
    collectIncompleteIndices(){
      const total = RenderState.total || 0; const out = [];
      for (let i=0;i<total;i++){
        const done = !!(TransStore._done && TransStore._done[i]);
        const html = TransStore.get(String(i)) || '';
        const failed = /\[该段失败：|\[请求失败：/.test(html);
        if (!done || failed || !html) out.push(i);
      }
      return out;
    },

    // 仅重试未完成/失败的块（断点续传）
    async retryIncomplete(){
      const s = settings.get();
      const indices = this.collectIncompleteIndices();
      if (!indices.length) { UI.toast('没有需要重试的段落'); return; }
      UI.toast(`重试 ${indices.length} 段…`);

      const c = document.querySelector('#ao3x-render'); if (!c) { UI.toast('未找到渲染容器'); return; }

      // 构造子计划（复用 data-original-html）
      const subPlan = indices.map(i => {
        const block = c.querySelector(`.ao3x-block[data-index="${i}"]`);
        const html = block ? (block.getAttribute('data-original-html') || '') : '';
        return { index: i, html };
      });

      // 状态计数
      let inFlight = 0, completed = 0, failed = 0;
      updateKV({ 进行中: inFlight, 完成: completed, 失败: failed });

      const postOne = (idx) => {
        // 清理旧状态（允许再次写入）
        TransStore.set(String(idx), '');
        if (TransStore._done) delete TransStore._done[idx];

        const label = `retry#${idx}`;
        inFlight++; updateKV({ 进行中: inFlight, 完成: completed, 失败: failed });
        postChatWithRetry({
          endpoint: resolveEndpoint(s.api.baseUrl, s.api.path),
          key: s.api.key,
          payload: {
            model: settings.get().model.id,
            messages: [
              { role:'system', content: settings.get().prompt.system },
              { role:'user',   content: settings.get().prompt.userTemplate.replace('{{content}}', subPlan.find(p=>p.index===idx).html) }
            ],
            temperature: settings.get().gen.temperature,
            max_tokens: settings.get().gen.maxTokens === -1 ? undefined : settings.get().gen.maxTokens,
            stream: !!settings.get().stream.enabled
          },
          stream: s.stream.enabled,
          label,
          onDelta: (delta) => { Streamer.push(idx, delta, (k, clean)=>{ TransStore.set(String(k), clean); Controller.applyDirect(k, clean); }); },
          onFinishReason: (fr)=>{ d('retry:finish_reason', {idx, fr}); },
          onDone: () => {
            TransStore.markDone(idx);
            inFlight--; completed++;
            // Update plan status for retry
            if (plan[idx]) {
              plan[idx].status = 'completed';
              plan[idx].error = null;
              renderPlanSummary(plan);
            }
            Streamer.done(idx, (k, clean)=>{ TransStore.set(String(k), clean); Controller.applyDirect(k, clean); });
            // 若正好轮到该块，也推进一次顺序渲染
            if (RenderState.canRender(idx)) RenderState.finalizeCurrent();
            updateKV({ 进行中: inFlight, 完成: completed, 失败: failed });
          },
          onError: (e) => {
            inFlight--; failed++;
            const msg = (TransStore.get(String(idx))||'') + `<p class="ao3x-muted">[该段失败：${e.message}]</p>`;
            TransStore.set(String(idx), msg);
            TransStore.markDone(idx);
            Controller.applyDirect(idx, msg);
            if (RenderState.canRender(idx)) RenderState.finalizeCurrent();
            updateKV({ 进行中: inFlight, 完成: completed, 失败: failed });
          }
        });
      };

      // 顺序/小并发重试（按设置并发）
      const conc = Math.max(1, s.concurrency || 2);
      let ptr = 0; let running = 0;
      await new Promise(resolve => {
        const kick = () => {
          while (running < conc && ptr < indices.length){
            const i = indices[ptr++]; running++;
            postOne(i);
            // 监听完成：通过轮询观察已完成数量
          }
          if (completed + failed >= indices.length) resolve(); else setTimeout(kick, 120);
        };
        kick();
      });

      // 最后兜底刷新与双语视图
      finalFlushAll(RenderState.total || 0);
      try { if (View && View.mode === 'bi' && Bilingual.canRender()) View.renderBilingual(); } catch {}
      UI.toast('重试完成');
      UI.updateToolbarState(); // 更新工具栏状态
    },
    async startTranslate(){
      const nodes = collectChapterUserstuffSmart(); if(!nodes.length){ UI.toast('未找到章节正文'); return; }
      markSelectedNodes(nodes); renderContainer = null; UI.showToolbar(); View.info('准备中…');

      // Save original node information for better cache matching
      if (typeof TransStore !== 'undefined') {
        TransStore.saveOriginalNodeInfo(nodes);
      }

      const s = settings.get();
      const allHtml = nodes.map(n=>n.innerHTML);
      const fullHtml = allHtml.join('\n');
      const ratio = Math.max(0.3, s.planner?.ratioOutPerIn ?? 0.7);
      const reserve = s.planner?.reserve ?? 384;
      const packSlack = Math.max(0.5, Math.min(1, s.planner?.packSlack ?? 0.95));

      // 固定prompt token（不含正文）
      const promptTokens = await estimatePromptTokensFromMessages([
        { role:'system', content: s.prompt.system || '' },
        { role:'user',   content: (s.prompt.userTemplate || '').replace('{{content}}','') }
      ]);

      const allText = stripHtmlToText(fullHtml);
      const allEstIn = await estimateTokensForText(allText);

      const cw   = s.model.contextWindow || 8192;
      const maxT = s.gen.maxTokens === -1 ? 999999 : s.gen.maxTokens || 1024; // Use unlimited when -1
      // ★ 核心预算：k<1 时更"能塞"
      // 约束1：out = k * in ≤ max_tokens  → in ≤ max_tokens / k
      // 约束2：prompt + in + out + reserve ≤ cw → in(1+k) ≤ (cw - prompt - reserve)
      const cap1 = s.gen.maxTokens === -1 ? 999999 : maxT / ratio; // 当max_tokens=-1时，不受输出限制
      const cap2 = (cw - promptTokens - reserve) / (1 + ratio);
      const maxInputBudgetRaw = Math.max(0, Math.min(cap1, cap2));
      const maxInputBudget    = Math.floor(maxInputBudgetRaw * packSlack);

      const slackSingle = s.planner?.singleShotSlackRatio ?? 0.15;
      const canSingle   = allEstIn <= maxInputBudget * (1 + Math.max(0, slackSingle));

      d('budget', { contextWindow: cw, promptTokens, reserve, userMaxTokens: maxT, ratio, packSlack, maxInputBudget, allEstIn, canSingle });

      // 规划
      let plan = [];
      if (canSingle) {
        const inTok = await estimateTokensForText(allText);
        plan = [{ index: 0, html: fullHtml, text: allText, inTok }];
      } else {
        plan = await packIntoChunks(allHtml, maxInputBudget);
      }
      d('plan', { chunks: plan.length, totalIn: allEstIn, inputBudget: maxInputBudget });

      renderPlanAnchors(plan);
      View.setMode('trans');
      RenderState.setTotal(plan.length);
      Bilingual.setTotal(plan.length);
      updateKV({ 进行中: 0, 完成: 0, 失败: 0 });

      // 运行
      try {
        if (plan.length === 1 && canSingle && (s.planner?.trySingleShotOnce !== false)) {
          View.info('单次请求翻译中…');
          await this.translateSingle({
            endpoint: resolveEndpoint(s.api.baseUrl, s.api.path),
            key: s.api.key,
            stream: s.stream.enabled,
            modelCw: s.model.contextWindow,
            ratio,
            promptTokens,
            reserve,
            contentHtml: plan[0].html,
            inTok: plan[0].inTok,
            userMaxTokens: s.gen.maxTokens
          });
          View.clearInfo();
          finalFlushAll(1);
          return;
        }
        View.info('文本较长：已启用智能分段 + 并发流水线…');
        await this.translateConcurrent({
          endpoint: resolveEndpoint(s.api.baseUrl, s.api.path),
          key: s.api.key,
          plan,
          concurrency: s.concurrency,
          stream: s.stream.enabled,
          modelCw: s.model.contextWindow,
          ratio,
          promptTokens,
          reserve,
          userMaxTokens: s.gen.maxTokens
        });
        View.clearInfo();
      } catch(e) {
        d('fatal', e);
        UI.toast('翻译失败：' + e.message);
      }
    },

    // 单次请求：max_tokens 基于真实 inTok 与 ratio
    async translateSingle({ endpoint, key, stream, modelCw, ratio, promptTokens, reserve, contentHtml, inTok, userMaxTokens }){
      const predictedOut = Math.ceil(inTok * ratio);
      const outCapByCw   = Math.max(256, modelCw - promptTokens - inTok - reserve);
      const maxTokensLocal = Math.max(256, Math.min(userMaxTokens === -1 ? 999999 : userMaxTokens, outCapByCw, predictedOut));
      d('single:tokens', { inTok, predictedOut, outCapByCw, userMaxTokens, maxTokensLocal });
      if (maxTokensLocal < 256) throw new Error('上下文空间不足');

      const i = 0;
      await postChatWithRetry({
        endpoint, key, stream,
        payload: (() => {
          const basePayload = {
            model: settings.get().model.id,
            messages: [
              { role:'system', content: settings.get().prompt.system },
              { role:'user',   content: settings.get().prompt.userTemplate.replace('{{content}}', contentHtml) }
            ],
            temperature: settings.get().gen.temperature,
            stream: !!settings.get().stream.enabled
          };

          // Only include max_tokens if it's not -1
          if (maxTokensLocal !== -1) {
            basePayload.max_tokens = maxTokensLocal;
          }

          return basePayload;
        })(),
        label:`single#${i}`,
        onDelta: (delta)=>{ Streamer.push(i, delta, (k, clean)=>{ View.setBlockTranslation(k, clean); }); },
        onRetry: () => { TransStore.set(String(i), ''); }, // Clear cache on retry
        onFinishReason: (fr)=>{
            d('finish_reason', {i, fr});
            // Store finish reason in plan
            if (plan[i] && fr) {
              plan[i].finishReason = fr;
              renderPlanSummary(plan);
            }
          },
        onDone: async () => {
          TransStore.markDone(i);
          Streamer.done(i, (k, clean) => { View.setBlockTranslation(k, clean); });
          // Ensure final content is applied once before advancing
          try {
            const cached = TransStore.get(String(i)) || '';
            if (cached) RenderState.applyIncremental(i, cached);
          } catch {}
          RenderState.finalizeCurrent();
          finalFlushAll(1);
          UI.updateToolbarState(); // 更新工具栏状态
          if (View && View.mode === 'bi' && Bilingual && Bilingual.canRender && Bilingual.canRender()) {
            try { View.renderBilingual(); } catch {}
          }
          },
          onError: (e)=>{
            // Mark as done with failure note so render can advance and UI不会卡住
            const msg = `<p class="ao3x-muted">[请求失败：${e.message}]</p>`;
            const prev = TransStore.get(String(i)) || '';
            TransStore.set(String(i), prev + msg);
            TransStore.markDone(i);
            View.setBlockTranslation(i, prev + msg);
            RenderState.finalizeCurrent();
            throw e;
          }
      });
    },

    // 分块并发：含动态校准 ratio（首块实测 out/in），对“未启动的块”合包重排，减少请求次数
    async translateConcurrent({ endpoint, key, plan, concurrency, stream, modelCw, ratio, promptTokens, reserve, userMaxTokens }){
      const N = plan.length;
      RenderState.setTotal(N);
      Bilingual.setTotal(N);

      let inFlight=0, nextToStart=0, completed=0, failed=0;
      let calibrated = false;
      let liveRatio  = ratio; // 运行期实时 ratio
      let currentBudget = Math.floor(Math.max(0, Math.min(userMaxTokens === -1 ? 999999 : userMaxTokens/liveRatio, (modelCw - promptTokens - reserve)/(1+liveRatio))) * (settings.get().planner.packSlack || 0.95));

      const started = new Set(); // 已经发出的 index

      // Network performance tracking
      const networkStats = {
        requestTimes: [],
        errorCount: 0,
        lastErrorTime: 0,
        averageResponseTime: 0,
        adaptiveConcurrency: Math.max(1, concurrency), // Start with user-defined concurrency
        isOnline: navigator.onLine,
        lastOnlineCheck: Date.now(),
        consecutiveErrors: 0,
        networkRecoveryDetected: false
      };

      // Network status monitoring
      const checkNetworkStatus = () => {
        const wasOnline = networkStats.isOnline;
        networkStats.isOnline = navigator.onLine;
        networkStats.lastOnlineCheck = Date.now();

        // Detect network recovery
        if (!wasOnline && networkStats.isOnline) {
          networkStats.networkRecoveryDetected = true;
          networkStats.consecutiveErrors = 0; // Reset error count on recovery
          d('network:recovery', { timestamp: Date.now() });
        }

        return networkStats.isOnline;
      };

      // Check network status periodically
      setInterval(checkNetworkStatus, 2000);

      const updateNetworkStats = (success, duration, error = null) => {
        if (success) {
          networkStats.requestTimes.push(duration);
          // Keep only last 10 requests for moving average
          if (networkStats.requestTimes.length > 10) {
            networkStats.requestTimes.shift();
          }
          networkStats.averageResponseTime = networkStats.requestTimes.reduce((a, b) => a + b, 0) / networkStats.requestTimes.length;

          // Reset consecutive errors on success
          networkStats.consecutiveErrors = 0;

          // Adjust concurrency based on performance - more conservative adjustments
          if (networkStats.averageResponseTime < 3000 && networkStats.errorCount < 2) {
            // Gradually increase concurrency when performance is good
            networkStats.adaptiveConcurrency = Math.min(concurrency, networkStats.adaptiveConcurrency + 0.5);
          } else if (networkStats.averageResponseTime > 8000 || networkStats.errorCount > 5) {
            // Gradually decrease concurrency when performance is poor
            networkStats.adaptiveConcurrency = Math.max(1, networkStats.adaptiveConcurrency - 0.5);
          }
        } else {
          networkStats.errorCount++;
          networkStats.consecutiveErrors++;
          networkStats.lastErrorTime = Date.now();

          // More aggressive reduction for network errors
          const isNetworkError = error && (
            error.message.includes('fetch') ||
            error.message.includes('network') ||
            error.message.includes('timeout') ||
            error.message.includes('ECONN') ||
            !networkStats.isOnline
          );

          if (isNetworkError) {
            // Reduce concurrency more aggressively for network issues
            networkStats.adaptiveConcurrency = Math.max(1, networkStats.adaptiveConcurrency - 1);
          } else {
            // More gradual reduction for other errors
            networkStats.adaptiveConcurrency = Math.max(1, networkStats.adaptiveConcurrency - 0.5);
          }
        }
      };

      const startNext = ()=>{
        const effectiveConcurrency = Math.floor(networkStats.adaptiveConcurrency);
        while(inFlight < effectiveConcurrency && nextToStart < plan.length){
          startChunk(nextToStart++);
        }
      };

      const startChunk = (i)=>{
        started.add(i);
        // Update plan status
        if (plan[i]) {
          plan[i].status = 'in_progress';
          plan[i].error = null;
          plan[i].finishReason = null;
          // Update plan display
          renderPlanSummary(plan);
        }
        const inputTok = plan[i].inTok != null ? plan[i].inTok : 0;
        const predictedOut = Math.ceil(inputTok * liveRatio);
        const outCapByCw   = Math.max(256, modelCw - promptTokens - inputTok - reserve);
        let maxTokensLocal = Math.max(256, Math.min(userMaxTokens === -1 ? 999999 : userMaxTokens, outCapByCw, predictedOut));
        const label = `chunk#${i}`;
        inFlight++; updateKV({ 进行中: inFlight, 完成: completed, 失败: failed });
        const begin = performance.now();
        d('chunk:start', {i, inFlight, nextToStart, nextToRender: RenderState.nextToRender, inputTok, predictedOut, outCapByCw, maxTokensLocal, liveRatio});

        postChatWithRetry({
          endpoint, key, payload: {
            model: settings.get().model.id,
            messages: [
              { role:'system', content: settings.get().prompt.system },
              { role:'user',   content: settings.get().prompt.userTemplate.replace('{{content}}', plan[i].html) }
            ],
            temperature: settings.get().gen.temperature,
            max_tokens: maxTokensLocal === -1 ? undefined : maxTokensLocal,
            stream: !!settings.get().stream.enabled
          }, stream, label,
          onDelta: (delta)=>{ Streamer.push(i, delta, (k, clean)=>{ View.setBlockTranslation(k, clean); }); },
          onRetry: () => { TransStore.set(String(i), ''); }, // Clear cache on retry
          onFinishReason: async (fr)=>{
            d('finish_reason', {i, fr});
            if(fr === 'length'){
              // 优先：适度扩大 out，再次尝试一次
              const extra = Math.floor(maxTokensLocal * 0.5);
              const newOutCapByCw = Math.max(256, modelCw - promptTokens - inputTok - reserve);
              const maybe = Math.min(userMaxTokens === -1 ? 999999 : userMaxTokens, newOutCapByCw);
              if (maxTokensLocal + extra <= maybe && extra >= 128) {
                const newMax = maxTokensLocal + extra;
                d('length:increase-max_tokens', {i, from:maxTokensLocal, to:newMax});
                TransStore.set(String(i), ''); // 清空已输出以免重复
                await postChatWithRetry({
                  endpoint, key, stream, label: `chunk#${i}-retry-max`,
                  payload: {
                    model: settings.get().model.id,
                    messages: [
                      { role:'system', content: settings.get().prompt.system },
                      { role:'user',   content: settings.get().prompt.userTemplate.replace('{{content}}', plan[i].html) }
                    ],
                    temperature: settings.get().gen.temperature,
                    max_tokens: newMax === -1 ? undefined : newMax,
                    stream: !!settings.get().stream.enabled
                  },
                  onDelta: (delta)=>{ Streamer.push(i, delta, (k, clean)=>{ View.setBlockTranslation(k, clean); }); },
                  onFinishReason: (fr2)=>{
                    d('finish_reason(second)', {i, fr2});
                    // Store finish reason in plan
                    if (plan[i] && fr2) {
                      plan[i].finishReason = fr2;
                      renderPlanSummary(plan);
                    }
                  },
                  onDone: ()=>{},
                  onError: (e)=>{ d('length:retry-max error', e); }
                });
              } else {
                // 次选：对该块更细切（一般不会走到这里，因为我们有真实计数）
                d('length:rechunk', {i});
              }
            }
          },
          onDone: async () => {
            const duration = performance.now() - begin;
            TransStore.markDone(i);
            inFlight--; completed++;
            // Update plan status
            if (plan[i]) {
              plan[i].status = 'completed';
              plan[i].error = null;
              renderPlanSummary(plan);
            }
            updateNetworkStats(true, duration);
            d('chunk:done', {i, ms: Math.round(duration), concurrency: networkStats.adaptiveConcurrency});
            Streamer.done(i, (k, clean) => { View.setBlockTranslation(k, clean); });
            // Ensure final content is applied once before advancing
            try {
              const cached = TransStore.get(String(i)) || '';
              if (cached) RenderState.applyIncremental(i, cached);
            } catch {}

            // ★ 动态校准：首个完成的块，实测 out/in（真实 token）
            if (!calibrated) {
              calibrated = true;
              const outHtml  = TransStore.get(String(i)) || '';
              const outTok   = await estimateTokensForText(stripHtmlToText(outHtml));
              const inTok    = plan[i].inTok || 1;
              let observedK  = outTok / inTok;
              // 限制范围，避免异常
              observedK = Math.min(1.2, Math.max(0.4, observedK));
              if (Math.abs(observedK - liveRatio) > 0.08) {
                liveRatio = (liveRatio*0.3 + observedK*0.7); // 比重偏向实测
                currentBudget = Math.floor(Math.max(0, Math.min(userMaxTokens === -1 ? 999999 : userMaxTokens/liveRatio, (modelCw - promptTokens - reserve)/(1+liveRatio))) * (settings.get().planner.packSlack || 0.95));
                d('calibrate', { observedK, liveRatio, currentBudget });

                // 对“未启动”的部分合包重排，减少请求次数
                const notStartedFrom = nextToStart;
                if (notStartedFrom < plan.length) {
                  const before = plan.slice(0, notStartedFrom);
                  const coalesced = await packIntoChunks(plan.slice(notStartedFrom).map(p=>p.html), currentBudget);
                  plan = before.concat(coalesced.map((p,idx)=>({ ...p, index: before.length + idx })));
                  // 仅为未启动部分追加锚点，不重置已有 DOM 和状态
                  appendPlanAnchorsFrom(plan, notStartedFrom);
                  // 仅更新总数，不重置 next 指针
                  if (typeof RenderState !== 'undefined') RenderState.total = plan.length;
                  Bilingual.setTotal(plan.length);
                }
              }
            }

            if (RenderState.canRender(i)) RenderState.finalizeCurrent();
            updateKV({ 进行中: inFlight, 完成: completed, 失败: failed });
            UI.updateToolbarState(); // 更新工具栏状态
            startNext();
          },
          onError: (e)=>{
            const duration = performance.now() - begin;
            inFlight--; failed++;
            // Update plan status
            if (plan[i]) {
              plan[i].status = 'failed';
              plan[i].error = e.message;
              renderPlanSummary(plan);
            }
            updateNetworkStats(false, duration, e);
            d('chunk:error', {i, err: e.message, concurrency: networkStats.adaptiveConcurrency});
            const clean=(TransStore.get(String(i))||'')+`<p class="ao3x-muted">[该段失败：${e.message}]</p>`;
            TransStore.set(String(i), clean);
            TransStore.markDone(i);
            View.setBlockTranslation(i, clean);
            RenderState.finalizeCurrent();
            updateKV({ 进行中: inFlight, 完成: completed, 失败: failed });
            // Smart delay before next request after error
            const isNetworkError = e.message.includes('fetch') || e.message.includes('network') || e.message.includes('timeout') || e.message.includes('ECONN');
            const isNetworkRecovery = networkStats.networkRecoveryDetected;

            let delay = 200; // Base delay

            if (isNetworkRecovery) {
              // Fast retry when network recovers
              delay = 100;
              networkStats.networkRecoveryDetected = false; // Reset flag
            } else if (isNetworkError) {
              // Moderate delay for network errors
              delay = Math.min(800, 300 + networkStats.consecutiveErrors * 100);
            } else {
              // Longer delay for other errors
              delay = Math.min(1500, 500 + networkStats.consecutiveErrors * 200);
            }

            setTimeout(() => startNext(), delay);
          }
        });
      };

      // 启动并发
      startNext();
      // 顺序推进直至全部完成
      while(RenderState.nextToRender < plan.length){ await sleep(80); }
      // 兜底一次：确保没有残留“待译”
      finalFlushAll(plan.length);
      UI.updateToolbarState(); // 更新工具栏状态
      // If in bilingual mode, render paired view now that all are done
      try { if (View && View.mode === 'bi') View.renderBilingual(); } catch {}
    }
  };

  /* ================= Streamer（增量 + 有序；含实时快照） ================= */
  const Streamer = {
    _buf: new Map(), // Use Map instead of Object.create(null)
    _dirty: new Map(), // Use Map instead of Object.create(null)
    _completed: new Set(), // Track completed chunks
    _raf: null,
    _last: 0,
    _maxBufferSize: 30, // Maximum number of chunks to keep in memory
    _cleanupThreshold: 20, // Start cleanup when we have this many chunks

    push(i, delta, apply) {
      const key = String(i);
      const current = this._buf.get(key) || '';
      this._buf.set(key, current + delta);
      this._dirty.set(key, true);

      // Cleanup if buffer is getting too large
      if (this._buf.size > this._cleanupThreshold) {
        this._cleanup();
      }

      this.schedule((k, clean)=>apply(k, clean));
    },

    done(i, apply) {
      const key = String(i);
      this._completed.add(key);
      this._dirty.set(key, true);
      this.schedule((k, clean)=>apply(k, clean), true);
    },

    getCleanNow(i){
      const key = String(i);
      const raw = this._buf.get(key) || '';
      if (!raw) return '';
      // 过滤思考内容
      const filtered = filterThinkingContent(raw);
      const html = /[<][a-zA-Z]/.test(filtered) ? filtered : filtered.replace(/\n/g, '<br/>');
      return sanitizeHTML(html);
    },

    _cleanup() {
      // Clean up completed chunks that are no longer needed
      const completedKeys = Array.from(this._completed);
      const keysToKeep = completedKeys.slice(-10); // Keep last 10 completed chunks

      completedKeys.forEach(key => {
        if (!keysToKeep.includes(key)) {
          this._buf.delete(key);
          this._dirty.delete(key);
          this._completed.delete(key);
        }
      });

      // Also clean up any dirty chunks that are too old
      const allKeys = Array.from(this._buf.keys());
      if (allKeys.length > this._maxBufferSize) {
        const keysToRemove = allKeys.slice(0, allKeys.length - this._maxBufferSize);
        keysToRemove.forEach(key => {
          if (!this._completed.has(key)) {
            this._buf.delete(key);
            this._dirty.delete(key);
          }
        });
      }
    },

    clear() {
      this._buf.clear();
      this._dirty.clear();
      this._completed.clear();
      if (this._raf) {
        cancelAnimationFrame(this._raf);
        this._raf = null;
      }
    },

    schedule(apply, force = false) {
      const { minFrameMs } = (typeof settings !== 'undefined' ? settings.get().stream : { minFrameMs: 40 });
      if (this._raf) return;

      const tick = () => {
        this._raf = null;
        const now = performance.now();
        if (!force && now - this._last < (minFrameMs ?? 40)) {
          this._raf = requestAnimationFrame(tick);
          return;
        }
        this._last = now;

        const dirtyKeys = Array.from(this._dirty.keys()).filter(k => this._dirty.get(k));
        const batchUpdates = [];

        // Batch updates for better performance
        for (const k of dirtyKeys) {
          const raw = this._buf.get(k) || '';
          // 过滤思考内容
          const filtered = filterThinkingContent(raw);
          const html = /[<][a-zA-Z]/.test(filtered) ? filtered : filtered.replace(/\n/g, '<br/>');
          const clean = sanitizeHTML(html);
          this._dirty.set(k, false);
          batchUpdates.push({ k: Number(k), clean });
        }

        // Apply all updates in batch
        batchUpdates.forEach(({ k, clean }) => apply(k, clean));

        if (Array.from(this._dirty.values()).some(Boolean)) {
          this._raf = requestAnimationFrame(tick);
        }
      };

      this._raf = requestAnimationFrame(tick);
    }
  };

  /* ================= 兜底：终局强制刷新 ================= */
  function finalFlushAll(total){
    const c = document.querySelector('#ao3x-render');
    if (!c) return;
    for (let i = 0; i < total; i++){
      const html = TransStore.get(String(i)) || '';
      const anchor = c.querySelector(`[data-chunk-id="${i}"]`);
      if (!anchor) continue;
      let transDiv = anchor.parentElement.querySelector('.ao3x-translation');
      if(!transDiv){
        transDiv = document.createElement('div');
        transDiv.className = 'ao3x-translation';
        anchor.insertAdjacentElement('afterend', transDiv);
      }
      transDiv.innerHTML = html || '<span class="ao3x-muted">（待译）</span>';
      if (RenderState && RenderState.lastApplied) {
        RenderState.lastApplied[i] = html;
      }
    }
    if (settings.get().debug) console.log('[AO3X] drain: flushed all blocks into DOM');
  }

  /* ================= Boot ================= */
  function init(){
    // Initialize performance monitoring
    PerfMonitor.mark('init_start');

    UI.init();
    applyFontSize(); // 应用初始字体大小设置

    // Initialize memory management and load cached translations
    if (typeof TransStore !== 'undefined') {
      TransStore.checkUrl(); // Check if URL changed
      const loadResult = TransStore.loadFromPersistent();
      d('cache:load_result', { success: loadResult, url: TransStore._currentUrl });
      if (!loadResult) {
        TransStore.clear(); // Only clear if no cache or URL changed
      }
    }
    if (typeof Streamer !== 'undefined') {
      Streamer.clear();
    }
    if (typeof RenderState !== 'undefined') {
      RenderState._domCache.clear();
    }

    const nodes = collectChapterUserstuffSmart();
    if (!nodes.length) UI.toast('未找到章节正文（请确认页面是否是章节页）');

    // Auto-render cached translations if available
    if (nodes.length && typeof TransStore !== 'undefined' && TransStore._completedCount > 0) {
      d('cache:auto_render', {
        completedCount: TransStore._completedCount,
        cacheSize: TransStore._cache.size(),
        cacheKeys: Array.from(TransStore._cache.keys),
        doneKeys: Object.keys(TransStore._done),
        nodesLength: nodes.length
      });

      // Mark selected nodes and show toolbar for cached content
      markSelectedNodes(nodes);
      UI.showToolbar();

      // Create a simple plan to render cached content
      const plan = nodes.map((node, i) => ({
        index: i,
        html: node.getAttribute('data-original-html') || node.innerHTML,
        status: TransStore._done[String(i)] ? 'completed' : 'pending',
        error: null
      }));

      // Set total count for RenderState and Bilingual
      RenderState.total = nodes.length;
      if (typeof Bilingual !== 'undefined') {
        Bilingual.setTotal(nodes.length);
      }

      // Render the cached content
      renderPlanSummary(plan);
      renderPlanAnchors(plan);

      // Debug: Check what renderPlanAnchors created
      const container = ensureRenderContainer();
      const blocks = container.querySelectorAll('.ao3x-block');
      d('cache:debug_blocks', { blockCount: blocks.length, planLength: plan.length });
      blocks.forEach((block, i) => {
        const transDiv = block.querySelector('.ao3x-translation');
        const anchor = block.querySelector('.ao3x-anchor');
        d('cache:debug_block', { index: i, hasTransDiv: !!transDiv, hasAnchor: !!anchor, transContent: transDiv?.innerHTML });
      });

      // Apply cached translations to the DOM with intelligent matching
      let lastRenderedIndex = -1;
      let hasAnyContent = false;

      // Try to match cached content by content hash instead of index
      const nodeHashes = nodes.map(node => {
        const content = node.getAttribute('data-original-html') || node.innerHTML;
        return simpleHash(content);
      });

      // Build a map of hash to cache entries
      const cacheEntries = {};
      for (let i = 0; i < TransStore._cache.keys.length; i++) {
        const key = TransStore._cache.keys[i];
        const value = TransStore._cache.get(key);
        if (value && value.trim()) {
          cacheEntries[key] = value;
        }
      }

      d('cache:matching_attempt', {
        nodeCount: nodes.length,
        cacheKeys: Object.keys(cacheEntries),
        nodeHashes: nodeHashes.slice(0, 3) // Show first 3 hashes for debugging
      });

      // 补丁3：在开始回填前，确保每个 index 都有壳
      for (let i = 0; i < nodes.length; i++) {
        if (!container.querySelector(`.ao3x-block[data-index="${i}"]`)) {
          const w = document.createElement('div');
          w.className = 'ao3x-block';
          w.setAttribute('data-index', String(i));
          w.setAttribute('data-original-html', nodes[i] ? nodes[i].innerHTML : '');
          const a = document.createElement('span');
          a.className = 'ao3x-anchor'; a.setAttribute('data-chunk-id', String(i));
          const t = document.createElement('div'); t.className = 'ao3x-translation';
          t.innerHTML = '<span class="ao3x-muted">（待译）</span>';
          w.appendChild(a); w.appendChild(t);
          // 按顺序插入
          const ref = container.querySelector(`.ao3x-block[data-index="${i+1}"]`);
          if (ref) container.insertBefore(w, ref); else container.appendChild(w);
        }
      }

      // First try: Direct index matching (for same page structure)
      for (let i = 0; i < nodes.length; i++) {
        const cached = cacheEntries[String(i)];
        if (cached && cached.trim()) {
          hasAnyContent = true;
          try {
            // Try to directly update the DOM element
            const block = container.querySelector(`[data-index="${i}"]`);
            if (block) {
              const transDiv = block.querySelector('.ao3x-translation');
              if (transDiv) {
                transDiv.innerHTML = cached;
                // 让后续 View.refresh / 双语渲染也能拿到
                RenderState.lastApplied[i] = cached;
                d('cache:direct_update', { index: i, success: true });
              }
            }

            // Also try the normal method
            RenderState.applyIncremental(i, cached);
            RenderState.lastApplied[i] = cached; // 确保lastApplied被设置
            lastRenderedIndex = i;
            d('cache:rendered_block', { index: i, hasContent: !!cached });
          } catch (e) {
            d('cache:render_error', { index: i, error: e.message });
          }
        }
      }

      // Check if there are more cache entries than current nodes
      // This handles cases where page structure changed between translation and reload
      const totalCacheEntries = Object.keys(cacheEntries).length;
      if (totalCacheEntries > nodes.length) {
        d('cache:extra_entries_found', {
          totalCacheEntries,
          currentNodes: nodes.length,
          extraEntries: totalCacheEntries - nodes.length
        });

        // Try to create additional blocks for extra cache entries
        for (let i = nodes.length; i < totalCacheEntries; i++) {
          const cached = cacheEntries[String(i)];
          if (cached && cached.trim()) {
            try {
              // Create a new block for this cache entry
              const wrapper = document.createElement('div');
              wrapper.className = 'ao3x-block';
              wrapper.setAttribute('data-index', String(i));
              // ★ 写入对应原文，供双语配对使用
              const originalHtml = (nodes[i] && nodes[i].innerHTML) ? nodes[i].innerHTML : '';
              wrapper.setAttribute('data-original-html', originalHtml);

              const anchor = document.createElement('span');
              anchor.className = 'ao3x-anchor';
              anchor.setAttribute('data-chunk-id', String(i));
              wrapper.appendChild(anchor);

              const transDiv = document.createElement('div');
              transDiv.className = 'ao3x-translation';
              transDiv.innerHTML = cached;
              wrapper.appendChild(transDiv);

              // ★ 按正确顺序插入，而不是一律丢到末尾
              const ref = container.querySelector(`.ao3x-block[data-index="${i+1}"]`);
              if (ref) container.insertBefore(wrapper, ref);
              else {
                // 再试试找"最近的前一个"以防中间有缺口
                let inserted = false;
                for (let j = i - 1; j >= 0; j--) {
                  const prev = container.querySelector(`.ao3x-block[data-index="${j}"]`);
                  if (prev && prev.nextSibling) {
                    prev.parentNode.insertBefore(wrapper, prev.nextSibling);
                    inserted = true; break;
                  }
                }
                if (!inserted) container.appendChild(wrapper);
              }

              // Update render state
              RenderState.applyIncremental(i, cached);
              RenderState.lastApplied[i] = cached;
              lastRenderedIndex = i;
              hasAnyContent = true;

              d('cache:created_extra_block', { index: i, success: true });
            } catch (e) {
              d('cache:extra_block_error', { index: i, error: e.message });
            }
          }
        }
      }

      // If no direct matches, try fuzzy matching based on content similarity
      if (!hasAnyContent && Object.keys(cacheEntries).length > 0) {
        d('cache:trying_fuzzy_match', { message: 'No direct index matches found, trying fuzzy matching' });

        // Use original node info if available for better matching
        const useAdvancedMatching = TransStore._originalNodeInfo && Object.keys(TransStore._originalNodeInfo).length > 0;

        if (useAdvancedMatching) {
          d('cache:using_advanced_matching', { originalNodeCount: Object.keys(TransStore._originalNodeInfo).length });

          for (let i = 0; i < nodes.length; i++) {
            const nodeContent = nodes[i].getAttribute('data-original-html') || nodes[i].innerHTML;
            const currentNodeHash = simpleHash(nodeContent);

            // Try to find the best matching cache entry using original node info
            let bestMatch = null;
            let bestScore = 0;
            let matchType = 'none';

            // First, try to match by hash with original node info
            for (const [originalIndex, originalInfo] of Object.entries(TransStore._originalNodeInfo)) {
              if (originalInfo.hash === currentNodeHash) {
                // Perfect hash match - use the cache entry for this original index
                const cacheValue = cacheEntries[originalIndex];
                if (cacheValue) {
                  bestMatch = { key: originalIndex, value: cacheValue };
                  bestScore = 1.0;
                  matchType = 'hash';
                  break;
                }
              }
            }

            // If no hash match, try similarity matching
            if (!bestMatch) {
              for (const [cacheKey, cacheValue] of Object.entries(cacheEntries)) {
                const originalInfo = TransStore._originalNodeInfo[cacheKey];
                if (originalInfo) {
                  // Compare current node with original node info
                  const originalWords = originalInfo.words;
                  const currentWords = nodeContent.toLowerCase().match(/\b\w+\b/g)?.slice(0, 50) || [];

                  const intersection = originalWords.filter(word => currentWords.includes(word));
                  const union = [...new Set([...originalWords, ...currentWords])];
                  const score = union.length > 0 ? intersection.length / union.length : 0;

                  if (score > bestScore && score > 0.2) { // Lower threshold for original node matching
                    bestScore = score;
                    bestMatch = { key: cacheKey, value: cacheValue };
                    matchType = 'similarity';
                  }
                }
              }
            }

            if (bestMatch) {
              hasAnyContent = true;
              try {
                // Try to directly update the DOM element
                  const block = container.querySelector(`[data-index="${i}"]`);
                if (block) {
                  const transDiv = block.querySelector('.ao3x-translation');
                  if (transDiv) {
                    transDiv.innerHTML = bestMatch.value;
                    d('cache:advanced_update', { index: i, matchedKey: bestMatch.key, score: bestScore, matchType });
                  }
                }

                // Also try the normal method
                RenderState.applyIncremental(i, bestMatch.value);
                RenderState.lastApplied[i] = bestMatch.value;
                lastRenderedIndex = i;
                d('cache:advanced_rendered_block', { index: i, matchedKey: bestMatch.key, score: bestScore, matchType });
              } catch (e) {
                d('cache:advanced_render_error', { index: i, error: e.message });
              }
            }
          }
        } else {
          // Fallback to basic fuzzy matching
          d('cache:using_basic_fuzzy_matching', { message: 'No original node info available' });

          for (let i = 0; i < nodes.length; i++) {
            const nodeContent = nodes[i].getAttribute('data-original-html') || nodes[i].innerHTML;

            // Try to find the best matching cache entry
            let bestMatch = null;
            let bestScore = 0;

            for (const [cacheKey, cacheValue] of Object.entries(cacheEntries)) {
              // Simple similarity check: look for common words or patterns
              const score = calculateSimilarity(nodeContent, cacheValue);
              if (score > bestScore && score > 0.3) { // 30% similarity threshold
                bestScore = score;
                bestMatch = { key: cacheKey, value: cacheValue };
              }
            }

            if (bestMatch) {
              hasAnyContent = true;
              try {
                // Try to directly update the DOM element
                  const block = container.querySelector(`[data-index="${i}"]`);
                if (block) {
                  const transDiv = block.querySelector('.ao3x-translation');
                  if (transDiv) {
                    transDiv.innerHTML = bestMatch.value;
                    d('cache:fuzzy_update', { index: i, matchedKey: bestMatch.key, score: bestScore });
                  }
                }

                // Also try the normal method
                RenderState.applyIncremental(i, bestMatch.value);
                RenderState.lastApplied[i] = bestMatch.value;
                lastRenderedIndex = i;
                d('cache:fuzzy_rendered_block', { index: i, matchedKey: bestMatch.key, score: bestScore });
              } catch (e) {
                d('cache:fuzzy_render_error', { index: i, error: e.message });
              }
            }
          }
        }
      }

      // If no content was found, show debug info
      if (!hasAnyContent) {
        const cacheDetails = Array.from(TransStore._cache.cache.entries()).map(([k, v]) => ({
          key: k,
          length: v?.length,
          preview: v?.slice(0, 100),
          isEmpty: !v || v.trim() === '',
          isPlaceholder: v?.includes('（待译）') || v?.includes('ao3x-muted')
        }));

        const nodeDetails = nodes.map((node, i) => ({
          index: i,
          originalLength: node.innerHTML.length,
          originalPreview: node.innerHTML.slice(0, 100),
          hash: simpleHash(node.innerHTML)
        }));

        d('cache:no_content_found', {
          cacheDetails,
          doneEntries: TransStore._done,
          totalNodes: nodes.length,
          nodeDetails,
          cacheKeys: TransStore._cache.keys,
          problem: `缓存有${cacheDetails.length}个块，但页面只有${nodes.length}个节点`
        });

        // 尝试显示所有缓存内容以便调试
        if (cacheDetails.length > 0) {
          console.group('🔍 AO3缓存调试信息');
          console.log('缓存条目详情:', cacheDetails);
          console.log('页面节点详情:', nodeDetails);
          console.log('缓存键:', TransStore._cache.keys);
          console.log('完成状态:', TransStore._done);
          console.groupEnd();
        }

        UI.toast(`缓存不匹配：缓存${cacheDetails.length}块，页面${nodes.length}节点`);
      }

      // Set nextToRender to the next unrendered chunk
      if (lastRenderedIndex >= 0) {
        RenderState.nextToRender = lastRenderedIndex + 1;
        d('cache:set_next_to_render', { nextToRender: RenderState.nextToRender });
      }

      // Ensure proper completion states for bilingual mode
      // For cached content, make sure all blocks with translations are marked as done
      // AND make sure the original HTML is correctly mapped from actual page nodes
      const cacheContainer = ensureRenderContainer();
      const cacheBlocks = cacheContainer.querySelectorAll('.ao3x-block');

      d('cache:fixing_bilingual_mapping', { blockCount: cacheBlocks.length,
        nodeCount: nodes.length,
        cacheEntryCount: Object.keys(cacheEntries).length
      });

      // First, ensure every block has correct original HTML from page nodes
      for (let i = 0; i < nodes.length; i++) {
        const block = cacheContainer.querySelector(`[data-index="${i}"]`);
        if (block && nodes[i]) {
          const originalHtml = nodes[i].innerHTML;
          block.setAttribute('data-original-html', originalHtml);
          d('cache:set_node_original', { index: i, originalLength: originalHtml.length });

          // Check if this block has corresponding translation
          const cached = TransStore.get(String(i));
          if (cached && cached.trim() && !cached.includes('（待译）') && !cached.includes('ao3x-muted')) {
            TransStore.markDone(i);
            d('cache:marked_done', { index: i, hasTranslation: true });
          }
        }
      }

      // Handle extra cache entries that don't correspond to current page nodes
      for (const [cacheKey, cacheValue] of Object.entries(cacheEntries)) {
        const idx = parseInt(cacheKey);
        if (idx >= nodes.length && cacheValue && cacheValue.trim()) {
          // This is an extra cache entry - create a block for it but without original HTML
          let block = cacheContainer.querySelector(`[data-index="${idx}"]`);
          if (block) {
            // Block exists but may not have proper original HTML
            const existingOriginal = block.getAttribute('data-original-html');
            if (!existingOriginal) {
              // Try to find original HTML from our stored node info
              const nodeInfo = TransStore._originalNodeInfo && TransStore._originalNodeInfo[cacheKey];
              if (nodeInfo && nodeInfo.preview) {
                // Use the preview as a fallback original content
                block.setAttribute('data-original-html', `<p>${nodeInfo.preview}</p>`);
                d('cache:set_fallback_original', { index: idx, preview: nodeInfo.preview.slice(0, 50) });
              } else {
                // No original content available, mark it as such
                block.setAttribute('data-original-html', '<p>[原文不可用]</p>');
                d('cache:set_placeholder_original', { index: idx });
              }
            }
            TransStore.markDone(idx);
          }
        }
      }

      // Update total count after processing all cached content
      const actualTotal = Math.max(nodes.length, Object.keys(cacheEntries).length);
      RenderState.total = actualTotal;
      if (typeof Bilingual !== 'undefined') {
        Bilingual.setTotal(actualTotal);
        d('cache:bilingual_setup', {
          total: actualTotal,
          canRender: Bilingual.canRender(),
          completedCount: TransStore._completedCount,
          allDone: TransStore.allDone(actualTotal)
        });
      }

      // Force refresh to show all cached content
      View.refresh(true);
      
      // Fix index mapping for bilingual mode
      // Ensure all blocks have correct data-index that matches cache keys
      const allBlocks = cacheContainer.querySelectorAll('.ao3x-block');
      allBlocks.forEach((block, index) => {
        const currentIdx = block.getAttribute('data-index');
        if (currentIdx !== String(index)) {
          d('cache:fixing_index_mismatch', { currentIndex: currentIdx, newIndex: index });
          block.setAttribute('data-index', String(index));
          
          // Also update the anchor's data-chunk-id
          const anchor = block.querySelector('.ao3x-anchor');
          if (anchor) {
            anchor.setAttribute('data-chunk-id', String(index));
          }
        }
      });
      
      // If in bilingual mode and all translations are available, trigger bilingual rendering
      if (View.mode === 'bi' && Bilingual.canRender()) {
        // Use a slightly longer delay to ensure DOM is ready
        setTimeout(() => {
          try {
            console.log('Cache restore: Triggering bilingual rendering');
            View.renderBilingual();
            
            // Fallback: if bilingual rendering doesn't work after 1 second, try again
            setTimeout(() => {
              if (View.mode === 'bi' && Bilingual.canRender()) {
                try {
                  console.log('Cache restore: Fallback bilingual rendering attempt');
                  View.renderBilingual();
                } catch (e) {
                  console.error('Failed to render bilingual on fallback attempt:', e);
                }
              }
            }, 1000);
          } catch (e) {
            console.error('Failed to render bilingual after cache restore:', e);
          }
        }, 200);
      }

      // Update toolbar state
      UI.updateToolbarState();

      // Show toast if we have cached content
      if (TransStore._completedCount > 0) {
        UI.toast(`已加载 ${TransStore._completedCount} 段缓存译文`);
      }
    }

    // Setup memory monitoring and cleanup
    setInterval(() => {
      if (typeof TransStore !== 'undefined' && TransStore._cache) {
        const cacheSize = TransStore._cache.size();
        if (cacheSize > 40) {
          TransStore.cleanupOldEntries();
          d('Memory cleanup triggered, cache size:', cacheSize);
        }
      }

      // Clean up performance monitoring
      if (PerfMonitor.measures.size > 50) {
        PerfMonitor.clear();
      }
    }, 30000); // Check every 30 seconds

    const mo = new MutationObserver(()=>{ /* no-op，保留接口 */ });
    mo.observe(document.documentElement, { childList:true, subtree:true });

    PerfMonitor.mark('init_end');
    const initDuration = PerfMonitor.measure('init_duration', 'init_start', 'init_end');
    d('Initialization completed in', Math.round(initDuration) + 'ms');
  }
  // 延迟初始化以确保AO3页面完全加载
  function delayedInit() {
    // 等待一小段时间让AO3的动态内容加载完成
    setTimeout(() => {
      init();
    }, 1000); // 1秒延迟，可根据需要调整
  }

  if(document.readyState==='loading') {
    document.addEventListener('DOMContentLoaded', delayedInit);
  } else {
    delayedInit();
  }

})();
