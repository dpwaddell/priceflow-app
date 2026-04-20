const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const APP_ROOT = "/mnt/user/appdata/priceflow";
const SERVER_FILE = path.join(APP_ROOT, "app", "server.js");
const BACKUP_DIR = path.join(
  APP_ROOT,
  "backups",
  `${new Date().toISOString().replace(/[:.]/g, "-")}_phase6_customer_lookup_v2`
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

function replaceOnceOrThrow(source, find, replace, label) {
  if (!source.includes(find)) {
    throw new Error(`Could not find expected block for: ${label}`);
  }
  return source.replace(find, replace);
}

try {
  if (!fs.existsSync(SERVER_FILE)) {
    throw new Error(`server.js not found at ${SERVER_FILE}`);
  }

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

  if (!txt.includes('app.use(express.urlencoded({ extended: true }));')) {
    throw new Error("Could not find express middleware block");
  }

  if (!txt.includes('app.get("/customer-assignments", async (req, res) => {')) {
    throw new Error("Could not find customer assignments route");
  }

  if (!txt.includes('function renderCustomerAssignmentsPage(')) {
    throw new Error("Could not find renderCustomerAssignmentsPage");
  }

  if (!txt.includes('id="customer_email"')) {
    throw new Error("Could not find customer assignment form email field");
  }

  if (!txt.includes('id="shopify_customer_id"')) {
    throw new Error("Could not find customer assignment form Shopify ID field");
  }

  if (!txt.includes("shopifyAdminGraphQL(")) {
    const helperFind = `app.use(express.json());
app.use(express.urlencoded({ extended: true }));`;

    const helperReplace = `app.use(express.json());
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

  const queries = [cleaned, \`email:\${cleaned}\`, \`name:\${cleaned}\`];
  const dedupe = new Map();

  for (const q of queries) {
    const data = await shopifyAdminGraphQL(shop.shop_domain, shop.access_token, gql, { query: q });
    const edges = (((data || {}).customers || {}).edges || []);
    for (const edge of edges) {
      const node = edge && edge.node ? edge.node : null;
      if (!node || !node.id) continue;
      const shortId = String(node.id).split("/").pop();
      dedupe.set(node.id, {
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

  return Array.from(dedupe.values());
}`;

    txt = replaceOnceOrThrow(txt, helperFind, helperReplace, "insert Shopify search helpers");
  }

  if (!txt.includes('app.get("/api/customer-search", async (req, res) => {')) {
    const apiInsertFind = `app.get("/customer-assignments", async (req, res) => {`;

    const apiInsertReplace = `app.get("/api/customer-search", async (req, res) => {
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

app.get("/customer-assignments", async (req, res) => {`;

    txt = replaceOnceOrThrow(txt, apiInsertFind, apiInsertReplace, "insert customer search API route");
  }

  if (!txt.includes('id="customer_lookup_btn"')) {
    const cardFind = `<div class="card">
          <h2>Create customer assignment</h2>`;

    const searchCard = `<div class="card">
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
          <h2>Create customer assignment</h2>`;

    txt = replaceOnceOrThrow(txt, cardFind, searchCard, "insert search card");
  }

  if (!txt.includes("customer_lookup_results")) {
    throw new Error("Search card insertion failed");
  }

  if (!txt.includes("Search customers")) {
    throw new Error("Search UI not present after patch");
  }

  if (!txt.includes("customer_lookup_btn")) {
    throw new Error("Search button not present after patch");
  }

  if (!txt.includes("Use customer")) {
    const scriptFind = `</script>
  \`;

  return renderLayout({ shop, host, apiKey, title: "PriceFlow | Customer assignments", content });
}`;

    const scriptReplace = `  <script>
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
            const res = await fetch("/api/customer-search?shop=" + encodeURIComponent(${JSON.stringify("SHOP_PLACEHOLDER")}).replace("SHOP_PLACEHOLDER", shop) + "&q=" + encodeURIComponent(term));
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
  \`;

  return renderLayout({ shop, host, apiKey, title: "PriceFlow | Customer assignments", content });
}`;

    txt = replaceOnceOrThrow(txt, scriptFind, scriptReplace, "insert customer search script");
  }

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
  run(`grep -n 'api/customer-search\\|searchShopifyCustomers\\|customer_lookup_btn\\|Find Shopify customer' ${SERVER_FILE}`);
  log("");
  log("Done.");
  log("Open Customer assignments in the browser and test searching.");
} catch (err) {
  console.error("");
  console.error("FAILED:", err.message);
  process.exit(1);
}
