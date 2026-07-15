/**
 * image.js — markdown image token → image 节点
 *
 * 本地图片读原始尺寸并按 imageMaxWidth 等比缩放（渲染层 ImageRun
 * 必须给像素宽高）；文件缺失/URL 保留节点交给渲染层占位 + 校验器 warn。
 * alt 文本进 caption，autoNumber 开着时 transform 会展开成「图N xxx」。
 */
const fs = require("fs");
const path = require("path");
const { imageSize } = require("image-size");

// preset 没配 markdown.imageMaxWidth 时的保险值（px），正常应由 preset 提供
const FALLBACK_MAX_WIDTH = 480;

const imageTokenToNode = (tok, ctx) => {
  const src = tok.attrGet("src") || "";
  const alt = (tok.content || "").trim();
  const node = { type: "image", src, ...(alt ? { caption: alt } : {}) };

  if (/^https?:\/\//i.test(src)) {
    // 宽高留空：opt-in 抓取转 base64 后渲染层按原图等比缩放
    if (!ctx.opts.fetchUrlImages) {
      ctx.addIssue("warn", "md-image-url",
        `URL 图片默认不抓取：${src}（渲染占位）。meta.fetchUrlImages:true 开启渲染时抓取，或先落盘/转 base64`);
    }
    return node;
  }
  const abs = path.isAbsolute(src) ? src : path.resolve(ctx.opts.imagesAbsDir || ".", src);
  let dim;
  try {
    dim = imageSize(fs.readFileSync(abs));
  } catch {
    // 尺寸留空：渲染层读不到文件会输出 [图片缺失] 占位，校验器另有 image-missing warn
    return node;
  }
  const maxWidth = ctx.opts.imageMaxWidth || FALLBACK_MAX_WIDTH;
  const scale = dim.width > maxWidth ? maxWidth / dim.width : 1;
  node.width = Math.round(dim.width * scale);
  node.height = Math.round(dim.height * scale);
  return node;
};

module.exports = { imageTokenToNode };
