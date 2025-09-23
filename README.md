# HaggleHub Minimal Backend (Express + Mailgun)

Exposes:
- `GET /health` → `{ ok: true }`
- `GET /` → “HaggleHub API is running.”
- `POST /send-email` → Sends email via Mailgun
- (also accepts `POST /api/send-email`)

## Quick start (local)
```bash
npm i
copy .env.example .env   # set your values
npm start
# test
curl -i http://localhost:3000/health
curl -i -X POST http://localhost:3000/send-email -H "Content-Type: application/json" -d "{"to":"you@yourmail.com","subject":"Test","text":"Hello"}"
```

## Required env vars (Render backend only; NEVER in frontend)
- `CORS_ORIGIN` → comma-separated list of allowed frontends (e.g., `https://hagglehub.app,https://hagglehub-web.onrender.com`)
- `MAILGUN_API_KEY` → your Mailgun API key
- `MAILGUN_DOMAIN` → `mg.yourdomain.com`
- `MAILGUN_FROM` → `HaggleHub <no-reply@yourdomain.com>`
- `PORT` → optional (defaults to 3000)

## Render deploy
1) Create Web Service (Node 18).
2) Build: `npm i` | Start: `npm start`.
3) Add env vars above.
4) Point custom domain `https://api.hagglehub.app` to this service.

## Frontend config
- `VITE_API_URL=https://api.hagglehub.app`
- The FE will call `POST ${VITE_API_URL}/send-email`
