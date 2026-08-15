---
name: cloudflare
description: Manage Cloudflare DNS, zones, cache, tunnels, Workers and Pages via the Cloudflare API. Use when the user asks about their domains, DNS records, cache purging, or apps hosted on Cloudflare.
---

# Cloudflare (connected)

Token in `$CLOUDFLARE_API_TOKEN`; `$CLOUDFLARE_ACCOUNT_ID` may be set too (when empty, list accounts below).
Base is `https://api.cloudflare.com/client/v4`. Define this helper once per shell —
`cf <METHOD> <path> [-d '<json>']`:

```sh
cf() { local m="$1" p="$2"; shift 2; curl -s -X "$m" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" "https://api.cloudflare.com/client/v4/$p" "$@"; }
```

Every response is an envelope `{success, errors, result, result_info}` — check `.success` and on `false` read
`.errors[] | {code, message}` instead of assuming the shape of `.result`. The token is scoped: an empty list or
a 403 often means the permission or zone was never granted, so say which grant is missing rather than "it's not
there". **DNS edits and cache purges change live traffic — say what you are about to do first, then report.**

- Token ok?: `cf GET user/tokens/verify | jq '.result.status'`
- Accounts: `cf GET accounts | jq -c '.result[] | {id, name}'`
- Zones (domains): `cf GET "zones?per_page=50" | jq -c '.result[] | {id, name, status, paused}'`
- A zone id by name: `cf GET "zones?name=example.com" | jq -r '.result[0].id'`
- DNS records: `cf GET "zones/<ZONE_ID>/dns_records?per_page=100" | jq -c '.result[] | {id, type, name, content, proxied, ttl}'`
- Create a record: `cf POST zones/<ZONE_ID>/dns_records -d '{"type":"A","name":"app.example.com","content":"203.0.113.7","proxied":true,"ttl":1}'` — `ttl: 1` means automatic; `proxied: false` is grey-cloud DNS-only
- Update / delete a record: `cf PATCH zones/<ZONE_ID>/dns_records/<RECORD_ID> -d '{"content":"..."}'` · `cf DELETE zones/<ZONE_ID>/dns_records/<RECORD_ID>`
- Purge cache: `cf POST zones/<ZONE_ID>/purge_cache -d '{"files":["https://example.com/path"]}'` — prefer listed URLs; `{"purge_everything":true}` only when the user asks for it
- A zone setting: `cf GET zones/<ZONE_ID>/settings/ssl | jq '.result.value'` (also `always_use_https`, `development_mode`, …) · flip one: `cf PATCH zones/<ZONE_ID>/settings/development_mode -d '{"value":"on"}'`
- Workers scripts: `cf GET "accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts" | jq -c '.result[] | {id, modified_on}'`
- Pages projects: `cf GET "accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects" | jq -c '.result[] | {name, subdomain, domains}'` · its deployments: `cf GET "accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/<NAME>/deployments" | jq -c '.result[] | {id, environment, url, created_on, status: .latest_stage.status}'`
- Tunnels: `cf GET "accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel?is_deleted=false" | jq -c '.result[] | {id, name, status}'`
- R2 buckets: `cf GET "accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets" | jq -c '.result.buckets[]'` — listing only; the objects inside speak S3 and need their own R2 access keys, which this token is not

Notes: paginate with `?page=N&per_page=50` and read `.result_info | {page, total_pages}`. `wrangler`, if
installed, picks up these same two env vars and needs no login. A proxied (orange-cloud) record hides the
origin IP — turning `proxied` off exposes it, so don't do that as a side effect of another edit.
