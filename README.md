# 网易云桌面音乐悬浮窗

独立的 BetterNCM 插件。Windows 桌面可显示当前歌曲的封面、歌名、歌手、进度以及带翻译的逐字歌词。歌词来自 RefinedNowPlaying。安装了 MaterialYouTheme 时，悬浮窗随歌曲主题换色。

## 安装

1. 在 Windows 10 2004 或更新的 x64 系统上使用网易云音乐 2.10.x、BetterNCM 1.0+ 和 RefinedNowPlaying。系统需有 Microsoft Edge WebView2 Runtime。
2. 从 [GitHub Releases](https://github.com/LilycleHeart/DesktopMusicFloat/releases/latest) 下载 `.plugin`，导入 BetterNCM 或复制到其 `plugins` 目录。自行构建的安装包位于 `dist/`。
3. 重启网易云音乐。悬浮窗会打开。也可以在插件设置里关闭或重新显示。

## 操作

- 拖动封面、歌名或歌手区域移动窗口。点击或拖动底部进度条跳转。
- 鼠标移到波形区域，显示上一首、播放／暂停、下一首、音量图标以及三个窗口开关。移开后恢复波形。
- 指向音量图标时，上方展开网易云主音量滑块。鼠标停在图标或滑块区域时，滚轮向上增大音量，向下减小，每格 5%。
- 启用字体管理器后，歌曲信息和歌词随已应用的字体设置及实时预览更新。
- 词栏默认随窗口在当前屏幕上的位置对齐。右击托盘图标，在「歌词对齐」中也可固定为左对齐或右对齐。
- **吸附隐藏**会将悬浮窗贴到最近的工作区边缘。移出窗口后会收起成短条，鼠标移到短条即可展开。把悬浮窗拖离边缘，可在原地保持展开，并在再次靠近边缘时吸附。
- **置顶**默认打开。**点击穿透**打开后，鼠标可操作窗口后方的应用。按 **Ctrl+Alt+Shift+P**，或在 BetterNCM 的悬浮窗插件设置中点「恢复鼠标操作」，即可关闭穿透并显示悬浮窗。Windows 托盘菜单也可以关闭穿透。悬浮窗启动时会自动关闭穿透。

波形沿用 OBSStreamSuite 的播放状态动画。进度、歌词和控件同步当前网易云播放器。悬浮窗通过本机回环连接和网易云通信，关闭网易云后自动退出。

## 构建

在 Windows x64 上用 Node.js 20+、.NET 8 SDK 和 Windows PowerShell 运行 `npm ci`、`npm run build`。产物包含 .NET 运行时。运行 `npm test` 检查打包后的悬浮窗与本机连接。

歌曲元数据、Material You 色板、波形和逐字歌词渲染移植自 [OBSStreamSuite](https://github.com/LilycleHeart/OBSStreamSuite/tree/4ffb709c3ead7a366c85fca139315fddf108e71a)。源码许可见 `LICENSE` 和 `licenses/`，发布包的 `licenses/` 还包含随附运行时和依赖的许可说明。
