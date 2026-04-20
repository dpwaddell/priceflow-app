const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const APP_ROOT = "/mnt/user/appdata/priceflow";
const SERVER_FILE = path.join(APP_ROOT, "app", "server.js");
const BACKUP_DIR = path.join(
  APP_ROOT,
  "backups",
  `${new Date().toISOString().replace(/[:.]/g, "-")}_phase6_customer_search_safe_v3`
);

function log(msg) {
  process.stdout.write(msg + "\n");
}

function run(cmd, opts = {}) {
  log(`$ ${cmd}`);
  return execSync(cmd, {
    cwd: APP_ROOT,
    env: process.env,
    ...opts,
  });
}

function runPrint(cmd) {
  log(`$ ${cmd}`);
  execSync(cmd, {
    cwd: APP_ROOT,
    env: process.env,
    stdio: "inherit",
    shell: "/bin/bash",
  });
}

function fail(msg) {
  throw new Error(msg);
}

function replaceRegexOrThrow(txt, regex, replacement, label) {
  if (!regex.test(txt)) {
    fail(`Could not replace expected block: ${label}`);
  }
  return txt.replace(regex, replacement);
}

try {
  if (!fs.existsSync(SERVER_FILE)) {
    fail(`Missing ${SERVER_FILE}`);
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.copyFileSync(SERVER_FILE, path.join(BACKUP_DIR, "server.js"));

  const composeFile = path.join(APP_ROOT, "docker-compose.yml");
  if (fs.existsSync(composeFile)) {
    fs.copyFileSync(composeFile, path.join(BACKUP_DIR, "docker-compose.yml"));
  }

  const envFile = path.join(APP_ROOT, ".env");
  if (fs.existsSync(envFile)) {
    fs.copyFileSync(envFile, path.join(BACKUP_DIR, ".env"));
  }

  let txt = fs.readFileSync(SERVER_FILE, "utf8");

  if (!txt.includes('app.use(express.urlencoded({ extended: true }));')) {
    fail("Could not find express urlencoded middleware");
  }

  if (!txt.includes('function renderCustomerAssignmentsPage(')) {
    fail("Could not find renderCustomerAssignmentsPage");
  }

  if (!txt.includes('app.get("/customer-assignments", async (req, res) => {')) {
    fail('Could not find app.get("/customer-assignments"... route');
  }

  if (!txt.includes('app.post("/customer-assignments", async (req, res) => {')) {
    fail('Could not find app.post("/customer-assignments"... route');
  }

  if (!txt.includes("async function shopifyAdminGraphQL(")) {
    const helperBlock = `app.use(express.urlencoded({ extended: true }));

async function shopifyAdminGraphQL(shopDomain, accessToken, query, variables = {}) {
  const apiVersion = "2026-04";
  const response = await fetch(\`https://\${shopDomain}/admin/api/\${apiVersion}/graphql.json\`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(\`Shopify GraphQL request failed: \${response.status}\`);
  }

  if (json.errors && json.errors.length) {
    throw new Error(\`Shopify GraphQL errors: \${JSON.stringify(json.errors)}\`);
  }

  return json.data || {};
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

  const query = \`
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

  const seen = new Map();

  for (const q of searchTerms) {
    const data = await shopifyAdminGraphQL(shop.shop_domain, shop.access_token, query, { query: q });
    const edges = (((data || {}).customers || {}).edges || []);
    for (const edge of edges) {
      const node = edge && edge.node ? edge.node : null;
      if (!node || !node.id) continue;

      const shortId = String(node.id).split("/").pop();
      seen.set(node.id, {
        id: node.id,
        short_id: shortId,
        display_name:
          node.displayName ||
          [node.firstName, node.lastName].filter(Boolean).join(" ").trim() ||
          node.email ||
          "Unnamed customer",
        email: node.email || "",
        phone: node.phone || "",
        tags: Array.isArray(node.tags) ? node.tags : []
      });
    }
  }

  return Array.from(seen.values());
}`;

    txt = txt.replace('app.use(express.urlencoded({ extended: true }));', helperBlock);
  }

  const newRenderer = `function renderCustomerAssignmentsPage({ shop, host, apiKey, dashboard, tiers, assignments, searchTerm = "", searchResults = [], prefillEmail = "", prefillId = "", searchError = "" }) {
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
                  <td><strong>\${escapeHtml(assignment.customer_email)}</strong></td>
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

  const searchResultsHtml = searchError
    ? \`<div class="empty" style="margin-top:12px;">Search failed: \${escapeHtml(searchError)}</div>\`
    : searchResults.length
      ? \`
        <div style="margin-top:16px; display:grid; gap:10px;">
          \${searchResults.map((customer) => {
            const subtitle = [customer.email || "", customer.phone || ""].filter(Boolean).join(" · ");
            const tags = Array.isArray(customer.tags) && customer.tags.length ? customer.tags.join(", ") : "No tags";
            const useUrl = "/customer-assignments?shop=" + encodeURIComponent(shop)
              + (host ? "&host=" + encodeURIComponent(host) : "")
              + "&lookup=" + encodeURIComponent(searchTerm)
              + "&use_email=" + encodeURIComponent(customer.email || "")
              + "&use_id=" + encodeURIComponent(customer.short_id || "");
            return \`
              <div class="card" style="padding:14px;">
                <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
                  <div>
                    <div style="font-weight:700;">\${escapeHtml(customer.display_name)}</div>
                    <div class="muted" style="margin-top:4px;">\${escapeHtml(subtitle || "No email/phone available")}</div>
                    <div class="muted" style="margin-top:4px;">Shopify ID: \${escapeHtml(customer.short_id || "")}</div>
                    <div class="muted" style="margin-top:4px;">Tags: \${escapeHtml(tags)}</div>
                  </div>
                  <div>
                    <a class="btn small" href="\${useUrl}">Use customer</a>
                  </div>
                </div>
              </div>
            \`;
          }).join("")}
        </div>
      \`
      : searchTerm
        ? \`<div class="empty" style="margin-top:12px;">No Shopify customers found for that search.</div>\`
        : "";

  const content = \`
    <div class="topbar">
      <div>
        <h1>Customer assignments</h1>
        <div class="sub">
          Connect trade customers to pricing tiers with optional effective dates. Search Shopify customers first, then assign them in one click.
        </div>
      </div>
      <div class="shop-meta">
        <span class="pill">Shop: \${escapeHtml(shop)}</span>
        <span class="pill">Plan: \${escapeHtml(dashboard.shop.plan_name || "free")}</span>
        <span class="pill">Trade customers limit: \${escapeHtml(String(dashboard.settings.free_plan_customer_limit || 1))}</span>
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
            Search by name or email. Selecting a result will fill the assignment form automatically.
          </div>

          <form method="get" action="/customer-assignments">
            <input type="hidden" name="shop" value="\${escapeHtml(shop)}" />
            \${host ? \`<input type="hidden" name="host" value="\${escapeHtml(host)}" />\` : ""}
            <div class="form-grid">
              <div class="field full">
                <label for="lookup">Customer search</label>
                <input id="lookup" name="lookup" value="\${escapeHtml(searchTerm)}" placeholder="Search by name or email" />
              </div>
            </div>

            <div class="actions">
              <button type="submit" class="btn">Search customers</button>
            </div>
          </form>

          \${searchResultsHtml}
        </div>

        <div class="card">
          <h2>Assign customer to tier</h2>
          \${tiers.length === 0 ? \`
            <div class="empty">You need at least one pricing tier before assigning customers.</div>
          \` : \`
            <form method="post" action="/customer-assignments?shop=\${encodeURIComponent(shop)}\${host ? \`&host=\${encodeURIComponent(host)}\` : ""}">
              <div class="form-grid">
                <div class="field full">
                  <label for="customer_email">Customer email</label>
                  <input id="customer_email" name="customer_email" type="email" value="\${escapeHtml(prefillEmail)}" placeholder="buyer@example.com" required />
                </div>

                <div class="field full">
                  <label for="shopify_customer_id">Shopify customer ID (optional)</label>
                  <input id="shopify_customer_id" name="shopify_customer_id" value="\${escapeHtml(prefillId)}" placeholder="123456789" />
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

        <div class="card">
          <h2>How assignments work</h2>
          <div class="list">
            <div class="list-row"><div>One row per customer</div><div class="muted">Manual MVP</div></div>
            <div class="list-row"><div>Email is primary</div><div class="muted">Simple to test</div></div>
            <div class="list-row"><div>Optional dates</div><div class="muted">Campaign ready</div></div>
            <div class="list-row"><div>Free plan</div><div class="muted">1 trade customer</div></div>
          </div>
        </div>
      </div>
    </div>
  \`;

  return renderLayout({ shop, host, apiKey, title: "PriceFlow | Customer assignments", content });
}

`;

  txt = replaceRegexOrThrow(
    txt,
    /function renderCustomerAssignmentsPage\([\s\S]*?\n}\n\napp\.get\("\/customer-assignments", async \(req, res\) => \{/,
    newRenderer + '\napp.get("/customer-assignments", async (req, res) => {',
    "renderCustomerAssignmentsPage block"
  );

  const newGetRoute = `app.get("/customer-assignments", async (req, res) => {
  try {
    const shop = sanitizeShop(req.query.shop);
    const host = String(req.query.host || "");
    const lookup = String(req.query.lookup || "").trim();
    const useEmail = String(req.query.use_email || "").trim();
    const useId = String(req.query.use_id || "").trim();

    if (!shop) return res.status(400).send("Missing or invalid shop.");

    const dashboard = await getDashboardData(shop);
    if (!dashboard) return res.status(404).send("Shop not found.");

    const tiers = await getPricingTiers(dashboard.shop.id);
    const assignments = await getCustomerAssignments(dashboard.shop.id);

    let searchResults = [];
    let searchError = "";

    if (lookup) {
      try {
        searchResults = await searchShopifyCustomers(shop, lookup);
      } catch (err) {
        searchError = err.message;
      }
    }

    return res.send(renderCustomerAssignmentsPage({
      shop,
      host,
      apiKey: process.env.SHOPIFY_API_KEY || "",
      dashboard,
      tiers,
      assignments,
      searchTerm: lookup,
      searchResults,
      prefillEmail: useEmail,
      prefillId: useId,
      searchError
    }));
  } catch (e) {
    return res.status(500).send(\`Customer assignments load failed: \${escapeHtml(e.message)}\`);
  }
});

app.post("/customer-assignments", async (req, res) => {`;

  txt = replaceRegexOrThrow(
    txt,
    /app\.get\("\/customer-assignments", async \(req, res\) => \{[\s\S]*?\n}\);\n\napp\.post\("\/customer-assignments", async \(req, res\) => \{/,
    newGetRoute,
    "customer assignments GET route"
  );

  fs.writeFileSync(SERVER_FILE, txt);

  log("Running syntax check...");
  run("node -c app/server.js", { stdio: "inherit" });

  log("");
  log("Restarting stack...");
  runPrint("docker compose down");
  runPrint("docker compose up -d");

  log("");
  log("Waiting for app...");
  execSync("sleep 8");

  log("");
  log("Health:");
  run("curl -s http://localhost:3100/health", { stdio: "inherit" });

  log("");
  log("Route markers:");
  run(`grep -n "searchShopifyCustomers\\|Find Shopify customer\\|Assign customer to tier" ${SERVER_FILE}`, {
    stdio: "inherit",
    shell: "/bin/bash"
  });

  log("");
  log("Checkpointing to git...");
  try {
    runPrint("git add app/server.js");
    execSync('git commit -m "Add server-side Shopify customer search to customer assignments"', {
      cwd: APP_ROOT,
      env: process.env,
      stdio: "inherit",
      shell: "/bin/bash",
    });
  } catch (err) {
    log("No commit created, continuing.");
  }
  runPrint("git push origin main");

  log("");
  log("Done.");
  log("Now open Customer assignments in Shopify admin and search by a real customer name or email.");
} catch (err) {
  console.error("");
  console.error("FAILED:", err.message);

  try {
    if (fs.existsSync(path.join(BACKUP_DIR, "server.js"))) {
      fs.copyFileSync(path.join(BACKUP_DIR, "server.js"), SERVER_FILE);
      console.error("Restored backup server.js.");
    }
  } catch (restoreErr) {
    console.error("Backup restore failed:", restoreErr.message);
  }

  process.exit(1);
}
