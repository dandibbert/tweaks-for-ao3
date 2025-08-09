// ==UserScript==
// @name         通用悬浮导航脚本 (AO3特别适配, Shadow DOM 版)
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  一个在所有网站都能用的悬浮导航面板。提供回到顶部、前往底部功能，并能智能查找下一页/章链接。在AO3上做特别优化。使用 Shadow DOM 隔离样式，避免被站点 CSS 污染。
// @author       You & Gemini & ChatGPT
// @match        *://*/*
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  /** ------------------------------
   *  SVG 图标
   * ------------------------------ */
  const upArrowSVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"></path></svg>';
  const downArrowSVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"></path></svg>';
  const nextArrowSVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"></path></svg>';

  /** ------------------------------
   *  创建 Shadow DOM 容器
   * ------------------------------ */
  const host = document.createElement('div'); // 挂在 body 下的宿主
  const shadow = host.attachShadow({ mode: 'open' });

  /** ------------------------------
   *  Shadow 内样式（防御性重置 + 你的视觉样式）
   *  关键点：
   *   - 完全不依赖站点全局 CSS
   *   - 锁定 1:1 宽高，禁止 padding/行高撑开
   *   - 在移动端避开底部工具栏
   * ------------------------------ */
  const style = document.createElement('style');
  style.textContent = `
    :host {
      all: initial; /* 尽量避免继承外部样式（对宿主） */
    }

    .gm-nav-panel {
      position: fixed;
      right: 12px;
      bottom: 80px; /* 适配移动端，避开浏览器底部工具栏 */
      z-index: 2147483647; /* 极大，避免被遮挡 */
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px; /* 缩小按钮之间的垂直间距 */
      pointer-events: none; /* 面板容器不抢事件，按钮再开启 */
    }

    .gm-nav-button {
      /* ——重置，避免被站点全局样式污染—— */
      all: unset; /* 先清空 button 默认外观 */
      box-sizing: border-box;
      display: inline-flex;
      justify-content: center;
      align-items: center;
      padding: 0;
      margin: 0;
      line-height: 1;
      font-size: 0;              /* 防止行高/字体撑开 */
      -webkit-appearance: none;
      appearance: none;
      cursor: pointer;

      /* ——尺寸与外观—— */
      width: 42px;
      height: 42px;
      aspect-ratio: 1 / 1;       /* 双保险：强制 1:1 */
      border-radius: 50%;
      background-color: rgba(0, 0, 0, 0.55);
      color: #ffffff;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
      transition: transform 0.2s cubic-bezier(0.25, 0.8, 0.25, 1), background-color 0.2s cubic-bezier(0.25, 0.8, 0.25, 1), opacity 0.2s;
      opacity: 0.6;
      flex: 0 0 42px;            /* 在 flex 容器中固定尺寸 */
      pointer-events: auto;      /* 重新打开按钮点击 */
      user-select: none;
      touch-action: manipulation;
    }

    .gm-nav-button:hover {
      background-color: rgba(0, 0, 0, 0.75);
      transform: scale(1.1);
      opacity: 1;
    }

    .gm-nav-button:active {
      transform: scale(1.0);
    }

    .gm-nav-button svg {
      width: 24px;
      height: 24px;
      fill: currentColor;
      pointer-events: none; /* 防止 SVG 抢点击焦点 */
      display: block;       /* 去掉 inline 元素的行高影响 */
    }

    .gm-nav-hidden {
      display: none !important;
    }

    /* 可选：减少动画（无障碍） */
    @media (prefers-reduced-motion: reduce) {
      .gm-nav-button {
        transition: none;
      }
      .gm-nav-button:hover,
      .gm-nav-button:active {
        transform: none;
      }
    }
  `;
  shadow.appendChild(style);

  /** ------------------------------
   *  构建 UI
   * ------------------------------ */
  const navPanel = document.createElement('div');
  navPanel.className = 'gm-nav-panel';

  const upButton = document.createElement('button');
  upButton.className = 'gm-nav-button';
  upButton.title = '回到顶部';
  upButton.innerHTML = upArrowSVG;
  upButton.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  const downButton = document.createElement('button');
  downButton.className = 'gm-nav-button';
  downButton.title = '滚至底部';
  downButton.innerHTML = downArrowSVG;
  downButton.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // 更可靠的页面高度计算
    const pageHeight = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
      document.body.offsetHeight,
      document.documentElement.offsetHeight,
      document.body.clientHeight,
      document.documentElement.clientHeight
    );
    window.scrollTo({ top: pageHeight, behavior: 'smooth' });
  });

  const nextButton = document.createElement('button');
  nextButton.className = 'gm-nav-button';
  nextButton.title = '下一页 / 下一章';
  nextButton.innerHTML = nextArrowSVG;

  navPanel.appendChild(upButton);
  navPanel.appendChild(downButton);
  navPanel.appendChild(nextButton);

  // 将面板放入 Shadow
  shadow.appendChild(navPanel);

  /** ------------------------------
   *  智能查找 “下一页/章” 链接
   *  - AO3 特别适配
   *  - 常见英文/中文关键词兜底
   * ------------------------------ */
  function findNextLink() {
    const hostname = window.location.hostname;
    let nextLink = null;

    if (hostname.includes('archiveofourown.org')) {
      nextLink = document.querySelector('li.chapter.next a, li.next a');
    }

    if (!nextLink) {
      const genericXpaths = [
        '//a[contains(text(),"Next Chapter")]',
        '//a[contains(text(),"下一章")]',
        '//a[contains(text(),"Next Page")]',
        '//a[contains(text(),"下一页")]',
        '//a[contains(text(),"Next →")]',
        '//a[text()="→"]',
        // 宽松：匹配包含 next 的链接文本（大小写不敏感）
        '//a[contains(translate(normalize-space(string(.)), "NEXT", "next"), "next")]'
      ];
      for (const xpath of genericXpaths) {
        const result = document
          .evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
          .singleNodeValue;
        if (result) {
          nextLink = result;
          break;
        }
      }
    }
    return nextLink;
  }

  function setupNextButton() {
    const link = findNextLink();
    if (link) {
      nextButton.classList.remove('gm-nav-hidden');
      nextButton.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        // 优先尝试点击；如果被阻止，回退到跳转
        const href = link.getAttribute('href');
        link.click?.();
        if (href && !href.startsWith('javascript:')) {
          // 当 click 无效时，进行显式跳转（相对/绝对都可）
          window.location.href = href;
        }
      };
    } else {
      nextButton.classList.add('gm-nav-hidden');
      nextButton.onclick = null;
    }
  }

  // 初始设置
  setupNextButton();

  // 可选：当 DOM 变化时重试（比如分页按钮是异步加载的）
  const mo = new MutationObserver(() => setupNextButton());
  mo.observe(document.documentElement, { childList: true, subtree: true });

  /** ------------------------------
   *  将宿主挂到 body（等待就绪更稳）
   * ------------------------------ */
  function appendWhenReady() {
    const append = () => {
      if (!document.body.contains(host)) {
        document.body.appendChild(host);
      }
    };
    if (document.body) append();
    else window.addEventListener('DOMContentLoaded', append, { once: true });
  }

  appendWhenReady();
})();
