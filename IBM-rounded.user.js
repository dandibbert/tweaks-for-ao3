// ==UserScript==
// @name         IBM ROUNDED 字体样式-修复Icon
// @namespace    http://tampermonkey.net/
// @version      0.4
// @description  修改网页普通文字为 IBM ROUNDED 標準體，保留图标字体与代码等宽字体
// @match        *://*/*
// @grant        GM_addStyle
// ==/UserScript==

(function () {
    'use strict';

    // 保留原字体来源，不替换网站自带的图标字体。
    GM_addStyle("@import url('https://ibmrounded.773421.xyz/result.css');");

    // Google AI Studio 等站点使用图标字体的连字（如 menu、more_vert）。
    // 禁止覆盖图标元素（以及它们的子元素）的 font-family，
    // 让网站原有的 Material Icons / Symbols、Font Awesome 等规则正常生效。
    const iconSelectors = [
        'i', 'svg', 'img', 'canvas',
        'mat-icon', 'md-icon', 'mdc-icon', 'g-icon', 'google-icon',
        'ion-icon', 'sl-icon', 'iconify-icon', 'vaadin-icon',
        '[role="img"]', '[data-icon]', '[data-lucide]',
        '[class*="icon" i]', '[id*="icon" i]',
        '[class*="symbol" i]',
        '.fa', '.fas', '.far', '.fab', '.fal', '.fad',
        '.glyphicon', '.anticon', '.octicon',
        '.mdi', '[class^="mdi-"]',
        '.bi', '[class^="bi-"]',
        '.pi', '[class^="pi-"]',
    ];

    const monospaceSelectors = [
        'code', 'pre', 'kbd', 'samp', 'tt',
        '.blob-code', '.blob-code-inner', '.highlight', '[class^="pl-"]',
    ];

    // 排除元素本身及其后代，避免给 <mat-icon><span>menu</span></mat-icon>
    // 或带语法高亮的 <code><span>...</span></code> 重新套上普通字体。
    const exclusions = [...iconSelectors, ...monospaceSelectors]
        .flatMap(selector => [selector, `${selector} *`])
        .join(',\n            ');

    GM_addStyle(`
        /* 普通文字统一使用 IBM ROUNDED；图标和代码由原网站决定字体。 */
        *:not(:is(${exclusions})) {
            font-family: 'IBM ROUNDED 標準體', sans-serif !important;
        }

        /* 保留原脚本对 Google 搜索标题字号的微调。 */
        #res h3, #extrares h3 {
            font-size: 17px !important;
            line-height: 1.3;
        }

        /* 代码块及其后代继续使用等宽字体。 */
        ${monospaceSelectors.join(',\n        ')} {
            font-family: ui-monospace, SFMono-Regular, "SF Mono", Consolas,
                "Liberation Mono", Menlo, monospace !important;
        }
    `);

    console.log('IBM ROUNDED 字体样式已应用，图标保留网站原有字体。');
})();
