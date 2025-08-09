// ==UserScript==
// @name         AO3 优化脚本 (移动端/桌面端)
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  优化AO3阅读和浏览体验。移动端阅读字号放大；在所有作品列表页（搜索、书签、用户主页等）高亮字数和Kudos，并移动到标题旁，字数统一以“万”为单位显示。
// @author       Gemini
// @match        https://archiveofourown.org/*
// @grant        GM_addStyle
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
   关键词屏蔽浮层面板
   ————————————— */
(function buildKeywordPanel() {
    /* ---------- 1. UI 结构 ---------- */
    // 容器
    const panel = document.createElement('div');
    panel.id = 'ao3-block-panel';
    panel.innerHTML = `
        <a href="#" id="ao3-block-toggle" title="关键词屏蔽">⚙️</a>
        <div id="ao3-block-form">
            <label>
                屏蔽关键词（英文逗号分隔）:
                <textarea id="ao3-block-input" rows="3" cols="30" placeholder="例: 怀孕,AU,斜线"></textarea>
            </label>
            <br>
            <button id="ao3-block-save">应用</button>
            <a href="#" id="ao3-block-clear">清空</a>
        </div>`;
    document.body.appendChild(panel);

    /* ---------- 2. 样式 ---------- */
    GM_addStyle(`
        #ao3-block-panel{
            position:fixed;
            top:10px;
            right:10px;
            z-index:9999;
            font-family:Arial,Helvetica,sans-serif;
            font-size:13px;
            color:#333;
        }
        #ao3-block-toggle{
            display:inline-block;
            background:#ffe45e;
            padding:4px 8px;
            border-radius:50%;
            text-decoration:none;
            box-shadow:0 0 3px #0002;
        }
        #ao3-block-form{
            display:none;
            margin-top:6px;
            padding:8px;
            background:#fff;
            border:1px solid #ccc;
            border-radius:5px;
            box-shadow:0 2px 6px #0003;
        }
        #ao3-block-panel.open #ao3-block-form{display:block;}
        #ao3-block-input{width:100%;box-sizing:border-box;}
        #ao3-block-form button{margin-top:4px;margin-right:6px;}
    `);

    /* ---------- 3. 逻辑 ---------- */
    const toggle  = panel.querySelector('#ao3-block-toggle');
    const form    = panel.querySelector('#ao3-block-form');
    const input   = panel.querySelector('#ao3-block-input');
    const saveBtn = panel.querySelector('#ao3-block-save');
    const clearBtn= panel.querySelector('#ao3-block-clear');

    toggle.addEventListener('click', e => {
        e.preventDefault();
        panel.classList.toggle('open');
        if (!panel.classList.contains('open')) return;
        // 打开时把已存词显示出来
        input.value = localStorage.getItem('ao3-block-keywords') || '';
        input.focus();
    });

    saveBtn.addEventListener('click', () => {
        // 更新存储
        const raw = input.value.trim();
        localStorage.setItem('ao3-block-keywords', raw);
        // 重新屏蔽
        doBlock(raw);
        panel.classList.remove('open');
    });

    clearBtn.addEventListener('click', e => {
        e.preventDefault();
        localStorage.removeItem('ao3-block-keywords');
        input.value = '';
        doBlock('');
    });

    /* 统一屏蔽函数（也用于首次加载） */
    function doBlock(rawList) {
        const kws = rawList.split(',')
                           .map(k => k.trim().toLowerCase())
                           .filter(k => k);

        document.querySelectorAll('li.work.blurb, li.bookmark.blurb').forEach(li => {
            const hide = kws.length && kws.some(k => li.textContent.toLowerCase().includes(k));
            li.style.display = hide ? 'none' : '';
        });
    }

    /* 页面初始加载时就执行一次 */
    const stored = localStorage.getItem('ao3-block-keywords') || '';
    if (stored) input.value = stored;
    doBlock(stored);
})();
  })();
