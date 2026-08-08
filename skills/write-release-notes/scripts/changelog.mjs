#!/usr/bin/env node
// Group commits in a git range by Conventional Commit type.
// Usage: node changelog.mjs <from-ref> <to-ref>

import { execFileSync } from "node:child_process";

const [from, to = "HEAD"] = process.argv.slice(2);

if (!from) {
  console.error("usage: changelog.mjs <from-ref> [to-ref]");
  process.exit(2);
}

const SEP = "";
let raw;
try {
  raw = execFileSync("git", ["log", `--format=%H${SEP}%s`, `${from}..${to}`], {
    encoding: "utf8",
  });
} catch {
  console.error(`could not read git range ${from}..${to}`);
  process.exit(1);
}

const HEADER = /^(?<type>\w+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?:\s*(?<subject>.+)$/;
const groups = { breaking: [], features: [], fixes: [], other: [] };

for (const line of raw.split("\n").filter(Boolean)) {
  const [hash, subject] = line.split(SEP);
  const m = HEADER.exec(subject ?? "");
  const entry = {
    hash: hash.slice(0, 8),
    scope: m?.groups.scope ?? null,
    subject: m?.groups.subject ?? subject,
  };

  if (m?.groups.bang) groups.breaking.push(entry);
  else if (m?.groups.type === "feat") groups.features.push(entry);
  else if (m?.groups.type === "fix") groups.fixes.push(entry);
  else groups.other.push(entry);
}

console.log(JSON.stringify({ range: `${from}..${to}`, groups }, null, 2));
