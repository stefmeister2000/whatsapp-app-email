// SQLite persistence — messages, leads, escalations.
// File lives next to the project (orvion.db); excluded from git.
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(process.env.DB_PATH || path.join(__dirname, "..", "orvion.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT NOT NULL,            -- WhatsApp number (or test-chat user id)
    direction TEXT NOT NULL,       -- 'in' | 'out'
    kind TEXT NOT NULL DEFAULT 'text', -- 'text' | 'image'
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user, id);

  CREATE TABLE IF NOT EXISTS leads (
    phone TEXT PRIMARY KEY,        -- WhatsApp number
    name TEXT,
    email TEXT,
    interest TEXT,                 -- treatment interest
    marketing_consent INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    lists TEXT NOT NULL DEFAULT '[]', -- JSON array of category/list names
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS escalations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT NOT NULL,
    reason TEXT NOT NULL,
    urgency TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS broadcasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    audience TEXT NOT NULL,
    sent INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    results TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migration: add `lists` column to pre-existing leads tables.
const leadCols = db.prepare("PRAGMA table_info(leads)").all().map((c) => c.name);
if (!leadCols.includes("lists")) {
  db.exec("ALTER TABLE leads ADD COLUMN lists TEXT NOT NULL DEFAULT '[]'");
}

// --- messages ---
const insertMessage = db.prepare(
  "INSERT INTO messages (user, direction, kind, body) VALUES (?, ?, ?, ?)",
);
export function logMessage(user, direction, body, kind = "text") {
  insertMessage.run(user, direction, kind, body);
}

export function listConversations() {
  return db
    .prepare(
      `SELECT m.user,
              COUNT(*) AS message_count,
              MAX(m.created_at) AS last_at,
              (SELECT body FROM messages WHERE user = m.user ORDER BY id DESC LIMIT 1) AS last_body,
              l.name AS lead_name
       FROM messages m
       LEFT JOIN leads l ON l.phone = m.user
       GROUP BY m.user
       ORDER BY last_at DESC`,
    )
    .all();
}

export function listMessages(user, limit = 500) {
  return db
    .prepare("SELECT * FROM messages WHERE user = ? ORDER BY id ASC LIMIT ?")
    .all(user, limit);
}

// --- leads ---
const getLeadListsStmt = db.prepare("SELECT lists FROM leads WHERE phone = ?");
const upsertLeadStmt = db.prepare(`
  INSERT INTO leads (phone, name, email, interest, marketing_consent, notes, lists)
  VALUES (@phone, @name, @email, @interest, @marketing_consent, @notes, @lists)
  ON CONFLICT(phone) DO UPDATE SET
    name = COALESCE(excluded.name, name),
    email = COALESCE(excluded.email, email),
    interest = COALESCE(excluded.interest, interest),
    marketing_consent = MAX(marketing_consent, excluded.marketing_consent),
    notes = COALESCE(excluded.notes, notes),
    lists = excluded.lists,
    updated_at = datetime('now')
`);
export function upsertLead(lead) {
  const existing = getLeadListsStmt.get(lead.phone);
  const current = existing ? JSON.parse(existing.lists || "[]") : [];
  const incoming = Array.isArray(lead.lists) ? lead.lists : [];
  const merged = Array.from(new Set([...current, ...incoming]));
  upsertLeadStmt.run({
    phone: lead.phone,
    name: lead.name ?? null,
    email: lead.email ?? null,
    interest: lead.interest ?? null,
    marketing_consent: lead.marketing_consent ? 1 : 0,
    notes: lead.notes ?? null,
    lists: JSON.stringify(merged),
  });
}

export function listLeads() {
  return db
    .prepare("SELECT * FROM leads ORDER BY updated_at DESC")
    .all()
    .map((l) => ({ ...l, lists: JSON.parse(l.lists || "[]") }));
}

// Distinct list/category names across all leads — for populating dropdowns.
export function allLists() {
  const rows = db.prepare("SELECT lists FROM leads").all();
  const set = new Set();
  for (const r of rows) for (const name of JSON.parse(r.lists || "[]")) set.add(name);
  return [...set].sort();
}

// Admin overwrite (unlike upsertLead, which merges) — used by the dashboard editor.
const overwriteLeadStmt = db.prepare(`
  INSERT INTO leads (phone, name, email, interest, marketing_consent, notes, lists)
  VALUES (@phone, @name, @email, @interest, @marketing_consent, @notes, @lists)
  ON CONFLICT(phone) DO UPDATE SET
    name = excluded.name,
    email = excluded.email,
    interest = excluded.interest,
    marketing_consent = excluded.marketing_consent,
    notes = excluded.notes,
    lists = excluded.lists,
    updated_at = datetime('now')
`);
export function overwriteLead(lead) {
  overwriteLeadStmt.run({
    phone: lead.phone,
    name: lead.name || null,
    email: lead.email || null,
    interest: lead.interest || null,
    marketing_consent: lead.marketing_consent ? 1 : 0,
    notes: lead.notes || null,
    lists: JSON.stringify(Array.isArray(lead.lists) ? lead.lists : []),
  });
}

export function deleteLead(phone) {
  return db.prepare("DELETE FROM leads WHERE phone = ?").run(phone).changes;
}

// --- settings (JSON values) ---
export function getSetting(key, fallback = null) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? JSON.parse(row.value) : fallback;
}
export function setSetting(key, value) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, JSON.stringify(value));
}

// --- broadcasts ---
export function logBroadcast(message, audience, sent, failed, results) {
  db.prepare(
    "INSERT INTO broadcasts (message, audience, sent, failed, results) VALUES (?, ?, ?, ?, ?)",
  ).run(message, audience, sent, failed, JSON.stringify(results));
}
export function listBroadcasts() {
  return db
    .prepare("SELECT * FROM broadcasts ORDER BY id DESC LIMIT 50")
    .all()
    .map((b) => ({ ...b, results: JSON.parse(b.results || "[]") }));
}

// --- follow-up eligibility ---
// Real WhatsApp contacts (digits-only user ids) who have messaged us at least once.
// `campaignId` scopes the "follow-ups since reply" count to one campaign's messages
// (kind = `followup:<campaignId>`); `listFilter` restricts to leads tagged with that list.
export function followupCandidates(campaignId, listFilter) {
  const users = db
    .prepare(
      `SELECT m.user, MAX(m.created_at) AS last_at,
              MAX(CASE WHEN m.direction = 'in' THEN m.id END) AS last_in_id,
              COALESCE(l.lists, '[]') AS lists
       FROM messages m
       LEFT JOIN leads l ON l.phone = m.user
       WHERE m.user GLOB '[0-9]*' AND m.user NOT GLOB '*[^0-9]*'
       GROUP BY m.user
       HAVING last_in_id IS NOT NULL`,
    )
    .all();
  const countFollowups = db.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE user = ? AND kind = ? AND id > ?",
  );
  const kind = `followup:${campaignId}`;
  return users
    .filter((u) => !listFilter || JSON.parse(u.lists || "[]").includes(listFilter))
    .map((u) => ({
      ...u,
      followups_since_reply: countFollowups.get(u.user, kind, u.last_in_id).n,
    }));
}

// --- escalations ---
const insertEscalation = db.prepare(
  "INSERT INTO escalations (user, reason, urgency) VALUES (?, ?, ?)",
);
export function logEscalation(user, reason, urgency) {
  insertEscalation.run(user, reason, urgency);
}

export function listEscalations() {
  // Unresolved first, then urgency (high → low), newest first within each group.
  return db
    .prepare(
      `SELECT * FROM escalations
       ORDER BY resolved ASC,
                CASE urgency WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
                id DESC
       LIMIT 300`,
    )
    .all();
}

export function setEscalationResolved(id, resolved) {
  return db
    .prepare("UPDATE escalations SET resolved = ? WHERE id = ?")
    .run(resolved ? 1 : 0, id).changes;
}

export function stats() {
  return {
    conversations: db.prepare("SELECT COUNT(DISTINCT user) AS n FROM messages").get().n,
    messages: db.prepare("SELECT COUNT(*) AS n FROM messages").get().n,
    leads: db.prepare("SELECT COUNT(*) AS n FROM leads").get().n,
    emails: db.prepare("SELECT COUNT(*) AS n FROM leads WHERE email IS NOT NULL").get().n,
    escalations: db.prepare("SELECT COUNT(*) AS n FROM escalations").get().n,
    open_escalations: db.prepare("SELECT COUNT(*) AS n FROM escalations WHERE resolved = 0").get().n,
  };
}
