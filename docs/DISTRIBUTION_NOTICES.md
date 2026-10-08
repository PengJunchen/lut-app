# 发行包第三方来源与许可说明

核查日期：2026-10-08。适用于 `packaging/runtime-lock.json` 锁定的 macOS arm64、macOS Intel 与 Windows x64 桌面包。

## 项目许可与 DJI LUT

仓库根目录的 `LICENSE`（MIT）只适用于项目原创源代码，不涵盖随包提供的 DJI `.cube` LUT、FFmpeg/FFprobe、Go、Electron 或 Chromium；这些材料分别适用各自的许可与来源说明。

[DJI 官方下载中心](https://www.dji.com/cn/downloads)及[官方帮助页](https://repair.dji.com/help/content?customId=01700007105&lang=en&paperDocType=ARTICLE&re=US&spaceId=17)用于识别 LUT 资产。[`assets/SOURCES.md`](../assets/SOURCES.md)记录了当前目录和逐项来源。到核查日期为止，没有找到 DJI 对这些 LUT 的第三方再分发明确授权；其再分发权利仍未确认。项目 MIT 许可不应被描述为对这些 LUT 的许可。

## FFmpeg 与 FFprobe

FFmpeg 官方[许可说明](https://ffmpeg.org/legal.html)称核心代码以 LGPL 2.1 或更高版本许可，启用受 GPL 约束的可选部分时 GPL 适用于整个 FFmpeg。下面锁定的构建配置均报告 `--enable-gpl --enable-version3`，包内随附相应的 [FFmpeg GPLv3 文本（8.1.2）](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n8.1.2/COPYING.GPLv3)或[（9.0.2）](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n9.0.2/COPYING.GPLv3)。这些文本来自 FFmpeg 上游，不是项目 MIT 许可的一部分。

| 桌面包 | 锁定供应商构建及来源记录 | 对应的 FFmpeg 上游源码与许可 | 已确认的构建资料边界 |
| --- | --- | --- | --- |
| macOS arm64，9.0.2 | [Martin Riedl 逐构建详情](https://ffmpeg.martin-riedl.de/info/detail/macos/arm64/1789931890_9.0.2)；锁定的 [FFmpeg ZIP](https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip)与 [FFprobe ZIP](https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffprobe.zip)；该构建的[配置与依赖版本](https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/versions.txt) | [FFmpeg 9.0.2 源码压缩包](https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz)、[上游 tag](https://github.com/FFmpeg/FFmpeg/tree/n9.0.2)及[GPLv3 文本](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n9.0.2/COPYING.GPLv3) | `versions.txt`列出准确构建配置与外部依赖版本。供应商公开了[构建脚本仓库](https://git.martin-riedl.de/ffmpeg/build-script)，但未找到能对应该 9.0.2 产物的脚本快照或 commit；完整外部依赖源码包也未确认。 |
| macOS Intel，8.1.2-tessus | [Evermeet FFmpeg ZIP](https://evermeet.cx/ffmpeg/ffmpeg-8.1.2.zip)、[FFprobe ZIP](https://evermeet.cx/ffmpeg/ffprobe-8.1.2.zip)、[FFmpeg 版本信息 API](https://evermeet.cx/ffmpeg/info/ffmpeg/8.1.2)、[FFprobe 版本信息 API](https://evermeet.cx/ffmpeg/info/ffprobe/8.1.2)及供应商[通用构建配置页](https://evermeet.cx/ffmpeg/) | [FFmpeg 8.1.2 源码压缩包](https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz)、[上游 tag](https://github.com/FFmpeg/FFmpeg/tree/n8.1.2)及[GPLv3 文本](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n8.1.2/COPYING.GPLv3) | Evermeet 版本 API 列出该构建的内部与外部库版本及外部源码链接；通用配置页列出 GPL 与 version 3 选项，但不是 8.1.2 专属配置记录。锁定二进制的构建配置含这些选项。未找到 Evermeet 针对该版本发布的构建脚本快照或完整供应商源码包。 |
| Windows x64，8.1.2 | [Gyan Essentials ZIP](https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip)、[供应商 SHA-256](https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip.sha256)、[Gyan 构建页](https://www.gyan.dev/ffmpeg/builds/)及[8.1.2 发布记录](https://github.com/GyanD/codexffmpeg/releases/tag/8.1.2) | [FFmpeg 8.1.2 源码压缩包](https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz)、该发布记录指向的[上游源码 commit](https://github.com/FFmpeg/FFmpeg/commit/38b88335f9)及[GPLv3 文本](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n8.1.2/COPYING.GPLv3) | Gyan 构建页将其构建标为静态 GPLv3 构建，8.1.2 发布记录指向上游 8.1.2 commit。未找到对应的 8.1.2 构建脚本快照或完整外部依赖源码包；构建页当前显示的 9.0.2 commit 不对应此 8.1.2 构建。 |

上游源码链接确认 FFmpeg 核心源码的版本，不代表供应商二进制全部构建输入。上表明确标注了未能从一手资料确认的历史构建脚本、完整依赖源码或版本对应关系。当前应用归档携带许可文本和运行时锁定记录，不含 FFmpeg 源码归档。

### GPLv3 文本在 RC 0.0.1 压缩包中的位置

干净 runner 按 `packaging/license-lock.json` 准备运行时后，三平台包内文件名统一为 `COPYING.GPLv3`：

- Apple Silicon：`DJI LUT.app/Contents/Resources/licenses/COPYING.GPLv3`
- Intel：`DJI LUT.app/Contents/Resources/licenses/COPYING.GPLv3`
- Windows x64：`resources/licenses/COPYING.GPLv3`

此前本机缓存包中出现的 `ffmpeg-COPYING.GPLv3` 是旧缓存的历史文件名，不是 RC 0.0.1 新包的路径。

每个包还在其 `licenses/` 目录中包含 `Go-LICENSE`、`Electron-LICENSE.txt` 与 `Chromium-LICENSES.html`；应用根目录的 `LICENSE` 是项目原创代码的 MIT 许可文本。
