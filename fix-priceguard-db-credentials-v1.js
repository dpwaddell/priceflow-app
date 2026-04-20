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
  `${new Date().toISOString().replace(/[:.]/g, "-")}_fix_priceguard_db_credentials`
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

function backup(file) {
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, path.join(BACKUP_DIR, path.basename(file)));
  }
}

try {
  if (!fs.existsSync(ENV_FILE)) fail(`Missing ${ENV_FILE}`);
  if (!fs.existsSync(COMPOSE_FILE)) fail(`Missing ${COMPOSE_FILE}`);
  if (!fs.existsSync(SERVER_FILE)) fail(`Missing ${SERVER_FILE}`);

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  backup(ENV_FILE);
  backup(COMPOSE_FILE);
  backup(SERVER_FILE);

  let env = fs.readFileSync(ENV_FILE, "utf8");
  let compose = fs.readFileSync(COMPOSE_FILE, "utf8");

  //
  // Keep visible branding as PriceGuard
  //
  env = env.replace(/^APP_NAME=.*/m, "APP_NAME=PriceGuard");

  //
  // Keep old live hostname until DNS/Shopify is updated
  //
  env = env.replace(/^APP_URL=.*/m, "APP_URL=https://priceflow.sample-guard.com");

  //
  // Fix DATABASE_URL:
  // - host should be priceguard-db (new service/container name)
  // - username should remain priceflow
  // - db name should remain priceflow_db
  //
  const dbMatch = env.match(/^DATABASE_URL=(.*)$/m);
  if (!dbMatch) {
    fail("Could not find DATABASE_URL in .env");
  }

  const rawDbUrl = dbMatch[1].trim();
  let parsed;
  try {
    parsed = new URL(rawDbUrl);
  } catch (err) {
    fail(`DATABASE_URL is not a valid URL: ${rawDbUrl}`);
  }

  parsed.hostname = "priceguard-db";
  parsed.port = "5432";
  parsed.username = "priceflow";
  parsed.pathname = "/priceflow_db";

  const fixedDbUrl = parsed.toString();
  env = env.replace(/^DATABASE_URL=.*/m, `DATABASE_URL=${fixedDbUrl}`);

  //
  // Fix docker-compose DB env values if they were renamed
  //
  compose = compose.replace(/POSTGRES_USER:\s*priceguard/g, "POSTGRES_USER: priceflow");
  compose = compose.replace(/POSTGRES_DB:\s*priceguard_db/g, "POSTGRES_DB: priceflow_db");
  compose = compose.replace(/POSTGRES_USER=priceguard/g, "POSTGRES_USER=priceflow");
  compose = compose.replace(/POSTGRES_DB=priceguard_db/g, "POSTGRES_DB=priceflow_db");

  //
  // Keep service/container names as priceguard
  //
  if (!compose.includes("priceguard-app") || !compose.includes("priceguard-db")) {
    log("Warning: docker-compose does not obviously contain priceguard service names, continuing anyway.");
  }

  fs.writeFileSync(ENV_FILE, env);
  fs.writeFileSync(COMPOSE_FILE, compose);

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
  log("Health:");
  run("curl -i --max-time 8 http://localhost:3100/health", { stdio: "inherit" });

  log("");
  log("Container status:");
  run("docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}' | grep -E 'priceguard|priceflow' || true", {
    stdio: "inherit",
  });

  log("");
  log("Recent app logs:");
  run("docker logs --tail 80 priceguard-app || true", { stdio: "inherit" });

  log("");
  log("Checkpointing to git...");
  try {
    runPrint("git add .env docker-compose.yml");
    execSync('git commit -m "Fix PriceGuard DB runtime config after rebrand"', {
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
  log("Expected result: PriceGuard branding remains, but runtime uses the original DB user/db name and old live hostname for now.");
} catch (err) {
  console.error("");
  console.error("FAILED:", err.message);
  process.exit(1);
}
