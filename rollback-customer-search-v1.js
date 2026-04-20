const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const APP_ROOT = "/mnt/user/appdata/priceflow";
const SERVER_FILE = path.join(APP_ROOT, "app", "server.js");
const BACKUPS_DIR = path.join(APP_ROOT, "backups");

function log(msg) {
  process.stdout.write(msg + "\n");
}

function run(cmd, opts = {}) {
  log(`$ ${cmd}`);
  return execSync(cmd, {
    cwd: APP_ROOT,
    stdio: "pipe",
    env: process.env,
    ...opts,
  }).toString();
}

function runPrint(cmd) {
  log(`$ ${cmd}`);
  execSync(cmd, {
    cwd: APP_ROOT,
    stdio: "inherit",
    env: process.env,
  });
}

function findLatestWorkingBackup() {
  if (!fs.existsSync(BACKUPS_DIR)) {
    throw new Error("Backups directory not found.");
  }

  const dirs = fs
    .readdirSync(BACKUPS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) =>
      name.includes("phase5") ||
      name.includes("embedded_nav_fix") ||
      name.includes("customer_assignments") ||
      name.includes("pricing_tiers")
    )
    .sort()
    .reverse();

  for (const dir of dirs) {
    const candidate = path.join(BACKUPS_DIR, dir, "server.js");
    const candidateAlt = path.join(BACKUPS_DIR, dir, "app", "server.js");
    if (fs.existsSync(candidateAlt)) return candidateAlt;
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error("No suitable backup server.js found.");
}

try {
  log("=== CURRENT APP STATUS ===");
  try {
    const syntax = run("node -c app/server.js");
    if (syntax.trim()) log(syntax.trim());
    log("server.js syntax check passed.");
  } catch (err) {
    log("server.js syntax check failed.");
  }

  try {
    const logs = run("docker logs --tail 120 priceflow-app");
    log("\n=== priceflow-app logs ===");
    log(logs || "(no logs)");
  } catch (err) {
    log("\n=== priceflow-app logs ===");
    log("(could not read container logs)");
  }

  const backupFile = findLatestWorkingBackup();
  log(`\nRestoring backup from: ${backupFile}`);

  fs.copyFileSync(SERVER_FILE, SERVER_FILE + `.failed.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`);
  fs.copyFileSync(backupFile, SERVER_FILE);

  log("\n=== RESTARTING STACK ===");
  runPrint("docker compose down");
  runPrint("docker compose up -d");

  log("\nWaiting for app...");
  execSync("sleep 8");

  log("\n=== HEALTH CHECK ===");
  try {
    const health = run("curl -s http://localhost:3100/health");
    log(health || "(empty response)");
  } catch (err) {
    log("Health check still failed.");
  }

  log("\n=== FINAL LOGS ===");
  try {
    const logs = run("docker logs --tail 80 priceflow-app");
    log(logs || "(no logs)");
  } catch (err) {
    log("(could not read final logs)");
  }

  log("\n=== GIT STATUS ===");
  try {
    const status = run("git status --short");
    log(status || "(clean)");
  } catch (err) {
    log("(git status unavailable)");
  }

  log("\nRollback complete.");
  log("Now reopen PriceFlow and confirm dashboard + customer assignments are back to the last working version.");
} catch (err) {
  console.error("\nFAILED:", err.message);
  process.exit(1);
}
