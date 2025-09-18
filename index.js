// index.js
// HaggleHub API — Mailgun -> Render -> Base44 agent (message_processor)
// - Receives Mailgun webhook
// - ACKs 200 immediately (prevents retries)
// - Invokes Base44 agent with the raw email payload
//
// ENV needed on Render:
//   BASE44_API_KEY = <your Base44 project API key>
// Optional:
//   CORS_ORIGIN = https://hagglehub.app

import express from "express";
import cors from "cors";
import { createClient } from "@base44/sdk";

const app = express();

// --- Middleware ---
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Mailgun posts form-encoded

// --- Simple health endpoints (handy for checks) ---
app.get("/", (_req, res) => res.send("HaggleHub API is running."));
app.get("/health", (_req, res) => res.json({ ok: true }));

// --- Helper: split an email address into local and domain parts
function splitRecipient(recipient) {
  let local = "", domain = "";
  if (recipient && recipient.includes("@")) {
    const parts = recipient.split("@");
    local = (parts[0] || "").trim();
    domain = (parts[1] || "").trim();
  }
  return { local, domain };
}

// --- Mailgun Inbound Webhook ---
// In Mailgun -> Routes, set:
//   forward("https://api.hagglehub.app/webhooks/email/mailgun")
//   stop()
app.post("/webhooks/email/mailgun", async (req, res) => {
  // 1) Read common Mailgun fields safely
  const sender     = req.body.sender || req.body.from || req.body["From"] || "";
  const subject    = req.body.subject || req.body["Subject"] || "";
  const textBody   = req.body["body-plain"] || req.body["stripped-text"] || "";
  const htmlBody   = req.body["body-html"]  || req.body["stripped-html"]  || "";
  const recipient  = req.body.recipient || req.body.to || req.body["To"] || "";
  const messageId  = req.body["message-id"] || req.body["Message-Id"] || req.body["Message-ID"] || "";

  const { local: recipientLocal, domain: recipientDomain } = splitRecipient(recipient);

  // 2) ACK Mailgun immediately (so it won't retry even if later steps fail)
  res.status(200).send("OK");

  // Log for visibility
  console.log("Inbound email:", {
    sender,
    subject,
    recipient,
    recipientLocal,
    messageId,
    preview: (textBody || htmlBody || "").toString().slice(0, 160)
  });

  // 3) Invoke the Base44 agent to do routing + create the Message
  try {
    const apiKey = process.env.BASE44_API_KEY;
    if (!apiKey) {
      console.error("Missing BASE44_API_KEY — cannot invoke Base44 agent");
      return;
    }
    const base44 = createClient({ apiKey });

    // Send a clean payload that your agent expects
    const payload = {
      channel: "email",
      direction: "in",
      senderEmail: sender,
      recipientEmail: recipient,
      recipientLocal,
      recipientDomain,
      subject,
      textBody: textBody || "",
      htmlBody: htmlBody || "",
      externalId: messageId
    };

    // IMPORTANT: use the non-service invoke (no asServiceRole)
    const resp = await base44.agents.invoke("message_processor", {
      input: "Process inbound email and attach to the correct user/deal.",
      session_id: messageId || `mailgun-${recipientLocal}-${Date.now()}`, // helps dedupe
      data: payload
    });

    console.log("Forwarded to Base44 agent → OK", resp && (resp.id || JSON.stringify(resp)));
  } catch (err) {
    console.error("Base44 agent invoke error:", err && err.message ? err.message : String(err));
  }
});

// --- Start server (Render sets PORT) ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HaggleHub API listening on ${PORT}`));
