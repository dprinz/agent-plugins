#!/usr/bin/env node
/**
 * A ~100-line stand-in for a plugin-aware client.
 *
 * It does the four things the spec asks of a client, in order:
 *   1. read plugin.json at the plugin root
 *   2. discover skills from the fixed location (immediate children of skills/)
 *   3. read mcp.json, expand ${PLUGIN_ROOT} / ${PLUGIN_DATA}, launch the server
 *   4. ignore extension namespaces it does not own
 *
 * Then it runs a scripted deploy so you can watch the plugin actually work.
 *
 * Usage: node tools/demo-client.mjs [plugin-root]
 */

import { spawn } from "node:child_process";
import { readFileSync, readdirSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";

const pluginRoot = resolve(process.argv[2] ?? ".");
const heading = (text) => console.log(`\n\x1b[1m${text}\x1b[0m`);

// -------------------------------------------------- 1. manifest

const manifest = JSON.parse(readFileSync(join(pluginRoot, "plugin.json"), "utf8"));

// The client owns PLUGIN_DATA, and it lives *outside* the package — the plugin
// directory is read-only as far as the plugin is concerned. Wiped each run so
// the demo is reproducible.
const pluginData = join(tmpdir(), "agent-plugins-demo", manifest.name);
rmSync(pluginData, { recursive: true, force: true });
mkdirSync(pluginData, { recursive: true });

heading("1. Manifest");
console.log(`   ${manifest.name} ${manifest.version ?? ""} — ${manifest.description ?? ""}`);

// -------------------------------------------------- 2. skills

heading("2. Skills discovered at skills/");
const skillsDir = join(pluginRoot, "skills");
if (existsSync(skillsDir)) {
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    const file = join(skillsDir, entry.name, "SKILL.md");
    if (!entry.isDirectory() || !existsSync(file)) continue; // no recursion, by spec
    const description = /^description:\s*(.+)$/m.exec(readFileSync(file, "utf8"))?.[1] ?? "";
    console.log(`   ${entry.name}\n     ${description.slice(0, 92)}…`);
  }
}

// -------------------------------------------------- 3. mcp servers

const expand = (value) =>
  value.replaceAll("${PLUGIN_ROOT}", pluginRoot).replaceAll("${PLUGIN_DATA}", pluginData);

const mcp = JSON.parse(readFileSync(join(pluginRoot, "mcp.json"), "utf8"));
const [serverId, config] = Object.entries(mcp.mcpServers)[0];

heading(`3. Launching MCP server "${serverId}"`);
const args = (config.args ?? []).map(expand);
const env = Object.fromEntries(Object.entries(config.env ?? {}).map(([k, v]) => [k, expand(v)]));
console.log(`   ${config.command} ${args.map((a) => a.replace(pluginRoot, "<PLUGIN_ROOT>")).join(" ")}`);
for (const [k, v] of Object.entries(env)) {
  console.log(`   env ${k}=${v.replace(pluginData, "<PLUGIN_DATA>").replace(pluginRoot, "<PLUGIN_ROOT>")}`);
}

const child = spawn(config.command, args, {
  cwd: config.cwd ? expand(config.cwd) : pluginRoot,
  env: { ...process.env, ...env, PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: pluginData },
  stdio: ["pipe", "pipe", "inherit"],
});

let nextId = 1;
const pending = new Map();

createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const settle = pending.get(message.id);
  if (!settle) return;
  pending.delete(message.id);
  message.error ? settle.reject(new Error(message.error.message)) : settle.resolve(message.result);
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve_, reject) => {
    pending.set(id, { resolve: resolve_, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const call = async (name, args_ = {}) => {
  const result = await request("tools/call", { name, arguments: args_ });
  const text = result.content.map((c) => c.text).join("\n");
  return result.isError ? { error: text } : JSON.parse(text);
};

// -------------------------------------------------- 4. extensions

heading("4. Client extensions");
for (const ns of Object.keys(manifest.extensions ?? {})) {
  const owned = ns === "com.example.ide"; // this demo client claims exactly one
  console.log(`   ${ns} — ${owned ? "owned by this client, applying" : "not ours, ignored"}`);
}

// -------------------------------------------------- scripted run

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function status(id) {
  await wait(450); // let the mock deployment resolve
  const { deployment } = await call("get_deployment_status", { deploymentId: id });
  console.log(`   ${deployment.id} ${deployment.state}  ${deployment.healthCheck?.detail ?? ""}`);
  return deployment;
}

const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
console.log(`   connected to ${init.serverInfo.name} ${init.serverInfo.version}`);

const { tools } = await request("tools/list");
heading("5. Tools exposed by the plugin");
for (const tool of tools) console.log(`   ${tool.name} — ${tool.description}`);

heading("6. Running the deploy-service skill's procedure");

const { environments } = await call("list_environments");
console.log(`   environments: ${environments.map((e) => `${e.name}${e.requiresApproval ? " (approval)" : ""}`).join(", ")}`);

console.log("\n   a good version:");
const good = await call("create_deployment", {
  service: "checkout-api",
  environment: "staging",
  version: "2.4.0",
});
await status(good.deployment.id);

console.log("\n   a version that fails its health check:");
const bad = await call("create_deployment", {
  service: "checkout-api",
  environment: "staging",
  version: "2.5.0-bad",
});
const failed = await status(bad.deployment.id);

if (failed.state === "failed") {
  console.log("\n   rollback (per references/rollback-playbook.md):");
  const rolled = await call("rollback_deployment", { deploymentId: failed.id });
  console.log(`   restoring ${rolled.restoredVersion}`);
  await status(rolled.deployment.id);
}

console.log(`\n   state was written to ${pluginData}/deployments.json — inside PLUGIN_DATA, not the package.`);

child.kill();
