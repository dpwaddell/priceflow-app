const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const APP_ROOT = "/mnt/user/appdata/priceflow";
const SERVER_FILE = path.join(APP_ROOT, "app", "server.js");
const BACKUP_DIR = path.join(
  APP_ROOT,
  "backups",
  `${new Date().toISOString().replace(/[:.]/g, "-")}_phase6_customer_search_message_and_anonymise`
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
    shell: "/bin/bash",
    stdio: "inherit",
  });
}

function fail(msg) {
  throw new Error(msg);
}

function replaceAllOrKeep(txt, find, replace) {
  return txt.split(find).join(replace);
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

  if (!txt.includes("searchShopifyCustomers")) {
    fail("Could not find searchShopifyCustomers in server.js");
  }

  if (!txt.includes("renderCustomerSearchPage")) {
    fail("Could not find renderCustomerSearchPage in server.js");
  }

  if (!txt.includes('app.get("/customer-search"')) {
    fail('Could not find /customer-search route in server.js');
  }

  // 1) Make Shopify customer search fail with a clean message instead of raw GraphQL dump
  const oldGraphQlErrorBlock = `  if (json.errors && json.errors.length) {
    throw new Error(\`Shopify GraphQL errors: \${JSON.stringify(json.errors)}\`);
  }`;

  const newGraphQlErrorBlock = `  if (json.errors && json.errors.length) {
    const raw = JSON.stringify(json.errors);
    if (raw.includes("ACCESS_DENIED") || raw.includes("protected-customer-data") || raw.includes("Customer object")) {
      throw new Error("Customer search is unavailable until this app is approved for Shopify protected customer data. You can still create assignments manually for now.");
    }
    throw new Error("Shopify customer search failed. Please try again.");
  }`;

  if (txt.includes(oldGraphQlErrorBlock)) {
    txt = txt.replace(oldGraphQlErrorBlock, newGraphQlErrorBlock);
  }

  // 2) Also catch non-200 responses more cleanly
  const oldNon200 = `  if (!response.ok) {
    throw new Error(\`Shopify GraphQL request failed: \${response.status}\`);
  }`;

  const newNon200 = `  if (!response.ok) {
    throw new Error("Shopify customer search request failed. Please try again.");
  }`;

  if (txt.includes(oldNon200)) {
    txt = txt.replace(oldNon200, newNon200);
  }

  // 3) Improve help copy on customer search page
  txt = replaceAllOrKeep(
    txt,
    "Find an existing Shopify customer, then send their email and Shopify customer ID back into the assignment form.",
    "Find an existing Shopify customer, then send their email and Shopify customer ID back into the assignment form. If customer search is not yet approved by Shopify, create assignments manually for now."
  );

  txt = replaceAllOrKeep(
    txt,
    "Search by email or name. Selecting a result will fill the assignment form automatically.",
    "Search by email or name. Selecting a result will fill the assignment form automatically. If Shopify protected customer data is not approved yet, use manual entry instead."
  );

  // 4) Improve empty/error card wording
  txt = replaceAllOrKeep(
    txt,
    'Search failed: ${escapeHtml(error)}',
    'Search unavailable: ${escapeHtml(error)}'
  );

  // 5) Replace any visible sample/demo name
  txt = replaceAllOrKeep(txt, "Dan Waddell", "John Smith");
  txt = replaceAllOrKeep(txt, "dan waddell", "john smith");

  // 6) Replace common sample email if present
  txt = replaceAllOrKeep(txt, "dan@example.com", "john@example.com");
  txt = replaceAllOrKeep(txt, "dan.waddell@example.com", "john.smith@example.com");

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
  log("Checkpointing to git...");
  try {
    runPrint("git add app/server.js");
    execSync('git commit -m "Handle Shopify customer search access denial and anonymise sample names"', {
      cwd: APP_ROOT,
      env: process.env,
      shell: "/bin/bash",
      stdio: "inherit",
    });
  } catch (err) {
    log("No commit created, continuing.");
  }

  runPrint("git push origin main");

  log("");
  log("Done.");
  log("Result:");
  log("- Raw Shopify GraphQL access errors are now replaced with a friendly message.");
  log("- Visible sample/help name text is changed from Dan Waddell to John Smith where present.");
  log("");
  log("Important:");
  log("To make customer search actually work, you still need Shopify protected customer data approval for this app.");
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
