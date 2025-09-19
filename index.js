// HaggleHub API — simplified, inbox-first backend
// Works with your cleaned frontend (Dashboard, DealDetails, Inbox, Notification bell)
//
// Endpoints:
//   GET  /health
//   GET  /users/me
//   GET  /deals
//   GET  /deals/:id
//   POST /deals
//   GET  /deals/:id/messages
//   POST /deals/:id/messages       (logs outbound; stub to integrate Mailgun later)
//   POST /webhooks/email/mailgun   (Mailgun inbound → inbox)
//   GET  /inbox/unmatched?userKey=...
//   POST /inbox/:msgId/attach      ({ dealId })
//   POST /inbox/:msgId/createDeal
//
// Env you may set in Render (optional now):
//   CORS_ORIGIN=https://hagglehub.app

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";

const app = express();

// --- Middleware ---
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());                           // JSON payloads
app.use(express.urlencoded({ extended: false }));  // x-www-form-urlencoded (Mailgun)
app.use(bodyParser.json());                        // (ok to keep; safe duplicate JSON parser)

// --- In-memory storage (replace with DB later) ---
let users = [
  // Simulated “logged-in” user (until auth is added)
  { id: 1, key: "p8j5o5u", name: "HaggleHub User", email: "user@example.com" },
];

let deals = [
  // Minimal seed example so your UI isn’t empty on first run
  { id: 1, userKey: "p8j5o5u", vehicle_id: null, dealer_id: null, status: "negotiating" },
];

let messages = [
  // { id, dealId, direction: 'in'|'out', body, meta, createdAt }
];

let inbox = [
  // unmatched inbound emails live here until attached or used to create a deal
  // { id, userKey, sender, recipient, subject, body, preview, createdAt }
];

// --- Helpers ---
function findUserByKey(userKey) {
  return users.find((u) => u.key === userKey);
}

function log(label, data) {
  try {
    console.log(`${label}:`, JSON.stringify(data, null, 2));
  } catch {
    console.log(label, data);
  }
}

// --- Health ---
app.get("/health", (req, res) => res.json({ ok: true }));

// --- Users ---
app.get("/users/me", (req, res) => {
  // TODO: replace with real auth/session
  res.json(users[0]);
});

// --- Deals ---
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
  const newDeal = {
    id: deals.length + 1,
    userKey: body.userKey || users[0]?.key || "unknown",
    vehicle_id: body.vehicle_id ?? null,
    dealer_id: body.dealer_id ?? null,
    status: body.status || "new",
    // you can add fields like dealerName, vehicleTitle, etc.
  };
  deals.push(newDeal);
  res.json(newDeal);
});

// --- Deal messages ---
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
  if (channel !== "email") return res.status(400).json({ error: "Only email is supported in this stub" });
  if (!to) return res.status(400).json({ error: "Missing 'to' (dealer email)" });

  const msg = {
    id: messages.length + 1,
    dealId: id,
    direction: "out",
    body: String(body || ""),
    meta: { to, subject },
    createdAt: new Date().toISOString(),
  };
  messages.push(msg);

  // Stub: we only log outbound right now (no Mailgun send here)
  log("Outbound email (stub)", msg);
  res.json(msg);
});

// --- Mailgun inbound webhook → inbox ---
app.post("/webhooks/email/mailgun", (req, res) => {
  const b = req.body || {};

  // Be tolerant about key names/casing Mailgun may use:
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

  // Recipient must look like deals-<userKey>@yourdomain
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
    createdAt: new Date().toISOString(),
  };

  inbox.push(msg);
  log("Inbound email (Mailgun → inbox)", msg);
  res.json({ status: "ok" });
});

// --- Inbox (unmatched) ---
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

// Attach unmatched message to existing deal
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

  log("Inbox attach → deal", { attached, removedInboxId: msgId });
  res.json(attached);
});

// Create a new deal from unmatched message, then attach it
app.post("/inbox/:msgId/createDeal", (req, res) => {
  const msgId = Number(req.params.msgId);
  const msg = inbox.find((m) => m.id === msgId);
  if (!msg) return res.status(404).json({ error: "Message not found in inbox" });

  const newDeal = {
    id: deals.length + 1,
    userKey: msg.userKey,
    vehicle_id: null,
    dealer_id: null,
    status: "new",
  };
  deals.push(newDeal);

  const attached = {
    id: messages.length + 1,
    dealId: newDeal.id,
    direction: "in",
    body: msg.body,
    meta: { sender: msg.sender, subject: msg.subject, recipient: msg.recipient },
    createdAt: msg.createdAt,
  };
  messages.push(attached);

  // remove from inbox
  inbox = inbox.filter((m) => m.id !== msgId);

  log("Created deal from inbox message", { newDeal, attached, removedInboxId: msgId });
  res.json({ deal: newDeal, message: attached });
});

// --- Root ---
app.get("/", (req, res) => {
  res.send("HaggleHub API is running.");
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HaggleHub API listening on ${PORT}`);
});
