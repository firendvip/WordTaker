# 弦外小猫 — NSIS 安装器自定义（经 package.json build.nsis.include 引入）
#
# electron-builder 会把本文件 !include 在生成脚本的最顶部（早于 MUI2.nsh 与
# assistedInstaller.nsh 的页面插入），因此这里的顶层 !define 会在各 MUI 页面宏
# 展开前生效；customWelcomePage / customPageAfterChangeDir 是 electron-builder
# 在 assistedInstaller.nsh 中提供的钩子。
#
# 注意：CI 的 makensis 带 -WX（警告即错误），本文件为 UTF-8（构建时
# -INPUTCHARSET UTF8），中文可直接书写。

# ---------- 界面配色：小猫头像画风（奶白底 + 深字；黑猫 + 奶黄点缀） ----------
# 作用范围：页眉区、welcome/finish 页背景（MUI2 仅这些区域可安全改色；
# 进度条为系统原生控件不强改）。页眉图 installerHeader.bmp 底色与此一致以无缝衔接。
!define MUI_BGCOLOR "FFF8E8"
!define MUI_TEXTCOLOR "241F1A"

!ifndef BUILD_UNINSTALLER
  # ---------- 完成页：使用提示（仅安装器；卸载器完成页保持默认文案） ----------
  !define MUI_FINISHPAGE_TEXT_LARGE
  !define MUI_FINISHPAGE_TEXT "$(^NameDA) 已经安装到你的电脑。$\r$\n$\r$\n单击$\"左alt$\"唤起小猫进行录音，再次单击$\"左alt$\"结束录音并进行AI润色。"
!endif

# ---------- 欢迎页：assisted 安装器默认没有 welcome 页，插入以展示小猫侧栏图 ----------
!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

# ---------- 安装中页：自定义副标题（提示语音模型较大，需耐心等待） ----------
# customPageAfterChangeDir 恰好插入在 MUI_PAGE_INSTFILES 之前，此处定义的
# MUI_PAGE_CUSTOMFUNCTION_SHOW 会被 INSTFILES 页消费；Show 回调晚于页面 Pre
# 中的默认头文案设置，运行时覆盖对所有安装语言一致生效。
!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW KittyInstFilesShow
  Function KittyInstFilesShow
    !insertmacro MUI_HEADER_TEXT "正在安装" "弦外小猫 正在安装，语音模型较大，请耐心等待..."
  FunctionEnd
!macroend
