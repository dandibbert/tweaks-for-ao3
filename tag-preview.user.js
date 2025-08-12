// ==UserScript==
// @name         AO3 标签预览面板 (优化版) - 防滑动误触
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  点击AO3标签时显示预览面板，可复制标签内容或在新标签页打开 - 彻底修复滑动误触/幽灵点击
// @author       Your Name
// @match        https://archiveofourown.org/*
// @grant        GM_addStyle
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    // 配置选项
    const CONFIG = {
        selectors: {
            nonTagElements: ['nav', '.navigation', '.header', '.footer', '.actions', '.dropdown', '.menu', '.pagination', '.breadcrumb', '.home', '.search', '.user'],
            tagContainers: ['.tags', '.warnings', '.categories', '.fandoms', '.relationships', '.characters', '.freeforms', '.work .meta .tags', '.work .meta .warnings', '.work .meta .categories', '.work .meta .fandom', '.work .meta .relationships', '.work .meta .characters', '.work .meta .freeforms', '.tag-set', '.tag-wrapper'],
            tagClasses: ['tag', 'tags', 'warning', 'category', 'rating', 'relationship', 'character', 'freeform', 'fandom']
        },
        performance: {
            debounceTime: 150,
            maxCacheSize: 100
        },
        ui: {
            animationDuration: 250,
            copyHintDuration: 2000,
            debugInfoDuration: 3000,
            vibrationDuration: 30,
            swipeThreshold: 10,        // 触点移动阈值(px)
            scrollThreshold: 8,        // 页面滚动阈值(px)
            maxTapDuration: 300        // 最大一次“点按”时长(ms)
        },
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
        isInitialized: false,

        // 触摸手势状态
        touchStartX: 0,
        touchStartY: 0,
        touchStartTime: 0,
        scrollStartY: 0,
        moved: false,
        ignoreClickUntil: 0, // 用于屏蔽幽灵点击
        cache: new Map()
    };

    // 工具函数
    const utils = {
        supportsAPI(apiName) {
            switch (apiName) {
                case 'clipboard': return typeof navigator !== 'undefined' && navigator.clipboard;
                case 'vibration': return typeof navigator !== 'undefined' && navigator.vibrate;
                case 'touch':     return 'ontouchstart' in window || (navigator && navigator.maxTouchPoints > 0);
                default:          return false;
            }
        },
        safeRemove(el) {
            if (el && el.parentNode) el.parentNode.removeChild(el);
        },
        setCache(key, value) {
            if (state.cache.size >= CONFIG.performance.maxCacheSize) {
                const firstKey = state.cache.keys().next().value;
                state.cache.delete(firstKey);
            }
            state.cache.set(key, value);
        },
        getCache(key) { return state.cache.get(key); }
    };

    // 样式
    const styles = {
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
                    box-sizing: border-box !important;
                    opacity: 0 !important;
                    transition: all ${CONFIG.ui.animationDuration}ms cubic-bezier(0.4, 0, 0.2, 1) !important;
                }
                .ao3-tag-panel.show { display: block !important; opacity: 1 !important; transform: translate(-50%, -50%) scale(1) !important; }
                .ao3-tag-panel .tag-content {
                    background: #f8f9fa !important;
                    border: 1px solid #e9ecef !important;
                    border-radius: 8px !important;
                    padding: 16px !important;
                    margin-bottom: 16px !important;
                    word-wrap: break-word !important;
                    font-size: 15px !important;
                    line-height: 1.5 !important;
                    color: #333 !important;
                    user-select: text !important;
                }
                .ao3-tag-panel .tag-content::before {
                    content: "标签内容" !important;
                    display: block !important;
                    font-weight: 500 !important;
                    color: #666 !important;
                    margin-bottom: 8px !important;
                    font-size: 12px !important;
                    text-transform: uppercase !important;
                    letter-spacing: 0.5px !important;
                }
                .ao3-tag-panel .button-group { display: flex !important; gap: 10px !important; margin-top: 4px !important; }
                .ao3-tag-panel button {
                    flex: 1 !important; padding: 11px 16px !important; border: none !important; border-radius: 8px !important;
                    cursor: pointer !important; font-size: 14px !important; font-weight: 500 !important; transition: all 0.15s ease !important;
                    -webkit-tap-highlight-color: rgba(0,0,0,0.1) !important; touch-action: manipulation !important; min-height: 40px !important;
                    display: flex !important; align-items: center !important; justify-content: center !important;
                }
                .ao3-tag-panel .copy-btn { background: #4a90e2 !important; color: #fff !important; }
                .ao3-tag-panel .copy-btn:active { background: #357abd !important; transform: scale(0.98) !important; }
                .ao3-tag-panel .open-btn { background: #7b68ee !important; color: #fff !important; }
                .ao3-tag-panel .open-btn:active { background: #6456d4 !important; transform: scale(0.98) !important; }
                .ao3-tag-panel .copy-hint {
                    text-align: center !important; color: #4a90e2 !important; font-size: 13px !important; margin-top: 12px !important;
                    opacity: 0 !important; transition: opacity 0.3s ease !important; padding: 6px 10px !important; background: #e8f0fe !important;
                    border-radius: 4px !important; font-weight: 500 !important;
                }
                .ao3-tag-panel .copy-hint.show { opacity: 1 !important; }
                .ao3-overlay {
                    position: fixed !important; inset: 0 !important; background: rgba(0,0,0,0.3) !important;
                    z-index: ${CONFIG.panel.zIndex - 1} !important; display: none !important; -webkit-tap-highlight-color: transparent !important;
                }
                .ao3-overlay.show { display: block !important; }
                .ao3-debug {
                    position: fixed !important; bottom: 20px !important; right: 20px !important; background: rgba(0,0,0,0.75) !important;
                    color: #fff !important; padding: 10px 16px !important; border-radius: 8px !important; font-size: 13px !important;
                    z-index: ${CONFIG.panel.zIndex - 2} !important; max-width: 300px !important; word-wrap: break-word !important; line-height: 1.4 !important;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.2) !important;
                }
            `;
            GM_addStyle(css);
        }
    };

    // 面板管理
    const panel = {
        elements: {},
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

            this.elements = { panel: panelElement, overlay, tagContent, copyBtn, openBtn, copyHint };
            return this.elements;
        },
        show(tagElement) {
            state.currentTag = tagElement;
            const tagText = tagElement.textContent.trim();
            const tagLink = tagElement.href;

            state.scrollPosition = window.pageYOffset || document.documentElement.scrollTop;

            this.elements.tagContent.textContent = tagText;
            this.elements.copyBtn.onclick = () => clipboard.copy(tagText);
            this.elements.openBtn.onclick = () => { window.open(tagLink, '_blank'); this.hide(); };
            this.elements.overlay.onclick = () => this.hide();

            this.elements.overlay.classList.add('show');
            this.elements.panel.classList.add('show');

            document.body.style.overflow = 'hidden';
            document.body.style.position = 'fixed';
            document.body.style.top = `-${state.scrollPosition}px`;
            document.body.style.width = '100%';

            if (utils.supportsAPI('vibration')) navigator.vibrate(CONFIG.ui.vibrationDuration);
        },
        hide() {
            this.elements.panel.classList.remove('show');
            this.elements.overlay.classList.remove('show');

            state.currentTag = null;

            document.body.style.overflow = '';
            document.body.style.position = '';
            document.body.style.width = '';
            const y = state.scrollPosition || 0;
            document.body.style.top = '';
            window.scrollTo(0, y);
        }
    };

    // 剪贴板
    const clipboard = {
        async copy(text) {
            try {
                if (utils.supportsAPI('clipboard')) {
                    await navigator.clipboard.writeText(text);
                } else {
                    this.fallbackCopy(text);
                }
                this.showCopyHint();
            } catch (e) {
                this.fallbackCopy(text);
            }
        },
        fallbackCopy(text) {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.left = '0';
            ta.style.top = '0';
            ta.style.width = '1px';
            ta.style.height = '1px';
            ta.style.opacity = '0';
            ta.style.zIndex = CONFIG.panel.zIndex;
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            try { document.execCommand('copy'); } catch {}
            utils.safeRemove(ta);
            this.showCopyHint();
        },
        showCopyHint() {
            panel.elements.copyHint.classList.add('show');
            setTimeout(() => panel.elements.copyHint.classList.remove('show'), CONFIG.ui.copyHintDuration);
        }
    };

    // 标签识别
    const tagRecognizer = {
        isTagLink(element) {
            if (!element || element.tagName !== 'A' || !element.href) return false;

            const href = element.href;
            const classList = element.classList;
            const linkText = element.textContent.trim().toLowerCase();

            const cacheKey = `${href}_${linkText}`;
            const cached = utils.getCache(cacheKey);
            if (cached !== undefined) return cached;

            if (this.isNonTagLink(element, linkText)) {
                utils.setCache(cacheKey, false);
                return false;
            }

            const isTag = this.checkTagLink(href, classList, element);
            utils.setCache(cacheKey, isTag);
            return isTag;
        },
        isNonTagLink(element, linkText) {
            const paginationTexts = ['next', 'previous', 'last', 'first', '»', '«', '‹', '›'];
            if (paginationTexts.some(t => linkText.includes(t)) || /^\d+$/.test(linkText)) return true;
            for (const selector of CONFIG.selectors.nonTagElements) {
                if (element.closest(selector)) return true;
            }
            return false;
        },
        checkTagLink(href, classList, element) {
            if (href.includes('/tags/') && !href.includes('/works?')) {
                return !href.includes('/tags/search') && !href.includes('/tags/feed') && !href.includes('/tags/new');
            }
            if (href.includes('/works?')) {
                if (href.includes('page=') || href.includes('show=')) return false;
                const hasTagParam =
                    href.includes('tag_id=') ||
                    href.includes('work_search%5Btag_ids%5D%5B%5D=') ||
                    href.includes('work_search%5Bfreeform_ids%5D%5B%5D=') ||
                    href.includes('work_search%5Bcharacter_ids%5D%5B%5D=') ||
                    href.includes('work_search%5Brelationship_ids%5D%5B%5D=') ||
                    href.includes('work_search%5Bfandom_ids%5D%5B%5D=');
                const hasNonTagParam =
                    href.includes('sort_column=') ||
                    href.includes('sort_direction=') ||
                    href.includes('query=') ||
                    href.includes('work_search%5Bquery%5D=');
                return hasTagParam && !hasNonTagParam;
            }
            for (const selector of CONFIG.selectors.tagContainers) {
                if (element.closest(selector)) return true;
            }
            for (const cls of CONFIG.selectors.tagClasses) {
                if (classList.contains(cls)) return true;
            }
            return false;
        }
    };

    // 统一激活（打开面板）的处理
    function tryActivateFromTarget(target, originalEvent) {
        let el = target;
        while (el && el !== document) {
            if (tagRecognizer.isTagLink(el)) {
                originalEvent && (originalEvent.preventDefault?.(), originalEvent.stopPropagation?.());
                panel.show(el);
                return true;
            }
            el = el.parentElement;
        }
        return false;
    }

    // 事件处理
    const eventHandler = {
        // 鼠标端：只用 click
        handleClick(event) {
            // 若刚经历过一次 touch 交互，短时间内屏蔽 click（幽灵点击）
            if (Date.now() < state.ignoreClickUntil) return;

            tryActivateFromTarget(event.target, event);
        },

        // 触屏端：用 touch 系列判定“点按”
        handleTouchStart(e) {
            const t = e.touches[0];
            state.touchStartX = t.clientX;
            state.touchStartY = t.clientY;
            state.scrollStartY = window.pageYOffset || document.documentElement.scrollTop || 0;
            state.touchStartTime = Date.now();
            state.moved = false;
        },
        handleTouchMove(e) {
            const t = e.touches[0];
            const dx = Math.abs(t.clientX - state.touchStartX);
            const dy = Math.abs(t.clientY - state.touchStartY);
            const dScroll = Math.abs((window.pageYOffset || document.documentElement.scrollTop || 0) - state.scrollStartY);

            if (dx > CONFIG.ui.swipeThreshold || dy > CONFIG.ui.swipeThreshold || dScroll > CONFIG.ui.scrollThreshold) {
                state.moved = true;
            }
        },
        handleTouchEnd(e) {
            // 吃掉随后可能出现的 click
            state.ignoreClickUntil = Date.now() + 400;

            const duration = Date.now() - state.touchStartTime;
            if (state.moved || duration > CONFIG.ui.maxTapDuration) return;

            // 用 changedTouches 拿到抬起位置对应的目标
            const touch = e.changedTouches && e.changedTouches[0];
            const target = (touch && document.elementFromPoint(touch.clientX, touch.clientY)) || e.target;

            tryActivateFromTarget(target, e);
        },

        init() {
            // 事件委托：触屏与非触屏分流
            if (utils.supportsAPI('touch')) {
                // 触屏：只挂 touch，不挂 click（避免重复/幽灵）
                document.addEventListener('touchstart', this.handleTouchStart, { passive: true });
                document.addEventListener('touchmove', this.handleTouchMove, { passive: true });
                document.addEventListener('touchend', this.handleTouchEnd, { passive: false, capture: true });
            } else {
                // 非触屏：使用 click
                document.addEventListener('click', this.handleClick, true);
            }

            // 键盘 ESC 关闭
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && state.currentTag) panel.hide();
            }, true);
        },
        destroy() {
            document.removeEventListener('click', this.handleClick, true);
            document.removeEventListener('touchstart', this.handleTouchStart);
            document.removeEventListener('touchmove', this.handleTouchMove);
            document.removeEventListener('touchend', this.handleTouchEnd);
        }
    };

    // 调试信息
    const debug = {
        show(msg) {
            const node = document.createElement('div');
            node.className = 'ao3-debug';
            node.textContent = msg;
            document.body.appendChild(node);
            setTimeout(() => utils.safeRemove(node), CONFIG.ui.debugInfoDuration);
        }
    };

    // 初始化
    function init() {
        if (state.isInitialized) return;
        try {
            styles.inject();
            panel.create();
            panel.elements.overlay.onclick = () => panel.hide();
            eventHandler.init();
            debug.show('AO3标签预览已启用 (2.1) - 防滑动误触');
            state.isInitialized = true;
            console.log('AO3 标签预览面板脚本已加载 (2.1)');
        } catch (err) {
            console.error('初始化失败:', err);
        }
    }

    function destroy() {
        if (!state.isInitialized) return;
        try {
            eventHandler.destroy();
            Object.values(panel.elements).forEach(utils.safeRemove);
            state.cache.clear();
            state.isInitialized = false;
            console.log('AO3 标签预览面板脚本已清理');
        } catch (err) {
            console.error('清理失败:', err);
        }
    }

    window.addEventListener('beforeunload', destroy);
    init();
})();
