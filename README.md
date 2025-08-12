# tweaks-for-ao3
Some tweaks for using AO3 on your iPhone. Safari and Userscripts.
## tag-preview.user.js：AO3 标签预览面板（Tampermonkey 脚本）

这是一个适用于 [Archive of Our Own](https://archiveofourown.org/)（AO3）的 Tampermonkey 用户脚本，点击或长按标签即可在当前页面弹出预览面板，无需跳转。

### 功能特性
- **标签预览面板**：显示标签文本，可直接复制或在新标签页打开。  
- **长按模式可切换**：  
  - 普通模式：点按标签弹出面板。  
  - 仅长按模式：点按标签无任何动作，长按才弹面板。  
- **防滑动误触**：优化触摸事件处理，滑动页面时不会误触发面板。  
- **点击空白关闭**：点击页面空白区域即可关闭面板。  
- **系统菜单拦截**：面板打开期间禁用右键/长按菜单，避免干扰操作。  
- **自定义设置持久化**：长按模式开关状态会保存，下次访问仍然生效。  

### 使用方法
1. 安装 [Tampermonkey](https://www.tampermonkey.net/)。  
2. 在 Tampermonkey 中创建新脚本，粘贴本项目代码保存。  
3. 访问 AO3 页面，脚本将自动生效。  
4. 可通过 Tampermonkey 菜单切换“仅长按模式”。  

### 许可证
[MIT License](LICENSE)
