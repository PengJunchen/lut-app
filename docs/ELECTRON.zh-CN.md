# Electron 桌面版使用与构建

Electron 桌面版在独立窗口中显示现有中文界面，由随包分发的 Go 引擎完成视频识别、LUT 匹配、转码、原样复制和报告生成。FFmpeg、FFprobe 与所需 LUT 会随 Go 引擎一起打包；运行时不需要安装 Go、Python、FFmpeg，也不需要联网。

## 使用桌面版

启动应用后，默认原片目录是应用所在文件夹。把应用放到待处理视频所在目录即可直接扫描；也可以点“选择文件夹”改选目录。开发时默认目录是启动 `npm start` 时所在的工作目录。

界面默认使用分步模式，在同一桌面窗口内切换素材设置、扫描预览、处理与结果。顶部可切换到保留的经典模式；切换模式不会丢失当前设置、预览或任务。文件列表分页，逐文件详情点击查看。LUT 清单默认隐藏，主动打开资源查看入口后才显示。

扫描后可以返回素材设置：没有更改设置时仍可继续原预览；更改目录、风格或子目录选项后必须重新扫描。处理期间配置锁定，取消需等待当前任务停止；结束后的旧任务可回看，开始下一次处理须先开始新批次。桌面初始大小会适应屏幕可用区域。

扫描默认不包含子目录。处理前先预览计划，再开始还原。Normal/Rec.709 和 HDR 素材、无法确认的素材会原样保留；后者会标记待核查。转换结果写入所选输出基础目录的 `Standard/` 或 `Vivid/` 子目录；输出基础目录留空时，结果写入原片目录下的 `Output/`。应用不会覆盖原片。处理结束后可以打开结果目录或导出报告。

macOS 桌面版要求 macOS 13 或更高版本，因为 Electron 44 已停止支持 macOS 12。Windows 包面向 Windows 10 x64。macOS 包使用 ad-hoc 签名，没有 Developer ID 证书，也未公证；Windows 包没有商业代码签名。首次启动时，操作系统可能显示来源提示。

## LUT 清单与格式

“自动还原清单”显示当前可自动匹配的机型、Log 模式、风格和 LUT 版本。“全部官方 LUT”可展开并搜索，查看官方还原、创意、HLG、sRGB、Linear 等 LUT 的版本、格式、输出用途与是否参与自动匹配。非 Rec.709 还原用途只供查看，扫描不会自动套用这些 LUT。

版本按同一机型、输入模式、输出色域和风格比较，只保留最新版本。例如 D-Log V2.0 与 D-Log2 V1.0 用于不同输入，仍会同时保留。清单来自构建时锁定的官方来源，不会在运行时自动更新。来源与版本核对见项目的 `assets/SOURCES.md` 和 `docs/DJI_LUT_RESEARCH.zh-CN.md`。

界面显示可发现的视频扩展名，包括 MOV、MP4、MKV、MXF、传输流和裸 H.264/H.265。扩展名只用于发现文件；实际解码和自动处理仍取决于 FFmpeg 能力及 DJI 元数据。裸 H.264/H.265 缺乏可靠的内嵌时间戳和机型元数据约定，因此原样保留并标记待核查；OSV 全景、球面投影或多路主视频也采用相同保留策略。为复制原音频码流，AAC 等兼容音频使用 MP4，PCM 等音频使用 MKV；视频仍按原始分辨率和帧率输出 10-bit HEVC。

## 从源码启动

需要 Node.js 22.12 或更高版本、Go 1.24 或更高版本和 Python 3.10 或更高版本。Go 常规源码测试不需要下载 FFmpeg 或 LUT 文件。

```sh
npm ci
go test ./...
npm test
```

桌面窗口使用 `desktop/.generated/<平台>/engine` 作为本地 Go 引擎。先准备与本机平台对应的 FFmpeg，再导入所需 LUT 文件，然后构建引擎并启动窗口：

```sh
python3 packaging/prepare_runtime.py darwin-arm64
python3 packaging/prepare_luts.py
npm run build:engine
npm start
```

源码开发首次启动时，Electron 会按本机平台从官方发行源下载对应运行时；发行包已包含 Electron 本体，可离线运行。

把 `darwin-arm64` 替换为 `darwin-amd64` 或 `windows-amd64` 可准备对应平台的运行时。Apple Silicon Mac 上的开发启动应使用 `darwin-arm64`；Intel Mac 使用 `darwin-amd64`。LUT 文件仅需准备一次，脚本按完整 library 中的 SHA-256 校验直接文件或 ZIP 内的指定成员，全部成功后才替换本地 LUT 目录并清除旧版本。可选 --source-dir 导入匹配的已有文件；原目录不会被修改。

## 构建发行包

从源码构建发行包需要先安装锁定版本的 npm 依赖，并准备与目标平台匹配的运行时和 LUT 文件：

```sh
npm ci
python3 packaging/prepare_runtime.py darwin-arm64
python3 packaging/prepare_luts.py
npm run build:desktop -- darwin-arm64
```

不传目标时，`npm run build:desktop` 会构建本机架构；也可以在一次命令中传入多个目标。可选目标和输出文件如下：

| 目标 | 最低系统版本 | 输出文件 |
| --- | --- | --- |
| `darwin-arm64` | macOS 13 | `dist/electron/DJI-LUT-macOS-AppleSilicon.zip` |
| `darwin-amd64` | macOS 13 | `dist/electron/DJI-LUT-macOS-Intel.zip` |
| `windows-amd64` | Windows 10 x64 | `dist/electron/DJI-LUT-Windows-x64.zip` |

构建脚本复用 [`packaging/build.py`](../packaging/build.py) 的运行时归档、LUT 校验和第三方许可证复制逻辑，并以 `bundled` 标签编译 Go 引擎。Electron、Chromium、Go 与 FFmpeg 的许可证文本会放进发行包的 `licenses/` 目录；项目和素材的许可边界见 [`THIRD_PARTY.md`](../THIRD_PARTY.md)。DJI LUT 的再分发授权目前未确认，制作本地包并不代表可以公开分发其中的 LUT 文件。

只需启动 Electron 开发窗口时，可使用 `npm run build:engine -- <target>` 只构建 Go sidecar，无需运行 electron-builder。Windows 交叉构建在没有 Wine 的机器上会关闭 electron-builder 的 Windows 可执行文件签名与资源编辑步骤。交叉构建结果不等同于在目标操作系统上的实际运行验证。所有发行包和 sidecar 中间文件均写入被 Git 忽略的 `dist/electron/` 与 `desktop/.generated/`。

## 构建依赖说明

截至 2026-10-03，npm 报告 electron-builder 的构建期依赖链包含 [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)。该依赖只用于构建，不随应用发行；应用本身没有配置共享 HTTP 缓存。当前没有可用的修复版本，因此保留锁定版本，不通过强制降级或覆盖依赖规避；更新构建依赖时应重新检查该公告。
