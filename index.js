// HaggleHub API — inbox-first backend (no seeds, no Base44)
//
// Core ideas:
// - Every user has a proxy email: deals-<userKey>@hagglehub.app
// - Inbound emails (Mailgun webhook) are stored in an inbox for that user
// - The app can attach an inbox message to an existing deal (by dealId)
// - Or attach by dealer (we'll find/create a deal for that user+dealer)
// - Or create a brand-new deal from a message (dealer inferred/created from sender)
// - Deals always belong to a user and have a dealer associated
//
// Endpoints:
//   GET  /health
//   GET  /users/me
//   GET  /dealers
//   POST /dealers
//   GET  /deals
//   GET  /deals/:id
//   POST /deals
//   GET  /deals/:id/messages
//   POST /deals/:id/messages        (outbound stub; logs only)
//   POST /webhooks/email/mailgun     (Mailgun inbound → inbox)
//   GET  /inbox/unmatched?userKey=...
//   POST /inbox/:msgId/attach        ({ dealId })
//   POST /inbox/:msgId/attachByDealer ({ dealer_id })  // find-or-create deal for user+dealer
//   POST /inbox/:msgId/createDeal    // infer/create dealer from message sender, then create deal
//   GET  /users/:userKey/messages    // convenience for "recent messages" per user (optional)
//   GET  /debug/state                // inspect in-memory state (optional)
//
// Notes:
// - In-memory storage for now; replace with a DB later.
// - No seeds: the API starts empty except one "current user" so the UI can load.

import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieSession from "cookie-session";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";

const app = express();
const PORT = process.env.PORT || 10000;

/* ---------- CORS ---------- */
const origins = (process.env.WEB_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => cb(null, origin || true),
  credentials: true
}));
app.use(express.json());

/* ---------- Sessions ---------- */
app.use(cookieSession({
  name: "hagglehub.sid",
  keys: [process.env.SESSION_SECRET || "dev-secret"],
  httpOnly: true,
  sameSite: "lax",
  secure: true
}));

/* ---------- Passport ---------- */
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new GoogleStrategy(
  {
    clientID: process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    callbackURL: process.env.GOOGLE_CALLBACK_URL
  },
  (accessToken, refreshToken, profile, done) => {
    // Minimal user object your frontend expects
    const user = {
      id: profile.id,
      key: profile.id,
      full_name: profile.displayName,
      email: profile.emails?.[0]?.value,
      user_metadata: {
        avatar_url: profile.photos?.[0]?.value
      }
    };
    return done(null, user);
  }
));

/* ---------- Auth routes ---------- */
app.get("/auth/google", (req, res, next) => {
  const state = req.query.redirect || "/";
  passport.authenticate("google", {
    scope: ["profile", "email"],
    state
  })(req, res, next);
});

app.get("/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/auth/failure" }),
  (req, res) => {
    const redirect = req.query.state || "/";
    // send back to your web app
    const dest = redirect.startsWith("http")
      ? redirect
      : `${(origins[0] || "https://www.hagglehub.app")}${redirect}`;
    res.redirect(dest);
  }
);

app.get("/auth/failure", (req, res) => {
  res.status(401).json({ error: "Google auth failed" });
});

app.get("/auth/logout", (req, res) => {
  req.logout?.(() => {});
  req.session = null;
  const redirect = req.query.redirect || (origins[0] || "https://www.hagglehub.app");
  res.redirect(redirect);
});

/* ---------- Me ---------- */
app.get("/users/me", (req, res) => {
  if (!req.user) return res.status(401).json({ error: "unauthenticated" });
  res.json(req.user);
});

/* ---------- Health ---------- */
app.get("/", (_, res) => res.json({ ok: true, service: "hagglehub-api" }));

app.listen(PORT, () => {
  console.log(`HaggleHub API listening on ${PORT}`);
});
