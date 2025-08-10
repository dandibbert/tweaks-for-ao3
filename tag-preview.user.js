// ==UserScript==
// @name         AO3 标签预览面板 (优化版)
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  点击AO3标签时显示预览面板，可复制标签内容或在新标签页打开 - 修复滑动误触问题
// @author       Your Name
// @match        https://archiveofourown.org/*
// @grant        GM_addStyle
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    // 配置选项
    const CONFIG = {
        // 选择器配置
        selectors: {
            nonTagElements: ['nav', '.navigation', '.header', '.footer', '.actions', '.dropdown', '.menu', '.pagination', '.breadcrumb', '.home', '.search', '.user'],
            tagContainers: ['.tags', '.warnings', '.categories', '.fandoms', '.relationships', '.characters', '.freeforms', '.work .meta .tags', '.work .meta .warnings', '.work .meta .categories', '.work .meta .fandom', '.work .meta .relationships', '.work .meta .characters', '.work .meta .freeforms', '.tag-set', '.tag-wrapper'],
            tagClasses: ['tag', 'tags', 'warning', 'category', 'rating', 'relationship', 'character', 'freeform', 'fandom']
        },
        // 性能配置
        performance: {
            debounceTime: 150,
            maxCacheSize: 100
        },
        // 用户体验配置
        ui: {
            animationDuration: 250,
            copyHintDuration: 2000,
            debugInfoDuration: 3000,
            vibrationDuration: 30,
            swipeThreshold: 10
        },
        // 面板样式配置
        panel: {
            width: '85%',
            maxWidth: '360px',
            minWidth: '280px',
            zIndex: 2147483647
        }
    };

    // 状态管理
    const state = {
        currentTag: null,
        scrollPosition: 0,
        isScrolling: false,
        touchStartX: 0,
        touchStartY: 0,
        cache: new Map(),
        isInitialized: false
    };

    // 工具函数
    const utils = {
        // 防抖函数
        debounce(func, wait) {
            let timeout;
            return function executedFunction(...args) {
                const later = () => {
                    clearTimeout(timeout);
                    func(...args);
                };
                clearTimeout(timeout);
                timeout = setTimeout(later, wait);
            };
        },

        // 检测 API 支持
        supportsAPI(apiName) {
            switch (apiName) {
                case 'clipboard':
                    return typeof navigator !== 'undefined' && navigator.clipboard;
                case 'vibration':
                    return typeof navigator !== 'undefined' && navigator.vibrate;
                case 'touch':
                    return 'ontouchstart' in window;
                default:
                    return false;
            }
        },

        // 安全的 DOM 操作
        safeRemove(element) {
            if (element && element.parentNode) {
                element.parentNode.removeChild(element);
            }
        },

        // 缓存管理
        setCache(key, value) {
            if (state.cache.size >= CONFIG.performance.maxCacheSize) {
                const firstKey = state.cache.keys().next().value;
                state.cache.delete(firstKey);
            }
            state.cache.set(key, value);
        },

        getCache(key) {
            return state.cache.get(key);
        }
    };

    // 样式管理
    const styles = {
        // 注入 CSS 样式
        inject() {
            const css = `
                .ao3-tag-panel {
                    position: fixed !important;
                    background: #ffffff !important;
                    border: 1px solid #e0e0e0 !important;
                    border-radius: 12px !important;
                    padding: 20px !important;
                    box-shadow: 0 4px 20px rgba(0,0,0,0.08) !important;
                    z-index: ${CONFIG.panel.zIndex} !important;
                    width: ${CONFIG.panel.width} !important;
                    max-width: ${CONFIG.panel.maxWidth} !important;
                    min-width: ${CONFIG.panel.minWidth} !important;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif !important;
                    display: none !important;
                    top: 50% !important;
                    left: 50% !important;
                    transform: translate(-50%, -50%) scale(0.95) !important;
                    margin: 0 !important;
                    box-sizing: border-box !important;
                    -webkit-box-sizing: border-box !important;
                    opacity: 0 !important;
                    transition: all ${CONFIG.ui.animationDuration}ms cubic-bezier(0.4, 0, 0.2, 1) !important;
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
                .ao3-overlay {
                    position: fixed !important;
                    top: 0 !important;
                    left: 0 !important;
                    width: 100% !important;
                    height: 100% !important;
                    background: rgba(0,0,0,0.3) !important;
                    z-index: ${CONFIG.panel.zIndex - 1} !important;
                    display: none !important;
                    -webkit-tap-highlight-color: transparent !important;
                }
                .ao3-overlay.show {
                    display: block !important;
                }
                .ao3-debug {
                    position: fixed !important;
                    bottom: 20px !important;
                    right: 20px !important;
                    background: rgba(0,0,0,0.75) !important;
                    color: white !important;
                    padding: 10px 16px !important;
                    border-radius: 8px !important;
                    font-size: 13px !important;
                    z-index: ${CONFIG.panel.zIndex - 2} !important;
                    max-width: 300px !important;
                    word-wrap: break-word !important;
                    line-height: 1.4 !important;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.2) !important;
                }
            `;
            GM_addStyle(css);
        }
    };

    // 面板管理
    const panel = {
        elements: {},
        
        // 创建面板元素
        create() {
            const overlay = document.createElement('div');
            overlay.className = 'ao3-overlay';
            overlay.id = 'ao3-overlay-unique';
            
            const panelElement = document.createElement('div');
            panelElement.className = 'ao3-tag-panel';
            panelElement.id = 'ao3-tag-panel-unique';
            
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
            panelElement.appendChild(tagContent);
            panelElement.appendChild(buttonGroup);
            panelElement.appendChild(copyHint);
            
            document.body.appendChild(overlay);
            document.body.appendChild(panelElement);
            
            this.elements = {
                panel: panelElement,
                overlay,
                tagContent,
                copyBtn,
                openBtn,
                copyHint
            };
            
            return this.elements;
        },
        
        // 显示面板
        show(tagElement) {
            state.currentTag = tagElement;
            const tagText = tagElement.textContent.trim();
            const tagLink = tagElement.href;
            
            // 保存当前滚动位置
            state.scrollPosition = window.pageYOffset || document.documentElement.scrollTop;
            
            // 设置内容
            this.elements.tagContent.textContent = tagText;
            
            // 更新按钮事件
            this.elements.copyBtn.onclick = () => clipboard.copy(tagText);
            this.elements.openBtn.onclick = () => {
                window.open(tagLink, '_blank');
                this.hide();
            };
            
            // 设置遮罩层点击关闭
            this.elements.overlay.onclick = () => this.hide();
            
            // 显示遮罩层和面板
            this.elements.overlay.style.display = 'block';
            this.elements.overlay.classList.add('show');
            this.elements.panel.style.display = 'block';
            this.elements.panel.classList.add('show');
            
            // 阻止页面滚动
            this.disableScroll();
            
            // 震动反馈
            if (utils.supportsAPI('vibration')) {
                navigator.vibrate(CONFIG.ui.vibrationDuration);
            }
        },
        
        // 隐藏面板
        hide() {
            this.elements.panel.style.display = 'none';
            this.elements.panel.classList.remove('show');
            this.elements.overlay.style.display = 'none';
            this.elements.overlay.classList.remove('show');
            this.elements.copyHint.classList.remove('show');
            
            state.currentTag = null;
            
            // 恢复页面滚动
            this.enableScroll();
        },
        
        // 禁用滚动
        disableScroll() {
            document.body.style.overflow = 'hidden';
            document.body.style.position = 'fixed';
            document.body.style.top = `-${state.scrollPosition}px`;
            document.body.style.width = '100%';
        },
        
        // 启用滚动
        enableScroll() {
            document.body.style.overflow = '';
            document.body.style.position = '';
            document.body.style.width = '';
            document.body.style.top = '';
            window.scrollTo(0, state.scrollPosition);
        },
        
        // 切换面板显示状态
        toggle(tagElement) {
            if (state.currentTag === tagElement) {
                this.hide();
            } else {
                this.show(tagElement);
            }
        }
    };

    // 剪贴板操作
    const clipboard = {
        // 复制到剪贴板
        async copy(text) {
            try {
                if (utils.supportsAPI('clipboard')) {
                    await navigator.clipboard.writeText(text);
                } else {
                    this.fallbackCopy(text);
                }
                this.showCopyHint();
            } catch (err) {
                console.error('复制失败:', err);
                this.fallbackCopy(text);
            }
        },
        
        // 降级复制方案
        fallbackCopy(text) {
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
            textArea.style.zIndex = CONFIG.panel.zIndex;
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            
            try {
                document.execCommand('copy');
                this.showCopyHint();
            } catch (e) {
                console.error('降级复制失败:', e);
            }
            
            utils.safeRemove(textArea);
        },
        
        // 显示复制提示
        showCopyHint() {
            panel.elements.copyHint.classList.add('show');
            setTimeout(() => {
                panel.elements.copyHint.classList.remove('show');
            }, CONFIG.ui.copyHintDuration);
        }
    };

    // 标签识别
    const tagRecognizer = {
        // 优化的标签链接识别
        isTagLink(element) {
            if (!element || !element.href || element.tagName !== 'A') return false;
            
            const href = element.href;
            const classList = element.classList;
            const linkText = element.textContent.trim().toLowerCase();
            
            // 使用缓存
            const cacheKey = `${href}_${linkText}`;
            const cached = utils.getCache(cacheKey);
            if (cached !== undefined) return cached;
            
            // 快速排除非标签链接
            if (this.isNonTagLink(element, linkText)) {
                utils.setCache(cacheKey, false);
                return false;
            }
            
            // 检查是否是标签链接
            const isTag = this.checkTagLink(href, classList, element);
            utils.setCache(cacheKey, isTag);
            return isTag;
        },
        
        // 快速排除非标签链接
        isNonTagLink(element, linkText) {
            // 排除分页文本
            const paginationTexts = ['next', 'previous', 'last', 'first', '»', '«', '‹', '›'];
            if (paginationTexts.some(text => linkText.includes(text)) || /^\d+$/.test(linkText)) {
                return true;
            }
            
            // 排除导航元素
            for (const selector of CONFIG.selectors.nonTagElements) {
                if (element.closest(selector)) {
                    return true;
                }
            }
            
            return false;
        },
        
        // 检查标签链接
        checkTagLink(href, classList, element) {
            // 检查标签页链接
            if (href.includes('/tags/') && !href.includes('/works?')) {
                return !href.includes('/tags/search') && 
                       !href.includes('/tags/feed') && 
                       !href.includes('/tags/new');
            }
            
            // 检查作品筛选链接
            if (href.includes('/works?')) {
                if (href.includes('page=') || href.includes('show=')) return false;
                
                const hasTagParam = href.includes('tag_id=') ||
                                   href.includes('work_search%5Btag_ids%5D%5B%5D=') ||
                                   href.includes('work_search%5Bfreeform_ids%5D%5B%5D=') ||
                                   href.includes('work_search%5Bcharacter_ids%5D%5B%5D=') ||
                                   href.includes('work_search%5Brelationship_ids%5D%5B%5D=') ||
                                   href.includes('work_search%5Bfandom_ids%5D%5B%5D=');
                
                const hasNonTagParam = href.includes('sort_column=') ||
                                      href.includes('sort_direction=') ||
                                      href.includes('query=') ||
                                      href.includes('work_search%5Bquery%5D=');
                
                return hasTagParam && !hasNonTagParam;
            }
            
            // 检查标签容器
            for (const selector of CONFIG.selectors.tagContainers) {
                if (element.closest(selector)) {
                    return true;
                }
            }
            
            // 检查元素类名
            for (const cls of CONFIG.selectors.tagClasses) {
                if (classList.contains(cls)) {
                    return true;
                }
            }
            
            return false;
        }
    };

    // 事件处理
    const eventHandler = {
        // 触摸开始
        handleTouchStart(event) {
            const touch = event.touches[0];
            state.touchStartX = touch.clientX;
            state.touchStartY = touch.clientY;
            state.isScrolling = false;
        },
        
        // 触摸移动
        handleTouchMove(event) {
            const touch = event.touches[0];
            const deltaX = Math.abs(touch.clientX - state.touchStartX);
            const deltaY = Math.abs(touch.clientY - state.touchStartY);
            
            // 如果移动距离超过阈值，认为是滑动
            if (deltaX > CONFIG.ui.swipeThreshold || deltaY > CONFIG.ui.swipeThreshold) {
                state.isScrolling = true;
            }
        },
        
        // 处理点击事件
        handleClick(event) {
            // 如果是滑动状态，不处理点击
            if (state.isScrolling) {
                state.isScrolling = false;
                return;
            }
            
            let target = event.target;
            while (target && target !== document) {
                if (tagRecognizer.isTagLink(target)) {
                    event.preventDefault();
                    event.stopPropagation();
                    panel.toggle(target);
                    return;
                }
                target = target.parentElement;
            }
        },
        
        // 初始化事件监听
        init() {
            // 使用事件委托
            document.addEventListener('click', this.handleClick, true);
            
            // 添加触摸事件监听（用于检测滑动）
            if (utils.supportsAPI('touch')) {
                document.addEventListener('touchstart', this.handleTouchStart, { passive: true });
                document.addEventListener('touchmove', this.handleTouchMove, { passive: true });
                document.addEventListener('touchend', this.handleClick, { passive: false, capture: true });
            }
            
            // 添加键盘事件
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && state.currentTag) {
                    panel.hide();
                }
            });
        },
        
        // 清理事件监听
        destroy() {
            document.removeEventListener('click', this.handleClick, true);
            document.removeEventListener('touchstart', this.handleTouchStart);
            document.removeEventListener('touchmove', this.handleTouchMove);
            document.removeEventListener('touchend', this.handleClick);
        }
    };

    // 调试信息
    const debug = {
        show(message) {
            const debugInfo = document.createElement('div');
            debugInfo.className = 'ao3-debug';
            debugInfo.textContent = message;
            document.body.appendChild(debugInfo);
            
            setTimeout(() => {
                utils.safeRemove(debugInfo);
            }, CONFIG.ui.debugInfoDuration);
        }
    };

    // 初始化
    function init() {
        if (state.isInitialized) return;
        
        try {
            // 注入样式
            styles.inject();
            
            // 创建面板
            panel.create();
            
            // 设置遮罩层点击关闭
            panel.elements.overlay.onclick = () => panel.hide();
            
            // 初始化事件监听
            eventHandler.init();
            
            // 显示调试信息
            debug.show('AO3标签预览已启用 (优化版)');
            
            state.isInitialized = true;
            console.log('AO3 标签预览面板脚本已加载 (优化版)');
        } catch (error) {
            console.error('初始化失败:', error);
        }
    }

    // 清理函数
    function destroy() {
        if (!state.isInitialized) return;
        
        try {
            // 清理事件监听
            eventHandler.destroy();
            
            // 清理DOM元素
            Object.values(panel.elements).forEach(element => {
                utils.safeRemove(element);
            });
            
            // 清理缓存
            state.cache.clear();
            
            state.isInitialized = false;
            console.log('AO3 标签预览面板脚本已清理');
        } catch (error) {
            console.error('清理失败:', error);
        }
    }

    // 页面卸载时清理
    window.addEventListener('beforeunload', destroy);

    // 启动脚本
    init();

})();
