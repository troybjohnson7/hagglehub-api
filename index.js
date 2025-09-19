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
// Add VIN / dealerEmailDomain if you have them, helps auto-match
const deals = [
  {
    id: 1,
    key: "p8j5o5u",
    dealerName: "Test Dealer",
    dealerEmailDomain: "dealer.com",   // optional
    vehicleTitle: "Sample Car",
    vin: "1ABCDEFG2HIJKL345",           // optional (17 chars)
    url: "https://dealer.com/inventory/sample-car",
    status: "open",
    best_offer_otd: null,
  }
];

const messages = []; // { id, dealId|null, channel, direction, body, meta, createdAt }


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

// Resolve a deal by id OR token (unchanged)
function findDealByParam(param) {
  const n = Number(param);
  if (!Number.isNaN(n)) return deals.find(d => d.id === n) || null;
  return deals.find(d => d.key === param) || null;
}

// --- Extraction & matching helpers ---

// crude VIN finder: 17 chars, A-HJ-NPR-Z and 0-9 (I, O, Q excluded)
const VIN_RE = /\b([A-HJ-NPR-Z0-9]{17})\b/i;

// pull simple candidates from subject/body
function extractCandidates({ subject, text, html }) {
  const hay = `${subject || ""}\n${text || ""}\n${html || ""}`;
  const vin = (hay.match(VIN_RE) || [])[1];
  // basic URL sniff
  const urlMatch = hay.match(/https?:\/\/[^\s)>\]]+/i);
  const url = urlMatch ? urlMatch[0] : null;
  return { vin, url };
}

// try to match an inbound email to a deal
function matchDealForEmail({ recipient, sender, subject, text, html }) {
  // 1) by recipient token (deals-<key>@)
  const m = (recipient || "").toLowerCase().match(/^deals-([a-z0-9]+)@/);
  if (m) {
    const byToken = deals.find(d => d.key === m[1]);
    if (byToken) return byToken;
  }

  // 2) by VIN in content
  const { vin, url } = extractCandidates({ subject, text, html });
  if (vin) {
    const byVin = deals.find(d => (d.vin || "").toUpperCase() === vin.toUpperCase());
    if (byVin) return byVin;
  }

  // 3) by dealer email domain
  const senderDomain = (sender || "").split("@")[1]?.toLowerCase();
  if (senderDomain) {
    const byDomain = deals.find(d => (d.dealerEmailDomain || "").toLowerCase() === senderDomain);
    if (byDomain) return byDomain;
  }

  // 4) by URL mention (contains the deal url)
  if (url) {
    const byUrl = deals.find(d => (d.url && url.toLowerCase().includes(d.url.toLowerCase())));
    if (byUrl) return byUrl;
  }

  // 5) give up → unmatched (null)
  return null;
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
// List unmatched inbound emails (dealId == null)
app.get("/inbox/unmatched", (req, res) => {
  const items = messages.filter(m => m.dealId === null).sort((a,b) => a.id - b.id);
  res.json(items);
});

// Attach an unmatched message to a deal (by id or key)
app.post("/inbox/attach", (req, res) => {
  const { messageId, dealParam } = req.body || {};
  if (!messageId || !dealParam) {
    return res.status(400).json({ error: "messageId and dealParam are required" });
  }
  const msg = messages.find(m => m.id === Number(messageId));
  if (!msg) return res.status(404).json({ error: "Message not found" });
  const deal = findDealByParam(dealParam);
  if (!deal) return res.status(404).json({ error: "Deal not found" });

  msg.dealId = deal.id;
  res.json({ ok: true, message: msg });
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

    const matchedDeal = matchDealForEmail({ recipient, sender, subject, text, html });

    messages.push({
      id: messages.length + 1,
      dealId: matchedDeal ? matchedDeal.id : null, // <— null = unmatched inbox
      channel: "email",
      direction: "in",
      body: text || html || "(no body)",
      meta: { sender, subject, messageId, recipient },
      createdAt: new Date().toISOString()
    });

    console.log("Inbound email (Mailgun):", {
      matched: !!matchedDeal,
      dealId: matchedDeal?.id || null,
      by: matchedDeal ? "heuristic" : "unmatched",
      sender,
      subject,
      preview: (text || html || "").slice(0, 120)
    });

    return res.status(200).send("OK");
  } catch (e) {
    console.error("Inbound email error:", e && e.message ? e.message : String(e));
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
