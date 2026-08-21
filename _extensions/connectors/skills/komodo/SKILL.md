---
name: komodo
description: Read and drive a Komodo deployment orchestrator, stacks, deployments, servers, builds, container logs and alerts via the Komodo Core API. Use when the user asks about Komodo, their stacks/deployments/containers, what is running where, or wants something deployed, restarted or stopped.
---

# Komodo (connected)

Core at `$KOMODO_ADDRESS`, credentials in `$KOMODO_API_KEY` + `$KOMODO_API_SECRET`.
Every call is `POST $KOMODO_ADDRESS/<read|write|execute>/<Operation>` and **the body is the params object
itself**: there is no `{"params":{…}}` wrapper on this path form. Sending one deserializes as *empty* params,
so zero-argument operations still answer and every operation with a required field fails with
``missing field `stack` ``. Define this helper once per shell: `komodo <module>/<Operation> ['<params json>']`:

```sh
komodo() { local p='{}'; [ -n "$2" ] && p="$2"; curl -s -H "x-api-key: $KOMODO_API_KEY" \
  -H "x-api-secret: $KOMODO_API_SECRET" -H "content-type: application/json" \
  -d "$p" "$KOMODO_ADDRESS/$1"; }
```

Responses carry every field Komodo knows; project them with `jq` instead of reading them whole.

- Who am I: `curl -s -H "x-api-key: $KOMODO_API_KEY" -H "x-api-secret: $KOMODO_API_SECRET" "$KOMODO_ADDRESS/user" | jq '{username, admin}'`, a GET, the one call that is not a POST envelope
- Stacks (compose): `komodo read/ListStacks | jq -c '.[] | {name, state: .info.state, status: .info.status, server: .info.server_id}'`
- A stack's compose file: `komodo read/GetStack '{"stack":"<NAME>"}' | jq -r '.config.file_contents'`, empty when the stack is git-backed or host-backed, and then `.config.repo` / `.config.file_paths` / `.config.files_on_host` say where it really lives
- Images, and what is out of date: `komodo read/ListStacks | jq -c '.[] | {name, services: [.info.services[] | {service, image, update_available}]}'`
- Deployments (single containers): `komodo read/ListDeployments | jq -c '.[] | {name, state: .info.state, image: .info.image, server: .info.server_name, update_available: .info.update_available}'`
- Servers, also how a `server_id` becomes a name: `komodo read/ListServers | jq -c '.[] | {id, name, state: .info.state, address: .info.address}'`
- Builds / procedures / actions: `komodo read/ListBuilds` · `komodo read/ListProcedures` · `komodo read/ListActions`
- One resource's full config: `komodo read/GetStack '{"stack":"<NAME>"}'` (also `GetDeployment`, `GetServer`, `GetBuild`)
- Stack logs: `komodo read/GetStackLog '{"stack":"<NAME>","services":[],"tail":100}' | jq -r '.stdout, .stderr'`, `services` is required even when empty
- Deployment logs: `komodo read/GetDeploymentLog '{"deployment":"<NAME>","tail":100}' | jq -r '.stdout, .stderr'`
- Open alerts: `komodo read/ListAlerts | jq -c '.alerts[] | select(.resolved | not) | {level, target, type: .data.type}'`, returns `{alerts, next_page}`, newest first and ~100 to a page, nearly all of them already resolved
- Host stats: `komodo read/GetSystemStats '{"server":"<NAME>"}' | jq '{cpu_perc, mem_used_gb, mem_total_gb, load_average}'`

## Executions (these change what is running)

Say what you are about to do before running one, and report the result. Each returns an `Update`.

- Deploy / redeploy a stack: `komodo execute/DeployStack '{"stack":"<NAME>"}'` (add `"services":["api"]` to narrow)
- Restart / stop / start a stack: `komodo execute/RestartStack '{"stack":"<NAME>"}'` · `execute/StopStack` · `execute/StartStack`
- Pull the stack's newest images then deploy: `komodo execute/PullStack '{"stack":"<NAME>"}'` then `execute/DeployStack`
- Deploy a deployment: `komodo execute/Deploy '{"deployment":"<NAME>"}'`
- Restart / stop / start a deployment: `komodo execute/RestartDeployment '{"deployment":"<NAME>"}'` · `execute/StopDeployment` · `execute/StartDeployment`
- Run a build: `komodo execute/RunBuild '{"build":"<NAME>"}'`
- Run a procedure / action: `komodo execute/RunProcedure '{"procedure":"<NAME>"}'` · `komodo execute/RunAction '{"action":"<NAME>"}'`

## Secrets in stack configs

When a config needs a stored secret (an env var in a stack's `environment`, a registry password), write its
`{{secret:name}}` reference straight into the command's JSON: the sandbox substitutes the real value as the
command runs, and you never see it:

- Set a stack env var: `komodo write/UpdateStack '{"id":"<NAME>","config":{"environment":"API_KEY={{secret:MY_API_KEY}}"}}'` then `execute/DeployStack`
- Better for values many stacks share: put it in Komodo's OWN variable store once, then plain `[[MY_API_KEY]]`
  in any environment (Komodo interpolates and redacts it on its side, no reference needed again):
  `komodo write/CreateVariable '{"name":"MY_API_KEY","is_secret":true}'` then
  `komodo write/UpdateVariableValue '{"name":"MY_API_KEY","value":"{{secret:MY_API_KEY}}"}'`

Notes: every `<NAME>` may also be the resource id, Komodo accepts either. List items are
`{id, type, name, tags, info}`, so the per-resource detail lives under `.info`; a *list* item's `info` and the
same resource's `GetX` `.config` are different shapes, and only `GetX` carries the compose text. The `write/*`
module edits resource *configuration* (`write/UpdateStack`, `write/CreateAlerter`, …): use it only when the
user asks to change config, not to make something run. A non-2xx response carries a JSON body with the reason;
an empty list from an admin key really is empty, but from a scoped key it means the key was granted nothing.
