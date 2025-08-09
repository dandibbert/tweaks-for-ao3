// ==UserScript==
// @name         通用悬浮导航脚本 (AO3特别适配)
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  一个在所有网站都能用的悬浮导航面板。提供回到顶部、前往底部功能，并能智能查找下一页/章链接。在AO3网站上进行特别优化，识别更精准。
// @author       You & Gemini
// @match        *://*/*
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    /**
     * 步骤 1: 注入UI样式
     * 设计一个现代、简洁、小巧的悬浮按钮面板。
     */
    GM_addStyle(`
        .gm-nav-panel {
            position: fixed;
            right: 12px;
            bottom: 80px; /* 适配移动端，避开浏览器底部工具栏 */
            z-index: 99999;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 10px; /* 缩小按钮之间的垂直间距 */
        }

        .gm-nav-button {
            width: 42px; /* 缩小按钮尺寸 */
            height: 42px; /* 缩小按钮尺寸 */
            background-color: rgba(0, 0, 0, 0.55); /* 半透明黑色背景，现代感 */
            color: #ffffff;
            border: none;
            border-radius: 50%; /* 圆形按钮 */
            display: flex;
            justify-content: center;
            align-items: center;
            cursor: pointer;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2); /* 调整阴影使其更柔和 */
            transition: all 0.2s cubic-bezier(0.25, 0.8, 0.25, 1);
            opacity: 0.6; /* 默认状态下半透明，不打扰阅读 */
        }

        .gm-nav-button:hover {
            background-color: rgba(0, 0, 0, 0.75);
            transform: scale(1.1);
            opacity: 1;
        }

        .gm-nav-button:active {
            transform: scale(1.0); /* 点击时恢复，有按压感 */
        }

        .gm-nav-button svg {
            width: 24px; /* 缩小图标尺寸 */
            height: 24px; /* 缩小图标尺寸 */
            fill: currentColor;
        }

        .gm-nav-hidden {
            display: none !important;
        }
    `);

    /**
     * 步骤 2: 定义按钮的图标和功能
     */
    const upArrowSVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"></path></svg>';
    const downArrowSVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"></path></svg>';
    const nextArrowSVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"></path></svg>';

    const navPanel = document.createElement('div');
    navPanel.className = 'gm-nav-panel';

    const upButton = document.createElement('button');
    upButton.className = 'gm-nav-button';
    upButton.title = '回到顶部';
    upButton.innerHTML = upArrowSVG;
    upButton.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });

    const downButton = document.createElement('button');
    downButton.className = 'gm-nav-button';
    downButton.title = '滚至底部';
    downButton.innerHTML = downArrowSVG;
    // **BUG修复**: 使用更可靠的方式获取页面总高度，兼容更多网站。
    downButton.onclick = () => {
        const pageHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, document.body.offsetHeight, document.documentElement.offsetHeight, document.body.clientHeight, document.documentElement.clientHeight);
        window.scrollTo({ top: pageHeight, behavior: 'smooth' });
    };

    const nextButton = document.createElement('button');
    nextButton.className = 'gm-nav-button';
    nextButton.title = '下一页 / 下一章';
    nextButton.innerHTML = nextArrowSVG;

    /**
     * 步骤 3: 智能查找“下一页”链接（泛用 + AO3特别适配）
     */
    let nextLink = null;
    const hostname = window.location.hostname;

    if (hostname.includes('archiveofourown.org')) {
        nextLink = document.querySelector('li.chapter.next a, li.next a');
    }

    if (!nextLink) {
        const genericXpaths = [
            '//a[contains(text(),"Next Chapter")]', '//a[contains(text(),"下一章")]',
            '//a[contains(text(),"Next Page")]', '//a[contains(text(),"下一页")]',
            '//a[contains(text(),"Next →")]', '//a[text()="→"]',
            '//a[contains(translate(text(), "NEXT", "next"), "next")]'
        ];
        for (const xpath of genericXpaths) {
            const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            if (result) {
                nextLink = result;
                break;
            }
        }
    }

    if (nextLink) {
        nextButton.onclick = () => nextLink.click();
    } else {
        nextButton.classList.add('gm-nav-hidden');
    }

    /**
     * 步骤 4: 将创建好的按钮添加到页面上
     * **BUG修复**: 增加一个检查，确保 document.body 加载完毕后再添加，以提高兼容性。
     */
    navPanel.appendChild(upButton);
    navPanel.appendChild(downButton);
    navPanel.appendChild(nextButton);

    function appendWhenReady() {
        if (document.body) {
            document.body.appendChild(navPanel);
        } else {
            // 如果 body 还没准备好，等待 DOMContentLoaded 事件
            window.addEventListener('DOMContentLoaded', () => document.body.appendChild(navPanel), { once: true });
        }
    }

    appendWhenReady();

})();
