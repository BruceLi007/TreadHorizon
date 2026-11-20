# public/fonts 字体许可说明

本目录随 Tread Horizon 仓库发布 **7 款 SIL Open Font License 1.1（OFL-1.1）** 字体；
它们作为界面可选字体分发。使用、复制、再分发或嵌入时请遵守 OFL，保留版权声明与本许可文件。
字体仅用于界面显示，不参与用户数据 / 备份。

> **2026-11-20 D-549（修改说明，必读）**：本目录现在放的是**子集化 + woff2 转换后的修改版**，
> 不再是上游原始文件。改法：裁成「BMP 全部汉字 20902 + ASCII + CJK/全角标点 +
> 本应用 UI 文案」共 21278 字，转 woff2；7 款合计 **15.9 MB**（改前 65.3 MB）。
> 每款另有 `<id>.preview.v1.woff2`（**同样是子集修改版**，只含设置里选项名 + 示例文案，9~34 KB，
> 7 款合计 0.12 MB）—— 用来让设置里的字体选项显示自身字形，又不必加载整款字体。
> 依据 OFL：
> - 子集 / 转格式属于 OFL 定义的 **Modified Version**，**不得沿用保留字体名**，所以 7 款的内部字体名
>   已统一改为 `TM UI Miao / Maoken / Jingnan / Childfun / Tiejili / Dymon / Zihun`（CSS 里也用这套名字）；
> - 版权声明、许可证字段（name 表 ID 0/7/8/13/14）**原样保留**，本文件与下面的 OFL 全文随字体一起分发；
> - 上游原始文件（ttf/otf）**不随发布包分发**，只留在仓库的 `assets/fonts-original/` 供重新生成使用；
>   生成脚本 `backup/tools/build-fonts.py` 也不进发布包。需要原始文件请到下列各来源地址下载。
>
> 如果你要再分发本目录的字体，请连同本文件一起分发，并保留 `TM UI …` 这套改名后的族名。

## 1. 喵咛狗爬黑 / Miorning Goupa Hei（内置界面字体；2026-11-10 D-359 起默认字体改为「猫啃什锦黑」）

- 文件：`miao-goupa-hei.v1.woff2`（子集修改版；源文件 `miao-goupa-hei.ttf`，34.1 MB）
- 版权：Copyright (c) 2026, MIORNING (喵咛).
- 设计：MIORNING / AI-assisted type design and construction
- 许可：SIL Open Font License, Version 1.1（https://openfontlicense.org）

## 2. 猫啃什锦黑 / Maoken Assorted Sans（默认界面字体，2026-11-10 D-359 起；2026-11-08 D-298 新增）

- 文件：`maoken-shijin-hei.v1.woff2`（子集修改版；源文件 `maoken-shijin-hei.ttf`，完整版 32,598 字形）
- 版权：Copyright (c) 2022-11-02, ZERO子 (https://github.com/Skr-ZERO)，with Reserved Font Name “Assorted”“什锦”；Copyright (c) 2022-11-01, Umihotaru (https://umihotaru.work/)
- 来源：https://github.com/maoken-fonts/MaokenAssortedSans
- 许可：SIL Open Font License, Version 1.1
- 说明：**已修改（子集 + woff2）**，因此按 OFL 第 3 条**不再使用保留字体名**「什锦 / Assorted」，
  内部族名改为 `TM UI Maoken`；版权 / 许可字段保留。

## 3. 荆南波波黑 / Jingnan Bobohei（2026-11-08 D-298 新增）

- 文件：`jingnan-bobohei.v1.woff2`（子集修改版；源文件 `jingnan-bobohei.ttf`，简体版 Bold）
- 版权：(c) Copyright Shanghai Etrump Information Technology Co.
- 来源：https://github.com/maoken-fonts/KNBobohei（猫啃网介绍页 https://www.maoken.com/freefonts/14257.html）
- 许可：SIL Open Font License, Version 1.1（作者 / 猫啃网 / 100font 页面均标注 OFL 1.1）
- 说明：源文件内未嵌 license 元数据，授权以作者公开声明为准；**已修改（子集 + woff2）**，族名改为 `TM UI Jingnan`。

## 4. 游趣体 / Child Fun Sans（2026-11-08 D-298 新增）

- 文件：`childfun-sans.v1.woff2`（子集修改版；源文件 `childfun-sans.ttf`）
- 版权：Copyright 2023-2024 Des-Magmeta (https://github.com/Des-Magmeta/ChildFunSans)；Copyright 2020 The Stick Project Authors (https://github.com/fontworks-fonts/Stick)
- 来源：https://github.com/Des-Magmeta/ChildFunSans（猫啃网介绍页 https://www.maoken.com/freefonts/22430.html）
- 许可：SIL Open Font License, Version 1.1
- 说明：**已修改（子集 + woff2）**，族名改为 `TM UI Childfun`。

## 5. 铁蒺藜体 / Tiejili SC（2026-11-08 D-298 新增）

- 文件：`tiejili-sc.v1.woff2`（子集修改版；源文件 `tiejili-sc.otf`）
- 版权：Copyright © 2022 Buernia (https://github.com/Buernia). Portions Copyright © 2020 The Reggae Project Authors (https://github.com/fontworks-fonts/Reggae). 'Tiejili' 与 '铁蒺藜' 为 Buernia 的商标。
- 来源：https://github.com/Buernia/Tiejili
- 许可：SIL Open Font License, Version 1.1
- 说明：**已修改（子集 + woff2）**，族名改为 `TM UI Tiejili`；商标声明保留，不用于推广。

## 6. 呆萌手写体 / Dymon ShouXieTi（2026-11-08 D-298 新增）

- 文件：`dymon-shouxieti.v1.woff2`（子集修改版；源文件 `dymon-shouxieti.otf`）
- 版权：Copyright 2025 K99Xmas (https://space.bilibili.com/350875102)
- 来源：猫啃网介绍页 https://www.maoken.com/freefonts/25915.html
- 许可：SIL Open Font License, Version 1.1（源文件元数据内嵌 OFL 声明）
- 说明：**已修改（子集 + woff2）**，族名改为 `TM UI Dymon`。

## 7. 字魂扁桃体 / ZiHun Biantaoti（2026-11-08 D-298 新增）

- 文件：`zihun-biantaoti.v1.woff2`（子集修改版；源文件 `zihun-biantaoti.ttf`）
- 版权：Copyright Shanghai ZiHun Network Technology Co.,Ltd.（字魂）
- 来源：https://izihun.com/shangyongziti/7495.html（基于得意黑 Smiley Sans 二次创作，得意黑本身为 SIL OFL 1.1）
- 许可：SIL Open Font License, Version 1.1（字魂官方页面声明以 OFL 1.1 发表）
- 说明：源文件内未嵌 license 元数据，授权以官方页面声明为准；**已修改（子集 + woff2）**，族名改为 `TM UI Zihun`。

## 说明

- **2026-11-20 D-549 起，以上 7 款都是「子集 + woff2」的修改版**（内部族名统一改为 `TM UI …`，见本文件开头的修改说明）；
  修改版仍整体适用 OFL：可商用、可再分发，但必须保留版权与许可声明，且不得使用原字体的保留名称。
- **2026-11-08 D-299（用户要求「嗷呜碎瘾黑彻底删除」）**：原随仓库发布的 **嗷呜碎瘾黑 / Howl Shattered Display**
  （`aowu-suiyin-hei.ttf`，SIL OFL 1.1）已从本目录与设置选项里删除；该字体版权行保留在此供历史核对：
  Copyright 2026 howlingFounts (https://github.com/howlingFounts). Copyright 2022-2023 The Unbounded Sans Project Authors
  (https://github.com/NightFurySL2001/unbounded-sans). Copyright 2020 The Dela Sans Project Authors
  (https://github.com/syakuzen/DelaGothic).
- 上游原始字体文件（ttf/otf，共 65.3 MB）**不在本目录、也不在发布包里**，只保存在本机工作区的 `assets/fonts-original/`
  （已进 `.gitignore`，不进仓库，由 `backup/tools/build-fonts.py` 用来重新生成子集）；需要原始文件也可按上面各「来源」地址下载。
- 仓库不再附带其他第三方字体：乐米栀夏浅风体 / 乐米清砚方墨体（© 杭州乐米网络科技有限公司 All rights reserved）
  与方塘像素体（来源授权不明）因授权原因**未随公开仓库发布**。
- 系统字体（微软雅黑 / 宋体 / 黑体 / 楷体）为操作系统自带，不随本仓库分发。

---

## SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007

SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.
The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.
DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).
"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.
PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.
2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.
3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.
4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.
5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.
DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
