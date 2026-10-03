# Electron 桌面端实施计划

分支：`feature/electron-desktop`，基线：`a254bd2`。

## 目标与边界

Electron 提供独立桌面窗口、系统目录选择、报告保存与打开结果目录。Go 继续负责视频元数据识别、相机与 LUT 匹配、并行转码、取消、原样复制和完整性校验。复用现有界面与 Go 引擎，不重复实现视频处理。

保持 D-Log、D-Log2、D-Log M 的精确元数据规则，以及未知/不支持素材的原样保留行为。默认不扫描子文件夹，由用户明确选择。所有处理产物写入独立 Output 树，不覆盖原片。

## 进程与接口

桌面主进程启动随包分发的 Go 子进程：`--desktop --input <应用所在目录>`。Go 启动后在标准输出写一行 JSON：`{"type":"ready","protocol":1,"url":"http://127.0.0.1:随机端口/#token=..."}`。错误走标准错误；桌面模式不弹 Go 启动错误窗口，也不打开系统浏览器。

Go 仍只监听本机回环地址，并保留令牌、来源和 Host 校验。令牌只保存在 Electron 主进程。Renderer 加载该服务的界面，通过隔离 preload 的 `window.djiDesktop.request(route, options)` 调用白名单接口；返回 `{status, ok, payload}`。Renderer 不接触令牌、Node.js、文件系统或任意 IPC。

Go 接口白名单：bootstrap/state(GET)，preview/run/cancel(POST)。主进程直接处理 select-folder、open-output、shutdown 和 export-report(POST)，分别使用 Electron 原生 dialog/shell、受控进程关闭与系统保存窗口。`export-report` 从 Go 当前已完成状态读取报告，不接收 Renderer 提供的任意文件路径或文件内容。

窗口关闭、应用退出或异常退出时，关闭 Go stdin/请求 shutdown；Go 在 stdin EOF、终止信号时取消并等待扫描/转码子进程。桌面主进程设置有界关闭超时和进程树兜底，不遗留 FFmpeg。禁止多实例重复启动。

## 安全与构建

关闭 Node integration，开启 context isolation、sandbox 和 web security。IPC 校验调用窗口与主 frame；限制 endpoint、方法与 payload 大小。窗口只允许当前 Go origin，禁止任意导航、新窗口与权限申请。不加载远程页面或 CDN。

固定 Electron/npm 依赖版本并提交 lockfile。复用已锁定哈希的 Go/FFmpeg/LUT 构建资源，分别构建 macOS arm64、macOS x64 和 Windows x64 包。所有可执行文件、缓存、发行包、中间文件和本地验收记录不进入 Git。

## 验收

- Go 常规/竞态测试及桌面模式生命周期检查；旧浏览器和 batch 入口保持可用。
- Node 侧接口白名单、来源、目录选择取消、子进程启动/失败/关闭测试。
- Mac 实际启动桌面窗口，验证原生目录选择与完整短素材批处理；核对 LUT、原样复制哈希、分辨率、帧率、10-bit 与音频。
- 三个平台发行构建和包内容检查；跨平台构建与真机运行证据分开记录。
- 最终源码检查、Git 提交和工作区状态检查。
