# DJI LUT

**中文** | [English](README.en.md)

DJI LUT 是一款离线运行的视频色彩还原工具。它读取 DJI 视频元数据，选择精确匹配的官方 LUT，并把结果保存为新文件。

项目维护 DJI 官方 LUT 目录，并逐步扩展自动转换覆盖。目录面向 DJI 全系列，但自动转换只适用于 `assets/catalog.json` 中已有精确机型、Log 模式和风格映射的素材；目录收录不代表某款相机已获自动支持或完成实机验收。

[rc0.0.1 下载](https://github.com/PengJunchen/lut-app/releases/tag/rc0.0.1) · [使用说明（中文）](docs/USAGE.zh-CN.md) · [技术架构（中文）](docs/ARCHITECTURE.zh-CN.md) · [贡献指南（中文）](CONTRIBUTING.md) · [发布流程（中文）](docs/RELEASING.zh-CN.md)

## 当前覆盖范围

截至 2026-10-08，官方目录核查记录了 44 个 DJI LUT 详情页，其中 4 个旧页面已被后续版本替代。`assets/library.json` 保留 58 条来源与机型资产记录；按 SHA-256 去重后对应 40 个独立 `.cube` 文件。`assets/catalog.json` 另有 44 条精确的机型、Log 模式和风格自动映射。这些数字分别表示详情页、目录记录、实际 LUT 文件和自动映射，不能互相替代。来源与版本细节见[官方 LUT 核查记录（中文）](docs/DJI_LUT_RESEARCH.zh-CN.md)和[资产来源清单（中文）](assets/SOURCES.md)。

自动转换需要从媒体元数据识别受支持的 DJI 相机，并在 `com.dji.camera.ColorGammaSxS` 字段中识别 D-Log、D-Log2 或 D-Log M；之后还必须找到与机型、输入模式和所选风格完全匹配的映射。机型或 Gamma 元数据缺失、冲突、无法识别，或没有精确 LUT 映射时，程序不会猜测或回退到相近型号。

| 素材情况 | 当前行为 |
| --- | --- |
| 相机和 Log 元数据可识别，且存在匹配的 D-Log、D-Log2 或 D-Log M LUT | 按所选 Standard 或 Vivid 风格及精确映射转换 |
| Normal / Rec.709 或可识别的 HDR（含 HLG）素材 | 原样复制，不套用 Log LUT |
| 机型或 Gamma 信息未知、缺失、冲突，或没有精确 LUT 映射 | 原样复制并标记待核查 |
| HLG、创意调色、sRGB、Linear 等非自动还原 LUT | 可在 LUT 清单中浏览，不参与自动转换 |

扫描器按 **38 种文件扩展名**发现候选视频；扩展名只用于发现文件，不表示 FFmpeg 一定能解码，也不表示文件带有可靠的 DJI 元数据、相机已支持或存在匹配 LUT。FFprobe 检查候选文件是否可读取、是否含受支持的视频流；检查通过仍不保证完整解码一定成功。裸 H.264/H.265、OSV 全景或多路主视频等特殊素材可能会被保留待核查。具体格式与处理行为见[使用说明（中文）](docs/USAGE.zh-CN.md)。

## 界面语言

当前源码构建提供简体中文与 English 界面切换。Electron 桌面版将语言选择保存在应用的 `userData` 偏好中；本机浏览器版将选择保存在浏览器的 `localStorage`。浏览器存储按来源（包括本机服务端口）隔离，因此如果服务重启后使用不同端口，之前的语言偏好可能不可用。下方公开的 `0.0.1-rc.0` 安装包早于界面语言改动，仍只有中文界面。

在顶部“语言 / Language”选择中文或 English，两种界面模式和处理期间均可切换。切换保留当前设置、有效预览与处理批次；官方 LUT 名称、文件路径和 JSON 报告保持原值。维护翻译见[本地化说明 / Localization](docs/LOCALIZATION.md)。

## 下载与发布

当前公开 RC 的应用版本为 `0.0.1-rc.0`，Git tag 为 **`rc0.0.1`**，GitHub Release 标题为 `DJI LUT 0.0.1-rc.0`。可在 [rc0.0.1 Release 页面](https://github.com/PengJunchen/lut-app/releases/tag/rc0.0.1)下载：

| 平台 | 下载 |
| --- | --- |
| macOS Apple Silicon | [DJI-LUT-macOS-AppleSilicon.zip](https://github.com/PengJunchen/lut-app/releases/download/rc0.0.1/DJI-LUT-macOS-AppleSilicon.zip) |
| macOS Intel | [DJI-LUT-macOS-Intel.zip](https://github.com/PengJunchen/lut-app/releases/download/rc0.0.1/DJI-LUT-macOS-Intel.zip) |
| Windows x64 | [DJI-LUT-Windows-x64.zip](https://github.com/PengJunchen/lut-app/releases/download/rc0.0.1/DJI-LUT-Windows-x64.zip) |

发行目标为 macOS 13 或更新版本（Apple Silicon 与 Intel）以及 Windows 10 x64。PR 和 `main` 的自动检查在三个目标平台运行原生构建验证；推送 `rc*` 或 `v*` tag 会构建三种发行包并附加到 GitHub Release。维护者须先在合入 `main` 的提交中同步应用版本字段，再创建 tag；发布工作流按 tag 校验源码版本，不临时改写版本文件。构建状态见 [GitHub Actions](https://github.com/PengJunchen/lut-app/actions)。完整步骤见[发布流程（中文）](docs/RELEASING.zh-CN.md)。

PR 和 `main` 构建成功后，在对应 Actions 运行的 Artifacts 中下载 `preview-darwin-arm64`、`preview-darwin-amd64` 或 `preview-windows-amd64`，可试用该提交的界面改动。每个预览归档包含桌面 ZIP 与构建摘要，保留 7 天；下载可能需要登录 GitHub。预览构建不是正式发行版。

桌面包包含 Electron 界面、Go 引擎、FFmpeg、FFprobe 和构建时锁定的 LUT 资源，日常运行无需另装这些工具，也不需要网络。macOS 包使用 ad-hoc 签名且未公证；Windows 包没有商业代码签名。发行包和本地构建中的第三方材料许可边界见[第三方材料说明](THIRD_PARTY.md)。

## 使用方式与处理特性

1. 解压对应平台的安装包，把应用放到素材文件夹旁边后启动。Electron 包打开桌面窗口；轻量 Go 包会在默认浏览器打开本机界面。视频识别和处理在本机完成。
2. 输入素材目录；结果保存基础目录可以留空（默认使用素材目录中的 `Output/`），也可以另选目录。默认不递归扫描子文件夹。
3. 选择 Standard 或 Vivid 风格并扫描预览。开始前可逐文件查看识别结果、计划使用的 LUT 和处理原因；待核查项目会原样复制，并计入保留数量。
4. 启动批次后可查看进度或取消。已完成的结果会保留。结束后可以打开结果目录或导出 JSON 报告；报告可能包含路径、名称和摘要，分享前请检查并移除个人信息。

原片不会被覆盖。需要转换的素材写入 `Output/Standard/` 或 `Output/Vivid/`（也可指定其他结果基础目录）。转换视频重新编码为 10-bit HEVC Rec.709，因此不是逐像素无损；音频码流会尽量复制。如果音频不能封装到 MP4（例如 PCM），结果改用 MKV 以保留音频码流。不需要 LUT 的素材按字节复制。完整操作步骤见[使用说明（中文）](docs/USAGE.zh-CN.md)。

Go 版本也可提供本机浏览器界面或无界面批处理；Electron 桌面版复用相同的 Go 引擎。

## 从源码开始

需要 Go 1.24 或更新版本。普通 Go 源码测试不需要下载 FFmpeg、LUT 或其他运行时文件：

```sh
go test ./...
```

Electron 开发还需要 Node.js 22.12 或更新版本：

```sh
npm ci
npm test
```

完整运行时准备、LUT 校验和平台打包步骤见[Electron 构建说明（中文）](docs/ELECTRON.zh-CN.md)。模块与数据之间的关系见[技术架构（中文）](docs/ARCHITECTURE.zh-CN.md)；如何提报问题、扩展 LUT 清单和提交修改见[贡献指南（中文）](CONTRIBUTING.md)。

## 许可证与项目声明

[`LICENSE`](LICENSE) 中的 MIT 许可适用于项目原创源码，不自动覆盖 DJI LUT、FFmpeg、Electron、Chromium 或发行包中的其他第三方材料。项目尚未确认 DJI LUT 文件的再分发授权；存在官方公开下载地址不等于取得再分发许可。请勿把项目的 MIT 许可当作 LUT 文件或包含 LUT 的发行包的授权依据，详情见[第三方材料说明](THIRD_PARTY.md)。

本项目是社区工具，不是 DJI 官方应用，也未获 DJI 背书。
