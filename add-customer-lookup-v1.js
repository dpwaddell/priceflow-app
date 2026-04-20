const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const APP_ROOT = "/mnt/user/appdata/priceflow";
const SERVER_FILE = path.join(APP_ROOT, "app", "server.js");
const BACKUP_DIR = path.join(
  APP_ROOT,
  "backups",
  `${new Date().toISOString().replace(/[:.]/g, "-")}_phase6_customer_lookup`
);

function log(msg) {
  process.stdout.write(msg + "\n");
}

function run(cmd) {
  log(`$ ${cmd}`);
  execSync(cmd, {
    cwd: APP_ROOT,
    stdio: "inherit",
    env: process.env,
  });
}

function mustReplace(source, find, replace, label) {
  if (!source.includes(find)) {
    throw new Error(`Could not find expected block for: ${label}`);
  }
  return source.replace(find, replace);
}

try {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.copyFileSync(SERVER_FILE, path.join(BACKUP_DIR, "server.js"));
  if (fs.existsSync(path.join(APP_ROOT, "docker-compose.yml"))) {
    fs.copyFileSync(
      path.join(APP_ROOT, "docker-compose.yml"),
      path.join(BACKUP_DIR, "docker-compose.yml")
    );
  }
  if (fs.existsSync(path.join(APP_ROOT, ".env"))) {
    fs.copyFileSync(
      path.join(APP_ROOT, ".env"),
      path.join(BACKUP_DIR, ".env")
    );
  }

  let txt = fs.readFileSync(SERVER_FILE, "utf8");

  if (!txt.includes('const pool = new Pool({')) {
    throw new Error("Unexpected server.js shape: pool block not found");
  }

  if (!txt.includes('app.use(express.urlencoded({ extended: true }));')) {
    throw new Error("Unexpected server.js shape: express urlencoded block not found");
  }

  const helperInsertAfter = `app.use(express.json());
app.use(express.urlencoded({ extended: true }));`;

  const helperBlock = `app.use(express.json());
app.use(express.urlencoded({ extended: true }));

async function shopifyAdminGraphQL(shopDomain, accessToken, query, variables = {}) {
  const apiVersion = "2026-04";
  const res = await fetch(\`https://\${shopDomain}/admin/api/\${apiVersion}/graphql.json\`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(\`Shopify GraphQL failed: \${res.status} \${JSON.stringify(json)}\`);
  }

  if (json.errors && json.errors.length) {
    throw new Error(\`Shopify GraphQL errors: \${JSON.stringify(json.errors)}\`);
  }

  return json.data;
}

async function searchShopifyCustomers(shopDomain, term) {
  const shopRes = await pool.query(
    \`SELECT id, shop_domain, access_token
     FROM shops
     WHERE shop_domain = $1
     LIMIT 1\`,
    [shopDomain]
  );

  if (shopRes.rowCount === 0) {
    throw new Error("Shop not found.");
  }

  const shop = shopRes.rows[0];

  if (!shop.access_token) {
    throw new Error("Shop does not have an access token.");
  }

  const cleaned = String(term || "").trim();
  if (!cleaned) return [];

  const gql = \`
    query CustomerLookup($query: String!) {
      customers(first: 12, query: $query) {
        edges {
          node {
            id
            displayName
            firstName
            lastName
            email
            phone
            tags
          }
        }
      }
    }
  \`;

  const searchTerms = [
    cleaned,
    \`email:\${cleaned}\`,
    \`name:\${cleaned}\`
  ];

  const dedupe = new Map();

  for (const q of searchTerms) {
    const data = await shopifyAdminGraphQL(shop.shop_domain, shop.access_token, gql, { query: q });
    const edges = (((data || {}).customers || {}).edges || []);
    for (const edge of edges) {
      const node = edge && edge.node ? edge.node : null;
      if (!node || !node.id) continue;
      const shortId = String(node.id).split("/").pop();
      dedupe.set(node.id, {
        id: node.id,
        short_id: shortId,
        display_name: node.displayName || [node.firstName, node.lastName].filter(Boolean).join(" ").trim() || node.email || "Unnamed customer",
        email: node.email || "",
        phone: node.phone || "",
        tags: Array.isArray(node.tags) ? node.tags : []
      });
    }
  }

  return Array.from(dedupe.values());
}`;

  txt = mustReplace(txt, helperInsertAfter, helperBlock, "insert Shopify GraphQL helper");

  const renderAssignmentsMarker = `function renderPricingTiersPage({ shop, host, apiKey, dashboard, tiers }) {`;
  if (!txt.includes(renderAssignmentsMarker)) {
    throw new Error("Could not find pricing tiers render marker");
  }

  const newAssignmentsRenderer = `
function renderCustomerAssignmentsPage({ shop, host, apiKey, dashboard, tiers, assignments }) {
  const rows = assignments.length === 0
    ? \`<div class="empty">No customer assignments yet. Assign your first trade customer to a pricing tier below.</div>\`
    : \`
      <div class="card">
        <h2>Existing customer assignments</h2>
        <table>
          <thead>
            <tr>
              <th>Customer</th>
              <th>Shopify ID</th>
              <th>Tier</th>
              <th>Effective from</th>
              <th>Effective to</th>
              <th>Status</th>
              <th style="width:220px;">Actions</th>
            </tr>
          </thead>
          <tbody>
            \${assignments.map((assignment) => {
              const status = ruleStatus(assignment.starts_at, assignment.ends_at, assignment.is_enabled);
              return \`
                <tr>
                  <td>
                    <strong>\${escapeHtml(assignment.customer_email)}</strong>
                  </td>
                  <td>\${escapeHtml(assignment.shopify_customer_id || "—")}</td>
                  <td>\${escapeHtml(assignment.tier_name || "—")}</td>
                  <td>\${escapeHtml(fmtDisplayDate(assignment.starts_at))}</td>
                  <td>\${escapeHtml(fmtDisplayDate(assignment.ends_at))}</td>
                  <td><span class="badge \${badgeClass(status)}">\${escapeHtml(status)}</span></td>
                  <td>
                    <div class="table-actions">
                      <form class="inline-form" method="post" action="/customer-assignments/\${assignment.id}/toggle?shop=\${encodeURIComponent(shop)}\${host ? \`&host=\${encodeURIComponent(host)}\` : ""}">
                        <button class="btn small" type="submit">\${assignment.is_enabled ? "Disable" : "Enable"}</button>
                      </form>
                      <form class="inline-form" method="post" action="/customer-assignments/\${assignment.id}/delete?shop=\${encodeURIComponent(shop)}\${host ? \`&host=\${encodeURIComponent(host)}\` : ""}" onsubmit="return confirm('Delete this customer assignment?');">
                        <button class="btn small danger" type="submit">Delete</button>
                      </form>
                    </div>
                  </td>
                </tr>
              \`;
            }).join("")}
          </tbody>
        </table>
      </div>
    \`;

  const tierOptions = tiers.map((tier) => {
    const status = ruleStatus(tier.starts_at, tier.ends_at, tier.is_enabled);
    return \`<option value="\${tier.id}">\${escapeHtml(tier.name)} (\${escapeHtml(status)})</option>\`;
  }).join("");

  const content = \`
    <div class="topbar">
      <div>
        <h1>Customer assignments</h1>
        <div class="sub">
          Link trade customers to pricing tiers. Search Shopify customers first, then create the assignment with the correct email and Shopify customer ID.
        </div>
      </div>
      <div class="shop-meta">
        <span class="pill">Shop: \${escapeHtml(shop)}</span>
        <span class="pill">Plan: \${escapeHtml(dashboard.shop.plan_name || "free")}</span>
        <span class="pill">Tiers: \${escapeHtml(String(dashboard.counts.tiers || 0))}</span>
      </div>
    </div>

    \${renderNav(shop, host, "assignments")}

    <div class="grid">
      <div class="stack">
        \${rows}
      </div>

      <div class="stack">
        <div class="card">
          <h2>Find Shopify customer</h2>
          <div class="muted" style="margin-bottom:12px;">
            Search by email or name. Selecting a result will fill the assignment form automatically.
          </div>

          <div class="form-grid">
            <div class="field full">
              <label for="customer_lookup_term">Customer search</label>
              <input id="customer_lookup_term" placeholder="Search by name or email" />
            </div>
          </div>

          <div class="actions">
            <button type="button" class="btn" id="customer_lookup_btn">Search customers</button>
          </div>

          <div id="customer_lookup_results" style="margin-top:16px;"></div>
        </div>

        <div class="card">
          <h2>Create customer assignment</h2>
          \${tiers.length === 0 ? \`
            <div class="empty">
              You need at least one pricing tier before assigning customers.
            </div>
          \` : \`
          <form method="post" action="/customer-assignments?shop=\${encodeURIComponent(shop)}\${host ? \`&host=\${encodeURIComponent(host)}\` : ""}">
            <div class="form-grid">
              <div class="field full">
                <label for="customer_email">Customer email</label>
                <input id="customer_email" name="customer_email" type="email" placeholder="buyer@example.com" required />
              </div>

              <div class="field full">
                <label for="shopify_customer_id">Shopify customer ID</label>
                <input id="shopify_customer_id" name="shopify_customer_id" placeholder="123456789" />
              </div>

              <div class="field full">
                <label for="tier_id">Pricing tier</label>
                <select id="tier_id" name="tier_id" required>
                  <option value="">Select a tier</option>
                  \${tierOptions}
                </select>
              </div>

              <div class="field">
                <label for="starts_at">Effective from</label>
                <input id="starts_at" name="starts_at" type="datetime-local" />
              </div>

              <div class="field">
                <label for="ends_at">Effective to</label>
                <input id="ends_at" name="ends_at" type="datetime-local" />
              </div>

              <div class="field full">
                <label for="is_enabled">Status</label>
                <select id="is_enabled" name="is_enabled">
                  <option value="true">Enabled</option>
                  <option value="false">Draft / disabled</option>
                </select>
              </div>
            </div>

            <div class="actions">
              <button class="btn primary" type="submit">Create assignment</button>
              <button type="button" class="btn" onclick="window.location.href='\${getEmbeddedAppUrl(shop, host, "/")}';">Back to dashboard</button>
            </div>
          </form>
          \`}
        </div>
      </div>
    </div>

    <script>
      (() => {
        const btn = document.getElementById("customer_lookup_btn");
        const termInput = document.getElementById("customer_lookup_term");
        const results = document.getElementById("customer_lookup_results");
        const emailInput = document.getElementById("customer_email");
        const idInput = document.getElementById("shopify_customer_id");

        if (!btn || !termInput || !results || !emailInput || !idInput) return;

        function esc(v) {
          return String(v || "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#39;");
        }

        async function search() {
          const term = termInput.value.trim();
          if (!term) {
            results.innerHTML = '<div class="empty">Enter a customer name or email to search.</div>';
            return;
          }

          btn.disabled = true;
          btn.textContent = "Searching...";

          try {
            const res = await fetch("/api/customer-search?shop=" + encodeURIComponent(${JSON.stringify(shop)}) + "&q=" + encodeURIComponent(term));
            const data = await res.json();

            if (!res.ok || !data.ok) {
              results.innerHTML = '<div class="empty">Search failed: ' + esc((data && data.error) || 'Unknown error') + '</div>';
              return;
            }

            const customers = data.customers || [];
            if (!customers.length) {
              results.innerHTML = '<div class="empty">No Shopify customers found for that search.</div>';
              return;
            }

            results.innerHTML = customers.map((c) => {
              const subtitle = [c.email || "", c.phone || ""].filter(Boolean).join(" · ");
              return \`
                <div class="card" style="padding:14px; margin-top:10px;">
                  <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
                    <div>
                      <div style="font-weight:700;">\${esc(c.display_name)}</div>
                      <div class="muted" style="margin-top:4px;">\${esc(subtitle || "No email/phone available")}</div>
                      <div class="muted" style="margin-top:4px;">Shopify ID: \${esc(c.short_id || "")}</div>
                    </div>
                    <div>
                      <button type="button" class="btn small">Use customer</button>
                    </div>
                  </div>
                </div>
              \`;
            }).join("");

            const cards = Array.from(results.querySelectorAll(".card"));
            cards.forEach((card, idx) => {
              const customer = customers[idx];
              const button = card.querySelector("button");
              if (!button) return;
              button.addEventListener("click", () => {
                emailInput.value = customer.email || "";
                idInput.value = customer.short_id || "";
                emailInput.focus();
              });
            });
          } catch (err) {
            results.innerHTML = '<div class="empty">Search failed: ' + esc(err.message || String(err)) + '</div>';
          } finally {
            btn.disabled = false;
            btn.textContent = "Search customers";
          }
        }

        btn.addEventListener("click", search);
        termInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            search();
          }
        });
      })();
    </script>
  `;

  return renderLayout({ shop, host, apiKey, title: "PriceFlow | Customer assignments", content });
}
` + renderAssignmentsMarker;

  txt = mustReplace(txt, renderAssignmentsMarker, newAssignmentsRenderer, "insert customer assignment renderer");

  const getAssignmentsBlock = `async function getPricingTiers(shopId) {
  const res = await pool.query(
    \`SELECT id, name, customer_tag, discount_type, discount_value, is_enabled, starts_at, ends_at, created_at, updated_at
     FROM pricing_tiers
     WHERE shop_id = $1
     ORDER BY created_at DESC, id DESC\`,
    [shopId]
  );
  return res.rows;
}`;

  const getAssignmentsReplacement = `async function getPricingTiers(shopId) {
  const res = await pool.query(
    \`SELECT id, name, customer_tag, discount_type, discount_value, is_enabled, starts_at, ends_at, created_at, updated_at
     FROM pricing_tiers
     WHERE shop_id = $1
     ORDER BY created_at DESC, id DESC\`,
    [shopId]
  );
  return res.rows;
}

async function getCustomerAssignments(shopId) {
  const res = await pool.query(
    \`SELECT
        ca.id,
        ca.shop_id,
        ca.shopify_customer_id,
        ca.customer_email,
        ca.tier_id,
        ca.starts_at,
        ca.ends_at,
        ca.is_enabled,
        ca.created_at,
        ca.updated_at,
        pt.name AS tier_name
      FROM customer_assignments ca
      JOIN pricing_tiers pt
        ON pt.id = ca.tier_id
      WHERE ca.shop_id = $1
      ORDER BY ca.created_at DESC, ca.id DESC\`,
    [shopId]
  );
  return res.rows;
}`;

  txt = mustReplace(txt, getAssignmentsBlock, getAssignmentsReplacement, "add getCustomerAssignments");

  const customerAssignmentsRouteBlock = `app.get("/customer-assignments", async (req, res) => {
  try {
    const shop = sanitizeShop(req.query.shop);
    const host = String(req.query.host || "");
    if (!shop) return res.status(400).send("Missing or invalid shop.");

    const dashboard = await getDashboardData(shop);
    if (!dashboard) return res.status(404).send("Shop not found.");

    const tiers = await getPricingTiers(dashboard.shop.id);
    const assignments = await getCustomerAssignments(dashboard.shop.id);

    return res.send(renderCustomerAssignmentsPage({
      shop,
      host,
      apiKey: process.env.SHOPIFY_API_KEY || "",
      dashboard,
      tiers,
      assignments
    }));
  } catch (e) {
    return res.status(500).send(\`Customer assignments load failed: \${escapeHtml(e.message)}\`);
  }
});`;

  const apiRoute = `
app.get("/api/customer-search", async (req, res) => {
  try {
    const shop = sanitizeShop(req.query.shop);
    const q = String(req.query.q || "").trim();

    if (!shop) {
      return res.status(400).json({ ok: false, error: "Missing or invalid shop." });
    }

    if (!q) {
      return res.json({ ok: true, customers: [] });
    }

    const customers = await searchShopifyCustomers(shop, q);
    return res.json({ ok: true, customers });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});
` + customerAssignmentsRouteBlock;

  txt = mustReplace(txt, customerAssignmentsRouteBlock, apiRoute, "insert api customer search route");

  fs.writeFileSync(SERVER_FILE, txt);

  log("Patch applied.");
  run("docker compose down");
  run("docker compose up -d");
  execSync("sleep 8");

  log("");
  log("Health:");
  run("curl -s http://localhost:3100/health");
  log("");
  log("Route check:");
  run(`grep -n 'api/customer-search\\|searchShopifyCustomers\\|Find Shopify customer' ${SERVER_FILE}`);
  log("");
  log("Done.");
  log("Open Customer assignments and test searching by customer email or name.");
} catch (err) {
  console.error("");
  console.error("FAILED:", err.message);
  process.exit(1);
}
