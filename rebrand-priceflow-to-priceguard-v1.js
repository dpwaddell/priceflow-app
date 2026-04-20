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
  `${new Date().toISOString().replace(/[:.]/g, "-")}_rebrand_priceguard`
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

function backup(file) {
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, path.join(BACKUP_DIR, path.basename(file)));
  }
}

function replaceAll(txt, from, to) {
  return txt.split(from).join(to);
}

try {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  backup(SERVER_FILE);
  backup(COMPOSE_FILE);
  backup(ENV_FILE);

  //
  // server.js
  //
  let server = fs.readFileSync(SERVER_FILE, "utf8");

  server = replaceAll(server, "PriceFlow |", "PriceGuard |");
  server = replaceAll(server, '"app":"PriceFlow"', '"app":"PriceGuard"');
  server = replaceAll(server, "PriceFlow", "PriceGuard");
  server = replaceAll(server, "priceflow", "priceguard");

  fs.writeFileSync(SERVER_FILE, server);

  //
  // docker-compose.yml
  //
  if (fs.existsSync(COMPOSE_FILE)) {
    let compose = fs.readFileSync(COMPOSE_FILE, "utf8");

    compose = replaceAll(compose, "priceflow-app", "priceguard-app");
    compose = replaceAll(compose, "priceflow-db", "priceguard-db");
    compose = replaceAll(compose, "container_name: priceflow", "container_name: priceguard");

    fs.writeFileSync(COMPOSE_FILE, compose);
  }

  //
  // .env
  //
  if (fs.existsSync(ENV_FILE)) {
    let env = fs.readFileSync(ENV_FILE, "utf8");

    env = replaceAll(env, "priceflow.sample-guard.com", "priceguard.sample-guard.com");
    env = replaceAll(env, "PriceFlow", "PriceGuard");
    env = replaceAll(env, "priceflow", "priceguard");

    fs.writeFileSync(ENV_FILE, env);
  }

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
  log("Git checkpoint...");
  try {
    runPrint("git add app/server.js docker-compose.yml .env");
    execSync(
      'git commit -m "Rebrand PriceFlow to PriceGuard"',
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
  log("PriceFlow has been rebranded to PriceGuard.");
  log("");
  log("Next recommended manual tasks:");
  log("1. Update Shopify Partner app name");
  log("2. Update app URLs in Shopify Partner dashboard");
  log("3. Update DNS / Cloudflare hostname");
  log("4. Update logo / favicon");
  log("5. Rename GitHub repo when ready");

} catch (err) {
  console.error("");
  console.error("FAILED:", err.message);
  process.exit(1);
}
