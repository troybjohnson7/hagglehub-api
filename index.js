// index.js
// HaggleHub API — Mailgun -> Render -> Base44 (user-routed by recipient IDENTIFIER)

import express from "express";
import cors from "cors";
import { createClient } from "@base44/sdk";

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Mailgun sends form-encoded

// (Optional) tiny debug endpoints
app.get("/", (_req, res) => res.send("HaggleHub API is running."));
app.get("/health", (_req, res) => res.json({ ok: true }));

// --- Helper: split recipient
function splitRecipient(recipient) {
  let local = "", domain = "";
  if (recipient && recipient.includes("@")) {
    const parts = recipient.split("@");
    local = parts[0].trim();
    domain = parts[1].trim();
  }
  return { local, domain };
}

// Mailgun Route action:
// forward("https://api.hagglehub.app/webhooks/email/mailgun"); stop()
app.post("/webhooks/email/mailgun", async (req, res) => {
  // 1) Read common Mailgun fields
  const sender     = req.body.sender || req.body.from || req.body["From"] || "";
  const subject    = req.body.subject || req.body["Subject"] || "";
  const textBody   = req.body["body-plain"] || req.body["stripped-text"] || "";
  const htmlBody   = req.body["body-html"]  || req.body["stripped-html"]  || "";
  const recipient  = req.body.recipient || req.body.to || req.body["To"] || "";
  const messageId  = req.body["message-id"] || req.body["Message-Id"] || req.body["Message-ID"] || "";

  const { local: recipientLocal, domain: recipientDomain } = splitRecipient(recipient);

  // 2) ACK Mailgun immediately (prevents retries)
  res.status(200).send("OK");

  console.log("Inbound email:", {
    sender,
    subject,
    recipient,
    recipientLocal,
    messageId,
    preview: (textBody || htmlBody || "").toString().slice(0, 160)
  });

  // 3) Forward to Base44 (no dealId; Base44 agent routes by recipient IDENTIFIER)
  try {
    const apiKey = process.env.BASE44_API_KEY;
    if (!apiKey) {
      console.error("Missing BASE44_API_KEY — cannot forward to Base44");
      return;
    }
    const base44 = createClient({ apiKey });

    // Send the minimal, agent-friendly payload.
    // Adjust keys to your Base44 schema if needed (e.g., use `body` instead of textBody/htmlBody).
    await base44.entities.Message.create({
      data: {
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
        // No dealId here — the message_processor inside Base44 will:
        // 1) map recipientLocal -> user
        // 2) try to match active deals (VIN/dealer, etc.)
        // 3) otherwise route to that user's fallback inbox
      }
    });

    console.log("Forwarded to Base44 → Message.create OK (agent will route)");
  } catch (err) {
    console.error("Base44 forward error:", err && err.message ? err.message : String(err));
  }
});

// ---- Start server (Render sets PORT) ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HaggleHub API listening on ${PORT}`));
