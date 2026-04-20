const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const APP_ROOT = "/mnt/user/appdata/priceflow";
const SERVER_FILE = path.join(APP_ROOT, "app", "server.js");
const BACKUP_DIR = path.join(
  APP_ROOT,
  "backups",
  `${new Date().toISOString().replace(/[:.]/g, "-")}_phase6_hide_customer_search_v2`
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
    fail(`Missing server file: ${SERVER_FILE}`);
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

  const oldButton =
    `<button type="button" class="btn" onclick="window.location.href='${'${getEmbeddedAppUrl(shop, host, "/customer-search")}'}';">Search Shopify customers</button>`;

  const newMessage =
    `<div class="empty" style="margin-bottom:12px;">Shopify customer search will be enabled once protected customer data access is approved. For now, enter customer email and Shopify customer ID manually.</div>`;

  txt = replaceOnce(
    txt,
    oldButton,
    newMessage,
    "replace customer search button"
  );

  txt = txt.replace(
    /app\.get\("\/customer-search", async \(req, res\) => \{[\s\S]*?\n\}\);\n\n/g,
    ""
  );

  txt = txt.replace(
    /app\.get\("\/api\/customer-search", async \(req, res\) => \{[\s\S]*?\n\}\);\n\n/g,
    ""
  );

  txt = txt.replace(
    /function renderCustomerSearchPage\([\s\S]*?\n\}\n\n/g,
    ""
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
  log("Verification:");
  run(
    `grep -n 'protected customer data access is approved\\|customer-search\\|renderCustomerSearchPage\\|api/customer-search' ${SERVER_FILE} || true`,
    { stdio: "inherit" }
  );

  log("");
  log("Checkpointing to git...");
  try {
    runPrint("git add app/server.js");
    execSync(
      'git commit -m "Hide Shopify customer search until protected customer data is approved"',
      {
        cwd: APP_ROOT,
        env: process.env,
        shell: "/bin/bash",
        stdio: "inherit",
      }
    );
  } catch (err) {
    log("No commit created, continuing.");
  }

  runPrint("git push origin main");

  log("");
  log("Done.");
  log("Customer assignments should now show a manual-entry message instead of the blocked search flow.");
} catch (err) {
  console.error("");
  console.error("FAILED:", err.message);

  try {
    const backupServer = path.join(BACKUP_DIR, "server.js");
    if (fs.existsSync(backupServer)) {
      fs.copyFileSync(backupServer, SERVER_FILE);
      console.error("Restored backup server.js.");
    }
  } catch (restoreErr) {
    console.error("Backup restore failed:", restoreErr.message);
  }

  process.exit(1);
}
