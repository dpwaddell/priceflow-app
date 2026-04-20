const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const APP_ROOT = "/mnt/user/appdata/priceflow";
const ENV_FILE = path.join(APP_ROOT, ".env");
const BACKUP_DIR = path.join(
  APP_ROOT,
  "backups",
  `${new Date().toISOString().replace(/[:.]/g, "-")}_switch_app_url_to_priceguard`
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

try {
  if (!fs.existsSync(ENV_FILE)) {
    throw new Error(`Missing ${ENV_FILE}`);
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.copyFileSync(ENV_FILE, path.join(BACKUP_DIR, ".env"));

  let envText = fs.readFileSync(ENV_FILE, "utf8");

  if (!/^APP_URL=/m.test(envText)) {
    throw new Error("APP_URL not found in .env");
  }

  envText = envText.replace(
    /^APP_URL=.*/m,
    "APP_URL=https://priceguard.sample-guard.com"
  );

  fs.writeFileSync(ENV_FILE, envText);

  log("Restarting stack...");
  runPrint("docker compose down --remove-orphans");
  runPrint("docker compose up -d --remove-orphans");

  log("");
  log("Waiting for app...");
  execSync("sleep 10");

  log("");
  log("Local health:");
  run("curl -s http://localhost:3100/health", { stdio: "inherit" });

  log("");
  log("Public health:");
  run("curl -s https://priceguard.sample-guard.com/health", { stdio: "inherit" });

  log("");
  log("Done.");
  log("APP_URL now points to https://priceguard.sample-guard.com");
} catch (err) {
  console.error("");
  console.error("FAILED:", err.message);
  process.exit(1);
}
