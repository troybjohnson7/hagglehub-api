// index.js
// HaggleHub API — Mailgun -> Render -> Base44 function (messageProcessor)
// Aligns with Base44 Users.email_identifier by sending:
//   - email_identifier: "<token>"
//   - recipientLocal: "<token>"        (trimmed; NOT "deals-<token>")
// Also sends recipientLocalRaw: "deals-<token>" for debugging.

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
  return m ? m[1] : localPart; // if already token, return as-is
}
function trimBody(s, maxLen) {
  if (!s) return "";
  const str = String(s);
  return str.length > maxLen ? str.slice(0, maxLen) : str;
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

// ---------- webhook ----------
app.post("/webhooks/email/mailgun", async (req, res) => {
  // 1) Extract Mailgun fields
  const sender     = req.body.sender || req.body.from || req.body["From"] || "";
  const subject    = req.body.subject || req.body["Subject"] || "";
  const textBody   = req.body["body-plain"] || req.body["stripped-text"] || "";
  const htmlBody   = req.body["body-html"]  || req.body["stripped-html"]  || "";
  const recipient  = req.body.recipient || req.body.to || req.body["To"] || "";
  const messageId  = req.body["message-id"] || req.body["Message-Id"] || req.body["Message-ID"] || "";

  const { local: recipientLocalRaw, domain: recipientDomain } = splitRecipient(recipient);
  const token = extractTokenFromLocal(recipientLocalRaw); // <- "p8j5o5u"

  // 2) Trim bodies to keep payload LLM-friendly
  const MAX_LEN = Number(process.env.MAX_BODY_LENGTH || 4000);
  const trimmedText = trimBody(textBody, MAX_LEN);
  const trimmedHtml = trimBody(htmlBody, MAX_LEN);
  const preview = (trimmedText || trimmedHtml).toString().slice(0, 160);

  // 3) Extra hints for Base44 matching
  const vin = extractVIN(trimmedText || trimmedHtml);
  const dealerName = extractDealerName(trimmedText || trimmedHtml);

  // 4) ACK Mailgun immediately (prevent retries)
  res.status(200).send("OK");

  // Log concise summary
  console.log("Inbound email:", {
    sender,
    subject,
    recipient,
    recipientLocal: token,        // trimmed token shown prominently
    recipientLocalRaw,            // original local part e.g., "deals-p8j5o5u"
    messageId,
    textLen: trimmedText.length,
    htmlLen: trimmedHtml.length,
    vin,
    dealerName,
    preview
  });

  // 5) Invoke Base44 function with aligned keys
  try {
    const apiKey = process.env.BASE44_API_KEY;
    if (!apiKey) {
      console.error("Missing BASE44_API_KEY — cannot invoke Base44 function");
      return;
    }
    const base44 = createClient({ apiKey });

    // Aligns with Users.email_identifier
    const payload = {
      // addressing / identity
      email_identifier: token,         // <-- canonical field in your Users table
      recipientLocal: token,           // <-- match their earlier function test (trimmed)
      recipientLocalRaw,               // <-- for debugging, optional
      recipientDomain,
      senderEmail: sender,
      recipientEmail: recipient,

      // core routing
      channel: "email",
      direction: "in",

      // content
      subject,
      textBody: trimmedText,
      htmlBody: trimmedHtml,
      preview,

      // matching hints
      vin,
      dealerName,

      // meta / idempotency
      externalId: messageId,
      receivedAt: new Date().toISOString(),
      source: "mailgun",

      // convenience aliases some backends expect
      aliasToken: token,
      userToken: token,

      // instruct backend to avoid connecting undefined relations
      safeMode: true
    };

    const baseInvoke = () =>
      base44.functions.invoke("messageProcessor", {
        input: "Process inbound email and attach to the correct user/deal.",
        session_id: messageId || `mailgun-${token || "unknown"}-${Date.now()}`,
        data: payload
      });

    try {
      const resp = await invokeWithRetry(baseInvoke);
      console.log("Base44 messageProcessor → OK", resp);
    } catch (err) {
      // If Base44 returns ObjectNotFoundError, re-invoke with attachNone=true as an escape hatch
      const status = err?.status || err?.response?.status;
      const data = err?.response?.data || err?.data || {};
      const errorType = data?.error_type || data?.errorType;

      console.error("Base44 forward error (first attempt):", JSON.stringify({
        name: err?.name || null,
        message: err?.message || String(err),
        status,
        data: pick(data, ["error_type", "errorType", "message", "detail", "traceback"]),
        code: err?.code || null
      }, null, 2));

      if (status === 500 && (errorType === "ObjectNotFoundError" || /ObjectNotFound/i.test(data?.message || ""))) {
        const payload2 = { ...payload, attachNone: true };
        try {
          const resp2 = await base44.functions.invoke("messageProcessor", {
            input: "Ingest only; do not connect relations.",
            session_id: (messageId || `mailgun-${token || "unknown"}-${Date.now()}`) + "-fallback",
            data: payload2
          });
          console.log("Base44 messageProcessor (fallback attachNone) → OK", resp2);
        } catch (err2) {
          const status2 = err2?.status || err2?.response?.status;
          const data2 = err2?.response?.data || err2?.data || {};
          console.error("Base44 forward error (fallback):", JSON.stringify({
            name: err2?.name || null,
            message: err2?.message || String(err2),
            status: status2,
            data: pick(data2, ["error_type", "errorType", "message", "detail", "traceback"]),
            code: err2?.code || null
          }, null, 2));
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
