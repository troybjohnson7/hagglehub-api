import express from "express";
import cors from "cors";
import { createClient } from "@base44/sdk";

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Mailgun posts form-encoded

// Simple test data (you can keep your existing /deals endpoints)
const messages = [];
const deals = [{ id: 1, dealerName: "Test Dealer", vehicleTitle: "Sample Car", status: "open" }];

app.get("/", (req, res) => res.send("HaggleHub API is running. Try GET /deals"));
app.get("/deals", (req, res) => res.json(deals));
app.get("/deals/:id/messages", (req, res) => {
  const dealId = Number(req.params.id);
  res.json(messages.filter(m => m.dealId === dealId));
});

// --- Mailgun inbound webhook -> forward to Base44 ---
app.post("/webhooks/email/mailgun", async (req, res) => {
  // 1) Read common Mailgun fields
  const sender   = req.body.sender || req.body.from || req.body["From"] || "";
  const subject  = req.body.subject || req.body["Subject"] || "";
  const textBody = req.body["body-plain"] || req.body["stripped-text"] || "";
  const toHeader = req.body.recipient || req.body.to || req.body["To"] || "";

  // 2) Find a dealId:
  //    a) Preferred: subject contains [Deal#123]
  //    b) Fallback: recipient like deal-123@hagglehub.app or deals-123@...
  let dealId;
  const subjMatch = subject.match(/\[Deal#(\d+)\]/i);
  if (subjMatch) {
    dealId = Number(subjMatch[1]);
  } else {
    const toLocal = (toHeader || "").split("@")[0]; // before @
    const toMatch = toLocal.match(/deals?-(\d+)/i);
    if (toMatch) dealId = Number(toMatch[1]);
  }
  if (!dealId) dealId = 1; // LAST-RESORT: attach to test deal for now

  // 3) Always ACK Mailgun fast (stop retries)
  res.status(200).send("OK");

  // 4) Log locally (optional)
  messages.push({
    dealId,
    channel: "email",
    direction: "in",
    body: textBody || "(no body)",
    meta: { sender, subject, toHeader },
    createdAt: new Date().toISOString()
  });
  console.log("Inbound email:", { sender, subject, dealId, preview: (textBody || "").slice(0, 120) });

  // 5) Forward into Base44 so your app UI sees it
  try {
    const apiKey = process.env.BASE44_API_KEY;
    if (!apiKey) {
      console.error("Missing BASE44_API_KEY — cannot forward to Base44");
      return;
    }

    const base44 = createClient({ apiKey });

    // Adjust field names to match your Base44 Message entity
    await base44.asServiceRole.entities.Message.create({
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
    console.error("Base44 forward error:", err && err.message ? err.message : String(err));
  }
});

// Start server (Render sets PORT)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HaggleHub API listening on ${PORT}`));
