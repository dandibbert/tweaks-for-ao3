// ==UserScript==
// @name         IBM ROUNDED 字体样式-修复Icon
// @namespace    http://tampermonkey.net/
// @version      0.3
// @description  修改网页字体为IBM ROUNDED 標準體, 并保留图标显示
// @match        *://*/*
// @grant        GM_addStyle
// ==/UserScript==

(function() {
    'use strict';
    
    // 导入IBM ROUNDED字体
    GM_addStyle(`
        @import url('https://ibmrounded.773421.xyz/result.css');
    `);
    
    // 定义需要排除的元素选择器列表，不改变它们的字体
    const exclusions = `
        i,
        svg,
        img,
        /* Google Material Icons / Symbols */
        .material-icons,
        [class*="material-symbols-"],
        /* Font Awesome */
        .fa, .fas, .far, .fab, .fal, [class*="fa-"],
        /* Bootstrap Glyphicon */
        .glyphicon, [class*="glyphicon-"],
        /* Ant Design & Element UI & Ionic*/
        .anticon,
        [class^="el-icon-"],
        ion-icon,
        /* GitHub Octicons */
        .octicon,
        /* 兜底: 包含 icon 字符的class */
        [class*="icon"],
        /* 等宽字体元素 */
        code, pre, kbd, samp, tt,
        .blob-code,
        .blob-code-inner,
        .highlight,
        [class^="pl-"]
    `;
    
    GM_addStyle(`
        /* ----- 规则 1: 修改全局字体，但排除图标元素 ----- */
        *:not(${exclusions}) {
            font-family: 'IBM ROUNDED 標準體', sans-serif !important;
        }
        
        /* ----- 规则 2: 特定元素规则 ----- */
        #res h3, #extrares h3 {
            font-size: 17px !important;
            line-height: 1.3;
            font-family: 'IBM ROUNDED 標準體', sans-serif !important;
        }
        
        /* ----- 规则 3: 确保排除元素保持原样 ----- */
        ${exclusions} {
            font-family: inherit !important;
        }
        
        /* ----- 规则 4: 等宽字体元素恢复默认 ----- */
        code, pre, kbd, samp, tt,
        .blob-code,
        .blob-code-inner,
        .highlight,
        [class^="pl-"] {
            font-family: ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace !important;
        }
        
        /* ----- 规则 5: 图标元素恢复默认 ----- */
        .octicon, .material-icons, .fa, .fas, .far, .fab, .glyphicon, .anticon, ion-icon {
            font-family: inherit !important;
        }
    `);
    
    console.log("IBM ROUNDED 字体样式脚本已应用，图标已排除。");
})();
