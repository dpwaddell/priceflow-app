CREATE TABLE IF NOT EXISTS oauth_states (
  shop_domain TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
