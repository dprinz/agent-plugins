#!/usr/bin/env node
/**
 * A conformance checker for Agent Plugins v1.0.0.
 *
 * Not a normative implementation — a readable one. Every check below cites the
 * rule it enforces so you can diff it against the spec:
 * https://agent-plugins.org/specification
 *
 * Usage: node tools/validate-plugin.mjs [plugin-root]
 */

import { readFileSync, readdirSync, statSync, lstatSync, realpathSync, existsSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const problems = [];
const notes = [];

const fail = (where, message) => problems.push(`${where}: ${message}`);
const note = (message) => notes.push(message);

// The manifest schema is closed. These are the only allowed top-level keys.
const MANIFEST_KEYS = new Set([
  "$schema", "name", "version", "description", "author",
  "homepage", "repository", "license", "keywords", "extensions",
]);

// Fields clients have historically put at the top level. They belong in
// mcp.json or inside `extensions`.
const MIGRATION_TRAPS = ["hooks", "agents", "commands", "skills", "mcpServers", "lspServers"];

const NAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const NAMESPACE_RE = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const SCHEMA_BASE = "https://agent-plugins.org/schemas/1.0.0";

function readJson(path, where) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(where, `not valid JSON — ${error.message}`);
    return null;
  }
}

// Path safety: plugin-relative paths start with "./" and must not escape root.
function checkContained(value, where) {
  const cleaned = value.replaceAll("${PLUGIN_ROOT}", root).replaceAll("${PLUGIN_DATA}", "");
  if (!cleaned.startsWith(root)) return; // not a plugin-root path, nothing to contain
  const resolved = resolve(cleaned);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    fail(where, `path escapes the plugin root: ${value}`);
  }
}

// ---------------------------------------------------------------- manifest

const manifestPath = join(root, "plugin.json");
if (!existsSync(manifestPath)) {
  fail("plugin.json", "missing — every plugin MUST have a manifest at the plugin root");
} else {
  const manifest = readJson(manifestPath, "plugin.json");
  if (manifest) {
    if (manifest.$schema !== `${SCHEMA_BASE}/plugin.schema.json`) {
      fail("plugin.json", `$schema must be "${SCHEMA_BASE}/plugin.schema.json"`);
    }
    if (typeof manifest.name !== "string") {
      fail("plugin.json", "name is required and must be a string");
    } else {
      if (manifest.name.length < 1 || manifest.name.length > 64) {
        fail("plugin.json", "name must be 1–64 characters");
      }
      if (!NAME_RE.test(manifest.name)) {
        fail("plugin.json", `name "${manifest.name}" must be lowercase alphanumeric with . or -`);
      }
      if (manifest.name.includes("--") || manifest.name.includes("..")) {
        fail("plugin.json", "name must not contain consecutive -- or ..");
      }
    }
    for (const key of Object.keys(manifest)) {
      if (MANIFEST_KEYS.has(key)) continue;
      const hint = MIGRATION_TRAPS.includes(key)
        ? ` — move it to mcp.json or under "extensions"`
        : "";
      fail("plugin.json", `"${key}" is not allowed at the top level${hint}`);
    }
    for (const ns of Object.keys(manifest.extensions ?? {})) {
      if (!NAMESPACE_RE.test(ns)) {
        fail("plugin.json", `extension namespace "${ns}" must be reverse-domain, e.g. com.example.client`);
      } else {
        note(`extension namespace "${ns}" declared — other clients will ignore it`);
      }
    }
  }
}

// ---------------------------------------------------------------- skills

const skillsDir = join(root, "skills");
if (existsSync(skillsDir)) {
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      fail(`skills/${entry.name}`, "only directories are discovered directly under skills/");
      continue;
    }
    const dir = join(skillsDir, entry.name);
    const skillFile = join(dir, "SKILL.md");

    // Only immediate children are skills; clients MUST NOT recurse deeper.
    if (!existsSync(skillFile)) {
      const deeper = readdirSync(dir, { withFileTypes: true }).some(
        (c) => c.isDirectory() && existsSync(join(dir, c.name, "SKILL.md")),
      );
      fail(
        `skills/${entry.name}`,
        deeper
          ? "SKILL.md is nested one level too deep — clients do not search recursively"
          : "no SKILL.md",
      );
      continue;
    }
    if (!statSync(skillFile).isFile()) {
      fail(`skills/${entry.name}/SKILL.md`, "must resolve to a regular file");
      continue;
    }
    if (lstatSync(skillFile).isSymbolicLink()) {
      const target = realpathSync(skillFile);
      if (relative(root, target).startsWith("..")) {
        fail(`skills/${entry.name}/SKILL.md`, "symlink escapes the plugin root");
      }
    }

    const source = readFileSync(skillFile, "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source);
    if (!frontmatter) {
      fail(`skills/${entry.name}/SKILL.md`, "missing YAML frontmatter (name, description)");
      continue;
    }
    const name = /^name:\s*(.+)$/m.exec(frontmatter[1])?.[1].trim();
    const description = /^description:\s*(.+)$/m.exec(frontmatter[1])?.[1].trim();

    if (!name) fail(`skills/${entry.name}/SKILL.md`, "frontmatter is missing name");
    else if (name !== entry.name) {
      fail(`skills/${entry.name}/SKILL.md`, `frontmatter name "${name}" must match the directory name`);
    }
    if (!description) fail(`skills/${entry.name}/SKILL.md`, "frontmatter is missing description");
    else if (description.length < 20) {
      note(`skills/${entry.name}: description is short — it is the only text used to decide relevance`);
    }
  }
}

// ---------------------------------------------------------------- mcp.json

const mcpPath = join(root, "mcp.json");
if (existsSync(mcpPath)) {
  const mcp = readJson(mcpPath, "mcp.json");
  if (mcp) {
    if (mcp.$schema !== `${SCHEMA_BASE}/mcp.schema.json`) {
      fail("mcp.json", `$schema must be "${SCHEMA_BASE}/mcp.schema.json"`);
    }
    if (typeof mcp.mcpServers !== "object" || mcp.mcpServers === null) {
      fail("mcp.json", "mcpServers is required (an empty object is valid)");
    } else {
      for (const [id, server] of Object.entries(mcp.mcpServers)) {
        const where = `mcp.json/${id}`;

        if (server.type === "stdio") {
          if (typeof server.command !== "string" || !server.command) {
            fail(where, "stdio servers require a command");
          } else {
            if (/\s/.test(server.command)) {
              fail(where, `command must be a single token — put "${server.command}" arguments in args`);
            }
            if (server.command.includes("${")) {
              fail(where, "command does not support placeholder expansion");
            }
            if (!server.command.startsWith("./") && server.command.includes("/")) {
              fail(where, "command must be a bare name or a ./ plugin-relative path");
            }
            if (server.command.startsWith("./")) {
              checkContained(join(root, server.command), where);
              if (!existsSync(join(root, server.command))) {
                fail(where, `command not found in package: ${server.command}`);
              }
            }
          }
          for (const arg of server.args ?? []) checkContained(arg, `${where}/args`);
          for (const [key, value] of Object.entries(server.env ?? {})) {
            if (key === "PLUGIN_ROOT" || key === "PLUGIN_DATA") {
              fail(where, `env must not define ${key} — the client sets it`);
            }
            checkContained(value, `${where}/env/${key}`);
          }
          // Catch the classic bug: writable state pointed at the read-only package.
          for (const [key, value] of Object.entries(server.env ?? {})) {
            if (/(^|_)(state|cache|db|data|logs?)(_|$)/i.test(key) && value.includes("${PLUGIN_ROOT}")) {
              note(`${where}: env ${key} looks writable but points at \${PLUGIN_ROOT} — use \${PLUGIN_DATA}`);
            }
          }
        } else if (server.type === "streamable-http" || server.type === "sse") {
          if (typeof server.url !== "string") {
            fail(where, `${server.type} servers require a url`);
          } else {
            let parsed;
            try {
              parsed = new URL(server.url);
            } catch {
              fail(where, `url is not absolute: ${server.url}`);
            }
            const loopback = ["localhost", "127.0.0.1", "::1"].includes(parsed?.hostname);
            if (parsed && parsed.protocol !== "https:" && !loopback) {
              fail(where, "non-loopback urls must use https");
            }
          }
          if (server.type === "sse") note(`${where}: sse is the legacy transport, prefer streamable-http`);
          for (const value of Object.values(server.headers ?? {})) {
            if (value.includes("${")) fail(where, "headers do not support placeholder expansion");
          }
        } else {
          fail(where, `type must be "stdio", "streamable-http", or "sse" (got ${JSON.stringify(server.type)})`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------- extension dirs

const KNOWN_TOP_LEVEL = new Set(["plugin.json", "mcp.json", "skills"]);
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (KNOWN_TOP_LEVEL.has(entry.name) || entry.name.startsWith(".")) continue;
  if (entry.isDirectory() && NAMESPACE_RE.test(entry.name)) {
    note(`${entry.name}/ is a client extension directory — clients that do not own it will ignore it`);
  }
}

// ---------------------------------------------------------------- report

for (const n of notes) console.log(`note  ${n}`);
for (const p of problems) console.log(`FAIL  ${p}`);

if (problems.length === 0) {
  console.log(`\nOK — ${root} conforms to Agent Plugins v1.0.0`);
  process.exit(0);
}
console.log(`\n${problems.length} problem(s) found`);
process.exit(1);
