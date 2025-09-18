// index.js - Direct HTTP with better error handling
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

// --- Base44 API Call Function (More Robust) ---
async function callBase44Function(functionName, payload) {
  const apiKey = process.env.BASE44_API_KEY;
  const projectId = process.env.BASE44_PROJECT_ID;

  // 1. Explicitly check for required environment variables
  if (!apiKey) throw new Error("CRITICAL: Missing BASE44_API_KEY environment variable.");
  if (!projectId) throw new Error("CRITICAL: Missing BASE44_PROJECT_ID environment variable.");

  const url = `https://api.base44.com/projects/${projectId}/functions/${functionName}/invoke`;
  console.log(`Calling Base44 function: ${functionName}`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      let errorBody;
      try {
        errorBody = await response.json();
      } catch (e) {
        errorBody = await response.text();
      }
      throw new Error(`Base44 API returned an error. Status: ${response.status}. Body: ${JSON.stringify(errorBody)}`);
    }

    return response.json();
  } catch (error) {
    // 2. Add more detail if the 'fetch' itself fails
    if (error.message.includes('fetch failed') || error.cause) {
      console.error('Detailed network error cause:', error.cause);
      throw new Error(`Network-level error ('fetch failed') when trying to reach Base44 API. URL: ${url}. Please verify networking settings on Render and check that the BASE44_PROJECT_ID is correct.`);
    }
    // Re-throw other errors
    throw error;
  }
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
    
    const functionPayload = {
      sender,
      subject,
      content,
      recipient,
      recipientLocal,
      emailIdentifier,
      vin,
      raw_data: req.body
    };

    const result = await callBase44Function("messageProcessor", functionPayload);
    console.log("✅ Email processed successfully:", result);

  } catch (error) {
    console.error("❌ Email processing failed:", error.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
