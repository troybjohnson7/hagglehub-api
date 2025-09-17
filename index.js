// index.js
// HaggleHub API (Render) — Mailgun -> Render -> Base44 (no deal-id parsing)

import express from "express";
import cors from "cors";
import { createClient } from "@base44/sdk";

const app = express();

// ---- Middleware ----
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // parse Mailgun form posts

// ---- Simple debug data (optional) ----
const messages = []; // just so you can view something at /deals/1/messages
const deals = [{ id: 1, dealerName: "Test Dealer", vehicleTitle: "Sample Car", status: "open" }];

app.get("/", (_req, res) => res.send("HaggleHub API is running. Try GET /deals"));
app.get("/deals", (_req, res) => res.json(deals));
app.get("/deals/:id/messages", (req, res) => {
  const dealId = Number(req.params.id);
  res.json(messages.filter(m => m.dealId === dealId));
});

// ---- Mailgun Inbound Webhook ----
// Mailgun Route action:
// forward("https://api.hagglehub.app/webhooks/email/mailgun"); stop();
app.post("/webhooks/email/mailgun", async (req, res) => {
  // 1) Pull common fields from Mailgun
  const sender    = req.body.sender || req.body.from || req.body["From"] || "";
  const subject   = req.body.subject || req.body["Subject"] || "";
  const textBody  = req.body["body-plain"] || req.body["stripped-text"] || "";
  const htmlBody  = req.body["body-html"]  || req.body["stripped-html"]  || "";
  const recipient = req.body.recipient || req.body.to || req.body["To"] || "";
  const messageId = req.body["message-id"] || req.body["Message-Id"] || req.body["Message-ID"] || "";

  // Split recipient for matching on your Base44 side (unique email per user)
  let recipientLocal = "";
  let recipientDomain = "";
  if (recipient && recipient.includes("@")) {
    const parts = recipient.split("@");
    recipientLocal = parts[0].trim();
    recipientDomain = parts[1].trim();
  }

  // 2) Immediately ACK Mailgun (prevents retries)
  res.status(200).send("OK");

  // 3) Log + store a local debug copy (optional; always uses dealId=1 locally)
  messages.push({
    dealId: 1, // purely for your local debug endpoint
    channel: "email",
    direction: "in",
    body: textBody || htmlBody || "(no body)",
    meta: { sender, subject, recipient, messageId, recipientLocal, recipientDomain },
    createdAt: new Date().toISOString()
  });
  console.log("Inbound email:", {
    sender,
    subject,
    recipient,
    messageId,
    preview: (textBody || htmlBody || "").toString().slice(0, 160)
  });

  // 4) Forward to Base44 with NO deal reference
  //    Your Base44 side should associate by recipientLocal/recipient (unique proxy),
  //    or by sender/name heuristics you control there.
  try {
    const apiKey = process.env.BASE44_API_KEY;
    if (!apiKey) {
      console.error("Missing BASE44_API_KEY — cannot forward to Base44");
      return;
    }
    const base44 = createClient({ apiKey });

    // 🔧 Adjust keys below to match your Base44 Message entity schema.
    // Suggested minimal fields for easy matching on Base44:
    // - channel, direction
    // - senderEmail, recipientEmail, recipientLocal, recipientDomain
    // - subject, textBody, htmlBody, messageId
    // If your entity uses different names, rename the keys in `data` accordingly.
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
        externalId: messageId   // optional external reference
      }
    });

    console.log("Forwarded to Base44 → Message.create OK (no dealId used)");
  } catch (err) {
    console.error("Base44 forward error:", err && err.message ? err.message : String(err));
  }
});

// ---- Start server ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HaggleHub API listening on ${PORT}`));
