# DJI 官方 LUT 目录检索与兼容性核查

核查日期：2026-10-08。本文记录 DJI 官方下载中心目录中可核验的 LUT 页面、直接下载文件、ZIP 成员、版本替代关系与本应用的自动映射边界。所有来源链接均指向 DJI 官方站点或官方 CDN。

## 范围与方法

从 [DJI 下载中心](https://www.dji.com/cn/downloads) 的官方 software/transcoding 数据和可见下载目录核对记录。当前 `transcoding` 分类共 45 条：44 个 LUT 软件详情页，以及 1 个不含 LUT 文件的 [LOG mode Transcoding Tool](https://www.dji.com/cn/downloads/softwares/transcoding-log-mode)，后者不进入库。浏览器可见列表中的 26 个 LUT 条目编号为 291–316；另 18 个 LUT 详情页由同一官方目录数据记录提供。逐页跟随 macOS/Windows 下载链接，取得官方 CDN 文件；对 ZIP 逐一列出成员并校验成员摘要。

版本状态按同一相机、输入 Gamma 与标准/ vivid look 的官方版本替代关系判断。Pocket 4 与 Pocket 4P 的四个 V1 页仍保留在审计清单，库中不再把它们当作当前版本；其对应 V2 页面为当前记录。没有 DJI 版号的历史软件记录保留空版本，不从文件日期推造版号。

## 统计结果

- 官方 LUT 详情页：44 条；其中当前页 40 条，已被后续 V2 取代的旧版页 4 条。
- 当前直接 LUT 页面：32 条；ZIP 归档页：8 条，解包出 25 个 LUT 成员。按相机标签拆分 Phantom 4/Zenmuse Z3 的一个映射后，`library.json` 有 58 条可浏览资产记录。
- 当前文件按 SHA-256 去重为 40 个实际 `.cube` 文件；库中均保留原页面标题和来源关系。当前唯一文件维度统计：{'3d': 36, '1d': 4}；3D 网格：{16: 1, 17: 1, 32: 1, 33: 23, 64: 4, 65: 6}。
- 自动目录有 44 条精确 camera/profile/look 映射，只接受结构有效、有限数值的 3D `.cube` Log→Rec.709 restore LUT；没有隐式机型、Gamma 或 look 回退。Pocket 4P 的 D-Log2 33³ 与 65³ 都留在库中，自动选择 65³。

## 官方 LUT 页面与下载文件

表内版本、支持产品、平台下载链接和文件摘要取自对应的 DJI 详情页数据。链接文字会直接打开 DJI CDN 文件；“官方页面数据”表示目录数据中的详情页，没有对应 291–316 可见编号。`页面资产数`对 ZIP 页统计解包后的 LUT 成员。

日期字段按源记录原样展示，不能作为版本先后或产品上市日期的保证。例如 Air 3S 软件页记录 `2023-08-03`，而 [DJI 官方发布公告](https://www.dji.com/media-center/announcements/dji-release-air-3s-us) 的产品发布日期为 2024-10-15，二者存在源数据异常。本库用兼容用途与官方版号判断替代关系。

| 列表编号 | DJI 官方详情页 | 页面列出的产品 | 页面版本 / 日期 | 直接下载文件 | 页面资产数 | 状态 |
| --- | --- | --- | --- | --- | ---: | --- |
| 291 | [DJI Mavic 3 D-Log M to Rec.709 LUT](https://www.dji.com/cn/downloads/softwares/dji-mavic-3-d-log-m-709-lut) | DJI Mavic 3<br>DJI Mavic 3 Classic<br>DJI Mavic 3 Pro | v1.0 · 2023-04-25 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/M3/DJI%20Mavic%203%20D-Log%20M%20to%20Rec.709%20V1.cube) | 1 | 当前记录 |
| 292 | [DJI Mavic 3 D-Log to Rec.709 vivid LUT](https://www.dji.com/cn/downloads/softwares/vivid-lut) | DJI Mavic 3<br>DJI Mavic 3 Classic<br>DJI Mavic 3 Pro | v1.0 · 2022-05-31 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/mavic%203/DJI%20Mavic%203%20D-Log%20to%20Rec.709%20vivid%20V1.cube) | 1 | 当前记录 |
| 293 | [DJI Mavic 3 D-Log to Rec.709 LUT](https://www.dji.com/cn/downloads/softwares/transcoding-mavic-3) | DJI Mavic 3<br>DJI Mavic 3 Classic<br>DJI Mavic 3 Pro | v1.0 · 2021-11-09 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/260%20downloads/DJI%20Mavic%203%20D-Log%20to%20Rec.709%20V1.cube) | 1 | 当前记录 |
| 294 | [DJI Mini 4 Pro DJI D-Log M to Rec.709](https://www.dji.com/cn/downloads/softwares/mini-4-pro-dlog-to-rec709) | DJI Mini 4 Pro | v1.0 · 2023-09-25 | [cube/mac_os](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/140%20lut/DJI%20Mini%204%20Pro%20D-Log%20M%20to%20Rec.709%20V1_.cube)<br>[cube/windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/140%20lut/DJI%20Mini%204%20Pro%20D-Log%20M%20to%20Rec.709%20V1._.cube) | 1 | 当前记录 |
| 295 | [DJI Flip D-Log M to Rec.709](https://www.dji.com/cn/downloads/softwares/flip-dlog-to-rec709) | DJI Flip | v1.0 · 2025-01-14 | [cube/mac_os](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/141%20LUT/DJI%20Flip%20D-Log%20M%20to%20Rec.709%20V1_.cube)<br>[cube/windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/141%20LUT/DJI%20Flip%20D-Log%20M%20to%20Rec.709%20V1._.cube) | 1 | 当前记录 |
| 296 | [DJI O4 Air Unit 系列 D-Log M to Rec.709](https://www.dji.com/cn/downloads/softwares/o4-air-unit-dlog-to-rec709) | DJI O4 Air Unit 系列 | v1.0 · 2025-01-09 | [cube/mac_os](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/ZA530%20LUT/DJI%20O4%20Air%20Unit%20Series%20D-Log%20M%20to%20Rec.709%20V1._.cube)<br>[cube/windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/ZA530%20LUT/DJI%20O4%20Air%20Unit%20Series%20D-Log%20M%20to%20Rec.709%20V1_.cube) | 1 | 当前记录 |
| 297 | [DJI Avata 2 DJI D-Log M to Rec.709](https://www.dji.com/cn/downloads/softwares/avata-2-dlog-to-rec709) | DJI Avata 2 | v1.0 · 2024-04-11 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/avata2%20d-log/DJI%20Avata%202%20D-Log%20M%20to%20Rec.709%20V1._.cube) | 1 | 当前记录 |
| 298 | [DJI Air 3s DJI D-Log M to Rec.709](https://www.dji.com/cn/downloads/softwares/air-3s-dlog-to-rec709) | DJI Air 3S | v1.0 · 2023-08-03 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/234_lut/DJI%20Air%203S%20%20D-Log%20M%20to%20Rec.709%20V1_.cube) | 1 | 当前记录 |
| 299 | [DJI Air 3 DJI D-Log M to Rec.709](https://www.dji.com/cn/downloads/softwares/air-3-dlog-to-rec709) | DJI Air 3 | v1.0 · 2023-08-03 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/DJI%20Air%203%20Lut/DJI%20Air%203%20D-Log%20M%20to%20Rec.709%20V1_.cube) | 1 | 当前记录 |
| 300 | [DJI Osmo 360 D-Log M to Rec.709 LUT](https://www.dji.com/cn/downloads/softwares/osmo-360-dlog-m-to-rec709-lut) | Osmo 360<br>Osmo 360 II | v1.0 · 2025-07-31 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/OQ101%20LUT/DJI%20Osmo%20360%20D-Log%20M%20to%20Rec.709%20V1.cube) | 1 | 当前记录 |
| 301 | [DJI Osmo Nano D-Log M to Rec.709 vivid LUT](https://www.dji.com/cn/downloads/softwares/osmo-nano-d-log-m-to-rec-709-vivid-lut) | Osmo Nano | V1.0 · 2025-09-23 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/OW001%20LUT/DJI%20OSMO%20Osmo%20Nano%20D-Log%20M%20to%20Rec.709%20V1.cube) | 1 | 当前记录 |
| 302 | [DJI OSMO Action 6 D-LogM to Rec.709 LUT](https://www.dji.com/cn/downloads/softwares/dji-osmo-action-6-d-log-m-to-rec-709-lut) | Osmo Action 6 | V1.0 · 2025-11-13 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/AC206%20LUT/DJI%20OSMO%20Action%206%20D-LogM%20to%20Rec.709%20LUT-11.17.cube) | 1 | 当前记录 |
| 303 | [DJI OSMO Action 5 Pro D-Log M to Rec.709 vivid LUT](https://www.dji.com/cn/downloads/softwares/dji-osmo-action-5-pro-d-log-m-to-rec-709-vivid-lut) | Osmo Action 5 Pro | V1.0 · 2024-09-19 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/AC204%E8%BD%AF%E4%BB%B6/DJI%20OSMO%20Action%205%20Pro%20D-Log%20M%20to%20Rec.709%20V1.cube) | 1 | 当前记录 |
| 304 | [DJI OSMO Action 5 Pro Rec.709 to Color Grading LUTs](https://www.dji.com/cn/downloads/softwares/dji-osmo-action-5-pro-rec-709-to-color-grading-luts) | Osmo Action 5 Pro | V1.1 · 2024-11-06 | [ZIP/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/AC204%E8%BD%AF%E4%BB%B6/%E5%A4%A7%E5%B8%88%E6%BB%A4%E9%95%9C/DJI%20OSMO%20Action%205%20Pro%20Rec.709%20to%20Color%20Grading%20LUTs.zip) | 4 | 当前记录 |
| 305 | [DJI OSMO Action 4 D-Log M to Rec.709 vivid LUT](https://www.dji.com/cn/downloads/softwares/dji-osmo-action-4-d-log-m-to-rec-709-vivid-lut) | Osmo Action 4 | V1.0 · 2023-08-02 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/203/DJI%20OSMO%20Action%204%20D-Log%20M%20to%20Rec.709%20V1.cube) | 1 | 当前记录 |
| 306 | [DJI OSMO Action 4 Rec.709 to Color Grading LUTs](https://www.dji.com/cn/downloads/softwares/dji-osmo-action-4-rec-709-to-color-grading-luts) | Osmo Action 4 | V1.1 · 2024-11-06 | [ZIP/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/AC204%E8%BD%AF%E4%BB%B6/%E5%A4%A7%E5%B8%88%E6%BB%A4%E9%95%9C/DJI%20OSMO%20Action%204%20Rec.709%20to%20Color%20Grading%20LUTs.zip) | 3 | 当前记录 |
| 307 | [DJI OSMO Pocket 3 D-Log M to Rec.709](https://www.dji.com/cn/downloads/softwares/osmo-pocket-3-dlog-to-rec709) | Osmo Pocket 3 | v1.0 · 2023-10-25 | [cube/mac_os、windows](https://www-dl.djicdn.com/5e45168b46b342d5b88f72c458ba6e79/OP3%20LUT%E6%96%87%E4%BB%B6%E7%89%B9%E6%AE%8A%E5%A4%84%E7%90%86/DJI%20OSMO%20Pocket%203%20D-Log%20M%20to%20Rec.709%20V1.cube) | 1 | 当前记录 |
| 308 | [DJI OSMO Pocket 3 Rec.709 to Color Grading LUTs](https://www.dji.com/cn/downloads/softwares/dji-osmo-pocket-3-rec-709-to-color-grading-luts) | Osmo Pocket 3 | v1.1 · 2024-11-06<br>V1.1 · 2024-11-06 | [ZIP/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/AC204%E8%BD%AF%E4%BB%B6/%E5%A4%A7%E5%B8%88%E6%BB%A4%E9%95%9C/DJI%20OSMO%20Pocket%203%20Rec.709%20to%20Color%20Grading%20LUTs.zip) | 4 | 当前记录 |
| 309 | [禅思 X9 D-Log to Rec.2020 HLG LUT](https://www.dji.com/cn/downloads/softwares/dji-zenmuse-x9-dlog2rec2020hlg-lut) | DJI Ronin 4D<br>DJI Inspire 3 | v1.0 · 2021-12-28 | [cube/mac_os、windows](https://mydjiflight.dji.com/file/links/DJI_ZENMUSE_X9_DLOG_TO_REC2020HLG_3D_LUT_V1) | 1 | 当前记录 |
| 310 | [禅思 X9 D-Log to Rec.709 LUT](https://www.dji.com/cn/downloads/softwares/dji-zenmuse-x9-dlog2rec709-lut) | DJI Ronin 4D<br>DJI Inspire 3 | v1.0 · 2021-12-28 | [cube/mac_os、windows](https://mydjiflight.dji.com/file/links/DJI_ZENMUSE_X9_DLOG_TO_REC709_3D_LUT_V1) | 1 | 当前记录 |
| 311 | [Inspire 1/Zenmuse X5R Dlog to sRGB 3DLUT](https://www.dji.com/cn/downloads/softwares/transcoding-zenmuse-x5r) | 悟 Inspire 1<br>悟 Inspire 1 Pro/RAW<br>禅思 Zenmuse X5<br>禅思 Zenmuse X5R | 未标版次 · 2016-05-12 | [ZIP/windows](https://dl.djicdn.com/downloads/zenmuse_x5s/X5_series_Dlog_3DLUT.zip) | 5 | 当前记录 |
| 312 | [Zenmuse Linear to D-Log LUT](https://www.dji.com/cn/downloads/softwares/transcoding-zenmuse-x7-linear) | 禅思 Zenmuse X5S<br>禅思 Zenmuse X7 | 未标版次 · 2018-01-04 | [ZIP/windows](https://dl.djicdn.com/downloads/zenmuse+x7/20180104/Linear+to+D-Log.zip) | 1 | 当前记录 |
| 313 | [Zenmuse D-Log to Rec.709 LUT](https://www.dji.com/cn/downloads/softwares/transcoding-zenmuse-x7-rec) | 禅思 Zenmuse X5S<br>禅思 Zenmuse X7 | 未标版次 · 2017-10-17 | [ZIP/windows](https://dl.djicdn.com/downloads/zenmuse+x7/20171017/D-Log+to+Rec709.zip) | 1 | 当前记录 |
| 314 | [DJl Mavic 2/Air 2s D-Log M to Rec709 LUT](https://www.dji.com/cn/downloads/softwares/dlog-m-to-rec709-lut) | 御 Mavic 2<br>DJI Air 2S | 未标版次 · 2018-09-19 | [cube/mac_os、windows](https://docs.djicdn.com/Products+info/DLog-M+to+Rec709.cube) | 1 | 当前记录 |
| 315 | [Phantom 4 Dlog 3DLUT](https://www.dji.com/cn/downloads/softwares/transcoding-phantom-4) | 精灵 Phantom 4<br>禅思 Zenmuse Z3 | 未标版次 · 2016-06-06 | [ZIP/windows](https://dl.djicdn.com/downloads/phantom_4/Phantom_4_Dlog_3DLUT_20160606.zip) | 3 | 当前记录 |
| 316 | [Phantom 3 Dlog to sRGB 3DLUT](https://www.dji.com/cn/downloads/softwares/transcoding-phantom-3) | 精灵 Phantom 3 Pro<br>精灵 Phantom 3 Advanced | 未标版次 · 2016-05-12 | [ZIP/windows](https://dl.djicdn.com/downloads/phantom_3/Phantom_3_Dlog_3DLUT.zip) | 4 | 当前记录 |
| 官方页面数据 | [DJI Mavic 4 Pro D-Log M to Rec.709 LUT](https://www.dji.com/cn/downloads/softwares/mavic-4-pro-dlog-m-to-rec709-lut) | DJI Mavic 4 Pro | v1.0 · 2025-05-13 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/WA341%20LUT/DJI%20Mavic%204%20Pro%20D-Log%20M%20to%20Rec.709%20V1.cube) | 1 | 当前记录 |
| 官方页面数据 | [DJI Mavic 4 Pro D-Log to Rec.709 LUT](https://www.dji.com/cn/downloads/softwares/mavic-4-pro-dlog-to-rec709-lut) | DJI Mavic 4 Pro | v1.0 · 2025-05-13 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/WA341%20LUT/DJI%20Mavic%204%20Pro%20D-Log%20to%20Rec.709%20V1.cube) | 1 | 当前记录 |
| 官方页面数据 | [DJI Mavic 4 Pro D-Log to Rec.709 vivid LUT](https://www.dji.com/cn/downloads/softwares/mavic-4-pro-dlog-to-rec709-vivid-lut) | DJI Mavic 4 Pro | v1.0 · 2025-05-13 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/WA341%20LUT/DJI%20Mavic%204%20Pro%20D-Log%20to%20Rec.709%20vivid%20V1.cube) | 1 | 当前记录 |
| 官方页面数据 | [DJI Mini 5 Pro D-Log M to Rec.709 LUT](https://www.dji.com/cn/downloads/softwares/mini-5-pro-dlog-m-to-rec709-lut) | DJI Mini 5 Pro | v1.0 · 2025-09-17 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/WA150%20LUT/DJI%20Mini%205%20Pro%20D-Log%20M%20to%20Rec.709%20LUT.cube) | 1 | 当前记录 |
| 官方页面数据 | [DJI Lito X1 D-Log M to Rec.709 LUT](https://www.dji.com/cn/downloads/softwares/lito-x1-dlog-m-to-rec709-lut) | DJI Lito X1 | v1.0 · 2026-04-23 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/WA151%20Lut/DJI%20Lito%20X1%20D-Log%20M%20to%20Rec.709%20LUT.cube) | 1 | 当前记录 |
| 官方页面数据 | [DJI Avata 360 D-Log M to Rec.709 LUT](https://www.dji.com/cn/downloads/softwares/avata-360-dlog-m-to-rec709-lut) | DJI Avata 360 | v1.0 · 2026-03-26 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/WA530%20Lut/DJI%20Avata%20360%20D-Log%20M%20to%20Rec.709%20V1.cube) | 1 | 当前记录 |
| 官方页面数据 | [DJI OSMO Pocket 4P D-Log to Rec.709 V2.0 size33](https://www.dji.com/cn/downloads/softwares/osmo-pocket-4p-dlog-to-rec709-lut-size33-2) | Osmo Pocket 4P | v2.0 · 2026-08-17 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/HG224%20LUT/DJI%20OSMO%20Pocket%204P%20D-Log%20to%20Rec.709%20V2.0%20size33.cube) | 1 | 当前记录 |
| 官方页面数据 | [DJI OSMO Pocket 4P D-Log to Rec.709 size33](https://www.dji.com/cn/downloads/softwares/osmo-pocket-4p-dlog-to-rec709-lut-size33) | Osmo Pocket 4P | v1.0 · 2026-06-15 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/HG224%20LUT/DJI%20OSMO%20Pocket%204P%20D-Log%20to%20Rec.709%20V1.0%20size33.cube) | 1 | 已被 [osmo-pocket-4p-dlog-to-rec709-lut-size33-2](https://www.dji.com/cn/downloads/softwares/osmo-pocket-4p-dlog-to-rec709-lut-size33-2) 取代 |
| 官方页面数据 | [DJI OSMO Pocket 4P D-Log to Rec.709 vivid V2.0 size33](https://www.dji.com/cn/downloads/softwares/osmo-pocket-4p-dlog-to-rec709-lut-vivid-size33-2) | Osmo Pocket 4P | v2.0 · 2026-08-17 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/HG224%20LUT/DJI%20OSMO%20Pocket%204P%20D-Log%20to%20Rec.709%20vivid%20V2.0%20size33.cube) | 1 | 当前记录 |
| 官方页面数据 | [DJI OSMO Pocket 4P D-Log to Rec.709 vivid size33](https://www.dji.com/cn/downloads/softwares/osmo-pocket-4p-dlog-to-rec709-lut-vivid-size33) | Osmo Pocket 4P | v1.0 · 2026-06-15 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/HG224%20LUT/DJI%20OSMO%20Pocket%204P%20D-Log%20to%20Rec.709%20vivid%20V1.0%20size33.cube) | 1 | 已被 [osmo-pocket-4p-dlog-to-rec709-lut-vivid-size33-2](https://www.dji.com/cn/downloads/softwares/osmo-pocket-4p-dlog-to-rec709-lut-vivid-size33-2) 取代 |
| 官方页面数据 | [DJI OSMO Pocket 4P D-Log2 to Rec.709 size33](https://www.dji.com/cn/downloads/softwares/osmo-pocket-4p-dlog-2-to-rec709-lut-size33) | Osmo Pocket 4P | v1.0 · 2026-06-15 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/HG224%20LUT/DJI%20OSMO%20Pocket%204P%20D-Log2%20to%20Rec.709%20V1.0%20size33.cube) | 1 | 当前记录 |
| 官方页面数据 | [DJI OSMO Pocket 4P D-Log2 to Rec.709 size65](https://www.dji.com/cn/downloads/softwares/osmo-pocket-4p-dlog-2-to-rec709-lut-size65) | Osmo Pocket 4P | v1.0 · 2026-06-15 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/HG224%20LUT/DJI%20OSMO%20Pocket%204P%20D-Log2%20to%20Rec.709%20V1.0%20size65.cube) | 1 | 当前记录 |
| 官方页面数据 | [DJI OSMO Pocket 4P D-Log2 to Rec.709 vivid size33](https://www.dji.com/cn/downloads/softwares/osmo-pocket-4p-dlog-2-to-rec709-lut-vivid-size33) | Osmo Pocket 4P | v1.0 · 2026-06-15 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/HG224%20LUT/DJI%20OSMO%20Pocket%204P%20D-Log2%20to%20Rec.709%20vivid%20V1.0%20size33.cube) | 1 | 当前记录 |
| 官方页面数据 | [DJI OSMO Pocket 4P D-Log2 to Rec.709 vivid size65](https://www.dji.com/cn/downloads/softwares/osmo-pocket-4p-dlog-2-to-rec709-lut-vivid-size65) | Osmo Pocket 4P | v1.0 · 2026-06-15 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/HG224%20LUT/DJI%20OSMO%20Pocket%204P%20D-Log2%20to%20Rec.709%20vivid%20V1.0%20size65.cube) | 1 | 当前记录 |
| 官方页面数据 | [DJI OSMO Pocket 4 D-Log to Rec.709 vivid V2.0](https://www.dji.com/cn/downloads/softwares/osmo-pocket-4-dlog-to-rec709-lut-vivid-2) | Osmo Pocket 4 | v2.0 · 2026-09-24 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/HG214%20Lut/DJI%20OSMO%20Pocket%204%20D-Log%20to%20Rec.709%20vivid%20V2.0.cube) | 1 | 当前记录 |
| 官方页面数据 | [DJI OSMO Pocket 4 D-Log to Rec.709 vivid](https://www.dji.com/cn/downloads/softwares/osmo-pocket-4-dlog-to-rec709-lut-vivid) | Osmo Pocket 4 | v1.0 · 2026-04-16 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/HG214%20Lut/DJI%20OSMO%20Pocket%204%20D-Log%20to%20Rec.709%20vivid%20V1.0.cube) | 1 | 已被 [osmo-pocket-4-dlog-to-rec709-lut-vivid-2](https://www.dji.com/cn/downloads/softwares/osmo-pocket-4-dlog-to-rec709-lut-vivid-2) 取代 |
| 官方页面数据 | [DJI OSMO Pocket 4 D-Log to Rec.709 V2.0](https://www.dji.com/cn/downloads/softwares/osmo-pocket-4-dlog-to-rec709-lut-2) | Osmo Pocket 4 | v2.0 · 2026-09-24 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/HG214%20Lut/DJI%20OSMO%20Pocket%204%20D-Log%20to%20Rec.709%20V2.0.cube) | 1 | 当前记录 |
| 官方页面数据 | [DJI OSMO Pocket 4 D-Log to Rec.709](https://www.dji.com/cn/downloads/softwares/osmo-pocket-4-dlog-to-rec709-lut) | Osmo Pocket 4 | v1.0 · 2026-04-16 | [cube/mac_os、windows](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/HG214%20Lut/DJI%20OSMO%20Pocket%204%20D-Log%20to%20Rec.709%20V1.0.cube) | 1 | 已被 [osmo-pocket-4-dlog-to-rec709-lut-2](https://www.dji.com/cn/downloads/softwares/osmo-pocket-4-dlog-to-rec709-lut-2) 取代 |

## ZIP 包成员核验

表中的网格与 1D 长度由 ZIP 成员本身解析；验证检查 Cube 指令、声明维度、数据行数量及 RGB 数值有限性。三个 creative LUT 的 `TITLE` 注释含 GBK 编码字节，不能严格按 UTF-8 解码；Action 5 Pro Zhu 的 GBK 标题字节恰好也能通过 UTF-8 解码，但会显示为乱码。标题不参与数值解析，所有文件保留官方原始字节，摘要也按原始字节计算。

| DJI 页面 | 成员数 | ZIP SHA-256 | 已检查的成员、维度与 SHA-256 前缀 |
| --- | ---: | --- | --- |
| [DJI OSMO Action 5 Pro Rec.709 to Color Grading LUTs](https://www.dji.com/cn/downloads/softwares/dji-osmo-action-5-pro-rec-709-to-color-grading-luts) | 4 | `db76e1d80ecf…` | `DJI OSMO Action 5 Pro Mei.cube` (64³, SHA-256 `7b52bfd161a5…`)<br>`DJI OSMO Action 5 Pro Ju.cube` (65³, SHA-256 `225f8f130e82…`)<br>`DJI OSMO Action 5 Pro Zhu.cube` (64³, SHA-256 `1e9d91db323c…`)<br>`DJI OSMO Action 5 Pro Lan.cube` (64³, SHA-256 `c05a85cb5bf9…`) |
| [DJI OSMO Action 4 Rec.709 to Color Grading LUTs](https://www.dji.com/cn/downloads/softwares/dji-osmo-action-4-rec-709-to-color-grading-luts) | 3 | `75dbe8c4548c…` | `DJI OSMO Action 4 Ice Pro.cube` (65³, SHA-256 `1f3460ec7fcd…`)<br>`DJI OSMO Action 4 Nature Pro.cube` (65³, SHA-256 `4140fb49ba2e…`)<br>`DJI OSMO Action 4 Forest Pro.cube` (65³, SHA-256 `31c0b9bc886f…`) |
| [DJI OSMO Pocket 3 Rec.709 to Color Grading LUTs](https://www.dji.com/cn/downloads/softwares/dji-osmo-pocket-3-rec-709-to-color-grading-luts) | 4 | `8ff5e3d8621a…` | `DJI OSMO Pocket 3 Spring Pro.cube` (32³, SHA-256 `e09d7c59e621…`)<br>`DJI OSMO Pocket 3 Summer Pro.cube` (17³, SHA-256 `5e478e5a6630…`)<br>`DJI OSMO Pocket 3 Autumn Pro.cube` (16³, SHA-256 `8ccb5068a5a8…`)<br>`DJI OSMO Pocket 3 Winter Pro.cube` (64³, SHA-256 `ad3a79ed2e6d…`) |
| [Inspire 1/Zenmuse X5R Dlog to sRGB 3DLUT](https://www.dji.com/cn/downloads/softwares/transcoding-zenmuse-x5r) | 5 | `69161b1c6b5d…` | `DJI_X5_DLOG2sRGB.cube` (33³, SHA-256 `52f580aa926c…`)<br>`DJI_X5_DLOG2sRGB_before20160401Firmware.cube` (33³, SHA-256 `ae161ebe8a76…`)<br>`DJI_X5_DLOG2sRGB_Improv.cube` (33³, SHA-256 `e9d1679b043a…`)<br>`gamma18TosRGB.cube` (1D 4096, SHA-256 `bbd13277286f…`)<br>`gamma22TosRGB.cube` (1D 4096, SHA-256 `e6b2caccc82e…`) |
| [Zenmuse Linear to D-Log LUT](https://www.dji.com/cn/downloads/softwares/transcoding-zenmuse-x7-linear) | 1 | `ffc0df94103d…` | `Linear to D-Log.cube` (1D 4096, SHA-256 `4be0a4b14b5a…`) |
| [Zenmuse D-Log to Rec.709 LUT](https://www.dji.com/cn/downloads/softwares/transcoding-zenmuse-x7-rec) | 1 | `2c484740aa04…` | `D-Log to Rec709.cube` (33³, SHA-256 `0a576b299d8c…`) |
| [Phantom 4 Dlog 3DLUT](https://www.dji.com/cn/downloads/softwares/transcoding-phantom-4) | 3 | `7f6aa2ea8589…` | `DJI_Phantom4_DLOG2Rec709.cube` (33³, SHA-256 `606a69301f10…`)<br>`DJI_Phantom4_DLOG2sRGB.cube` (33³, SHA-256 `9dd3349e4480…`)<br>`DJI_Phantom4_DLOG2sRGB_Improv.cube` (33³, SHA-256 `981cde1e56e4…`) |
| [Phantom 3 Dlog to sRGB 3DLUT](https://www.dji.com/cn/downloads/softwares/transcoding-phantom-3) | 4 | `1bfeee29d93c…` | `DJI_Phantom3_DLOG2sRGB.cube` (1D 1024, SHA-256 `4c90431f568e…`)<br>`DJI_Phantom3_DLOG2sRGB_Improv.cube` (33³, SHA-256 `104f201d0c0c…`)<br>`gamma18TosRGB.cube` (1D 4096, SHA-256 `bbd13277286f…`)<br>`gamma22TosRGB.cube` (1D 4096, SHA-256 `e6b2caccc82e…`) |

## 自动映射清单

自动映射仅表示本应用具备精确 camera/profile/look 的 Log→Rec.709 3D Cube 路径。它不表示所有视频一定有可读的相机元数据；运行时仍需相机识别、Gamma 证据和文件探测通过。Creative Rec.709 LUT、sRGB/Rec.2020 HLG 变换、Linear→D-Log、1D 曲线及无法精确识别的设备只保留在资产库。

| 相机 ID / 官方机型 | 输入 profile | Look | DJI 版号 | 网格 | 官方页面 |
| --- | --- | --- | --- | ---: | --- |
| `action4` (Osmo Action 4) | `dlogm` | `vivid` | 1.0 | 33 | [DJI OSMO Action 4 D-Log M to Rec.709 vivid LUT](https://www.dji.com/cn/downloads/softwares/dji-osmo-action-4-d-log-m-to-rec-709-vivid-lut) |
| `action5pro` (Osmo Action 5 Pro) | `dlogm` | `vivid` | 1.0 | 33 | [DJI OSMO Action 5 Pro D-Log M to Rec.709 vivid LUT](https://www.dji.com/cn/downloads/softwares/dji-osmo-action-5-pro-d-log-m-to-rec-709-vivid-lut) |
| `action6` (Osmo Action 6) | `dlogm` | `standard` | 1.0 | 33 | [DJI OSMO Action 6 D-LogM to Rec.709 LUT](https://www.dji.com/cn/downloads/softwares/dji-osmo-action-6-d-log-m-to-rec-709-lut) |
| `air2s` (DJI Air 2S) | `dlogm` | `standard` | 未标版本 | 33 | [DJl Mavic 2/Air 2s D-Log M to Rec709 LUT](https://www.dji.com/cn/downloads/softwares/dlog-m-to-rec709-lut) |
| `air3` (DJI Air 3) | `dlogm` | `standard` | 1.0 | 33 | [DJI Air 3 DJI D-Log M to Rec.709](https://www.dji.com/cn/downloads/softwares/air-3-dlog-to-rec709) |
| `air3s` (DJI Air 3S) | `dlogm` | `standard` | 1.0 | 33 | [DJI Air 3s DJI D-Log M to Rec.709](https://www.dji.com/cn/downloads/softwares/air-3s-dlog-to-rec709) |
| `avata2` (DJI Avata 2) | `dlogm` | `standard` | 1.0 | 33 | [DJI Avata 2 DJI D-Log M to Rec.709](https://www.dji.com/cn/downloads/softwares/avata-2-dlog-to-rec709) |
| `avata360` (DJI Avata 360) | `dlogm` | `standard` | 1.0 | 33 | [DJI Avata 360 D-Log M to Rec.709 LUT](https://www.dji.com/cn/downloads/softwares/avata-360-dlog-m-to-rec709-lut) |
| `flip` (DJI Flip) | `dlogm` | `standard` | 1.0 | 33 | [DJI Flip D-Log M to Rec.709](https://www.dji.com/cn/downloads/softwares/flip-dlog-to-rec709) |
| `inspire3` (DJI Inspire 3) | `dlog` | `standard` | 1.0 | 33 | [禅思 X9 D-Log to Rec.709 LUT](https://www.dji.com/cn/downloads/softwares/dji-zenmuse-x9-dlog2rec709-lut) |
| `litox1` (DJI Lito X1) | `dlogm` | `standard` | 1.0 | 33 | [DJI Lito X1 D-Log M to Rec.709 LUT](https://www.dji.com/cn/downloads/softwares/lito-x1-dlog-m-to-rec709-lut) |
| `mavic2pro` (DJI Mavic 2 Pro) | `dlogm` | `standard` | 未标版本 | 33 | [DJl Mavic 2/Air 2s D-Log M to Rec709 LUT](https://www.dji.com/cn/downloads/softwares/dlog-m-to-rec709-lut) |
| `mavic3` (DJI Mavic 3) | `dlog` | `standard` | 1.0 | 33 | [DJI Mavic 3 D-Log to Rec.709 LUT](https://www.dji.com/cn/downloads/softwares/transcoding-mavic-3) |
| `mavic3` (DJI Mavic 3) | `dlog` | `vivid` | 1.0 | 33 | [DJI Mavic 3 D-Log to Rec.709 vivid LUT](https://www.dji.com/cn/downloads/softwares/vivid-lut) |
| `mavic3` (DJI Mavic 3) | `dlogm` | `standard` | 1.0 | 33 | [DJI Mavic 3 D-Log M to Rec.709 LUT](https://www.dji.com/cn/downloads/softwares/dji-mavic-3-d-log-m-709-lut) |
| `mavic3classic` (DJI Mavic 3 Classic) | `dlog` | `standard` | 1.0 | 33 | [DJI Mavic 3 D-Log to Rec.709 LUT](https://www.dji.com/cn/downloads/softwares/transcoding-mavic-3) |
| `mavic3classic` (DJI Mavic 3 Classic) | `dlog` | `vivid` | 1.0 | 33 | [DJI Mavic 3 D-Log to Rec.709 vivid LUT](https://www.dji.com/cn/downloads/softwares/vivid-lut) |
| `mavic3classic` (DJI Mavic 3 Classic) | `dlogm` | `standard` | 1.0 | 33 | [DJI Mavic 3 D-Log M to Rec.709 LUT](https://www.dji.com/cn/downloads/softwares/dji-mavic-3-d-log-m-709-lut) |
| `mavic3pro` (DJI Mavic 3 Pro) | `dlog` | `standard` | 1.0 | 33 | [DJI Mavic 3 D-Log to Rec.709 LUT](https://www.dji.com/cn/downloads/softwares/transcoding-mavic-3) |
| `mavic3pro` (DJI Mavic 3 Pro) | `dlog` | `vivid` | 1.0 | 33 | [DJI Mavic 3 D-Log to Rec.709 vivid LUT](https://www.dji.com/cn/downloads/softwares/vivid-lut) |
| `mavic3pro` (DJI Mavic 3 Pro) | `dlogm` | `standard` | 1.0 | 33 | [DJI Mavic 3 D-Log M to Rec.709 LUT](https://www.dji.com/cn/downloads/softwares/dji-mavic-3-d-log-m-709-lut) |
| `mavic4pro` (DJI Mavic 4 Pro) | `dlog` | `standard` | 1.0 | 33 | [DJI Mavic 4 Pro D-Log to Rec.709 LUT](https://www.dji.com/cn/downloads/softwares/mavic-4-pro-dlog-to-rec709-lut) |
| `mavic4pro` (DJI Mavic 4 Pro) | `dlog` | `vivid` | 1.0 | 33 | [DJI Mavic 4 Pro D-Log to Rec.709 vivid LUT](https://www.dji.com/cn/downloads/softwares/mavic-4-pro-dlog-to-rec709-vivid-lut) |
| `mavic4pro` (DJI Mavic 4 Pro) | `dlogm` | `standard` | 1.0 | 33 | [DJI Mavic 4 Pro D-Log M to Rec.709 LUT](https://www.dji.com/cn/downloads/softwares/mavic-4-pro-dlog-m-to-rec709-lut) |
| `mini4pro` (DJI Mini 4 Pro) | `dlogm` | `standard` | 1.0 | 33 | [DJI Mini 4 Pro DJI D-Log M to Rec.709](https://www.dji.com/cn/downloads/softwares/mini-4-pro-dlog-to-rec709) |
| `mini5pro` (DJI Mini 5 Pro) | `dlogm` | `standard` | 1.0 | 33 | [DJI Mini 5 Pro D-Log M to Rec.709 LUT](https://www.dji.com/cn/downloads/softwares/mini-5-pro-dlog-m-to-rec709-lut) |
| `o4airunit` (DJI O4 Air Unit) | `dlogm` | `standard` | 1.0 | 33 | [DJI O4 Air Unit 系列 D-Log M to Rec.709](https://www.dji.com/cn/downloads/softwares/o4-air-unit-dlog-to-rec709) |
| `osmo360` (Osmo 360) | `dlogm` | `standard` | 1.0 | 33 | [DJI Osmo 360 D-Log M to Rec.709 LUT](https://www.dji.com/cn/downloads/softwares/osmo-360-dlog-m-to-rec709-lut) |
| `osmo360ii` (Osmo 360 II) | `dlogm` | `standard` | 1.0 | 33 | [DJI Osmo 360 D-Log M to Rec.709 LUT](https://www.dji.com/cn/downloads/softwares/osmo-360-dlog-m-to-rec709-lut) |
| `osmonano` (Osmo Nano) | `dlogm` | `vivid` | 1.0 | 33 | [DJI Osmo Nano D-Log M to Rec.709 vivid LUT](https://www.dji.com/cn/downloads/softwares/osmo-nano-d-log-m-to-rec-709-vivid-lut) |
| `phantom4` (Phantom 4) | `dlog` | `standard` | 未标版本 | 33 | [Phantom 4 Dlog 3DLUT — DJI_Phantom4_DLOG2Rec709.cube](https://www.dji.com/cn/downloads/softwares/transcoding-phantom-4) |
| `phantom4advanced` (Phantom 4 Advanced) | `dlog` | `standard` | 未标版本 | 33 | [Phantom 4 Dlog 3DLUT — DJI_Phantom4_DLOG2Rec709.cube](https://www.dji.com/cn/downloads/softwares/transcoding-phantom-4) |
| `phantom4pro` (Phantom 4 Pro) | `dlog` | `standard` | 未标版本 | 33 | [Phantom 4 Dlog 3DLUT — DJI_Phantom4_DLOG2Rec709.cube](https://www.dji.com/cn/downloads/softwares/transcoding-phantom-4) |
| `phantom4prov2` (Phantom 4 Pro V2.0) | `dlog` | `standard` | 未标版本 | 33 | [Phantom 4 Dlog 3DLUT — DJI_Phantom4_DLOG2Rec709.cube](https://www.dji.com/cn/downloads/softwares/transcoding-phantom-4) |
| `pocket3` (Osmo Pocket 3) | `dlogm` | `standard` | 1.0 | 33 | [DJI OSMO Pocket 3 D-Log M to Rec.709](https://www.dji.com/cn/downloads/softwares/osmo-pocket-3-dlog-to-rec709) |
| `pocket4` (Osmo Pocket 4) | `dlog` | `standard` | 2.0 | 33 | [DJI OSMO Pocket 4 D-Log to Rec.709 V2.0](https://www.dji.com/cn/downloads/softwares/osmo-pocket-4-dlog-to-rec709-lut-2) |
| `pocket4` (Osmo Pocket 4) | `dlog` | `vivid` | 2.0 | 33 | [DJI OSMO Pocket 4 D-Log to Rec.709 vivid V2.0](https://www.dji.com/cn/downloads/softwares/osmo-pocket-4-dlog-to-rec709-lut-vivid-2) |
| `pocket4p` (Osmo Pocket 4P) | `dlog` | `standard` | 2.0 | 33 | [DJI OSMO Pocket 4P D-Log to Rec.709 V2.0 size33](https://www.dji.com/cn/downloads/softwares/osmo-pocket-4p-dlog-to-rec709-lut-size33-2) |
| `pocket4p` (Osmo Pocket 4P) | `dlog` | `vivid` | 2.0 | 33 | [DJI OSMO Pocket 4P D-Log to Rec.709 vivid V2.0 size33](https://www.dji.com/cn/downloads/softwares/osmo-pocket-4p-dlog-to-rec709-lut-vivid-size33-2) |
| `pocket4p` (Osmo Pocket 4P) | `dlog2` | `standard` | 1.0 | 65 | [DJI OSMO Pocket 4P D-Log2 to Rec.709 size65](https://www.dji.com/cn/downloads/softwares/osmo-pocket-4p-dlog-2-to-rec709-lut-size65) |
| `pocket4p` (Osmo Pocket 4P) | `dlog2` | `vivid` | 1.0 | 65 | [DJI OSMO Pocket 4P D-Log2 to Rec.709 vivid size65](https://www.dji.com/cn/downloads/softwares/osmo-pocket-4p-dlog-2-to-rec709-lut-vivid-size65) |
| `ronin4d` (DJI Ronin 4D) | `dlog` | `standard` | 1.0 | 33 | [禅思 X9 D-Log to Rec.709 LUT](https://www.dji.com/cn/downloads/softwares/dji-zenmuse-x9-dlog2rec709-lut) |
| `zenmusex5s` (Zenmuse X5S) | `dlog` | `standard` | 未标版本 | 33 | [Zenmuse D-Log to Rec.709 LUT — D-Log to Rec709.cube](https://www.dji.com/cn/downloads/softwares/transcoding-zenmuse-x7-rec) |
| `zenmusex7` (Zenmuse X7) | `dlog` | `standard` | 未标版本 | 33 | [Zenmuse D-Log to Rec.709 LUT — D-Log to Rec709.cube](https://www.dji.com/cn/downloads/softwares/transcoding-zenmuse-x7-rec) |

### 机型与 Gamma 证据

`Mavic 2/Air 2S` 目录标题本身不足以限定 Mavic 2 子型号。DJI 的 [LUT 详情页](https://www.dji.com/downloads/softwares/dlog-m-to-rec709-lut) 提供同一 D-Log M 到 Rec.709 文件；[官方 LUT 支持矩阵](https://repair.dji.com/help/content?customId=01700007105&lang=en&paperDocType=ARTICLE&re=US&spaceId=17) 将 D-Log M 与 Mavic 2 Pro、Air 2S 对应，并将 Mavic 2 Zoom 标为 D-Cinelike；[Mavic 2 FAQ](https://www.dji.com/support/product/mavic-2?from=nav&site=brandsite) 也说明 DLog-M 为 Mavic 2 Pro 相机设计。因此只生成 `mavic2pro` 与 `air2s` 自动映射，不把 LUT 套到 Mavic 2 Zoom。

同一份 DJI [LUT 支持矩阵](https://repair.dji.com/help/content?customId=01700007105&lang=en&paperDocType=ARTICLE&re=US&spaceId=17) 明确列出 Phantom 4 Advanced、Phantom 4 Pro 和 Phantom 4 Pro V2.0 可使用 Phantom 4 LUT。因此这三个机型与 Phantom 4 共用已核验的 Rec.709 restore Cube；目录仍为每个相机 ID 分别登记映射。

DJI 支持矩阵也用于核对当前产品的 D-Log / D-Log M 区分。每个 LUT 文件仍保留官方页面标题；相同 SHA-256 只说明下载字节一致，不推断不同机型应采用相同成像管线。

## 字节、格式与复用说明

当前登记的 LUT 载荷（包括 ZIP 包内成员）均为 `.cube` 文本；8 个官方页面以 ZIP 容器交付。目录标题中“3DLUT”是产品描述；实际 ZIP 成员扩展名和文件内容仍是 `.cube`。库内既有 3D Cube，也有 1D Cube；当前自动引擎只接收 3D Cube。软件页的 Windows/macOS 下载链接有时重复同一 URL 或字节，库按 SHA-256 共享单个文件名，同时保留各页面、平台和机型标签。

Phantom 4 官方 Cube 含有 `LUT_3D_INPUT_RANGE` 标量范围头。应用会先校验原始文件与清单 SHA-256，再生成供 FFmpeg 使用的临时副本，把该范围转换成三个通道各自相同的 `DOMAIN_MIN` / `DOMAIN_MAX`；原始 DJI Cube 字节和摘要保持不变。

多个官方页面标签对应完全相同的 D-Log M 文件；例如 33³ `b18162854ab47702068410c33afa98a8cb6eef159fc5a04ce0e65fad0fd8947e` 这一字节串出现在多个 DJI 页面下载中。源文件的注释指向 Mavic 3 Pro D-Log M。库保留每个官方标题和精确来源链接，但不宣称所有这些页面所标机型具有独立调谐的文件。

当前 Git 库只登记元数据、SHA-256、格式和来源；实际 `.cube` 文件由本地离线资源准备流程导入，并在打包前重新核验。DJI 下载/帮助页面没有给出这些 LUT 在第三方应用内再分发的明确授权；本次目录核对不构成再分发许可。

## 相关文件

- [可浏览的 DJI LUT 资产库](../assets/library.json)
- [自动 Log→Rec.709 目录](../assets/catalog.json)
- [源文件摘要与归属说明](../assets/SOURCES.md)
