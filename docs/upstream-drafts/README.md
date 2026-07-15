# 上游 issue 文稿（dolanmiu/docx）

2026-07-11 整理，依据 `docs/upstream-issues.md`。全部在 **docx@9.7.1 干净环境**重跑过
最小复现（`repro.js`），并核对过当日 GitHub master 源码；GitHub issue 搜索未见重复报告。

## 文稿清单（编号对应 upstream-issues.md）

| 文稿 | 问题 | 状态 |
|---|---|---|
| `issue-1-duplicate-pstyle.md` | bullet+style 双 pStyle，非法 OOXML | 9.7.1 仍复现；**附 `patch-issue-1.diff` 可直接带 PR** |
| `issue-2-style-name.md` | 样式缺 name 被 LO/WPS 整条丢弃 | 9.7.1 仍复现；附截图 `evidence/issue2-libreoffice-table-collapse.png` |
| `issue-3-tblgrid.md` | 缺省 columnWidths 写 100 twips 假网格 | 9.7.1 仍复现 |
| `issue-4-universal-measure.md` | universal measure 透传，Word 拒开 | 9.7.1 仍复现（最重，建议先发） |
| `issue-6-highlightcs.md` | highlight 附带输出非法 w:highlightCs | 本轮新发现，8.5/9.7 均在 |

原 #5（rPr 子元素顺序）**9.x 已修**，不发。

## 复现脚本

```bash
mkdir /tmp/docx-repro && cd /tmp/docx-repro && npm i docx@latest
node <本目录>/repro.js          # 7 个最小复现 docx
node <本目录>/repro-visual.js   # 4 个「正常对照 + 病灶」可视化 docx（截图用）
# 截图：bash scripts/docx2png.sh eN.docx outdir
```

注意：本机 LibreOffice 24.2.7 只对 #2 有肉眼崩坏；#1/#3/#4A 的崩坏记录来自 LO 24.8/WPS
（见 upstream-issues.md），文稿措辞已按此区分。#1、#6 的杀手证据是 schema 校验
（`npm run validate -- <file>`），不依赖查看器版本。

## 发布方式

逐条开 issue（勿合并成一条），正文直接贴对应 md 的英文部分（去掉开头中文引言块）。
#2 记得上传截图。#1 发完 issue 后可 fork 上游按 `patch-issue-1.diff` 提 PR（diff 里
测试文件的插入位置标了 `@@ -TEST-LOCATION @@`，落到 `properties.spec.ts` 相邻用例旁）。
