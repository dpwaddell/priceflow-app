const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const APP_ROOT = "/mnt/user/appdata/priceflow";
const SERVER_FILE = path.join(APP_ROOT, "app", "server.js");
const BACKUP_DIR = path.join(
  APP_ROOT,
  "backups",
  `${new Date().toISOString().replace(/[:.]/g, "-")}_phase6_customer_search_page`
);

function log(msg) {
  process.stdout.write(msg + "\n");
}

function run(cmd, opts = {}) {
  log(`$ ${cmd}`);
  return execSync(cmd, {
    cwd: APP_ROOT,
    env: process.env,
    shell: "/bin/bash",
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

function replaceOnce(txt, find, replace, label) {
  if (!txt.includes(find)) {
    fail(`Could not find expected block: ${label}`);
  }
  return txt.replace(find, replace);
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
    fail('Could not find GET /customer-assignments route');
  }

  if (!txt.includes('app.get("/health", async (req, res) => {')) {
    fail('Could not find /health route marker');
  }

  if (!txt.includes('app.get("/", async (req, res) => {')) {
    fail('Could not find root route marker');
  }

  if (!txt.includes("async function shopifyAdminGraphQL(")) {
    const helperInsertion = `

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
}
`;

    txt = replaceOnce(
      txt,
      'app.use(express.urlencoded({ extended: true }));',
      'app.use(express.urlencoded({ extended: true }));' + helperInsertion,
      "insert Shopify helper functions"
    );
  }

  if (!txt.includes('function renderCustomerSearchPage(')) {
    const searchRenderer = `
function renderCustomerSearchPage({ shop, host, apiKey, query = "", customers = [], error = "" }) {
  const searchValue = escapeHtml(query || "");
  const resultsHtml = error
    ? \`<div class="empty">Search failed: \${escapeHtml(error)}</div>\`
    : customers.length === 0 && query
      ? \`<div class="empty">No Shopify customers found for that search.</div>\`
      : customers.map((customer) => {
          const subtitle = [customer.email || "", customer.phone || ""].filter(Boolean).join(" · ");
          const tags = Array.isArray(customer.tags) && customer.tags.length ? customer.tags.join(", ") : "No tags";
          const backUrl =
            getEmbeddedAppUrl(shop, host, "/customer-assignments") +
            "&use_email=" + encodeURIComponent(customer.email || "") +
            "&use_id=" + encodeURIComponent(customer.short_id || "");
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
                  <a class="btn small" href="\${backUrl}">Use customer</a>
                </div>
              </div>
            </div>
          \`;
        }).join("");

  const content = \`
    <div class="topbar">
      <div>
        <h1>Search Shopify customers</h1>
        <div class="sub">
          Find an existing Shopify customer, then send their email and Shopify customer ID back into the assignment form.
        </div>
      </div>
      <div class="shop-meta">
        <span class="pill">Shop: \${escapeHtml(shop)}</span>
      </div>
    </div>

    \${renderNav(shop, host, "assignments")}

    <div class="grid">
      <div class="stack">
        <div class="card">
          <h2>Customer search</h2>
          <form method="get" action="/customer-search">
            <input type="hidden" name="shop" value="\${escapeHtml(shop)}" />
            \${host ? \`<input type="hidden" name="host" value="\${escapeHtml(host)}" />\` : ""}
            <div class="form-grid">
              <div class="field full">
                <label for="q">Search by email or name</label>
                <input id="q" name="q" value="\${searchValue}" placeholder="e.g. buyer@example.com or Dan Waddell" />
              </div>
            </div>
            <div class="actions">
              <button class="btn primary" type="submit">Search customers</button>
              <button type="button" class="btn" onclick="window.location.href='\${getEmbeddedAppUrl(shop, host, "/customer-assignments")}';">Back to assignments</button>
            </div>
          </form>
        </div>

        \${resultsHtml ? \`<div class="stack">\${resultsHtml}</div>\` : ""}
      </div>

      <div class="stack">
        <div class="card">
          <h2>How it works</h2>
          <div class="list">
            <div class="list-row"><div>Search Shopify</div><div class="muted">Live customer lookup</div></div>
            <div class="list-row"><div>Use customer</div><div class="muted">Prefills assignment form</div></div>
            <div class="list-row"><div>Email + ID</div><div class="muted">Stored with assignment</div></div>
          </div>
        </div>
      </div>
    </div>
  \`;

  return renderLayout({ shop, host, apiKey, title: "PriceFlow | Search Shopify customers", content });
}
`;

    txt = replaceOnce(
      txt,
      'app.get("/health", async (req, res) => {',
      searchRenderer + '\napp.get("/health", async (req, res) => {',
      "insert renderCustomerSearchPage"
    );
  }

  if (!txt.includes('app.get("/api/customer-search", async (req, res) => {')) {
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

app.get("/customer-search", async (req, res) => {
  try {
    const shop = sanitizeShop(req.query.shop);
    const host = String(req.query.host || "");
    const q = String(req.query.q || "").trim();

    if (!shop) {
      return res.status(400).send("Missing or invalid shop.");
    }

    let customers = [];
    let error = "";

    if (q) {
      try {
        customers = await searchShopifyCustomers(shop, q);
      } catch (err) {
        error = err.message;
      }
    }

    return res.send(renderCustomerSearchPage({
      shop,
      host,
      apiKey: process.env.SHOPIFY_API_KEY || "",
      query: q,
      customers,
      error
    }));
  } catch (e) {
    return res.status(500).send(\`Customer search load failed: \${escapeHtml(e.message)}\`);
  }
});

`;

    txt = replaceOnce(
      txt,
      'app.get("/customer-assignments", async (req, res) => {',
      apiRoute + 'app.get("/customer-assignments", async (req, res) => {',
      "insert customer-search routes"
    );
  }

  txt = replaceOnce(
    txt,
    `<h2>Assign customer to tier</h2>`,
    `<h2>Assign customer to tier</h2>
          <div class="actions" style="margin-bottom:12px;">
            <button type="button" class="btn" onclick="window.location.href='${'${getEmbeddedAppUrl(shop, host, "/customer-search")}'}';">Search Shopify customers</button>
          </div>`,
    "add search button to assignments page"
  );

  txt = replaceOnce(
    txt,
    `const host = String(req.query.host || "");`,
    `const host = String(req.query.host || "");
    const useEmail = String(req.query.use_email || "").trim();
    const useId = String(req.query.use_id || "").trim();`,
    "capture prefill params on assignments route"
  );

  txt = replaceOnce(
    txt,
    `      assignments
    }));`,
    `      assignments,
      prefillEmail: useEmail,
      prefillId: useId
    }));`,
    "pass prefills into assignments renderer"
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
  run(`grep -n "shopifyAdminGraphQL\\|searchShopifyCustomers\\|customer-search\\|Search Shopify customers" ${SERVER_FILE}`, {
    stdio: "inherit"
  });

  log("");
  log("Checkpointing to git...");
  try {
    runPrint("git add app/server.js");
    execSync('git commit -m "Add Shopify customer search page for assignments"', {
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
  log("Open Customer assignments in Shopify admin, click 'Search Shopify customers', search, then click 'Use customer'.");
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
