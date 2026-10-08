# 技术架构

本文说明桌面应用、Go 引擎、LUT 清单与随包运行时之间的关系，方便定位代码和评审社区贡献。应用用于在本机处理视频；视频、LUT 与处理报告不会由程序上传到项目服务。

## 模块边界

| 目录或文件 | 职责 | 修改时关注 |
| --- | --- | --- |
| `cmd/lutapp/` | 命令行入口、应用状态编排、批处理入口，以及 Go 本机服务的启动与关闭 | 界面请求和批处理最终共用 `internal/engine`；保持取消、关闭和报告行为一致 |
| `internal/engine/` | 视频发现、FFprobe 探测、元数据分类、LUT 目录验证、预览计划、复制或转码、结果校验与 JSON 报告 | 自动匹配是明确的机型、Log 模式和风格组合；不要加入文件名猜测或相近型号回退 |
| `internal/webui/` | 将嵌入的静态界面通过本机 HTTP 服务提供，并以 JSON API 转发到应用层 | 监听地址限定为 IPv4 回环；API 使用随机访问令牌并验证请求来源 |
| `internal/folderpicker/` | 按操作系统实现原片目录和结果目录选择 | 桌面特有操作需经过 Electron 主进程和系统选择对话框 |
| `internal/bundle/` | 在打包版本中准备 FFmpeg、FFprobe 与 LUT 资源，校验并提取到本机缓存 | 资源来自构建时锁定的归档；普通测试构建不嵌入这些第三方文件 |
| `assets/` | 存放受版本控制的清单、来源说明，以及打包时才嵌入的 LUT 资源定义 | `library.json` 是可浏览资产目录，`catalog.json` 是自动匹配表；`.cube` 文件不提交到 Git |
| `desktop/` | Electron 主进程、preload 桥接、Go 子进程监督、IPC 校验和桌面打包配置 | Renderer 不直接使用 Node API；新增原生能力应通过受限 IPC 路由 |
| `packaging/` | 按锁定清单准备运行时和 LUT，校验散列并构建 Go 发行包 | 更新来源或工具版本时同步散列、许可证文本和平台信息 |
| `docs/` | 面向用户的使用、构建、官方来源核查和架构说明 | 例子使用通用路径，不提交含个人媒体或机器信息的日志 |

## 运行方式

Go 程序有三种入口形态：

1. 默认模式启动 Go 本机服务，并在默认浏览器打开界面。
2. `--no-open` 启动同一服务，但由用户自行打开显示出的本机地址。
3. `--batch` 使用无界面模式；可加 `--dry-run` 只输出扫描计划。

Electron 桌面版由 Electron 主进程启动随包提供的 Go 引擎子进程。Go 引擎选用临时可用端口，在 `127.0.0.1` 提供同一静态界面和 JSON API；就绪消息将本机地址和访问令牌交给 Electron。Electron 窗口加载该本机来源，界面请求通过 preload 暴露的桥接进入主进程，再由主进程调用 Go API。选择目录、打开结果目录和导出报告等桌面能力也由主进程执行。

## 媒体处理与匹配

扫描阶段根据扩展名发现候选文件，然后通过 FFprobe 读取媒体流、DJI 元数据和视频结构。扩展名只决定是否进入扫描，不能证明文件可解码、元数据完整或机型受支持。

自动恢复需要三项信息相符：

- `com.dji.camera.ColorGammaSxS` 能识别为 D-Log、D-Log2 或 D-Log M；
- 相机元数据能匹配已登记的相机标识，且相机字段之间没有冲突；
- 所选 Standard 或 Vivid 风格在 `catalog.json` 中有对应映射。

当前目录中的 44 条自动映射只代表已登记的组合，并非 44 个机型，也不表示 DJI 所有机型都已完成自动识别。缺失、未知或冲突的机型/Gamma 信息不会通过文件名、位深或相似机型推断。Normal/Rec.709 与已识别 HDR 素材原样复制；未知或不匹配的素材原样复制并标为待核查。裸 H.264/H.265、OSV 全景和多路主视频等特殊素材遵循相同的保守原则。

扫描返回一个不处理视频的逐文件计划，列明动作、匹配结果、目标 LUT 和原因。开始处理后，引擎对可转换素材使用 FFmpeg 套用 3D LUT 并重新编码为 10-bit HEVC Rec.709，同时复制音频码流；容器会按音频兼容性选择 MP4 或 MKV。处理前会验证资源摘要，写入临时结果，再检查视频元数据和输出内容后发布。复制类素材按字节复制并核对输入、输出 SHA-256。遇到已有目标文件时不会覆盖。

输出位于所选基础目录下的 `Standard/` 或 `Vivid/`；未指定目录时使用原片目录下的 `Output/`。批次报告记录匹配决定、状态、原因、资源版本以及输入/输出摘要。报告也可能含完整本机路径与文件名，分享前需脱敏。

## 界面语言与偏好

`internal/webui/static/i18n.js` 定义 `zh-CN` 和 `en` 的页面文案；`app.js` 根据当前语言渲染静态标签、预览、处理状态和已知错误。翻译仅作用于显示内容，机型标识、LUT 官方名称、文件路径、匹配条件和导出报告保持原值。切换语言重新渲染当前界面，不使有效预览过期，也不重新发送扫描或处理请求。

Go 浏览器模式先读取有效的 `localStorage` 偏好，再按浏览器语言选择。Electron 在页面初始化前通过受限 IPC 提供 `GET /api/desktop-preferences`；`POST /api/desktop-language` 仅接受 `{ "language": "zh-CN" }` 或 `{ "language": "en" }`。这两个路由由 Electron 主进程处理，不转发到 Go，也不属于 Go HTTP API。它们与其他桌面路由共用主窗口、主 frame、回环来源和请求体校验。

`desktop/lib/preferences.cjs` 负责读取和顺序原子写入 `userData/preferences.json`，只保存语言字段；`desktop/lib/native-i18n.cjs` 管理窗口、菜单、应用提示和系统对话框中应用提供的文案。语言偏好不属于媒体处理配置，目录、风格和递归设置继续独立验证。Go 浏览器模式的目录选择请求可携带白名单语言，原生选择器通过固定脚本的参数或环境变量获取提示文字，不拼接用户输入为脚本代码。

维护翻译的方法与验证边界见[本地化说明](LOCALIZATION.md)。

## LUT 数据模型

清单与二进制资源分开维护：

| 文件 | 作用 |
| --- | --- |
| `assets/library.json` | UI 浏览目录：来源页面、产品、用途、色彩空间、版本、格式、散列和自动处理资格等记录 |
| `assets/catalog.json` | 引擎自动匹配表：每条记录绑定一个相机、输入 profile、look、`.cube` 文件与 SHA-256 |
| `assets/SOURCES.md` | 官方页面和文件来源、下载地址、版本关系及再分发边界 |
| `docs/DJI_LUT_RESEARCH.zh-CN.md` | 官方下载页核查和当前目录统计 |
| `assets/luts/` | 本地准备的 `.cube` 文件目录，由 `.gitignore` 排除 |

截至 2026-10-08，来源核查覆盖 44 个 DJI LUT 详情页，其中 4 个旧页面已被新版替代；当前清单为 58 条资产记录，对应 SHA-256 去重后的 40 个 LUT 文件。`library.json` 中有些记录共用同一 payload，自动表则按相机拆成 44 条机型/profile/look 映射。因此“详情页数”“资产记录数”“唯一文件数”和“自动映射数”是不同指标。

浏览目录可以含自动转换以外的官方 LUT。引擎只接受经过校验的 3D `.cube` Log-to-Rec.709 restore LUT；HLG、创意、sRGB、Linear 等资产可浏览但不参与自动还原。常规测试只嵌入 JSON 清单；使用 `bundled` build tag 的发行构建会嵌入通过校验的完整 LUT 资源集，不限于自动映射所用文件。

## 离线运行与安全边界

- Go 本机 HTTP 服务只绑定 `127.0.0.1`，使用随机端口和访问令牌；令牌通过 URL fragment 交给应用页面，API 请求还会校验 Bearer 令牌和来源。页面响应使用同源内容安全策略、禁止嵌入框架，并设置 MIME 嗅探保护。
- Electron 窗口启用 sandbox 和 context isolation，关闭 Node 集成；弹窗、新窗口、外部跳转和 renderer 权限请求均受限。preload 只暴露请求桥接，主进程验证调用来源和允许的路由。
- 发行构建将目标平台 FFmpeg/FFprobe 运行时与 LUT 资源编入 Go 引擎。首次运行在本机用户缓存中准备资源，校验缓存清单和文件摘要；已安装应用处理素材时不需要联网，也不要求用户另装 Go、Python、Node、FFmpeg 或 FFprobe。
- `packaging/runtime-lock.json`、`packaging/license-lock.json` 和 LUT 清单固定构建输入。更新依赖或资源时需要核对版本、源站和 SHA-256，并维护随包许可证材料。
- 项目没有素材上传或遥测服务。JSON 报告、FFmpeg 日志和应用错误上下文可能包含本机路径、文件名或元数据，公开前应检查并脱敏。

`LICENSE` 的 MIT 条款只覆盖项目原创源码。DJI LUT 的再分发授权目前未确认，FFmpeg 与 Electron/Chromium 也各有独立许可；详见 [`THIRD_PARTY.md`](../THIRD_PARTY.md)。

## 从哪里开始修改

- 用户操作或文案：先看 `docs/USAGE.zh-CN.md`、`internal/webui/static/` 和 `cmd/lutapp/app.go`。
- 识别、预览和转码：从 `internal/engine/planning.go`、`classify.go`、`catalog.go` 与 `run.go` 开始。
- 新官方 LUT：先核对 `assets/SOURCES.md`，更新 `library.json`；只有满足自动还原边界并有对应验证时，才更新 `catalog.json`。
- Electron 桌面能力：阅读 `desktop/main.cjs`、`desktop/preload.cjs`、`desktop/lib/ipc-contract.cjs` 和 `desktop/lib/request-dispatcher.cjs`。
- 发行构建：查看 `packaging/prepare_runtime.py`、`packaging/prepare_luts.py`、`packaging/build.py`、`desktop/scripts/` 和 [`docs/ELECTRON.zh-CN.md`](ELECTRON.zh-CN.md)。

贡献准备与建议验证步骤见 [`CONTRIBUTING.md`](../CONTRIBUTING.md)。
