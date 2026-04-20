const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const APP_ROOT = "/mnt/user/appdata/priceflow";
const ENV_FILE = path.join(APP_ROOT, ".env");
const COMPOSE_FILE = path.join(APP_ROOT, "docker-compose.yml");
const SERVER_FILE = path.join(APP_ROOT, "app", "server.js");
const BACKUP_DIR = path.join(
  APP_ROOT,
  "backups",
  `${new Date().toISOString().replace(/[:.]/g, "-")}_repair_priceguard_startup`
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

function runPrint(cmd) {
  log(`$ ${cmd}`);
  execSync(cmd, {
    cwd: APP_ROOT,
    env: process.env,
    shell: "/bin/bash",
    stdio: "inherit",
  });
}

function tryCapture(cmd) {
  try {
    log(`$ ${cmd}`);
    return execSync(cmd, {
      cwd: APP_ROOT,
      env: process.env,
      shell: "/bin/bash",
      stdio: "pipe",
    }).toString();
  } catch (err) {
    return String(err.stdout || "") + String(err.stderr || "") || err.message;
  }
}

function backup(file) {
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, path.join(BACKUP_DIR, path.basename(file)));
  }
}

function parseComposeForDbService(compose) {
  const serviceRegex = /^([A-Za-z0-9_-]+):\s*$/gm;
  const lines = compose.split(/\r?\n/);

  let currentService = null;
  let currentIndent = null;
  const services = {};

  for (const line of lines) {
    const indent = line.match(/^(\s*)/)[1].length;
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) continue;

    const m = line.match(/^(\s*)([A-Za-z0-9_-]+):\s*$/);
    if (m) {
      const name = m[2];
      if (indent === 2) {
        currentService = name;
        currentIndent = indent;
        services[currentService] = services[currentService] || [];
        continue;
      }
    }

    if (currentService) {
      services[currentService].push(line);
    }
  }

  for (const [name, blockLines] of Object.entries(services)) {
    const block = blockLines.join("\n");
    if (
      /postgres/i.test(block) ||
      /POSTGRES_DB/i.test(block) ||
      /POSTGRES_USER/i.test(block) ||
      /5432/i.test(block)
    ) {
      return name;
    }
  }

  return null;
}

function parseContainerNameForDb(compose) {
  const match = compose.match(/container_name:\s*(priceguard-db|priceflow-db|[A-Za-z0-9._-]+)/);
  return match ? match[1] : null;
}

function updateDatabaseUrl(envText, mutator) {
  const m = envText.match(/^DATABASE_URL=(.*)$/m);
  if (!m) throw new Error("DATABASE_URL not found in .env");
  const original = m[1].trim();
  const url = new URL(original);
  mutator(url);
  return envText.replace(/^DATABASE_URL=.*/m, `DATABASE_URL=${url.toString()}`);
}

try {
  if (!fs.existsSync(ENV_FILE)) throw new Error(`Missing ${ENV_FILE}`);
  if (!fs.existsSync(COMPOSE_FILE)) throw new Error(`Missing ${COMPOSE_FILE}`);
  if (!fs.existsSync(SERVER_FILE)) throw new Error(`Missing ${SERVER_FILE}`);

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  backup(ENV_FILE);
  backup(COMPOSE_FILE);
  backup(SERVER_FILE);

  let envText = fs.readFileSync(ENV_FILE, "utf8");
  const composeText = fs.readFileSync(COMPOSE_FILE, "utf8");

  log("=== PRE-CHECK ===");
  log(tryCapture("docker ps -a --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}' | grep -E 'priceguard|priceflow' || true"));

  log("=== PRICEGUARD APP LOGS ===");
  let appLogs = tryCapture("docker logs --tail 200 priceguard-app || true");
  log(appLogs);

  log("=== PRICEGUARD DB LOGS ===");
  const dbLogs = tryCapture("docker logs --tail 120 priceguard-db || true");
  log(dbLogs);

  let changed = false;

  const dbService = parseComposeForDbService(composeText);
  const dbContainer = parseContainerNameForDb(composeText);

  log("=== COMPOSE DETECTION ===");
  log(`Detected DB service: ${dbService || "(none detected)"}`);
  log(`Detected DB container: ${dbContainer || "(none detected)"}`);

  // Keep branding visible, but keep old public hostname until DNS is moved
  if (/^APP_NAME=.*/m.test(envText)) {
    envText = envText.replace(/^APP_NAME=.*/m, "APP_NAME=PriceGuard");
    changed = true;
  }
  if (/^APP_URL=.*/m.test(envText)) {
    envText = envText.replace(/^APP_URL=.*/m, "APP_URL=https://priceflow.sample-guard.com");
    changed = true;
  }

  // Known DB/user/name fixes
  if (
    appLogs.includes('role "priceguard" does not exist') ||
    appLogs.includes("password authentication failed") ||
    appLogs.includes('database "priceguard_db" does not exist')
  ) {
    log("Applying DB username/database fallback to original values...");
    envText = updateDatabaseUrl(envText, (url) => {
      url.username = "priceflow";
      url.pathname = "/priceflow_db";
    });
    changed = true;
  }

  // Host resolution fix
  if (
    appLogs.includes("ENOTFOUND") ||
    appLogs.includes("getaddrinfo") ||
    appLogs.includes("ECONNREFUSED") ||
    !appLogs.includes("listening on 3100")
  ) {
    const chosenHost = dbService || dbContainer || "priceguard-db";
    log(`Applying DB hostname fallback to: ${chosenHost}`);
    envText = updateDatabaseUrl(envText, (url) => {
      url.hostname = chosenHost;
      url.port = "5432";
      if (!url.username || url.username === "priceguard") url.username = "priceflow";
      if (!url.pathname || url.pathname === "/priceguard_db") url.pathname = "/priceflow_db";
    });
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(ENV_FILE, envText);
  }

  log("=== CURRENT .ENV SNAPSHOT ===");
  const safeEnvLines = fs.readFileSync(ENV_FILE, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      if (line.startsWith("DATABASE_URL=")) return "DATABASE_URL=***redacted***";
      if (line.startsWith("SHOPIFY_API_SECRET=")) return "SHOPIFY_API_SECRET=***redacted***";
      return line;
    });
  log(safeEnvLines.join("\n"));

  log("");
  log("Syntax check...");
  run("node -c app/server.js", { stdio: "inherit" });

  log("");
  log("Restarting stack...");
  runPrint("docker compose down --remove-orphans");
  runPrint("docker compose up -d --remove-orphans");

  log("");
  log("Waiting for app...");
  execSync("sleep 10");

  log("");
  log("=== HEALTH ===");
  const health = tryCapture("curl -i --max-time 8 http://localhost:3100/health || true");
  log(health);

  log("=== POST-RESTART APP LOGS ===");
  appLogs = tryCapture("docker logs --tail 200 priceguard-app || true");
  log(appLogs);

  log("=== POST-RESTART CONTAINERS ===");
  log(tryCapture("docker ps -a --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}' | grep -E 'priceguard|priceflow' || true"));

  log("=== GIT STATUS ===");
  log(tryCapture("git status --short"));

  if (/200 OK/.test(health) || /"ok":true/.test(health)) {
    log("=== CHECKPOINTING ===");
    try {
      runPrint("git add .env docker-compose.yml");
      execSync('git commit -m "Repair PriceGuard runtime startup after rebrand"', {
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
    log("Done. PriceGuard is back up.");
  } else {
    log("");
    log("Startup is still failing.");
    log("Most useful lines are in the POST-RESTART APP LOGS above.");
  }
} catch (err) {
  console.error("");
  console.error("FAILED:", err.message);
  process.exit(1);
}
