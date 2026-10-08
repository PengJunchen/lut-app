# 版本与 GitHub 发布

工作流 [`desktop-ci-release.yml`](../.github/workflows/desktop-ci-release.yml) 在 PR 指向 `main`、提交合入 `main` 和推送发布 tag 时触发。PR 与主分支运行源码检查和三个平台的本机构建验证；只有发布 tag 会创建 GitHub Release。社区 PR 无需配置发布密钥。

## 版本规则

| Tag | 源码中的 SemVer | GitHub Release |
| --- | --- | --- |
| `rc0.0.1` | `0.0.1-rc.0` | 候选版本 / prerelease |
| `rc0.0.2` | `0.0.2-rc.0` | 候选版本 / prerelease |
| `v0.0.1-rc.1` | `0.0.1-rc.1` | 候选版本 / prerelease |
| `v0.0.1` | `0.0.1` | 正式版本 |

`package.json`、`package-lock.json` 与 Go 引擎使用完整 SemVer；macOS 的 `CFBundleShortVersionString` 和旧 Go 应用打包清单的 `CFBundleVersion` 使用数字 `X.Y.Z`。版本工具会同步这些字段，发布检查只验证，不修改源码。

## 维护者操作

先在开发分支更新版本和 `CHANGELOG.md`，审核变更后提交并通过 PR 合入 `main`。以下是首个 RC 的例子：

```sh
node desktop/scripts/release-version.cjs set 0.0.1-rc.0
node desktop/scripts/release-version.cjs check-tag rc0.0.1
git diff
```

合并后的 `main` 检查通过后，在准确的主分支提交创建 tag：

```sh
git switch main
git pull --ff-only
node desktop/scripts/release-version.cjs check-tag rc0.0.1
git tag -a rc0.0.1 -m "DJI LUT 0.0.1-rc.0"
git push origin rc0.0.1
```

不匹配的版本、非支持格式的 tag、失败的测试或任一目标构建失败都会阻止发布。已经公开的版本 tag 不应移动；修正已发布版本时创建新的版本和 tag。

## 下载包验收

构建分别在 macOS arm64、macOS x64 和 Windows x64 runner 上运行。构建脚本下载锁定版本的依赖，验证 FFmpeg/FFprobe 和官方 LUT 的 SHA-256，然后生成 Electron 应用 ZIP。

`verify_desktop_build.py` 在对应平台启动实际 Go sidecar，检查它加载的目录，验证提取后的运行时、40 个 LUT payload、许可证及 ZIP 内的源文件；完整 readiness 和 bootstrap 响应只在内存中使用，不作为公开产物。该检查验证 sidecar 启动和资源完整性，不代替所有机型的实拍素材验收或桌面窗口人工操作测试。

汇总阶段再次校验三份 ZIP 的 CRC、资源哈希、tag、提交和版本，附加：

- `SHA256SUMS`：三个下载包和元数据文件的 SHA-256。
- `BUILD-METADATA.json`：公开提交、tag、版本、平台、相对资源路径和摘要；不包含 runner 路径、账户信息、访问令牌或用户素材信息。

用户可在 [GitHub Actions](https://github.com/PengJunchen/lut-app/actions) 查看实际运行结果，在 [Releases](https://github.com/PengJunchen/lut-app/releases) 下载对应平台。macOS 包使用 ad-hoc 签名且未公证，Windows 包没有商业代码签名。第三方来源与许可边界见 [`DISTRIBUTION_NOTICES.md`](DISTRIBUTION_NOTICES.md)。
