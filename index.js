import { createClient } from "@base44/sdk";

// ... inside app.post("/webhooks/email/mailgun", async (req, res) => { ... after res.status(200).send("OK") ... })

try {
  const apiKey = process.env.BASE44_API_KEY;
  if (!apiKey) {
    console.error("Missing BASE44_API_KEY — cannot forward to Base44");
    return;
  }

  // Create regular client with API key (no service token)
  const base44 = createClient({ apiKey });

  // Create the message directly (NO asServiceRole)
  await base44.entities.Message.create({
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
