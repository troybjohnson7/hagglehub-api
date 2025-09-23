# HaggleHub Backend (Express + Mailgun)

Endpoints:
- GET  /health
- GET  /               -> "HaggleHub API is running."
- POST /send-email     -> outbound via Mailgun
- POST /api/send-email -> same handler (optional prefix)
- POST /webhooks/email/mailgun -> inbound Mailgun webhook (stores inbox)
- GET  /inbox/unmatched?userKey=...   -> messages not attached to deals
- GET  /users/:userKey/messages       -> all messages for a user
- GET  /debug/state                   -> debug in-memory store (dev only)

## Deploy on Render
1. Create Web Service (Node 18).
2. Build: `npm i` | Start: `npm start`
3. Env vars:
   - WEB_ORIGINS=https://hagglehub.app,https://hagglehub-web.onrender.com
   - MAILGUN_API_KEY=...
   - MAILGUN_DOMAIN=mg.yourdomain.com
   - MAILGUN_FROM="HaggleHub <no-reply@yourdomain.com>"
   - (optional) MAILGUN_SIGNING_KEY=...
4. Point custom domain https://api.hagglehub.app to this service.

## Mailgun Inbound Route
- Create a route that POSTs to: https://api.hagglehub.app/webhooks/email/mailgun
- For testing, you can POST a JSON payload with fields: sender, recipient, subject, body-plain, body-html
