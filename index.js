// index.js
// HaggleHub API — Mailgun -> Render -> Base44
// Primary: invoke Base44 function "messageProcessor"
// Fallback on 500/ObjectNotFoundError: upsert Dealer, then create Message
//
// Message schema requires: dealer_id, direction, content
// deal_id may be null (uncategorized)
// We'll map: direction="inbound", channel="email", content=(text or stripped html),
// subject, sender_contact, is_read=false, raw_data=<original payload>
//
// ENV on Render:
//   BASE44_API_KEY = <your Base44 project API key>
// Optional:
//   CORS_ORIGIN = https://hagglehub.app
//   MAX_BODY_LENGTH = 4000

import express from "express";
import cors from "cors";
import { createClient } from "@base44/sdk";

const app = express();

// ---------- middleware ----------
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Mailgun posts form-encoded

// ---------- health ----------
app.get("/", (_req, res) => res.send("HaggleHub API is running."));
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---------- helpers ----------
function splitRecipient(recipient) {
  let local = "", domain = "";
  if (recipient && recipient.includes("@")) {
    const parts = recipient.split("@");
    local = (parts[0] || "").trim();
    domain = (parts[1] || "").trim();
  }
  return { local, domain };
}
function extractTokenFromLocal(localPart) {
  // deals-<token> or deal-<token> -> <token>
  if (!localPart) return "";
  const m = localPart.match(/^deals?-(.+)$/i);
  return m ? m[1] : localPart;
}
function trimBody(s, maxLen) {
  if (!s) return "";
  const str = String(s);
  return str.length > maxLen ? str.slice(0, maxLen) : str;
}
function stripHtml(html) {
  if (!html) return "";
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
// VIN: 17 chars, excluding I,O,Q
function extractVIN(text) {
  if (!text) return "";
  const re = /\b([A-HJ-NPR-Z0-9]{17})\b/i;
  const m = text.match(re);
  return m ? m[1].toUpperCase() : "";
}
// crude dealer heuristic: “… from Toyota of Cedar Park.”
function extractDealerName(text) {
  if (!text) return "";
  const m = text.match(/from\s+([A-Za-z0-9&.,'’\-\s]+?)(?:[\.\n\r]|$)/i);
  if (!m) return "";
  let name = m[1].trim();
  if (name.toLowerCase() === "me" || name.toLowerCase() === "us") return "";
  return name.slice(0, 80);
}
async function invokeWithRetry(fn, tries = 2, delayMs = 350) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      const status = e?.status || e?.response?.status;
      if (status && status >= 500 && status < 600 && i < tries - 1) {
        await new Promise(r => setTimeout(r, delayMs));
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}
function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj?.[k] !== undefined) out[k] = obj[k];
  return out;
}

// ---------- Base44 fallback helpers ----------
async function findDealerIdByName(base44, name) {
  if (!name) return null;
  try {
    const res = await base44.entities.Dealer.list({
      where: { name }, // adjust if your Dealer uses a different field
      limit: 1
    });
    if (res?.items?.length) return res.items[0].id;
  } catch (e) {}
  return null;
}

async function ensureDealer(base44, name) {
  // Try exact name; if blank, default to "Unknown Dealer"
  const safeName = name && name.trim() ? name.trim() : "Unknown Dealer";
  let id = await findDealerIdByName(base44, safeName);
  if (id) return id;

  // Attempt to create Dealer with minimal fields
  try {
    const created = await base44.entities.Dealer.create({
      data: { name: safeName }
    });
    return created.id;
  } catch (e) {
    console.error("Fallback: Dealer.create failed:", e?.message || String(e));
    return null;
  }
}

async function createMessageDirect(base44, { dealer_id, subject, content, sender_contact, raw_data }) {
  // Map exactly to your Message entity fields
  const data = {
    dealer_id,                 // required
    direction: "inbound",      // required
    channel: "email",
    subject: subject || "",
    content: content || "",    // required
    sender_contact: sender_contact || "",
    is_read: false,
    raw_data: raw_data || {}
  };

  // Try straightforward create
  return base44.entities.Message.create({ data });
}

// ---------- webhook ----------
app.post("/webhooks/email/mailgun", async (req, res) => {
  // 1) Extract Mailgun fields
  const sender     = req.body.sender || req.body.from || req.body["From"] || "";
  const subject    = req.body.subject || req.body["Subject"] || "";
  const textBody   = req.body["body-plain"] || req.body["stripped-text"] || "";
  const htmlBody   = req.body["body-html"]  || req.body["stripped-html"]  || "";
  const recipient  = req.body.recipient || req.body.to || req.body["To"] || "";
  const messageId  = req.body["message-id"] || req.body["Message-Id"] || req.body["Message-ID"] || "";

  const { local: recipientLocalRaw } = splitRecipient(recipient);
  const token = extractTokenFromLocal(recipientLocalRaw); // e.g., "p8j5o5u"

  // 2) Build safe bodies & content
  const MAX_LEN = Number(process.env.MAX_BODY_LENGTH || 4000);
  const trimmedText = trimBody(textBody, MAX_LEN);
  const trimmedHtml = trimBody(htmlBody, MAX_LEN);
  const preview = (trimmedText || trimmedHtml).toString().slice(0, 160);
  const content = trimmedText || stripHtml(trimmedHtml) || preview || "(no content)";

  // 3) Extra hints
  const vin = extractVIN(trimmedText || trimmedHtml);
  const dealerName = extractDealerName(trimmedText || trimmedHtml);

  // 4) ACK Mailgun immediately
  res.status(200).send("OK");

  console.log("Inbound email:", {
    sender,
    subject,
    recipient,
    recipientLocal: token,   // trimmed token matches Users.email_identifier
    recipientLocalRaw,       // original local part
    messageId,
    textLen: trimmedText.length,
    htmlLen: trimmedHtml.length,
    vin,
    dealerName,
    preview
  });

  // 5) Call Base44 function first
  try {
    const apiKey = process.env.BASE44_API_KEY;
    if (!apiKey) {
      console.error("Missing BASE44_API_KEY — cannot invoke Base44");
      return;
    }
    const base44 = createClient({ apiKey });

    const payload = {
      // identity / addressing
      email_identifier: token,      // your Users table canonical id
      recipientLocal: token,
      recipientLocalRaw,
      senderEmail: sender,
      recipientEmail: recipient,

      // core routing
      channel: "email",
      direction: "inbound",         // matches your enum

      // content
      subject,
      content,                       // send content too (function can use it)
      textBody: trimmedText,         // still provide as hints
      htmlBody: trimmedHtml,
      preview,

      // matching hints
      vin,
      dealerName,

      // meta / idempotency
      externalId: messageId,
      receivedAt: new Date().toISOString(),
      source: "mailgun",

      // convenience aliases
      aliasToken: token,
      userToken: token,

      // instruct backend to avoid connecting undefined relations
      safeMode: true
    };

    const callFn = () =>
      base44.functions.invoke("messageProcessor", {
        input: "Process inbound email and attach to the correct user/deal.",
        session_id: messageId || `mailgun-${token || "unknown"}-${Date.now()}`,
        data: payload
      });

    try {
      const resp = await invokeWithRetry(callFn);
      console.log("Base44 messageProcessor → OK", resp);
      return; // success path
    } catch (err) {
      const status = err?.status || err?.response?.status;
      const data = err?.response?.data || err?.data || {};
      const errorType = data?.error_type || data?.errorType;

      console.error("Base44 forward error (function):", JSON.stringify({
        name: err?.name || null,
        message: err?.message || String(err),
        status,
        data: pick(data, ["error_type", "errorType", "message", "detail", "traceback"]),
        code: err?.code || null
      }, null, 2));

      // ---------- Fallback: upsert Dealer, then create Message ----------
      if (status === 500 && (errorType === "ObjectNotFoundError" || /ObjectNotFound/i.test(data?.message || ""))) {
        try {
          // Prefer parsed dealerName; if empty, use "Unknown Dealer"
          const dealer_id = await ensureDealer(base44, dealerName || "Unknown Dealer");
          if (!dealer_id) {
            console.error("Fallback: could not ensure Dealer (dealer_id missing). Message not recorded.");
            return;
          }

          const raw_data = {
            sender,
            subject,
            recipient,
            recipientLocal: recipientLocalRaw, // keep original
            token,
            messageId,
            textLen: trimmedText.length,
            htmlLen: trimmedHtml.length,
            vin,
            dealerName,
            preview
          };

          const created = await createMessageDirect(base44, {
            dealer_id,
            subject,
            content,
            sender_contact: sender,
            raw_data
          });

          console.log("Fallback: Message.create → OK", { id: created.id, dealer_id });
        } catch (err2) {
          console.error("Fallback path failed:", err2?.message || String(err2));
        }
      }
    }
  } catch (errOuter) {
    console.error("Base44 invoke wrapper error:", errOuter?.message || String(errOuter));
  }
});

// ---------- start server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HaggleHub API listening on ${PORT}`));
