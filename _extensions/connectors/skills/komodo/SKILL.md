---
name: komodo
description: Read and drive a Komodo deployment orchestrator — stacks, deployments, servers, builds, container logs and alerts via the Komodo Core API. Use when the user asks about Komodo, their stacks/deployments/containers, what is running where, or wants something deployed, restarted or stopped.
---

# Komodo (connected)

Core at `$KOMODO_ADDRESS`, credentials in `$KOMODO_API_KEY` + `$KOMODO_API_SECRET`.
Every call is `POST $KOMODO_ADDRESS/<read|write|execute>/<Operation>` with the body `{"params":{…}}`.
Define this helper once per shell — `komodo <module>/<Operation> ['<params json>']`:

```sh
komodo() { local p="{}"; [ -n "$2" ] && p="$2"; curl -s -H "x-api-key: $KOMODO_API_KEY" \
  -H "x-api-secret: $KOMODO_API_SECRET" -H "content-type: application/json" \
  -d "{\"params\":$p}" "$KOMODO_ADDRESS/$1"; }
```

- Who am I: `curl -s -H "x-api-key: $KOMODO_API_KEY" -H "x-api-secret: $KOMODO_API_SECRET" "$KOMODO_ADDRESS/user" | jq '{username, admin}'`
- Stacks (compose): `komodo read/ListStacks | jq '.[] | {name, state: .info.state, status: .info.status, server: .info.server_name}'`
- Deployments (single containers): `komodo read/ListDeployments | jq '.[] | {name, state: .info.state, image: .info.image, server: .info.server_name, update_available: .info.update_available}'`
- Servers: `komodo read/ListServers | jq '.[] | {name, state: .info.state, address: .info.address, version: .info.version}'`
- Builds / procedures / actions: `komodo read/ListBuilds` · `komodo read/ListProcedures` · `komodo read/ListActions`
- One resource's full config: `komodo read/GetStack '{"stack":"<NAME>"}'` (also `GetDeployment`, `GetServer`, `GetBuild`)
- Stack logs: `komodo read/GetStackLog '{"stack":"<NAME>","services":[],"tail":100}' | jq -r '.stdout, .stderr'`
- Deployment logs: `komodo read/GetDeploymentLog '{"deployment":"<NAME>","tail":100}' | jq -r '.stdout, .stderr'`
- Open alerts: `komodo read/ListAlerts | jq '.alerts[] | select(.resolved | not) | {level, target, data}'`
- Host stats: `komodo read/GetSystemStats '{"server":"<NAME>"}'`

## Executions (these change what is running)

Say what you are about to do before running one, and report the result. Each returns an `Update`.

- Deploy / redeploy a stack: `komodo execute/DeployStack '{"stack":"<NAME>"}'` (add `"services":["api"]` to narrow)
- Restart / stop / start a stack: `komodo execute/RestartStack '{"stack":"<NAME>"}'` · `execute/StopStack` · `execute/StartStack`
- Pull the stack's newest images then deploy: `komodo execute/PullStack '{"stack":"<NAME>"}'` then `execute/DeployStack`
- Deploy a deployment: `komodo execute/Deploy '{"deployment":"<NAME>"}'`
- Restart / stop / start a deployment: `komodo execute/RestartDeployment '{"deployment":"<NAME>"}'` · `execute/StopDeployment` · `execute/StartDeployment`
- Run a build: `komodo execute/RunBuild '{"build":"<NAME>"}'`
- Run a procedure / action: `komodo execute/RunProcedure '{"procedure":"<NAME>"}'` · `komodo execute/RunAction '{"action":"<NAME>"}'`

Notes: every `<NAME>` may also be the resource id — Komodo accepts either. List items are
`{id, type, name, tags, info}`, so the per-resource detail lives under `.info`. The `write/*` module edits
resource *configuration* (`write/UpdateStack`, `write/CreateAlerter`, …) — use it only when the user asks to
change config, not to make something run. A non-2xx response carries a JSON body with the reason.
