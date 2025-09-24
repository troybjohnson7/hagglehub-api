import express from "express";
import cors from "cors";
import "dotenv/config";
import { createRawBodyMiddleware } from "./utils/rawBody.js";

const app = express();
app.use(express.json());

const allowed = (process.env.WEB_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (!allowed.length || allowed.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`));
  }
}));

const store = { inbox: [] };
const genId = () => "msg_" + Date.now() + "_" + Math.random().toString(36).slice(2,8);

app.get("/", (_req, res) => res.type("text").send("HaggleHub API is running."));
app.get("/health", (_req, res) => res.json({ ok: true }));

async function sendEmailHandler(req, res) {
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
app.post("/send-email", sendEmailHandler);
app.post("/api/send-email", sendEmailHandler);

app.use("/webhooks/email/mailgun", createRawBodyMiddleware());
app.post("/webhooks/email/mailgun", async (req, res) => {
  try {
    let payload = {};
    const ct = req.headers["content-type"] || "";
    if (ct.includes("application/json")) {
      payload = JSON.parse(req.rawBody.toString("utf8"));
    } else {
      const params = new URLSearchParams(req.rawBody.toString("utf8"));
      for (const [k, v] of params.entries()) payload[k] = v;
    }
    const from = payload["from"] || payload["sender"] || payload["From"] || "";
    const to = payload["recipient"] || payload["to"] || payload["To"] || "";
    const subject = payload["subject"] || "";
    const text = payload["body-plain"] || payload["text"] || "";
    const html = payload["body-html"] || payload["html"] || "";

    let userKey = "";
    const m = /deals-([^@]+)@/i.exec(to);
    if (m) userKey = m[1];

    const msg = { id: genId(), userKey, from, to, subject, text, html, ts: Date.now() };
    store.inbox.unshift(msg);
    return res.json({ ok: true, id: msg.id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "Webhook error" });
  }
});

app.get("/inbox/unmatched", (req, res) => {
  const userKey = String(req.query.userKey || "");
  const items = store.inbox.filter(m => m.userKey === userKey);
  res.json({ ok: true, items });
});
app.get("/users/:userKey/messages", (req, res) => {
  const userKey = String(req.params.userKey || "");
  const items = store.inbox.filter(m => m.userKey === userKey);
  res.json({ ok: true, items });
});

app.get("/debug/state", (_req, res) => res.json(store));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API listening on :${port}`));
