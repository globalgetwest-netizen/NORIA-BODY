-- Noria Agent (Business) subscriptions — Cloudflare D1 schema (safe to run more than once).
-- Apply with:  npx wrangler d1 execute noria-db --remote --file=schema-subscriptions.sql
--
-- Tracks the real, billed, recurring $1000/month "Noria Agent" tier via Paystack. This is a SEPARATE
-- subscription from the $35/month "Noria Pro" tier (which today is unlocked by a stateless access code,
-- no billing, no database row at all — see worker.js validCode/isOwnerKey). A real subscription needs
-- state, because billing status changes over time (a payment can fail, renew, or be cancelled) in a way
-- a one-time stateless code never has to represent.

CREATE TABLE IF NOT EXISTS subscriptions (
  email                        TEXT PRIMARY KEY,
  plan                         TEXT NOT NULL DEFAULT 'noria_agent_business_monthly',
  status                       TEXT NOT NULL DEFAULT 'pending',  -- pending | active | past_due | cancelled
  paystack_customer_code       TEXT NOT NULL DEFAULT '',
  paystack_subscription_code   TEXT NOT NULL DEFAULT '',
  paystack_email_token         TEXT NOT NULL DEFAULT '',          -- needed to manage/cancel via Paystack's own API later
  last_reference                TEXT NOT NULL DEFAULT '',
  current_period_end           INTEGER NOT NULL DEFAULT 0,
  created_at                   INTEGER NOT NULL,
  updated_at                   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);

-- Every real Paystack event received, kept for audit/debugging (a webhook can usefully be replayed or
-- inspected after the fact — this is the same "never trust a single flat boolean, keep the evidence"
-- discipline the rest of Noria's codebase holds every other claim to).
CREATE TABLE IF NOT EXISTS payment_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL DEFAULT '',
  event         TEXT NOT NULL,
  reference     TEXT NOT NULL DEFAULT '',
  payload       TEXT NOT NULL DEFAULT '',   -- the raw event JSON, for later inspection
  received_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_events_email ON payment_events(email);
