# DJI LUT source and asset notes

The catalog records four Osmo Pocket 4P LUTs and five DJI D-Log M LUTs. Their `.cube` payloads are ignored local build inputs and are not included in a clean Git checkout. DJI's support matrix and official download pages were used to register model/profile/look combinations. Camera keys in `catalog.json` (`pocket4p`, `pocket3`, `action4`, `action5pro`, `air3s`, `air3`) are this application's canonical product-name keys; they are not DJI-published metadata codes.

## Official references

- [DJI LUT download library](https://www.dji.com/lut) lists the Pocket 4P D-Log and D-Log 2 LUT variants and the D-Log M LUT downloads used below.
- [DJI support: models that support D-Log and availability of official LUT files](https://repair.dji.com/help/content?customId=01700007105&lang=en&paperDocType=ARTICLE&re=US&spaceId=17) identifies whether each model has a LUT and gives its official restore LUT name. It lists Pocket 3, Action 5 Pro, Action 4, Air 3S and Air 3 with their D-Log M LUTs; Pocket 4P is listed with separate D-Log and D-Log 2 LUTs.
- Product download pages confirm the source label, look, version and `.cube` format: [Osmo Pocket 3](https://www.dji.com/osmo-pocket-3/downloads), [Osmo Action 5 Pro](https://www.dji.com/osmo-action-5-pro/downloads), [Osmo Action 4](https://www.dji.com/osmo-action-4/downloads), [DJI Air 3S](https://www.dji.com/air-3s/downloads), and [DJI Air 3](https://www.dji.com/air-3/downloads).

## Catalog matrix

| Camera key | Profile | Look | Official DJI label |
| --- | --- | --- | --- |
| `pocket4p` | `dlog` | `standard` | DJI OSMO Pocket 4P D-Log to Rec.709 V2.0, 33-point |
| `pocket4p` | `dlog` | `vivid` | DJI OSMO Pocket 4P D-Log to Rec.709 vivid V2.0, 33-point |
| `pocket4p` | `dlog2` | `standard` | DJI OSMO Pocket 4P D-Log2 to Rec.709 V1.0, 65-point |
| `pocket4p` | `dlog2` | `vivid` | DJI OSMO Pocket 4P D-Log2 to Rec.709 vivid V1.0, 65-point |
| `pocket3` | `dlogm` | `standard` | DJI OSMO Pocket 3 D-Log M to Rec.709 V1.0 |
| `action5pro` | `dlogm` | `vivid` | DJI OSMO Action 5 Pro D-Log M to Rec.709 vivid LUT V1.0 |
| `action4` | `dlogm` | `vivid` | DJI OSMO Action 4 D-Log M to Rec.709 vivid LUT V1.0 |
| `air3s` | `dlogm` | `standard` | DJI Air 3s D-Log M to Rec.709 V1.0 |
| `air3` | `dlogm` | `standard` | DJI Air 3 D-Log M to Rec.709 V1.0 |

There are no implicit style fallbacks in the manifest. For example, Action 4 and Action 5 Pro have only an official `vivid` entry here; Pocket 3, Air 3S and Air 3 have only an official `standard` entry. An unavailable tuple should remain unavailable.

## Download URLs and byte checks

Each D-Log M asset below was fetched from the direct `.cube` URL exposed by its linked DJI product downloads page. The exact URLs are also stored in `catalog.json`.

| Camera | DJI download page | Direct DJI asset |
| --- | --- | --- |
| `pocket3` | [Osmo Pocket 3 downloads](https://www.dji.com/osmo-pocket-3/downloads) | [DJI OSMO Pocket 3 D-Log M to Rec.709 V1.cube](https://www-dl.djicdn.com/5e45168b46b342d5b88f72c458ba6e79/OP3%20LUT%E6%96%87%E4%BB%B6%E7%89%B9%E6%AE%8A%E5%A4%84%E7%90%86/DJI%20OSMO%20Pocket%203%20D-Log%20M%20to%20Rec.709%20V1.cube) |
| `action5pro` | [Osmo Action 5 Pro downloads](https://www.dji.com/osmo-action-5-pro/downloads) | [DJI OSMO Action 5 Pro D-Log M to Rec.709 V1.cube](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/AC204%E8%BD%AF%E4%BB%B6/DJI%20OSMO%20Action%205%20Pro%20D-Log%20M%20to%20Rec.709%20V1.cube) |
| `action4` | [Osmo Action 4 downloads](https://www.dji.com/osmo-action-4/downloads) | [DJI OSMO Action 4 D-Log M to Rec.709 V1.cube](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/203/DJI%20OSMO%20Action%204%20D-Log%20M%20to%20Rec.709%20V1.cube) |
| `air3s` | [DJI Air 3S downloads](https://www.dji.com/air-3s/downloads) | [DJI Air 3S D-Log M to Rec.709 V1.cube](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/234_lut/DJI%20Air%203S%20%20D-Log%20M%20to%20Rec.709%20V1_.cube) |
| `air3` | [DJI Air 3 downloads](https://www.dji.com/air-3/downloads) | [DJI Air 3 D-Log M to Rec.709 V1.cube](https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/DJI%20Air%203%20Lut/DJI%20Air%203%20D-Log%20M%20to%20Rec.709%20V1_.cube) |

The registered files were parsed as 3D `.cube` LUTs. Their grids contain 33³ (35,937) or 65³ (274,625) finite RGB rows, as recorded in the catalog. Each of the five D-Log M downloads has SHA-256 `b18162854ab47702068410c33afa98a8cb6eef159fc5a04ce0e65fad0fd8947e` (1,042,315 bytes). The upstream ETags and downloaded bytes also match across these five URLs.

The identical D-Log M payload is a source-side limitation: although DJI's individual product pages label the files for the distinct camera/look combinations above, each downloaded cube has the same contents, and its embedded comment reads `Mavic 3 Pro, D-Log M, 2023-03-24`. The manifest retains the official per-product labels and exact source URLs, but does not claim that the payloads are uniquely tuned for those cameras or that the `standard` and `vivid` versions differ numerically. The app should still select only the exact registered camera/profile/look tuple.

## Attribution and redistribution

The LUTs are DJI-authored downloads and are attributed to DJI in the catalog. The inspected download and support pages did not provide a LUT-specific license or an explicit grant to redistribute the files in a third-party application. Redistribution rights therefore remain unknown. Source checkouts omit the `.cube` bytes; local package preparation obtains or imports them and verifies the registered SHA-256 values. This process does not grant permission to redistribute the resulting package.
