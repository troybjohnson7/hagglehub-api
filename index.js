// HaggleHub API — inbox-first backend (no seeds, no Base44)
//
// Core ideas:
// - Every user has a proxy email: deals-<userKey>@hagglehub.app
// - Inbound emails (Mailgun webhook) are stored in an inbox for that user
// - The app can attach an inbox message to an existing deal (by dealId)
// - Or attach by dealer (we'll find/create a deal for that user+dealer)
// - Or create a brand-new deal from a message (dealer inferred/created from sender)
// - Deals always belong to a user and have a dealer associated
//
// Endpoints:
//   GET  /health
//   GET  /users/me
//   GET  /dealers
//   POST /dealers
//   GET  /deals
//   GET  /deals/:id
//   POST /deals
//   GET  /deals/:id/messages
//   POST /deals/:id/messages        (outbound stub; logs only)
//   POST /webhooks/email/mailgun     (Mailgun inbound → inbox)
//   GET  /inbox/unmatched?userKey=...
//   POST /inbox/:msgId/attach        ({ dealId })
//   POST /inbox/:msgId/attachByDealer ({ dealer_id })  // find-or-create deal for user+dealer
//   POST /inbox/:msgId/createDeal    // infer/create dealer from message sender, then create deal
//   GET  /users/:userKey/messages    // convenience for "recent messages" per user (optional)
//   GET  /debug/state                // inspect in-memory state (optional)
//
// Notes:
// - In-memory storage for now; replace with a DB later.
// - No seeds: the API starts empty except one "current user" so the UI can load.

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";

const app = express();

// ---------- Middleware ----------
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());                           // JSON bodies
app.use(express.urlencoded({ extended: false }));  // form-encoded (Mailgun)
app.use(bodyParser.json());                        // safe duplicate JSON parser

// ---------- In-memory storage ----------
let users = [
  // Simulated current user (replace with real auth later)
  // user.key is used in deals-<userKey>@hagglehub.app
  { id: 1, key: "p8j5o5u", name: "HaggleHub User", email: "user@example.com" },
];

let dealers = [
  // { id, name, email, phone }
];

let deals = [
  // { id, userKey, dealer_id, status, createdAt, updatedAt }
];

let messages = [
  // { id, dealId, direction: 'in'|'out', body, meta, createdAt }
];

let inbox = [
  // { id, userKey, sender, recipient, subject, body, preview, createdAt }
];

// ---------- Helpers ----------
function nowISO() {
  return new Date().toISOString();
}

function log(label, obj) {
  try {
    console.log(label + ":", JSON.stringify(obj, null, 2));
  } catch {
    console.log(label, obj);
  }
}

function findUserByKey(userKey) {
  return users.find((u) => u.key === userKey);
}

function findDealerByEmail(email) {
  if (!email) return undefined;
  const e = String(email).toLowerCase().trim();
  return dealers.find((d) => (d.email || "").toLowerCase().trim() === e);
}

function ensureDealerFromSender(sender) {
  // Try to use the full sender email; fall back to domain if needed.
  const emailMatch = String(sender || "").toLowerCase().match(
    /<?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})>?/
  );
  const email = emailMatch ? emailMatch[1] : null;

  let dealer = email ? findDealerByEmail(email) : undefined;
  if (dealer) return dealer;

  // Create dealer if not found
  const nameFromEmail = email ? email.split("@")[1] : "unknown-dealer";
  dealer = {
    id: dealers.length + 1,
    name: nameFromEmail,  // you can enrich this later
    email: email || "",
    phone: "",
  };
  dealers.push(dealer);
  return dealer;
}

function findOrCreateDealForUserAndDealer(userKey, dealer_id) {
  // Prefer an open/active deal if one exists; otherwise create
  const existing = deals.find(
    (d) => d.userKey === userKey && d.dealer_id === dealer_id
  );
  if (existing) return existing;

  const newDeal = {
    id: deals.length + 1,
    userKey,
    dealer_id,
    status: "new",
    createdAt: nowISO(),
    updatedAt: nowISO(),
  };
  deals.push(newDeal);
  return newDeal;
}

// ---------- Health ----------
app.get("/health", (req, res) => res.json({ ok: true }));

// ---------- Users ----------
app.get("/users/me", (req, res) => {
  // TODO: replace with real auth/session
  res.json(users[0]);
});

// ---------- Dealers ----------
app.get("/dealers", (req, res) => res.json(dealers));

app.post("/dealers", (req, res) => {
  const body = req.body || {};
  const dealer = {
    id: dealers.length + 1,
    name: body.name || "",
    email: body.email || "",
    phone: body.phone || "",
  };
  dealers.push(dealer);
  res.json(dealer);
});

// ---------- Deals ----------
app.get("/deals", (req, res) => {
  res.json(deals);
});

app.get("/deals/:id", (req, res) => {
  const id = Number(req.params.id);
  const deal = deals.find((d) => d.id === id);
  if (!deal) return res.status(404).json({ error: "Deal not found" });
  res.json(deal);
});

app.post("/deals", (req, res) => {
  const body = req.body || {};
  if (!body.userKey) {
    // if caller omitted, default to current user for convenience
    body.userKey = users[0]?.key;
  }
  if (!body.dealer_id) {
    return res.status(400).json({ error: "dealer_id is required for a deal" });
  }

  const dealer = dealers.find((d) => d.id === Number(body.dealer_id));
  if (!dealer) return res.status(404).json({ error: "Dealer not found" });

  const newDeal = {
    id: deals.length + 1,
    userKey: body.userKey,
    dealer_id: Number(body.dealer_id),
    status: body.status || "new",
    createdAt: nowISO(),
    updatedAt: nowISO(),
  };
  deals.push(newDeal);
  res.json(newDeal);
});

// ---------- Deal messages ----------
app.get("/deals/:id/messages", (req, res) => {
  const id = Number(req.params.id);
  const thread = messages
    .filter((m) => m.dealId === id)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  res.json(thread);
});

app.post("/deals/:id/messages", (req, res) => {
  const id = Number(req.params.id);
  const deal = deals.find((d) => d.id === id);
  if (!deal) return res.status(404).json({ error: "Deal not found" });

  const { channel = "email", to, subject = "", body = "" } = req.body || {};
  if (channel !== "email") {
    return res.status(400).json({ error: "Only email channel is supported (stub)" });
  }
  if (!to) return res.status(400).json({ error: "Missing 'to' (dealer email)" });

  const msg = {
    id: messages.length + 1,
    dealId: id,
    direction: "out",
    body: String(body || ""),
    meta: { to, subject },
    createdAt: nowISO(),
  };
  messages.push(msg);

  // Stub only: just log instead of actually sending via Mailgun
  log("Outbound email (stub)", msg);
  res.json(msg);
});

// ---------- Mailgun inbound webhook → inbox ----------
app.post("/webhooks/email/mailgun", (req, res) => {
  const b = req.body || {};

  // Be tolerant about Mailgun keys / casing
  const recipient =
    b.recipient || b.to || b.To || b["Recipient"] || b["envelope-to"] || "";
  const sender =
    b.sender || b.from || b.From || b["Sender"] || "";
  const subject =
    b.subject || b.Subject || "";
  const bodyPlain =
    b["body-plain"] || b["stripped-text"] || b.preview || b["body"] || "";
  const preview =
    b["stripped-text"] || b.preview || "";

  // Extract userKey from deals-<userKey>@...
  const m = String(recipient).toLowerCase().match(/^deals-([a-z0-9]+)@/);
  if (!m) return res.status(400).json({ error: "Invalid recipient" });
  const userKey = m[1];

  const user = findUserByKey(userKey);
  if (!user) return res.status(404).json({ error: "User not found for recipient" });

  const msg = {
    id: inbox.length + 1,
    userKey,
    sender,
    recipient,
    subject,
    body: String(bodyPlain || ""),
    preview: String(preview || ""),
    createdAt: nowISO(),
  };

  inbox.push(msg);
  log("Inbound email (Mailgun → inbox)", msg);
  res.json({ status: "ok" });
});

// ---------- Inbox (unmatched) ----------
app.get("/inbox/unmatched", (req, res) => {
  const userKey = req.query.userKey;
  if (!userKey) return res.status(400).json({ error: "Missing userKey" });

  const user = findUserByKey(userKey);
  if (!user) return res.status(404).json({ error: "User not found" });

  const list = inbox
    .filter((m) => m.userKey === userKey)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  res.json(list);
});

// Attach to an existing deal by dealId
app.post("/inbox/:msgId/attach", (req, res) => {
  const msgId = Number(req.params.msgId);
  const dealId = Number(req.body?.dealId);

  const msg = inbox.find((m) => m.id === msgId);
  if (!msg) return res.status(404).json({ error: "Message not found in inbox" });

  const deal = deals.find((d) => d.id === dealId);
  if (!deal) return res.status(404).json({ error: "Deal not found" });

  const attached = {
    id: messages.length + 1,
    dealId,
    direction: "in",
    body: msg.body,
    meta: { sender: msg.sender, subject: msg.subject, recipient: msg.recipient },
    createdAt: msg.createdAt,
  };
  messages.push(attached);

  // remove from inbox
  inbox = inbox.filter((m) => m.id !== msgId);

  deal.updatedAt = nowISO();
  log("Inbox attach → deal", { attached, removedInboxId: msgId });
  res.json(attached);
});

// Attach by dealer: find-or-create a deal for this user+dealer, then attach
app.post("/inbox/:msgId/attachByDealer", (req, res) => {
  const msgId = Number(req.params.msgId);
  const dealer_id = Number(req.body?.dealer_id);

  const msg = inbox.find((m) => m.id === msgId);
  if (!msg) return res.status(404).json({ error: "Message not found in inbox" });

  const dealer = dealers.find((d) => d.id === dealer_id);
  if (!dealer) return res.status(404).json({ error: "Dealer not found" });

  const deal = findOrCreateDealForUserAndDealer(msg.userKey, dealer.id);

  const attached = {
    id: messages.length + 1,
    dealId: deal.id,
    direction: "in",
    body: msg.body,
    meta: { sender: msg.sender, subject: msg.subject, recipient: msg.recipient },
    createdAt: msg.createdAt,
  };
  messages.push(attached);

  // remove from inbox
  inbox = inbox.filter((m) => m.id !== msgId);

  deal.updatedAt = nowISO();
  log("Inbox attachByDealer → deal", { deal, attached, removedInboxId: msgId });
  res.json({ deal, message: attached });
});

// Create a new deal from message: infer/create dealer from sender, then create deal
app.post("/inbox/:msgId/createDeal", (req, res) => {
  const msgId = Number(req.params.msgId);
  const msg = inbox.find((m) => m.id === msgId);
  if (!msg) return res.status(404).json({ error: "Message not found in inbox" });

  // Infer/create dealer from sender email
  const dealer = ensureDealerFromSender(msg.sender);

  const deal = findOrCreateDealForUserAndDealer(msg.userKey, dealer.id);

  const attached = {
    id: messages.length + 1,
    dealId: deal.id,
    direction: "in",
    body: msg.body,
    meta: { sender: msg.sender, subject: msg.subject, recipient: msg.recipient },
    createdAt: msg.createdAt,
  };
  messages.push(attached);

  // remove from inbox
  inbox = inbox.filter((m) => m.id !== msgId);

  deal.updatedAt = nowISO();
  log("Created/attached deal from inbox message", { deal, attached, removedInboxId: msgId });
  res.json({ deal, message: attached });
});

// Convenience: messages for a user's deals (for recent lists)
app.get("/users/:userKey/messages", (req, res) => {
  const userKey = req.params.userKey;
  const userDeals = deals.filter((d) => d.userKey === userKey).map((d) => d.id);
  const all = messages.filter((m) => userDeals.includes(m.dealId));
  res.json(all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

// Debug: inspect in-memory state (optional, disable in prod)
app.get("/debug/state", (req, res) => {
  res.json({ users, dealers, deals, messages, inbox });
});

// Root
app.get("/", (req, res) => {
  res.send("HaggleHub API is running.");
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HaggleHub API listening on ${PORT}`);
});
