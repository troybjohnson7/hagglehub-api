// index.js for Render - FINAL VERSION 2
// HaggleHub API — Mailgun -> Render -> Base44

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
const extractDealerName = (text) => {
    const name = text?.match(/from\s+([\w\s&.,'’\-]+?)(?:[\.\n\r]|$)/i)?.[1]?.trim();
    if (!name || ["me", "us"].includes(name.toLowerCase())) return "";
    return name.slice(0, 80);
};

// --- Base44 Helpers ---
async function findUserByEmailId(base44, emailIdentifier) {
    if (!emailIdentifier) return null;
    const { items } = await base44.entities.User.list({ where: { email_identifier: emailIdentifier }, limit: 1 });
    return items?.[0] || null;
}

async function findOrCreateDealer(base44, dealerName, sender) {
    const safeName = dealerName?.trim() || sender.split('@')[0].replace(/[._-]/g, ' ').trim();
    if (!safeName) { // Final check for a valid name
        throw new Error("Could not determine a valid dealer name from sender email.");
    }
    const { items } = await base44.entities.Dealer.list({ where: { name: safeName }, limit: 1 });
    if (items?.[0]?.id) {
        console.log(`Found existing dealer: ${safeName} (ID: ${items[0].id})`);
        return items[0].id;
    }
    
    console.log(`Creating new dealer: ${safeName}`);
    // FIX: DO NOT specify created_by. The service key will own this record.
    const newDealer = await base44.entities.Dealer.create({
        data: { name: safeName, contact_email: sender }
    });
    return newDealer.id;
}


// --- Main Webhook ---
app.post("/webhooks/email/mailgun", async (req, res) => {
    // ACK Mailgun immediately
    res.status(200).send("OK");

    try {
        // 1. Extract data
        const sender = req.body.sender || req.body.from || "";
        const recipient = req.body.recipient || req.body.to || "";
        const subject = req.body.subject || "";
        const textBody = req.body["body-plain"] || "";
        const htmlBody = req.body["body-html"] || "";
        const content = textBody || stripHtml(htmlBody);

        const { local: recipientLocal } = splitRecipient(recipient);
        const emailIdentifier = extractTokenFromLocal(recipientLocal);
        
        console.log(`Processing email for identifier: ${emailIdentifier}`);

        // 2. Init Base44 client
        const apiKey = process.env.BASE44_API_KEY;
        if (!apiKey) throw new Error("Missing BASE44_API_KEY");
        const base44 = createClient({ apiKey });

        // 3. Find User
        const user = await findUserByEmailId(base44, emailIdentifier);
        if (!user) throw new Error(`User not found for email identifier: ${emailIdentifier}`);
        console.log(`Found user: ${user.id}`);

        // 4. Find or Create Dealer
        const vin = extractVIN(content);
        const dealerName = extractDealerName(content);
        const dealerId = await findOrCreateDealer(base44, dealerName, sender);
        if (!dealerId) throw new Error("Failed to find or create a dealer.");

        // 5. Invoke the Base44 function with all required IDs
        const functionPayload = {
            sender,
            subject,
            content,
            vin,
            dealer_id: dealerId,
            user_id: user.id, // Pass user_id for message ownership
            raw_data: req.body
        };

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
