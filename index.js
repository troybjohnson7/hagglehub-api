// HaggleHub API — Express + Mailgun (token-based routing)
// Endpoints:
//   GET  /health
//   GET  /deals                      (includes proxyEmail for each deal)
//   GET  /deals/:param/messages      (:param = numeric id OR deal key/token)
//   POST /deals/:param/messages      (send email; Reply-To = deal proxy email)
//   POST /webhooks/email/mailgun     (inbound email; attaches by recipient token)
//
// Render deploy:
//   Build: npm install
//   Start: npm start
//
// Required ENV (Render → Service → Environment):
//   CORS_ORIGIN=https://app.hagglehub.app   (or * while testing)
//   MAILGUN_DOMAIN=hagglehub.app            (or mg.hagglehub.app)
//   MAILGUN_API_KEY=key-xxxxxxxxxxxxxxxxxxx
//   MAIL_FROM=HaggleHub <noreply@hagglehub.app>

import express from "express";
import cors from "cors";

const app = express();

// ===== Middleware =====
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());
// Mailgun posts form-encoded by default
app.use(express.urlencoded({ extended: false }));

// ===== In-memory data (MVP) =====
// Give each deal a stable human-friendly token "key"
const deals = [
  {
    id: 1,
    key: "p8j5o5u",              // TOKEN visible in proxy email e.g., deals-p8j5o5u@...
    dealerName: "Test Dealer",
    vehicleTitle: "Sample Car",
    url: "",
    status: "open",
    best_offer_otd: null,
  }
];

const messages = []; // { id, dealId, channel, direction, body, meta, createdAt }

// Helper: build the proxy email for a deal
function dealProxyEmail(deal) {
  const domain = process.env.MAILGUN_DOMAIN || "hagglehub.app";
  return `deals-${deal.key}@${domain}`;
}

// Helper: resolve a deal by id OR token
function findDealByParam(param) {
  const n = Number(param);
  if (!Number.isNaN(n)) {
    return deals.find(d => d.id === n) || null;
  }
  return deals.find(d => d.key === param) || null;
}

// ===== Mailgun send helper (outbound email) =====
async function sendEmailViaMailgun({ to, subject, text, html, replyTo }) {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  const from   = process.env.MAIL_FROM;

  if (!apiKey || !domain || !from) {
    throw new Error("Missing MAILGUN_API_KEY, MAILGUN_DOMAIN, or MAIL_FROM");
  }

  const url = `https://api.mailgun.net/v3/${domain}/messages`;
  const auth = "Basic " + Buffer.from(`api:${apiKey}`).toString("base64");

  const form = new URLSearchParams();
  form.set("from", from);
  form.set("to", to);
  form.set("subject", subject || "");
  if (html) form.set("html", html);
  form.set("text", text || "");
  if (replyTo) form.set("h:Reply-To", replyTo); // ensures replies flow to the token address

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

// ===== Routes =====

// Healthcheck
app.get("/health", (req, res) => res.json({ ok: true }));

// List deals (include each deal's proxyEmail for convenience)
app.get("/deals", (req, res) => {
  const result = deals.map(d => ({ ...d, proxyEmail: dealProxyEmail(d) }));
  res.json(result);
});

// List messages for a deal (by id or key)
app.get("/deals/:param/messages", (req, res) => {
  const deal = findDealByParam(req.params.param);
  if (!deal) return res.status(404).json({ error: "Deal not found" });
  const items = messages.filter(m => m.dealId === deal.id);
  res.json(items);
});

// Create outbound message (send email via Mailgun; Reply-To = deal proxy)
app.post("/deals/:param/messages", async (req, res) => {
  try {
    const deal = findDealByParam(req.params.param);
    if (!deal) return res.status(404).json({ error: "Deal not found" });

    const { channel = "email", to, subject = "", body = "", html } = req.body || {};
    if (channel !== "email") return res.status(400).json({ error: "Only email is supported in this endpoint" });
    if (!to) return res.status(400).json({ error: "Missing 'to' (dealer email)" });

    // Optional subject tagging (not required when using tokenized Reply-To)
    const finalSubject = subject || "HaggleHub message";

    await sendEmailViaMailgun({
      to,
      subject: finalSubject,
      text: body,
      html,
      replyTo: dealProxyEmail(deal)
    });

    const msg = {
      id: messages.length + 1,
      dealId: deal.id,
      channel: "email",
      direction: "out",
      body: String(body || ""),
      meta: { to, subject: finalSubject, replyTo: dealProxyEmail(deal) },
      createdAt: new Date().toISOString()
    };
    messages.push(msg);

    console.log("Outbound email sent:", {
      to,
      subject: finalSubject,
      replyTo: dealProxyEmail(deal),
      preview: (body || "").slice(0, 120)
    });

    res.json(msg);
  } catch (err) {
    console.error("Outbound email error:", err.message || String(err));
    res.status(502).json({ error: "Failed to send email", details: err.message || String(err) });
  }
});

// Inbound Mailgun webhook (dealer -> HaggleHub via email)
// Associates by recipient token: deals-<token>@<domain>
app.post("/webhooks/email/mailgun", async (req, res) => {
  try {
    const f = req.body || {};

    const recipient = f.recipient || f.to || f["To"] || "";
    const sender    = f.sender || f.from || f["From"] || "";
    const subject   = f.subject || f["Subject"] || "";
    const text      = f["body-plain"] || f["stripped-text"] || "";
    const html      = f["body-html"]  || f["stripped-html"]  || "";
    const messageId = f["message-id"] || f["Message-Id"] || f["Message-ID"] || "";

    // Extract token from recipient: deals-p8j5o5u@hagglehub.app -> token = p8j5o5u
    let token = "";
    const m = recipient.toLowerCase().match(/^deals-([a-z0-9]+)@/);
    if (m) token = m[1];

    // Find deal by token; fallback to first deal so nothing gets lost (MVP)
    let deal = token ? deals.find(d => d.key === token) : null;
    if (!deal) deal = deals[0];

    messages.push({
      id: messages.length + 1,
      dealId: deal.id,
      channel: "email",
      direction: "in",
      body: text || html || "(no body)",
      meta: { sender, subject, messageId, recipient, token },
      createdAt: new Date().toISOString()
    });

    console.log("Inbound email (Mailgun):", {
      token,
      dealKey: deal.key,
      dealId: deal.id,
      sender,
      subject,
      preview: (text || html || "").slice(0, 120)
    });

    // Return 200 quickly so Mailgun doesn't retry
    return res.status(200).send("OK");
  } catch (e) {
    console.error("Inbound email error:", e && e.message ? e.message : String(e));
    // Still 200 while debugging to avoid Mailgun retries
    return res.status(200).send("OK");
  }
});

// Root hint
app.get("/", (req, res) => {
  res.send("HaggleHub API is running. Try GET /deals, GET /deals/p8j5o5u/messages, or POST /webhooks/email/mailgun");
});

// ===== Start =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HaggleHub API listening on ${PORT}`));
