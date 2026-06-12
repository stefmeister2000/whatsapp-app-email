// WhatsApp Business Cloud API client (Meta Graph API).

const GRAPH_VERSION = process.env.GRAPH_API_VERSION || "v21.0";

function apiUrl() {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
}

async function post(payload) {
  const res = await fetch(apiUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WhatsApp API ${res.status}: ${body}`);
  }
  return res.json();
}

/** WhatsApp text messages cap at 4096 chars — split long replies on paragraph/line boundaries. */
function splitMessage(text, limit = 4000) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < 1) cut = limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export async function sendText(to, text) {
  for (const chunk of splitMessage(text)) {
    await post({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: true, body: chunk },
    });
  }
}

/** Upload a base64 image to WhatsApp's media store; returns a media id for sendImage. */
export async function uploadMedia(base64, mimeType) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([Buffer.from(base64, "base64")], { type: mimeType }), "upload");
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/media`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` },
      body: form,
    },
  );
  if (!res.ok) {
    throw new Error(`Media upload failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.id;
}

export async function sendImage(to, mediaId, caption) {
  await post({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "image",
    image: { id: mediaId, ...(caption ? { caption } : {}) },
  });
}

/**
 * Download a WhatsApp media attachment (image, etc.) by media id.
 * Two-step Graph API flow: resolve the media URL, then fetch the binary.
 * Returns { base64, mimeType }.
 */
export async function downloadMedia(mediaId) {
  const auth = {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` },
  };
  const metaRes = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`,
    auth,
  );
  if (!metaRes.ok) {
    throw new Error(`Media lookup failed: ${metaRes.status} ${await metaRes.text()}`);
  }
  const meta = await metaRes.json();

  const binRes = await fetch(meta.url, auth);
  if (!binRes.ok) {
    throw new Error(`Media download failed: ${binRes.status}`);
  }
  const buffer = Buffer.from(await binRes.arrayBuffer());
  return { base64: buffer.toString("base64"), mimeType: meta.mime_type };
}

/** Mark the incoming message as read and show a typing indicator while Claude thinks. */
export async function markReadWithTyping(messageId) {
  try {
    await post({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" },
    });
  } catch (err) {
    // Non-fatal (typing_indicator needs a recent Graph API version)
    console.warn("mark-read/typing failed:", err.message);
  }
}
