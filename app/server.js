require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const {
  sanitizeShop,
  buildInstallUrl,
  verifyHmac,
  generateNonce,
  exchangeCodeForToken
} = require("./shopify-auth");

const app = express();
const port = process.env.PORT || 3100;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

app.use(express.json());

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function ensureShopAndSettings({ shopDomain, accessToken = null }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const shopRes = await client.query(
      `INSERT INTO shops (shop_domain, access_token, installed_at, plan_name, plan_status, created_at, updated_at)
       VALUES ($1, $2, NOW(), 'free', 'active', NOW(), NOW())
       ON CONFLICT (shop_domain)
       DO UPDATE SET
         access_token = COALESCE(EXCLUDED.access_token, shops.access_token),
         installed_at = COALESCE(shops.installed_at, NOW()),
         updated_at = NOW()
       RETURNING id, shop_domain, plan_name, plan_status`,
      [shopDomain, accessToken]
    );

    const shop = shopRes.rows[0];

    await client.query(
      `INSERT INTO settings (shop_id, onboarding_complete, created_at, updated_at)
       VALUES ($1, false, NOW(), NOW())
       ON CONFLICT (shop_id)
       DO NOTHING`,
      [shop.id]
    );

    await client.query(
      `INSERT INTO audit_logs (shop_id, actor_type, actor_email, action, entity_type, entity_id, metadata_json)
       VALUES ($1, 'system', 'system@priceflow.local', $2, 'shop', $3, $4::jsonb)`,
      [shop.id, accessToken ? "oauth_install_complete" : "shop_record_created", String(shop.id), JSON.stringify({ shop_domain: shopDomain })]
    );

    await client.query("COMMIT");
    return shop;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

app.get("/", async (req, res) => {
  res.send(`
    <html>
      <head>
        <title>PriceFlow</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 32px; color: #111; }
          .card { max-width: 760px; border: 1px solid #e5e7eb; border-radius: 12px; padding: 24px; }
          h1 { margin-top: 0; }
          ul { line-height: 1.7; }
          input { padding: 10px; width: 320px; }
          button { padding: 10px 14px; cursor: pointer; }
          .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>PriceFlow</h1>
          <p>Shopify auth foundation is ready.</p>

          <form class="row" method="get" action="/install">
            <input name="shop" placeholder="store-name.myshopify.com" />
            <button type="submit">Install app</button>
          </form>

          <ul>
            <li><a href="/health">/health</a></li>
            <li><a href="/admin">/admin</a></li>
            <li><a href="/debug/schema">/debug/schema</a></li>
            <li><a href="/debug/shops">/debug/shops</a></li>
          </ul>
        </div>
      </body>
    </html>
  `);
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT NOW()");
    res.json({
      ok: true,
      app: process.env.APP_NAME,
      db: true,
      app_url: process.env.APP_URL || null,
      has_shopify_key: !!process.env.SHOPIFY_API_KEY,
      has_shopify_secret: !!process.env.SHOPIFY_API_SECRET
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/install", async (req, res) => {
  try {
    const shop = sanitizeShop(req.query.shop);
    if (!shop) {
      return res.status(400).send("Invalid or missing shop parameter.");
    }

    const apiKey = process.env.SHOPIFY_API_KEY;
    const scopes = process.env.SHOPIFY_SCOPES;
    const appUrl = process.env.APP_URL;

    if (!apiKey || !scopes || !appUrl) {
      return res.status(500).send("Missing Shopify app configuration.");
    }

    const state = generateNonce();
    const redirectUri = `${appUrl}/auth/callback`;
    const installUrl = buildInstallUrl({
      shop,
      apiKey,
      scopes,
      redirectUri,
      state
    });

    return res.redirect(installUrl);
  } catch (e) {
    return res.status(500).send(`Install failed: ${escapeHtml(e.message)}`);
  }
});

app.get("/auth/callback", async (req, res) => {
  try {
    const shop = sanitizeShop(req.query.shop);
    const code = String(req.query.code || "");

    if (!shop || !code) {
      return res.status(400).send("Missing shop or code.");
    }

    if (!verifyHmac(req.query)) {
      return res.status(400).send("Invalid HMAC.");
    }

    const tokenResponse = await exchangeCodeForToken({ shop, code });
    const accessToken = tokenResponse.access_token;

    if (!accessToken) {
      return res.status(500).send("No access token returned by Shopify.");
    }

    const shopRecord = await ensureShopAndSettings({
      shopDomain: shop,
      accessToken
    });

    return res.send(`
      <html>
        <head>
          <title>PriceFlow Installed</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 32px; color: #111; }
            .card { max-width: 760px; border: 1px solid #e5e7eb; border-radius: 12px; padding: 24px; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>PriceFlow installed</h1>
            <p>Shop connected successfully.</p>
            <p><strong>Shop:</strong> ${escapeHtml(shopRecord.shop_domain)}</p>
            <p><strong>Plan:</strong> ${escapeHtml(shopRecord.plan_name)}</p>
            <p>You can now move on to embedded admin shell + billing.</p>
          </div>
        </body>
      </html>
    `);
  } catch (e) {
    return res.status(500).send(`Auth callback failed: ${escapeHtml(e.message)}`);
  }
});

app.get("/admin", async (req, res) => {
  res.send(`
    <html>
      <head>
        <title>PriceFlow Admin</title>
        <style>
          body { font-family: Arial, sans-serif; background: #f8fafc; padding: 32px; color: #111; }
          .wrap { max-width: 1000px; margin: 0 auto; }
          .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
          .card { background: white; border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px; }
          h1, h2 { margin-top: 0; }
          .muted { color: #6b7280; }
        </style>
      </head>
      <body>
        <div class="wrap">
          <h1>PriceFlow Admin</h1>
          <p class="muted">Phase 3 scaffold: Shopify install/auth foundation.</p>
          <div class="grid">
            <div class="card">
              <h2>Now working</h2>
              <ul>
                <li>Install route</li>
                <li>OAuth redirect</li>
                <li>Callback handler</li>
                <li>Token storage</li>
                <li>Shop + settings upsert</li>
              </ul>
            </div>
            <div class="card">
              <h2>Next build step</h2>
              <ul>
                <li>Embedded admin shell</li>
                <li>Billing setup</li>
                <li>Tier CRUD</li>
                <li>Customer pricing CRUD</li>
              </ul>
            </div>
          </div>
        </div>
      </body>
    </html>
  `);
});

app.get("/debug/schema", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name ASC
    `);

    res.json({
      ok: true,
      tables: result.rows.map(r => r.table_name)
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/debug/shops", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, shop_domain, plan_name, plan_status, installed_at, created_at, updated_at,
             CASE WHEN access_token IS NULL THEN false ELSE true END AS has_access_token
      FROM shops
      ORDER BY id ASC
    `);

    res.json({
      ok: true,
      shops: result.rows
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(port, () => {
  console.log(`PriceFlow listening on ${port}`);
});
