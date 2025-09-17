// index.js
// HaggleHub API — Mailgun -> Render -> Base44 (multi-identifier matching: alias, VIN, dealer)

import express from "express";
import cors from "cors";
import { createClient } from "@base44/sdk";

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // parse x-www-form-urlencoded

// --- (Optional) local debug storage so /deals/1/messages shows something
const messages = [];
const deals = [{ id: 1, dealerName: "Test Dealer", vehicleTitle: "Sample Car", status: "open" }];

app.get("/", (_req, res) => res.send("HaggleHub API is running. Try GET /deals"));
app.get("/deals", (_req, res) => res.json(deals));
app.get("/deals/:id/messages", (req, res) => {
  const dealId = Number(req.params.id);
  res.json(messages.filter((m) => m.dealId === dealId));
});

// --------- helpers ---------
function extractAliasToken(recipient) {
  // examples: deals-p8j5o5u@hagglehub.app  -> token = p8j5o5u
  //           deal-abc123@hagglehub.app    -> token = abc123
  try {
    if (!recipient) return null;
    const local = recipient.split("@")[0].trim().toLowerCase();
    let m = local.match(/^deals?-([a-z0-9_-]+)$/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function extractVIN(text) {
  // VIN: 17 chars, no I,O,Q. Case-insensitive. Common robust regex:
  const VIN_RE = /\b([A-HJ-NPR-Z0-9]{17})\b/gi;
  if (!text) return null;
  let match;
  while ((match = VIN_RE.exec(text))) {
    const vin = match[1].toUpperCase();
    return vin; // return first plausible VIN
  }
  return null;
}

function extractDealerName(text) {
  // Heuristic: look for "from {Dealer Name}" up to line break or period.
  // Example: "This is Brian from Toyota of Cedar Park. The Tundra ..."
  if (!text) return null;
  const re = /from\s+([A-Za-z0-9&.,'’\-\s]+?)(?:[\.\n\r]|$)/i;
  const m = text.match(re);
  if (m) {
    let name = m[1].trim();
    // Avoid capturing "me" or "us" etc.
    if (name.toLowerCase() === "me" || name.toLowerCase() === "us") return null;
    // cap length
    if (name.length > 80) name = name.slice(0, 80);
    return name;
  }
  return null;
}

async function findDealInBase44(base44, { aliasToken, vin, dealerName }) {
  // We’ll try in priority order:
  // 1) alias token exact match against common alias fields
  // 2) VIN exact match against likely VIN fields
  // 3) dealer name contains/ilike against name fields
  //
  // NOTE: Base44 filtering syntax can vary by project; these are common patterns.
  // If a filter is unsupported in your project, Base44 will throw — we catch and continue.

  // 1) alias exact match
  if (aliasToken) {
    const aliasFields = ["emailAliasLocal", "proxyLocal", "aliasToken", "proxyEmailLocal"];
    for (const field of aliasFields) {
      try {
        const r = await base44.entities.Deal.list({
          where: { [field]: aliasToken },
          limit: 1
        });
        if (r && r.items && r.items.length) return r.items[0].id;
      } catch (e) {
        // ignore and try next field
      }
    }
  }

  // 2) VIN exact match
  if (vin) {
    const vinFields = ["vin", "vehicleVin", "carVin"];
    for (const field of vinFields) {
      try {
        const r = await base44.entities.Deal.list({
          where: { [field]: vin },
          limit: 1
        });
        if (r && r.items && r.items.length) return r.items[0].id;
      } catch (e) {}
    }

    // Sometimes VIN is on a related Vehicle. Try a broad search if your project supports it.
    try {
      const r = await base44.entities.Deal.list({
        where: { "vehicle.vin": vin },
        limit: 1
      });
      if (r && r.items && r.items.length) return r.items[0].id;
    } catch (e) {}
  }

  // 3) dealer name contains/ilike
  if (dealerName) {
    const dealerFields = ["dealerName", "storeName", "dealer.name"];
    for (const field of dealerFields) {
      try {
        // Try case-insensitive contains if supported
        const r = await base44.entities.Deal.list({
          where: { [field]: { contains: dealerName, mode: "insensitive" } },
          limit: 3
        });
        if (r && r.items && r.items.length) {
          // If >1, just pick the first for now (you can improve scoring later)
          return r.items[0].id;
        }
      } catch (e) {
        // Try plain equality as a fallback
        try {
          const r2 = await base44.entities.Deal.list({
            where: { [field]: dealerName },
            limit: 1
          });
          if (r2 && r2.items && r2.items.length) return r2.items[0].id;
        } catch (_) {}
      }
    }
  }

  // Not found
  return null;
}

// --------- webhook ---------
app.post("/webhooks/email/mailgun", async (req, res) => {
  const sender     = req.body.sender || req.body.from || req.body["From"] || "";
  const subject    = req.body.subject || req.body["Subject"] || "";
  const textBody   = req.body["body-plain"] || req.body["stripped-text"] || "";
  const htmlBody   = req.body["body-html"]  || req.body["stripped-html"]  || "";
  const recipient  = req.body.recipient || req.body.to || req.body["To"] || "";
  const messageId  = req.body["message-id"] || req.body["Message-Id"] || req.body["Message-ID"] || "";

  // ACK Mailgun immediately
  res.status(200).send("OK");

  // Local debug stash (for /deals/1/messages)
  messages.push({
    dealId: 1, // purely local debug
    channel: "email",
    direction: "in",
    body: textBody || htmlBody || "(no body)",
    meta: { sender, subject, recipient, messageId },
    createdAt: new Date().toISOString()
  });

  // Build identifiers
  const aliasToken  = extractAliasToken(recipient);
  const vin         = extractVIN(textBody || htmlBody || "");
  const dealerName  = extractDealerName(textBody || htmlBody || "");

  console.log("Inbound email:", {
    sender,
    subject,
    recipient,
    messageId,
    aliasToken,
    vin,
    dealerName,
    preview: (textBody || htmlBody || "").toString().slice(0, 160)
  });

  // Forward into Base44 (with best-effort deal resolution)
  try {
    const apiKey = process.env.BASE44_API_KEY;
    if (!apiKey) {
      console.error("Missing BASE44_API_KEY — cannot forward to Base44");
      return;
    }
    const base44 = createClient({ apiKey });

    let b44DealId = await findDealInBase44(base44, { aliasToken, vin, dealerName });

    if (!b44DealId) {
      // Use a configured fallback so the message is never dropped
      const fallbackId = process.env.BASE44_FALLBACK_DEAL_ID || null;
      if (fallbackId) {
        console.warn("No deal matched; using BASE44_FALLBACK_DEAL_ID:", fallbackId);
        b44DealId = fallbackId;
      } else {
        console.error("No deal matched and no BASE44_FALLBACK_DEAL_ID set — message will be created without a deal (may fail if deal is required).");
      }
    }

    // Prepare payload for Message.create
    const payload = {
      channel: "email",
      direction: "in",
      senderEmail: sender,        // adjust names to your schema if needed
      recipientEmail: recipient,
      subject,
      textBody: textBody || "",
      htmlBody: htmlBody || "",
      externalId: messageId,
      aliasToken,
      vin,
      dealerName
    };

    // Try shapes in order depending on whether we found a deal id
    let created = null;
    let lastErr = null;

    if (b44DealId) {
      // Shape 1: dealId
      try {
        created = await base44.entities.Message.create({
          data: { ...payload, dealId: b44DealId }
        });
      } catch (e) { lastErr = e; }

      // Shape 2: deal.connect
      if (!created) {
        try {
          created = await base44.entities.Message.create({
            data: { ...payload, deal: { connect: { id: b44DealId } } }
          });
        } catch (e) { lastErr = e; }
      }

      // Shape 3: deal as string
      if (!created) {
        try {
          created = await base44.entities.Message.create({
            data: { ...payload, deal: b44DealId }
          });
        } catch (e) { lastErr = e; }
      }
    } else {
      // No deal id; try creating without a deal (works only if your schema allows it)
      try {
        created = await base44.entities.Message.create({ data: payload });
      } catch (e) { lastErr = e; }
    }

    if (created) {
      console.log("Forwarded to Base44 → Message.create OK", { id: created.id, dealId: b44DealId || "(none)" });
    } else {
      console.error("Base44 forward failed", lastErr && (lastErr.message || String(lastErr)));
    }
  } catch (err) {
    console.error("Base44 forward error:", err && err.message ? err.message : String(err));
  }
});

// ---- Start server ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HaggleHub API listening on ${PORT}`));
