// ==UserScript==
// @name         AO3 标签预览面板 (移动端优化版)
// @namespace    http://tampermonkey.net/
// @version      1.8
// @description  点击AO3标签时显示预览面板，可复制标签内容或在新标签页打开 - 低调配色
// @author       Your Name
// @match        https://archiveofourown.org/*
// @grant        GM_addStyle
// @license      MIT
// ==/UserScript==
(function() {
    'use strict';
    // 添加CSS样式 - 低调配色方案
    GM_addStyle(`
        .ao3-tag-panel {
            position: fixed !important;
            background: #ffffff !important;
            border: 1px solid #e0e0e0 !important;
            border-radius: 12px !important;
            padding: 20px !important;
            box-shadow: 0 4px 20px rgba(0,0,0,0.08) !important;
            z-index: 2147483647 !important;
            width: 85% !important;
            max-width: 360px !important;
            min-width: 280px !important;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif !important;
            display: none !important;
            top: 50% !important;
            left: 50% !important;
            transform: translate(-50%, -50%) scale(0.95) !important;
            margin: 0 !important;
            box-sizing: border-box !important;
            -webkit-box-sizing: border-box !important;
            opacity: 0 !important;
            transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1) !important;
        }
        .ao3-tag-panel.show {
            display: block !important;
            opacity: 1 !important;
            transform: translate(-50%, -50%) scale(1) !important;
        }
        .ao3-tag-panel .tag-content {
            background: #f8f9fa !important;
            border: 1px solid #e9ecef !important;
            border-radius: 8px !important;
            padding: 16px !important;
            margin-bottom: 16px !important;
            word-wrap: break-word !important;
            font-size: 15px !important;
            line-height: 1.5 !important;
            color: #333333 !important;
            -webkit-user-select: text !important;
            user-select: text !important;
        }
        .ao3-tag-panel .tag-content::before {
            content: "标签内容" !important;
            display: block !important;
            font-weight: 500 !important;
            color: #666666 !important;
            margin-bottom: 8px !important;
            font-size: 12px !important;
            text-transform: uppercase !important;
            letter-spacing: 0.5px !important;
        }
        .ao3-tag-panel .button-group {
            display: flex !important;
            gap: 10px !important;
            margin-top: 4px !important;
        }
        .ao3-tag-panel button {
            flex: 1 !important;
            padding: 11px 16px !important;
            border: none !important;
            border-radius: 8px !important;
            cursor: pointer !important;
            font-size: 14px !important;
            font-weight: 500 !important;
            transition: all 0.15s ease !important;
            -webkit-tap-highlight-color: rgba(0,0,0,0.1) !important;
            touch-action: manipulation !important;
            min-height: 40px !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
        }
        .ao3-tag-panel .copy-btn {
            background: #4a90e2 !important;
            color: white !important;
        }
        .ao3-tag-panel .copy-btn:active {
            background: #357abd !important;
            transform: scale(0.98) !important;
        }
        .ao3-tag-panel .open-btn {
            background: #7b68ee !important;
            color: white !important;
        }
        .ao3-tag-panel .open-btn:active {
            background: #6456d4 !important;
            transform: scale(0.98) !important;
        }
        .ao3-tag-panel .copy-hint {
            text-align: center !important;
            color: #4a90e2 !important;
            font-size: 13px !important;
            margin-top: 12px !important;
            opacity: 0 !important;
            transition: opacity 0.3s ease !important;
            padding: 6px 10px !important;
            background: #e8f0fe !important;
            border-radius: 4px !important;
            font-weight: 500 !important;
        }
        .ao3-tag-panel .copy-hint.show {
            opacity: 1 !important;
        }
        /* 遮罩层 */
        .ao3-overlay {
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            width: 100% !important;
            height: 100% !important;
            background: rgba(0,0,0,0.3) !important;
            z-index: 2147483646 !important;
            display: none !important;
            -webkit-tap-highlight-color: transparent !important;
        }
        .ao3-overlay.show {
            display: block !important;
        }
        /* 调试信息 */
        .ao3-debug {
            position: fixed !important;
            bottom: 20px !important;
            right: 20px !important;
            background: rgba(0,0,0,0.75) !important;
            color: white !important;
            padding: 10px 16px !important;
            border-radius: 8px !important;
            font-size: 13px !important;
            z-index: 2147483645 !important;
            max-width: 300px !important;
            word-wrap: break-word !important;
            line-height: 1.4 !important;
            box-shadow: 0 2px 10px rgba(0,0,0,0.2) !important;
        }
    `);
    // 创建面板和遮罩层
    function createPanel() {
        // 创建遮罩层
        const overlay = document.createElement('div');
        overlay.className = 'ao3-overlay';
        overlay.id = 'ao3-overlay-unique';
        // 创建面板
        const panel = document.createElement('div');
        panel.className = 'ao3-tag-panel';
        panel.id = 'ao3-tag-panel-unique';
        const tagContent = document.createElement('div');
        tagContent.className = 'tag-content';
        const buttonGroup = document.createElement('div');
        buttonGroup.className = 'button-group';
        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-btn';
        copyBtn.textContent = '复制标签';
        const openBtn = document.createElement('button');
        openBtn.className = 'open-btn';
        openBtn.textContent = '打开链接';
        const copyHint = document.createElement('div');
        copyHint.className = 'copy-hint';
        copyHint.textContent = '已复制到剪贴板';
        buttonGroup.appendChild(copyBtn);
        buttonGroup.appendChild(openBtn);
        panel.appendChild(tagContent);
        panel.appendChild(buttonGroup);
        panel.appendChild(copyHint);
        document.body.appendChild(overlay);
        document.body.appendChild(panel);
        return {
            panel,
            overlay,
            tagContent,
            copyBtn,
            openBtn,
            copyHint
        };
    }
    const { panel, overlay, tagContent, copyBtn, openBtn, copyHint } = createPanel();
    let currentTag = null;
    let scrollPosition = 0;
    // 显示面板 - 移动端居中显示
    function showPanel(tagElement) {
        currentTag = tagElement;
        const tagText = tagElement.textContent.trim();
        const tagLink = tagElement.href;
        // 保存当前滚动位置
        scrollPosition = window.pageYOffset || document.documentElement.scrollTop;
        tagContent.textContent = tagText;
        // 显示遮罩层和面板
        overlay.style.display = 'block';
        overlay.classList.add('show');
        panel.style.display = 'block';
        panel.classList.add('show');
        // 强制设置样式
        panel.style.cssText = `
            position: fixed !important;
            top: 50% !important;
            left: 50% !important;
            transform: translate(-50%, -50%) scale(1) !important;
            display: block !important;
            z-index: 2147483647 !important;
            width: 85% !important;
            max-width: 360px !important;
            opacity: 1 !important;
        `;
        // 更新按钮事件
        copyBtn.onclick = () => copyToClipboard(tagText);
        openBtn.onclick = () => {
            window.open(tagLink, '_blank');
            hidePanel();
        };
        // 遮罩层点击关闭
        overlay.onclick = hidePanel;
        // 阻止页面滚动 - 使用更温和的方式
        document.body.style.overflow = 'hidden';
        document.body.style.position = 'fixed';
        document.body.style.top = `-${scrollPosition}px`;
        document.body.style.width = '100%';
    }
    // 隐藏面板
    function hidePanel() {
        panel.style.display = 'none';
        panel.classList.remove('show');
        overlay.style.display = 'none';
        overlay.classList.remove('show');
        copyHint.classList.remove('show');
        currentTag = null;
        // 恢复页面滚动 - 确保恢复到原来的位置
        document.body.style.overflow = '';
        document.body.style.position = '';
        document.body.style.width = '';
        document.body.style.top = '';
        // 使用保存的滚动位置恢复
        window.scrollTo(0, scrollPosition);
    }
    // 复制到剪贴板 - 移动端优化
    async function copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
            copyHint.classList.add('show');
            setTimeout(() => {
                copyHint.classList.remove('show');
            }, 2000);
        } catch (err) {
            // 降级方案
            const textArea = document.createElement('textarea');
            textArea.value = text;
            textArea.style.position = 'fixed';
            textArea.style.left = '0';
            textArea.style.top = '0';
            textArea.style.width = '100%';
            textArea.style.height = '100px';
            textArea.style.fontSize = '16px';
            textArea.style.padding = '10px';
            textArea.style.backgroundColor = '#fff';
            textArea.style.zIndex = '2147483647';
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            try {
                document.execCommand('copy');
                copyHint.classList.add('show');
                setTimeout(() => {
                    copyHint.classList.remove('show');
                }, 2000);
            } catch (e) {
                console.error('复制失败:', e);
            }
            document.body.removeChild(textArea);
        }
    }
    // 精准判断是否是AO3标签链接
    function isTagLink(element) {
        if (!element || !element.href || element.tagName !== 'A') return false;
        const href = element.href;
        const classList = element.classList;
        
        // 排除明显的非标签链接
        const nonTagSelectors = [
            'nav', '.navigation', '.header', '.footer',
            '.actions', '.dropdown', '.menu', '.pagination',
            '.breadcrumb', '.home', '.search', '.user'
        ];
        for (const selector of nonTagSelectors) {
            if (element.closest(selector)) {
                return false;
            }
        }
        
        // 排除分页链接（数字、Next、Previous等）
        const linkText = element.textContent.trim().toLowerCase();
        const paginationTexts = ['next', 'previous', 'last', 'first', '»', '«', '‹', '›'];
        if (paginationTexts.some(text => linkText.includes(text)) || /^\d+$/.test(linkText)) {
            return false;
        }
        
        // 1. 检查是否是标签页链接 (/tags/)
        if (href.includes('/tags/') && !href.includes('/works?')) {
            // 排除一些非标签的链接
            if (href.includes('/tags/search') ||
                href.includes('/tags/feed') ||
                href.includes('/tags/new')) {
                return false;
            }
            return true;
        }
        
        // 2. 检查是否是作品筛选链接 - 更严格的条件
        if (href.includes('/works?')) {
            // 排除分页参数
            if (href.includes('page=') || href.includes('show=')) {
                return false;
            }
            
            // 只包含标签相关参数的链接
            const hasTagParam = href.includes('tag_id=') ||
                               href.includes('work_search%5Btag_ids%5D%5B%5D=') ||
                               href.includes('work_search%5Bfreeform_ids%5D%5B%5D=') ||
                               href.includes('work_search%5Bcharacter_ids%5D%5B%5D=') ||
                               href.includes('work_search%5Brelationship_ids%5D%5B%5D=') ||
                               href.includes('work_search%5Bfandom_ids%5D%5B%5D=');
            
            // 排除包含其他非标签参数的链接
            const hasNonTagParam = href.includes('sort_column=') ||
                                 href.includes('sort_direction=') ||
                                 href.includes('query=') ||
                                 href.includes('work_search%5Bquery%5D=');
            
            return hasTagParam && !hasNonTagParam;
        }
        
        // 3. 检查是否在标签容器内
        const tagContainers = [
            '.tags', '.warnings', '.categories', '.fandoms',
            '.relationships', '.characters', '.freeforms',
            '.work .meta .tags', '.work .meta .warnings',
            '.work .meta .categories', '.work .meta .fandom',
            '.work .meta .relationships', '.work .meta .characters',
            '.work .meta .freeforms', '.tag-set', '.tag-wrapper'
        ];
        for (const selector of tagContainers) {
            if (element.closest(selector)) {
                return true;
            }
        }
        
        // 4. 检查元素本身的类名
        const tagClasses = [
            'tag', 'tags', 'warning', 'category', 'rating',
            'relationship', 'character', 'freeform', 'fandom'
        ];
        for (const cls of tagClasses) {
            if (classList.contains(cls)) {
                return true;
            }
        }
        
        return false;
    }
    // 处理标签点击 - 移动端优化
    function handleTagClick(event) {
        let target = event.target;
        while (target && target !== document) {
            if (isTagLink(target)) {
                event.preventDefault();
                event.stopPropagation();
                // 震动反馈（如果支持）
                if (navigator.vibrate) {
                    navigator.vibrate(30);
                }
                if (currentTag === target) {
                    hidePanel();
                    return;
                }
                showPanel(target);
                return;
            }
            target = target.parentElement;
        }
    }
    // 初始化事件监听 - 移动端优化
    document.addEventListener('click', handleTagClick, true);
    document.addEventListener('touchstart', handleTagClick, { passive: false, capture: true });
    console.log('AO3 标签预览面板脚本已加载 (移动端优化版)');
    // 显示加载成功提示
    const debugInfo = document.createElement('div');
    debugInfo.className = 'ao3-debug';
    debugInfo.textContent = 'AO3标签预览已启用';
    document.body.appendChild(debugInfo);
    // 3秒后隐藏提示
    setTimeout(() => {
        debugInfo.style.display = 'none';
    }, 10);
})();
