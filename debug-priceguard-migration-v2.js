const { execSync } = require("child_process");

const APP_ROOT = "/mnt/user/appdata/priceflow";
const APP_SERVICE = "priceguard-app";
const DB_SERVICE = "priceguard-db";

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
    return (err.stdout ? String(err.stdout) : "") +
           (err.stderr ? String(err.stderr) : "") ||
           err.message;
  }
}

try {
  log("Stopping everything first...");
  run("docker compose down --remove-orphans", { stdio: "inherit" });

  log("");
  log("Starting DB only...");
  run(`docker compose up -d ${DB_SERVICE}`, { stdio: "inherit" });

  log("");
  log("Waiting for DB...");
  execSync("sleep 6");

  log("");
  log("DB status:");
  log(tryCapture(`docker compose ps ${DB_SERVICE}`));

  log("");
  log("DB logs:");
  log(tryCapture(`docker compose logs --tail=80 ${DB_SERVICE}`));

  log("");
  log("Running one-shot migration with full output...");
  const migrateOutput = tryCapture(
    `docker compose run --rm --no-deps ${APP_SERVICE} sh -lc 'echo "NODE=$(node -v)"; echo "PWD=$(pwd)"; echo "---- env ----"; env | sort | grep -E "^(APP_NAME|APP_URL|DATABASE_URL|PORT|NODE_ENV)=" || true; echo "---- package ----"; cat package.json 2>/dev/null || true; echo "---- migrate ----"; node run-migrations.js'`
  );
  log(migrateOutput);

  log("");
  log("Running one-shot server start with full output...");
  const serverOutput = tryCapture(
    `docker compose run --rm --no-deps ${APP_SERVICE} sh -lc 'echo "---- start ----"; node server.js'`
  );
  log(serverOutput);

  log("");
  log("Done.");
  log("Paste everything from '---- migrate ----' onwards.");
} catch (err) {
  console.error("");
  console.error("FAILED:", err.message);
  process.exit(1);
}
