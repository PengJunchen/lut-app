# 贡献指南

欢迎提交问题、官方 LUT 覆盖资料、文档修正和代码改进。提交前先阅读[技术架构](docs/ARCHITECTURE.zh-CN.md)、[使用说明](docs/USAGE.zh-CN.md)以及与改动相关的[官方 LUT 核查记录](docs/DJI_LUT_RESEARCH.zh-CN.md)。

## 本地开发

核心使用 Go；Electron 桌面开发需要 Node.js。建议环境：Go 1.24 或更新版本、Node.js 22.12 或更新版本；准备运行时和 LUT 资源还需要 Python 3.10 或更新版本。

```sh
go test ./...
npm ci
npm test
```

`go test ./...` 不需要下载 FFmpeg 或 `.cube` 资源。`npm test` 检查 Electron 桥接层与界面本地化行为，需要先安装锁定依赖。完整桌面构建步骤见 [`docs/ELECTRON.zh-CN.md`](docs/ELECTRON.zh-CN.md)。

开发运行和发行构建使用独立资源准备步骤：

```sh
python3 packaging/prepare_runtime.py darwin-arm64
python3 packaging/prepare_luts.py
npm run build:engine
npm start
```

将 `darwin-arm64` 换为 `darwin-amd64` 或 `windows-amd64` 可准备其他目标的运行时。LUT 准备程序按锁定官方来源和 SHA-256 校验文件；发行构建命令、最低系统要求和输出包名称见 Electron 构建说明。

## 新增或修订 LUT 覆盖

LUT 清单的价值在于来源明确、匹配条件可复核。请仅使用可核验的 DJI 官方下载页面和下载文件，并在 PR 中提供来源证据：

1. 在 `assets/SOURCES.md` 或相关研究文档中记录官方详情页、直接下载地址（若为 ZIP 则注明精确成员）、页面标注的产品和版本，以及文件 SHA-256。不要根据文件日期推导版号。
2. 在 `assets/library.json` 增加或修订资产记录。保留官方标题、来源和用途；同一文件的多个记录应引用相同的内容地址和摘要，避免重复保存 payload。
3. 只有在文件是结构有效的 3D `.cube` Log-to-Rec.709 restore LUT，且相机、输入 Gamma、风格关系经过核实后，才把条目标为可自动使用，并按精确相机/profile/look 组合维护 `assets/catalog.json`。HLG、创意、sRGB、Linear 等浏览目录项目不要加到自动转换表。
4. 为自动映射变化补充或更新引擎测试，覆盖元数据缺失、未知或冲突时的保留行为；不要让文件名、视频位深或相近机型触发 LUT 回退。
5. 本地准备资源并验证清单：

   ```sh
   python3 packaging/prepare_luts.py
   go test ./...
   ```

准备脚本会下载或导入本机忽略目录中的资源并校验摘要。不要把 `.cube` payload、运行时二进制、下载缓存或构建输出提交到 Git。项目没有确认 DJI LUT 的再分发许可；MIT 许可不覆盖 DJI LUT。

## 提交代码与文档

- 页面与原生菜单的新文案应同时提供中文和英文，README 的两种语言也应保持事实一致。翻译不能改变路径、机型、LUT 标识或处理报告；具体维护步骤见[本地化说明 / Localization](docs/LOCALIZATION.md)。
- 修改 Go 代码后运行 `gofmt`，并增加能验证行为的测试。
- Electron IPC、Go 本机 API、路径处理、子进程生命周期和打包配置都属于安全边界；请描述输入校验、权限和失败关闭方式。
- 行为改动请说明复现步骤、预期结果和验证平台。清楚区分目标平台交叉构建与在该操作系统上的实际运行验证。
- 文档使用通用路径和通用素材名，不要放入私人文件路径、视频名称、相机序列号、访问令牌、完整调试日志或个人验证截图。
- 处理报告和 FFprobe/FFmpeg 日志可能包含本机路径、文件名、相机字段或其他媒体元数据。若这些内容有助于复现，请先检查并脱敏后再粘贴；不要上传原片。
- PR 请说明改动范围、依据、测试命令和未验证平台。仓库 PR 模板提供了检查项。

## 版本和发行

公开首个 RC 的目标版本为 `0.0.1-rc.0`，tag 与 GitHub Release 名称为 `rc0.0.1`。维护者应先把 package/Go 等源码版本字段统一更新并合入 `main`，再创建 tag。发行工作流按 tag 检查当前提交中的版本，不会替提交修改版本文件。PR/`main` 检查和 `rc*`、`v*` 发布触发规则见仓库的 GitHub Actions 工作流。

具体版本同步、tag 命名、发布操作和下载包验收见[版本与发布说明](docs/RELEASING.zh-CN.md)。
