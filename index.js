import express from "express";
import cors from "cors";

const app = express();

// Basic middlewares
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());
// Mailgun posts form-encoded; this parses it:
app.use(express.urlencoded({ extended: false }));

// Super simple in-memory data for testing
const messages = []; // {dealId, channel, direction, body, meta, createdAt}
const deals = [{ id: 1, dealerName: "Test Dealer", vehicleTitle: "Sample Car", status: "open" }];

// Health/home
app.get("/", (req, res) => res.send("HaggleHub API is running. Try GET /deals"));

// List deals
app.get("/deals", (req, res) => res.json(deals));

// List messages for a deal
app.get("/deals/:id/messages", (req, res) => {
  const dealId = Number(req.params.id);
  res.json(messages.filter(m => m.dealId === dealId));
});

// Mailgun inbound webhook (dealer -> you)
// Set this URL in Mailgun Routes after you deploy.
app.post("/webhooks/email/mailgun", (req, res) => {
  const sender  = req.body.sender || req.body.from || req.body["From"] || "";
  const subject = req.body.subject || req.body["Subject"] || "";
  const text    = req.body["body-plain"] || req.body["stripped-text"] || "";

  // MVP: attach to test deal #1
  messages.push({
    dealId: 1,
    channel: "email",
    direction: "in",
    body: text || "(no body)",
    meta: { sender, subject },
    createdAt: new Date().toISOString()
  });

  console.log("Inbound email:", { sender, subject, preview: (text || "").slice(0, 120) });

  // IMPORTANT: always 200 so Mailgun doesn't retry
  return res.status(200).send("OK");
});

// Start server (Render sets PORT for you)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HaggleHub API listening on ${PORT}`));

