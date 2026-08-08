#!/usr/bin/env node
/**
 * deploy-platform — a mock deployment platform exposed over MCP (stdio).
 *
 * Dependency-free on purpose: the demo has to run with nothing but `node`.
 * It speaks JSON-RPC 2.0 over newline-delimited stdin/stdout, which is what the
 * MCP stdio transport uses.
 *
 * Two paths matter for the Agent Plugins spec, and both arrive through `env` in
 * mcp.json after the client expands the placeholders:
 *
 *   DEPLOY_PLATFORM_CATALOG  <- ${PLUGIN_ROOT}  read-only, shipped in the package
 *   DEPLOY_PLATFORM_STATE    <- ${PLUGIN_DATA}  writable, owned by the client
 *
 * A server that wrote its state under PLUGIN_ROOT would be writing into its own
 * package. That is the mistake the two variables exist to prevent.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2025-06-18";

const pluginRoot = process.env.PLUGIN_ROOT ?? "";
const catalogPath =
  process.env.DEPLOY_PLATFORM_CATALOG ??
  join(pluginRoot, "mcp/deploy-platform/data/environments.json");

let statePath = process.env.DEPLOY_PLATFORM_STATE;
if (!statePath || statePath.includes("${")) {
  // The client is required to set PLUGIN_DATA. If it did not, fall back to a
  // temp dir rather than writing into the package.
  statePath = join(tmpdir(), "deploy-buddy", "deployments.json");
  log(`PLUGIN_DATA unavailable, falling back to ${statePath}`);
}

function log(message) {
  // stdout is the protocol channel. Diagnostics go to stderr, always.
  process.stderr.write(`[deploy-platform] ${message}\n`);
}

// ---------------------------------------------------------------- state

function loadEnvironments() {
  return JSON.parse(readFileSync(catalogPath, "utf8")).environments;
}

function loadState() {
  if (!existsSync(statePath)) return { deployments: [] };
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    log("state file unreadable, starting empty");
    return { deployments: [] };
  }
}

function saveState(state) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// A deployment is "in progress" for a beat, then resolves deterministically so
// the demo is reproducible: versions containing "bad" fail their health check.
function resolve(deployment) {
  if (deployment.state !== "in_progress") return deployment;
  if (Date.now() - deployment.startedAt < 400) return deployment;

  const bad = deployment.version.includes("bad");
  deployment.state = bad ? "failed" : "succeeded";
  deployment.healthCheck = bad
    ? { passed: false, detail: "readiness probe failed after 30s" }
    : { passed: true, detail: "readiness probe passed in 4s" };
  return deployment;
}

// ---------------------------------------------------------------- tools

const tools = [
  {
    name: "list_environments",
    description: "List the deployment environments this platform knows about.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler() {
      return { environments: loadEnvironments() };
    },
  },
  {
    name: "create_deployment",
    description: "Start a deployment of a service version to an environment.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service name, e.g. checkout-api" },
        environment: { type: "string", description: "Target environment name" },
        version: { type: "string", description: "Version or tag to deploy" },
      },
      required: ["service", "environment", "version"],
      additionalProperties: false,
    },
    handler({ service, environment, version }) {
      const env = loadEnvironments().find((e) => e.name === environment);
      if (!env) throw new Error(`unknown environment: ${environment}`);

      const state = loadState();
      const open = state.deployments.find(
        (d) => d.service === service && d.environment === environment && resolve(d).state === "in_progress",
      );
      if (open) throw new Error(`deployment ${open.id} is still in progress for ${service} on ${environment}`);

      const deployment = {
        id: `dep-${String(state.deployments.length + 1).padStart(4, "0")}`,
        service,
        environment,
        version,
        state: "in_progress",
        startedAt: Date.now(),
        healthCheck: null,
      };
      state.deployments.push(deployment);
      saveState(state);
      return { deployment };
    },
  },
  {
    name: "get_deployment_status",
    description:
      "Get the status of one deployment by id, or the most recent deployments of a service.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        service: { type: "string" },
      },
      additionalProperties: false,
    },
    handler({ deploymentId, service }) {
      const state = loadState();
      state.deployments.forEach(resolve);
      saveState(state);

      if (deploymentId) {
        const found = state.deployments.find((d) => d.id === deploymentId);
        if (!found) throw new Error(`unknown deployment: ${deploymentId}`);
        return { deployment: found };
      }
      const list = state.deployments.filter((d) => !service || d.service === service);
      return { deployments: list.slice(-5).reverse() };
    },
  },
  {
    name: "rollback_deployment",
    description:
      "Roll an environment back to the last version that passed its health check.",
    inputSchema: {
      type: "object",
      properties: { deploymentId: { type: "string" } },
      required: ["deploymentId"],
      additionalProperties: false,
    },
    handler({ deploymentId }) {
      const state = loadState();
      state.deployments.forEach(resolve);

      const failed = state.deployments.find((d) => d.id === deploymentId);
      if (!failed) throw new Error(`unknown deployment: ${deploymentId}`);

      const target = [...state.deployments]
        .reverse()
        .find(
          (d) =>
            d.environment === failed.environment &&
            d.service === failed.service &&
            d.state === "succeeded",
        );
      if (!target) throw new Error(`no healthy version to roll back to on ${failed.environment}`);

      const rollback = {
        id: `dep-${String(state.deployments.length + 1).padStart(4, "0")}`,
        service: failed.service,
        environment: failed.environment,
        version: target.version,
        state: "in_progress",
        startedAt: Date.now(),
        healthCheck: null,
        rollbackOf: failed.id,
      };
      state.deployments.push(rollback);
      saveState(state);
      return { deployment: rollback, restoredVersion: target.version };
    },
  },
];

// ---------------------------------------------------------------- transport

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function handle(request) {
  const { id, method, params = {} } = request;

  switch (method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "deploy-platform", version: "1.0.0" },
      };

    case "tools/list":
      return {
        tools: tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      };

    case "tools/call": {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) throw new Error(`unknown tool: ${params.name}`);
      try {
        const result = tool.handler(params.arguments ?? {});
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        // Tool failures are results, not protocol errors — the model needs to read them.
        return {
          isError: true,
          content: [{ type: "text", text: error.message }],
        };
      }
    }

    case "ping":
      return {};

    default:
      throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;

  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }

  if (request.id === undefined) return; // notification, nothing to answer

  try {
    send({ jsonrpc: "2.0", id: request.id, result: handle(request) });
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: error.code ?? -32603, message: error.message },
    });
  }
});

log(`catalog: ${catalogPath}`);
log(`state:   ${statePath}`);
