const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const APP_ROOT = "/mnt/user/appdata/priceflow";
const GITIGNORE = path.join(APP_ROOT, ".gitignore");

function appendIfMissing(line) {
  let txt = "";
  if (fs.existsSync(GITIGNORE)) txt = fs.readFileSync(GITIGNORE, "utf8");
  const lines = txt.split(/\r?\n/).filter(Boolean);
  if (!lines.includes(line)) {
    lines.push(line);
    fs.writeFileSync(GITIGNORE, lines.join("\n") + "\n");
  }
}

try {
  appendIfMissing("*.bak.*");
  appendIfMissing("checkpoint-*.js");
  appendIfMissing("fix-embedded-nav-*.js");
  appendIfMissing("shopify.app.*.toml");
  appendIfMissing("!shopify.app.example.toml");

  console.log("Updated .gitignore");
  execSync("git status --short", { cwd: APP_ROOT, stdio: "inherit" });
} catch (err) {
  console.error("FAILED:", err.message);
  process.exit(1);
}
