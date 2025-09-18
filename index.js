// index.js - Direct Entity API approach
import express from "express";
import cors from "cors";

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get("/", (_req, res) => res.send("HaggleHub API is running."));

// --- Helper Functions ---
const splitRecipient = (recipient) => {
  if (!recipient || !recipient.includes("@")) return { local: "", domain: "" };
  const [local, domain] = recipient.split("@", 2);
  return { local: (local || "").trim(), domain: (domain || "").trim() };
};

const extractTokenFromLocal = (localPart) => {
  if (!localPart) return "";
  const m = localPart.match(/^deals?-(.+)$/i);
  return m ? m[1] : localPart;
};

const stripHtml = (html) => (html || "").replace(/<[^>]+>/g, "");
const extractVIN = (text) => text?.match(/\b([A-HJ-NPR-Z0-9]{17})\b/i)?.[1].toUpperCase() || "";

// --- Base44 Entity API Functions ---
async function callBase44API(endpoint, method = 'GET', body = null) {
  const apiKey = process.env.BASE44_API_KEY;
  const projectId = process.env.BASE44_PROJECT_ID;

  if (!apiKey) throw new Error("Missing BASE44_API_KEY");
  if (!projectId) throw new Error("Missing BASE44_PROJECT_ID");

  const url = `https://app.base44.com/api/projects/${projectId}${endpoint}`;
  
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  };

  if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    options.body = JSON.stringify(body);
  }

  console.log(`Calling Base44 API: ${method} ${url}`);
  
  try {
    const response = await fetch(url, options);
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Base44 API error ${response.status}: ${errorText}`);
    }
    
    return response.json();
  } catch (error) {
    if (error.message.includes('ENOTFOUND')) {
      throw new Error(`DNS lookup failed for Base44 API. Check if app.base44.com is accessible.`);
    }
    throw error;
  }
}

async function findUserByEmailId(emailIdentifier) {
  const users = await callBase44API(`/entities/User?filter=${encodeURIComponent(`email_identifier="${emailIdentifier}"`)}&limit=1`);
  return users.items?.[0] || null;
}

async function findOrCreateDealer(dealerName, senderEmail) {
  const safeName = dealerName || senderEmail.split('@')[0].replace(/[._-]/g, ' ');
  
  // Try to find existing dealer
  const existingDealers = await callBase44API(`/entities/Dealer?filter=${encodeURIComponent(`name="${safeName}"`)}&limit=1`);
  if (existingDealers.items?.[0]) {
    return existingDealers.items[0];
  }
  
  // Create new dealer
  const newDealer = await callBase44API('/entities/Dealer', 'POST', {
    name: safeName,
    contact_email: senderEmail
  });
  
  return newDealer;
}

async function createMessage(messageData) {
  return callBase44API('/entities/Message', 'POST', messageData);
}

// --- Main Webhook ---
app.post("/webhooks/email/mailgun", async (req, res) => {
  res.status(200).send("OK");

  try {
    const sender = req.body.sender || req.body.from || "";
    const recipient = req.body.recipient || req.body.to || "";
    const subject = req.body.subject || "";
    const textBody = req.body["body-plain"] || "";
    const htmlBody = req.body["body-html"] || "";
    const content = textBody || stripHtml(htmlBody);

    const { local: recipientLocal } = splitRecipient(recipient);
    const emailIdentifier = extractTokenFromLocal(recipientLocal);
    const vin = extractVIN(content);

    console.log(`Processing email for identifier: ${emailIdentifier}`);
    
    // 1. Find user
    const user = await findUserByEmailId(emailIdentifier);
    if (!user) {
      console.log(`User not found for email identifier: ${emailIdentifier}`);
      return;
    }
    
    console.log(`Found user: ${user.id}`);
    
    // 2. Find or create dealer
    const dealer = await findOrCreateDealer(extractDealerName(content), sender);
    console.log(`Using dealer: ${dealer.id} (${dealer.name})`);
    
    // 3. Create message - use fallback deal if available
    const messageData = {
      deal_id: user.fallback_deal_id || null,
      dealer_id: dealer.id,
      direction: 'inbound',
      channel: 'email',
      subject: subject,
      content: content,
      is_read: false,
      raw_data: req.body
    };
    
    const message = await createMessage(messageData);
    console.log("✅ Message created successfully:", message.id);

  } catch (error) {
    console.error("❌ Email processing failed:", error.message);
  }
});

function extractDealerName(text) {
  const name = text?.match(/from\s+([\w\s&.,''\-]+?)(?:[\.\n\r]|$)/i)?.[1]?.trim();
  if (!name || ["me", "us"].includes(name.toLowerCase())) return "";
  return name.slice(0, 80);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
