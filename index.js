// index.js for Render - Fallback System Version

import express from "express";
import cors from "cors";
import { createClient } from "@base44/sdk";

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// --- Health Check ---
app.get("/", (_req, res) => res.send("HaggleHub API is running."));

// --- Helpers ---
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

// --- Base44 Helpers ---
async function findUserAndFallbackDeal(base44, emailIdentifier) {
    if (!emailIdentifier) return null;
    const { items } = await base44.entities.User.list({ where: { email_identifier: emailIdentifier }, limit: 1 });
    const user = items?.[0];
    if (!user || !user.fallback_deal_id) return null;

    // Fetch the associated fallback deal to get the dealer_id
    const deals = await base44.entities.Deal.filter({id: user.fallback_deal_id});
    const deal = deals?.[0];
    if (!deal) return null;
    
    return { userId: user.id, dealId: deal.id, dealerId: deal.dealer_id };
}

// --- Main Webhook ---
app.post("/webhooks/email/mailgun", async (req, res) => {
    // ACK Mailgun immediately
    res.status(200).send("OK");

    try {
        // 1. Extract data
        const sender = req.body.sender || req.body.from || "";
        const subject = req.body.subject || "";
        const textBody = req.body["body-plain"] || "";
        const htmlBody = req.body["body-html"] || "";
        const content = textBody || stripHtml(htmlBody);
        const recipient = req.body.recipient || req.body.to || "";

        const { local: recipientLocal } = splitRecipient(recipient);
        const emailIdentifier = extractTokenFromLocal(recipientLocal);
        
        console.log(`Processing email for identifier: ${emailIdentifier}`);

        // 2. Init Base44 client
        const apiKey = process.env.BASE44_API_KEY;
        if (!apiKey) throw new Error("Missing BASE44_API_KEY");
        const base44 = createClient({ apiKey });

        // 3. Find User and their Fallback Deal info
        const fallbackInfo = await findUserAndFallbackDeal(base44, emailIdentifier);
        if (!fallbackInfo) throw new Error(`User/FallbackDeal not found for identifier: ${emailIdentifier}`);
        console.log(`Found user and fallback info:`, fallbackInfo);

        // 4. Invoke the Base44 function with guaranteed IDs
        const vin = extractVIN(content); // Still useful for the function to try matching
        
        const functionPayload = {
            sender,
            subject,
            content,
            vin,
            dealer_id: fallbackInfo.dealerId, // Use the fallback dealer
            user_id: fallbackInfo.userId,
            raw_data: req.body
        };

        // Even if VIN matching works, we can still use the fallback dealer_id.
        // The deal_id inside the function will be correctly assigned if a match is found.
        if (vin) {
            functionPayload.deal_id = null; // Let the function find the deal
        } else {
            functionPayload.deal_id = fallbackInfo.dealId; // No VIN, so assign to fallback deal
        }
        
        await base44.functions.invoke("messageProcessor", functionPayload);
        console.log("✅ Successfully invoked messageProcessor function.");

    } catch (err) {
        console.error("--- WEBHOOK PROCESSING FAILED ---");
        console.error(err.message);
        const data = err?.response?.data || err?.data;
        if (data) console.error("Error Details:", data);
    }
});

// --- Start Server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HaggleHub API listening on ${PORT}`));
