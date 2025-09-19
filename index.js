import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- In-memory storage (replace with DB later) ---
let users = [
  { id: 1, key: "p8j5o5u", name: "Troy Johnson", email: "troy@example.com" },
];
let deals = [
  { id: 1, vehicle_id: null, dealer_id: null, status: "negotiating", userKey: "p8j5o5u" },
];
let messages = [];
let inbox = []; // unmatched emails land here

// --- Helpers ---
function findUserByKey(userKey) {
  return users.find((u) => u.key === userKey);
}

function log(label, data) {
  console.log(`${label}:`, JSON.stringify(data, null, 2));
}

// --- USERS ---
app.get("/users/me", (req, res) => {
  // TODO: replace with auth
  res.json(users[0]);
});

// --- DEALS ---
app.get("/deals", (req, res) => {
  res.json(deals);
});

app.get("/deals/:id", (req, res) => {
  const deal = deals.find((d) => d.id === Number(req.params.id));
  if (!deal) return res.status(404).json({ error: "Deal not found" });
  res.json(deal);
});

app.post("/deals", (req, res) => {
  const newDeal = { id: deals.length + 1, ...req.body };
  deals.push(newDeal);
  res.json(newDeal);
});

// --- MESSAGES tied to deals ---
app.get("/deals/:id/messages", (req, res) => {
  const dealMsgs = messages.filter((m) => m.dealId === Number(req.params.id));
  res.json(dealMsgs);
});

app.post("/deals/:id/messages", (req, res) => {
  const dealId = Number(req.params.id);
  const deal = deals.find((d) => d.id === dealId);
  if (!deal) return res.status(404).json({ error: "Deal not found" });

  const msg = {
    id: messages.length + 1,
    dealId,
    direction: "out",
    body: req.body.body,
    meta: { to: req.body.to, subject: req.body.subject },
    createdAt: new Date().toISOString(),
  };
  messages.push(msg);
  log("Outbound email sent", msg);
  res.json(msg);
});

// --- INBOX (catch-all) ---
app.get("/inbox/unmatched", (req, res) => {
  const userKey = req.query.userKey;
  if (!userKey) return res.status(400).json({ error: "Missing userKey" });

  const user = findUserByKey(userKey);
  if (!user) return res.status(404).json({ error: "User not found" });

  const userMsgs = inbox.filter((m) => m.userKey === userKey);
  res.json(userMsgs);
});

// Simulate Mailgun webhook → add to inbox
app.post("/webhooks/email/mailgun", (req, res) => {
  const payload = req.body;
  const recipient = payload.recipient || "";
  const match = recipient.match(/deals-(.+)@hagglehub\.app/);

  if (!match) {
    return res.status(400).json({ error: "Invalid recipient" });
  }
  const userKey = match[1];

  const msg = {
    id: inbox.length + 1,
    userKey,
    sender: payload.sender,
    recipient,
    subject: payload.subject,
    body: payload["body-plain"] || payload.preview || "",
    preview: payload["stripped-text"] || "",
    createdAt: new Date().toISOString(),
  };

  inbox.push(msg);
  log("Inbound email (Mailgun)", msg);
  res.json({ status: "ok" });
});

// Attach unmatched message to deal
app.post("/inbox/:msgId/attach", (req, res) => {
  const msgId = Number(req.params.msgId);
  const dealId = Number(req.body.dealId);
  const msg = inbox.find((m) => m.id === msgId);
  const deal = deals.find((d) => d.id === dealId);

  if (!msg) return res.status(404).json({ error: "Message not found" });
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

  inbox = inbox.filter((m) => m.id !== msgId); // remove from inbox
  log("Message attached to deal", attached);
  res.json(attached);
});

// Create new deal from unmatched message
app.post("/inbox/:msgId/createDeal", (req, res) => {
  const msgId = Number(req.params.msgId);
  const msg = inbox.find((m) => m.id === msgId);
  if (!msg) return res.status(404).json({ error: "Message not found" });

  const newDeal = {
    id: deals.length + 1,
    vehicle_id: null,
    dealer_id: null,
    status: "new",
    userKey: msg.userKey,
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

  inbox = inbox.filter((m) => m.id !== msgId);
  log("New deal created from message", { newDeal, attached });

  res.json({ deal: newDeal, message: attached });
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HaggleHub API listening on ${PORT}`);
});
