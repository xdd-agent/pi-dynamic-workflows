// ── xdd-agent fork: if this file executes, jiti loaded a plain .js from src/
//    (proving dist/ is unnecessary for git-installed extensions) ──
const fs = require("node:fs");
const path = require("node:path");
try {
  const dir = path.join(process.env.HOME || process.env.USERPROFILE || ".", ".pi", "workflows");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "jiti-verified.txt"),
    "xdd-agent fork — src/jiti-verify.js loaded (plain .js, no dist/ needed)\n" + new Date().toISOString() + "\n"
  );
} catch (_) { /* best-effort marker */ }
