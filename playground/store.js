"use strict";
// Playground 会话/身份存储：独立 DB 文件（data/playground.db），不碰核心文档库。
// 消息存 OpenAI 格式 JSON——历史续聊时原样回灌 agent 循环。
// 匿名恢复码是唯一凭证，服务端只存
// SHA-256 哈希映射到内部 userId；会话按 user_id 归属，消息查询必须先过
// (session_id, user_id) 归属校验，不裸查。

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

class Store {
  constructor(dbPath) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.db = new Database(dbPath || path.join(DATA_DIR, "playground.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS identities (
        user_id       TEXT PRIMARY KEY,
        recovery_hash TEXT NOT NULL UNIQUE,
        created_at    INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '新对话',
        doc_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
    `);
    this._migrateLegacyClientIds();
    // user_id 索引放迁移后建：老库迁移前还没有这一列
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, updated_at DESC)");
  }

  // 旧 clientId 弱隔离 → 恢复码身份的一次性迁移（幂等：client_id 列消失即不再进入）。
  // UUID 格式的 clientId（crypto.randomUUID，122 位熵）直接当 legacy 恢复码存哈希，
  // 前端发现旧 localStorage 键时无缝换新；非 UUID 异常值不发恢复码，
  // 归入不可反查的哈希（= 管理员 legacy 作用域，普通用户不可见）。
  // 最后重建 sessions 表到目标 schema——老列 client_id 带 NOT NULL，留着会让
  // 迁移后必须重建表；否则旧 client_id NOT NULL 会让 createSession 撞约束。
  _migrateLegacyClientIds() {
    const cols = this.db.prepare("SELECT name FROM pragma_table_info('sessions')").all().map((c) => c.name);
    if (!cols.includes("client_id")) return;
    this.db.transaction(() => {
      if (!cols.includes("user_id")) this.db.exec("ALTER TABLE sessions ADD COLUMN user_id TEXT");
      const insertIdentity = this.db.prepare(
        "INSERT INTO identities (user_id, recovery_hash, created_at) VALUES (?, ?, ?)");
      const bind = this.db.prepare("UPDATE sessions SET user_id = ? WHERE client_id = ? AND user_id IS NULL");
      const findByHash = this.db.prepare("SELECT user_id FROM identities WHERE recovery_hash = ?");
      for (const { client_id } of this.db.prepare(
        "SELECT DISTINCT client_id FROM sessions WHERE user_id IS NULL").all()) {
        // 半迁移状态（旧版迁移只补了列没重建表）重入时，身份可能已存在——按哈希复用
        const legacyHash = UUID_RE.test(client_id) ? sha256(client_id) : null;
        const existing = legacyHash ? findByHash.get(legacyHash) : null;
        let userId;
        if (existing) {
          userId = existing.user_id;
        } else {
          userId = crypto.randomUUID();
          insertIdentity.run(userId, legacyHash || sha256(crypto.randomBytes(32).toString("hex")), Date.now());
        }
        bind.run(userId, client_id);
      }
      this.db.exec(`
        CREATE TABLE sessions_new (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '新对话',
          doc_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO sessions_new (id, user_id, title, doc_id, created_at, updated_at)
          SELECT id, user_id, title, doc_id, created_at, updated_at FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_new RENAME TO sessions;
      `);
    })();
  }

  // ── 身份 ─────────────────────────────────────────────

  // 恢复码只在此刻存在于内存并返回一次；落库仅哈希，丢了服务端不能反查
  createIdentity() {
    const recoveryCode = "ink_" + crypto.randomBytes(32).toString("base64url");
    const userId = crypto.randomUUID();
    const createdAt = Date.now();
    this.db.prepare(
      "INSERT INTO identities (user_id, recovery_hash, created_at) VALUES (?, ?, ?)"
    ).run(userId, sha256(recoveryCode), createdAt);
    return { userId, recoveryCode, createdAt };
  }

  verifyIdentity(recoveryCode) {
    if (typeof recoveryCode !== "string" || !recoveryCode) return null;
    const row = this.db.prepare(
      "SELECT user_id, created_at FROM identities WHERE recovery_hash = ?"
    ).get(sha256(recoveryCode));
    return row ? { userId: row.user_id, createdAt: row.created_at } : null;
  }

  // ── 会话（一律带 userId 归属条件）──────────────────────

  createSession(userId, title) {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db.prepare(
      "INSERT INTO sessions (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run(id, userId, title || "新对话", now, now);
    return { id, title: title || "新对话" };
  }

  getSession(id, userId) {
    return this.db.prepare(
      "SELECT * FROM sessions WHERE id = ? AND user_id = ?"
    ).get(id, userId);
  }

  listSessions(userId) {
    return this.db.prepare(
      "SELECT id, title, doc_id, updated_at FROM sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100"
    ).all(userId);
  }

  touchSession(id, { title, docId } = {}) {
    const sets = ["updated_at = ?"];
    const vals = [Date.now()];
    if (title) { sets.push("title = ?"); vals.push(title); }
    if (docId) { sets.push("doc_id = ?"); vals.push(docId); }
    vals.push(id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }

  appendMessage(sessionId, msg) {
    this.db.prepare(
      "INSERT INTO messages (session_id, json, created_at) VALUES (?, ?, ?)"
    ).run(sessionId, JSON.stringify(msg), Date.now());
  }

  getMessages(sessionId) {
    return this.db.prepare(
      "SELECT json FROM messages WHERE session_id = ? ORDER BY id"
    ).all(sessionId).map((r) => JSON.parse(r.json));
  }

  deleteSession(id) {
    this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }
}

module.exports = { Store };
