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
  const v = state.llm || { baseURL: "", model: "", apiKey: "", thinking: false };
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
