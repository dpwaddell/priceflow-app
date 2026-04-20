const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const APP_ROOT = "/mnt/user/appdata/priceflow";
const COMPOSE_FILE = path.join(APP_ROOT, "docker-compose.yml");

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

function capture(cmd) {
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
    return capture(cmd);
  } catch (err) {
    return (err.stdout ? String(err.stdout) : "") + (err.stderr ? String(err.stderr) : "") || err.message;
  }
}

function detectServices() {
  const compose = fs.readFileSync(COMPOSE_FILE, "utf8");
  const services = [...compose.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)].map(m => m[1]);

  let appService = null;
  let dbService = null;

  for (const svc of services) {
    const blockMatch = compose.match(new RegExp(`^  ${svc}:([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:|\\Z)`, "m"));
    const block = blockMatch ? blockMatch[1] : "";

    if (!dbService && (/postgres/i.test(block) || /POSTGRES_DB/i.test(block) || /5434:5432|5432:5432/.test(block))) {
      dbService = svc;
    }

    if (!appService && (/3100:3100/.test(block) || /node app\/server\.js|node server\.js|npm run migrate|npm start/i.test(block))) {
      appService = svc;
    }
  }

  return { appService, dbService, services };
}

try {
  if (!fs.existsSync(COMPOSE_FILE)) {
    throw new Error(`Missing ${COMPOSE_FILE}`);
  }

  const { appService, dbService, services } = detectServices();

  log("Detected services:");
  log(`- all: ${services.join(", ")}`);
  log(`- app: ${appService || "(not found)"}`);
  log(`- db: ${dbService || "(not found)"}`);

  if (!appService || !dbService) {
    throw new Error("Could not reliably detect app/db services from docker-compose.yml");
  }

  log("");
  log("Stopping everything first...");
  run("docker compose down --remove-orphans", { stdio: "inherit" });

  log("");
  log("Starting DB only...");
  run(`docker compose up -d ${dbService}`, { stdio: "inherit" });

  log("");
  log("Waiting for DB...");
  execSync("sleep 6");

  log("");
  log("DB container status:");
  log(tryCapture(`docker compose ps ${dbService}`));

  log("");
  log("DB logs:");
  log(tryCapture(`docker compose logs --tail=80 ${dbService}`));

  log("");
  log("Running one-shot migration with full output...");
  const migrateOutput = tryCapture(
    `docker compose run --rm --no-deps ${appService} sh -lc 'echo "NODE=$(node -v)"; echo "PWD=$(pwd)"; echo "DATABASE_URL=${DATABASE_URL}"; echo "---- package ----"; cat package.json 2>/dev/null || true; echo "---- migrate ----"; node run-migrations.js'`
  );
  log(migrateOutput);

  log("");
  log("Running one-shot server start with full output...");
  const serverOutput = tryCapture(
    `docker compose run --rm --no-deps ${appService} sh -lc 'echo "---- start ----"; node server.js'`
  );
  log(serverOutput);

  log("");
  log("Done.");
  log("Paste the output from '---- migrate ----' onwards.");
} catch (err) {
  console.error("");
  console.error("FAILED:", err.message);
  process.exit(1);
}
