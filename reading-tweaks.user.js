// ==UserScript==
// @name         AO3 优化脚本 (Bauhaus Edition)
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  包豪斯风格重构：优化阅读体验、高亮数据、关键词屏蔽与标签高亮。
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

    // 1. 移动端阅读字体优化
    GM_addStyle(`
        @media screen and (max-width: 768px) {
            div#workskin .userstuff {
                font-size: 1.25rem !important;
                line-height: 1.8 !important;
                letter-spacing: 0.02em;
            }
        }
    `);

    // 2. 统计数据高亮 (包豪斯方块风格)
    GM_addStyle(`
        .stat-highlight {
            background-color: #FFD700 !important; /* 包豪斯黄 */
            color: #000 !important;
            font-weight: 900 !important;
            padding: 2px 6px !important;
            border: 2px solid #000 !important;
            margin-left: 6px;
            font-size: 0.85em;
            text-transform: uppercase;
            display: inline-block;
        }
        .tag-match-highlight {
            background-color: #0055FF !important; /* 包豪斯蓝 */
            color: #fff !important;
            font-weight: bold !important;
            border: 2px solid #000 !important;
            padding: 0 4px !important;
        }
        dl.stats dt.words, dl.stats dd.words,
        dl.stats dt.kudos, dl.stats dd.kudos { display: none !important; }
    `);

    // 处理作品列表
    const works = document.querySelectorAll('li.work.blurb, li.bookmark.blurb');
    if (works.length > 0) {
        works.forEach(work => {
            const titleHeading = work.querySelector('h4.heading');
            if (!titleHeading || titleHeading.querySelector('.stat-highlight')) return;

            const wordsElement = work.querySelector('dd.words');
            if (wordsElement) {
                const count = parseInt(wordsElement.textContent.replace(/,/g, ''), 10);
                if (!isNaN(count)) {
                    const span = document.createElement('span');
                    span.textContent = `${(count / 10000).toFixed(1)}W`;
                    span.classList.add('stat-highlight');
                    titleHeading.appendChild(span);
                }
            }

            const kudosElement = work.querySelector('dd.kudos');
            if (kudosElement) {
                const span = document.createElement('span');
                span.textContent = `KUDOS ${kudosElement.textContent.trim()}`;
                span.classList.add('stat-highlight');
                titleHeading.appendChild(span);
            }
        });
    }

    // 3. 包豪斯风格设置面板
    (function buildBauhausPanel() {
        if (typeof GM_registerMenuCommand === 'undefined') return;

        GM_addStyle(`
            .bh-overlay {
                position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                background: rgba(255, 255, 255, 0.9); z-index: 10000;
                display: none; align-items: center; justify-content: center;
                font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
            }
            .bh-overlay.show { display: flex; }
            .bh-modal {
                background: #fff; border: 4px solid #000;
                width: 90%; max-width: 500px; padding: 0;
                box-shadow: 12px 12px 0px #000; /* 几何硬阴影 */
            }
            .bh-header {
                background: #000; color: #fff; padding: 15px 20px;
                display: flex; justify-content: space-between; align-items: center;
            }
            .bh-title { margin: 0; font-size: 1.2rem; font-weight: 900; letter-spacing: 1px; }
            .bh-body { padding: 30px 20px; }
            .bh-label {
                display: block; font-weight: 900; margin-bottom: 5px;
                text-transform: uppercase; font-size: 0.9rem;
            }
            .bh-textarea {
                width: 100%; min-height: 80px; border: 3px solid #000;
                padding: 10px; margin-bottom: 20px; box-sizing: border-box;
                font-size: 14px; outline: none; transition: background 0.2s;
            }
            .bh-textarea:focus { background: #ffffd0; }
            .bh-footer {
                border-top: 4px solid #000; padding: 15px;
                display: flex; gap: 0; /* 紧凑布局 */
            }
            .bh-btn {
                flex: 1; padding: 12px; border: 2px solid #000;
                cursor: pointer; font-weight: 900; text-transform: uppercase;
                transition: 0.1s;
            }
            .bh-btn-save { background: #0055FF; color: #fff; border-left: none; }
            .bh-btn-cancel { background: #fff; color: #000; }
            .bh-btn:hover { filter: invert(1); }
            .bh-close { cursor: pointer; font-size: 20px; font-weight: bold; }
        `);

        const overlay = document.createElement('div');
        overlay.className = 'bh-overlay';
        overlay.innerHTML = `
            <div class="bh-modal">
                <div class="bh-header">
                    <span class="bh-title">CONFIG / CONFIGURATION</span>
                    <span class="bh-close" id="bh-x">×</span>
                </div>
                <div class="bh-body">
                    <label class="bh-label">Block Keywords (Hide)</label>
                    <textarea id="bh-block" class="bh-textarea" placeholder="KEYWORD_01, KEYWORD_02..."></textarea>
                    
                    <label class="bh-label">Highlight Tags (Blue)</label>
                    <textarea id="bh-high" class="bh-textarea" placeholder="TAG_01, TAG_02..."></textarea>
                </div>
                <div class="bh-footer">
                    <button class="bh-btn bh-btn-cancel" id="bh-cancel">Cancel</button>
                    <button class="bh-btn bh-btn-save" id="bh-save">Apply</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const B_KEY = 'ao3-block-keywords';
        const H_KEY = 'ao3-highlight-keywords';

        function applyRules(bStr, hStr) {
            const bList = bStr.split(',').map(s => s.trim().toLowerCase()).filter(s => s);
            const hList = hStr.split(',').map(s => s.trim().toLowerCase()).filter(s => s);

            document.querySelectorAll('li.work.blurb, li.bookmark.blurb').forEach(li => {
                const text = li.textContent.toLowerCase();
                const shouldHide = bList.some(k => text.includes(k));
                li.style.display = shouldHide ? 'none' : '';

                if (!shouldHide) {
                    li.querySelectorAll('a.tag').forEach(tag => {
                        const tagText = tag.textContent.toLowerCase();
                        tag.classList.toggle('tag-match-highlight', hList.length > 0 && hList.some(k => tagText.includes(k)));
                    });
                }
            });
        }

        const open = async () => {
            document.getElementById('bh-block').value = await GM_getValue(B_KEY, '');
            document.getElementById('bh-highlight-input')?.remove(); // 兼容旧版
            document.getElementById('bh-high').value = await GM_getValue(H_KEY, '');
            overlay.classList.add('show');
        };

        const close = () => overlay.classList.remove('show');

        document.getElementById('bh-save').onclick = async () => {
            const b = document.getElementById('bh-block').value;
            const h = document.getElementById('bh-high').value;
            await GM_setValue(B_KEY, b);
            await GM_setValue(H_KEY, h);
            applyRules(b, h);
            close();
        };

        document.getElementById('bh-cancel').onclick = close;
        document.getElementById('bh-x').onclick = close;

        GM_registerMenuCommand("🔳 AO3 BAUHAUS SETTINGS", open);

        (async () => {
            const b = await GM_getValue(B_KEY, '');
            const h = await GM_getValue(H_KEY, '');
            if (b || h) applyRules(b, h);
        })();
    })();
})();
