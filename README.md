# Orvion WhatsApp AI Agent

A WhatsApp Business agent powered by **Claude Opus 4.8** that knows the entire
[orvionresearch.com](https://orvionresearch.com) website — all four service lines
(Weight Loss, Hair Loss, Men's Health, Peptides), pricing, the intake process,
shipping, refunds, and policies.

## What it does

- Answers patient questions on WhatsApp from a built-in knowledge base scraped from the website — never invents prices or policies.
- Replies in WhatsApp style (short, warm, plain text), in English or Arabic.
- **Medical safety guardrails**: never gives medical advice or dosing; routes medical questions to Orvion's licensed physicians, and emergencies to 998.
- **Human handoff**: an `escalate_to_human` tool flags order/account/delivery issues, press, partnerships, or anything it can't answer (optionally to a Slack/webhook URL).
- Remembers each contact's conversation (last 20 turns, in-memory).
- **Prompt caching**: the knowledge base is cached, so repeat messages cost ~10% of the input price.
- Handles Meta webhook retries (dedupe), splits replies over WhatsApp's 4096-char limit, shows read receipts + typing indicator.

- **Admin mini app** at `/admin` (password: `ADMIN_PASSWORD` in `.env`): live inbox of every conversation, a leads CRM (name, WhatsApp number, email, treatment interest, marketing consent, lists/categories), a marketing broadcast tool, follow-up campaigns, and the escalation log. Auto-refreshes every 5 seconds.
- **Lead & email capture**: the agent fills the leads database itself via a `save_lead` tool — it asks interested customers for their email at a natural moment and records marketing consent only when explicitly given. It can also tag a lead into a list (e.g. "Hair Loss - Women (Waitlist)") for later targeted outreach.
- **Lists/categories**: any lead can be tagged into one or more custom lists from the Leads tab. Marketing broadcasts and follow-up campaigns can target a specific list, "all leads", or "leads with marketing consent".
- **Follow-up campaigns**: define multiple automated re-engagement campaigns, each with its own target list, message, and cadence (per week / max follow-ups before stopping). Runs on a 30-minute scheduler.
- **SQLite persistence** (`orvion.db`): messages, leads, escalations, broadcasts, and follow-up campaigns survive restarts.

## Project layout

| File | Purpose |
|---|---|
| `src/server.js` | Express webhook server + test chat + admin API |
| `src/agent.js` | Claude agent: system prompt, compliance policy, tools (escalate, save_lead) |
| `src/knowledge.js` | Full Orvion knowledge base (edit here when the site changes) |
| `src/whatsapp.js` | WhatsApp Cloud API client (send, media download, read receipts) |
| `src/db.js` | SQLite store: messages, leads, escalations |
| `src/admin.html` | Admin dashboard UI (inbox / leads / escalations) |
| `src/test-chat.html` | WhatsApp-style browser test chat (text + photos) |
| `src/chat-cli.js` | Terminal chat for testing without WhatsApp |

## Setup

### 1. Install & configure

```bash
cd orvion-whatsapp-agent
npm install
cp .env.example .env   # then fill in the values
```

You need:

- **`ANTHROPIC_API_KEY`** — from [platform.claude.com](https://platform.claude.com)
- **WhatsApp Cloud API credentials** — from [developers.facebook.com](https://developers.facebook.com):
  1. Create a Meta App → add the **WhatsApp** product.
  2. On *API Setup*, copy the **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`.
  3. Generate a token → `WHATSAPP_ACCESS_TOKEN`. (For production, create a permanent **System User** token in Meta Business Settings with `whatsapp_business_messaging` permission.)
  4. Invent any secret string → `WHATSAPP_VERIFY_TOKEN`.

### 2. Test locally without WhatsApp

```bash
npm run chat
```

Chat with the agent in your terminal — useful for tuning the prompt and knowledge base.

### 3. Connect the webhook

The server must be reachable over HTTPS. For local dev:

```bash
npm run dev          # starts on :3000
ngrok http 3000      # or cloudflared tunnel --url http://localhost:3000
```

In the Meta App Dashboard → WhatsApp → **Configuration**:

- Callback URL: `https://<your-domain>/webhook`
- Verify token: the same `WHATSAPP_VERIFY_TOKEN` from `.env`
- Click **Verify and save**, then subscribe to the **messages** webhook field.

Send a WhatsApp message to your business number — the agent replies.

### 4. Deploy

Any Node 18+ host works (Railway, Render, Fly.io, a VPS). Set the env vars and run `npm start`.

## Notes for production

- **Conversation memory is in-memory** — it resets on restart and doesn't scale past one instance. Swap the `Map` in `src/agent.js` for Redis or SQLite.
- **24-hour window**: WhatsApp lets businesses send free-form replies only within 24h of the user's last message. Replies to incoming messages (this bot's only behavior) are always fine; proactive outreach needs approved templates.
- **Updating knowledge**: when orvionresearch.com changes, update `src/knowledge.js`. The whole knowledge base is one cached string — edits take effect on restart.
- Type `/reset` in WhatsApp to clear your conversation history (handy while testing).
