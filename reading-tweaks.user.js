// ==UserScript==
// @name         AO3 优化脚本 (移动端/桌面端)
// @namespace    http://tampermonkey.net/
// @version      2.8
// @description  优化AO3阅读和浏览体验。移动端阅读字号放大；在所有作品列表页（搜索、书签、用户主页等）高亮字数和Kudos，并移动到标题旁，字数统一以“万”为单位显示。通过菜单项管理关键词屏蔽。
// @author       Gemini
// @match        https://archiveofourown.org/*
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    /**
     * 功能 1: 移动端阅读字体优化
     * 使用 CSS 媒体查询，仅当屏幕宽度小于等于 768px (典型的平板和手机尺寸) 时，
     * 自动放大文章正文区域的字体和行高，提升阅读体验。
     */
    GM_addStyle(`
        @media screen and (max-width: 768px) {
            div#workskin .userstuff {
                font-size: 130% !important;
                line-height: 1.8 !important; /* 增加行高以提高可读性 */
            }
        }
    `);

    /**
     * 功能 2: 在所有作品列表页高亮统计数据并移动到标题旁
     * 自动检测页面是否存在作品列表，而不再限制于特定URL。
     */
    const works = document.querySelectorAll('li.work.blurb, li.bookmark.blurb');

    // 只有当页面上存在作品列表时，才执行后续操作
    if (works.length > 0) {

        // 注入用于移动和高亮数据的 CSS 样式
        GM_addStyle(`
            /* 高亮标签的样式 */
            .stat-highlight {
                background-color: #ffe45e !important; /* 使用鲜艳的黄色 */
                color: #333 !important;
                font-weight: bold !important;
                padding: 3px 8px !important;
                border-radius: 5px !important;
                border: 1px solid #d4af37 !important;
                display: inline-block !important;
                margin-left: 8px; /* 与标题保持一点距离 */
                font-size: 0.9em; /* 使其比标题稍小 */
                vertical-align: middle; /* 垂直居中对齐 */
                white-space: nowrap; /* 防止标签内换行 */
            }

            /* 隐藏原始的字数和Kudos条目，避免信息重复 */
            dl.stats dt.words, dl.stats dd.words,
            dl.stats dt.kudos, dl.stats dd.kudos {
                display: none !important;
            }
        `);

        // 遍历找到的每一个作品条目
        works.forEach(work => {
            const titleHeading = work.querySelector('h4.heading');
            // 确保该条目未被处理过，防止重复添加
            if (!titleHeading || titleHeading.querySelector('.stat-highlight')) {
                return;
            }

            // --- 处理字数 (Words) ---
            const wordsElement = work.querySelector('dd.words');
            if (wordsElement) {
                const wordsText = wordsElement.textContent.trim().replace(/,/g, '');
                const wordsCount = parseInt(wordsText, 10);

                if (!isNaN(wordsCount)) {
                    // 统一将字数转换为以“万”为单位
                    const wordsInWan = (wordsCount / 10000).toFixed(1);
                    
                    // 创建新的span元素来显示字数
                    const newWordsSpan = document.createElement('span');
                    newWordsSpan.textContent = `${wordsInWan}万`;
                    newWordsSpan.classList.add('stat-highlight');

                    // 将新元素添加到标题后面
                    titleHeading.appendChild(newWordsSpan);
                }
            }

            // --- 处理点赞数 (Kudos) ---
            const kudosElement = work.querySelector('dd.kudos');
            if (kudosElement) {
                const kudosText = kudosElement.textContent.trim();
                
                // 创建新的span元素来显示Kudos
                const newKudosSpan = document.createElement('span');
                newKudosSpan.textContent = `❤️ ${kudosText}`; // 添加爱心图标以示区分
                newKudosSpan.classList.add('stat-highlight');

                // 将新元素添加到标题后面
                titleHeading.appendChild(newKudosSpan);
            }
        });
    }

/* —————————————
   关键词屏蔽功能 (通过菜单项触发)
   ————————————— */
(function buildKeywordPanel() {
    // 检查是否支持 GM_registerMenuCommand
    if (typeof GM_registerMenuCommand === 'undefined') {
        console.warn('AO3 优化脚本: GM_registerMenuCommand 未定义，关键词屏蔽功能可能无法通过菜单访问。');
        return;
    }

    // 注入模态框样式
    GM_addStyle(`
        .ao3-modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.6);
            z-index: 10000;
            display: none;
            align-items: center;
            justify-content: center;
        }
        
        .ao3-modal-overlay.show {
            display: flex;
        }
        
        .ao3-modal {
            background: #fff;
            border-radius: 8px;
            width: 90%;
            max-width: 500px;
            max-height: 90vh;
            overflow: hidden;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
        }
        
        .ao3-modal-header {
            padding: 24px 28px 16px;
            border-bottom: 1px solid #e5e7eb;
            position: relative;
        }
        
        .ao3-modal-title {
            margin: 0;
            font-size: 20px;
            font-weight: 600;
            color: #111827;
            line-height: 1.3;
        }
        
        .ao3-modal-close {
            position: absolute;
            right: 20px;
            top: 20px;
            width: 32px;
            height: 32px;
            border: none;
            background: #f3f4f6;
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            color: #6b7280;
            font-size: 16px;
        }
        
        .ao3-modal-close:hover {
            background: #e5e7eb;
            color: #374151;
        }
        
        .ao3-modal-body {
            padding: 24px 28px;
        }
        
        .ao3-input-group {
            margin-bottom: 20px;
        }
        
        .ao3-input-label {
            display: block;
            font-size: 14px;
            font-weight: 500;
            color: #374151;
            margin-bottom: 8px;
        }
        
        .ao3-textarea {
            width: 100%;
            min-height: 100px;
            padding: 12px 16px;
            border: 2px solid #e5e7eb;
            border-radius: 8px;
            font-size: 14px;
            font-family: inherit;
            resize: vertical;
            box-sizing: border-box;
            transition: border-color 0.2s ease, box-shadow 0.2s ease;
            background: #fafafa;
        }
        
        .ao3-textarea:focus {
            outline: none;
            border-color: #3b82f6;
            background: #fff;
            box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
        }
        
        .ao3-input-hint {
            font-size: 12px;
            color: #6b7280;
            margin-top: 6px;
        }
        
        .ao3-modal-footer {
            padding: 16px 28px 24px;
            display: flex;
            justify-content: flex-end;
            gap: 12px;
            border-top: 1px solid #e5e7eb;
            background: #fafafa;
        }
        
        .ao3-btn {
            padding: 10px 20px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            border: 1px solid;
            cursor: pointer;
        }
        
        .ao3-btn:focus {
            outline: none;
            box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
        }
        
        .ao3-btn-secondary {
            background: #fff;
            border-color: #d1d5db;
            color: #374151;
        }
        
        .ao3-btn-secondary:hover {
            background: #f9fafb;
            border-color: #9ca3af;
        }
        
        .ao3-btn-danger {
            background: #fff;
            border-color: #fca5a5;
            color: #dc2626;
        }
        
        .ao3-btn-danger:hover {
            background: #fef2f2;
            border-color: #f87171;
        }
        
        .ao3-btn-primary {
            background: #3b82f6;
            border-color: #3b82f6;
            color: #fff;
        }
        
        .ao3-btn-primary:hover {
            background: #2563eb;
            border-color: #2563eb;
        }
        
        @media (max-width: 640px) {
            .ao3-modal {
                width: 95%;
                margin: 20px;
            }
            .ao3-modal-header,
            .ao3-modal-body {
                padding-left: 20px;
                padding-right: 20px;
            }
            .ao3-modal-footer {
                padding: 16px 20px 20px;
                flex-wrap: wrap;
            }
            .ao3-btn {
                flex: 1;
                min-width: 80px;
            }
        }
    `);

    // 创建模态框HTML结构
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
                    <label class="ao3-input-label" for="ao3-keywords-input">
                        屏蔽关键词
                    </label>
                    <textarea
                        id="ao3-keywords-input"
                        class="ao3-textarea"
                        placeholder="请输入需要屏蔽的关键词，用英文逗号分隔\n\n例如：怀孕, AU, 现代AU, 斜线\n\n支持中英文关键词，不区分大小写"
                        rows="5"
                    ></textarea>
                    <div class="ao3-input-hint">
                        💡 输入关键词后点击"应用"即可屏蔽包含这些词的作品
                    </div>
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

    // 获取元素引用
    const modal = overlay.querySelector('.ao3-modal');
    const closeBtn = overlay.querySelector('.ao3-modal-close');
    const textarea = overlay.querySelector('#ao3-keywords-input');
    const clearBtn = overlay.querySelector('#ao3-clear-btn');
    const cancelBtn = overlay.querySelector('#ao3-cancel-btn');
    const saveBtn = overlay.querySelector('#ao3-save-btn');

    // 存储封装与迁移
    const STORAGE_KEY = 'ao3-block-keywords';

    async function getKeywordsFromGM() {
        try {
            const value = await GM_getValue(STORAGE_KEY, '');
            return typeof value === 'string' ? value : '';
        } catch (e) {
            return '';
        }
    }

    async function setKeywordsToGM(value) {
        try {
            await GM_setValue(STORAGE_KEY, value);
        } catch (e) {}
    }

    async function clearKeywordsInGM() {
        try {
            await GM_deleteValue(STORAGE_KEY);
        } catch (e) {}
    }

    async function migrateFromLocalStorageIfNeeded() {
        try {
            const existing = await GM_getValue(STORAGE_KEY, null);
            if (existing === null) {
                const ls = localStorage.getItem(STORAGE_KEY);
                if (ls !== null) {
                    await GM_setValue(STORAGE_KEY, ls);
                    localStorage.removeItem(STORAGE_KEY);
                }
            }
        } catch (e) {}
    }

    // 屏蔽功能
    function doBlock(rawList) {
        const keywords = rawList.split(',')
            .map(k => k.trim().toLowerCase())
            .filter(k => k);

        document.querySelectorAll('li.work.blurb, li.bookmark.blurb').forEach(li => {
            const shouldHide = keywords.length && keywords.some(k => 
                li.textContent.toLowerCase().includes(k)
            );
            li.style.display = shouldHide ? 'none' : '';
        });
    }

    // 显示模态框
    async function showModal() {
        const storedKeywords = await getKeywordsFromGM();
        textarea.value = storedKeywords;
        overlay.classList.add('show');
        setTimeout(() => textarea.focus(), 100);
    }

    // 隐藏模态框
    function hideModal() {
        overlay.classList.remove('show');
    }

    // 事件监听
    saveBtn.addEventListener('click', async () => {
        const keywords = textarea.value.trim();
        await setKeywordsToGM(keywords);
        doBlock(keywords);
        hideModal();
    });

    clearBtn.addEventListener('click', async () => {
        if (confirm('确定要清空所有屏蔽关键词吗？')) {
            await clearKeywordsInGM();
            textarea.value = '';
            doBlock('');
        }
    });

    cancelBtn.addEventListener('click', hideModal);
    closeBtn.addEventListener('click', hideModal);

    // 点击遮罩层关闭
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            hideModal();
        }
    });

    // 阻止模态框内容区域的点击事件冒泡
    modal.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    // ESC键关闭
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.classList.contains('show')) {
            hideModal();
        }
    });

    // 注册菜单命令
    GM_registerMenuCommand("🚫 AO3 关键词屏蔽设置", showModal);

    // 页面加载时迁移并应用已保存的屏蔽规则（GM 存储）
    (async function initKeywordBlock() {
        await migrateFromLocalStorageIfNeeded();
        const stored = await getKeywordsFromGM();
        if (stored) doBlock(stored);
    })();
})();
  })();
