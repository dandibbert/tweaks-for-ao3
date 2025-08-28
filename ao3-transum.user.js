// ==UserScript==
// @name         AO3 全文翻译+总结（移动端 Safari / Tampermonkey）
// @namespace    https://ao3-translate.example
// @version      0.8.2
// @description  【翻译+总结双引擎】精确token计数；智能分块策略；流式渲染；章节总结功能；独立缓存系统；四视图切换（译文/原文/双语/总结）；长按悬浮菜单；移动端优化；OpenAI兼容API。
// @match        https://archiveofourown.org/works/*
// @match        https://archiveofourown.org/chapters/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
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
      model: { id: '', contextWindow: 16000 },
      gen: { maxTokens: 7000, temperature: 0.7, top_p: 1 },
      translate: {
        model: { id: '', contextWindow: 16000 },
        gen: { maxTokens: 7000, temperature: 0.7, top_p: 1 },
        reasoningEffort: -1  // -1不发送, 'none'/'low'/'medium'/'high'才发送
      },
      prompt: {
        system: '你是专业的文学翻译助手。请保持 AO3 文本结构、段落层次、行内格式（粗体、斜体、链接），人名不做翻译，术语翻译时意译，以保证不了解者也能看懂为准则，语气自然流畅。',
        userTemplate: '请将以下 AO3 正文完整翻译为中文，人名保持原文，术语翻译时意译，以保证不了解者也能看懂为准则，保持 HTML 结构与行内标记，仅替换可见文本内容：\n{{content}}\n（请直接返回 HTML 片段，不要使用代码块或转义。）'
      },
      summary: {
        model: { id: '', contextWindow: 16000 },
        gen: { maxTokens: 7000, temperature: 0.7, top_p: 1 },
        reasoningEffort: -1,  // -1不发送, 'none'/'low'/'medium'/'high'才发送
        system: '你是专业的文学内容总结助手。请准确概括故事情节、人物关系和重要事件，保持客观中性的语调，不要做文本分析，仅输出总结内容。',
        userTemplate: '请对以下AO3章节内容进行剧情总结，重点包括：主要情节发展、角色互动、重要对话或事件。请用简洁明了的中文总结：\n{{content}}\n（请直接返回总结内容，不需要格式化，不需要做文本分析，人名保留原文不翻译。）',
        ratioTextToSummary: 0.3  // 总结通常比原文更简洁
      },
      stream: { enabled: true, minFrameMs: 30 },
      concurrency: 3,
      debug: false,
      ui: { fontSize: 16 }, // 译文字体大小
      planner: {
        reserve: 384,
        trySingleShotOnce: true,
        singleShotSlackRatio: 0.15,
        packSlack: 0.95,          // 更激进一点
        ratioOutPerIn: 1        // ★ 英->中常见：输出token约为输入的70%
      },
      watchdog: { idleMs: -1, hardMs: -1, maxRetry: 1 },
      download: { workerUrl: '' }
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
  function GM_Del(k){ try{ GM_deleteValue(k); }catch{ try{ localStorage.removeItem(k); }catch{} } }
  function GM_ListKeys(){ try{ return (typeof GM_listValues === 'function') ? GM_listValues() : Object.keys(localStorage); }catch{ try{ return Object.keys(localStorage); }catch{ return []; } } }


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

      // 创建悬浮按钮组容器
      const floatingMenu = document.createElement('div');
      floatingMenu.className = 'ao3x-floating-menu';
      floatingMenu.style.display = 'none';

      // 创建下载按钮
      const btnDownload = document.createElement('button');
      btnDownload.className = 'ao3x-btn ao3x-floating-btn';
      btnDownload.textContent = '📥';
      btnDownload.title = '下载当前译文缓存';

      // 创建总结按钮
      const btnSummary = document.createElement('button');
      btnSummary.className = 'ao3x-btn ao3x-floating-btn';
      btnSummary.textContent = '📝';
      btnSummary.title = '生成章节总结';

      // 移除占位按钮，菜单仅保留“下载”和“总结”两个按钮
      floatingMenu.appendChild(btnDownload);
      floatingMenu.appendChild(btnSummary);
      wrap.appendChild(floatingMenu);

      // 长按功能变量
      let longPressTimer = null;
      let isLongPress = false;
      let isMenuVisible = false;

      // 显示/隐藏悬浮菜单
      const showFloatingMenu = () => {
        if (isMenuVisible) return;
        isMenuVisible = true;
        floatingMenu.style.display = 'flex';
        // 添加动画效果
        requestAnimationFrame(() => {
          floatingMenu.classList.add('visible');
        });
      };

      const hideFloatingMenu = () => {
        if (!isMenuVisible) return;
        isMenuVisible = false;
        floatingMenu.classList.remove('visible');
        // 延迟隐藏以等待动画完成
        setTimeout(() => {
          if (!isMenuVisible) {
            floatingMenu.style.display = 'none';
          }
        }, 200);
      };

      const startLongPress = () => {
        isLongPress = false;
        longPressTimer = setTimeout(() => {
          isLongPress = true;
          showFloatingMenu();
        }, 800); // 0.8秒长按
      };

      const cancelLongPress = () => {
        clearTimeout(longPressTimer);
        // 长按完成后不要立即隐藏菜单，让用户可以点击
        // 重置长按状态需要延迟，避免影响click事件
        setTimeout(() => {
          isLongPress = false;
        }, 50);
      };

      // iOS Safari文本选择防护
      const preventSelection = (e) => {
        // 检查是否有target和closest方法
        if (e.target && typeof e.target.closest === 'function') {
          if (e.target.closest('.ao3x-btn')) {
            e.preventDefault();
            e.stopPropagation();
            return false;
          }
        } else if (e.target) {
          // 向上遍历DOM树查找匹配的元素（兼容性fallback）
          let element = e.target;
          while (element && element !== document) {
            if (element.classList && element.classList.contains('ao3x-btn')) {
              e.preventDefault();
              e.stopPropagation();
              return false;
            }
            element = element.parentNode;
          }
        }
      };

      // 鼠标事件（桌面）
      btnTranslate.addEventListener('mousedown', (e) => {
        preventSelection(e);
        startLongPress();
      });
      btnTranslate.addEventListener('mouseup', cancelLongPress);
      btnTranslate.addEventListener('mouseleave', () => {
        cancelLongPress();
        // 鼠标离开时也隐藏菜单
        setTimeout(() => {
          if (isMenuVisible && !floatingMenu.matches(':hover') && !btnTranslate.matches(':hover')) {
            hideFloatingMenu();
          }
        }, 100);
      });

      // 触摸事件（移动设备）
      btnTranslate.addEventListener('touchstart', (e) => {
        preventSelection(e);
        startLongPress();
      });
      btnTranslate.addEventListener('touchend', cancelLongPress);
      btnTranslate.addEventListener('touchcancel', cancelLongPress);

      // 悬浮菜单事件
      floatingMenu.addEventListener('mouseleave', () => {
        // 鼠标离开悬浮菜单时延迟隐藏
        setTimeout(() => {
          if (isMenuVisible && !floatingMenu.matches(':hover') && !btnTranslate.matches(':hover')) {
            hideFloatingMenu();
          }
        }, 300);
      });

      // 点击外部区域隐藏菜单
      document.addEventListener('click', (e) => {
        if (isMenuVisible && !wrap.contains(e.target)) {
          hideFloatingMenu();
        }
      });

      // 添加全局文本选择防护
      document.addEventListener('selectstart', preventSelection);
      document.addEventListener('mousedown', preventSelection);
      document.addEventListener('touchstart', preventSelection);

      // 翻译按钮点击事件
      btnTranslate.addEventListener('click', (e) => {
        if (!isLongPress) {
          Controller.startTranslate();
        }
      });

      // 总结按钮事件
      btnSummary.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof SummaryController !== 'undefined' && SummaryController.startSummary) {
          SummaryController.startSummary();
        } else {
          UI.toast('总结功能尚未完全实现');
        }
        hideFloatingMenu();
      });

      // 下载按钮事件
      btnDownload.addEventListener('click', (e) => {
        e.stopPropagation();
        Controller.downloadTranslation();
        hideFloatingMenu();
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
            <h4 class="ao3x-section-title">翻译模型设置</h4>
            <div class="ao3x-field">
              <label>翻译模型名称</label>
              <div class="ao3x-input-group">
                <input id="ao3x-translate-model" type="text" placeholder="gpt-4o-mini"/>
                <button id="ao3x-fetch-models" class="ao3x-btn-secondary">获取列表</button>
              </div>
              <span class="ao3x-hint">翻译专用模型，可与总结模型不同</span>
            </div>
            <div id="ao3x-translate-model-browser" class="ao3x-model-browser" style="display:none">
              <div class="ao3x-field">
                <label>搜索模型</label>
                <input id="ao3x-translate-model-q" type="text" placeholder="输入关键词筛选模型..." class="ao3x-model-search"/>
              </div>
              <div class="ao3x-model-list" id="ao3x-translate-model-list"></div>
            </div>
            <div class="ao3x-field-group">
              <div class="ao3x-field">
                <label>翻译上下文窗口</label>
                <input id="ao3x-translate-cw" type="number" min="2048" value="16000"/>
              </div>
              <div class="ao3x-field">
                <label>翻译Max Tokens</label>
                <input id="ao3x-translate-maxt" type="number" min="128" value="7000"/>
              </div>
            </div>
            <div class="ao3x-field-group">
              <div class="ao3x-field">
                <label>翻译温度 <span class="ao3x-badge">0-2</span></label>
                <input id="ao3x-translate-temp" type="number" step="0.1" min="0" max="2" value="0.7"/>
              </div>
              <div class="ao3x-field">
                <label>翻译推理强度</label>
                <select id="ao3x-translate-reasoning">
                  <option value="-1">不发送</option>
                  <option value="none">none</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
              </div>
            </div>
          </div>

          <div class="ao3x-section">
            <h4 class="ao3x-section-title">总结模型设置</h4>
            <div class="ao3x-field">
              <label>总结模型名称</label>
              <div class="ao3x-input-group">
                <input id="ao3x-summary-model" type="text" placeholder="gpt-4o-mini"/>
                <button id="ao3x-fetch-summary-models" class="ao3x-btn-secondary">获取列表</button>
              </div>
              <span class="ao3x-hint">总结专用模型，可与翻译模型不同</span>
            </div>
            <div id="ao3x-summary-model-browser" class="ao3x-model-browser" style="display:none">
              <div class="ao3x-field">
                <label>搜索模型</label>
                <input id="ao3x-summary-model-q" type="text" placeholder="输入关键词筛选模型..." class="ao3x-model-search"/>
              </div>
              <div class="ao3x-model-list" id="ao3x-summary-model-list"></div>
            </div>
            <div class="ao3x-field-group">
              <div class="ao3x-field">
                <label>总结上下文窗口</label>
                <input id="ao3x-summary-cw" type="number" min="2048" value="16000"/>
              </div>
              <div class="ao3x-field">
                <label>总结Max Tokens</label>
                <input id="ao3x-summary-maxt" type="number" min="128" value="7000"/>
              </div>
            </div>
            <div class="ao3x-field-group">
              <div class="ao3x-field">
                <label>总结温度 <span class="ao3x-badge">0-2</span></label>
                <input id="ao3x-summary-temp" type="number" step="0.1" min="0" max="2" value="0.7"/>
              </div>
              <div class="ao3x-field">
                <label>总结推理强度</label>
                <select id="ao3x-summary-reasoning">
                  <option value="-1">不发送</option>
                  <option value="none">none</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
              </div>
            </div>
          </div>


          <div class="ao3x-section">
            <h4 class="ao3x-section-title">翻译提示词设置</h4>
            <div class="ao3x-field">
              <label>System Prompt</label>
              <textarea id="ao3x-sys" rows="3"></textarea>
            </div>
            <div class="ao3x-field">
              <label>User 模板 <span class="ao3x-hint">使用 {{content}} 作为占位符</span></label>
              <textarea id="ao3x-user" rows="3"></textarea>
            </div>
            <div class="ao3x-field">
              <label>译文/原文比 <span class="ao3x-hint">用于计算分块，通常译文比原文更长</span></label>
              <input id="ao3x-ratio" type="number" step="0.05" min="0.3" value="0.7"/>
            </div>
          </div>

          <div class="ao3x-section">
            <h4 class="ao3x-section-title">总结提示词设置</h4>
            <div class="ao3x-field">
              <label>System Prompt</label>
              <textarea id="ao3x-summary-sys" rows="3" placeholder="你是专业的文学内容总结助手..."></textarea>
            </div>
            <div class="ao3x-field">
              <label>User 模板 <span class="ao3x-hint">使用 {{content}} 作为占位符</span></label>
              <textarea id="ao3x-summary-user" rows="3" placeholder="请对以下AO3章节内容进行剧情总结...{{content}}"></textarea>
            </div>
            <div class="ao3x-field">
              <label>原文/总结比 <span class="ao3x-hint">用于计算分块，通常总结比原文更简洁</span></label>
              <input id="ao3x-summary-ratio" type="number" step="0.05" min="0.1" max="1" value="0.3"/>
            </div>
          </div>

          <div class="ao3x-section">
            <h4 class="ao3x-section-title">高级选项</h4>
            <div class="ao3x-field-group">
              <div class="ao3x-field">
                <label>并发数</label>
                <input id="ao3x-conc" type="number" min="1" max="8" value="3"/>
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
            <div class="ao3x-field">
              <label>下载服务URL</label>
              <input id="ao3x-download-worker" type="text" placeholder=""/>
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
            <div class="ao3x-field">
              <label>存储管理</label>
              <div class="ao3x-input-group">
                <button id="ao3x-list-storage" class="ao3x-btn-secondary">查看翻译缓存键</button>
                <button id="ao3x-clear-all-cache" class="ao3x-btn-secondary">清理所有翻译缓存</button>
              </div>
              <span class="ao3x-hint">作用域：本脚本使用的翻译缓存（键前缀 ao3_translator_）。</span>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(mask); document.body.appendChild(panel);
      panel.addEventListener('click', e => e.stopPropagation());
      $('#ao3x-close-x', panel).addEventListener('click', UI.closePanel);

      const fetchBtn = $('#ao3x-fetch-models', panel);
      const fetchSummaryBtn = $('#ao3x-fetch-summary-models', panel);
      const translateBrowserBox = $('#ao3x-translate-model-browser', panel);
      const summaryBrowserBox = $('#ao3x-summary-model-browser', panel);

      fetchBtn.addEventListener('click', async () => {
        translateBrowserBox.style.display = 'block';
        await ModelBrowser.fetchAndRender(panel, 'translate');
        UI.toast('翻译模型列表已更新');
      });

      fetchSummaryBtn.addEventListener('click', async () => {
        summaryBrowserBox.style.display = 'block';
        await ModelBrowser.fetchAndRender(panel, 'summary');
        UI.toast('总结模型列表已更新');
      });

      $('#ao3x-translate-model-q', panel).addEventListener('input', () => ModelBrowser.filter(panel, 'translate'));
      $('#ao3x-summary-model-q', panel).addEventListener('input', () => ModelBrowser.filter(panel, 'summary'));

      const autosave = () => {
        // 检查翻译模型变更时的同步逻辑
        const translateModel = $('#ao3x-translate-model', panel).value.trim();
        const summaryModel = $('#ao3x-summary-model', panel).value.trim();

        // 如果总结模型为空且翻译模型有值，则同步
        if (!summaryModel && translateModel) {
          $('#ao3x-summary-model', panel).value = translateModel;
        }

        settings.set(collectPanelValues(panel));
        applyFontSize();
        saveToast();
      };

      // 专门监听翻译模型输入框的变化
      $('#ao3x-translate-model', panel).addEventListener('input', debounce(() => {
        const translateModel = $('#ao3x-translate-model', panel).value.trim();
        const summaryModel = $('#ao3x-summary-model', panel).value.trim();

        // 如果总结模型为空，则自动同步翻译模型的值
        if (!summaryModel && translateModel) {
          $('#ao3x-summary-model', panel).value = translateModel;
        }
        autosave();
      }, 300));

      panel.addEventListener('input', debounce(autosave, 300), true);
      panel.addEventListener('change', autosave, true);
      panel.addEventListener('blur', (e)=>{ if(panel.contains(e.target)) autosave(); }, true);

      // 存储管理：列出与清理（GM 与 localStorage 双覆盖）
      $('#ao3x-list-storage', panel)?.addEventListener('click', () => {
        try{
          const gmKeys = GM_ListKeys().filter(k => typeof k === 'string' && k.startsWith('ao3_translator_'));
          const lsKeys = (function(){ try{ return Object.keys(localStorage).filter(k => k.startsWith('ao3_translator_')); }catch{ return []; } })();
          const allKeys = Array.from(new Set([...(gmKeys||[]), ...(lsKeys||[])]));
          if (!allKeys.length){ UI.toast('未发现翻译缓存键'); return; }
          const lines = allKeys.slice(0,50).join('\n') + (allKeys.length>50?'\n…':'');
          alert(`翻译缓存键（GM:${gmKeys.length} / LS:${lsKeys.length}）：\n${lines}`);
        }catch(e){ UI.toast('读取存储键失败'); console.warn(e); }
      });

      $('#ao3x-clear-all-cache', panel)?.addEventListener('click', () => {
        const gmKeys = GM_ListKeys().filter(k => typeof k === 'string' && k.startsWith('ao3_translator_'));
        const lsKeys = (function(){ try{ return Object.keys(localStorage).filter(k => k.startsWith('ao3_translator_')); }catch{ return []; } })();
        const total = (gmKeys?.length||0) + (lsKeys?.length||0);
        if (!total){ UI.toast('没有可清理的翻译缓存'); return; }
        if (!confirm(`将清理 GM:${gmKeys.length} / LS:${lsKeys.length} 个翻译缓存，是否继续？`)) return;
        let removedGM = 0, removedLS = 0;
        for (const k of gmKeys){ try{ GM_Del(k); removedGM++; }catch{} }
        for (const k of lsKeys){ try{ localStorage.removeItem(k); removedLS++; }catch{} }
        UI.toast(`清理完成 GM:${removedGM} / LS:${removedLS}`);
      });

      UI._panel = panel; UI._mask = mask; UI.syncPanel();
    },
    openPanel() { UI.syncPanel(); UI._mask.style.display = 'block'; UI._panel.style.display = 'block'; UI.hideFAB(); },
    closePanel() { UI._mask.style.display = 'none'; UI._panel.style.display = 'none'; UI.showFAB(); },
    hideFAB() { const fab = $('.ao3x-fab-wrap'); if (fab) fab.classList.add('hidden'); },
    showFAB() { const fab = $('.ao3x-fab-wrap'); if (fab) fab.classList.remove('hidden'); },
    syncPanel() {
      const s = settings.get();
      $('#ao3x-base').value = s.api.baseUrl; $('#ao3x-path').value = s.api.path; $('#ao3x-key').value = s.api.key;
      // 同步翻译和总结模型设置
      $('#ao3x-translate-model').value = s.translate?.model?.id || s.model?.id || '';
      $('#ao3x-translate-cw').value = s.translate?.model?.contextWindow || s.model?.contextWindow || 16000;
      $('#ao3x-translate-maxt').value = s.translate?.gen?.maxTokens || s.gen?.maxTokens || 7000;
      $('#ao3x-translate-temp').value = s.translate?.gen?.temperature || s.gen?.temperature || 0.7;
      $('#ao3x-translate-reasoning').value = String(s.translate?.reasoningEffort ?? -1);

      $('#ao3x-summary-model').value = s.summary?.model?.id || '';
      $('#ao3x-summary-cw').value = s.summary?.model?.contextWindow || s.model?.contextWindow || 16000;
      $('#ao3x-summary-maxt').value = s.summary?.gen?.maxTokens || s.gen?.maxTokens || 7000;
      $('#ao3x-summary-temp').value = s.summary?.gen?.temperature || s.gen?.temperature || 0.7;
      $('#ao3x-summary-reasoning').value = String(s.summary?.reasoningEffort ?? -1);

      $('#ao3x-sys').value = s.prompt.system; $('#ao3x-user').value = s.prompt.userTemplate;
      $('#ao3x-stream').checked = !!s.stream.enabled; $('#ao3x-stream-minframe').value = String(s.stream.minFrameMs ?? 40);
      $('#ao3x-debug').checked = !!s.debug; $('#ao3x-conc').value = String(s.concurrency);
      $('#ao3x-idle').value = String(s.watchdog.idleMs); $('#ao3x-hard').value = String(s.watchdog.hardMs); $('#ao3x-retry').value = String(s.watchdog.maxRetry);
      $('#ao3x-ratio').value = String(s.planner?.ratioOutPerIn || 0.7);
      $('#ao3x-font-size').value = String(s.ui?.fontSize || 16);
      $('#ao3x-download-worker').value = s.download?.workerUrl || '';
      // 同步总结设置字段
      $('#ao3x-summary-sys').value = s.summary?.system || '';
      $('#ao3x-summary-user').value = s.summary?.userTemplate || '';
      $('#ao3x-summary-ratio').value = String(s.summary?.ratioTextToSummary ?? 0.3);
    },
    buildToolbar() {
      const bar = document.createElement('div');
      bar.className = 'ao3x-toolbar';
      bar.innerHTML = `<button data-mode="trans" class="active">仅译文</button><button data-mode="orig">仅原文</button><button data-mode="bi" disabled>双语对照</button><button id="ao3x-clear-cache" data-action="clear-cache">清除翻译缓存</button><button id="ao3x-retry-incomplete" data-action="retry" style="display: none;">重试未完成</button>`;
      bar.addEventListener('click', (e) => {
        const btn = e.target.closest('button'); if (!btn) return;
        const action = btn.getAttribute('data-action');
        if (action === 'retry') { Controller.retryIncomplete(); return; }
        if (action === 'clear-cache') {
          if (confirm('确定要清除当前页面的翻译缓存吗？')) {
            TransStore.clearCache();
            View.setShowingCache(false);
            UI.updateToolbarState(); // 更新工具栏状态，重新显示双语对照按钮
            UI.toast('翻译缓存已清除');
            // 删除翻译容器
            const renderContainer = document.querySelector('#ao3x-render');
            if (renderContainer) {
              renderContainer.remove();
            }
            // 恢复原始章节内容的显示
            SelectedNodes.forEach(node => {
              node.style.display = '';
            });
            // 切换到原文模式
            View.setMode('orig');
            UI.hideToolbar();
          }
          return;
        }

        [...bar.querySelectorAll('button')].forEach(b => { if (!b.getAttribute('data-action')) b.classList.remove('active', 'highlight'); });
        if (!action && !btn.disabled) { btn.classList.add('active'); View.setMode(btn.getAttribute('data-mode')); }
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
      .ao3x-fab-wrap{position:fixed;right:12px;top:50%;transform:translateY(-50%);z-index:999999;display:flex;flex-direction:column;gap:8px;opacity:0.6;transition:opacity .3s;pointer-events:auto}
      .ao3x-fab-wrap:hover{opacity:1}
      .ao3x-fab-wrap.hidden{opacity:0;pointer-events:none}
      .ao3x-btn{background:rgba(255,255,255,.9);color:var(--c-accent);border:1px solid rgba(229,229,229,.8);border-radius:var(--radius-full);padding:10px 14px;font-size:13px;font-weight:500;box-shadow:0 2px 8px rgba(0,0,0,.08);cursor:pointer;transition:all .2s;backdrop-filter:blur(8px)}
      .ao3x-btn:hover{background:rgba(255,255,255,.95);box-shadow:0 4px 12px rgba(179,0,0,.15);transform:translateY(-1px)}
      .ao3x-btn:active{transform:scale(.98)}

      /* 悬浮按钮组 - 环状布局 */
      .ao3x-floating-menu{
        position:absolute;right:100%;top:50%;
        transform:translate(-8px, -50%);
        pointer-events:none;opacity:0;
        transition:opacity .18s ease-out, transform .18s ease-out;
        display:flex;flex-direction:column;gap:8px;
        background:rgba(255,255,255,.98);
        border:1px solid var(--c-border);
        border-radius:12px;padding:8px;
        box-shadow:0 6px 18px rgba(0,0,0,.12);
        min-width:44px;
      }
      .ao3x-floating-menu.visible{
        opacity:1;pointer-events:all;transform:translate(-12px, -50%);
      }
      .ao3x-floating-btn{
        position:relative;
        /* 与主翻译按钮保持一致尺寸与风格 */
        padding:10px 14px;
        font-size:13px;
        background:white;
        border:1px solid rgba(229,229,229,.9);
        box-shadow:0 1px 3px rgba(0,0,0,.06);
        border-radius:var(--radius-full);
        min-width:auto;min-height:auto;
        display:flex;align-items:center;justify-content:center;
      }
      .ao3x-floating-btn:hover{
        background:#fff;
        box-shadow:0 3px 10px rgba(179,0,0,.16);
        transform:none;
      }
      @keyframes floatIn{
        from{
          opacity:0;
          transform:translateX(15px) scale(0.9);
        }
        to{
          opacity:1;
          transform:translateX(0) scale(1);
        }
      }

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
      .ao3x-field select,
      .ao3x-field textarea{
        width:100%;padding:10px 12px;
        border:1px solid var(--c-border);border-radius:var(--radius);
        background:var(--c-soft);color:var(--c-fg);
        font-size:14px;transition:all .2s;box-sizing:border-box;
      }
      .ao3x-field input:focus,
      .ao3x-field select:focus,
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

      /* 块选择控制 */
      .ao3x-block-controls{
        display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;
      }
      .ao3x-btn-mini{
        background:var(--c-soft);color:var(--c-fg);border:1px solid var(--c-border);
        border-radius:6px;padding:4px 8px;font-size:11px;font-weight:500;
        cursor:pointer;transition:all .2s;
      }
      .ao3x-btn-mini:hover{
        background:var(--c-accent);color:white;transform:translateY(-1px);
      }
      .ao3x-btn-primary-mini{
        background:var(--c-accent);color:white;border-color:var(--c-accent);
      }
      .ao3x-btn-primary-mini:hover{
        background:#9a0000;
      }

      /* 块复选框 */
      .ao3x-block-checkbox{
        display:inline-flex;align-items:center;cursor:pointer;
        margin-right:8px;position:relative;
      }
      .ao3x-block-checkbox input{
        position:absolute;opacity:0;cursor:pointer;height:0;width:0;
      }
      .ao3x-block-checkbox .checkmark{
        width:16px;height:16px;background:var(--c-soft);
        border:1px solid var(--c-border);border-radius:4px;
        position:relative;transition:all .2s;
      }
      .ao3x-block-checkbox:hover .checkmark{
        background:var(--c-accent);border-color:var(--c-accent);
      }
      .ao3x-block-checkbox input:checked ~ .checkmark{
        background:var(--c-accent);border-color:var(--c-accent);
      }
      .ao3x-block-checkbox .checkmark::after{
        content:'';position:absolute;display:none;
        left:5px;top:2px;width:3px;height:6px;
        border:solid white;border-width:0 2px 2px 0;
        transform:rotate(45deg);
      }
      .ao3x-block-checkbox input:checked ~ .checkmark::after{
        display:block;
      }

      /* 总结视图样式 */
      .ao3x-summary-container{
        margin:20px 0;padding:0;
        border-top:2px solid var(--c-accent);
        border-bottom:2px solid var(--c-accent);
        background:rgba(179,0,0,0.02);
        border-radius:var(--radius);
      }
      .ao3x-summary-block{
        margin-bottom:20px;border:1px solid var(--c-border);
        border-radius:var(--radius);background:white;
        box-shadow:0 1px 3px rgba(0,0,0,.05);
      }
      /* 当内容直接放在总结块中（未使用 .ao3x-summary-pair 包裹）时，提供基础内边距 */
      .ao3x-summary-block > .ao3x-summary-content{
        padding:16px;
      }
      .ao3x-summary-pair{
        padding:16px;
      }
      .ao3x-summary-header{
        font-weight:600;font-size:14px;color:var(--c-accent);
        margin-bottom:8px;padding-bottom:6px;
        border-bottom:1px solid var(--c-border);
      }
      .ao3x-summary-preview{
        font-size:12px;color:var(--c-muted);line-height:1.4;
        margin-bottom:12px;padding:8px;background:var(--c-soft);
        border-radius:6px;border-left:3px solid var(--c-border);
      }
      .ao3x-summary-content{
        color:var(--c-fg);line-height:1.6;font-size:15px;
        min-height:40px;transition:min-height 0.2s ease;
      }
      .ao3x-summary-content blockquote{
        margin:0.8em 0;padding-left:1em;
        border-left:3px solid var(--c-accent);
        font-style:italic;background:rgba(179,0,0,0.05);
        border-radius:0 var(--radius) var(--radius) 0;
      }

      /* 调整计划面板行样式以适应复选框 */
      .ao3x-plan .row{
        display:flex;align-items:center;font-size:12px;color:#4b5563;
        padding:6px 0;border-top:1px solid var(--c-border);
      }
      .ao3x-plan .row:first-of-type{border-top:none}
      .ao3x-plan .row b{
        margin-right:8px;
      }


    `);
  }
  function debounce(fn, wait){ let t; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), wait); }; }
  function collectPanelValues(panel) {
    const cur = settings.get();

    // 收集翻译模型配置
    const translateModel = $('#ao3x-translate-model', panel).value.trim();
    const summaryModel = $('#ao3x-summary-model', panel).value.trim();

    return {
      api: { baseUrl: $('#ao3x-base', panel).value.trim(), path: $('#ao3x-path', panel).value.trim(), key: $('#ao3x-key', panel).value.trim() },
      // 保持向后兼容的model字段
      model: {
        id: translateModel || cur.model?.id || '',
        contextWindow: parseInt($('#ao3x-translate-cw', panel).value, 10) || cur.model?.contextWindow || 16000
      },
      gen: {
        maxTokens: parseInt($('#ao3x-translate-maxt', panel).value, 10) || cur.gen?.maxTokens || 7000,
        temperature: parseFloat($('#ao3x-translate-temp', panel).value) || cur.gen?.temperature || 0.7
      },
      translate: {
        model: {
          id: translateModel,
          contextWindow: parseInt($('#ao3x-translate-cw', panel).value, 10) || cur.model?.contextWindow || 16000
        },
        gen: {
          maxTokens: parseInt($('#ao3x-translate-maxt', panel).value, 10) || cur.gen?.maxTokens || 7000,
          temperature: parseFloat($('#ao3x-translate-temp', panel).value) || cur.gen?.temperature || 0.7
        },
        reasoningEffort: parseInt($('#ao3x-translate-reasoning', panel).value, 10) || -1
      },
      summary: {
        model: {
          id: summaryModel,
          contextWindow: parseInt($('#ao3x-summary-cw', panel).value, 10) || cur.model?.contextWindow || 16000
        },
        gen: {
          maxTokens: parseInt($('#ao3x-summary-maxt', panel).value, 10) || cur.gen?.maxTokens || 7000,
          temperature: parseFloat($('#ao3x-summary-temp', panel).value) || cur.gen?.temperature || 0.7
        },
        reasoningEffort: parseInt($('#ao3x-summary-reasoning', panel).value, 10) || -1,
        system: $('#ao3x-summary-sys', panel).value,
        userTemplate: $('#ao3x-summary-user', panel).value,
        ratioTextToSummary: Math.max(0.1, Math.min(1, parseFloat($('#ao3x-summary-ratio', panel).value) || cur.summary?.ratioTextToSummary || 0.3))
      },
      prompt: { system: $('#ao3x-sys', panel).value, userTemplate: $('#ao3x-user', panel).value },
      stream: { enabled: $('#ao3x-stream', panel).checked, minFrameMs: Math.max(0, parseInt($('#ao3x-stream-minframe', panel).value||String(cur.stream.minFrameMs||40),10)) },
      concurrency: Math.max(1, Math.min(8, parseInt($('#ao3x-conc', panel).value, 10) || cur.concurrency)),
      debug: $('#ao3x-debug', panel).checked,
      planner: {
        ...cur.planner,
        ratioOutPerIn: Math.max(0.3, parseFloat($('#ao3x-ratio', panel).value || cur.planner?.ratioOutPerIn || 0.7))
      },
      watchdog: {
        idleMs: (function(){ const v = parseInt($('#ao3x-idle', panel).value || cur.watchdog.idleMs, 10); return v === -1 ? -1 : Math.max(5000, v); })(),
        hardMs: (function(){ const v = parseInt($('#ao3x-hard', panel).value || cur.watchdog.hardMs, 10); return v === -1 ? -1 : Math.max(10000, v); })(),
        maxRetry: Math.max(0, Math.min(3, parseInt($('#ao3x-retry', panel).value || cur.watchdog.maxRetry, 10)))
      },
      ui: {
        fontSize: Math.max(12, Math.min(24, parseInt($('#ao3x-font-size', panel).value || cur.ui?.fontSize || 16, 10)))
      },
      download: {
        workerUrl: ($('#ao3x-download-worker', panel).value || cur.download?.workerUrl || '').trim()
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
      return `<div class="row"><label class="ao3x-block-checkbox"><input type="checkbox" data-block-index="${i}"><span class="checkmark"></span></label><b>#${i}</b> <span class="ao3x-small">in≈${estIn}</span> ｜ <span class="ao3x-small">开头：</span>${escapeHTML(head)} <span class="ao3x-small">结尾：</span>${escapeHTML(tail)}</div>`;
    }).join('');
    const controls = `
      <div class="ao3x-block-controls">
        <button id="ao3x-select-all" class="ao3x-btn-mini">全选</button>
        <button id="ao3x-select-none" class="ao3x-btn-mini">取消全选</button>
        <button id="ao3x-select-invert" class="ao3x-btn-mini">反选</button>
        <button id="ao3x-retry-selected" class="ao3x-btn-mini ao3x-btn-primary-mini">重试选中</button>
      </div>
    `;
    box.innerHTML = `<h4>切块计划：共 ${plan.length} 块</h4>${controls}${rows}<div class="ao3x-kv" id="ao3x-kv"></div>`;

    // 绑定控制按钮事件
    bindBlockControlEvents(box);
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

  /* ================= Finish Reason Handler ================= */
  function handleFinishReason(finishReason, label) {
    if (!finishReason) return; // null 或 undefined，不处理

    const reasonMap = {
      'stop': '正常完成',
      'length': '长度限制（将自动重试）',
      'content_filter': '内容被过滤',
      'tool_calls': '工具调用完成',
      'function_call': '函数调用完成',
      'recitation': '引用检测触发',
      'safety': '安全检查触发',
      'other': '其他原因完成'
    };

    // 只对非正常完成的情况显示提示
    if (finishReason !== 'stop' && finishReason !== 'length') {
      const reason = reasonMap[finishReason] || `未知原因: ${finishReason}`;
      UI.toast(`${label} 非正常完成: ${reason}`);
      d('finish_reason:abnormal', {label, finishReason, reason});
    }
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
        // 检查是否是超时错误，如果是则显示toast提示
        if (e.message && (e.message.includes('idle-timeout') || e.message.includes('hard-timeout'))) {
          UI.toast(`块 ${label} 因超时失败`);
        }
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
    currentType: 'translate', // 记录当前操作的模型类型
    async fetchAndRender(panel, type = 'translate'){
      this.currentType = type;
      try{
        const list=await getModels();
        this.all=list;
        this.render(panel, list, type);
      } catch(e){
        UI.toast('获取模型失败：'+e.message);
      }
    },
    render(panel, list, type = 'translate'){
      const boxId = type === 'translate' ? '#ao3x-translate-model-list' : '#ao3x-summary-model-list';
      const box = $(boxId, panel);
      box.innerHTML='';
      list.forEach(m=>{
        const div=document.createElement('div');
        div.className='ao3x-model-item';
        div.textContent=m.id||m.name||JSON.stringify(m);
        div.addEventListener('click', ()=>{
          this.selectModel(panel, m.id || m.name, type);
        });
        box.appendChild(div);
      });
    },
    selectModel(panel, modelId, type){
      if (type === 'translate') {
        // 设置翻译模型
        $('#ao3x-translate-model', panel).value = modelId;

        // 如果总结模型为空，则同步设置总结模型
        const summaryModelInput = $('#ao3x-summary-model', panel);
        if (!summaryModelInput.value.trim()) {
          summaryModelInput.value = modelId;
          UI.toast(`已设置翻译模型为 ${modelId}，并同步到总结模型`);
        } else {
          UI.toast(`已设置翻译模型为 ${modelId}`);
        }
      } else if (type === 'summary') {
        // 设置总结模型
        $('#ao3x-summary-model', panel).value = modelId;
        UI.toast(`已设置总结模型为 ${modelId}`);
      }

      // 保存设置
      settings.set(collectPanelValues(panel));
      saveToast();
    },
    filter(panel, type = null){
      const actualType = type || this.currentType;
      const queryId = actualType === 'translate' ? '#ao3x-translate-model-q' : '#ao3x-summary-model-q';
      const q = ($(queryId, panel).value||'').toLowerCase();
      const list = !q ? this.all : this.all.filter(m=>(m.id||'').toLowerCase().includes(q));
      this.render(panel, list, actualType);
    }
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

    // 从存储加载缓存（优先 GM 存储，回落 localStorage 由 GM_Get 封装处理）
    loadFromCache() {
      if (!this._cacheKey) return;
      try {
        const data = GM_Get(this._cacheKey);
        if (data && typeof data === 'object') {
          this._map = data._map || Object.create(null);
          this._done = data._done || Object.create(null);
          return;
        }
        // GM 无数据时，尝试从 localStorage 读取并迁移
        try {
          const cached = localStorage.getItem(this._cacheKey);
          if (cached) {
            const dataLS = JSON.parse(cached);
            this._map = dataLS._map || Object.create(null);
            this._done = dataLS._done || Object.create(null);
            // 迁移到 GM，并清理 LS
            try { GM_Set(this._cacheKey, { _map: this._map, _done: this._done, timestamp: Date.now() }); } catch {}
            try { localStorage.removeItem(this._cacheKey); } catch {}
          }
        } catch {}
      } catch (e) {
        console.warn('Failed to load translation cache:', e);
      }
    },

    // 保存到存储（优先 GM 存储，回落 localStorage 由 GM_Set 封装处理）
    saveToCache() {
      if (!this._cacheKey) return;
      try {
        const data = {
          _map: this._map,
          _done: this._done,
          timestamp: Date.now()
        };
        GM_Set(this._cacheKey, data);
      } catch (e) {
        console.warn('Failed to save translation cache:', e);
      }
    },

    // 清除缓存
    clearCache() {
      if (this._cacheKey) {
        GM_Del(this._cacheKey);
      }
      this.clear();
    },

    // 检查是否有缓存
    hasCache() {
      if (!this._cacheKey) return false;
      try {
        const data = GM_Get(this._cacheKey);
        if (data) {
          const map = data._map || {};
          return Object.keys(map).length > 0;
        }
        // GM 无数据时，尝试读取 LS 并顺便迁移
        try {
          const cached = localStorage.getItem(this._cacheKey);
          if (!cached) return false;
          const dataLS = JSON.parse(cached);
          const map = dataLS._map || {};
          if (Object.keys(map).length > 0) {
            try { GM_Set(this._cacheKey, { _map: map, _done: dataLS._done || {}, timestamp: Date.now() }); } catch {}
            try { localStorage.removeItem(this._cacheKey); } catch {}
            return true;
          }
          return false;
        } catch {
          return false;
        }
      } catch (e) {
        return false;
      }
    },

    // 获取缓存信息
    getCacheInfo() {
      if (!this._cacheKey) return { hasCache: false, total: 0, completed: 0 };
      try {
        const data = GM_Get(this._cacheKey);
        if (data) {
          const map = data._map || {};
          const done = data._done || {};
          return {
            hasCache: Object.keys(map).length > 0,
            total: Object.keys(map).length,
            completed: Object.keys(done).length
          };
        }
        // GM 无数据时，尝试读取 LS 并迁移
        try {
          const cached = localStorage.getItem(this._cacheKey);
          if (!cached) return { hasCache: false, total: 0, completed: 0 };
          const dataLS = JSON.parse(cached);
          const map = dataLS._map || {};
          const done = dataLS._done || {};
          // 迁移
          try { GM_Set(this._cacheKey, { _map: map, _done: done, timestamp: Date.now() }); } catch {}
          try { localStorage.removeItem(this._cacheKey); } catch {}
          return {
            hasCache: Object.keys(map).length > 0,
            total: Object.keys(map).length,
            completed: Object.keys(done).length
          };
        } catch {
          return { hasCache: false, total: 0, completed: 0 };
        }
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
      if(this.mode==='summary'){ this.renderSummary(); return; }
      const c=this.ensure();
      if (initial) {
        const next = RenderState.nextToRender || 0;
        c.querySelectorAll('.ao3x-block:not(.ao3x-summary-block)').forEach(block=>{
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
    renderSummary(){
      const c = this.ensure();
      // 查找总结专用的块容器
      const summaryBlocks = Array.from(c.querySelectorAll('.ao3x-summary-block'));

      if (summaryBlocks.length === 0) {
        // 如果没有总结块，显示提示信息
        c.innerHTML = '<div class="ao3x-info">没有找到总结内容。请先生成章节总结。</div>';
        return;
      }

      // 渲染每个总结块
      summaryBlocks.forEach(block => {
        const idx = block.getAttribute('data-summary-index');
        const orig = block.getAttribute('data-original-html') || '';
        const summary = SummaryStore.get(idx) || '';

        // 创建总结视图HTML结构
        const summaryHTML = summary || '<span class="ao3x-muted">（待总结）</span>';
        const origPreview = this.getTextPreview(stripHtmlToText(orig), 100); // 显示原文预览

        const html = `
          <div class="ao3x-summary-pair">
            <div class="ao3x-summary-header">段落 #${idx}</div>
            <div class="ao3x-summary-preview">原文预览：${escapeHTML(origPreview)}</div>
            <div class="ao3x-summary-content">${summaryHTML}</div>
          </div>
        `;

        // 使用 requestAnimationFrame 减少闪烁
        requestAnimationFrame(() => {
          block.innerHTML = `<span class="ao3x-anchor" data-summary-chunk-id="${idx}"></span>${html}`;
        });
      });
    },
    renderBilingual(){
      const c=this.ensure(); const blocks = Array.from(c.querySelectorAll('.ao3x-block:not(.ao3x-summary-block)'));
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
    },
    // 获取文本预览，用于总结视图
    getTextPreview(text, maxLength = 100) {
      if (!text || typeof text !== 'string') return '';
      const clean = text.replace(/\s+/g, ' ').trim();
      if (clean.length <= maxLength) return clean;
      return clean.slice(0, maxLength) + '...';
    },
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
      return `<div class="row"><label class="ao3x-block-checkbox"><input type="checkbox" data-block-index="${i}"><span class="checkmark"></span></label><b>#${i}</b> <span class="ao3x-small">in≈${p.inTok||0}</span> ｜ <span class="ao3x-small">开头：</span>${escapeHTML(head)} <span class="ao3x-small">结尾：</span>${escapeHTML(tail)}</div>`;
    }).join('');
    const controls = `
      <div class="ao3x-block-controls">
        <button id="ao3x-select-all" class="ao3x-btn-mini">全选</button>
        <button id="ao3x-select-none" class="ao3x-btn-mini">取消全选</button>
        <button id="ao3x-select-invert" class="ao3x-btn-mini">反选</button>
        <button id="ao3x-retry-selected" class="ao3x-btn-mini ao3x-btn-primary-mini">重试选中</button>
      </div>
    `;
    box.innerHTML = `<h4>切块计划：共 ${plan.length} 块</h4>${controls}${rows}<div class="ao3x-kv" id="ao3x-kv"></div>`;

    // 绑定控制按钮事件
    bindBlockControlEvents(box);

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
      return `<div class="row"><label class="ao3x-block-checkbox"><input type="checkbox" data-block-index="${idx}"><span class="checkmark"></span></label><b>#${idx}</b> <span class="ao3x-small">in≈${p.inTok||0}</span> ｜ <span class="ao3x-small">开头：</span>${escapeHTML(head)} <span class="ao3x-small">结尾：</span>${escapeHTML(tail)}</div>`;
    }).join('');
    const kv = `<div class="ao3x-kv" id="ao3x-kv"></div>`;
    const headHtml = `<h4>切块计划：共 ${plan.length} 块</h4>`;
    const controls = `
      <div class="ao3x-block-controls">
        <button id="ao3x-select-all" class="ao3x-btn-mini">全选</button>
        <button id="ao3x-select-none" class="ao3x-btn-mini">取消全选</button>
        <button id="ao3x-select-invert" class="ao3x-btn-mini">反选</button>
        <button id="ao3x-retry-selected" class="ao3x-btn-mini ao3x-btn-primary-mini">重试选中</button>
      </div>
    `;
    const fixed = Array.from(box.querySelectorAll('.row')).slice(0, startIndex).map(n=>n.outerHTML).join('');
    box.innerHTML = headHtml + controls + fixed + rows + kv;

    // 重新绑定控制按钮事件
    bindBlockControlEvents(box);

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

  /* ================= 块选择控制事件绑定 ================= */
  function bindBlockControlEvents(container) {
    const selectAllBtn = container.querySelector('#ao3x-select-all');
    const selectNoneBtn = container.querySelector('#ao3x-select-none');
    const selectInvertBtn = container.querySelector('#ao3x-select-invert');
    const retrySelectedBtn = container.querySelector('#ao3x-retry-selected');

    if (selectAllBtn) {
      selectAllBtn.addEventListener('click', () => {
        const checkboxes = container.querySelectorAll('.ao3x-block-checkbox input[type="checkbox"]');
        checkboxes.forEach(cb => cb.checked = true);
        UI.toast(`已选择 ${checkboxes.length} 个块`);
      });
    }

    if (selectNoneBtn) {
      selectNoneBtn.addEventListener('click', () => {
        const checkboxes = container.querySelectorAll('.ao3x-block-checkbox input[type="checkbox"]');
        checkboxes.forEach(cb => cb.checked = false);
        UI.toast('已取消全部选择');
      });
    }

    if (selectInvertBtn) {
      selectInvertBtn.addEventListener('click', () => {
        const checkboxes = container.querySelectorAll('.ao3x-block-checkbox input[type="checkbox"]');
        let selectedCount = 0;
        checkboxes.forEach(cb => {
          cb.checked = !cb.checked;
          if (cb.checked) selectedCount++;
        });
        UI.toast(`已反选，当前选中 ${selectedCount} 个块`);
      });
    }

    if (retrySelectedBtn) {
      retrySelectedBtn.addEventListener('click', () => {
        const checkboxes = container.querySelectorAll('.ao3x-block-checkbox input[type="checkbox"]:checked');
        const selectedIndices = Array.from(checkboxes).map(cb => {
          const index = cb.getAttribute('data-block-index');
          return parseInt(index, 10);
        }).filter(i => !isNaN(i));

        if (selectedIndices.length === 0) {
          UI.toast('请先选择要重试的块');
          return;
        }

        Controller.retrySelectedBlocks(selectedIndices);
      });
    }
  }

  /* ================= Controller ================= */
  const Controller = {




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

// 下载翻译为TXT文件（完整替换此函数）
downloadTranslation() {
  // 1) 基本检查
  const cacheInfo = TransStore.getCacheInfo && TransStore.getCacheInfo();
  if (!cacheInfo || !cacheInfo.hasCache || !cacheInfo.completed) {
    UI.toast('没有可下载的翻译内容');
    return;
  }

  // 2) 生成文件名
  const info = this.getWorkInfo ? this.getWorkInfo() : {};
  const workTitle = (info && info.workTitle) || '作品';
  const chapterTitle = (info && info.chapterTitle) || '章节';
  const fileName = `${workTitle}-${chapterTitle}.txt`;

  // 3) 汇总正文
  let fullText = '';
  const total = cacheInfo.total || 0;
  for (let i = 0; i < total; i++) {
    const translation = TransStore.get && TransStore.get(String(i));
    if (!translation) continue;

    let plain = '';
    try {
      if (this.extractTextWithStructure) {
        plain = this.extractTextWithStructure(translation) || '';
      } else {
        const div = document.createElement('div');
        div.innerHTML = translation;
        plain = (div.textContent || '').replace(/\r?\n/g, '\n').trim();
      }
    } catch (_) {}
    if (plain) fullText += plain + '\n\n';
  }
  fullText = fullText.trim();
  if (!fullText) {
    UI.toast('翻译内容为空');
    return;
  }

  // 4) EvansBrowser / iOS Safari 家族 → 走云端“两步法”（POST→GET）；其他浏览器保留 Blob
  const s = settings.get();
  const WORKER_ORIGIN = s.download?.workerUrl || '';

// —— 只针对 EvansBrowser，其他一律走 Blob ——
// 你给的精确 UA（可留作备用精确等号匹配）
const EVANS_FULL =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 ' +
  'Mobile/15E148 Safari/604.1 EvansBrowser/1.0';

const ua = navigator.userAgent || '';

// 条件1：包含 EvansBrowser/<版本号>（推荐）
const hasEvansToken = /\bEvansBrowser\/\d+(?:\.\d+)*\b/i.test(ua);

// 条件2：精确等号匹配整串（可选补充，避免极端裁剪导致 token 丢失时你仍能识别）
const isExactEvansUA = ua.trim() === EVANS_FULL;

// 最终：只有 Evans 才用云端两步法
const shouldUseCloud = hasEvansToken || isExactEvansUA;

  if (shouldUseCloud) {
    // —— 两步法：1) POST 文本到 /api/upload → 2) 跳转到返回的 GET 下载链接 ——
    (async () => {
      try {
        UI.toast('1/2 上传到云端…');
        const body = new URLSearchParams();
        body.set('text', fullText);
        body.set('filename', fileName);

        const res = await fetch(`${WORKER_ORIGIN}/api/upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body
        });

        if (!res.ok) {
          const err = await res.text().catch(() => res.statusText);
          UI.toast('上传失败：' + err);
          return;
        }

        const data = await res.json().catch(() => null);
        if (!data || !data.url) {
          UI.toast('上传返回无下载链接');
          return;
        }

        UI.toast('2/2 跳转下载…');
        location.href = data.url; // 导航到 GET 链接触发下载
      } catch (e) {
        UI.toast('异常：' + (e && e.message ? e.message : String(e)));
      }
    })();
    return; // 重要：不要再继续走到 Blob 分支
  }

  // 5) 其他浏览器：保留原来的 Blob 下载
  try {
    const blob = new Blob([fullText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    UI.toast(`已下载 ${fileName}`);
  } catch (e) {
    UI.toast('本地下载失败：' + (e && e.message ? e.message : String(e)));
  }
},

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

    // 重试选中的块（手动选择）
    async retrySelectedBlocks(selectedIndices){
      if (!selectedIndices || !selectedIndices.length) {
        UI.toast('未选择要重试的块');
        return;
      }

      const s = settings.get();
      UI.toast(`开始重试 ${selectedIndices.length} 个选中块…`);

      const c = document.querySelector('#ao3x-render');
      if (!c) {
        UI.toast('未找到渲染容器');
        return;
      }

      // 彻底清理选中块的所有缓存和状态
      selectedIndices.forEach(i => {
        // 清除TransStore中的旧翻译和完成状态
        TransStore.set(String(i), '');
        if (TransStore._done) delete TransStore._done[i];

        // 清理RenderState中的应用状态
        if (RenderState && RenderState.lastApplied) {
          RenderState.lastApplied[i] = '';
        }

        // 清理Streamer中的缓冲区
        if (typeof Streamer !== 'undefined' && Streamer._buf) {
          Streamer._buf[i] = '';
          Streamer._dirty[i] = false;
        }

        // 重置DOM显示为待译状态
        const anchor = c.querySelector(`[data-chunk-id="${i}"]`);
        if (anchor) {
          let transDiv = anchor.parentElement.querySelector('.ao3x-translation');
          if (transDiv) {
            transDiv.innerHTML = '<span class="ao3x-muted">（重新翻译中…）</span>';
            // 强制重新设置最小高度
            transDiv.style.minHeight = '60px';
          }
        }
      });

      // 构造子计划（复用 data-original-html）
      const subPlan = selectedIndices.map(i => {
        const block = c.querySelector(`.ao3x-block[data-index="${i}"]`);
        const html = block ? (block.getAttribute('data-original-html') || '') : '';
        return { index: i, html };
      });

      // 状态计数
      let inFlight = 0, completed = 0, failed = 0;
      updateKV({ 重试进行中: inFlight, 重试完成: completed, 重试失败: failed });

      const postOne = (idx) => {
        const planItem = subPlan.find(p => p.index === idx);
        if (!planItem || !planItem.html) {
          failed++;
          updateKV({ 重试进行中: inFlight, 重试完成: completed, 重试失败: failed });
          return;
        }

        const label = `retry-selected#${idx}`;
        inFlight++;
        updateKV({ 重试进行中: inFlight, 重试完成: completed, 重试失败: failed });

        postChatWithRetry({
          endpoint: resolveEndpoint(s.api.baseUrl, s.api.path),
          key: s.api.key,
          payload: {
            model: s.model.id,
            messages: [
              { role:'system', content: s.prompt.system },
              { role:'user',   content: s.prompt.userTemplate.replace('{{content}}', planItem.html) }
            ],
            temperature: s.gen.temperature,
            max_tokens: s.gen.maxTokens,
            stream: !!s.stream.enabled
          },
          stream: s.stream.enabled,
          label,
          onDelta: (delta) => {
            Streamer.push(idx, delta, (k, clean) => {
              TransStore.set(String(k), clean);
              // 只有当前顺序渲染的块才能实时显示，其他块仅缓存
              if (RenderState.canRender(k)) {
                RenderState.applyIncremental(k, clean);
              }
            });
          },
          onFinishReason: (fr) => {
            d('retry-selected:finish_reason', {idx, fr});
            handleFinishReason(fr, `retry-selected#${idx}`);
          },
          onDone: () => {
            TransStore.markDone(idx);
            inFlight--; completed++;
            Streamer.done(idx, (k, clean) => {
              TransStore.set(String(k), clean);
              // 只有当前顺序渲染的块才能实时显示，其他块仅缓存
              if (RenderState.canRender(k)) {
                RenderState.applyIncremental(k, clean);
              }
            });

            // 若正好轮到该块，也推进一次顺序渲染
            if (RenderState.canRender(idx)) RenderState.finalizeCurrent();
            updateKV({ 重试进行中: inFlight, 重试完成: completed, 重试失败: failed });

            // 检查是否所有选中的块都完成了
            if (completed + failed >= selectedIndices.length) {
              // 清理状态显示，恢复正常显示
              setTimeout(() => {
                const kvElement = document.querySelector('#ao3x-kv');
                if (kvElement) {
                  // 显示总体统计而不是重试统计
                  const totalCompleted = Object.keys(TransStore._done || {}).length;
                  const total = RenderState.total || 0;
                  updateKV({ 已完成: totalCompleted, 总计: total });
                }
                UI.updateToolbarState();
              }, 1000);
            }
          },
          onError: (e) => {
            inFlight--; failed++;
            const msg = `<p class="ao3x-muted">[重试失败：${e.message}]</p>`;
            TransStore.set(String(idx), msg);
            TransStore.markDone(idx);
            // 只有当前顺序渲染的块才能实时显示，其他块仅缓存
            if (RenderState.canRender(idx)) {
              RenderState.applyIncremental(idx, msg);
            }

            if (RenderState.canRender(idx)) RenderState.finalizeCurrent();
            updateKV({ 重试进行中: inFlight, 重试完成: completed, 重试失败: failed });

            // 检查是否所有选中的块都完成了
            if (completed + failed >= selectedIndices.length) {
              // 清理状态显示，恢复正常显示
              setTimeout(() => {
                const kvElement = document.querySelector('#ao3x-kv');
                if (kvElement) {
                  // 显示总体统计而不是重试统计
                  const totalCompleted = Object.keys(TransStore._done || {}).length;
                  const total = RenderState.total || 0;
                  updateKV({ 已完成: totalCompleted, 总计: total });
                }
                UI.updateToolbarState();
              }, 1000);
            }
          }
        });
      };

      // 按设置并发数重试选中的块
      const conc = Math.max(1, Math.min(4, s.concurrency || 2));
      let ptr = 0;

      const processNext = () => {
        while (ptr < selectedIndices.length) {
          const i = selectedIndices[ptr++];
          postOne(i);

          // 达到并发限制时暂停
          if (inFlight >= conc) {
            break;
          }
        }

        // 如果还有未处理的块，稍后继续
        if (ptr < selectedIndices.length && inFlight < conc) {
          setTimeout(processNext, 100);
        }
      };

      // 开始处理
      processNext();

      // 监控完成状态
      const checkCompletion = () => {
        if (completed + failed >= selectedIndices.length) {
          UI.toast(`选中块重试完成：成功 ${completed}，失败 ${failed}`);

          // 最后兜底刷新
          finalFlushAll(RenderState.total || 0);

          // 如果是双语模式且可以渲染，更新双语视图
          try {
            if (View && View.mode === 'bi' && Bilingual.canRender()) {
              View.renderBilingual();
            }
          } catch {}

          return;
        }

        // 如果未完成，继续监控
        setTimeout(checkCompletion, 500);
      };

      // 开始监控完成状态
      setTimeout(checkCompletion, 500);
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
          onFinishReason: (fr)=>{
            d('retry:finish_reason', {idx, fr});
            handleFinishReason(fr, `retry#${idx}`);
          },
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
        onFinishReason: (fr)=>{
          d('finish_reason', {i, fr});
          handleFinishReason(fr, `single#${i}`);
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
            handleFinishReason(fr, `chunk#${i}`);
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
                  onFinishReason: (fr2)=>{
                    d('finish_reason(second)', {i, fr2});
                    handleFinishReason(fr2, `chunk#${i}-retry-max`);
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

  /* ================= Summary Storage ================= */
  const SummaryStore = {
    _map: Object.create(null), _done: Object.create(null),
    // 总结为一次性展示：完全取消本地持久化

    initCache() { /* no-op: 不做持久化初始化 */ },
    loadFromCache() { /* no-op */ },
    saveToCache() { /* no-op */ },
    clearCache() { this.clear(); },
    hasCache() { return false; },
    getCacheInfo() { return { hasCache: false, total: 0, completed: 0 }; },

    set(i, content){ this._map[i] = content; },
    get(i){ return this._map[i] || ''; },
    markDone(i){ this._done[i] = true; },
    allDone(total){ for(let k=0;k<total;k++){ if(!this._done[k]) return false; } return true; },
    clear(){ this._map = Object.create(null); this._done = Object.create(null); }
  };

  /* ================= SummaryController ================= */
  const SummaryController = {
    _isActive: false,
    _currentPlan: null,
    _renderState: { nextToRender: 0, total: 0, lastApplied: Object.create(null) },

    // 检查是否可以启动总结
    canStartSummary() {
      const nodes = collectChapterUserstuffSmart();
      return nodes.length > 0;
    },

    // 获取总结配置
    getSummaryConfig() {
      const s = settings.get();
      return {
        system: s.summary?.system || '你是专业的文学内容总结助手。请准确概括故事情节、人物关系和重要事件，保持客观中性的语调。',
        userTemplate: s.summary?.userTemplate || '请对以下AO3章节内容进行剧情总结，重点包括：主要情节发展、角色互动、重要对话或事件。请用简洁明了的中文总结：\n{{content}}\n（请直接返回总结内容，不需要格式化。）',
        ratioTextToSummary: s.summary?.ratioTextToSummary || 0.3
      };
    },

    // 启动总结功能
    async startSummary() {
      // 防抖：短时间重复点击不重复发送
      const now = Date.now();
      this._lastStartAt = this._lastStartAt || 0;
      if (now - this._lastStartAt < 1200) {
        UI.toast('总结已在处理中…');
        return;
      }
      this._lastStartAt = now;
      if (this._isActive) {
        UI.toast('总结功能正在运行中');
        return;
      }

      const nodes = collectChapterUserstuffSmart();
      if (!nodes.length) {
        UI.toast('未找到章节正文');
        return;
      }

      this._isActive = true;
      markSelectedNodes(nodes);
      // 不重置 renderContainer，复用当前容器，且清理旧的总结 UI，避免叠加
      const c = ensureRenderContainer();
      c.querySelectorAll('#ao3x-summary-plan, .ao3x-summary-block').forEach(n => n.remove());
      // 不触发顶栏工具栏，保持与翻译工具栏独立
      View.info('准备总结中…');

      try {
        const s = settings.get();
        const config = this.getSummaryConfig();
        const allHtml = nodes.map(n => n.innerHTML);
        const fullHtml = allHtml.join('\n');

        // 使用总结专用的比例计算分块
        const ratio = config.ratioTextToSummary;
        const reserve = s.planner?.reserve ?? 384;
        const packSlack = Math.max(0.5, Math.min(1, s.planner?.packSlack ?? 0.95));

        // 计算总结的prompt tokens
        const promptTokens = await estimatePromptTokensFromMessages([
          { role: 'system', content: config.system },
          { role: 'user', content: config.userTemplate.replace('{{content}}', '') }
        ]);

        const allText = stripHtmlToText(fullHtml);
        const allEstIn = await estimateTokensForText(allText);

        const cw = s.model.contextWindow || 8192;
        const maxT = s.gen.maxTokens || 1024;

        // 总结通常比翻译需要更少的输出token
        const cap1 = maxT / ratio;
        const cap2 = (cw - promptTokens - reserve) / (1 + ratio);
        const maxInputBudgetRaw = Math.max(0, Math.min(cap1, cap2));
        const maxInputBudget = Math.floor(maxInputBudgetRaw * packSlack);

        const slackSingle = s.planner?.singleShotSlackRatio ?? 0.15;
        const canSingle = allEstIn <= maxInputBudget * (1 + Math.max(0, slackSingle));

        d('summary:budget', { contextWindow: cw, promptTokens, reserve, userMaxTokens: maxT, ratio, packSlack, maxInputBudget, allEstIn, canSingle });

        // 创建总结计划
        let plan = [];
        if (canSingle) {
          const inTok = await estimateTokensForText(allText);
          plan = [{ index: 0, html: fullHtml, text: allText, inTok }];
        } else {
          plan = await packIntoChunks(allHtml, maxInputBudget);
        }

        this._currentPlan = plan;
        d('summary:plan', { chunks: plan.length, totalIn: allEstIn, inputBudget: maxInputBudget });

        // 渲染总结计划界面
        this.renderSummaryPlan(plan);
        this.initRenderState(plan.length);

        // 开始总结处理
        if (plan.length === 1 && canSingle) {
          View.info('单次总结中…');
          await this.summarizeSingle({
            endpoint: resolveEndpoint(s.api.baseUrl, s.api.path),
            key: s.api.key,
            stream: s.stream.enabled,
            modelCw: s.model.contextWindow,
            ratio,
            promptTokens,
            reserve,
            contentHtml: plan[0].html,
            inTok: plan[0].inTok,
            userMaxTokens: s.gen.maxTokens,
            config
          });
        } else {
          View.info('文本较长：正在分段总结…');
          await this.summarizeConcurrent({
            endpoint: resolveEndpoint(s.api.baseUrl, s.api.path),
            key: s.api.key,
            plan,
            concurrency: s.concurrency,
            stream: s.stream.enabled,
            modelCw: s.model.contextWindow,
            ratio,
            promptTokens,
            reserve,
            userMaxTokens: s.gen.maxTokens,
            config
          });
        }

        View.clearInfo();
        UI.toast('总结完成');

      } catch (e) {
        d('summary:fatal', e);
        UI.toast('总结失败：' + e.message);
        View.clearInfo();
      } finally {
        this._isActive = false;
      }
    },

    // 渲染总结计划界面
    renderSummaryPlan(plan) {
      const c = ensureRenderContainer();

      // 1. 创建总结计划容器，放在最前面（翻译计划之前）
      let summaryPlanBox = $('#ao3x-summary-plan', c);
      if (!summaryPlanBox) {
        summaryPlanBox = document.createElement('div');
        summaryPlanBox.id = 'ao3x-summary-plan';
        summaryPlanBox.className = 'ao3x-plan';
        // 插入到容器最前面，翻译计划之前
        const existingPlan = $('#ao3x-plan', c);
        if (existingPlan) {
          c.insertBefore(summaryPlanBox, existingPlan);
        } else {
          c.insertBefore(summaryPlanBox, c.firstChild);
        }
      }

      const rows = plan.map((p, i) => {
        const text = stripHtmlToText(p.text || p.html);
        const head = text.slice(0, 48);
        const tail = text.slice(-48);
        const estIn = p.inTok != null ? p.inTok : 0;
        return `<div class="row"><b>#${i}</b> <span class="ao3x-small">in≈${estIn}</span> ｜ <span class="ao3x-small">开头：</span>${escapeHTML(head)} <span class="ao3x-small">结尾：</span>${escapeHTML(tail)}</div>`;
      }).join('');

      summaryPlanBox.innerHTML = `<h4>总结计划：共 ${plan.length} 段</h4>${rows}<div class="ao3x-kv" id="ao3x-summary-kv"></div>`;

      // 2. 创建总结内容容器，放在总结计划之后，翻译计划之前
      let summaryContentContainer = $('#ao3x-summary-content-container', c);
      if (!summaryContentContainer) {
        summaryContentContainer = document.createElement('div');
        summaryContentContainer.id = 'ao3x-summary-content-container';
        summaryContentContainer.className = 'ao3x-summary-container';
        // 插入到总结计划之后
        summaryPlanBox.insertAdjacentElement('afterend', summaryContentContainer);
      }

      // 清空总结内容容器（避免重复添加）
      summaryContentContainer.innerHTML = '';

      // 3. 在总结内容容器中创建每个总结块
      plan.forEach((p, i) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'ao3x-block ao3x-summary-block';
        wrapper.setAttribute('data-summary-index', String(i));
        wrapper.setAttribute('data-original-html', p.html);

        const anchor = document.createElement('span');
        anchor.className = 'ao3x-anchor';
        anchor.setAttribute('data-summary-chunk-id', String(i));
        wrapper.appendChild(anchor);

        const div = document.createElement('div');
        div.className = 'ao3x-summary-content';
        div.innerHTML = '<span class="ao3x-muted">（待总结）</span>';
        wrapper.appendChild(div);

        // 将总结块添加到总结内容容器中
        summaryContentContainer.appendChild(wrapper);
      });
    },

    // 初始化总结渲染状态
    initRenderState(total) {
      this._renderState = {
        nextToRender: 0,
        total: total,
        lastApplied: Object.create(null)
      };
    },

    // 检查是否可以渲染指定段落
    canRender(i) {
      return i === this._renderState.nextToRender;
    },

    // 增量应用总结内容到DOM
    applyIncremental(i, cleanContent) {
      const c = ensureRenderContainer();
      const anchor = c.querySelector(`[data-summary-chunk-id="${i}"]`);
      if (!anchor) return;

      let contentDiv = anchor.parentElement.querySelector('.ao3x-summary-content');
      if (!contentDiv) {
        contentDiv = document.createElement('div');
        contentDiv.className = 'ao3x-summary-content';
        contentDiv.style.minHeight = '40px'; // 防止跳动
        anchor.insertAdjacentElement('afterend', contentDiv);
      }

      const prev = this._renderState.lastApplied[i] || '';
      const hasPlaceholder = /\(待总结\)/.test(contentDiv.textContent || '');

      if (!prev || hasPlaceholder) {
        requestAnimationFrame(() => {
          contentDiv.innerHTML = cleanContent || '<span class="ao3x-muted">（待总结）</span>';
          this._renderState.lastApplied[i] = cleanContent;
        });
        return;
      }

      if (cleanContent.startsWith(prev)) {
        const tail = cleanContent.slice(prev.length);
        if (tail) {
          requestAnimationFrame(() => {
            contentDiv.insertAdjacentHTML('beforeend', tail);
            this._renderState.lastApplied[i] = cleanContent;
          });
        }
      } else {
        requestAnimationFrame(() => {
          contentDiv.innerHTML = cleanContent;
          this._renderState.lastApplied[i] = cleanContent;
        });
      }
    },

    // 完成当前段落并推进渲染指针
    finalizeCurrent() {
      while (this._renderState.nextToRender < this._renderState.total) {
        const i = this._renderState.nextToRender;

        // 获取当前段落的内容
        const cached = SummaryStore.get(String(i)) || '';
        if (cached) this.applyIncremental(i, cached);

        // 检查是否已完成
        const isDone = !!(SummaryStore._done && SummaryStore._done[i]);
        if (isDone) {
          this._renderState.nextToRender++;
          continue;
        }

        // 当前段落未完成，停止推进
        break;
      }
    },

    // 更新总结状态显示
    updateSummaryKV(kv) {
      const kvElement = document.querySelector('#ao3x-summary-kv');
      if (!kvElement) return;
      kvElement.innerHTML = Object.entries(kv).map(([k, v]) =>
        `<span>${k}: ${escapeHTML(String(v))}</span>`
      ).join('');
    },

    // 单次总结处理
    async summarizeSingle({ endpoint, key, stream, modelCw, ratio, promptTokens, reserve, contentHtml, inTok, userMaxTokens, config }) {
      const predictedOut = Math.ceil(inTok * ratio);
      const outCapByCw = Math.max(256, modelCw - promptTokens - inTok - reserve);
      const maxTokensLocal = Math.max(256, Math.min(userMaxTokens, outCapByCw, predictedOut));

      d('summary:single:tokens', { inTok, predictedOut, outCapByCw, userMaxTokens, maxTokensLocal });
      if (maxTokensLocal < 256) throw new Error('上下文空间不足，无法进行总结');

      const i = 0;
      this.updateSummaryKV({ 状态: '正在总结', 进度: '1/1' });

      await postChatWithRetry({
        endpoint,
        key,
        stream,
        payload: {
          model: settings.get().summary?.model?.id || settings.get().model.id,
          messages: [
            { role: 'system', content: config.system },
            { role: 'user', content: config.userTemplate.replace('{{content}}', contentHtml) }
          ],
          temperature: settings.get().summary?.gen?.temperature || settings.get().gen.temperature,
          max_tokens: maxTokensLocal,
          stream: !!settings.get().stream.enabled
        },
        label: `summary-single#${i}`,
        onDelta: (delta) => {
          // 使用专用的 SummaryStreamer，与翻译分离缓冲区
          SummaryStreamer.push(i, delta, (k, clean) => {
            SummaryStore.set(String(k), clean);
            if (this.canRender(k)) {
              this.applyIncremental(k, clean);
            }
          });
        },
        onFinishReason: (fr) => {
          d('summary:single:finish_reason', { i, fr });
          handleFinishReason(fr, `summary-single#${i}`);
        },
        onDone: () => {
          SummaryStore.markDone(i);
          // 使用专用 SummaryStreamer 的完成快照，确保最后一帧一致
          SummaryStreamer.done(i, (k, clean) => {
            SummaryStore.set(String(k), clean);
            if (this.canRender(k)) {
              this.applyIncremental(k, clean);
            }
          });

          // 兜底：若已有最终缓存，确保渲染（与翻译部分保持一致策略）
          try {
            const finalContent = SummaryStore.get(String(i)) || '';
            if (finalContent) this.applyIncremental(i, finalContent);
          } catch {}

          this.finalizeCurrent();
          this.updateSummaryKV({ 状态: '已完成', 进度: '1/1' });
          d('summary:single:completed', { tokens: { in: inTok, maxOut: maxTokensLocal } });
        },
        onError: (e) => {
          const msg = `<p class="ao3x-muted">[总结失败：${e.message}]</p>`;
          SummaryStore.set(String(i), msg);
          SummaryStore.markDone(i);

          if (this.canRender(i)) {
            this.applyIncremental(i, msg);
          }

          this.finalizeCurrent();
          this.updateSummaryKV({ 状态: '失败', 错误: e.message });

          throw e;
        }
      });
    },

    // 并发分段总结处理
    async summarizeConcurrent({ endpoint, key, plan, concurrency, stream, modelCw, ratio, promptTokens, reserve, userMaxTokens, config }) {
      const N = plan.length;
      this.initRenderState(N);

      let inFlight = 0, nextToStart = 0, completed = 0, failed = 0;
      const startNext = () => {
        while (inFlight < concurrency && nextToStart < plan.length) {
          startChunk(nextToStart++);
        }
      };

      const startChunk = (i) => {
        const inputTok = plan[i].inTok != null ? plan[i].inTok : 0;
        const predictedOut = Math.ceil(inputTok * ratio);
        const outCapByCw = Math.max(256, modelCw - promptTokens - inputTok - reserve);
        const maxTokensLocal = Math.max(256, Math.min(userMaxTokens, outCapByCw, predictedOut));
        const label = `summary-chunk#${i}`;

        inFlight++;
        this.updateSummaryKV({ 进行中: inFlight, 完成: completed, 失败: failed, 进度: `${completed}/${N}` });

        d('summary:chunk:start', { i, inFlight, nextToStart, inputTok, predictedOut, outCapByCw, maxTokensLocal });

        postChatWithRetry({
          endpoint,
          key,
          payload: {
            model: settings.get().summary?.model?.id || settings.get().model.id,
            messages: [
              { role: 'system', content: config.system },
              { role: 'user', content: config.userTemplate.replace('{{content}}', plan[i].html) }
            ],
            temperature: settings.get().summary?.gen?.temperature || settings.get().gen.temperature,
            max_tokens: maxTokensLocal,
            stream: !!settings.get().stream.enabled
          },
          stream,
          label,
          onDelta: (delta) => {
            // 使用专用的 SummaryStreamer，与翻译分离缓冲区
            SummaryStreamer.push(i, delta, (k, clean) => {
              SummaryStore.set(String(k), clean);
              if (this.canRender(k)) {
                this.applyIncremental(k, clean);
              }
            });
          },
          onFinishReason: (fr) => {
            d('summary:chunk:finish_reason', { i, fr });
            handleFinishReason(fr, `summary-chunk#${i}`);
          },
          onDone: () => {
            SummaryStore.markDone(i);
            inFlight--;
            completed++;

            d('summary:chunk:done', { i });

            // 使用专用 SummaryStreamer 的完成快照，确保最后一帧一致
            SummaryStreamer.done(i, (k, clean) => {
              SummaryStore.set(String(k), clean);
              if (this.canRender(k)) {
                this.applyIncremental(k, clean);
              }
            });

            // 兜底：若已有最终缓存，确保渲染
            try {
              const finalContent = SummaryStore.get(String(i)) || '';
              if (finalContent && this.canRender(i)) this.applyIncremental(i, finalContent);
            } catch {}

            this.finalizeCurrent();
            this.updateSummaryKV({ 进行中: inFlight, 完成: completed, 失败: failed, 进度: `${completed}/${N}` });
            startNext();
          },
          onError: (e) => {
            inFlight--;
            failed++;

            d('summary:chunk:error', { i, err: e.message });

            const msg = `<p class="ao3x-muted">[总结失败：${e.message}]</p>`;
            SummaryStore.set(String(i), msg);
            SummaryStore.markDone(i);

            if (this.canRender(i)) {
              this.applyIncremental(i, msg);
            }

            this.finalizeCurrent();
            this.updateSummaryKV({ 进行中: inFlight, 完成: completed, 失败: failed, 进度: `${completed}/${N}` });
            startNext();
          }
        });
      };

      // 启动并发处理
      startNext();

      // 等待所有分段完成
      while (this._renderState.nextToRender < plan.length) {
        await sleep(80);
      }

      d('summary:concurrent:completed', { total: N, completed, failed });
    }
  };

  /* ================= Streamer（增量 + 有序；含实时快照） ================= */
  const createStreamer = () => ({
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
  });

  // Create separate instances for translation and summary
  const Streamer = createStreamer();
  const SummaryStreamer = createStreamer();

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
