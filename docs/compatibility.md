# 查看器兼容性记录（Word / WPS / LibreOffice）

> 建档：2026-07-10。目的：把 Word、WPS 和 LibreOffice 的已知差异收拢成单一清单，交付前按目标查看器过一遍。
>
> 口径：**Word = Windows 桌面版**（人工验收基准）；**LO = LibreOffice**（预览/PDF 转换走它——`preview:true`、`npm run visual`、`pdf:true` 看到的都是 LO 行为）；WPS 为国内常见查看器。「未验证」= 没有实测记录，别当结论用。
>
> 新差异的记录纪律：实测后加进本文件对应节（带日期与来源），影响使用建议的同步进 `get_examples` 场景判断；库的 bug 另记 `docs/upstream-issues.md`。

## 1. 域（Field）能力 —— 三端差异最大的一类

Word 域没有缓存内容时需要「更新域」才出结果；WPS/LO 对 `updateFields` 的态度各不相同。

| 能力 | Word | WPS | LibreOffice | 记录 |
|---|---|---|---|---|
| native toc（TOC 域，`toc.native:true`） | 打开提示更新域后出页码 | 一直空白 | 一直空白 | 探针验证 2026-07-07 |
| `{{pageRef:id}}`（PAGEREF 域） | 更新域后出页码，可点跳转（2026-07-09 验收通过） | 一直空白 | 应用内空白；**转 PDF 时会更新出真页码** | 探针 + 人工验收 |
| SECTIONPAGES（节内总页） | 正常 | 不渲染（空白） | 不渲染（空白） | 探针实测 |
| PAGE / NUMPAGES（当前页/总页） | 正常 | 正常 | 正常 | 页脚页码长期使用 |

使用约定（校验器已把关）：

- **pageRef / native toc 只在 `meta.target:"word"` 用**——`pageref-viewer` warn 兜底。收件人查看器不确定时：目录用默认静态 toc（无页码但任何端可见可跳），页码引用不用。
- **别被 PNG 预览骗**：LO 转 PDF 会更新 PAGEREF，预览里能看到真页码 ≠ universal 安全——WPS/LO 直接打开 docx 仍是空白，Word 首开也要更新域。
- **重启页码的节去掉「共x页」是有意取舍**：SECTIONPAGES 两端不渲染，NUMPAGES 对重启节是「第1页 共58页」的错觉，索性只留「第x页」（前置页惯例本就不标总页）。

## 2. 内容能力

| 能力 | Word | WPS | LibreOffice | 记录 |
|---|---|---|---|---|
| 脚注（真实内容，非域） | 正常 | 正常 | 正常 | implementation record |
| 批注（`textOptions.comment`） | 气泡可见 | 气泡可见 | 应用内可见；**导出 PDF 默认不带**（预览 PNG 看不到属正常） | implementation record |
| 复选框（w14:checkbox sdt） | **可点击勾选** | 显示为符号（不可点） | 显示为符号（不可点） | 探针验证 2026-07-07，universal 安全 |
| 公式 OMML（`math`/行内 math run） | 正常 | 未验证 | **n 元算子（`\sum \int \prod`）上下限不显示**（LO 的 OMML 导入缺陷，标准写法没问题）；装饰符/矩阵/分式正常。⚠️ 预览机必须装 **libreoffice-math**，缺装时公式整段空白（2026-07-10 实测） | implementation record |
| 行内公式放高结构（分式/求和上下限/矩阵） | 未实测（lineRule 缺省按倍数行距，理论上行高自适应） | 未验证（推测同 LO） | **上下被截断**：求和下限裁半、矩阵下行整个被裁——机制同 §3「图片段落带行距」（`w:line` 被当固定行高）| 2026-07-11 用户实测 + 本机复现 |
| 表格 keepTogether | 表高过一页时自动放弃 keep 照常拆（预期） | 未验证 | 同 Word | implementation record，A/B 视觉验证 |
| sectionBreak evenPage/oddPage | 未实测（标准 `w:type`，低风险） | 未验证 | 正常生效：页码按奇偶跳号（第1页 oddPage→ 下节「第3页」）；**PDF 导出不物理输出空白页**，打印才有空白页 | 2026-07-10 探针实测 |

## 3. 渲染层已内置的规避 —— 记「为什么」，改渲染层前必读

这些坑服务端已经兜住，正常使用碰不到；列在这里是防止将来改渲染层时把规避当冗余删掉。详细现象与上游反馈见 `docs/upstream-issues.md`。

| 坑 | 不规避的后果 | 我们的规避 | 记录 |
|---|---|---|---|
| 自定义样式缺 `<w:name>` | Word 容忍；**LO 整条样式作废**，pStyle 悬空连带表格/编号布局崩坏 | 样式合并时自动补 `name: id` | implementation record |
| universal measure 字符串（`"0.75cm"`） | 样式处 LO 静默丢；**pgMar 处 Word 整份文件拒开**（schema 全绿、LO 正常，视觉回归抓不到） | 一律换算 twips 数值；`npm run validate` 把 wml part 里出现 universal measure 列为 error | upstream §4，2026-07-07 实测 |
| 表格 `tblW auto` / 100twips 假网格 | Word auto 布局侥幸救回；**LO/WPS 塌成细缝或挤成一团**（span 表尤甚） | 显式 `tblW = sum(columnWidths)` DXA + `tblLayout fixed`；无列宽时按版心等分真实列宽 | upstream §3，用户实测 |
| docx 库 `bullet` 选项与自定义样式同用 | 重复 pStyle（非法 OOXML），**LO 布局直接崩** | markdown 列表走自定义编号 `md-ordered`/`md-bullet`，不用库的 bullet | upstream §1 |
| rPr 子元素顺序违反 CT_RPr sequence | **Word 弹「不可读取的内容」**；LO 不校验顺序，视觉回归全绿极易漏过 | 落盘前 `fixWordCompat` 按 CT_RPr 重排；validate 出口断言同一份 `RPR_CHILD_ORDER` | upstream §5，2026-07-07 实测 |
| `AlignmentType.START/END`（strict 枚举） | transitional Word 弹修复弹窗 | 出口归一化为 left/right | upstream §5 附带 |
| 图片段落带行距 | **LO/WPS 把 `w:line` 当固定行高，高图裁成一条**；Word 正常 | 图片段落不设行距 | implementation record，实测修复 |

## 4. 交付通道注意（不是查看器问题，但症状像）

- **云服务器直接下载损坏 docx**（2026-07-07 实测：服务端过 OpenXmlValidator 0 错误，直下后 Word 拒开）——**打 zip 包传输**，zip 自带完整性校验。「Word 打不开」先查通道再查渲染。
- CDN/反向代理可能缓存 docx，导致同名覆盖后仍拿到旧版。下载响应应带 `Cache-Control: no-store`；历史同名文件更新时建议换文件名。

## 5. 验证工具与三端的对应关系

| 工具 | 覆盖的端 | 抓不到的 |
|---|---|---|
| `npm run validate`（三层校验） | Word 兼容陷阱（rPr 顺序、universal measure 等「LO 宽容而 Word 严格」的问题） | 视觉/布局问题 |
| `preview:true` / `scripts/docx2png.sh` | LO 视觉 | Word 拒开类问题（LO 宽容）；域空白在 PDF 里可能被 LO 更新掉 |
| `npm run visual`（视觉回归） | LO 分页/文本 | 同上；WPS 全靠人工 |
| Windows Word 人工实测 | Word 最终验收 | —— |

**WPS 是三端里没有自动化覆盖的一端**：目前全部结论来自探针/用户实测记录，新能力上线若面向 WPS 用户，应主动请用户在 WPS 里验收一遍。
