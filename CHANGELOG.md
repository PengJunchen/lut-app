# 更新日志

本文件记录面向社区的版本变更。项目源码中的历史开发版本号不代表已公开发行版本；公开 RC 使用下方 `0.0.1-rc.0` 记录。

## 未发布 / Unreleased

- 页面支持中文与 English 即时切换，覆盖分步和经典模式、预览、进度、资源清单与已知诊断；有效预览与当前批次不会因语言切换重置。
- Electron 记住本机语言偏好，并同步原生菜单、窗口标题、目录选择和报告导出提示。浏览器模式使用当前来源的本地语言偏好。
- 新增 [English README](README.en.md) 和[本地化维护说明](docs/LOCALIZATION.md)，与中文文档保持能力、下载版本和许可边界一致。

These changes are available in source builds. The published `rc0.0.1` packages still use the Chinese interface; the release tag and downloads have not been replaced.

## [0.0.1-rc.0] — 2026-10-08 — 首个公开候选版本

Git tag：`rc0.0.1`。GitHub Release 显示标题：`DJI LUT 0.0.1-rc.0`。

### 新增

- 提供 Go 媒体处理引擎、Go 本机浏览器界面和 Electron 桌面入口。
- 扫描素材并生成逐文件计划；对具有匹配 DJI 相机和 Log 元数据的素材套用 Standard 或 Vivid 官方 LUT。
- 为 Normal/Rec.709、可识别 HDR、未知或未匹配素材提供原样复制与待核查标记。
- 公开带来源、版本、格式和 SHA-256 信息的 LUT 资产清单及官方页面核查记录。
- 提供分步页面、前进与返回、经典模式切换，以及按需打开的 LUT 浏览清单。
- 提供 macOS Apple Silicon、macOS Intel 和 Windows x64 桌面发行目标。
- 增加 PR/主分支本机构建验证与 tag 发布流程，附带下载包校验和和公开构建元数据。

### 覆盖范围说明

当前审计记录包括 44 个 DJI 官方 LUT 详情页，其中 4 个旧页面已被更新版本替代；`library.json` 中有 58 条资产记录，对应 40 个唯一 LUT 文件；自动转换表有 44 条精确机型、Log profile 和风格映射。这些范围不表示所有 DJI 机型都已支持自动识别或经过实机验证。非自动还原用途的 HLG、创意、sRGB、Linear LUT 仅供浏览；扩展名也不保证文件能解码或自动处理。

### 许可提示

MIT 许可仅适用于项目原创源码。DJI LUT 文件的再分发许可尚未确认；FFmpeg、Electron/Chromium 和其他第三方材料遵循各自许可。详情见 [`THIRD_PARTY.md`](THIRD_PARTY.md)。
