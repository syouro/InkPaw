"use strict";
// InkPaw Playground 前端：无框架单页。
// BYOK：模型配置存 localStorage，随每次 /api/chat 请求发给后端转发，后端不存。
// 身份：匿名恢复码（inkpaw.recoveryCode）也存 localStorage，所有 /api/* 请求
// 走 Authorization 头——绝不进 URL；预览/下载改鉴权 fetch + Blob URL。

const $ = (s) => document.querySelector(s);
// html:false（默认）会转义模型输出里的原生 HTML，防注入
const md = window.markdownit({ linkify: true, breaks: true });
const state = {
  recoveryCode: localStorage.getItem("inkpaw.recoveryCode") || null,
  llm: JSON.parse(localStorage.getItem("inkpaw.llm") || "null"),
  sessionId: null,
  selectedTemplateId: null,
  streaming: false,
  docId: null,
  previewTab: "pages", // pages=LibreOffice 版式图，draft=可编辑草稿
  blobUrls: [], // 本会话创建的 Blob URL，切换/重渲时统一 revoke 防内存泄漏
};

// ── 身份 ─────────────────────────────────────────────
function setRecoveryCode(code) {
  state.recoveryCode = code;
  localStorage.setItem("inkpaw.recoveryCode", code);
}

const authFetch = (url, opts = {}) => fetch(url, {
  ...opts,
  headers: { ...(opts.headers || {}), Authorization: `Bearer ${state.recoveryCode}` },
});

async function verifyCode(code) {
  const r = await fetch("/api/identity", { headers: { Authorization: `Bearer ${code}` } });
  return r.ok;
}

async function createIdentity() {
  const r = await fetch("/api/identity", { method: "POST" });
  if (!r.ok) throw new Error("创建身份失败");
  const { recoveryCode } = await r.json();
  setRecoveryCode(recoveryCode);
  return recoveryCode;
}

// 首次进入 / 旧版无缝迁移：旧 clientId（UUID）服务端迁移后就是 legacy 恢复码。
// 返回是否新建了身份（新建时启动后提示保存恢复码）
async function ensureIdentity() {
  if (state.recoveryCode && await verifyCode(state.recoveryCode)) return false;
  const legacy = localStorage.getItem("inkpaw.clientId");
  if (legacy && await verifyCode(legacy)) {
    setRecoveryCode(legacy);
    localStorage.removeItem("inkpaw.clientId");
    return false;
  }
  await createIdentity();
  return true;
}

// ── 设置 ─────────────────────────────────────────────
const dlg = $("#settings-dialog");
const form = $("#settings-form");
function openSettings() {
  const v = state.llm || {
    baseURL: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    apiKey: "",
    thinking: true,
  };
  form.baseURL.value = v.baseURL; form.model.value = v.model;
  form.apiKey.value = v.apiKey; form.thinking.checked = !!v.thinking;
  renderIdentityPanel();
  dlg.showModal();
}
$("#btn-settings").onclick = openSettings;
dlg.addEventListener("close", () => {
  if (dlg.returnValue !== "ok") return;
  state.llm = {
    baseURL: form.baseURL.value.trim().replace(/\/+$/, ""),
    model: form.model.value.trim(),
    apiKey: form.apiKey.value.trim(),
    thinking: form.thinking.checked,
  };
  localStorage.setItem("inkpaw.llm", JSON.stringify(state.llm));
});

// 身份区：恢复码默认遮挡，提供显示/复制/导入/新建
function renderIdentityPanel() {
  const codeEl = $("#identity-code");
  codeEl.textContent = "•".repeat(24);
  codeEl.dataset.shown = "";
}
$("#btn-code-show").onclick = () => {
  const codeEl = $("#identity-code");
  if (codeEl.dataset.shown) { renderIdentityPanel(); return; }
  codeEl.textContent = state.recoveryCode || "（无）";
  codeEl.dataset.shown = "1";
};
$("#btn-code-copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText(state.recoveryCode || "");
    $("#btn-code-copy").textContent = "已复制✓";
    setTimeout(() => { $("#btn-code-copy").textContent = "复制"; }, 1500);
  } catch {
    alert("复制失败，请点「显示」后手动复制");
  }
};
$("#btn-code-import").onclick = async () => {
  const code = prompt("粘贴要导入的恢复码（ink_ 开头）：");
  if (!code) return;
  if (!(await verifyCode(code.trim()))) { alert("恢复码无效"); return; }
  if (!confirm("导入后页面将切换到该身份。当前身份的数据不会删除，但若未保存当前恢复码将无法找回，确认切换？")) return;
  setRecoveryCode(code.trim());
  dlg.close("cancel");
  state.sessionId = null;
  newSession();
};
$("#btn-code-new").onclick = async () => {
  if (!confirm("创建新身份后页面将切换过去。当前身份的数据不会删除，但若未保存当前恢复码将无法找回，确认创建？")) return;
  await createIdentity();
  renderIdentityPanel();
  state.sessionId = null;
  newSession();
};

// ── 会话列表 ──────────────────────────────────────────
async function refreshSessions() {
  const list = await authFetch("/api/sessions").then((r) => r.json());
  const el = $("#session-list");
  el.innerHTML = "";
  for (const s of list) {
    const div = document.createElement("div");
    div.className = "session-item" + (s.id === state.sessionId ? " active" : "");
    div.innerHTML = `<span class="t"></span><button class="del" title="删除">×</button>`;
    div.querySelector(".t").textContent = s.title;
    div.onclick = () => loadSession(s.id);
    div.querySelector(".del").onclick = async (e) => {
      e.stopPropagation();
      await authFetch(`/api/sessions/${s.id}`, { method: "DELETE" });
      if (s.id === state.sessionId) newSession();
      refreshSessions();
    };
    el.appendChild(div);
  }
}

function newSession() {
  state.sessionId = null;
  $("#messages").innerHTML = `<div class="sys-note">新对话——描述你要的文档即可开始</div>`;
  setPreview(null);
  refreshSessions();
  refreshTemplates();
}
$("#btn-new").onclick = newSession;

// ── 模板区 ────────────────────────────────────────────
// 选中的模板随每轮 /api/chat 只提交 templateId，服务端验归属后注入 agent 上下文
async function refreshTemplates() {
  const el = $("#template-list");
  let data;
  try {
    data = await authFetch("/api/templates").then((r) => r.json());
  } catch {
    return;
  }
  const templates = data.templates || [];
  if (state.selectedTemplateId && !templates.some((x) => x.templateId === state.selectedTemplateId)) {
    state.selectedTemplateId = null; // 选中的被删了
  }
  el.innerHTML = "";
  if (!templates.length) {
    el.innerHTML = `<div class="tpl-empty">上传 .docx 模板（{{槽名}} 占位）后可选定填槽</div>`;
    return;
  }
  for (const tpl of templates) {
    const div = document.createElement("div");
    div.className = "tpl-item" + (tpl.templateId === state.selectedTemplateId ? " active" : "");
    div.title = `槽位：${(tpl.slots || []).join("、") || "（无占位符）"}`;
    div.innerHTML = `<span class="t"></span><button class="del" title="删除模板">×</button>`;
    div.querySelector(".t").textContent = tpl.name;
    div.onclick = () => {
      state.selectedTemplateId = state.selectedTemplateId === tpl.templateId ? null : tpl.templateId;
      refreshTemplates();
    };
    div.querySelector(".del").onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`删除模板「${tpl.name}」？由它创建的文档将无法再渲染。`)) return;
      await authFetch(`/api/templates/${tpl.templateId}`, { method: "DELETE" });
      refreshTemplates();
    };
    el.appendChild(div);
  }
}

$("#btn-upload-tpl").onclick = () => $("#tpl-file").click();
$("#tpl-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { addNote("✗ 模板超过 5MB 上限"); return; }
  const base64 = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1]); // 剥掉 dataURL 前缀
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
  const r = await authFetch("/api/templates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name.replace(/\.(docx|dotx)$/i, ""), base64 }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { addNote(`✗ 模板上传失败：${data.error || r.statusText}`); return; }
  const warn = (data.warnings || []).length ? `（注意：${data.warnings.join("；")}）` : "";
  addNote(`模板「${data.name}」已上传，槽位：${(data.slots || []).join("、") || "无"}${warn}`);
  state.selectedTemplateId = data.templateId; // 上传即选中，用户通常接着要用
  refreshTemplates();
});

async function loadSession(id) {
  state.sessionId = id;
  const data = await authFetch(`/api/sessions/${id}/messages`).then((r) => r.json());
  const box = $("#messages");
  box.innerHTML = "";
  for (const m of data.messages) {
    if (m.role === "user") addUserMsg(m.content);
    else {
      for (const name of m.toolCalls || []) addToolChip(name).classList.remove("running");
      if (m.content) addAssistantBubble().innerHTML = md.render(m.content);
    }
  }
  setPreview(data.docInfo);
  box.scrollTop = box.scrollHeight;
  refreshSessions();
}

// ── 消息渲染 ──────────────────────────────────────────
const box = () => $("#messages");
function scrollBottom() { box().scrollTop = box().scrollHeight; }
function addUserMsg(text) {
  const d = document.createElement("div");
  d.className = "msg user";
  d.innerHTML = `<div class="bubble"></div>`;
  d.querySelector(".bubble").textContent = text;
  box().appendChild(d); scrollBottom();
}
function addAssistantBubble() {
  const d = document.createElement("div");
  d.className = "msg assistant";
  d.innerHTML = `<div class="bubble"></div>`;
  box().appendChild(d); scrollBottom();
  return d.querySelector(".bubble");
}
function addReasoningBlock() {
  const d = document.createElement("div");
  d.className = "reasoning";
  box().appendChild(d); scrollBottom();
  return d;
}
function addToolChip(name) {
  const wrap = document.createElement("div");
  wrap.className = "msg assistant";
  const chip = document.createElement("span");
  chip.className = "toolchip running";
  chip.textContent = `⚙ ${name}`;
  wrap.appendChild(chip);
  box().appendChild(wrap); scrollBottom();
  return chip;
}
function addNote(text) {
  const d = document.createElement("div");
  d.className = "sys-note";
  d.textContent = text;
  box().appendChild(d); scrollBottom();
}

// ── 预览面板 ──────────────────────────────────────────
// <img>/<a> 不会带 Authorization 头：全部鉴权 fetch 转 Blob。
function revokeBlobUrls() {
  for (const u of state.blobUrls) URL.revokeObjectURL(u);
  state.blobUrls = [];
}
window.addEventListener("pagehide", revokeBlobUrls);

async function setPreview(info) {
  const pages = $("#preview-pages"), dl = $("#dl-buttons");
  revokeBlobUrls();
  dl.innerHTML = "";
  state.docId = (info && info.docId) || null;
  // 草稿视图不依赖 PNG 管线：没有 LibreOffice 也能出，所以在没有 pages 时照样刷新
  if (state.previewTab === "draft") loadDraft();
  if (!info || !info.pages || !info.pages.length) {
    pages.innerHTML = `<div class="preview-empty">渲染后这里会显示每页预览</div>`;
    return;
  }
  pages.innerHTML = "";
  for (const url of info.pages) {
    const r = await authFetch(url);
    if (!r.ok) continue;
    const blobUrl = URL.createObjectURL(await r.blob());
    state.blobUrls.push(blobUrl);
    const img = document.createElement("img");
    img.src = blobUrl;
    pages.appendChild(img);
  }
  const mkDownload = (url, label, filename) => {
    const a = document.createElement("a");
    a.href = "#";
    a.textContent = label;
    a.onclick = async (e) => {
      e.preventDefault();
      const r = await authFetch(url);
      if (!r.ok) { addNote("✗ 下载失败"); return; }
      const blobUrl = URL.createObjectURL(await r.blob());
      const tmp = document.createElement("a");
      tmp.href = blobUrl;
      tmp.download = filename;
      tmp.click();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 30000); // 触发下载后即可回收
    };
    dl.appendChild(a);
  };
  const short = info.docId.slice(0, 8);
  if (info.docx) mkDownload(info.docx, "⬇ docx", `inkpaw-${short}.docx`);
  if (info.pdf) mkDownload(info.pdf, "⬇ PDF", `inkpaw-${short}.pdf`);
}

// ── 草稿视图（docs/editable-preview.md §3.2.4、§3.3）────
// 版式视图是 LibreOffice 出的真实分页；草稿视图是 def 直出的可编辑 HTML。
// 系统算出来的编号/图表号/交叉引用是只读 chip，用户改不动也删不掉。

function ensureDraftCss(css) {
  let el = document.getElementById("draft-css");
  if (!el) {
    el = document.createElement("style");
    el.id = "draft-css";
    document.head.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
}

/** chip 指纹：ref id 的有序列表。任何编辑都不该改变它（§3.3 提交前校验的前置） */
const chipSignature = (leaf) =>
  Array.from(leaf.querySelectorAll(".ip-ref")).map((c) => c.dataset.ref).join(" ");

/** e.getTargetRanges() 给出本次输入将影响的范围——用它判定会不会碰到 chip */
function inputTouchesChip(leaf, e) {
  const ranges = typeof e.getTargetRanges === "function" ? e.getTargetRanges() : [];
  const chips = leaf.querySelectorAll(".ip-ref");
  if (!chips.length) return false;
  for (const sr of ranges) {
    const r = document.createRange();
    try {
      r.setStart(sr.startContainer, sr.startOffset);
      r.setEnd(sr.endContainer, sr.endOffset);
    } catch { return true; } // 范围异常时按「会碰到」处理，宁可拦错不放过
    for (const chip of chips) if (r.intersectsNode(chip)) return true;
  }
  return false;
}

/** 目标范围是否全部落在本叶子内——跨叶子的编辑一律拦掉（§3.2.4 编辑孤岛） */
function inputEscapesLeaf(leaf, e) {
  const ranges = typeof e.getTargetRanges === "function" ? e.getTargetRanges() : [];
  for (const sr of ranges) {
    if (!leaf.contains(sr.startContainer) || !leaf.contains(sr.endContainer)) return true;
  }
  return false;
}

// 一期只做值编辑：换行、分段都属结构编辑（P4），在这里就拦住
const STRUCTURAL_INPUTS = new Set(["insertParagraph", "insertLineBreak"]);

/**
 * 按 DOM 顺序把叶子重建回 def 里的原始字符串（§3.3）：
 * 文本节点原样取，chip 还原成 {{ref:id}} / {{pageRef:id}}。
 * 前缀在容器外面，所以这里得到的就是 raw 本身，不必再剔。
 */
function leafToRaw(leaf) {
  let out = "";
  for (const n of leaf.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) { out += n.nodeValue; continue; }
    if (n.nodeType !== Node.ELEMENT_NODE) continue;
    if (n.dataset && n.dataset.ref) { out += `{{ref:${n.dataset.ref}}}`; continue; }
    if (n.dataset && n.dataset.pageref) { out += `{{pageRef:${n.dataset.pageref}}}`; continue; }
    out += n.textContent; // 不该出现的元素：退化成纯文本，别把标签写进 def
  }
  return out;
}

async function submitLeaf(leaf, sig) {
  if (chipSignature(leaf) !== sig) return; // input 兜底已还原过，不该走到这
  const value = leafToRaw(leaf);
  if (value === leaf.dataset.committed) return;
  const body = {
    id: leaf.dataset.nodeId,
    path: JSON.parse(leaf.dataset.pathJson),
    value,
  };
  leaf.classList.add("saving");
  try {
    const r = await authFetch(`/api/docs/${state.docId}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "写回失败");
    leaf.dataset.committed = value;
    leaf.classList.add("saved");
    setTimeout(() => leaf.classList.remove("saved"), 1200);
    // 编号/引用可能因内容变化而重排，版式视图的 PNG 也已过期——提示而不自动重渲，
    // 重渲要过 LibreOffice，不该由每次失焦触发
    if ((data.issues || []).some((i) => i.level === "error")) {
      addNote("⚠ 改动已保存，但文档存在 error 级问题，渲染前需修正");
    }
  } catch (e) {
    // 服务端拒绝（如引用标记被改）：还原成上次提交成功的值，别让页面停在假状态
    leaf.textContent = "";
    leaf.innerHTML = leaf.dataset.snapshot;
    addNote(`✗ ${e.message}`);
  } finally {
    leaf.classList.remove("saving");
  }
}

function armLeaf(leaf) {
  const snapshot = leaf.innerHTML;
  const sig = chipSignature(leaf);
  leaf.dataset.snapshot = snapshot;
  leaf.dataset.committed = leafToRaw(leaf);

  leaf.addEventListener("beforeinput", (e) => {
    if (STRUCTURAL_INPUTS.has(e.inputType)
      || inputEscapesLeaf(leaf, e)
      || inputTouchesChip(leaf, e)) {
      e.preventDefault();
    }
  });

  // 粘贴一律降级成纯文本：富文本会把 span/样式整片带进来，污染叶子结构
  leaf.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData("text/plain").replace(/[\r\n]+/g, " ");
    document.execCommand("insertText", false, text);
  });

  // 拖放能绕过 beforeinput 把 chip 拖走，直接禁掉
  leaf.addEventListener("drop", (e) => e.preventDefault());
  leaf.addEventListener("dragstart", (e) => e.preventDefault());

  // 兜底：beforeinput 拦不住的路径（IME、undo、浏览器差异）事后校验，
  // chip 指纹变了就整条还原。宁可丢一次输入，也不写坏引用
  leaf.addEventListener("input", () => {
    if (chipSignature(leaf) !== sig) {
      leaf.innerHTML = snapshot;
      addNote("✗ 该处的编号或引用由系统维护，不能修改（已还原）");
    }
  });

  // 失焦提交：编辑中每次按键都打服务端既费带宽也让 validator 反复空跑
  leaf.addEventListener("blur", () => submitLeaf(leaf, sig));
}

/**
 * 草稿改完后重新渲染。版式视图的 PNG 不会跟着写回自动更新——渲染要过
 * LibreOffice（约 5-10 秒），由每次失焦触发既慢又浪费，所以给个显式按钮。
 * 渲染完自动切到版式视图：点这个按钮的人就是想看排版结果。
 */
async function rerender() {
  const btn = $("#btn-rerender");
  if (!state.docId || (btn && btn.disabled)) return;
  if (btn) { btn.disabled = true; btn.textContent = "⏳ 渲染中…"; }
  try {
    const r = await authFetch(`/api/docs/${state.docId}/render`, { method: "POST" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      // error 级 issue 会挡住渲染，逐条说清是哪里不合格，别只丢一句"失败"
      for (const it of (data.issues || []).filter((i) => i.level === "error")) addNote(`✗ ${it.message}`);
      throw new Error(data.error || "渲染失败");
    }
    for (const w of data.warnings || []) addNote(`⚠ ${w}`);
    // 先切 tab 再灌数据：setPreview 在草稿 tab 激活时会连带重载草稿，
    // 那会把当前这个按钮的 DOM 一起换掉，白跑一趟
    switchPreviewTab("pages");
    await setPreview(data);
    addNote("✓ 已重新渲染");
  } catch (e) {
    addNote(`✗ ${e.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "🔄 重新渲染"; }
  }
}

async function loadDraft() {
  const el = $("#preview-draft");
  if (!state.docId) {
    el.innerHTML = `<div class="preview-empty">渲染后这里会显示可编辑草稿</div>`;
    return;
  }
  el.innerHTML = `<div class="preview-empty">草稿生成中…</div>`;
  try {
    const r = await authFetch(`/api/docs/${state.docId}/draft`);
    if (!r.ok) throw new Error("生成失败");
    const { html, css } = await r.json();
    ensureDraftCss(css);
    // html 的文本内容已在服务端 htmlUtil 逐段转义，结构标签由渲染器生成
    el.innerHTML = `<div class="draft-status">灰底部分是系统维护的编号与交叉引用，不可编辑。改完点别处即保存。`
      + `<button id="btn-rerender" class="cfg-open">🔄 重新渲染</button>`
      + `<button id="btn-config" class="cfg-open">⚙ 页眉页脚</button></div>`
      + `<div class="draft-page">${html}</div>`;
    el.querySelectorAll(".ip-leaf").forEach(armLeaf);
    armStructureControls(el);
    $("#btn-config").onclick = openConfig;
    $("#btn-rerender").onclick = rerender;
  } catch (e) {
    el.innerHTML = `<div class="preview-empty">草稿视图生成失败：${e.message}</div>`;
  }
}

// ── 块级结构编辑（docs/editable-preview.md §4 P4）───────
// 只做整节点的增删上下移。段落内 run 的增删不做：text 与 textOptions 是按下标
// 一一对应的平行数组（§3.2.5），错一格样式和脚注会整体错位，且页面上没有
// 「这是第几个 run」的自然操作入口。插图也不做——src 是路径，属注入面。

async function structureOp(op, anchorId, text) {
  try {
    const r = await authFetch(`/api/docs/${state.docId}/structure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, anchorId, ...(text !== undefined ? { text } : {}) }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "操作失败");
    // 引用悬空这类告警必须让用户看见：删掉被引用的节点不会报错，但文档已经带伤
    for (const it of (data.issues || []).filter((i) => i.level === "warn")) addNote(`⚠ ${it.message}`);
    await loadDraft(); // 编号和 id 都可能变，整块重载而不是局部改 DOM
  } catch (e) {
    addNote(`✗ ${e.message}`);
  }
}

/**
 * 给每个可操作块挂控件。一个 def 节点可能渲染成多个块（表格 = 表题段 + 表body，
 * checklist = 每项一段），只在该 id 的**第一个**块上挂，避免一个节点出现多套按钮。
 */
function armStructureControls(root) {
  const seen = new Set();
  for (const block of root.querySelectorAll(".draft-page > .ip-doc > [data-node-id]")) {
    const id = block.dataset.nodeId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    block.classList.add("ip-block");
    const bar = document.createElement("span");
    bar.className = "ip-blockbar";
    bar.contentEditable = "false";
    const mk = (label, title, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.title = title;
      b.onclick = (e) => { e.preventDefault(); fn(); };
      bar.appendChild(b);
    };
    mk("↑", "上移", () => structureOp("moveUp", id));
    mk("↓", "下移", () => structureOp("moveDown", id));
    mk("＋", "在下方插入段落", () => structureOp("insertAfter", id, "新段落"));
    mk("✕", "删除该块", () => {
      if (confirm("删除这一块？引用它的交叉引用会悬空。")) structureOp("delete", id);
    });
    block.prepend(bar);
  }
}

// ── 页眉页脚配置（docs/editable-preview.md §3.5）────────
// 三态：继承 / 显式无页眉 / 自定义。「继承」写回必须是 clear（删除键）而不是置空——
// headerText:"" 的语义是「本节显式无页眉」，写成空字符串页眉会静默消失且查不出原因。

const CONFIG_LABEL = {
  headerText: "页眉文字", pageNumber: "页脚页码", titlePage: "首页不显示页眉页脚",
  pageNumberStart: "页码起始值", pageNumberFormat: "页码格式",
};

async function postConfig(body) {
  const r = await authFetch(`/api/docs/${state.docId}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "写入失败");
  return data;
}

/** 一个字段一行：继承态用 radio 表达，避免「空字符串 = 继承」的歧义 */
function configRow(field, spec, scope, sectionId, layer) {
  const explicit = layer.set[field];
  const isSet = explicit !== undefined;
  const eff = layer.effective[field];
  const row = document.createElement("div");
  row.className = "cfg-row";
  const name = `${sectionId || "doc"}-${field}`;
  const inheritable = scope === "section" ? spec.scopes.includes("document") : true;

  const apply = async (body) => {
    try { await postConfig({ ...(sectionId ? { sectionId } : {}), ...body }); await openConfig(); }
    catch (e) { addNote(`✗ ${e.message}`); }
  };

  const head = document.createElement("div");
  head.className = "cfg-head";
  head.textContent = CONFIG_LABEL[field] || field;
  row.appendChild(head);

  if (spec.type === "boolean") {
    const box = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!eff;
    cb.onchange = () => apply({ set: { [field]: cb.checked } });
    box.append(cb, document.createTextNode(isSet ? " 本层设置" : ` 继承（当前 ${eff ? "开" : "关"}）`));
    row.appendChild(box);
    if (isSet && inheritable) {
      const btn = document.createElement("button");
      btn.textContent = "恢复继承";
      btn.onclick = () => apply({ clear: [field] });
      row.appendChild(btn);
    }
    return row;
  }

  if (field === "headerText") {
    const mk = (value, label, onPick) => {
      const l = document.createElement("label");
      const r0 = document.createElement("input");
      r0.type = "radio"; r0.name = name;
      r0.checked = value === (isSet ? (explicit === "" ? "none" : "custom") : "inherit");
      r0.onchange = onPick;
      l.append(r0, document.createTextNode(` ${label}`));
      return l;
    };
    if (inheritable) {
      row.appendChild(mk("inherit", `继承文档级（当前「${eff || "无页眉"}」）`, () => apply({ clear: [field] })));
    }
    row.appendChild(mk("none", "本层无页眉", () => apply({ set: { [field]: "" } })));
    const custom = mk("custom", "自定义：", () => {});
    const input = document.createElement("input");
    input.type = "text";
    input.value = isSet && explicit !== "" ? explicit : "";
    input.placeholder = "页眉右侧文字";
    input.onchange = () => apply({ set: { [field]: input.value } });
    custom.appendChild(input);
    row.appendChild(custom);
    return row;
  }

  // pageNumberStart / pageNumberFormat：没有继承态（只有「不设置」和「设置」）
  const input = document.createElement(spec.enum ? "select" : "input");
  if (spec.enum) {
    for (const v of spec.enum) {
      const o = document.createElement("option");
      o.value = v; o.textContent = v; o.selected = explicit === v;
      input.appendChild(o);
    }
  } else {
    input.type = "number";
    input.min = String(spec.min ?? 0);
    input.value = isSet ? String(explicit) : "";
    input.placeholder = "不设置";
  }
  input.onchange = () => {
    if (!spec.enum && input.value === "") return apply({ clear: [field] });
    apply({ set: { [field]: spec.enum ? input.value : Number(input.value) } });
  };
  row.appendChild(input);
  if (isSet) {
    const btn = document.createElement("button");
    btn.textContent = "不设置";
    btn.onclick = () => apply({ clear: [field] });
    row.appendChild(btn);
  }
  return row;
}

function configLayer(title, scope, sectionId, layer, fields) {
  const box = document.createElement("section");
  box.className = "cfg-layer";
  const h = document.createElement("h4");
  h.textContent = title;
  box.appendChild(h);
  for (const [field, spec] of Object.entries(fields)) {
    if (!spec.scopes.includes(scope)) continue;
    box.appendChild(configRow(field, spec, scope, sectionId, layer));
  }
  return box;
}

async function openConfig() {
  const dlg = $("#config-dialog"), body = $("#config-body");
  if (!state.docId) { addNote("还没有文档"); return; }
  try {
    const r = await authFetch(`/api/docs/${state.docId}/config`);
    if (!r.ok) throw new Error("读取配置失败");
    const cfg = await r.json();
    body.innerHTML = "";
    body.appendChild(configLayer("文档级（首节）", "document", null, cfg.document, cfg.fields));
    cfg.sections.forEach((s, i) => {
      if (!s.id) {
        const note = document.createElement("p");
        note.className = "hint";
        note.textContent = `第 ${i + 1} 个分节没有节点 id，无法单独配置`;
        body.appendChild(note);
        return;
      }
      body.appendChild(configLayer(`第 ${i + 1} 节（${s.brief}）`, "section", s.id, s, cfg.fields));
    });
    if (!dlg.open) dlg.showModal();
  } catch (e) {
    addNote(`✗ ${e.message}`);
  }
}

$("#btn-config-close").onclick = () => $("#config-dialog").close();

function switchPreviewTab(tab) {
  state.previewTab = tab;
  for (const b of document.querySelectorAll(".ptab")) b.classList.toggle("active", b.dataset.tab === tab);
  $("#preview-pages").hidden = tab !== "pages";
  $("#preview-draft").hidden = tab !== "draft";
  if (tab === "draft") loadDraft();
}

for (const b of document.querySelectorAll(".ptab")) {
  b.onclick = () => switchPreviewTab(b.dataset.tab);
}

// ── 发送与流式接收 ─────────────────────────────────────
async function send() {
  if (state.streaming) return;
  const input = $("#input");
  const text = input.value.trim();
  if (!text) return;
  if (!state.llm || !state.llm.apiKey) { openSettings(); return; }

  input.value = "";
  addUserMsg(text);
  state.streaming = true;
  $("#btn-send").disabled = true;

  let bubble = null, reasoningEl = null;
  const chips = new Map();

  try {
    const resp = await authFetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: state.sessionId, message: text, llm: state.llm,
        ...(state.selectedTemplateId ? { selectedTemplateId: state.selectedTemplateId } : {}),
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      addNote(`✗ ${err.error || resp.statusText}`);
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop();
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data: ")) continue;
        handleEvent(JSON.parse(line.slice(6)));
      }
    }
  } catch (e) {
    addNote(`✗ 连接中断：${e.message}`);
  } finally {
    state.streaming = false;
    $("#btn-send").disabled = false;
    refreshSessions();
  }

  function handleEvent(ev) {
    switch (ev.type) {
      case "session":
        state.sessionId = ev.sessionId;
        break;
      case "reasoning":
        if (!reasoningEl) reasoningEl = addReasoningBlock();
        reasoningEl.textContent += ev.delta;
        reasoningEl.scrollTop = reasoningEl.scrollHeight;
        break;
      case "content":
        if (!bubble) { bubble = addAssistantBubble(); bubble._raw = ""; reasoningEl = null; }
        bubble._raw += ev.delta;
        bubble.innerHTML = md.render(bubble._raw); // 流式期间整段重渲染，长度可控
        scrollBottom();
        break;
      case "tool_start":
        bubble = null; reasoningEl = null;
        chips.set(ev.id, addToolChip(ev.name));
        break;
      case "tool_end": {
        const chip = chips.get(ev.id);
        if (chip) {
          chip.classList.remove("running");
          if (ev.isError) chip.classList.add("error");
        }
        break;
      }
      case "preview":
        setPreview(ev);
        break;
      case "error":
        addNote(`✗ ${ev.message}`);
        break;
      case "usage":
        if (ev.inputTokens || ev.outputTokens) addNote(`本轮 tokens：输入 ${ev.inputTokens} / 输出 ${ev.outputTokens}`);
        break;
    }
  }
}
$("#btn-send").onclick = send;
$("#input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});

// ── 启动 ─────────────────────────────────────────────
(async () => {
  const isNew = await ensureIdentity();
  newSession();
  if (isNew) addNote("已为你创建匿名身份。恢复码保存在本浏览器；换设备前请在「模型设置」里复制恢复码，凭它找回你的会话和文档。");
  if (!state.llm) openSettings();
})().catch((e) => addNote(`✗ 初始化失败：${e.message}（刷新重试）`));
