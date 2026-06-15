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

  CREATE TABLE IF NOT EXISTS knowledge_pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    title TEXT,
    content TEXT NOT NULL,
    scraped_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversation_state (
    user TEXT PRIMARY KEY,
    ai_paused INTEGER NOT NULL DEFAULT 0
  );
`);

// Migration: add `lists` column to pre-existing leads tables.
const leadCols = db.prepare("PRAGMA table_info(leads)").all().map((c) => c.name);
if (!leadCols.includes("lists")) {
  db.exec("ALTER TABLE leads ADD COLUMN lists TEXT NOT NULL DEFAULT '[]'");
}

// Migration: add `followups_opted_out` column to pre-existing conversation_state tables.
const conversationStateCols = db.prepare("PRAGMA table_info(conversation_state)").all().map((c) => c.name);
if (!conversationStateCols.includes("followups_opted_out")) {
  db.exec("ALTER TABLE conversation_state ADD COLUMN followups_opted_out INTEGER NOT NULL DEFAULT 0");
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
              l.name AS lead_name,
              COALESCE(cs.ai_paused, 0) AS ai_paused
       FROM messages m
       LEFT JOIN leads l ON l.phone = m.user
       LEFT JOIN conversation_state cs ON cs.user = m.user
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

export function deleteMessage(id) {
  return db.prepare("DELETE FROM messages WHERE id = ?").run(id).changes;
}

// --- conversation state (per-contact AI pause) ---
const isAiPausedStmt = db.prepare("SELECT ai_paused FROM conversation_state WHERE user = ?");
export function isAiPaused(user) {
  const row = isAiPausedStmt.get(user);
  return !!(row && row.ai_paused);
}
const setAiPausedStmt = db.prepare(`
  INSERT INTO conversation_state (user, ai_paused) VALUES (?, ?)
  ON CONFLICT(user) DO UPDATE SET ai_paused = excluded.ai_paused
`);
export function setAiPaused(user, paused) {
  setAiPausedStmt.run(user, paused ? 1 : 0);
}

// A contact who declines/opts out of a follow-up check-in stops receiving
// further automatic follow-up campaign messages (set by the agent via the
// stop_followups tool).
const setFollowupsOptedOutStmt = db.prepare(`
  INSERT INTO conversation_state (user, followups_opted_out) VALUES (?, ?)
  ON CONFLICT(user) DO UPDATE SET followups_opted_out = excluded.followups_opted_out
`);
export function setFollowupsOptedOut(user, optedOut) {
  setFollowupsOptedOutStmt.run(user, optedOut ? 1 : 0);
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

// --- knowledge pages (scanned from orvionresearch.com, added to the AI's knowledge base) ---
const upsertKnowledgePageStmt = db.prepare(`
  INSERT INTO knowledge_pages (url, title, content, scraped_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(url) DO UPDATE SET title = excluded.title, content = excluded.content, scraped_at = excluded.scraped_at
`);
export function upsertKnowledgePage(url, title, content) {
  upsertKnowledgePageStmt.run(url, title, content);
}
export function listKnowledgePages() {
  return db.prepare("SELECT * FROM knowledge_pages ORDER BY scraped_at DESC").all();
}
export function deleteKnowledgePage(id) {
  return db.prepare("DELETE FROM knowledge_pages WHERE id = ?").run(id).changes;
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
         AND m.user NOT IN (SELECT user FROM escalations WHERE resolved = 0)
         AND m.user NOT IN (SELECT user FROM conversation_state WHERE ai_paused = 1 OR followups_opted_out = 1)
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

const hasOpenEscalationStmt = db.prepare(
  "SELECT 1 FROM escalations WHERE user = ? AND resolved = 0 LIMIT 1",
);
export function hasOpenEscalation(user) {
  return !!hasOpenEscalationStmt.get(user);
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
