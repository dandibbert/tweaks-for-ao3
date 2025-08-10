// ==UserScript==
// @name         AO3 优化脚本 (移动端/桌面端)
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  优化AO3阅读和浏览体验。移动端阅读字号放大；在所有作品列表页（搜索、书签、用户主页等）高亮字数和Kudos，并移动到标题旁，字数统一以“万”为单位显示。通过菜单项管理关键词屏蔽。
// @author       Gemini
// @match        https://archiveofourown.org/*
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
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

    /* ---------- 1. UI 结构 (使用模态框) ---------- */
    // 创建遮罩层
    const overlay = document.createElement('div');
    overlay.id = 'ao3-block-overlay';
    overlay.style.cssText = `
        display: none;
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background-color: rgba(0, 0, 0, 0.5);
        z-index: 9998;
    `;
    document.body.appendChild(overlay);

    // 创建模态框容器
    const modal = document.createElement('div');
    modal.id = 'ao3-block-modal';
    modal.style.cssText = `
        display: none;
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        z-index: 9999;
        overflow-y: auto;
        padding: 20px;
        box-sizing: border-box;
    `;
    document.body.appendChild(modal);

    // 创建模态框内容
    const modalContent = document.createElement('div');
    modalContent.style.cssText = `
        background: #fff;
        margin: 5% auto;
        padding: 25px;
        border-radius: 8px;
        width: 90%;
        max-width: 550px;
        box-shadow: 0 5px 15px rgba(0,0,0,0.3);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
        position: relative; /* 为关闭按钮定位 */
    `;
    
    // 添加一个关闭图标 (X) 在右上角
    const closeIcon = document.createElement('span');
    closeIcon.innerHTML = '&times;';
    closeIcon.style.cssText = `
        position: absolute;
        top: 15px;
        right: 20px;
        font-size: 28px;
        font-weight: bold;
        cursor: pointer;
        color: #aaa;
    `;
    closeIcon.addEventListener('click', hideModal);
    modalContent.appendChild(closeIcon);

    modalContent.innerHTML += `
        <h3 style="margin-top: 0; color: #333; border-bottom: 1px solid #eee; padding-bottom: 10px;">AO3 关键词屏蔽设置</h3>
        <label style="display: block; margin-bottom: 15px; color: #555;">
            屏蔽关键词（英文逗号分隔）:
            <textarea id="ao3-block-input" rows="4" placeholder="例: 怀孕,AU,斜线" style="width: 100%; box-sizing: border-box; margin-top: 8px; padding: 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px; resize: vertical;"></textarea>
        </label>
        <div style="text-align: right; margin-top: 20px;">
            <button id="ao3-block-clear" class="ao3-btn ao3-btn-secondary" style="margin-right: 10px;">清空</button>
            <button id="ao3-block-close" class="ao3-btn ao3-btn-secondary">取消</button>
            <button id="ao3-block-save" class="ao3-btn ao3-btn-primary" style="margin-left: 10px;">应用</button>
        </div>
    `;
    modal.appendChild(modalContent);

    /* ---------- 2. 样式 (按钮和整体美化) ---------- */
    const style = document.createElement('style');
    style.textContent = `
        .ao3-btn {
            padding: 8px 16px;
            border: 1px solid transparent;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            transition: all 0.2s ease-in-out;
            outline: none; /* 移除默认焦点轮廓 */
        }
        .ao3-btn:focus {
            box-shadow: 0 0 0 2px rgba(0, 123, 255, 0.25); /* 自定义焦点轮廓 */
        }
        .ao3-btn-primary {
            background-color: #007bff; /* Bootstrap 主色蓝 */
            color: #fff;
        }
        .ao3-btn-primary:hover {
            background-color: #0056b3; /* 深蓝悬停 */
        }
        .ao3-btn-secondary {
            background-color: #6c757d; /* Bootstrap 次色灰 */
            color: #fff;
        }
        .ao3-btn-secondary:hover {
            background-color: #545b62; /* 深灰悬停 */
        }
        #ao3-block-input:focus {
            border-color: #007bff;
            box-shadow: 0 0 0 0.2rem rgba(0,123,255,.25);
        }
        #ao3-block-modal h3 {
             margin-top: 0;
             color: #333;
             border-bottom: 1px solid #eee;
             padding-bottom: 10px;
        }
    `;
    document.head.appendChild(style);

    /* ---------- 3. 逻辑 ---------- */
    const input   = modal.querySelector('#ao3-block-input');
    const saveBtn = modal.querySelector('#ao3-block-save');
    const clearBtn= modal.querySelector('#ao3-block-clear');
    const closeBtn= modal.querySelector('#ao3-block-close');

    // 统一屏蔽函数（也用于首次加载）
    function doBlock(rawList) {
        const kws = rawList.split(',')
                           .map(k => k.trim().toLowerCase())
                           .filter(k => k);

        document.querySelectorAll('li.work.blurb, li.bookmark.blurb').forEach(li => {
            const hide = kws.length && kws.some(k => li.textContent.toLowerCase().includes(k));
            li.style.display = hide ? 'none' : '';
        });
    }

    // 显示模态框
    function showModal() {
        const storedKeywords = localStorage.getItem('ao3-block-keywords') || '';
        input.value = storedKeywords;
        overlay.style.display = 'block';
        modal.style.display = 'block';
        // 确保输入框获得焦点
        setTimeout(() => {
            if (input) input.focus();
        }, 10);
    }

    // 隐藏模态框
    function hideModal() {
        overlay.style.display = 'none';
        modal.style.display = 'none';
    }

    // 事件监听
    saveBtn.addEventListener('click', () => {
        const raw = input.value.trim();
        localStorage.setItem('ao3-block-keywords', raw);
        doBlock(raw);
        hideModal();
    });

    clearBtn.addEventListener('click', (e) => {
        e.preventDefault();
        localStorage.removeItem('ao3-block-keywords');
        input.value = '';
        doBlock('');
    });

    closeBtn.addEventListener('click', hideModal);
    // 点击遮罩层关闭模态框
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
             hideModal();
        }
    });

    // 注册菜单命令
    GM_registerMenuCommand("AO3 - 设置关键词屏蔽", showModal);

    /* 页面初始加载时就执行一次 */
    const stored = localStorage.getItem('ao3-block-keywords') || '';
    if (stored) doBlock(stored);
})();
  })();
