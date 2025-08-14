// ==UserScript==
// @name         AO3 全文翻译（移动端 Safari / Tampermonkey）
// @namespace    https://ao3-translate.example
// @version      0.5.9
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
    get() {
      try {
        const saved = GM_Get(NS);
        return saved ? deepMerge(structuredClone(this.defaults), saved) : structuredClone(this.defaults);
      } catch { return structuredClone(this.defaults); }
    },
    set(p) { const merged = deepMerge(this.get(), p); GM_Set(NS, merged); return merged; }
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
  function stripHtmlToText(html){ const div=document.createElement('div'); div.innerHTML=html; return (div.textContent||'').replace(/\s+/g,' ').trim(); }
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

      // 添加长按下载功能
      let longPressTimer = null;
      let isLongPress = false;

      const startLongPress = () => {
        isLongPress = false;
        longPressTimer = setTimeout(() => {
          isLongPress = true;
          Controller.downloadTranslation();
        }, 1000); // 1秒长按
      };

      const cancelLongPress = () => {
        clearTimeout(longPressTimer);
        isLongPress = false;
      };

      // iOS Safari文本选择防护
      const preventSelection = (e) => {
        if (e.target.closest('.ao3x-btn')) {
          e.preventDefault();
          e.stopPropagation();
          return false;
        }
      };

      // 鼠标事件（桌面）
      btnTranslate.addEventListener('mousedown', (e) => {
        preventSelection(e);
        startLongPress();
      });
      btnTranslate.addEventListener('mouseup', cancelLongPress);
      btnTranslate.addEventListener('mouseleave', cancelLongPress);

      // 触摸事件（移动设备）
      btnTranslate.addEventListener('touchstart', (e) => {
        preventSelection(e);
        startLongPress();
      });
      btnTranslate.addEventListener('touchend', cancelLongPress);
      btnTranslate.addEventListener('touchcancel', cancelLongPress);

      // 添加全局文本选择防护
      document.addEventListener('selectstart', preventSelection);
      document.addEventListener('mousedown', preventSelection);
      document.addEventListener('touchstart', preventSelection);

      btnTranslate.addEventListener('click', (e) => {
        if (!isLongPress) {
          Controller.startTranslate();
        }
      });

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
                <label>Max Tokens</label>
                <input id="ao3x-maxt" type="number" min="128" value="2048"/>
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
        await ModelBrowser.fetchAndRender(panel);
        UI.toast('模型列表已更新');
      });
      $('#ao3x-model-q', panel).addEventListener('input', () => ModelBrowser.filter(panel));

      const autosave = () => { settings.set(collectPanelValues(panel)); applyFontSize(); saveToast(); };
      panel.addEventListener('input', debounce(autosave, 300), true);
      panel.addEventListener('change', autosave, true);
      panel.addEventListener('blur', (e)=>{ if(panel.contains(e.target)) autosave(); }, true);

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
      bar.innerHTML = `<button data-mode="trans" class="active">仅译文</button><button data-mode="orig">仅原文</button><button data-mode="bi" disabled>双语对照</button><button id="ao3x-clear-cache" data-action="clear-cache">清除缓存</button><button id="ao3x-retry-incomplete" data-action="retry" style="display: none;">重试未完成</button>`;
      bar.addEventListener('click', (e) => {
        const btn = e.target.closest('button'); if (!btn) return;
        const action = btn.getAttribute('data-action');
        if (action === 'retry') { Controller.retryIncomplete(); return; }
        if (action === 'clear-cache') {
          if (confirm('确定要清除当前页面的翻译缓存吗？')) {
            TransStore.clearCache();
            View.setShowingCache(false);
            UI.updateToolbarState(); // 更新工具栏状态，重新显示双语对照按钮
            UI.toast('缓存已清除');
            // 隐藏工具栏如果没有翻译内容
            const renderContainer = document.querySelector('#ao3x-render');
            if (renderContainer) {
              renderContainer.remove();
            }
            UI.hideToolbar();
          }
          return;
        }
        [...bar.querySelectorAll('button')].forEach(b => { if (!b.getAttribute('data-action')) b.classList.remove('active', 'highlight'); });
        if (!action && !btn.disabled) { btn.classList.add('active'); View.setMode(btn.getAttribute('data-mode')); }
      });

      // 添加双语对照按钮的长按多选功能
      const biBtn = bar.querySelector('[data-mode="bi"]');
      if (biBtn) {
        let multiSelectLongPressTimer = null;
        let isMultiSelectLongPress = false;

        const startMultiSelectLongPress = () => {
          isMultiSelectLongPress = false;
          multiSelectLongPressTimer = setTimeout(() => {
            isMultiSelectLongPress = true;
            Controller.enterMultiSelectMode();
          }, 1000); // 1秒长按
        };

        const cancelMultiSelectLongPress = () => {
          clearTimeout(multiSelectLongPressTimer);
          isMultiSelectLongPress = false;
        };

        // iOS Safari文本选择防护
        const preventSelection = (e) => {
          if (e.target.closest('.ao3x-toolbar-btn')) {
            e.preventDefault();
            e.stopPropagation();
            return false;
          }
        };

        // 鼠标事件（桌面）
        biBtn.addEventListener('mousedown', (e) => {
          preventSelection(e);
          startMultiSelectLongPress();
        });
        biBtn.addEventListener('mouseup', cancelMultiSelectLongPress);
        biBtn.addEventListener('mouseleave', cancelMultiSelectLongPress);

        // 触摸事件（移动设备）
        biBtn.addEventListener('touchstart', (e) => {
          preventSelection(e);
          startMultiSelectLongPress();
        });
        biBtn.addEventListener('touchend', cancelMultiSelectLongPress);
        biBtn.addEventListener('touchcancel', cancelMultiSelectLongPress);

        biBtn.addEventListener('click', (e) => {
          // 如果是多选模式，退出多选模式
          if (Controller.isInMultiSelectMode()) {
            Controller.exitMultiSelectMode();
            return;
          }

          // 正常的翻译按钮点击功能
          const action = biBtn.getAttribute('data-action');
          if (!action && !biBtn.disabled) {
            [...bar.querySelectorAll('button')].forEach(b => { if (!b.getAttribute('data-action')) b.classList.remove('active', 'highlight'); });
            biBtn.classList.add('active');
            View.setMode(biBtn.getAttribute('data-mode'));
          }
        });
      }
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

      // 检查是否有缓存，控制清除缓存按钮的显示
      if (clearCacheBtn) {
        const hasCache = TransStore.hasCache();
        clearCacheBtn.style.display = hasCache ? '' : 'none';
      }

      // 检查翻译是否全部完成，高亮双语对照按钮
      if (biBtn) {
        const isAllComplete = TransStore.allDone(RenderState.total || 0) && (RenderState.total || 0) > 0;
        const isShowingCache = View.isShowingCache();

        // 如果正在显示缓存，隐藏双语对照按钮
        if (isShowingCache) {
          biBtn.style.display = 'none';
        } else {
          biBtn.style.display = '';
          // 启用双语对照按钮（除非正在显示缓存）
          biBtn.disabled = false;
          if (isAllComplete) {
            biBtn.classList.add('highlight');
          } else {
            biBtn.classList.remove('highlight');
          }
        }
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
      .ao3x-toolbar button:disabled{
        opacity:0.5;
        cursor:not-allowed;
        color:var(--c-fg-weak);
      }
      .ao3x-toolbar button:disabled:hover{
        background:transparent;
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

      /* 动态字体大小 */
      .ao3x-translation{font-size:var(--translation-font-size,16px);min-height:60px;transition:min-height 0.2s ease}

      /* 引用样式 */
      .ao3x-translation blockquote{
        margin:1em 0;
        padding-left:1em;
        border-left:4px solid var(--c-border);
        font-style:italic;
        color:var(--c-fg);
        background:var(--c-soft);
        border-radius:0 var(--radius) var(--radius) 0;
      }

      /* 双语对照 */
      .ao3x-pair{
        padding:12px 16px;margin:12px 0;
        border:1px solid var(--c-border);border-radius:var(--radius);
        background:white;box-shadow:0 1px 3px rgba(0,0,0,.05);
        min-height:80px;transition:all 0.2s ease;
      }
      .ao3x-pair .orig{color:#374151;line-height:1.6}
      .ao3x-pair .orig blockquote{
        margin:0.5em 0;
        padding-left:0.8em;
        border-left:3px solid var(--c-border);
        font-style:italic;
        background:var(--c-soft);
        border-radius:0 var(--radius) var(--radius) 0;
      }
      .ao3x-pair .trans{
        color:#111;line-height:1.7;margin-top:12px;padding-top:12px;
        border-top:1px dashed var(--c-border);
        font-size:var(--translation-font-size,16px);
      }
      .ao3x-pair .trans blockquote{
        margin:0.5em 0;
        padding-left:0.8em;
        border-left:3px solid var(--c-accent);
        font-style:italic;
        background:rgba(179,0,0,0.05);
        border-radius:0 var(--radius) var(--radius) 0;
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


      /* 对照块勾选框 */
      .ao3x-multiselect-label{
        position:absolute;left:50%;top:50%;transform:translate(-50%, -50%);
        cursor:pointer;z-index:10;
        background:white;padding:4px;border-radius:4px;
        box-shadow:0 2px 4px rgba(0,0,0,0.1);
      }
      .ao3x-multiselect-checkbox{
        width:18px;height:18px;cursor:pointer;
        accent-color:var(--c-accent);
      }
      .ao3x-pair{
        position:relative; /* 为绝对定位的勾选框提供参考 */
      }
      .ao3x-pair:hover{
        background:var(--c-soft);
      }
      .ao3x-pair.selected{
        background:rgba(179,0,0,.05);
        border-color:var(--c-accent);
      }

      /* 浮动保存按钮 */
      .ao3x-multiselect-save{
        position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
        z-index:999999;background:var(--c-accent);color:white;
        border:none;padding:12px 24px;border-radius:var(--radius-full);
        font-size:14px;font-weight:500;cursor:pointer;
        box-shadow:0 4px 12px rgba(179,0,0,.25);
        transition:all .2s;pointer-events:auto;user-select:none;
        -webkit-user-select:none;-moz-user-select:none;-ms-user-select:none;
      }
      .ao3x-multiselect-save:hover{
        background:#9a0000;transform:translateX(-50%) translateY(-2px);
        box-shadow:0 6px 16px rgba(179,0,0,.35);
      }
      .ao3x-multiselect-save:active{
        transform:translateX(-50%) translateY(0);
      }

      /* 图片预览模态框 */
      .ao3x-image-preview-modal{
        position:fixed;inset:0;background:rgba(0,0,0,.8);
        z-index:100001;display:flex;align-items:center;
        justify-content:center;padding:20px;
        backdrop-filter:blur(4px);
      }
      .ao3x-image-preview-content{
        background:white;border-radius:var(--radius);
        max-width:90vw;max-height:90vh;overflow:hidden;
        box-shadow:0 8px 32px rgba(0,0,0,.3);
        display:flex;flex-direction:column;
      }
      .ao3x-image-preview-header{
        display:flex;align-items:center;justify-content:space-between;
        padding:16px 20px;border-bottom:1px solid var(--c-border);
        background:var(--c-soft);
      }
      .ao3x-image-preview-header span{
        font-size:16px;font-weight:600;color:var(--c-fg);
      }
      .ao3x-image-preview-close{
        background:transparent;border:none;
        color:var(--c-muted);width:32px;height:32px;
        border-radius:var(--radius-full);font-size:20px;
        line-height:1;cursor:pointer;transition:all .2s;
      }
      .ao3x-image-preview-close:hover{
        background:var(--c-accent);color:white;
      }
      .ao3x-image-preview-body{
        padding:20px;overflow:auto;
        display:flex;align-items:center;justify-content:center;
      }
      .ao3x-image-preview-body img{
        max-width:100%;max-height:60vh;
        border-radius:var(--radius);box-shadow:0 2px 8px rgba(0,0,0,.1);
      }
      .ao3x-image-preview-footer{
        display:flex;gap:12px;padding:16px 20px;
        border-top:1px solid var(--c-border);
        background:var(--c-soft);
      }
      .ao3x-image-preview-download,
      .ao3x-image-preview-longpress{
        flex:1;padding:10px 16px;border-radius:var(--radius-full);
        border:none;font-size:14px;font-weight:500;cursor:pointer;
        transition:all .2s;
      }
      .ao3x-image-preview-download{
        background:var(--c-accent);color:white;
      }
      .ao3x-image-preview-download:hover{
        background:#9a0000;
      }
      .ao3x-image-preview-longpress{
        background:var(--c-border);color:var(--c-fg);
      }
      .ao3x-image-preview-longpress:hover{
        background:var(--c-muted);color:white;
      }

      /* 移动端优化 */
      @media (max-width:768px){
        .ao3x-multiselect-ui{
          top:8px;left:12px;right:12px;transform:none;
          padding:10px 16px;font-size:13px;
        }
        .ao3x-multiselect-save{
          bottom:16px;left:12px;right:12px;transform:none;
          padding:14px 20px;
        }
        .ao3x-image-preview-content{
          max-width:95vw;max-height:95vh;
        }
        .ao3x-image-preview-body{
          padding:16px;
        }
        .ao3x-image-preview-footer{
          flex-direction:column;gap:8px;
        }
      }
    `);
  }
  function debounce(fn, wait){ let t; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), wait); }; }
  function collectPanelValues(panel) {
    const cur = settings.get();
    return {
      api: { baseUrl: $('#ao3x-base', panel).value.trim(), path: $('#ao3x-path', panel).value.trim(), key: $('#ao3x-key', panel).value.trim() },
      model: { id: $('#ao3x-model', panel).value.trim(), contextWindow: parseInt($('#ao3x-cw', panel).value, 10) || cur.model.contextWindow },
      gen: { maxTokens: parseInt($('#ao3x-maxt', panel).value, 10) || cur.gen.maxTokens, temperature: parseFloat($('#ao3x-temp', panel).value) || cur.gen.temperature },
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
      return `<div class="row"><b>#${i}</b> <span class="ao3x-small">in≈${estIn}</span> ｜ <span class="ao3x-small">开头：</span>${escapeHTML(head)} <span class="ao3x-small">…结尾：</span>${escapeHTML(tail)}</div>`;
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
        plan.push({html, text, inTok});
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
    // 处理块级元素，包括blockquote在内的所有块级元素
    const blocks=$all('p, div, li, pre, blockquote', tmp);

    if(!blocks.length){
      parts.push(html);
      return parts;
    }

    // 处理所有块级元素，包括blockquote
    for(const b of blocks) {
      // 检查是否在其他块级元素内部，避免重复处理
      if(b.closest('p, div, li, pre, blockquote') && !b.parentElement?.isEqualNode(tmp)) continue;
      parts.push(b.outerHTML);
    }

    return parts;
  }

  /* ================= OpenAI-compatible + SSE ================= */
  function resolveEndpoint(baseUrl, apiPath){ if(!baseUrl) throw new Error('请在设置中填写 Base URL'); const hasV1=/\/v1\//.test(baseUrl); return hasV1? baseUrl : `${trimSlash(baseUrl)}/${trimSlash(apiPath||'v1/chat/completions')}`; }
  function resolveModelsEndpoint(baseUrl){ if(!baseUrl) throw new Error('请填写 Base URL'); const m=baseUrl.match(/^(.*?)(\/v1\/.*)$/); return m? `${m[1]}/v1/models` : `${trimSlash(baseUrl)}/v1/models`; }
  async function fetchJSON(url, key, body){
    const res = await fetch(url, { method:'POST', headers:{'content-type':'application/json', ...(key?{'authorization':`Bearer ${key}`}:{})}, body: JSON.stringify(body) });
    if(!res.ok){ const t=await res.text(); throw new Error(`HTTP ${res.status}: ${t.slice(0,500)}`); }
    return await res.json();
  }
  function supportsStreamingFetch(){ try{ return !!(window.ReadableStream && window.TextDecoder && window.AbortController); } catch{ return false; } }

  async function postChatWithRetry({ endpoint, key, payload, stream, onDelta, onDone, onError, onFinishReason, label }){
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
      let content=full?.choices?.[0]?.message?.content || '';
      const fr = full?.choices?.[0]?.finish_reason || null;
      // 过滤思考内容，只保留非思考内容作为译文
      if (content) {
        content = content.replace(/<thinking>[\s\S]*?<\/thinking>/g, '')  // 标准XML标签格式
                        .replace(/<think>[\s\S]*?<\/think>/g, '')  // 简化XML标签格式
                        .replace(/^Thought:\s*[^\n]*\n\n/gm, '')  // 行首的Thought前缀格式（必须有双换行）
                        .replace(/^Thinking Process:\s*[^\n]*\n\n/gm, '')  // 行首的思考过程前缀（必须有双换行）
                        .replace(/^Internal Monologue:\s*[^\n]*\n\n/gm, '')  // 行首的内心独白前缀（必须有双换行）
                        .replace(/\[思考\][\s\S]*?\[\/思考\]/g, '');  // 中文标签格式
      }
      onDelta && onDelta(content); onFinishReason && onFinishReason(fr); onDone && onDone();
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
          let delta = choice?.delta?.content ?? choice?.text ?? '';
          // 过滤思考内容，只保留非思考内容作为译文
          if (delta) {
            delta = delta.replace(/<thinking>[\s\S]*?<\/thinking>/g, '')  // 标准XML标签格式
                         .replace(/<think>[\s\S]*?<\/think>/g, '')      // 简化XML标签格式
                         .replace(/^Thought:\s*[^\n]*\n\n/gm, '')  // 行首的Thought前缀格式（必须有双换行）
                         .replace(/^Thinking Process:\s*[^\n]*\n\n/gm, '')  // 行首的思考过程前缀（必须有双换行）
                         .replace(/^Internal Monologue:\s*[^\n]*\n\n/gm, '')  // 行首的内心独白前缀（必须有双换行）
                         .replace(/\[思考\][\s\S]*?\[\/思考\]/g, '');     // 中文标签格式
          }
          if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
          if(delta){ onDelta(delta); lastTick = performance.now(); bytes += delta.length; events++; }
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
    async fetchAndRender(panel){ try{ const list=await getModels(); this.all=list; this.render(panel, list); } catch(e){ UI.toast('获取模型失败：'+e.message); } },
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
    _map: Object.create(null), _done: Object.create(null),
    _cacheKey: null,

    // 初始化缓存键（基于当前URL）
    initCache() {
      this._cacheKey = `ao3_translator_${window.location.pathname}`;
      this.loadFromCache();
    },

    // 从localStorage加载缓存
    loadFromCache() {
      if (!this._cacheKey) return;
      try {
        const cached = localStorage.getItem(this._cacheKey);
        if (cached) {
          const data = JSON.parse(cached);
          this._map = data._map || Object.create(null);
          this._done = data._done || Object.create(null);
        }
      } catch (e) {
        console.warn('Failed to load translation cache:', e);
      }
    },

    // 保存到localStorage
    saveToCache() {
      if (!this._cacheKey) return;
      try {
        const data = {
          _map: this._map,
          _done: this._done,
          timestamp: Date.now()
        };
        localStorage.setItem(this._cacheKey, JSON.stringify(data));
      } catch (e) {
        console.warn('Failed to save translation cache:', e);
      }
    },

    // 清除缓存
    clearCache() {
      if (this._cacheKey) {
        localStorage.removeItem(this._cacheKey);
      }
      this.clear();
    },

    // 检查是否有缓存
    hasCache() {
      if (!this._cacheKey) return false;
      try {
        const cached = localStorage.getItem(this._cacheKey);
        if (!cached) return false;
        const data = JSON.parse(cached);
        const map = data._map || {};
        const done = data._done || {};
        // 检查是否有任何翻译内容
        return Object.keys(map).length > 0;
      } catch (e) {
        return false;
      }
    },

    // 获取缓存信息
    getCacheInfo() {
      if (!this._cacheKey) return { hasCache: false, total: 0, completed: 0 };
      try {
        const cached = localStorage.getItem(this._cacheKey);
        if (!cached) return { hasCache: false, total: 0, completed: 0 };
        const data = JSON.parse(cached);
        const map = data._map || {};
        const done = data._done || {};
        return {
          hasCache: Object.keys(map).length > 0,
          total: Object.keys(map).length,
          completed: Object.keys(done).length
        };
      } catch (e) {
        return { hasCache: false, total: 0, completed: 0 };
      }
    },

    set(i, html){
      this._map[i] = html;
      this.saveToCache(); // 自动保存
    },

    get(i){ return this._map[i] || ''; },

    markDone(i){
      this._done[i] = true;
      this.saveToCache(); // 自动保存
    },

    allDone(total){
      for(let k=0;k<total;k++){ if(!this._done[k]) return false; }
      return true;
    },

    clear(){
      this._map = Object.create(null);
      this._done = Object.create(null);
    }
  };

  const RenderState = {
    nextToRender: 0, total: 0, lastApplied: Object.create(null),
    setTotal(n){ this.total = n; this.nextToRender = 0; this.lastApplied = Object.create(null); },
    canRender(i){ return i === this.nextToRender; },
    applyIncremental(i, cleanHtml){
      const c = ensureRenderContainer();
      const anchor = c.querySelector(`[data-chunk-id="${i}"]`); if(!anchor) return;
      let transDiv = anchor.parentElement.querySelector('.ao3x-translation');
      if(!transDiv){
        transDiv=document.createElement('div');
        transDiv.className='ao3x-translation';
        // 设置最小高度防止容器跳动
        transDiv.style.minHeight = '60px';
        anchor.insertAdjacentElement('afterend', transDiv);
      }
      const prev = this.lastApplied[i] || '';
      const hasPlaceholder = /\(待译\)/.test(transDiv.textContent || '');
      if (!prev || hasPlaceholder) {
        // 使用 requestAnimationFrame 减少闪烁
        requestAnimationFrame(() => {
          transDiv.innerHTML = cleanHtml || '<span class="ao3x-muted">（待译）</span>';
          this.lastApplied[i] = cleanHtml;
        });
        return;
      }
      if (cleanHtml.startsWith(prev)) {
        const tail = cleanHtml.slice(prev.length);
        if (tail) {
          requestAnimationFrame(() => {
            transDiv.insertAdjacentHTML('beforeend', tail);
            this.lastApplied[i] = cleanHtml;
          });
        }
      } else {
        requestAnimationFrame(() => {
          transDiv.innerHTML = cleanHtml;
          this.lastApplied[i] = cleanHtml;
        });
      }
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
    _isShowingCache: false,
    ensure(){ return ensureRenderContainer(); },
    info(msg){ let n=$('#ao3x-info'); if(!n){ n=document.createElement('div'); n.id='ao3x-info'; n.className='ao3x-small'; this.ensure().prepend(n); } n.textContent=msg; },
    clearInfo(){ const n=$('#ao3x-info'); if(n) n.remove(); },

    // 检查是否正在显示缓存
    isShowingCache() {
      return this._isShowingCache;
    },

    // 设置是否正在显示缓存
    setShowingCache(showing) {
      this._isShowingCache = showing;
    },
    setMode(m){
      // 只在显示缓存时禁用双语对照模式
      if (m === 'bi' && this.isShowingCache()) {
        m = 'trans'; // 强制切换到译文模式
        UI.toast('显示缓存时双语对照功能已禁用');
      }
      this.mode=m; this.applyHostVisibility(); this.refresh(true);
    },
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
              // 对于缓存加载，显示所有已缓存的翻译
              contentHTML = TransStore.get(idxStr) || '';
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
      blocks.forEach(block=>{
        const idx = block.getAttribute('data-index');
        const orig = block.getAttribute('data-original-html') || '';
        const trans = TransStore.get(idx);
        const pairs = Bilingual.pairByParagraph(orig, trans);
        const html = pairs.map(p => `<div class="ao3x-pair"><div class="orig">${p.orig}</div><div class="trans">${p.trans||'<span class="ao3x-muted">（无对应段落）</span>'}</div></div>`).join('');

        // 使用 requestAnimationFrame 减少闪烁
        requestAnimationFrame(() => {
          block.innerHTML = `<span class="ao3x-anchor" data-chunk-id="${idx}"></span>${html}`;
        });
      });
    },
    setBlockTranslation(idx, html){
      TransStore.set(String(idx), html);
      if (RenderState.canRender(Number(idx))) {
        RenderState.applyIncremental(Number(idx), html);
      }
      // 只在显示缓存时禁用双语对照功能
      if(this.mode==='bi' && Bilingual.canRender() && this.isShowingCache()){
        this.mode = 'trans';
        UI.toast('显示缓存时双语对照功能已禁用');
        this.refresh(true);
      }
    }
  };
  const Bilingual = {
    canRender(){ return this._total != null && TransStore.allDone(this._total); },
    setTotal(n){ this._total = n; }, _total: null,
    splitParagraphs(html){
      const div = document.createElement('div'); div.innerHTML = html; const out = [];
      // 处理所有块级元素，包括blockquote
      div.querySelectorAll('p, div, li, pre, blockquote').forEach(el=>{
        const text=(el.textContent||'').trim();
        if(!text) return;
        // 检查是否在其他块级元素内部，避免重复处理
        if(el.closest('p, div, li, pre, blockquote') && !el.parentElement?.isEqualNode(div)) return;
        out.push(el.outerHTML);
      });

      if(!out.length){
        const raw=(div.innerHTML||'').split(/<br\s*\/?>/i).map(x=>x.trim()).filter(Boolean);
        return raw.map(x=>`<p>${x}</p>`);
      }
      return out;
    },
    pairByParagraph(origHTML, transHTML){ const o=this.splitParagraphs(origHTML); const t=this.splitParagraphs(transHTML); const m=Math.max(o.length,t.length); const pairs=new Array(m); for(let i=0;i<m;i++){ pairs[i]={orig:o[i]||'',trans:t[i]||''}; } return pairs; }
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
    // 多选模式状态
    _multiSelectMode: false,
    _selectedBlocks: new Set(),
    _multiSelectUI: null,

    // 检查是否处于多选模式
    isInMultiSelectMode() {
      return this._multiSelectMode;
    },

    // 进入多选模式
    enterMultiSelectMode() {
      if (this._multiSelectMode) return;

      // 确保当前是双语对照模式
      if (View.mode !== 'bi') {
        View.setMode('bi');
      }

      this._multiSelectMode = true;
      this._selectedBlocks.clear();

      // 更新按钮文本
      this.updateBiButtonText();

      // 为每个对照块添加勾选框
      this.addCheckboxesToPairs();

      // 显示浮动保存按钮
      this.showFloatingSaveButton();

      UI.toast('已进入多选模式，选择要保存的对照块');
    },

    // 退出多选模式
    exitMultiSelectMode() {
      if (!this._multiSelectMode) return;

      this._multiSelectMode = false;
      this._selectedBlocks.clear();

      // 更新按钮文本
      this.updateBiButtonText();

      // 移除勾选框
      this.removeCheckboxesFromPairs();

      // 隐藏浮动保存按钮
      this.hideFloatingSaveButton();

      // 移除多选UI
      if (this._multiSelectUI) {
        this._multiSelectUI.remove();
        this._multiSelectUI = null;
      }

      UI.toast('已退出多选模式');
    },

    // 更新双语按钮文本
    updateBiButtonText() {
      const biBtn = document.querySelector('[data-mode="bi"]');
      if (biBtn) {
        if (this._multiSelectMode) {
          biBtn.textContent = '多选模式';
          biBtn.classList.add('highlight');
        } else {
          biBtn.textContent = '双语对照';
          biBtn.classList.remove('highlight');
        }
      }
    },

    // 为对照块添加勾选框
    addCheckboxesToPairs() {
      const pairs = document.querySelectorAll('.ao3x-pair');
      pairs.forEach((pair, arrayIndex) => {
        // 使用数组索引作为唯一标识符，而不是块的data-index
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'ao3x-multiselect-checkbox';
        checkbox.dataset.blockIndex = String(arrayIndex);

        const label = document.createElement('label');
        label.className = 'ao3x-multiselect-label';
        label.appendChild(checkbox);

        pair.appendChild(label);

        // 添加点击事件
        checkbox.addEventListener('change', (e) => {
          const pairIndex = String(arrayIndex);
          console.log(`勾选框状态改变: pairIndex=${pairIndex}, checked=${e.target.checked}`);
          if (e.target.checked) {
            this._selectedBlocks.add(pairIndex);
          } else {
            this._selectedBlocks.delete(pairIndex);
          }
          console.log('当前选中的块:', Array.from(this._selectedBlocks));
          this.updateFloatingSaveButton();
        });

        // 为整个对照块添加点击事件，但排除浮动保存按钮
        pair.addEventListener('click', (e) => {
          // 检查点击事件是否来自浮动保存按钮或其子元素
          const saveButton = document.getElementById('ao3x-multiselect-save');
          if (saveButton && (saveButton.contains(e.target) || e.target.closest('#ao3x-multiselect-save'))) {
            return;
          }
          
          if (e.target.type !== 'checkbox') {
            checkbox.checked = !checkbox.checked;
            checkbox.dispatchEvent(new Event('change'));
          }
        });
      });
    },

    // 移除对照块的勾选框
    removeCheckboxesFromPairs() {
      const checkboxes = document.querySelectorAll('.ao3x-multiselect-checkbox');
      const labels = document.querySelectorAll('.ao3x-multiselect-label');
      checkboxes.forEach(cb => cb.remove());
      labels.forEach(label => label.remove());
    },

    // 显示浮动保存按钮
    showFloatingSaveButton() {
      const button = document.createElement('button');
      button.id = 'ao3x-multiselect-save';
      button.className = 'ao3x-multiselect-save';
      button.textContent = '保存选中部分';
      button.style.display = 'none';

      // 阻止事件冒泡但保持按钮功能
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        this.saveSelectedBlocksAsImages();
      });
      
      // 阻止其他事件的冒泡
      ['mousedown', 'mouseup', 'touchstart', 'touchend'].forEach(eventType => {
        button.addEventListener(eventType, (e) => {
          e.stopPropagation();
        });
      });

      document.body.appendChild(button);
    },

    // 隐藏浮动保存按钮
    hideFloatingSaveButton() {
      const button = document.getElementById('ao3x-multiselect-save');
      if (button) {
        button.remove();
      }
    },

    // 更新浮动保存按钮状态
    updateFloatingSaveButton() {
      const button = document.getElementById('ao3x-multiselect-save');
      if (button) {
        button.style.display = this._selectedBlocks.size > 0 ? 'block' : 'none';
        button.textContent = `保存选中部分 (${this._selectedBlocks.size})`;
      }
    },

    // 保存选中块为图片
    async saveSelectedBlocksAsImages() {
      if (this._selectedBlocks.size === 0) {
        UI.toast('请先选择要保存的对照块');
        return;
      }

      // 调试信息：查看所有可用的块和对照块
      const allBlocks = document.querySelectorAll('.ao3x-block');
      console.log('页面上所有可用的块:', Array.from(allBlocks).map(block => ({
        index: block.getAttribute('data-index'),
        hasPair: !!block.querySelector('.ao3x-pair')
      })));
      
      // 调试信息：查看所有可用的对照块
      const allPairs = document.querySelectorAll('.ao3x-pair');
      console.log('页面上所有可用的对照块:', Array.from(allPairs).map(pair => ({
        blockIndex: pair.querySelector('input[data-block-index]')?.getAttribute('data-block-index'),
        hasContent: !!pair.querySelector('.orig') && !!pair.querySelector('.trans')
      })));

      // 修复查找逻辑：使用数组索引查找对照块
      const selectedPairs = Array.from(this._selectedBlocks).map(pairIndex => {
        // 查找带有指定data-block-index的对照块
        const pair = document.querySelector(`.ao3x-pair input[data-block-index="${pairIndex}"]`)?.closest('.ao3x-pair');
        console.log(`查找对照块索引 ${pairIndex}:`, {
          pairFound: !!pair,
          pair: pair,
          pairIndex: pairIndex
        });
        return pair;
      }).filter(pair => pair !== null);

      console.log('选中的对照块:', {
        selectedBlocks: Array.from(this._selectedBlocks),
        foundPairs: selectedPairs.length,
        pairs: selectedPairs
      });

      if (selectedPairs.length === 0) {
        UI.toast('未找到选中的对照块');
        return;
      }

      UI.toast('正在生成长图...');

      try {
        // 将多个对照块合并为一张长图
        const imageData = await this.renderSelectedPairsAsLongImage(selectedPairs);
        if (imageData) {
          this.showImagePreview(imageData, `对照块长图_${selectedPairs.length}段`);
          UI.toast('长图生成成功');
        }
      } catch (error) {
        console.error('生成图片失败:', error);
        UI.toast('生成图片失败，请重试');
      }
    },

    // 将多个对照块渲染为长图
    async renderSelectedPairsAsLongImage(selectedPairs) {
      const TAKE = 10;
      const MAX_WIDTH = 1080;
      const PADDING = 12;
      const BG_COLOR = '#ffffff';

      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const loadImage = (url) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.crossOrigin = 'anonymous';
        img.src = url;
      });

      // 确保html-to-image库已加载
      await this.ensureHtmlToImageLoaded();

      if (document.fonts && document.fonts.ready) {
        try { await Promise.race([document.fonts.ready, sleep(1200)]); } catch {}
      }

      const nodes = selectedPairs.slice(0, TAKE);
      if (!nodes.length) { throw new Error('没有选中的对照块'); }

      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const images = [];

      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        
        // 临时隐藏多选框和边框
        const checkbox = node.querySelector('.ao3x-multiselect-checkbox');
        const label = node.querySelector('.ao3x-multiselect-label');
        const originalCheckboxDisplay = checkbox ? checkbox.style.display : null;
        const originalLabelDisplay = label ? label.style.display : null;
        
        if (checkbox) checkbox.style.display = 'none';
        if (label) label.style.display = 'none';
        
        // 临时移除边框
        const originalBorder = node.style.border;
        const originalBorderRadius = node.style.borderRadius;
        node.style.border = 'none';
        node.style.borderRadius = '0';
        
        // 直接使用原始节点，参考简化脚本
        const rect = node.getBoundingClientRect();
        const width = Math.ceil(rect.width);
        const pixelRatio = Math.min((MAX_WIDTH / width) || dpr, dpr);
        
        console.log('处理节点:', {
          index: i,
          width: width,
          height: rect.height,
          pixelRatio: pixelRatio
        });

        // 获取html-to-image库
        const htmlToImageLib = this.getHtmlToImageLib();
        if (!htmlToImageLib || !htmlToImageLib.toPng) {
          // 恢复多选框显示和边框
          if (checkbox) checkbox.style.display = originalCheckboxDisplay;
          if (label) label.style.display = originalLabelDisplay;
          node.style.border = originalBorder;
          node.style.borderRadius = originalBorderRadius;
          throw new Error('html-to-image库未正确加载');
        }
        
        try {
          // 简化调用，直接对原始节点截图
          const dataUrl = await htmlToImageLib.toPng(node, {
            backgroundColor: BG_COLOR,
            pixelRatio,
            cacheBust: true,
            style: { 
              width: width + 'px'
            }
          });
          
          console.log(`节点 ${i} 图片生成成功，dataUrl长度:`, dataUrl.length);
          
          const img = await loadImage(dataUrl);
          images.push(img);
        } finally {
          // 恢复多选框显示和边框
          if (checkbox) checkbox.style.display = originalCheckboxDisplay;
          if (label) label.style.display = originalLabelDisplay;
          node.style.border = originalBorder;
          node.style.borderRadius = originalBorderRadius;
        }
        
        await sleep(50);
      }

      const rawMaxWidth = Math.max(...images.map(img => img.width));
      const canvasWidth = Math.min(rawMaxWidth, MAX_WIDTH);
      let totalHeight = 0;
      const scaled = images.map(img => {
        const scale = canvasWidth / img.width;
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        totalHeight += h;
        return { img, w, h };
      });
      totalHeight += PADDING * Math.max(0, scaled.length - 1);

      const canvas = document.createElement('canvas');
      canvas.width = canvasWidth;
      canvas.height = totalHeight;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.fillStyle = BG_COLOR;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      let y = 0;
      for (const s of scaled) {
        ctx.drawImage(s.img, 0, y, s.w, s.h);
        y += s.h + PADDING;
      }

      return new Promise(resolve => {
        canvas.toBlob(blob => {
          resolve(blob);
        }, 'image/png');
      });
    },

    // 确保html-to-image库已加载
    async ensureHtmlToImageLoaded() {
      console.log('检查html-to-image库加载状态...');
      
      // 检查是否已有可用的toPng函数
      if (this.getHtmlToImageLib()) {
        console.log('html-to-image库已加载');
        return;
      }

      return new Promise((resolve, reject) => {
        console.log('开始加载html-to-image库...');
        
        // 使用页面上下文注入脚本
        const scriptContent = `
          (function() {
            if (window.htmlToImage) {
              console.log('html-to-image库已存在');
              return;
            }
            
            var script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.min.js';
            script.onload = function() {
              console.log('html-to-image库加载完成');
              console.log('window.htmlToImage:', typeof window.htmlToImage);
              console.log('window.htmlToImage.toPng:', typeof window.htmlToImage?.toPng);
              
              if (window.htmlToImage && window.htmlToImage.toPng) {
                console.log('✓ html-to-image库加载成功');
                
                // 尝试将库暴露给userscript上下文
                try {
                  // 为Tampermonkey创建一个全局引用
                  if (typeof GM_setValue !== 'undefined') {
                    // Tampermonkey环境
                    window.htmlToImageLib = window.htmlToImage;
                  }
                } catch (e) {
                  console.log('无法为Tampermonkey暴露库:', e);
                }
                
                // 通过自定义事件通知
                document.dispatchEvent(new CustomEvent('htmlToImageLoaded', {
                  detail: { library: window.htmlToImage }
                }));
              } else {
                console.error('✗ html-to-image库加载失败');
                document.dispatchEvent(new CustomEvent('htmlToImageLoadFailed'));
              }
            };
            script.onerror = function() {
              console.error('html-to-image库脚本加载失败');
              document.dispatchEvent(new CustomEvent('htmlToImageLoadFailed'));
            };
            document.head.appendChild(script);
          })();
        `;
        
        const script = document.createElement('script');
        script.textContent = scriptContent;
        document.head.appendChild(script);
        
        // 监听加载完成事件
        const handleLoadSuccess = (event) => {
          document.removeEventListener('htmlToImageLoaded', handleLoadSuccess);
          document.removeEventListener('htmlToImageLoadFailed', handleLoadFailed);
          
          // 如果事件详情中有库引用，尝试保存它
          if (event.detail && event.detail.library) {
            console.log('从事件详情中获取库引用');
            // 在userscript上下文中保存库引用
            try {
              window.htmlToImageLib = event.detail.library;
            } catch (e) {
              console.log('无法保存库引用:', e);
            }
          }
          
          resolve();
        };
        
        const handleLoadFailed = () => {
          document.removeEventListener('htmlToImageLoaded', handleLoadSuccess);
          document.removeEventListener('htmlToImageLoadFailed', handleLoadFailed);
          reject(new Error('html-to-image库加载失败'));
        };
        
        document.addEventListener('htmlToImageLoaded', handleLoadSuccess);
        document.addEventListener('htmlToImageLoadFailed', handleLoadFailed);
        
        // 超时处理
        const self = this;
        setTimeout(() => {
          document.removeEventListener('htmlToImageLoaded', handleLoadSuccess);
          document.removeEventListener('htmlToImageLoadFailed', handleLoadFailed);
          if (!self.getHtmlToImageLib()) {
            reject(new Error('html-to-image库加载超时'));
          }
        }, 10000);
      });
    },

    // 获取html-to-image库
    getHtmlToImageLib() {
      // 首先尝试通过unsafeWindow访问（如果可用）
      try {
        if (typeof unsafeWindow !== 'undefined' && unsafeWindow.htmlToImage && unsafeWindow.htmlToImage.toPng) {
          console.log('通过unsafeWindow找到html-to-image库');
          return unsafeWindow.htmlToImage;
        }
      } catch (e) {
        console.log('unsafeWindow不可用');
      }
      
      const possibleGlobals = [
        'htmlToImage',
        'htmlToImageLib', 
        'htmlToImageLibrary',
        'HtmlToImage',
        'HTMLToImage'
      ];
      
      // 首先检查已知全局变量
      for (const globalName of possibleGlobals) {
        const global = window[globalName];
        if (global && global.toPng) {
          console.log(`找到库: ${globalName}`);
          return global;
        }
      }
      
      // 如果没找到，检查window上所有包含html或image的属性
      const allWindowProps = Object.keys(window);
      const htmlImageProps = allWindowProps.filter(prop => 
        prop.toLowerCase().includes('html') && prop.toLowerCase().includes('image')
      );
      
      for (const prop of htmlImageProps) {
        const global = window[prop];
        if (global && global.toPng) {
          console.log(`找到库: ${prop} (动态检测)`);
          return global;
        }
      }
      
      // 尝试通过页面上下文访问
      try {
        const pageContextEval = function() {
          return window.htmlToImage;
        };
        const pageLib = eval(`(${pageContextEval})()`);
        if (pageLib && pageLib.toPng) {
          console.log('通过页面上下文找到html-to-image库');
          return pageLib;
        }
      } catch (e) {
        console.log('页面上下文访问失败:', e);
      }
      
      // 最后尝试通过document.currentScript等高级方式检测
      try {
        // 检查是否有任何脚本标签包含html-to-image
        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
          if (script.src && script.src.includes('html-to-image')) {
            console.log('找到html-to-image脚本，但需要手动检查导出');
            // 这里可能需要更复杂的逻辑来获取导出
          }
        }
      } catch (e) {
        console.log('高级检测失败:', e);
      }
      
      return null;
    },

    // 将对照块渲染为图片
    async renderPairAsImage(pairElement) {
      const MAX_WIDTH = 1080;
      const BG_COLOR = '#ffffff';

      const loadImage = (url) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.crossOrigin = 'anonymous';
        img.src = url;
      });

      // 确保html-to-image库已加载
      await this.ensureHtmlToImageLoaded();

      // 创建临时容器进行样式清理
      const tempContainer = document.createElement('div');
      tempContainer.style.position = 'absolute';
      tempContainer.style.left = '-9999px';
      tempContainer.style.top = '-9999px';
      tempContainer.style.backgroundColor = BG_COLOR;
      tempContainer.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      tempContainer.style.fontSize = '16px';
      tempContainer.style.lineHeight = '1.6';
      tempContainer.style.color = '#0b0b0d';
      tempContainer.style.padding = '20px';
      tempContainer.style.boxSizing = 'border-box';
      
      const clonedPair = pairElement.cloneNode(true);
      
      // 调试信息：检查克隆的内容
      console.log('原始对照块信息:', {
        textContent: pairElement.textContent?.substring(0, 100),
        innerHTML: pairElement.innerHTML?.substring(0, 200)
      });
      
      console.log('克隆对照块信息:', {
        textContent: clonedPair.textContent?.substring(0, 100),
        innerHTML: clonedPair.innerHTML?.substring(0, 200)
      });
      
      // 移除勾选框
      const checkbox = clonedPair.querySelector('.ao3x-multiselect-checkbox');
      const label = clonedPair.querySelector('.ao3x-multiselect-label');
      if (checkbox) checkbox.remove();
      if (label) label.remove();
      
      // 清理样式
      clonedPair.style.border = 'none';
      clonedPair.style.boxShadow = 'none';
      clonedPair.style.borderRadius = '0';
      clonedPair.style.margin = '0';
      clonedPair.style.background = 'transparent';
      
      // 设置原文和译文样式
      const origElement = clonedPair.querySelector('.orig');
      const transElement = clonedPair.querySelector('.trans');
      
      if (origElement) {
        origElement.style.color = '#374151';
        origElement.style.lineHeight = '1.6';
        origElement.style.marginBottom = '12px';
        origElement.style.paddingBottom = '12px';
        origElement.style.borderBottom = '1px solid #e5e5e5';
      }
      
      if (transElement) {
        transElement.style.color = '#111';
        transElement.style.lineHeight = '1.7';
        transElement.style.marginTop = '0';
        transElement.style.paddingTop = '0';
        transElement.style.borderTop = 'none';
      }
      
      tempContainer.appendChild(clonedPair);
      document.body.appendChild(tempContainer);
      
      // 调试信息：检查添加到容器后的内容
      console.log('添加到容器后的对照块信息:', {
        textContent: clonedPair.textContent?.substring(0, 100),
        innerHTML: clonedPair.innerHTML?.substring(0, 200)
      });
      
      console.log('完整临时容器信息:', {
        textContent: tempContainer.textContent?.substring(0, 100),
        innerHTML: tempContainer.innerHTML?.substring(0, 200)
      });
      
      // 等待一小段时间确保样式应用
      await sleep(100);
      
      const rect = tempContainer.getBoundingClientRect();
      const width = Math.ceil(rect.width);
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const pixelRatio = Math.min((MAX_WIDTH / width) || dpr, dpr);
      
      // 调试信息
      console.log('临时容器信息:', {
        width: rect.width,
        height: rect.height,
        content: tempContainer.textContent?.substring(0, 100),
        innerHTML: tempContainer.innerHTML?.substring(0, 200)
      });

      // 获取html-to-image库
      const htmlToImageLib = this.getHtmlToImageLib();
      if (!htmlToImageLib || !htmlToImageLib.toPng) {
        throw new Error('html-to-image库未正确加载');
      }
      
      const dataUrl = await htmlToImageLib.toPng(tempContainer, {
        backgroundColor: BG_COLOR,
        pixelRatio,
        cacheBust: true,
        style: { 
          width: width + 'px',
          visibility: 'visible',
          opacity: '1',
          display: 'block'
        },
        filter: (node) => {
          // 确保不过滤任何节点
          return true;
        }
      });

      document.body.removeChild(tempContainer);
      
      return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          canvas.toBlob(blob => {
            resolve(blob);
          }, 'image/png');
        };
        img.src = dataUrl;
      });
    },

    
    // 显示图片预览
    showImagePreview(imageBlob, fileName) {
      const url = URL.createObjectURL(imageBlob);
      const modal = document.createElement('div');
      modal.className = 'ao3x-image-preview-modal';
      
      // iOS Safari优化：使用内联样式避免CSS加载问题
      modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.9);
        z-index: 999999;
        display: flex;
        align-items: center;
        justify-content: center;
        -webkit-overflow-scrolling: touch;
        -webkit-transform: translateZ(0);
        transform: translateZ(0);
        opacity: 0;
        transition: opacity 0.3s ease;
      `;
      
      modal.innerHTML = `
        <div style="
          background: white;
          border-radius: 12px;
          max-width: 90%;
          max-height: 90%;
          overflow: hidden;
          -webkit-overflow-scrolling: touch;
          -webkit-transform: translateZ(0);
          transform: translateZ(0);
          box-shadow: 0 10px 40px rgba(0,0,0,0.3);
        ">
          <div style="
            padding: 16px 20px;
            border-bottom: 1px solid #eee;
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: white;
            border-radius: 12px 12px 0 0;
          ">
            <span style="font-size: 16px; color: #333; font-weight: 600;">${fileName}</span>
            <button style="
              background: none;
              border: none;
              font-size: 28px;
              cursor: pointer;
              color: #666;
              padding: 0;
              width: 40px;
              height: 40px;
              display: flex;
              align-items: center;
              justify-content: center;
              -webkit-user-select: none;
              user-select: none;
              border-radius: 50%;
              transition: all 0.2s ease;
            " onclick="this.closest('.ao3x-image-preview-modal').remove()">×</button>
          </div>
          <div style="
            max-height: 70vh;
            overflow-y: auto;
            -webkit-overflow-scrolling: touch;
            background: #f8f9fa;
          ">
            <img src="${url}" alt="${fileName}" style="
              max-width: 100%;
              height: auto;
              display: block;
              -webkit-user-select: none;
              user-select: none;
              -webkit-user-drag: none;
              pointer-events: none;
              background: white;
            " />
          </div>
          <div style="
            padding: 16px 20px;
            border-top: 1px solid #eee;
            display: flex;
            gap: 12px;
            background: white;
            border-radius: 0 0 12px 12px;
          ">
            <button style="
              background: #007aff;
              color: white;
              border: none;
              padding: 12px 24px;
              border-radius: 8px;
              font-size: 16px;
              cursor: pointer;
              -webkit-user-select: none;
              user-select: none;
              -webkit-appearance: none;
              appearance: none;
              font-weight: 500;
              transition: all 0.2s ease;
            " onclick="Controller.downloadImage('${url}', '${fileName}')">下载图片</button>
            <button style="
              background: #34c759;
              color: white;
              border: none;
              padding: 12px 24px;
              border-radius: 8px;
              font-size: 16px;
              cursor: pointer;
              -webkit-user-select: none;
              user-select: none;
              -webkit-appearance: none;
              appearance: none;
              touch-action: manipulation;
              font-weight: 500;
              transition: all 0.2s ease;
            " onmousedown="Controller.startImageLongPress(this)" ontouchstart="Controller.startImageLongPress(this)">长按保存</button>
          </div>
        </div>
      `;

      // iOS Safari特殊处理：先隐藏，添加到DOM，然后显示
      modal.style.display = 'none';
      document.body.appendChild(modal);
      
      // 强制重绘并显示
      requestAnimationFrame(() => {
        modal.style.display = 'flex';
        
        // 触发重绘确保iOS Safari正确渲染
        modal.offsetHeight;
        modal.style.opacity = '1';
        
        // iOS设备特殊处理
        if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
          // 强制滚动到顶部
          setTimeout(() => {
            modal.scrollTop = 0;
            const content = modal.querySelector('div[style*="background: white"]');
            if (content) {
              content.scrollTop = 0;
            }
            
            // 再次强制重绘
            modal.style.display = 'none';
            modal.offsetHeight;
            modal.style.display = 'flex';
          }, 50);
        }
      });

      // 点击背景关闭
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.style.opacity = '0';
          setTimeout(() => {
            modal.remove();
            URL.revokeObjectURL(url);
          }, 300);
        }
      });
      
      // iOS Safari特殊处理：阻止默认的缩放和滚动行为
      modal.addEventListener('touchmove', (e) => {
        if (e.target === modal) {
          e.preventDefault();
        }
      }, { passive: false });
    },

    // 下载图片
    downloadImage(url, fileName) {
      const a = document.createElement('a');
      a.href = url;
      a.download = `${fileName}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      UI.toast(`已下载 ${fileName}.png`);
    },

    // 开始图片长按
    startImageLongPress(button) {
      // 阻止文本选择和默认行为
      const preventSelection = (e) => {
        e.preventDefault();
        e.stopPropagation();
        return false;
      };
      
      // 添加事件监听器阻止文本选择
      button.addEventListener('selectstart', preventSelection);
      button.addEventListener('mousedown', preventSelection);
      button.addEventListener('touchstart', preventSelection);
      
      // 为iOS添加额外保护
      button.style.userSelect = 'none';
      button.style.webkitUserSelect = 'none';
      button.style.touchCallout = 'none';
      button.style.webkitTouchCallout = 'none';
      button.style.touchAction = 'manipulation';
      
      let longPressTimer = setTimeout(() => {
        const modal = button.closest('.ao3x-image-preview-modal');
        const img = modal.querySelector('img');
        if (img) {
          const url = img.src;
          const fileName = modal.querySelector('div[style*="font-size: 16px"]').textContent;
          this.downloadImage(url, fileName);
        }
      }, 1000);

      const cancelLongPress = () => {
        clearTimeout(longPressTimer);
        // 移除事件监听器
        button.removeEventListener('selectstart', preventSelection);
        button.removeEventListener('mousedown', preventSelection);
        button.removeEventListener('touchstart', preventSelection);
        // 恢复样式
        button.style.userSelect = '';
        button.style.webkitUserSelect = '';
        button.style.touchCallout = '';
        button.style.webkitTouchCallout = '';
        button.style.touchAction = '';
      };

      button.addEventListener('mouseup', cancelLongPress);
      button.addEventListener('mouseleave', cancelLongPress);
      button.addEventListener('touchend', cancelLongPress);
      button.addEventListener('touchcancel', cancelLongPress);
    },

    // 获取作品名和章节名
    getWorkInfo() {
      const titleElement = document.querySelector('h2.title.heading');
      const workTitle = titleElement ? titleElement.textContent.trim() : '未知作品';

      // 尝试多种章节名选择器
      const chapterElement = document.querySelector('.chapter.preface.group h3.title a') ||
                           document.querySelector('.chapter h3.title a') ||
                           document.querySelector('h3.title a');
      const chapterTitle = chapterElement ? chapterElement.textContent.trim() : '未知章节';

      return {
        workTitle: workTitle,
        chapterTitle: chapterTitle
      };
    },

    // 下载翻译为TXT文件
    downloadTranslation() {
      const cacheInfo = TransStore.getCacheInfo();
      if (!cacheInfo.hasCache || cacheInfo.completed === 0) {
        UI.toast('没有可下载的翻译内容');
        return;
      }

      const { workTitle, chapterTitle } = this.getWorkInfo();
      const fileName = `${workTitle}-${chapterTitle}.txt`;

      // 收集所有翻译内容
      let fullText = '';
      const total = cacheInfo.total;

      for (let i = 0; i < total; i++) {
        const translation = TransStore.get(String(i));
        if (translation) {
          // 智能提取文本，保留段落结构
          const text = this.extractTextWithStructure(translation);
          if (text) {
            fullText += text + '\n\n';
          }
        }
      }

      if (!fullText.trim()) {
        UI.toast('翻译内容为空');
        return;
      }

// ★ 根据 UA 选择下载方式（EvansBrowser 走 CF Workers 表单 POST）
const ua = navigator.userAgent || '';
const isEvans = /\bEvansBrowser\/\d/i.test(ua);  // 放宽匹配，避免等号匹配失败

if (isEvans) {
  UI.toast('EvansBrowser → 走 Cloudflare Workers（POST）');
  const action = `https://txt.jagerze.tech/cd-post/${encodeURIComponent(fileName)}`;
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = action;
  form.style.display = 'none';

  const textarea = document.createElement('textarea');
  textarea.name = 'text';   // Workers 从这个字段取文本
  textarea.value = fullText;

  form.appendChild(textarea);
  document.body.appendChild(form);
  form.submit();
  setTimeout(() => form.remove(), 2000);
  return; // 别继续走 Blob 分支
}

// ↓ 其他浏览器保留原来的 Blob 下载
const blob = new Blob([fullText], { type: 'text/plain;charset=utf-8' });
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = fileName;
document.body.appendChild(a);
a.click();
document.body.removeChild(a);
URL.revokeObjectURL(url);
UI.toast(`已下载 ${fileName}`);

    // 智能提取文本，保留段落结构
    extractTextWithStructure(html) {
      // 创建临时DOM元素来解析HTML
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = html;

      // 递归提取文本，保留段落结构
      const extractText = (element) => {
        let text = '';

        // 处理文本节点
        for (let node of element.childNodes) {
          if (node.nodeType === Node.TEXT_NODE) {
            const content = node.textContent.trim();
            if (content) {
              text += content + ' ';
            }
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            const tagName = node.tagName.toLowerCase();

            // 块级元素处理：添加换行
            if (['p', 'div', 'br', 'blockquote', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tagName)) {
              const blockText = extractText(node).trim();
              if (blockText) {
                text += blockText + '\n';
              }
            }
            // 行内元素处理：直接添加文本
            else if (['span', 'strong', 'em', 'i', 'b', 'a', 'code', 'small', 'sub', 'sup'].includes(tagName)) {
              text += extractText(node);
            }
            // 其他元素：递归处理
            else {
              text += extractText(node);
            }
          }
        }

        return text;
      };

      // 提取并清理文本
      let extractedText = extractText(tempDiv);

      // 替换HTML实体字符
      extractedText = extractedText
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");

      // 清理多余的空格和换行
      extractedText = extractedText
        .replace(/[ \t]+/g, ' ')  // 多个空格/制表符合并为一个空格
        .replace(/\n\s*\n\s*\n/g, '\n\n')  // 多个空行合并为两个换行
        .replace(/\n +\n/g, '\n\n')  // 移除空行中的空格
        .replace(/\s+$/g, '')  // 移除末尾空格
        .replace(/^\s+/g, '');  // 移除开头空格

      return extractedText.trim();
    },

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
            max_tokens: settings.get().gen.maxTokens,
            stream: !!settings.get().stream.enabled
          },
          stream: s.stream.enabled,
          label,
          onDelta: (delta) => { Streamer.push(idx, delta, (k, clean)=>{ TransStore.set(String(k), clean); Controller.applyDirect(k, clean); }); },
          onFinishReason: (fr)=>{ d('retry:finish_reason', {idx, fr}); },
          onDone: () => {
            TransStore.markDone(idx);
            inFlight--; completed++;
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
      const conc = Math.max(1, Math.min(4, s.concurrency || 2));
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

      // 重置缓存显示状态，因为现在要开始新的翻译
      View.setShowingCache(false);
      UI.updateToolbarState(); // 更新工具栏状态，重新显示双语对照按钮

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
      const maxT = s.gen.maxTokens || 1024;
      // ★ 核心预算：k<1 时更“能塞”
      // 约束1：out = k * in ≤ max_tokens  → in ≤ max_tokens / k
      // 约束2：prompt + in + out + reserve ≤ cw → in(1+k) ≤ (cw - prompt - reserve)
      const cap1 = maxT / ratio;
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
      const maxTokensLocal = Math.max(256, Math.min(userMaxTokens, outCapByCw, predictedOut));
      d('single:tokens', { inTok, predictedOut, outCapByCw, userMaxTokens, maxTokensLocal });
      if (maxTokensLocal < 256) throw new Error('上下文空间不足');

      const i = 0;
      await postChatWithRetry({
        endpoint, key, stream,
        payload: {
          model: settings.get().model.id,
          messages: [
            { role:'system', content: settings.get().prompt.system },
            { role:'user',   content: settings.get().prompt.userTemplate.replace('{{content}}', contentHtml) }
          ],
          temperature: settings.get().gen.temperature,
          max_tokens: maxTokensLocal,
          stream: !!settings.get().stream.enabled
        },
        label:`single#${i}`,
        onDelta: (delta)=>{ Streamer.push(i, delta, (k, clean)=>{ View.setBlockTranslation(k, clean); }); },
        onFinishReason: (fr)=>{ d('finish_reason', {i, fr}); },
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
      let currentBudget = Math.floor(Math.max(0, Math.min(userMaxTokens/liveRatio, (modelCw - promptTokens - reserve)/(1+liveRatio))) * (settings.get().planner.packSlack || 0.95));

      const started = new Set(); // 已经发出的 index

      const startNext = ()=>{ while(inFlight < concurrency && nextToStart < plan.length){ startChunk(nextToStart++); } };

      const startChunk = (i)=>{
        started.add(i);
        const inputTok = plan[i].inTok != null ? plan[i].inTok : 0;
        const predictedOut = Math.ceil(inputTok * liveRatio);
        const outCapByCw   = Math.max(256, modelCw - promptTokens - inputTok - reserve);
        let maxTokensLocal = Math.max(256, Math.min(userMaxTokens, outCapByCw, predictedOut));
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
            max_tokens: maxTokensLocal,
            stream: !!settings.get().stream.enabled
          }, stream, label,
          onDelta: (delta)=>{ Streamer.push(i, delta, (k, clean)=>{ View.setBlockTranslation(k, clean); }); },
          onFinishReason: async (fr)=>{
            d('finish_reason', {i, fr});
            if(fr === 'length'){
              // 优先：适度扩大 out，再次尝试一次
              const extra = Math.floor(maxTokensLocal * 0.5);
              const newOutCapByCw = Math.max(256, modelCw - promptTokens - inputTok - reserve);
              const maybe = Math.min(userMaxTokens, newOutCapByCw);
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
                    max_tokens: newMax,
                    stream: !!settings.get().stream.enabled
                  },
                  onDelta: (delta)=>{ Streamer.push(i, delta, (k, clean)=>{ View.setBlockTranslation(k, clean); }); },
                  onFinishReason: (fr2)=>{ d('finish_reason(second)', {i, fr2}); },
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
            TransStore.markDone(i);
            inFlight--; completed++;
            d('chunk:done', {i, ms: Math.round(performance.now()-begin)});
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
                currentBudget = Math.floor(Math.max(0, Math.min(userMaxTokens/liveRatio, (modelCw - promptTokens - reserve)/(1+liveRatio))) * (settings.get().planner.packSlack || 0.95));
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
            inFlight--; failed++;
            d('chunk:error', {i, err: e.message});
            const clean=(TransStore.get(String(i))||'')+`<p class="ao3x-muted">[该段失败：${e.message}]</p>`;
            TransStore.set(String(i), clean);
            TransStore.markDone(i);
            View.setBlockTranslation(i, clean);
            RenderState.finalizeCurrent();
            updateKV({ 进行中: inFlight, 完成: completed, 失败: failed });
            startNext();
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
    _buf: Object.create(null),
    _dirty: Object.create(null),
    _raf: null,
    _last: 0,
    push(i, delta, apply) {
      this._buf[i] = (this._buf[i] || '') + delta;
      this._dirty[i] = true;
      this.schedule((k, clean)=>apply(k, clean));
    },
    done(i, apply) {
      this._dirty[i] = true;
      this.schedule((k, clean)=>apply(k, clean), true);
    },
    getCleanNow(i){
      const raw = (this._buf && this._buf[i]) || '';
      if (!raw) return '';
      const html = /[<][a-zA-Z]/.test(raw) ? raw : raw.replace(/\n/g, '<br/>');
      return sanitizeHTML(html);
    },
    schedule(apply, force = false) {
      const { minFrameMs } = (typeof settings !== 'undefined' ? settings.get().stream : { minFrameMs: 40 });
      if (this._raf) return;
      const tick = () => {
        this._raf = null;
        const now = performance.now();
        if (!force && now - this._last < (minFrameMs ?? 40)) { this._raf = requestAnimationFrame(tick); return; }
        this._last = now;

        const keys = Object.keys(this._dirty).filter(k => this._dirty[k]);
        for (const k of keys) {
          const raw = this._buf[k] || '';
          const html = /[<][a-zA-Z]/.test(raw) ? raw : raw.replace(/\n/g, '<br/>');
          const clean = sanitizeHTML(html);
          this._dirty[k] = false;
          apply(Number(k), clean);
        }
        if (Object.values(this._dirty).some(Boolean)) this._raf = requestAnimationFrame(tick);
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

  /* ================= 自动加载缓存 ================= */
  async function autoLoadFromCache(nodes, cacheInfo) {
    try {
      // 标记当前正在显示缓存
      View.setShowingCache(true);

      // 收集章节内容并创建翻译计划
      markSelectedNodes(nodes);

      const allHtml = nodes.map(n => n.innerHTML);
      const fullHtml = allHtml.join('\n');

      // 估算token并创建计划
      const s = settings.get();
      const allText = stripHtmlToText(fullHtml);
      const allEstIn = await estimateTokensForText(allText);

      const cw = s.model.contextWindow || 8192;
      const maxT = s.gen.maxTokens || 1024;
      const ratio = Math.max(0.3, s.planner?.ratioOutPerIn ?? 0.7);
      const reserve = s.planner?.reserve ?? 384;
      const packSlack = Math.max(0.5, Math.min(1, s.planner?.packSlack ?? 0.95));

      // 固定prompt token（不含正文）
      const promptTokens = await estimatePromptTokensFromMessages([
        { role:'system', content: s.prompt.system || '' },
        { role:'user',   content: (s.prompt.userTemplate || '').replace('{{content}}','') }
      ]);

      const cap1 = maxT / ratio;
      const cap2 = (cw - promptTokens - reserve) / (1 + ratio);
      const maxInputBudgetRaw = Math.max(0, Math.min(cap1, cap2));
      const maxInputBudget = Math.floor(maxInputBudgetRaw * packSlack);

      const slackSingle = s.planner?.singleShotSlackRatio ?? 0.15;
      const canSingle = allEstIn <= maxInputBudget * (1 + Math.max(0, slackSingle));

      // 创建计划（与缓存大小匹配）
      let plan = [];
      if (canSingle) {
        const inTok = await estimateTokensForText(allText);
        plan = [{ index: 0, html: fullHtml, text: allText, inTok }];
      } else {
        plan = await packIntoChunks(allHtml, maxInputBudget);
      }

      // 确保计划长度与缓存匹配
      if (plan.length !== cacheInfo.total) {
        // 如果不匹配，调整计划长度以匹配缓存
        if (plan.length < cacheInfo.total) {
          // 需要分更多块
          const remaining = cacheInfo.total - plan.length;
          for (let i = 0; i < remaining; i++) {
            plan.push({
              index: plan.length + i,
              html: '',
              text: '',
              inTok: 0
            });
          }
        } else {
          // 需要合并块
          plan = plan.slice(0, cacheInfo.total);
        }
      }

      // 渲染计划锚点
      renderPlanAnchors(plan);
      View.setMode('trans');
      RenderState.setTotal(plan.length);
      Bilingual.setTotal(plan.length);

      // 显示工具栏
      UI.showToolbar();

      // 刷新显示以加载缓存内容
      View.refresh(true);

      // 更新工具栏状态
      UI.updateToolbarState();

      // 显示提示信息
      UI.toast(`已自动加载 ${cacheInfo.completed}/${cacheInfo.total} 段缓存翻译`);

      if (settings.get().debug) {
        console.log('[AO3X] Auto-loaded cache:', cacheInfo);
      }

    } catch (e) {
      console.error('[AO3X] Failed to auto-load cache:', e);
      UI.toast('自动加载缓存失败');
    }
  }

  /* ================= Boot ================= */
  function init(){
    UI.init();
    applyFontSize(); // 应用初始字体大小设置

    // 初始化翻译缓存
    TransStore.initCache();

    const nodes = collectChapterUserstuffSmart();
    if (!nodes.length) UI.toast('未找到章节正文（请确认页面是否是章节页）');

    // 检查是否有缓存，如果有则自动加载
    const cacheInfo = TransStore.getCacheInfo();
    if (cacheInfo.hasCache) {
      // 延迟一下确保UI已经初始化完成
      setTimeout(() => {
        autoLoadFromCache(nodes, cacheInfo);
      }, 100);
    }

    const mo = new MutationObserver(()=>{ /* no-op，保留接口 */ });
    mo.observe(document.documentElement, { childList:true, subtree:true });
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init); else init();

})();
