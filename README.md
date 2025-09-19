# HaggleHub API (Starter on Render)

Minimal Express API to receive **Mailgun inbound emails**, store messages in memory, and serve your frontend.

## Endpoints
- `GET /health` → `{ ok: true }`
- `GET /deals` → demo list of deals
- `GET /deals/:id/messages` → messages for a deal
- `POST /deals/:id/messages` → stub for outbound email (logs only)
- `POST /webhooks/email/mailgun` → **Mailgun inbound webhook** (returns 200 immediately)

## Deploy on Render
1. Push this repo to GitHub (`hagglehub-api`).
2. In Render → **New → Web Service** → pick the repo.
3. **Build Command:** `npm install`
4. **Start Command:** `npm start`
5. **Environment Variables** (Render → Service → Environment):
   - `CORS_ORIGIN` = `https://app.hagglehub.app` (or `*` while testing)
   - `MAILGUN_DOMAIN` = `hagglehub.app` (used later for outbound)
   - `MAILGUN_API_KEY` = `key-...` (used later for outbound)
   - `MAIL_FROM` = `noreply@hagglehub.app` (used later for outbound)

## Mailgun Route
In Mailgun → **Receiving → Routes**:

```txt
match_recipient(".*@hagglehub.app")
forward("https://api.hagglehub.app/webhooks/email/mailgun")
stop()
```

Hit **Test**. You should see 200 OK, and the message will appear at:
`GET https://api.hagglehub.app/deals/1/messages`

## Next steps
- Replace in-memory arrays with Postgres + Prisma.
- Implement outbound email via Mailgun API in `POST /deals/:id/messages`.
- Add subject token `[Deal#ID]` to outbound to auto-link replies.
