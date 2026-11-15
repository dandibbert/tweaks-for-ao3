// ==UserScript==
// @name         IBM ROUNDED 字体样式-修复Icon
// @namespace    http://tampermonkey.net/
// @version      0.5
// @description  全站 IBM ROUNDED 正文字体，兼容 Google Material Icons 与 Claude Anthropicons
// @match        *://*/*
// @grant        GM_addStyle
// ==/UserScript==

(function () {
    'use strict';

    // 保留原字体来源，不替换网站自带的图标字体。
    GM_addStyle("@import url('https://ibmrounded.773421.xyz/result.css');");

    // Claude 使用 Anthropicons-Variable 图标字体，其字形不一定有 icon 类名。
    // 避免全元素 !important 规则覆盖图标，专门改 Claude 的文字字体变量。
    if (/(^|\.)claude\.ai$/i.test(location.hostname)) {
        GM_addStyle(`
            :root, html, body, .cds-root, [data-mode] {
                --font-anthropic-sans: 'IBM ROUNDED 標準體', sans-serif !important;
                --font-anthropic-serif: 'IBM ROUNDED 標準體', sans-serif !important;
                --cds-font-sans: 'IBM ROUNDED 標準體', sans-serif !important;
                --cds-font-voice: 'IBM ROUNDED 標準體', sans-serif !important;
            }

            /* 回退给没有使用 CSS 字体变量的普通文字，避免触碰图标。 */
            body { font-family: 'IBM ROUNDED 標準體', sans-serif !important; }
            .font-claude-response-body,
            .font-claude-response-title,
            .font-anthropic-sans,
            .font-anthropic-serif,
            .font-sans, .font-serif {
                font-family: 'IBM ROUNDED 標準體', sans-serif !important;
            }
        `);
        console.log('IBM ROUNDED：Claude 使用字体变量，保留 Anthropicons 图标字体。');
        return;
    }

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
