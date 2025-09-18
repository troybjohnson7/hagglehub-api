// index.js
// HaggleHub API — Mailgun -> Render -> Base44 function (messageProcessor)
// Adds aliasToken, vin, dealerName, preview; trims bodies; gentle retry on 5xx.

import express from "express";
import cors from "cors";
import { createClient } from "@base44/sdk";

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Mailgun posts form-encoded

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
function extractAliasToken(recipientLocal) {
  if (!recipientLocal) return "";
  const m = recipientLocal.match(/^deals?-(.+)$/i);
  return m ? m[1] : "";
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
// tiny retry helper for transient 5xx
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

// ---------- webhook ----------
app.post("/webhooks/email/mailgun", async (req, res) => {
  const sender     = req.body.sender || req.body.from || req.body["From"] || "";
  const subject    = req.body.subject || req.body["Subject"] || "";
  const textBody   = req.body["body-plain"] || req.body["stripped-text"] || "";
  const htmlBody   = req.body["body-html"]  || req.body["stripped-html"]  || "";
  const recipient  = req.body.recipient || req.body.to || req.body["To"] || "";
  const messageId  = req.body["message-id"] || req.body["Message-Id"] || req.body["Message-ID"] || "";

  const { local: recipientLocal, domain: recipientDomain } = splitRecipient(recipient);
  const aliasToken = extractAliasToken(recipientLocal);

  // Trim bodies to keep payload LLM-friendly
  const MAX_LEN = Number(process.env.MAX_BODY_LENGTH || 4000);
  const trimmedText = trimBody(textBody, MAX_LEN);
  const trimmedHtml = trimBody(htmlBody, MAX_LEN);
  const preview = (trimmedText || trimmedHtml).toString().slice(0, 160);

  // Extra hints for Base44 matching
  const vin = extractVIN(trimmedText || trimmedHtml);
  const dealerName = extractDealerName(trimmedText || trimmedHtml);

  // ACK Mailgun immediately
  res.status(200).send("OK");

  console.log("Inbound email:", {
    sender,
    subject,
    recipient,
    recipientLocal,
    messageId,
    textLen: trimmedText.length,
    htmlLen: trimmedHtml.length,
    vin,
    dealerName,
    preview
  });

  try {
    const apiKey = process.env.BASE44_API_KEY;
    if (!apiKey) {
      console.error("Missing BASE44_API_KEY — cannot invoke Base44 function");
      return;
    }
    const base44 = createClient({ apiKey });

    const payload = {
      channel: "email",
      direction: "in",
      // addressing
      senderEmail: sender,
      recipientEmail: recipient,
      recipientLocal,
      recipientDomain,
      aliasToken,
      // content
      subject,
      textBody: trimmedText,
      htmlBody: trimmedHtml,
      preview,
      // matching hints
      vin,
      dealerName,
      // idempotency
      externalId: messageId,
      source: "mailgun"
    };

    const resp = await invokeWithRetry(
      () => base44.functions.invoke("messageProcessor", {
        input: "Process inbound email and attach to the correct user/deal.",
        session_id: messageId || `mailgun-${recipientLocal || "unknown"}-${Date.now()}`,
        data: payload
      })
    );

    console.log("Base44 messageProcessor → OK", resp);
  } catch (err) {
    const safe = {
      name: err?.name || null,
      message: err?.message || String(err),
      status: err?.status || err?.response?.status || null,
      data: err?.response?.data || err?.data || null,
      code: err?.code || null
    };
    console.error("Base44 forward error:", JSON.stringify(safe, null, 2));
  }
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HaggleHub API listening on ${PORT}`));
