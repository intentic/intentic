---
name: fly
description: Manage Fly.io machines, apps, volumes and app secrets through the Machines API. Use when the user asks what is running on Fly.io, or to start, stop, resize, move, redeploy or destroy a Fly machine.
---

# Fly.io (connected)

Token in `$FLY_API_TOKEN`, organization slug in `$FLY_ORG`. Everything below is the Machines API at
`https://api.machines.dev/v1`; flyctl is not installed here, and a copy you install yourself reads the plain
name, so hand it the token per command: `FLY_API_TOKEN=$FLY_API_TOKEN fly status -a <APP>`. Define this helper
once per shell: `flyapi <METHOD> <path> [-d '<json>']`:

```sh
flyapi() { local m="$1" p="$2"; shift 2; curl -s -X "$m" -H "Authorization: Bearer $FLY_API_TOKEN" \
  -H "Content-Type: application/json" "https://api.machines.dev/v1/$p" "$@"; }
```

The machine is the unit: an app is a namespace with its own private network, and scaling means creating or
destroying machines inside one. A failure answers non-2xx with `{"error": "…"}`, so read `.error` rather than
assuming the shape of the result: 404 is definitively gone, 401/403 is a token that never covered this, and an
app-scoped token refuses org-wide calls outright instead of answering an empty list.

## Reading

- What this token is: `flyapi GET tokens/current | jq -c '.tokens[] | {org_slug, apps, user}'`
- Apps: `flyapi GET "apps?org_slug=$FLY_ORG" | jq -c '.apps[] | {name, status, machine_count, volume_count}'`
- Every machine in the org, with the app it belongs to: `flyapi GET "orgs/$FLY_ORG/machines" | jq -c '.machines[] | {app_name, id, name, state, region}'`, page on with `?cursor=<next_cursor>`
- Machines in one app: `flyapi GET apps/<APP>/machines | jq -c '.[] | {id, name, state, region, image: .config.image, guest: .config.guest}'`, a bare array, not an envelope
- One machine: `flyapi GET apps/<APP>/machines/<ID> | jq '{state, region, private_ip, cordoned, image: .image_ref, config}'`
- Why it is in that state: `flyapi GET apps/<APP>/machines/<ID>/events | jq -c '.[] | {type, status, timestamp, exit: .request.exit_event}'`, an OOM or a non-zero exit shows up here and nowhere else
- What it is running right now: `flyapi GET apps/<APP>/machines/<ID>/ps | jq -c '.[] | {pid, command, rss}'`, started machines only
- Volumes: `flyapi GET apps/<APP>/volumes | jq -c '.[] | {id, name, region, size_gb, state, attached_machine_id, bytes_used, bytes_total}'`
- Secret names, never their values: `flyapi GET apps/<APP>/secrets | jq -c '.secrets[] | {name, digest}'`
- Addresses: `flyapi GET apps/<APP>/ip_assignments | jq -c '.ips[] | {ip, region, shared}'`
- Regions: `flyapi GET platform/regions | jq -c '.Regions[] | {code, name}'`, capital R on this one response

## Changing what runs

Each of these costs money or takes traffic. Say which machines you are about to touch before running one, and
report what came back.

- Start · stop · restart: `flyapi POST apps/<APP>/machines/<ID>/start` · `…/stop -d '{"signal":"SIGINT","timeout":"30s"}'` · `…/restart?signal=SIGTERM&timeout=30`
- Suspend, which snapshots memory so the next start may resume instead of cold-booting: `flyapi POST apps/<APP>/machines/<ID>/suspend`
- Wait for the transition rather than polling: `flyapi GET "apps/<APP>/machines/<ID>/wait?state=started&timeout=60"`; waiting for `stopped` also needs `&instance_id=<instance_id>`
- Run a command inside one: `flyapi POST apps/<APP>/machines/<ID>/exec -d '{"command":["sh","-c","df -h /data"],"timeout":30}' | jq -r '.exit_code, .stdout, .stderr'`
- Create: `flyapi POST apps/<APP>/machines -d '{"name":"api-2","region":"iad","config":{"image":"ghcr.io/acme/api:1.4","guest":{"cpu_kind":"shared","cpus":1,"memory_mb":512},"env":{"PORT":"8080"},"services":[{"protocol":"tcp","internal_port":8080,"ports":[{"port":443,"handlers":["tls","http"]}],"autostart":true,"autostop":"suspend"}],"restart":{"policy":"on-failure","max_retries":3}}}'`; add `"skip_launch":true` to leave it created but stopped
- Change one (new image, bigger guest, edited env): GET the machine, edit that `.config`, and send the whole thing back with `flyapi POST apps/<APP>/machines/<ID> -d '{"config":{…}}'`. **The config is replaced, not merged**, so anything you leave out is gone from the machine. A started machine relaunches on the new config in that same request, and a start sent alongside it races the `replacing` state and is refused; a stopped machine stays stopped, so there the start afterwards is the real operation
- Stamp metadata without replacing the config or waking the machine: `flyapi POST apps/<APP>/machines/<ID>/metadata/<KEY> -d '{"value":"…"}'`; filter on it later with `GET apps/<APP>/machines?metadata.<KEY>=<VALUE>`
- Take one out of the proxy's rotation, or put it back: `flyapi POST apps/<APP>/machines/<ID>/cordon` · `…/uncordon`. Blue-green is: create the replacement with `"skip_service_registration":true`, check it, uncordon it, then destroy the old one
- Destroy: `flyapi DELETE "apps/<APP>/machines/<ID>?force=true"`, irreversible, and `force` kills it mid-request
- Scale out or in by creating another machine from the same config, or destroying one: there is no scale endpoint, and a machine is pinned to the region it was created in
- Volumes: `flyapi POST apps/<APP>/volumes -d '{"name":"data","region":"iad","size_gb":10}'` · grow (never shrink): `flyapi PUT apps/<APP>/volumes/<VOL>/extend -d '{"size_gb":20}'`, whose answer carries `needs_restart` · snapshot: `flyapi POST apps/<APP>/volumes/<VOL>/snapshots`. Mount it at create with `"mounts":[{"volume":"<VOL>","path":"/data"}]`; one volume serves exactly one machine, in its own region
- App secrets: `flyapi POST apps/<APP>/secrets -d '{"values":{"API_KEY":"{{secret:MY_API_KEY}}"}}'`, writing the `{{secret:name}}` reference straight into the JSON so the sandbox substitutes the real value as the command runs and you never see it. A machine reads secrets when it is created or updated, so an existing one needs an update afterwards to pick the new value up
- A new app, and deleting one: `flyapi POST apps -d "{\"app_name\":\"<NAME>\",\"org_slug\":\"$FLY_ORG\"}"` · `flyapi DELETE apps/<NAME>` takes its machines and volumes with it

## Deploying a new build

There is no `fly deploy` from here; a deploy is push an image, then point machines at it. Mint an app-scoped
registry credential with `flyapi POST apps/<APP>/deploy_token -d '{"expiry":"1h"}'`, `docker login
registry.fly.io -u x -p <token>`, push `registry.fly.io/<APP>:<tag>` (needs the Docker capability in this
sandbox), then update each machine's `config.image` and `wait` for `started` one machine at a time. With no
Docker, deploy an image that already sits in a registry Fly can pull.

Notes: a started machine bills for its CPU and RAM every second it is up; a stopped or suspended one bills only
for its volume, so stop what you finished with rather than leaving it idle. States run `created` → `starting` →
`started` → `stopping` → `stopped` (plus `suspended`, `replacing`, `destroying`, `destroyed`), and only the
machine's own events explain a stop you did not ask for. When you are making a series of edits to one machine,
hold `POST apps/<APP>/machines/<ID>/lease -d '{"ttl":60}'` and release it after: a conflict means another writer
(often someone's `fly deploy`) holds it, and forcing past that is how two writers half-apply two configs.
