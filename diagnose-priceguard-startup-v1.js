const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const APP_ROOT = "/mnt/user/appdata/priceflow";
const SERVER_FILE = path.join(APP_ROOT, "app", "server.js");
const COMPOSE_FILE = path.join(APP_ROOT, "docker-compose.yml");
const ENV_FILE = path.join(APP_ROOT, ".env");
const BACKUP_DIR = path.join(
  APP_ROOT,
  "backups",
  `${new Date().toISOString().replace(/[:.]/g, "-")}_diagnose_priceguard_startup`
);

function log(msg = "") {
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

function runCapture(cmd) {
  log(`$ ${cmd}`);
  return execSync(cmd, {
    cwd: APP_ROOT,
    env: process.env,
    shell: "/bin/bash",
    stdio: "pipe",
  }).toString();
}

function tryCapture(cmd) {
  try {
    return runCapture(cmd);
  } catch (err) {
    return `COMMAND FAILED: ${cmd}\n${err.message}\n`;
  }
}

try {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  [SERVER_FILE, COMPOSE_FILE, ENV_FILE].forEach((file) => {
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, path.join(BACKUP_DIR, path.basename(file)));
    }
  });

  log("=== CURRENT CONTAINERS ===");
  log(tryCapture(`docker ps -a --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}' | grep -E 'priceguard|priceflow' || true`));

  log("=== APP LOGS ===");
  log(tryCapture("docker logs --tail 120 priceguard-app"));

  log("=== DB LOGS ===");
  log(tryCapture("docker logs --tail 80 priceguard-db"));

  log("=== PORT CHECK ===");
  log(tryCapture("ss -ltnp | grep ':3100\\|:5434' || true"));

  log("=== ENV SNAPSHOT ===");
  if (fs.existsSync(ENV_FILE)) {
    const envText = fs.readFileSync(ENV_FILE, "utf8");
    const lines = envText
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        if (/DATABASE_URL=/.test(line)) return "DATABASE_URL=***redacted***";
        if (/SHOPIFY_API_SECRET=/.test(line)) return "SHOPIFY_API_SECRET=***redacted***";
        if (/SHOPIFY_API_KEY=/.test(line)) return line;
        if (/APP_URL=/.test(line)) return line;
        if (/APP_NAME=/.test(line)) return line;
        return line;
      });
    log(lines.join("\n"));
  } else {
    log("No .env found");
  }

  log("=== QUICK HEALTH TESTS ===");
  log(tryCapture("curl -i --max-time 5 http://localhost:3100/health || true"));

  let appLogs = "";
  try {
    appLogs = execSync("docker logs --tail 200 priceguard-app", {
      cwd: APP_ROOT,
      env: process.env,
      shell: "/bin/bash",
      stdio: "pipe",
    }).toString();
  } catch (err) {
    appLogs = String(err.stdout || "") + "\n" + String(err.stderr || "");
  }

  const likelyEnvIssue =
    appLogs.includes("ENOTFOUND") ||
    appLogs.includes("ECONNREFUSED") ||
    appLogs.includes("DATABASE_URL") ||
    appLogs.includes("password authentication failed") ||
    appLogs.includes("getaddrinfo") ||
    appLogs.includes("Cannot find module") ||
    appLogs.includes("SyntaxError");

  if (likelyEnvIssue) {
    log("=== AUTO-FIX: reverting runtime-only host/app-name values in .env ===");
    if (!fs.existsSync(ENV_FILE)) {
      throw new Error("Cannot auto-fix .env because it does not exist.");
    }

    let envText = fs.readFileSync(ENV_FILE, "utf8");
    envText = envText.replace(/APP_URL=https:\/\/priceguard\.sample-guard\.com/g, "APP_URL=https://priceflow.sample-guard.com");
    envText = envText.replace(/APP_NAME=PriceGuard/g, "APP_NAME=PriceFlow");
    fs.writeFileSync(ENV_FILE, envText);

    log("Restarting stack after .env runtime revert...");
    run("docker compose down --remove-orphans", { stdio: "inherit" });
    run("docker compose up -d --remove-orphans", { stdio: "inherit" });

    log("Waiting for app...");
    execSync("sleep 8");

    log("=== HEALTH AFTER AUTO-FIX ===");
    log(tryCapture("curl -i --max-time 5 http://localhost:3100/health || true"));

    log("=== APP LOGS AFTER AUTO-FIX ===");
    log(tryCapture("docker logs --tail 120 priceguard-app"));
  }

  log("=== GIT STATUS ===");
  log(tryCapture("git status --short"));

  log("Done.");
  log("If health is back, keep the visible branding as PriceGuard for now and leave APP_URL on the old hostname until DNS/Shopify are updated.");
} catch (err) {
  console.error("");
  console.error("FAILED:", err.message);
  process.exit(1);
}
