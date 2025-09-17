// index.js
// HaggleHub API (Render) — Mailgun -> Render -> Base44 forwarder

import express from "express";
import cors from "cors";
import { createClient } from "@base44/sdk";

const app = express();

// ---- Middleware ----
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());
// Mailgun posts as x-www-form-urlencoded (and sometimes multipart)
// This parser covers urlencoded form bodies:
app.use(express.urlencoded({ extended: false }));

// ---- Simple in-memory test data (optional) ----
const messages = []; // {dealId, channel, direction, body, meta, createdAt}
const deals = [{ id: 1, dealerName: "Test Dealer", vehicleTitle: "Sample Car", status: "open" }];

// ---- Health / sanity routes ----
app.get("/", (req, res) => res.send("HaggleHub API is running. Try GET /deals"));
app.get("/deals", (req, res) => res.json(deals));
app.get("/deals/:id/messages", (req, res) => {
  const dealId = Number(req.params.id);
  res.json(messages.filter(m => m.dealId === dealId));
});

// ---- Mailgun Inbound Webhook ----
// Set this URL in Mailgun -> Routes:
// forward("https://api.hagglehub.app/webhooks/email/mailgun"); stop();
app.post("/webhooks/email/mailgun", async (req, res) => {
  // 1) Extract common Mailgun fields safely
  const sender   = req.body.sender || req.body.from || req.body["From"] || "";
  const subject  = req.body.subject || req.body["Subject"] || "";
  const textBody = req.body["body-plain"] || req.body["stripped-text"] || "";
  const toHeader = req.body.recipient || req.body.to || req.body["To"] || "";

  // 2) Determine dealId
  //    Preferred: subject contains [Deal#123] or Deal#123
  //    Fallback: recipient local-part looks like deal-123@ or deals-123@
  let dealId;
  const m1 = subject.match(/\[Deal#(\d+)\]/i);   // [Deal#123]
  const m2 = subject.match(/\bDeal#(\d+)\b/i);   // Deal#123
  if (m1) dealId = Number(m1[1]);
  else if (m2) dealId = Number(m2[1]);
  else {
    const toLocal = (toHeader || "").split("@")[0]; // before @
    const m3 = toLocal.match(/deals?-(\d+)/i);       // deal-123 / deals-123
    if (m3) dealId = Number(m3[1]);
  }
  if (!dealId) dealId = 1; // Fallback for testing

  // 3) ACK Mailgun immediately (prevents retries even if our later steps fail)
  res.status(200).send("OK");

  // 4) Log and store a local copy (optional, for debugging)
  messages.push({
    dealId,
    channel: "email",
    direction: "in",
    body: textBody || "(no body)",
    meta: { sender, subject, toHeader },
    createdAt: new Date().toISOString()
  });
  console.log("Inbound email:", {
    sender,
    subject,
    dealId,
    preview: (textBody || "").slice(0, 120)
  });

  // 5) Forward into Base44 so your app UI (which reads from Base44) will see it
  try {
    const apiKey = process.env.BASE44_API_KEY;
    if (!apiKey) {
      console.error("Missing BASE44_API_KEY — cannot forward to Base44");
      return;
    }

    // Create a normal Base44 client using your project API key (no asServiceRole)
    const base44 = createClient({ apiKey });

    // Adjust fields here if your Base44 "Message" entity uses different names
    await base44.entities.Message.create({
      data: {
        channel: "email",
        direction: "in",
        sender: sender,
        subject: subject,
        body: textBody || "",
        dealId: dealId
      }
    });

    console.log("Forwarded to Base44 → Message.create OK (dealId:", dealId, ")");
  } catch (err) {
    console.error(
      "Base44 forward error:",
      err && err.message ? err.message : String(err)
    );
  }
});

// ---- Start server (Render sets PORT) ----
const PORT = process.env.PORT || 3000;
// Some platforms require binding to 0.0.0.0; Render handles this automatically.
app.listen(PORT, () => console.log(`HaggleHub API listening on ${PORT}`));
