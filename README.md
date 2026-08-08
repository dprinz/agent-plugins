# deploy-buddy — a runnable Agent Plugins demo

Companion project for **[Agent Plugins: ein portables Paketformat für Skills und MCP-Server](https://systemebene.house-harkonnen.com/artikel/agent-plugins-portables-paketformat)**.

Agent Skills carry procedural knowledge, MCP carries live tool access, and until
now there was no boundary that let you ship both as one thing.
[Agent Plugins v1.0.0](https://agent-plugins.org/specification) is that
boundary — a directory with fixed component locations, packaging Skills and MCP
servers *without changing their native formats*.

This repository is that directory. It is a real, conformant plugin, and it runs.

```bash
node tools/validate-plugin.mjs .   # conformance check against the v1.0.0 rules
node tools/demo-client.mjs .       # a mock client loads the plugin and uses it
```

No `npm install`. No API keys. Node 18+ and nothing else.

## What the demo shows

`demo-client.mjs` is ~100 lines doing exactly what the spec asks of a client:
read `plugin.json`, discover skills from `skills/`, expand the placeholders in
`mcp.json`, launch the server, ignore extension namespaces it does not own. Then
it walks through the `deploy-service` procedure end to end:

```
6. Running the deploy-service skill's procedure
   environments: staging, production (approval)

   a good version:
   dep-0001 succeeded  readiness probe passed in 4s

   a version that fails its health check:
   dep-0002 failed  readiness probe failed after 30s

   rollback (per references/rollback-playbook.md):
   restoring 2.4.0
   dep-0003 succeeded  readiness probe passed in 4s
```

That output is the whole thesis in miniature. The *decision* to roll back came from
a Skill. The *ability* to roll back came from an MCP server. One package delivered
both, and the client needed no knowledge of either beyond where to look.

## Layout

```text
deploy-buddy/
├── plugin.json                       # required manifest — the only mandatory file
├── mcp.json                          # portable MCP configuration
├── skills/                           # fixed location; immediate children only
│   ├── deploy-service/
│   │   ├── SKILL.md
│   │   └── references/
│   │       └── rollback-playbook.md  # loaded on demand, not always-on context
│   └── write-release-notes/
│       ├── SKILL.md
│       └── scripts/
│           └── changelog.mjs
├── mcp/deploy-platform/              # server implementation; an ordinary directory
│   ├── server.mjs
│   └── data/environments.json
├── com.example.ide/                  # client extension namespace — others ignore it
│   └── hooks/hooks.json
└── tools/                            # repo tooling, not part of the plugin surface
    ├── validate-plugin.mjs
    └── demo-client.mjs
```

Only `plugin.json`, `skills/`, `mcp.json`, and reverse-domain namespace directories
mean anything to a client. Everything else — `mcp/`, `tools/`, this README — is
just files a client walks past. That is what "fixed component locations" buys you:
discovery without the clients agreeing on anything else.

## The five things worth stealing

**1. The manifest schema is closed.** `plugin.json` accepts `name` plus metadata,
and nothing else. If you are migrating from a client-specific format, the fields
you will reach for out of habit — `hooks`, `agents`, `commands`, `mcpServers` — are
all rejected at the top level. The validator names each one and tells you where it
goes instead. This is the single most common migration error, so it is worth
failing loudly on.

**2. `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are not interchangeable.** The client
sets both and expands them in `args`, `env` values, and `cwd`:

```json
"env": {
  "DEPLOY_PLATFORM_CATALOG": "${PLUGIN_ROOT}/mcp/deploy-platform/data/environments.json",
  "DEPLOY_PLATFORM_STATE": "${PLUGIN_DATA}/deployments.json"
}
```

Read-only things you shipped come from `PLUGIN_ROOT`. Anything you write goes to
`PLUGIN_DATA`. A server that writes state under `PLUGIN_ROOT` is writing into its
own package — it breaks on read-only installs, and updates silently eat the data.
`validate-plugin.mjs` flags writable-looking env keys pointed at `PLUGIN_ROOT`.

Note also that `command` gets *no* expansion and must be a single token: `"node"`,
with the script path in `args`. `"node --inspect"` is invalid.

**3. Skills are discovered one level deep, and only one level.** `skills/greet/SKILL.md`
is a skill. `skills/greet/nested/SKILL.md` is invisible — clients must not recurse.
The frontmatter `name` has to match the directory name. Both are easy to get wrong
during a migration and produce a plugin that loads with no error and no skills.

**4. Client-specific behavior survives, in a namespace.** Hooks are not a portable
v1 component. Rather than dropping them, they live in `com.example.ide/` plus an
`extensions` entry in the manifest. Clients that do not own that namespace ignore
the directory entirely and still get the skills and the MCP server. That is the
mechanism that makes migration additive instead of lossy — you are not forced to
choose between portability and the client features you already depend on.

`com.example.ide` here is illustrative. Only use a namespace a real client
publishes and documents; inventing one gets you a directory nobody reads.

**5. The two component types are independent.** `write-release-notes` uses no MCP
server at all — delete `mcp.json` and it still works. `deploy-service` leans on one
heavily. A client that implements only skills is still a conformant client, and
your plugin should degrade accordingly rather than assume both are present.

## Try the failure modes

The validator is the interesting part to poke at. Break something and watch it
complain — nest a `SKILL.md` one level deeper, rename a skill directory without
touching its frontmatter, put `"hooks"` in `plugin.json`, point `DEPLOY_PLATFORM_STATE`
at `${PLUGIN_ROOT}`, or aim an arg at `${PLUGIN_ROOT}/../../etc/passwd`:

```
FAIL  plugin.json: "hooks" is not allowed at the top level — move it to mcp.json or under "extensions"
FAIL  skills/greet: SKILL.md is nested one level too deep — clients do not search recursively
FAIL  mcp.json/a/args: path escapes the plugin root: ${PLUGIN_ROOT}/../../etc/passwd
```

Each check cites the rule it enforces. It is a readable implementation, not a
normative one — [the specification](https://agent-plugins.org/specification) wins
where they disagree.

## The mock platform

`mcp/deploy-platform/server.mjs` is a dependency-free MCP server speaking JSON-RPC
over stdio. It is deterministic on purpose: any version string containing `bad`
fails its health check, so the rollback path is reproducible. Four tools —
`list_environments`, `create_deployment`, `get_deployment_status`,
`rollback_deployment` — backed by a JSON file under `PLUGIN_DATA`.

Real plugins should use the [MCP SDK](https://modelcontextprotocol.io). This one
hand-rolls the protocol so the demo clones and runs with zero install steps.

## Installing it in a real client

Out of scope for the spec, deliberately — it says nothing about registries,
installation, trust, or updates, and leaves those to clients. Point your client's
plugin loader at this directory. If it supports Agent Plugins v1.0.0, it finds two
skills and one MCP server without any per-client file in the package.

## License

MIT
