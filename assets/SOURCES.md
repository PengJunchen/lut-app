# DJI LUT 来源与资产说明

核查日期：2026-10-08。所有 LUT 标签、版本、支持产品与下载链接均来自 DJI 官方下载中心或 DJI 帮助中心。完整逐页清单与机型兼容性依据见 [DJI 官方 LUT 目录检索与兼容性核查](../docs/DJI_LUT_RESEARCH.zh-CN.md)。

## 来源与覆盖范围

- [DJI 下载中心](https://www.dji.com/cn/downloads) 的 `transcoding` 分类包含 44 个 LUT 软件详情页和 1 个不含 LUT 载荷的 LOG mode transcoding tool。可见目录编号 291–316 覆盖 26 个 LUT 页面；同一官方目录数据还列出另外 18 个 LUT 页面。
- 每个软件详情页提供 macOS/Windows 文件链接。`library.json` 保留 DJI 标题、来源详情页、直接 CDN URL、发布版本、格式、维度和 SHA-256。多个产品标签如果下载到相同字节，文件按 SHA-256 去重，产品来源记录仍分别保留。
- 旧版 Pocket 4/Pocket 4P D-Log 与 vivid 页面作为历史依据留在私有审计清单，不进入当前库；V2 页面替代它们。Pocket 4P 的 D-Log2 33³ 与 65³ 官方版本/尺寸均保留，自动目录选择 65³。
- ZIP 软件包按成员登记，库中不把 ZIP 容器伪装成可直接应用的 Cube。当前登记的 LUT 成员文件均为 `.cube`，其中含 1D 和 3D 数据；8 个官方页面以 ZIP 容器交付。只有符合引擎契约的 3D Cube Log→Rec.709 restore 资产进入自动目录。

## 相机与 Gamma 边界

[D-Log LUT 支持矩阵](https://repair.dji.com/help/content?customId=01700007105&lang=en&paperDocType=ARTICLE&re=US&spaceId=17) 与各下载页共同用于核对相机/Gamma。Mavic 2/Air 2S 页面对应的 LUT 只映射到有 DJI 官方 D-Log M 证据的 `mavic2pro` 与 `air2s`；Mavic 2 Zoom 是 D-Cinelike，不进入自动映射。该矩阵还明确说明 Phantom 4 Advanced、Phantom 4 Pro 与 Phantom 4 Pro V2.0 可使用 Phantom 4 LUT，因此三者分别登记到 Phantom 4 的同一已核验 Cube。对没有引擎精确 camera ID 的历史产品，保留官方来源产品名和官方 slug，仅供浏览。

无自动映射的资产仍保留在资料库，包括 Rec.709 创意 look、sRGB/Rec.2020 HLG 输出、Linear→D-Log、1D 曲线、以及缺少精确相机 alias 的历史来源。目录不会做近似机型或 Gamma 回退。

## 字节复用与分发

相同 SHA-256 表示当前取得的文件字节相同，不代表 DJI 为各产品标签分别调校了独立曲线。当前若干页面下载同一份 33³ D-Log M Cube；该文件的注释写明 Mavic 3 Pro D-Log M。`assets/catalog.json` 保留精确相机/profile/look 选择，不用共享哈希推导未经 DJI 证实的通用兼容范围。

实际 `.cube` 载荷不提交在 Git 中；本地打包流程应使用 SHA-256 匹配的官方文件并重新核验。DJI 下载与帮助页面没有明确说明允许第三方应用再分发这些 LUT，本说明不构成授权。
