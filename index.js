// HaggleHub API (starter) — Express + Mailgun inbound
// Endpoints:
//   GET  /health
//   GET  /deals
//   GET  /deals/:id/messages
//   POST /deals/:id/messages          (stub for outbound email; logs only)
//   POST /webhooks/email/mailgun      (inbound email from Mailgun; returns 200 fast)
//
// Deploy on Render as a Web Service:
//   Build: npm install
//   Start: npm start
//
// Env Vars (Render → Environment):
//   CORS_ORIGIN=https://app.hagglehub.app   (or * while testing)
//   MAILGUN_DOMAIN=hagglehub.app
//   MAILGUN_API_KEY=key-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
//   MAIL_FROM=noreply@hagglehub.app         (used later for outbound)

import express from "express";
import cors from "cors";

// --- Mailgun send helper (outbound email) ---
async function sendEmailViaMailgun({ to, subject, text, html }) {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  const from   = process.env.MAIL_FROM;

  if (!apiKey || !domain || !from) {
    throw new Error("Missing MAILGUN_API_KEY, MAILGUN_DOMAIN, or MAIL_FROM");
  }

  const url = `https://api.mailgun.net/v3/${domain}/messages`;
  const auth = "Basic " + Buffer.from(`api:${apiKey}`).toString("base64");

  // Mailgun expects form-encoded body
  const form = new URLSearchParams();
  form.set("from", from);
  form.set("to", to);
  form.set("subject", subject || "");
  if (html) form.set("html", html);
  form.set("text", text || "");

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString()
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Mailgun send failed: ${res.status} ${res.statusText} ${body}`);
  }

  return res.json();
}

const app = express();

// ===== Middleware =====
app.use(cors({ origin: process.env.CORS_ORIGIN || "*"}));
app.use(express.json());
// Mailgun will POST form-encoded fields by default
app.use(express.urlencoded({ extended: false }));

// ===== In-memory data (MVP) =====
const deals = [
  { id: 1, dealerName: "Test Dealer", vehicleTitle: "Sample Car", url: "", status: "open", best_offer_otd: null }
];
const messages = []; // { id, dealId, channel, direction, body, meta, createdAt }

// ===== Routes =====

// Healthcheck
app.get("/health", (req, res) => res.json({ ok: true }));

// List deals
app.get("/deals", (req, res) => res.json(deals));

// List messages for a deal
app.get("/deals/:id/messages", (req, res) => {
  const dealId = Number(req.params.id);
  res.json(messages.filter(m => m.dealId === dealId));
});

// Create outbound message (now sends email via Mailgun)
app.post("/deals/:id/messages", async (req, res) => {
  try {
    const dealId = Number(req.params.id);
    const { channel = "email", to, subject = "", body = "", html } = req.body || {};

    if (channel !== "email") {
      return res.status(400).json({ error: "Only email is supported in this patch" });
    }
    if (!to) {
      return res.status(400).json({ error: "Missing 'to' (dealer email)" });
    }

    // Ensure we tag the subject with the Deal id so replies auto-attach later
    const taggedSubject = subject.includes("[Deal#")
      ? subject
      : `[Deal#${dealId}] ${subject || "HaggleHub message"}`;

    // 1) Send via Mailgun
    await sendEmailViaMailgun({
      to,
      subject: taggedSubject,
      text: body,
      html
    });

    // 2) Save to timeline (outbound)
    const msg = {
      id: messages.length + 1,
      dealId,
      channel: "email",
      direction: "out",
      body: String(body || ""),
      meta: { to, subject: taggedSubject },
      createdAt: new Date().toISOString()
    };
    messages.push(msg);

    console.log("Outbound email sent:", { to, subject: taggedSubject, preview: (body || "").slice(0, 120) });
    res.json(msg);
  } catch (err) {
    console.error("Outbound email error:", err.message || String(err));
    res.status(502).json({ error: "Failed to send email", details: err.message || String(err) });
  }
});

  messages.push(msg);

  // TODO: implement outbound email via Mailgun API (kept as stub for now)
  console.log("Outbound message (stub):", { to, subject, preview: (body || "").slice(0, 120) });

  res.json(msg);
});

// Inbound Mailgun webhook (dealer -> HaggleHub via email)
app.post("/webhooks/email/mailgun", async (req, res) => {
  try {
    const f = req.body || {};
    const sender  = f.sender || f.from || f["From"] || "";
    const subject = f.subject || f["Subject"] || "";
    const text    = f["body-plain"] || f["stripped-text"] || "";
    const html    = f["body-html"]  || f["stripped-html"]  || "";
    const messageId = f["message-id"] || f["Message-Id"] || f["Message-ID"] || "";

    // Very basic deal association: always attach to deal #1 for MVP
    const dealId = 1;

    messages.push({
      id: messages.length + 1,
      dealId,
      channel: "email",
      direction: "in",
      body: text || html || "(no body)",
      meta: { sender, subject, messageId },
      createdAt: new Date().toISOString()
    });

    console.log("Inbound email (Mailgun):", {
      sender, subject, preview: (text || html || "").slice(0, 120)
    });

    // Always ack 200 quickly so Mailgun doesn't retry
    return res.status(200).send("OK");
  } catch (e) {
    console.error("Inbound email error:", e && e.message ? e.message : String(e));
    // Still 200 while debugging to avoid retries
    return res.status(200).send("OK");
  }
});

// Root hint
app.get("/", (req, res) => {
  res.send("HaggleHub API is running. Try GET /deals or POST /webhooks/email/mailgun");
});

// ===== Start =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HaggleHub API listening on ${PORT}`));
