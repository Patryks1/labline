#!/usr/bin/env bun
/**
 * Fail CI and local checks when publisher/staging payloads land on a
 * source branch. Those files are not the game; they cannot be reviewed.
 */
import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const errors = [];

const BANNED_DIRS = [
  path.join(root, ".github", "labline-balance"),
  path.join(root, ".github", "staging"),
];

const BANNED_WORKFLOW_NAMES = [
  "labline-model-economy-bootstrap.yml",
  "labline-model-economy-publish.yml",
];

const BANNED_BASENAME_PATTERNS = [
  /^economy\.b64(\.|$)/,
  /^plan\.b64(\.|$)/,
  /^script\.b64(\.|$)/,
  /^economy\.fixed(\.|$)/,
];

function walk(dir, visit) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, visit);
    else visit(full);
  }
}

for (const dir of BANNED_DIRS) {
  if (existsSync(dir)) {
    errors.push(`forbidden staging directory present: ${path.relative(root, dir)}`);
  }
}

const workflowsDir = path.join(root, ".github", "workflows");
if (existsSync(workflowsDir)) {
  for (const name of readdirSync(workflowsDir)) {
    if (BANNED_WORKFLOW_NAMES.includes(name)) {
      errors.push(`temporary publisher workflow present: .github/workflows/${name}`);
    }
  }
}

walk(root, (file) => {
  const rel = path.relative(root, file);
  const base = path.basename(file);
  if (BANNED_BASENAME_PATTERNS.some((pattern) => pattern.test(base))) {
    errors.push(`publisher payload fragment present: ${rel}`);
  }
});

const noopDocs = [
  path.join(root, "docs", "MODEL_TRAINING_BALANCE_2026.md"),
];
for (const file of noopDocs) {
  if (!existsSync(file)) continue;
  const text = readFileSync(file, "utf8").trim();
  if (!text || text === "noop" || text.length < 200) {
    errors.push(
      `${path.relative(root, file)} is a placeholder; replace it with real model-economy documentation`,
    );
  }
}

if (errors.length > 0) {
  console.error("Staging payload check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("Staging payload check passed.");
