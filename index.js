// index.js
// HaggleHub API — Mailgun -> Render -> Base44 (functions.invoke)
// Trims bodies to avoid LLM/agent overflows that cause 500s.

import express from "express";
import cors from "cors";
import { createClient } from "@base44/sdk";

const app = express();

// --- Middleware ---
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Mailgun posts form-encoded

// --- Health ---
app.get("/", (_req, res) => res.send("HaggleHub API is running."));
app.get("/health", (_req, res) => res.json({ ok: true }));

// --- Helpers ---
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

// --- Mailgun Inbound Webhook ---
// Mailgun Route action:
//   forward("https://api.hagglehub.app/webhooks/email/mailgun"); stop()
app.post("/webhooks/email/mailgun", async (req, res) => {
  // 1) Extract Mailgun fields
  const sender     = req.body.sender || req.body.from || req.body["From"] || "";
  const subject    = req.body.subject || req.body["Subject"] || "";
  const textBody   = req.body["body-plain"] || req.body["stripped-text"] || "";
  const htmlBody   = req.body["body-html"]  || req.body["stripped-html"]  || "";
  const recipient  = req.body.recipient || req.body.to || req.body["To"] || "";
  const messageId  = req.body["message-id"] || req.body["Message-Id"] || req.body["Message-ID"] || "";

  const { local: recipientLocal, domain: recipientDomain } = splitRecipient(recipient);

  // 2) Trim bodies to keep payload LLM-friendly (defaults to 4000; can override via env)
  const MAX_LEN = Number(process.env.MAX_BODY_LENGTH || 4000);
  const trimmedText = trimBody(textBody, MAX_LEN);
  const trimmedHtml = trimBody(htmlBody, MAX_LEN);

  // 3) ACK Mailgun immediately (no retries)
  res.status(200).send("OK");

  // Log a concise summary (lengths help diagnose payload size issues)
  console.log("Inbound email:", {
    sender,
    subject,
    recipient,
    recipientLocal,
    messageId,
    textLen: trimmedText.length,
    htmlLen: trimmedHtml.length,
    preview: (trimmedText || trimmedHtml).toString().slice(0, 160)
  });

  // 4) Invoke Base44 function (agent) with trimmed payload
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
      senderEmail: sender,
      recipientEmail: recipient,
      recipientLocal,
      recipientDomain,
      subject,
      textBody: trimmedText,
      htmlBody: trimmedHtml,
      externalId: messageId,
      source: "mailgun"
    };

    const resp = await base44.functions.invoke("message_processor", {
      input: "Process inbound email and attach to the correct user/deal.",
      session_id: messageId || `mailgun-${recipientLocal || "unknown"}-${Date.now()}`,
      data: payload
    });

    console.log("Base44 message_processor → OK", resp);
  } catch (err) {
    // Print structured error details if available
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

// --- Start server (Render sets PORT) ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HaggleHub API listening on ${PORT}`));
