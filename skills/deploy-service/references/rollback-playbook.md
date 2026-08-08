# Rollback playbook

Loaded on demand by the `deploy-service` skill when a deployment reports
`failed`. Keeping it out of `SKILL.md` keeps the always-on instructions short.

## Decide

| `healthCheck.detail` contains | Action |
| --- | --- |
| `readiness probe` | Roll back. The new version never became ready. |
| `migration` | Do **not** roll back automatically — a partially applied schema migration can make the previous version fail too. Report and ask. |
| `timeout` | Poll once more. Slow starts resolve; if it is still failing, roll back. |
| anything else | Roll back and report the raw detail verbatim. |

## Execute

1. `rollback_deployment` with the failed deployment id.
2. `get_deployment_status` on the *returned* deployment id, not the failed one.
3. If the rollback itself fails, stop. Two failed writes to an environment is
   the point where a human takes over.

## Report

State the version the environment is on now, the version it was supposed to be
on, and whether a migration was involved. That last one decides whether the next
attempt is safe.
