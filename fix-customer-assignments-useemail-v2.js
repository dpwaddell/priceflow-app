const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const APP_ROOT = "/mnt/user/appdata/priceflow";
const SERVER_FILE = path.join(APP_ROOT, "app", "server.js");
const BACKUP_DIR = path.join(
  APP_ROOT,
  "backups",
  `${new Date().toISOString().replace(/[:.]/g, "-")}_phase6_fix_useEmail_not_defined_v2`
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
    stdio: "inherit",
    shell: "/bin/bash",
  });
}

function fail(msg) {
  throw new Error(msg);
}

function findBlockByBrace(source, marker) {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`Marker not found: ${marker}`);

  const braceStart = source.indexOf("{", start);
  if (braceStart === -1) throw new Error(`Opening brace not found for: ${marker}`);

  let i = braceStart;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inSingle) {
      if (!escaped && ch === "'") inSingle = false;
      escaped = !escaped && ch === "\\";
      continue;
    }

    if (inDouble) {
      if (!escaped && ch === '"') inDouble = false;
      escaped = !escaped && ch === "\\";
      continue;
    }

    if (inTemplate) {
      if (!escaped && ch === "`") {
        inTemplate = false;
        continue;
      }
      if (!escaped && ch === "\\") {
        escaped = true;
        continue;
      }
      escaped = false;
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      escaped = false;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      escaped = false;
      continue;
    }

    if (ch === "`") {
      inTemplate = true;
      escaped = false;
      continue;
    }

    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        let end = i + 1;
        while (end < source.length && /\s/.test(source[end])) end++;
        if (source.slice(end, end + 2) === ");") {
          end += 2;
          while (end < source.length && /\s/.test(source[end])) end++;
        }
        return { start, end };
      }
    }
  }

  throw new Error(`Could not find end of block for marker: ${marker}`);
}

try {
  if (!fs.existsSync(SERVER_FILE)) {
    fail(`Missing ${SERVER_FILE}`);
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.copyFileSync(SERVER_FILE, path.join(BACKUP_DIR, "server.js"));

  const composeFile = path.join(APP_ROOT, "docker-compose.yml");
  if (fs.existsSync(composeFile)) {
    fs.copyFileSync(composeFile, path.join(BACKUP_DIR, "docker-compose.yml"));
  }

  const envFile = path.join(APP_ROOT, ".env");
  if (fs.existsSync(envFile)) {
    fs.copyFileSync(envFile, path.join(BACKUP_DIR, ".env"));
  }

  let txt = fs.readFileSync(SERVER_FILE, "utf8");

  const marker = 'app.get("/customer-assignments", async (req, res) => {';
  const block = findBlockByBrace(txt, marker);
  const routeText = txt.slice(block.start, block.end);

  if (!routeText.includes('const useEmail = String(req.query.use_email || "").trim();')) {
    const target = 'const host = String(req.query.host || "");';
    if (!routeText.includes(target)) {
      fail("Could not find host declaration inside customer assignments GET route.");
    }

    const replacement = `const host = String(req.query.host || "");
    const lookup = String(req.query.lookup || "").trim();
    const useEmail = String(req.query.use_email || "").trim();
    const useId = String(req.query.use_id || "").trim();`;

    let newRouteText;

    if (routeText.includes('const lookup = String(req.query.lookup || "").trim();')) {
      newRouteText = routeText.replace(
        `const host = String(req.query.host || "");
    const lookup = String(req.query.lookup || "").trim();`,
        replacement
      );
    } else {
      newRouteText = routeText.replace(target, replacement);
    }

    txt = txt.slice(0, block.start) + newRouteText + txt.slice(block.end);
  } else {
    log("useEmail/useId already present in GET route.");
  }

  fs.writeFileSync(SERVER_FILE, txt);

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
  log("Verification:");
  run(`grep -n 'const lookup = String(req.query.lookup || "").trim();\\|const useEmail = String(req.query.use_email || "").trim();\\|const useId = String(req.query.use_id || "").trim();' ${SERVER_FILE}`, { stdio: "inherit" });

  log("");
  log("Checkpointing to git...");
  try {
    runPrint("git add app/server.js");
    execSync('git commit -m "Fix customer assignment prefill params in GET route"', {
      cwd: APP_ROOT,
      env: process.env,
      stdio: "inherit",
      shell: "/bin/bash",
    });
  } catch (err) {
    log("No commit created, continuing.");
  }
  runPrint("git push origin main");

  log("");
  log("Done.");
  log("Now reopen PriceFlow > Customer assignments and test again.");
} catch (err) {
  console.error("");
  console.error("FAILED:", err.message);

  try {
    const backupServer = path.join(BACKUP_DIR, "server.js");
    if (fs.existsSync(backupServer)) {
      fs.copyFileSync(backupServer, SERVER_FILE);
      console.error("Restored backup server.js.");
    }
  } catch (restoreErr) {
    console.error("Backup restore failed:", restoreErr.message);
  }

  process.exit(1);
}
