---
name: deploy-service
description: Deploy a service to a staging or production environment, verify it, and roll back if the health checks fail. Use when the user asks to ship, release, promote, deploy, or roll back a service.
license: MIT
metadata:
  version: "1.0.0"
---

# Deploy a service

Procedural knowledge for shipping a service. The live actions run through the
`deploy-platform` MCP server that ships in the same plugin, but the procedure
below is the part that is worth reusing — it holds even if the platform changes.

## Before you deploy

1. Call `list_environments` and confirm the target environment exists.
2. Check `requiresApproval` on that environment. If it is `true`, ask the user
   for an explicit go-ahead in chat and quote the environment name back to them.
   Never infer approval from an earlier deploy in the same session.
3. Call `get_deployment_status` for the service. If the previous deployment is
   still `in_progress`, stop and report it instead of stacking a second one.

## Deploy

1. Call `create_deployment` with the service, environment, and version.
2. Report the returned deployment id to the user immediately — it is the handle
   for everything that follows.
3. Poll `get_deployment_status` until the state leaves `in_progress`.

## Verify

- `succeeded` — report the id, environment, version, and health check result.
- `failed` — do not retry blindly. Read `healthCheck.detail`, then follow
  [references/rollback-playbook.md](references/rollback-playbook.md).

## Roll back

Call `rollback_deployment` with the failing deployment id. It restores the last
version that passed its health check on that environment. Confirm with
`get_deployment_status` afterwards and report the version the environment
actually ended up on — not the one you intended.

## Report

Close every deploy with four facts: environment, service, version, final state.
If you skipped a step (no approval, no polling, no verification), say so.
