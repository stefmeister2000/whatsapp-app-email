import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateReply, resetConversation } from "./agent.js";
import { sendText, sendTemplate, sendImage, uploadMedia, markRead, markReadWithTyping, downloadMedia } from "./whatsapp.js";
import {
  logMessage,
  listConversations,
  listMessages,
  deleteMessage,
  listLeads,
  allLists,
  listEscalations,
  stats,
  overwriteLead,
  upsertLead,
  deleteLead,
  setEscalationResolved,
  logBroadcast,
  listBroadcasts,
  getSetting,
  setSetting,
  listKnowledgePages,
  upsertKnowledgePage,
  deleteKnowledgePage,
  isAiPaused,
  setAiPaused,
} from "./db.js";
import {
  getCampaigns,
  saveCampaigns,
  eligibleForCampaign,
  startFollowupScheduler,
} from "./followups.js";
import { scanPage } from "./scanner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "25mb" })); // base64 images from the test chat

const PORT = process.env.PORT || 3000;

// Meta retries webhook deliveries — dedupe on message id.
const processedIds = new Set();
function alreadyProcessed(id) {
  if (processedIds.has(id)) return true;
  processedIds.add(id);
  if (processedIds.size > 5000) {
    // drop oldest half
    const ids = [...processedIds];
    processedIds.clear();
    for (const keep of ids.slice(ids.length / 2)) processedIds.add(keep);
  }
  return false;
}

app.get("/health", (_req, res) => res.json({ ok: true }));

// --- Local test chat (browser UI, same agent brain as WhatsApp) ---
const TEST_CHAT_USER = "browser-test-user";

app.get(["/", "/chat"], (_req, res) =>
  res.sendFile(path.join(__dirname, "test-chat.html")),
);

app.post("/api/test-chat", async (req, res) => {
  const text = (req.body?.message || "").trim();
  const image = req.body?.image; // { data: base64, mimeType }
  if (!text && !image) return res.status(400).json({ error: "Empty message" });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: "ANTHROPIC_API_KEY is not set — add it to .env and restart.",
    });
  }
  let content = text;
  if (image) {
    content = [
      {
        type: "image",
        source: { type: "base64", media_type: image.mimeType, data: image.data },
      },
      {
        type: "text",
        text: text || "(The customer sent this photo without a caption — respond to what you see.)",
      },
    ];
  }
  try {
    logMessage(
      TEST_CHAT_USER,
      "in",
      image ? `[photo] ${text || "(no caption)"}` : text,
      image ? "image" : "text",
    );
    const reply = await generateReply(TEST_CHAT_USER, content);
    logMessage(TEST_CHAT_USER, "out", reply);
    res.json({ reply });
  } catch (err) {
    console.error("Test chat error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/test-chat/reset", (_req, res) => {
  resetConversation(TEST_CHAT_USER);
  res.json({ ok: true });
});

// --- Admin mini app: inbox + leads + escalations ---
function requireAdmin(req, res, next) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    return res
      .status(503)
      .json({ error: "Set ADMIN_PASSWORD in .env to enable the admin app." });
  }
  const provided =
    req.headers["x-admin-password"] || req.query.key || req.cookies?.key;
  if (provided === password) return next();
  return res.status(401).json({ error: "Wrong or missing admin password" });
}

app.get("/admin", (_req, res) =>
  res.sendFile(path.join(__dirname, "admin.html")),
);
app.get("/api/admin/overview", requireAdmin, (_req, res) =>
  res.json({
    stats: stats(),
    conversations: listConversations(),
    leads: listLeads(),
    escalations: listEscalations(),
  }),
);
app.get("/api/admin/messages", requireAdmin, (req, res) => {
  const user = req.query.user;
  if (!user) return res.status(400).json({ error: "user required" });
  res.json({ messages: listMessages(user) });
});
app.delete("/api/admin/messages/:id", requireAdmin, (req, res) => {
  res.json({ ok: true, deleted: deleteMessage(Number(req.params.id)) });
});

// Pause/resume the AI for one conversation — e.g. when the team takes over an escalation.
// While paused, incoming messages are logged but the agent does not auto-reply or send follow-ups.
app.post("/api/admin/conversations/:user/pause", requireAdmin, (req, res) => {
  setAiPaused(req.params.user, !!req.body?.paused);
  res.json({ ok: true });
});

// Manual send from the team — starts a new conversation or replies in an existing one.
// Text and/or a photo; logged with kind 'manual' (text) or 'image' (photo) so the
// inbox can tell team replies apart from the agent's automatic ones.
app.post("/api/admin/send", requireAdmin, async (req, res) => {
  const to = String(req.body?.to || "").replace(/\D/g, "");
  const message = (req.body?.message || "").trim();
  const image = req.body?.image; // { data: base64, mimeType }
  if (!to) return res.status(400).json({ error: "Recipient WhatsApp number required" });
  if (!message && !image) return res.status(400).json({ error: "Empty message" });
  if (!process.env.WHATSAPP_ACCESS_TOKEN) {
    return res.status(503).json({
      error: "WhatsApp is not connected yet (WHATSAPP_ACCESS_TOKEN missing).",
    });
  }
  try {
    if (image) {
      const mediaId = await uploadMedia(image.data, image.mimeType);
      await sendImage(to, mediaId, message || undefined);
      logMessage(to, "out", message ? `[photo] ${message}` : "[photo]", "image");
    } else {
      await sendText(to, message);
      logMessage(to, "out", message, "manual");
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message.slice(0, 300) });
  }
});

// Leads CRUD (dashboard editor — full overwrite, unlike the agent's merge)
app.post("/api/admin/leads", requireAdmin, (req, res) => {
  const { phone } = req.body || {};
  if (!phone || !String(phone).trim())
    return res.status(400).json({ error: "phone is required" });
  const lists = Array.isArray(req.body.lists)
    ? req.body.lists
    : String(req.body.lists || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  overwriteLead({
    ...req.body,
    phone: String(phone).replace(/[^\d+]/g, "").replace(/^\+/, "") || phone,
    lists,
  });
  res.json({ ok: true });
});
app.delete("/api/admin/leads/:phone", requireAdmin, (req, res) => {
  const changes = deleteLead(req.params.phone);
  res.json({ ok: true, deleted: changes });
});

// Distinct lead lists/categories actually in use — for audience pickers
app.get("/api/admin/lists", requireAdmin, (_req, res) =>
  res.json({ lists: allLists() }),
);

// Curated catalog of lists/categories (defined once, then assigned to leads via checkboxes)
app.get("/api/admin/lead-lists", requireAdmin, (_req, res) =>
  res.json({ lists: getSetting("lead_lists", []) }),
);
app.post("/api/admin/lead-lists", requireAdmin, (req, res) => {
  const lists = Array.isArray(req.body?.lists)
    ? [...new Set(req.body.lists.map((s) => String(s).trim()).filter(Boolean))]
    : [];
  setSetting("lead_lists", lists);
  res.json({ lists });
});

// Escalations: resolve / reopen
app.post("/api/admin/escalations/:id", requireAdmin, (req, res) => {
  setEscalationResolved(Number(req.params.id), !!req.body?.resolved);
  res.json({ ok: true });
});

// Marketing broadcast — sends to leads now; reports per-recipient results.
// mode "text": free-form message, only delivers to contacts who messaged within 24h.
// mode "template": pre-approved WhatsApp template, delivers regardless of the 24h window.
app.post("/api/admin/broadcast", requireAdmin, async (req, res) => {
  const mode = req.body?.mode === "template" ? "template" : "text";
  const audience = req.body?.audience || "consented";
  if (!process.env.WHATSAPP_ACCESS_TOKEN) {
    return res.status(503).json({
      error: "WhatsApp is not connected yet (WHATSAPP_ACCESS_TOKEN missing).",
    });
  }

  let message, templateName, templateLanguage, templateParams;
  if (mode === "template") {
    templateName = (req.body?.template_name || "").trim();
    templateLanguage = (req.body?.template_language || "en").trim();
    templateParams = Array.isArray(req.body?.template_params) ? req.body.template_params : [];
    if (!templateName) return res.status(400).json({ error: "Template name required" });
    message = `[template: ${templateName}]` + (templateParams.length ? ` ${templateParams.join(" | ")}` : "");
  } else {
    message = (req.body?.message || "").trim();
    if (!message) return res.status(400).json({ error: "Empty message" });
  }

  const listName = audience.startsWith("list:") ? audience.slice(5) : null;
  const targets = listLeads().filter((l) => {
    if (!/^\d+$/.test(l.phone)) return false;
    if (listName) return l.lists.includes(listName);
    if (audience === "all") return true;
    return l.marketing_consent;
  });
  const results = [];
  for (const lead of targets) {
    try {
      if (mode === "template") {
        await sendTemplate(lead.phone, templateName, templateLanguage, templateParams);
      } else {
        await sendText(lead.phone, message);
      }
      logMessage(lead.phone, "out", message, "broadcast");
      results.push({ phone: lead.phone, name: lead.name, ok: true });
    } catch (err) {
      results.push({ phone: lead.phone, name: lead.name, ok: false, error: err.message.slice(0, 200) });
    }
  }
  const sent = results.filter((r) => r.ok).length;
  logBroadcast(message, audience, sent, results.length - sent, results);
  res.json({ sent, failed: results.length - sent, results });
});
app.get("/api/admin/broadcasts", requireAdmin, (_req, res) =>
  res.json({ broadcasts: listBroadcasts() }),
);

// Follow-up campaigns — multiple targeted lists, each with its own cadence.
app.get("/api/admin/followups", requireAdmin, (_req, res) => {
  const campaigns = getCampaigns().map((c) => ({
    ...c,
    eligible_now: eligibleForCampaign(c).length,
  }));
  res.json({ campaigns, lists: allLists() });
});
app.post("/api/admin/followups", requireAdmin, (req, res) => {
  const body = req.body || {};
  const input = Array.isArray(body.campaigns) ? body.campaigns : [];
  let nextId = Date.now();
  const campaigns = input.map((c) => ({
    id: c.id || nextId++,
    name: (c.name || "Follow-up").trim(),
    list: (c.list || "").trim(),
    message: (c.message || "").trim(),
    enabled: !!c.enabled,
    quiet_hours: Math.min(168, Math.max(1, Number(c.quiet_hours) || 24)),
    max_per_lead: Math.min(10, Math.max(1, Number(c.max_per_lead) || 3)),
  }));
  saveCampaigns(campaigns);
  res.json({
    campaigns: campaigns.map((c) => ({ ...c, eligible_now: eligibleForCampaign(c).length })),
    lists: allLists(),
  });
});

// Knowledge base — extra pages scanned from orvionresearch.com.
app.get("/api/admin/knowledge", requireAdmin, (_req, res) => {
  res.json({ pages: listKnowledgePages() });
});
app.post("/api/admin/knowledge", requireAdmin, async (req, res) => {
  const url = (req.body?.url || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: "Enter a valid http(s) URL" });
  }
  try {
    const { title, content } = await scanPage(url);
    upsertKnowledgePage(url, title, content);
    res.json({ pages: listKnowledgePages() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.delete("/api/admin/knowledge/:id", requireAdmin, (req, res) => {
  deleteKnowledgePage(Number(req.params.id));
  res.json({ pages: listKnowledgePages() });
});

// Webhook verification handshake (Meta App Dashboard → Webhooks → Verify)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("Webhook verified");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Incoming messages
app.post("/webhook", (req, res) => {
  // Ack immediately — Meta times out at ~10s and Claude may take longer.
  res.sendStatus(200);

  const value = req.body?.entry?.[0]?.changes?.[0]?.value;
  const messages = value?.messages;
  if (!messages) return; // status updates (delivered/read) etc.

  for (const message of messages) {
    handleMessage(message).catch((err) =>
      console.error("Message handling failed:", err),
    );
  }
});

async function handleMessage(message) {
  if (alreadyProcessed(message.id)) return;

  const from = message.from; // WhatsApp number of the sender

  // The team has taken over this conversation — log the message for the inbox
  // but don't auto-reply (no canned replies, no AI, no follow-ups).
  if (isAiPaused(from)) {
    let label;
    if (message.type === "text") label = message.text.body;
    else if (message.type === "interactive") label = message.interactive?.button_reply?.title || message.interactive?.list_reply?.title;
    else if (message.type === "image") label = `[image] ${message.image?.caption?.trim() || "(no caption)"}`;
    else if (message.type === "audio") label = "[voice note]";
    else label = `[${message.type}]`;
    console.log(`[in, AI paused] ${from}: ${label}`);
    logMessage(from, "in", label, message.type === "image" ? "image" : "text");
    upsertLead({ phone: from, marketing_consent: true, lists: ["WhatsApp contacts"] });
    await markRead(message.id);
    return;
  }

  const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

  // Build the content for Claude: plain text, or [image, text] blocks.
  let content;
  let logLabel;
  if (message.type === "text") {
    content = message.text.body;
    logLabel = content;
  } else if (message.type === "interactive") {
    content =
      message.interactive?.button_reply?.title ||
      message.interactive?.list_reply?.title;
    logLabel = content;
  } else if (message.type === "image") {
    try {
      const { base64, mimeType } = await downloadMedia(message.image.id);
      if (!SUPPORTED_IMAGE_TYPES.includes(mimeType)) {
        await sendText(
          from,
          "Sorry, I couldn't open that image format. Could you send it as a regular photo (JPG/PNG)?",
        );
        return;
      }
      const caption = message.image.caption?.trim();
      content = [
        {
          type: "image",
          source: { type: "base64", media_type: mimeType, data: base64 },
        },
        {
          type: "text",
          text: caption || "(The customer sent this photo without a caption — respond to what you see.)",
        },
      ];
      logLabel = `[image] ${caption || "(no caption)"}`;
    } catch (err) {
      console.error("Image download failed:", err.message);
      await sendText(
        from,
        "I had trouble opening that image — could you try sending it again?",
      );
      return;
    }
  } else if (message.type === "audio") {
    await sendText(
      from,
      "I can't listen to voice notes just yet — could you type your question? A team member can also call you back if you prefer.",
    );
    return;
  } else {
    await sendText(
      from,
      "I can read text messages and photos. How can I help you with Orvion's treatments, pricing or delivery?",
    );
    return;
  }
  if (!content) return;

  if (typeof content === "string" && content.trim().toLowerCase() === "/reset") {
    resetConversation(from);
    await sendText(from, "Conversation reset. How can I help?");
    return;
  }

  console.log(`[in] ${from}: ${logLabel}`);
  logMessage(from, "in", logLabel, message.type === "image" ? "image" : "text");
  // Every WhatsApp contact already consented to marketing on the website, so
  // mark them as a consented lead and tag them for follow-up campaigns.
  upsertLead({ phone: from, marketing_consent: true, lists: ["WhatsApp contacts"] });
  await markReadWithTyping(message.id);

  try {
    const reply = await generateReply(from, content);
    console.log(`[out] ${from}: ${reply.slice(0, 120)}...`);
    logMessage(from, "out", reply);
    await sendText(from, reply);
  } catch (err) {
    console.error("Claude error:", err);
    await sendText(
      from,
      "Sorry, something went wrong on my side. Please try again in a moment, or reach our team at hello@orvionresearch.com / +971 55 905 6884.",
    );
  }
}

const required = [
  "ANTHROPIC_API_KEY",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_VERIFY_TOKEN",
];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.warn(`⚠️  Missing env vars: ${missing.join(", ")} — see .env.example`);
}

app.listen(PORT, () => {
  console.log(`Orvion WhatsApp agent listening on :${PORT}`);
  console.log(`Webhook URL: POST /webhook · Verification: GET /webhook`);
  startFollowupScheduler();
});
