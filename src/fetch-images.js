/**
 * fetch-images.js — URL 图片抓取（docs/architecture.md）
 *
 * 显式 opt-in（meta.fetchUrlImages: true）后，renderDocument 渲染前把 def
 * 里的 http(s) 图片抓下来转成 data:base64 直传并回写 def——文档自包含，
 * 后续渲染不再拉网络，渲染层保持离线纯函数。
 * 约束：超时 10s、≤5MB（流式计数，不信 Content-Length）、MIME 白名单。
 * 失败不中断：保留原 URL（渲染占位），返回 warning。
 */

const TIMEOUT_MS = 10 * 1000;
// 与 base64 直传上限同一口径（docxUtil BASE64_IMAGE_LIMIT）
const MAX_BYTES = 5 * 1024 * 1024;
// docx 包内可嵌的位图格式；svg/webp 等 Word 支持参差，先不放行
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/bmp"]);

const isHttpUrl = (s) => typeof s === "string" && /^https?:\/\//i.test(s);

const fetchImage = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const mime = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    throw new Error(`MIME 不在白名单: ${mime || "(空)"}（允许 ${[...ALLOWED_MIME].join(", ")}）`);
  }
  const declared = Number(res.headers.get("content-length"));
  if (declared > MAX_BYTES) {
    throw new Error(`超过 ${MAX_BYTES / 1024 / 1024}MB 上限（Content-Length ${declared}）`);
  }
  // Content-Length 可缺可谎报，边读边计数
  const chunks = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new Error(`超过 ${MAX_BYTES / 1024 / 1024}MB 上限`);
    }
    chunks.push(value);
  }
  return `data:${mime};base64,${Buffer.concat(chunks).toString("base64")}`;
};

/** 收集 def 里所有图片 src 槽位：image 节点、表格格内图、页眉页脚图 */
const collectSlots = (def) => {
  const slots = [];
  const pushSrcSlots = (holder, key) => {
    const v = holder[key];
    if (Array.isArray(v)) {
      v.forEach((_, i) => slots.push({
        get: () => holder[key][i], set: (nv) => { holder[key][i] = nv; },
      }));
    } else {
      slots.push({ get: () => holder[key], set: (nv) => { holder[key] = nv; } });
    }
  };
  for (const node of def.contexts || []) {
    if (!node) continue;
    if (node.type === "image") pushSrcSlots(node, "src");
    if (node.type === "table" && node.tableOptions && node.tableOptions.images) {
      for (const list of Object.values(node.tableOptions.images)) {
        for (const d of Array.isArray(list) ? list : []) {
          if (d && d.type === "image") pushSrcSlots(d, "src");
        }
      }
    }
  }
  const meta = def.meta || {};
  for (const key of ["headerImage", "footerImage"]) {
    if (meta[key] && typeof meta[key] === "object") pushSrcSlots(meta[key], "src");
  }
  return slots;
};

/**
 * 抓取 def 里的 URL 图片。深拷贝回填，不动传入对象。
 * @returns {{ def, changed: boolean, warnings: string[] }}
 */
const fetchUrlImagesInDef = async (def) => {
  const copy = structuredClone(def);
  const slots = collectSlots(copy).filter((s) => isHttpUrl(s.get()));
  const warnings = [];
  let changed = false;
  // 同一 URL 出现多处只抓一次、失败只报一次
  const fetched = new Map();
  for (const url of new Set(slots.map((s) => s.get()))) {
    try {
      fetched.set(url, await fetchImage(url));
    } catch (e) {
      warnings.push(`URL 图片抓取失败（渲染占位）: ${url}（${e.message}）`);
    }
  }
  for (const slot of slots) {
    const dataUri = fetched.get(slot.get());
    if (dataUri) {
      slot.set(dataUri);
      changed = true;
    }
  }
  return { def: copy, changed, warnings };
};

module.exports = { fetchUrlImagesInDef, isHttpUrl, MAX_BYTES, ALLOWED_MIME };
