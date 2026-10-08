# 界面本地化 / Interface localization

当前源码构建支持中文（`zh-CN`）和 English（`en`）。页面顶部的语言选择器在分步模式和经典模式都可用，切换不会改变目录、风格、有效预览、处理任务或导出报告。已发布的 `rc0.0.1` 下载包仍为中文界面，本次功能尚未发行。

Current source builds support Chinese (`zh-CN`) and English (`en`). The header language selector works in both guided and classic modes. Switching preserves folders, the selected look, a valid preview, the active batch and exported reports. The published `rc0.0.1` downloads still use the Chinese interface; this feature has not been released yet.

## 偏好与失败处理 / Preferences and failures

- Electron 先读取 `userData/preferences.json` 中有效的语言字段；缺失、损坏或不可读时使用系统语言。保存按请求顺序原子替换文件，只记录语言，不记录素材路径。保存失败时界面回到当前原生语言并提示错误。
- Go 浏览器模式使用当前来源的 `localStorage`；没有有效偏好时使用浏览器语言。存储受限时仍可在当前会话切换，来源端口变化后偏好可能不同。
- 文件路径、官方 LUT 标题、机型标识、JSON 报告和外部工具原始诊断保留原值。应用提供的说明和已知诊断可翻译；系统文件列表与系统自带按钮由操作系统决定语言。

- Electron reads a valid language from `userData/preferences.json`, otherwise falling back to the system locale. Writes replace the file atomically in request order and store only the language. A failed save restores the renderer to the current native language and displays an error.
- The Go browser interface uses origin-scoped `localStorage`, then the browser locale. Restricted storage still permits switching for the current session; a different port may have a separate preference.
- Paths, official LUT titles, camera identifiers, JSON reports and raw external diagnostics retain their original values. App descriptions and known diagnostics are translated. The OS controls its own file list and dialog buttons.

## 维护文案 / Maintaining strings

| 文件 / File | 作用 / Responsibility |
| --- | --- |
| `internal/webui/static/i18n.js` | 页面标签、模板、已知错误和识别原因 / Renderer labels, templates, known errors and classification reasons |
| `internal/webui/static/app.js` | 按当前语言重新渲染状态，保留批次与预览有效性 / Rerender state without changing batch or preview validity |
| `internal/webui/static/index.html` | 静态元素的翻译键与可访问性属性 / Static translation keys and accessibility attributes |
| `desktop/lib/native-i18n.cjs` | 窗口、菜单、原生对话框与桌面错误 / Window, menus, native dialogs and desktop errors |
| `desktop/lib/preferences.cjs` | 偏好加载、顺序保存与失败回退 / Preference loading, ordered writes and failure behavior |
| `README.md` / `README.en.md` | 对等说明、互相切换的文档入口 / Equivalent documentation with reciprocal language links |

新增文案时提供两种语言的相同键、占位符与含义，动态字段继续转义。新增后端诊断时补充已知文案映射，未知外部内容显示原始诊断。不要通过翻译修改 LUT 选择、目录内容或报告结构。语言偏好请求不能包含媒体处理配置。

Add matching keys, placeholders and meaning in both languages, and keep dynamic values escaped. When adding backend diagnostics, update the known-message mapping; unknown external diagnostics remain raw. Localization must not change LUT selection, directory contents or report structure. Language preference requests must not carry processing options.

## 验证 / Validation

```sh
npm test
go test ./...
go test -race ./...
```

测试应覆盖字典一致性、偏好读取和保存失败、连续切换的顺序、受限 IPC 来源与请求体，以及切换后预览与批次不重置。手动检查两种语言、两种模式、返回导航、小窗口、处理进度、原生目录和报告对话框，并区分自动化检查与目标系统实机验证。

Cover dictionary parity, preference loading and save failures, consecutive update order, restricted IPC sources and bodies, and preserving preview/batch state across a switch. Manually inspect both languages and modes, back navigation, small windows, progress, native folder and report dialogs. Distinguish automated checks from native platform validation.
