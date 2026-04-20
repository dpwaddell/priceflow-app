const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const APP_ROOT = "/mnt/user/appdata/priceflow";
const SERVER_FILE = path.join(APP_ROOT, "app", "server.js");
const COMPOSE_FILE = path.join(APP_ROOT, "docker-compose.yml");
const ENV_FILE = path.join(APP_ROOT, ".env");

function log(msg) {
  process.stdout.write(msg + "\n");
}

function run(cmd, opts = {}) {
  log(`$ ${cmd}`);
  return execSync(cmd, {
    cwd: APP_ROOT,
    env: process.env,
    shell: "/bin/bash",
    stdio: "inherit",
    ...opts,
  });
}

function runQuiet(cmd) {
  try {
    execSync(cmd, {
      cwd: APP_ROOT,
      env: process.env,
      shell: "/bin/bash",
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

try {
  if (!fs.existsSync(SERVER_FILE)) throw new Error(`Missing ${SERVER_FILE}`);
  if (!fs.existsSync(COMPOSE_FILE)) throw new Error(`Missing ${COMPOSE_FILE}`);
  if (!fs.existsSync(ENV_FILE)) throw new Error(`Missing ${ENV_FILE}`);

  log("Verifying rebrand files...");
  const server = fs.readFileSync(SERVER_FILE, "utf8");
  const compose = fs.readFileSync(COMPOSE_FILE, "utf8");
  const env = fs.readFileSync(ENV_FILE, "utf8");

  if (!server.includes("PriceGuard")) {
    throw new Error("server.js does not appear to be rebranded to PriceGuard.");
  }
  if (!compose.includes("priceguard-app") || !compose.includes("priceguard-db")) {
    throw new Error("docker-compose.yml does not appear to contain priceguard service/container names.");
  }
  if (!env.includes("PriceGuard") && !env.includes("priceguard")) {
    log("Warning: .env does not obviously contain PriceGuard text, continuing anyway.");
  }

  log("");
  log("Stopping current compose stack...");
  run("docker compose down --remove-orphans || true");

  log("");
  log("Removing old PriceFlow containers if they still exist...");
  run("docker rm -f priceflow-app priceflow-db 2>/dev/null || true");

  log("");
  log("Cleaning any orphaned PriceGuard containers from failed start...");
  run("docker rm -f priceguard-app priceguard-db 2>/dev/null || true");

  log("");
  log("Starting rebranded stack...");
  run("docker compose up -d --remove-orphans");

  log("");
  log("Waiting for app...");
  execSync("sleep 8");

  log("");
  log("Health check...");
  run("curl -s http://localhost:3100/health");

  log("");
  log("Container check...");
  run("docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -E 'priceguard|priceflow' || true");

  log("");
  log("Git checkpoint...");
  try {
    run("git add app/server.js docker-compose.yml .env");
    run(`git commit -m "Fix PriceGuard rebrand container conflict" || true`);
  } catch {
    log("No commit created, continuing.");
  }

  run("git push origin main");

  log("");
  log("Done.");
  log("Your stack should now be running as PriceGuard.");
} catch (err) {
  console.error("");
  console.error("FAILED:", err.message);
  process.exit(1);
}
