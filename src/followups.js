// Automated follow-up campaigns to people who already messaged us.
// Each campaign (set from the admin Follow-ups tab, stored in settings under
// "followup_campaigns") looks like:
//   { id, name, list (optional list/category filter, "" = everyone), message,
//     enabled, per_week (1-7), max_per_lead }
// Cadence: a contact is eligible for a campaign when their conversation has
// been quiet for 7/per_week days AND they've received fewer than max_per_lead
// follow-ups from THIS campaign since their last reply. A reply resets the counter.
import { getSetting, setSetting, followupCandidates, logMessage } from "./db.js";
import { sendText } from "./whatsapp.js";

const CHECK_EVERY_MS = 30 * 60 * 1000; // every 30 minutes

export function getCampaigns() {
  return getSetting("followup_campaigns", []);
}

export function saveCampaigns(campaigns) {
  setSetting("followup_campaigns", campaigns);
}

export function eligibleForCampaign(campaign) {
  if (!campaign.message) return [];
  const quietMs = (7 / Math.max(1, campaign.per_week)) * 24 * 3600 * 1000;
  const cutoff = Date.now() - quietMs;
  return followupCandidates(campaign.id, campaign.list || null).filter((c) => {
    const lastAt = new Date(c.last_at.replace(" ", "T") + "Z").getTime();
    return lastAt < cutoff && c.followups_since_reply < campaign.max_per_lead;
  });
}

async function tick() {
  if (!process.env.WHATSAPP_ACCESS_TOKEN) return; // not connected yet

  for (const campaign of getCampaigns()) {
    if (!campaign.enabled || !campaign.message) continue;
    for (const contact of eligibleForCampaign(campaign)) {
      try {
        await sendText(contact.user, campaign.message);
        logMessage(contact.user, "out", campaign.message, `followup:${campaign.id}`);
        console.log(`[FOLLOWUP:${campaign.name}] sent to ${contact.user}`);
      } catch (err) {
        // Most common cause: outside WhatsApp's 24h window (needs a template).
        console.warn(`[FOLLOWUP:${campaign.name}] failed for ${contact.user}: ${err.message}`);
      }
    }
  }
}

export function startFollowupScheduler() {
  setInterval(() => tick().catch((e) => console.error("Followup tick:", e)), CHECK_EVERY_MS);
  console.log("Follow-up scheduler running (checks every 30 min)");
}
