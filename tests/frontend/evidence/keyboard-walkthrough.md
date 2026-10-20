# 键盘与窄屏走查清单

自动化结果（Chrome headless，真实页面）：

- step=初始对象计数 · walls=7 · openings=4 · furniture=7 · rooms=2 · dirty=已保存 · undoDisabled=true · redoDisabled=true
- step=Delete 删除墙体 · walls=6 · openings=3 · furniture=7 · rooms=1 · dirty=未保存 · undoDisabled=false · redoDisabled=true
- step=Ctrl+Z 撤销 · walls=7 · openings=4 · furniture=7 · rooms=2 · dirty=未保存 · undoDisabled=true · redoDisabled=false
- step=Ctrl+Shift+Z 重做 · walls=6 · openings=3 · furniture=7 · rooms=1 · dirty=未保存 · undoDisabled=false · redoDisabled=true
- step=再次 Ctrl+Z 还原 · walls=7 · openings=4 · furniture=7 · rooms=2 · dirty=未保存 · undoDisabled=true · redoDisabled=false
- step=Ctrl+S 保存 · result=已保存
- step=Tab 焦点 · tag=A · text=跳到主要内容 · focusVisible=true · outlineStyle=auto · outlineWidth=1px · outlineColor=rgb(16, 16, 16)
- step=375px 布局 · scrollWidth=375 · clientWidth=375 · shellWidth=351 · sidebarCollapsed=false

人工复核清单：

- [x] Tab 后焦点环可见（:focus-visible；主题控件 3px outline + offset 2px，浏览器默认控件回退为可见 outline）
- [x] 选中墙体后 Delete/Backspace 删除，Ctrl+Z 撤销，Ctrl+Shift+Z / Ctrl+Y 重做
- [x] Ctrl+S 保存；保存中按钮 aria-busy，失败/409 有明确提示
- [x] W/D/N/V 切换工具，Esc 取消选择或关闭对话框
- [x] ? 打开快捷键说明；对话框为原生 <dialog>，焦点可返回
- [x] 2D/3D 标签可点击，3D 画布有 aria-label 计数
- [x] 375px 登录页、有数据列表、空列表、编辑器均无横向溢出（`login-375.png`、`list-375.png`、`list-empty-375.png`、`editor-2d-375.png`）；工具栏自身横向滚动
- [x] 分享页无保存/删除/撤销/重做入口，Esc/键盘不会进入编辑模式

数据来源：`tests/frontend/evidence/keyboard.json`。
