/**
 * store.js — 文档状态库（docs/architecture.md）
 *
 * SQLite（better-sqlite3），documents 表整 def 覆写——文档体量小，不做增量存储。
 * openStore(dbPath) 返回操作句柄；路径可注入，测试用临时库。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const openStore = (dbPath) => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL DEFAULT '',
      preset     TEXT NOT NULL,
      def        TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS templates (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL DEFAULT '',
      ext        TEXT NOT NULL DEFAULT 'docx',
      slots      TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
  `);
  // 老库迁移：kind 区分 def 文档与模板填槽文档（def 列对后者存 {templateId, slots}）
  const hasKind = db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('documents') WHERE name = 'kind'").get().n > 0;
  if (!hasKind) db.exec("ALTER TABLE documents ADD COLUMN kind TEXT NOT NULL DEFAULT 'def'");

  const insertStmt = db.prepare(
    "INSERT INTO documents (id, title, preset, def, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const getStmt = db.prepare("SELECT * FROM documents WHERE id = ?");
  const updateStmt = db.prepare("UPDATE documents SET def = ?, updated_at = ? WHERE id = ?");
  const deleteStmt = db.prepare("DELETE FROM documents WHERE id = ?");
  const insertTplStmt = db.prepare(
    "INSERT INTO templates (id, name, ext, slots, created_at) VALUES (?, ?, ?, ?, ?)");
  const getTplStmt = db.prepare("SELECT * FROM templates WHERE id = ?");
  const listTplStmt = db.prepare("SELECT * FROM templates ORDER BY created_at DESC");
  const deleteTplStmt = db.prepare("DELETE FROM templates WHERE id = ?");

  const rowToDoc = (row) => row == null ? null : {
    id: row.id,
    title: row.title,
    preset: row.preset,
    kind: row.kind || "def",
    def: JSON.parse(row.def),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  const rowToTpl = (row) => row == null ? null : {
    id: row.id,
    name: row.name,
    ext: row.ext,
    slots: JSON.parse(row.slots),
    createdAt: row.created_at,
  };

  return {
    createDocument: ({ title = "", preset, def, kind = "def" }) => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      insertStmt.run(id, title, preset, JSON.stringify(def), kind, now, now);
      return rowToDoc(getStmt.get(id));
    },
    getDocument: (id) => rowToDoc(getStmt.get(id)),
    updateDef: (id, def) => {
      const res = updateStmt.run(JSON.stringify(def), new Date().toISOString(), id);
      if (res.changes === 0) throw new Error(`文档不存在: ${id}`);
      return rowToDoc(getStmt.get(id));
    },
    deleteDocument: (id) => deleteStmt.run(id).changes > 0,
    createTemplate: ({ name = "", ext = "docx", slots = [] }) => {
      const id = crypto.randomUUID();
      insertTplStmt.run(id, name, ext, JSON.stringify(slots), new Date().toISOString());
      return rowToTpl(getTplStmt.get(id));
    },
    getTemplate: (id) => rowToTpl(getTplStmt.get(id)),
    listTemplates: () => listTplStmt.all().map(rowToTpl),
    deleteTemplate: (id) => deleteTplStmt.run(id).changes > 0,
    close: () => db.close(),
  };
};

module.exports = { openStore };
