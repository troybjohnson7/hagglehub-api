import express from "express";
import cors from "cors";
import "dotenv/config";

const app = express();
app.use(express.json());

// CORS allow-list from env (comma-separated)
const allowed = (process.env.CORS_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    // allow same-origin or server-to-server (no Origin header)
    if (!origin) return cb(null, true);
    if (allowed.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`));
  }
}));

app.get("/", (_req, res) => res.type("text").send("HaggleHub API is running."));
app.get("/health", (_req, res) => res.json({ ok: true }));

async function handleSendEmail(req, res) {
  try {
    const { to, subject, text, html, replyTo } = req.body || {};
    if (!to || !subject || (!text && !html)) {
      return res.status(400).json({ ok: false, error: "Missing: 'to', 'subject', and one of 'text' or 'html'." });
    }

    const apiKey = process.env.MAILGUN_API_KEY;
    const domain = process.env.MAILGUN_DOMAIN;
    const from = process.env.MAILGUN_FROM;
    if (!apiKey || !domain || !from) {
      return res.status(500).json({ ok: false, error: "Mailgun not configured on server." });
    }

    const form = new URLSearchParams();
    form.append("from", from);
    form.append("to", to);
    form.append("subject", subject);
    if (text) form.append("text", text);
    if (html) form.append("html", html);
    if (replyTo) form.append("h:Reply-To", replyTo);

    const mgRes = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
      method: "POST",
      headers: {
        "Authorization": "Basic " + Buffer.from(`api:${apiKey}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form
    });

    const mgText = await mgRes.text();
    if (!mgRes.ok) {
      return res.status(mgRes.status).json({ ok: false, error: `Mail provider error: ${mgText}` });
    }
    return res.json({ ok: true, id: `mailgun:${Date.now()}` });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "Server error while sending email." });
  }
}

app.post("/send-email", handleSendEmail);
app.post("/api/send-email", handleSendEmail);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API listening on :${port}`));
