# DJI LUT

DJI LUT 是一个本地运行的视频色彩还原工具，根据 DJI 视频元数据选择匹配的官方 LUT，并把处理结果保存为独立文件。

An offline tool for exploring DJI's official LUT catalog and restoring supported DJI Log footage.

项目面向 **DJI 全系列官方 LUT** 建立目录并逐步扩展转换覆盖；当前版本只会自动处理 `assets/catalog.json` 中已有精确机型、Log 模式与风格映射的素材。这里的“面向全系列”不表示所有 DJI 相机都已支持自动识别或完成实机验证。

[RC 下载页](https://github.com/PengJunchen/lut-app/releases/tag/rc0.0.1) · [使用说明](docs/USAGE.zh-CN.md) · [技术架构](docs/ARCHITECTURE.zh-CN.md) · [贡献指南](CONTRIBUTING.md)

## 当前覆盖范围

截至 2026-10-08，官方目录核查记录了 44 个 DJI LUT 详情页，其中 4 个旧页面已被后续版本替代。`assets/library.json` 保留 58 条来源与机型资产记录；相同内容按 SHA-256 去重后对应 40 个 `.cube` 文件。`assets/catalog.json` 另有 44 条精确的机型、Log 模式和风格自动映射。这些数字分别表示详情页、目录记录、实际 LUT 文件和自动映射，不能互相替代。来源与版本细节见 [官方 LUT 核查记录](docs/DJI_LUT_RESEARCH.zh-CN.md) 和 [资产来源清单](assets/SOURCES.md)。

自动转换要求程序能从媒体元数据识别受支持的 DJI 相机，并在 `com.dji.camera.ColorGammaSxS` 字段中识别 D-Log、D-Log2 或 D-Log M；之后还必须找到对应的机型、输入模式和所选风格映射。机型或 Gamma 元数据缺失、冲突、无法识别，或没有精确 LUT 映射时，程序不会猜测或回退到相近型号。

| 情况 | 当前行为 |
| --- | --- |
| 元数据可识别且存在匹配的 D-Log / D-Log2 / D-Log M LUT | 按所选 Standard 或 Vivid 风格转换 |
| Normal / Rec.709 或可识别的 HDR（含 HLG）素材 | 原样复制，不套 Log LUT |
| 未知、缺失或相互冲突的机型 / Gamma 信息 | 原样复制并标记待核查 |
| HLG、创意调色、sRGB、Linear 等非自动还原 LUT | 可在 LUT 清单中浏览，不参与自动转换 |

文件扩展名只用于发现候选文件，不代表 FFmpeg 一定能解码、文件一定带有可靠的 DJI 元数据，或该机型一定有自动映射。裸 H.264/H.265、OSV 全景或多路主视频等特殊素材可能会被保留待核查。具体格式和处理行为见[使用说明](docs/USAGE.zh-CN.md)。

## 下载与发布

首个公开 RC 目标版本为 `0.0.1-rc.0`，Git tag 和 GitHub Release 名称为 **`rc0.0.1`**。发布生成后，可从 [rc0.0.1 Release 页面](https://github.com/PengJunchen/lut-app/releases/tag/rc0.0.1) 下载：

| 平台 | 下载 |
| --- | --- |
| macOS Apple Silicon | [DJI-LUT-macOS-AppleSilicon.zip](https://github.com/PengJunchen/lut-app/releases/download/rc0.0.1/DJI-LUT-macOS-AppleSilicon.zip) |
| macOS Intel | [DJI-LUT-macOS-Intel.zip](https://github.com/PengJunchen/lut-app/releases/download/rc0.0.1/DJI-LUT-macOS-Intel.zip) |
| Windows x64 | [DJI-LUT-Windows-x64.zip](https://github.com/PengJunchen/lut-app/releases/download/rc0.0.1/DJI-LUT-Windows-x64.zip) |

发行目标为 macOS 13 或更新版本（Apple Silicon 与 Intel）以及 Windows 10 x64。PR 和 `main` 的自动检查覆盖三种构建目标；推送 `rc*` 或 `v*` tag 会构建三种发行包并附加到 GitHub Release。发布维护者需先在合并到 `main` 的提交中同步应用版本字段，再创建 tag；发布工作流按 tag 校验源码版本，不临时改写版本文件。构建与状态可在 [GitHub Actions](https://github.com/PengJunchen/lut-app/actions) 查看。

桌面包包含 Electron 界面、Go 引擎、FFmpeg、FFprobe 和构建时锁定的 LUT 资源，日常运行不要求另装这些工具，也不需要网络。macOS 包使用 ad-hoc 签名且未公证；Windows 包没有商业代码签名。发行包与本地构建所含第三方材料的许可边界见 [THIRD_PARTY.md](THIRD_PARTY.md)。

## 使用特性

- 在本机扫描文件夹，先查看逐文件处理计划，再启动批次；默认不递归扫描子文件夹。
- 原片不会被覆盖。转换文件写入 `Output/Standard/` 或 `Output/Vivid/`，也可以选择其他输出基础目录。
- 转换视频重新编码为 10-bit HEVC Rec.709，音频码流尽量复制；不需要 LUT 的素材按字节复制。
- 批次结束后可查看或导出 JSON 报告。报告含文件路径、名称和摘要；分享前应先删除个人路径等信息。
- Go 版也可启动本机浏览器界面或使用无界面批处理。Electron 桌面版复用同一 Go 引擎。

## 从源码开始

需要 Go 1.24 或更高版本。普通 Go 源码测试不需要下载 FFmpeg、LUT 或其他运行时文件：

```sh
go test ./...
```

Electron 开发还需要 Node.js 22.12 或更高版本：

```sh
npm ci
npm test
```

完整的运行时准备、LUT 校验和平台打包步骤见[桌面版构建说明](docs/ELECTRON.zh-CN.md)。核心模块与数据之间的关系见[技术架构](docs/ARCHITECTURE.zh-CN.md)；如何提报问题、扩展 LUT 清单和提交修改见[贡献指南](CONTRIBUTING.md)。

## 许可证与项目声明

[`LICENSE`](LICENSE) 中的 MIT 许可适用于项目原创源码，不自动覆盖 DJI LUT、FFmpeg、Electron、Chromium 或发行包中的其他第三方材料。项目目前没有确认 DJI LUT 文件的再分发授权；获取官方公开下载地址不等于取得再分发许可。不要将本项目的 MIT 许可当作 LUT 文件或包含 LUT 的发行包的授权依据，详情见 [THIRD_PARTY.md](THIRD_PARTY.md)。

本项目为社区工具，不是 DJI 官方应用，也未获 DJI 背书。
