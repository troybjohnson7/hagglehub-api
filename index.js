// HaggleHub API — user-token model (deals-<userKey>@...)
// Endpoints:
//   GET  /health
//   GET  /users                       (lists users incl. proxyEmail)
//   GET  /users/:key/messages         (all messages for a user)
//   GET  /deals                       (list deals)
//   GET  /deals/:id/messages          (messages linked to a specific deal)
//   POST /deals/:id/messages          (send email; Reply-To = user's proxy)
//   POST /webhooks/email/mailgun      (inbound; attach to user, try to match a deal)
//   GET  /inbox/unmatched[?userKey=]  (messages with dealId == null; optional filter)
//   POST /inbox/attach                (attach unmatched message to a deal)
//
// ENV (Render):
//   CORS_ORIGIN=https://hagglehub.app           (or * while testing)
//   MAILGUN_DOMAIN=hagglehub.app                (or mg.hagglehub.app)
//   MAILGUN_API_KEY=key-xxxxxxxxxxxxxxxxxxxxxxx
//   MAIL_FROM=HaggleHub <noreply@hagglehub.app>

import express from "express";
import cors from "cors";

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ===== In-memory data (MVP) =====

// Users: each has a unique key that forms the proxy email
const users = [
  { key: "p8j5o5u", name: "Test User" },
  // add more users here later
];

// Deals: each belongs to a user via userKey
const deals = [
  {
    id: 1,
    userKey: "p8j5o5u",
    dealerName: "Test Dealer",
    dealerEmailDomain: "dealer.com",    // optional
    vehicleTitle: "Sample Car",
    vin: "1ABCDEFG2HIJKL345",           // optional (17 chars)
    url: "https://dealer.com/inventory/sample-car",
    status: "open",
    best_offer_otd: null
  }
];

// Messages:
//   Required: userKey
//   Optional: dealId (null when unmatched)
//   shape: { id, userKey, dealId|null, channel, direction, body, meta, createdAt }
const messages = [];

// ===== Helpers =====

function userProxyEmail(userKey) {
  const domain = process.env.MAILGUN_DOMAIN || "hagglehub.app";
  return `deals-${userKey}@${domain}`;
}

function findUserByKey(key) {
  return users.find(u => u.key === key) || null;
}

function findDealById(id) {
  return deals.find(d => d.id === Number(id)) || null;
}

const VIN_RE = /\b([A-HJ-NPR-Z0-9]{17})\b/i;

function extractCandidates({ subject, text, html }) {
  const hay = `${subject || ""}\n${text || ""}\n${html || ""}`;
  const vin = (hay.match(VIN_RE) || [])[1];
  const urlMatch = hay.match(/https?:\/\/[^\s)>\]]+/i);
  const url = urlMatch ? urlMatch[0] : null;
  return { vin, url };
}

// Try to match a message to one of THIS USER'S deals
function matchDealForUser(userKey, { sender, subject, text, html }) {
  const userDeals = deals.filter(d => d.userKey === userKey);
  if (userDeals.length === 0) return null;

  const { vin, url } = extractCandidates({ subject, text, html });
  if (vin) {
    const byVin = userDeals.find(d => (d.vin || "").toUpperCase() === vin.toUpperCase());
    if (byVin) return byVin;
  }
  const senderDomain = (sender || "").split("@")[1]?.toLowerCase();
  if (senderDomain) {
    const byDomain = userDeals.find(d => (d.dealerEmailDomain || "").toLowerCase() === senderDomain);
    if (byDomain) return byDomain;
  }
  if (url) {
    const byUrl = userDeals.find(d => (d.url && url.toLowerCase().includes(d.url.toLowerCase())));
    if (byUrl) return byUrl;
  }
  return null; // unmatched to any specific deal (will stay in user's inbox)
}

// ===== Mailgun (outbound) =====
async function sendEmailViaMailgun({ to, subject, text, html, replyTo }) {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  const from   = process.env.MAIL_FROM;
  if (!apiKey || !domain || !from) throw new Error("Missing MAILGUN_API_KEY, MAILGUN_DOMAIN, or MAIL_FROM");

  const url = `https://api.mailgun.net/v3/${domain}/messages`;
  const auth = "Basic " + Buffer.from(`api:${apiKey}`).toString("base64");
  const form = new URLSearchParams();
  form.set("from", from);
  form.set("to", to);
  form.set("subject", subject || "");
  if (html) form.set("html", html);
  form.set("text", text || "");
  if (replyTo) form.set("h:Reply-To", replyTo);

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

app.get("/health", (req, res) => res.json({ ok: true }));

// Users (handy for UI later)
app.get("/users", (req, res) => {
  const list = users.map(u => ({ ...u, proxyEmail: userProxyEmail(u.key) }));
  res.json(list);
});
app.get("/users/:key/messages", (req, res) => {
  const key = req.params.key;
  const user = findUserByKey(key);
  if (!user) return res.status(404).json({ error: "User not found" });
  const items = messages.filter(m => m.userKey === key).sort((a,b)=> new Date(a.createdAt)-new Date(b.createdAt));
  res.json(items);
});

// Deals
app.get("/deals", (req, res) => {
  res.json(deals);
});
app.get("/deals/:id/messages", (req, res) => {
  const deal = findDealById(req.params.id);
  if (!deal) return res.status(404).json({ error: "Deal not found" });
  const items = messages.filter(m => m.dealId === deal.id).sort((a,b)=> new Date(a.createdAt)-new Date(b.createdAt));
  res.json(items);
});

// Send outbound (Reply-To = user's proxy)
app.post("/deals/:id/messages", async (req, res) => {
  try {
    const deal = findDealById(req.params.id);
    if (!deal) return res.status(404).json({ error: "Deal not found" });

    const { channel = "email", to, subject = "", body = "", html } = req.body || {};
    if (channel !== "email") return res.status(400).json({ error: "Only email is supported" });
    if (!to) return res.status(400).json({ error: "Missing 'to' (dealer email)" });

    const replyTo = userProxyEmail(deal.userKey);
    await sendEmailViaMailgun({ to, subject: subject || "HaggleHub message", text: body, html, replyTo });

    const msg = {
      id: messages.length + 1,
      userKey: deal.userKey,
      dealId: deal.id,
      channel: "email",
      direction: "out",
      body: String(body || ""),
      meta: { to, subject: subject || "HaggleHub message", replyTo },
      createdAt: new Date().toISOString()
    };
    messages.push(msg);

    console.log("Outbound email sent:", { to, subject: msg.meta.subject, replyTo, preview: msg.body.slice(0,120) });
    res.json(msg);
  } catch (err) {
    console.error("Outbound email error:", err.message || String(err));
    res.status(502).json({ error: "Failed to send email", details: err.message || String(err) });
  }
});

// Inbound webhook — attach to user by token; try to match a deal among that user's deals
app.post("/webhooks/email/mailgun", async (req, res) => {
  try {
    const f = req.body || {};
    const recipient = f.recipient || f.to || f["To"] || "";
    const sender    = f.sender || f.from || f["From"] || "";
    const subject   = f.subject || f["Subject"] || "";
    const text      = f["body-plain"] || f["stripped-text"] || "";
    const html      = f["body-html"]  || f["stripped-html"]  || "";
    const messageId = f["message-id"] || f["Message-Id"] || f["Message-ID"] || "";

    // Extract user key from deals-<key>@...
    let userKey = "";
    const m = (recipient || "").toLowerCase().match(/^deals-([a-z0-9]+)@/);
    if (m) userKey = m[1];

    const user = userKey ? findUserByKey(userKey) : null;

    // If we can't identify the user, we still store it (userKey = null) — but ideally all routes use deals-<userKey>@...
    const matchedDeal = user ? matchDealForUser(user.key, { sender, subject, text, html }) : null;

    messages.push({
      id: messages.length + 1,
      userKey: user ? user.key : null,
      dealId: matchedDeal ? matchedDeal.id : null,
      channel: "email",
      direction: "in",
      body: text || html || "(no body)",
      meta: { sender, subject, messageId, recipient, userKey },
      createdAt: new Date().toISOString()
    });

    console.log("Inbound email (Mailgun):", {
      userKey: user ? user.key : null,
      matchedDealId: matchedDeal?.id || null,
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

// Unmatched inbox (optionally filter by userKey)
app.get("/inbox/unmatched", (req, res) => {
  const { userKey } = req.query || {};
  let items = messages.filter(m => m.dealId === null);
  if (userKey) items = items.filter(m => m.userKey === userKey);
  items.sort((a,b)=> new Date(a.createdAt)-new Date(b.createdAt));
  res.json(items);
});

app.post("/inbox/attach", (req, res) => {
  const { messageId, dealId } = req.body || {};
  if (!messageId || !dealId) return res.status(400).json({ error: "messageId and dealId are required" });
  const msg = messages.find(m => m.id === Number(messageId));
  if (!msg) return res.status(404).json({ error: "Message not found" });
  const deal = findDealById(dealId);
  if (!deal) return res.status(404).json({ error: "Deal not found" });

  msg.userKey = deal.userKey;  // ensure it’s tied to the deal’s user
  msg.dealId = deal.id;
  res.json({ ok: true, message: msg });
});

// Root
app.get("/", (req, res) => {
  res.send("HaggleHub API (user-token model) is running.");
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HaggleHub API listening on ${PORT}`));
