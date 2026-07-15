#!/usr/bin/env bash
# 把 docx 渲染成 PNG（每页一张），供 agent 读图做视觉验证。
# 用法: scripts/docx2png.sh <file.docx> [outdir]
# 依赖: libreoffice-writer（soffice）+ CJK 字体（google-noto-sans-cjk-ttc-fonts）
set -euo pipefail

docx="$1"
outdir="${2:-$(dirname "$docx")/preview}"
mkdir -p "$outdir"

# soffice 并发会抢 profile 锁，给它独立的 UserInstallation
profile="$(mktemp -d)"
trap 'rm -rf "$profile"' EXIT

soffice --headless -env:UserInstallation="file://$profile" \
  --convert-to pdf --outdir "$outdir" "$docx" >/dev/null

base="$(basename "$docx" .docx)"
pdf="$outdir/$base.pdf"
[ -f "$pdf" ] || { echo "转换失败: 没有生成 $pdf" >&2; exit 1; }

if command -v pdftoppm >/dev/null; then
  pdftoppm -png -r 110 "$pdf" "$outdir/$base"
else
  # 没有 poppler 时退化为只出 PDF（agent 的 Read 也能直接读 PDF）
  echo "提示: 未安装 pdftoppm，只生成了 PDF" >&2
fi

ls "$outdir/$base"*
