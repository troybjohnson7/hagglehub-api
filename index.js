// index.js for Render
// HaggleHub API — Mailgun -> Render -> Base44
// Primary: invoke Base44 function "messageProcessor"

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
function extractVIN(text) {
  if (!text) return "";
  const re = /\b([A-HJ-NPR-Z0-9]{17})\b/i;
  const m = text.match(re);
  return m ? m[1].toUpperCase() : "";
}
function extractDealerName(text) {
  if (!text) return "";
  const m = text.match(/from\s+([A-Za-z0-9&.,'’\-\s]+?)(?:[\.\n\r]|$)/i);
  if (!m) return "";
  let name = m[1].trim();
  if (name.toLowerCase() === "me" || name.toLowerCase() === "us") return "";
  return name.slice(0, 80);
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

  const { local: recipientLocal } = splitRecipient(recipient);

  // 2) Build safe bodies & content
  const MAX_LEN = Number(process.env.MAX_BODY_LENGTH || 4000);
  const trimmedText = trimBody(textBody, MAX_LEN);
  const trimmedHtml = trimBody(htmlBody, MAX_LEN);
  const content = trimmedText || stripHtml(trimmedHtml) || "(no content)";

  // 3) Extra hints
  const vin = extractVIN(content);
  const dealerName = extractDealerName(content);

  // 4) ACK Mailgun immediately
  res.status(200).send("OK");

  const logPayload = {
    sender,
    subject,
    recipient,
    recipientLocal,
    messageId,
    vin,
    dealerName,
    preview: content.slice(0, 160)
  };
  console.log("Inbound email:", logPayload);

  // 5) Call Base44 function with the correct payload format
  try {
    const apiKey = process.env.BASE44_API_KEY;
    if (!apiKey) {
      console.error("Missing BASE44_API_KEY — cannot invoke Base44");
      return;
    }
    const base44 = createClient({ apiKey });

    // This is the simplified payload the function expects
    const functionPayload = {
      sender,
      subject,
      recipient,
      recipientLocal,
      vin,
      dealerName,
      textBody: trimmedText,
      htmlBody: trimmedHtml,
      content, // Main content field
      raw_data: req.body // Pass the full raw payload for debugging
    };

    const resp = await base44.functions.invoke("messageProcessor", functionPayload);
    console.log("Base44 messageProcessor → OK", resp);

  } catch (err) {
    const status = err?.status || err?.response?.status;
    const data = err?.response?.data || err?.data || {};
    console.error("Base44 forward error (function):", JSON.stringify({
      name: err?.name || null,
      message: err?.message || String(err),
      status,
      data,
      code: err?.code || null
    }, null, 2));
  }
});

// ---------- start server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HaggleHub API listening on ${PORT}`));
