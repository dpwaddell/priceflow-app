const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const APP_ROOT = "/mnt/user/appdata/priceflow";
const ENV_FILE = path.join(APP_ROOT, ".env");
const COMPOSE_FILE = path.join(APP_ROOT, "docker-compose.yml");
const BACKUPS_DIR = path.join(APP_ROOT, "backups");

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

function fail(msg) {
  throw new Error(msg);
}

function readIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

function findLatestBackupFiles() {
  if (!fs.existsSync(BACKUPS_DIR)) {
    fail("Backups directory not found.");
  }

  const dirs = fs.readdirSync(BACKUPS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort()
    .reverse();

  for (const dir of dirs) {
    const full = path.join(BACKUPS_DIR, dir);
    const env = path.join(full, ".env");
    const compose = path.join(full, "docker-compose.yml");
    const server = path.join(full, "server.js");
    const appServer = path.join(full, "app", "server.js");

    if (fs.existsSync(env) || fs.existsSync(compose) || fs.existsSync(server) || fs.existsSync(appServer)) {
      return {
        dir: full,
        env: fs.existsSync(env) ? env : null,
        compose: fs.existsSync(compose) ? compose : null,
      };
    }
  }

  fail("No usable backup files found.");
}

function extractDatabaseUrl(text) {
  if (!text) return null;
  const m = text.match(/^DATABASE_URL=(.*)$/m);
  return m ? m[1].trim() : null;
}

function extractPostgresPassword(text) {
  if (!text) return null;

  let m = text.match(/POSTGRES_PASSWORD:\s*([^\s#]+)/);
  if (m) return m[1].trim().replace(/^['"]|['"]$/g, "");

  m = text.match(/POSTGRES_PASSWORD=([^\s#]+)/);
  if (m) return m[1].trim().replace(/^['"]|['"]$/g, "");

  return null;
}

function updateEnvDatabaseUrl(envText, password) {
  const m = envText.match(/^DATABASE_URL=(.*)$/m);
  if (!m) fail("DATABASE_URL not found in current .env");

  const url = new URL(m[1].trim());
  url.hostname = "priceguard-db";
  url.port = "5432";
  url.username = "priceflow";
  url.password = password;
  url.pathname = "/priceflow_db";

  return envText.replace(/^DATABASE_URL=.*/m, `DATABASE_URL=${url.toString()}`);
}

function replaceComposePassword(composeText, password) {
  let updated = composeText;

  if (/POSTGRES_PASSWORD:\s*[^\s#]+/.test(updated)) {
    updated = updated.replace(/POSTGRES_PASSWORD:\s*[^\s#]+/g, `POSTGRES_PASSWORD: ${password}`);
  }

  if (/POSTGRES_PASSWORD=[^\s#]+/.test(updated)) {
    updated = updated.replace(/POSTGRES_PASSWORD=[^\s#]+/g, `POSTGRES_PASSWORD=${password}`);
  }

  return updated;
}

try {
  if (!fs.existsSync(ENV_FILE)) fail(`Missing ${ENV_FILE}`);
  if (!fs.existsSync(COMPOSE_FILE)) fail(`Missing ${COMPOSE_FILE}`);

  const backup = findLatestBackupFiles();

  log(`Using backup directory: ${backup.dir}`);

  const backupEnvText = backup.env ? fs.readFileSync(backup.env, "utf8") : "";
  const backupComposeText = backup.compose ? fs.readFileSync(backup.compose, "utf8") : "";

  const backupDbUrl = extractDatabaseUrl(backupEnvText);
  const backupPasswordFromEnv = backupDbUrl ? new URL(backupDbUrl).password : null;
  const backupPasswordFromCompose = extractPostgresPassword(backupComposeText);

  const oldPassword = backupPasswordFromEnv || backupPasswordFromCompose;

  if (!oldPassword) {
    fail("Could not recover the original DB password from backup .env or docker-compose.yml");
  }

  log(`Recovered original DB password from backup: ${"*".repeat(Math.max(8, oldPassword.length))}`);

  let envText = fs.readFileSync(ENV_FILE, "utf8");
  let composeText = fs.readFileSync(COMPOSE_FILE, "utf8");

  // Keep branding
  envText = envText.replace(/^APP_NAME=.*/m, "APP_NAME=PriceGuard");
  envText = envText.replace(/^APP_URL=.*/m, "APP_URL=https://priceflow.sample-guard.com");

  // Restore working DB URL runtime values
  envText = updateEnvDatabaseUrl(envText, oldPassword);

  // Restore compose DB credentials while keeping priceguard service names
  composeText = composeText.replace(/POSTGRES_USER:\s*priceguard/g, "POSTGRES_USER: priceflow");
  composeText = composeText.replace(/POSTGRES_DB:\s*priceguard_db/g, "POSTGRES_DB: priceflow_db");
  composeText = composeText.replace(/POSTGRES_USER=priceguard/g, "POSTGRES_USER=priceflow");
  composeText = composeText.replace(/POSTGRES_DB=priceguard_db/g, "POSTGRES_DB=priceflow_db");
  composeText = replaceComposePassword(composeText, oldPassword);

  fs.writeFileSync(ENV_FILE, envText);
  fs.writeFileSync(COMPOSE_FILE, composeText);

  log("");
  log("Restarting stack...");
  runPrint("docker compose down --remove-orphans");
  runPrint("docker compose up -d --remove-orphans");

  log("");
  log("Waiting for app...");
  execSync("sleep 10");

  log("");
  log("Health:");
  run("curl -i --max-time 8 http://localhost:3100/health", { stdio: "inherit" });

  log("");
  log("App logs:");
  run("docker logs --tail 120 priceguard-app || true", { stdio: "inherit" });

  log("");
  log("Container status:");
  run("docker ps -a --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}' | grep -E 'priceguard|priceflow' || true", { stdio: "inherit" });

  log("");
  log("Checkpointing to git...");
  try {
    runPrint("git add .env docker-compose.yml");
    execSync('git commit -m "Restore original DB password after PriceGuard rebrand"', {
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
  log("Expected result: PriceGuard branding stays, but runtime DB password is restored to the original working value.");
} catch (err) {
  console.error("");
  console.error("FAILED:", err.message);
  process.exit(1);
}
