// index.js
// HaggleHub API — Mailgun -> Render -> Base44 (invoke message_processor agent)

// ENV on Render:
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
app.use(express.urlencoded({ extended: false })); // Mailgun sends form-encoded

// --- Health endpoints ---
app.get("/", (_req, res) => res.send("HaggleHub API is running."));
app.get("/health", (_req, res) => res.json({ ok: true }));

// --- Helper: split recipient email ---
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
app.post("/webhooks/email/mailgun", async (req, res) => {
  // 1) Extract Mailgun fields
  const sender     = req.body.sender || req.body.from || req.body["From"] || "";
  const subject    = req.body.subject || req.body["Subject"] || "";
  const textBody   = req.body["body-plain"] || req.body["stripped-text"] || "";
  const htmlBody   = req.body["body-html"]  || req.body["stripped-html"]  || "";
  const recipient  = req.body.recipient || req.body.to || req.body["To"] || "";
  const messageId  = req.body["message-id"] || req.body["Message-Id"] || req.body["Message-ID"] || "";

  const { local: recipientLocal, domain: recipientDomain } = splitRecipient(recipient);

  // 2) ACK Mailgun immediately (prevent retries)
  res.status(200).send("OK");

  // Log inbound
  console.log("Inbound email:", {
    sender,
    subject,
    recipient,
    recipientLocal,
    messageId,
    preview: (textBody || htmlBody || "").toString().slice(0, 160)
  });

  // 3) Forward to Base44 by invoking the agent
  try {
    const apiKey = process.env.BASE44_API_KEY;
    if (!apiKey) {
      console.error("Missing BASE44_API_KEY — cannot invoke Base44 agent");
      return;
    }
    const base44 = createClient({ apiKey });

    // Payload for your agent
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

    // Correct method for external integration
    const resp = await base44.functions.invoke("message_processor", {
      input: "Process inbound email and attach to the correct user/deal.",
      session_id: messageId || `mailgun-${recipientLocal}-${Date.now()}`,
      data: payload
    });

    console.log("Forwarded to Base44 message_processor → OK", resp);
  } catch (err) {
    console.error("Base44 forward error:", err && err.message ? err.message : String(err));
  }
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HaggleHub API listening on ${PORT}`));
