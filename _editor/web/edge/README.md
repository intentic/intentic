# Editor edge failover

A Cloudflare Worker in front of app.intentic.dev that passes every request to the nginx origin and, only when the
origin fails, answers from a copy of the released editor kept at the edge.

app.intentic.dev is an nginx container (`../Dockerfile`) on the same box and Cloudflare tunnel as the platform api and
Postgres. When that box is down the editor answers Cloudflare's 52x/530, and nobody can load it unless the service
worker (`../public/sw.js`) already kept a copy for them. The editor's outage mode opens remembered sandboxes without
the platform, but it still needs the page to load. This Worker is the copy for everyone else.

## Key files

- [worker.ts](worker.ts): pass-through, the rule for when the copy answers, and how the copy's answers are dressed.
- [deploy-edge.sh](deploy-edge.sh): builds the copy from a release's web image plus the live origin, uploads it, and
  reads it back.
- [wrangler.jsonc](wrangler.jsonc): the Worker `intentic-app-edge`, its asset binding, and no routes yet.
- [../../../\_tools/scripts/platform/ship-web.sh](../../../_tools/scripts/platform/ship-web.sh): the release step
  that runs deploy-edge.sh once the origin serves the release.

## When the copy answers

The Worker uses the same rule as sw.js `fallsBack`. The origin has failed when:

- the subrequest throws;
- it answers 500 or 502–599 (501 counts as a real answer);
- a GET or HEAD gets no response headers within 10 s for a navigation, or 15 s for anything else.

A healthy nginx answers in well under a second. Cloudflare gives up on an unreachable origin only after about 19 s
(522) or 100 s (524), so the deadlines cover a box that hangs rather than refuses. The clock stops when the headers
arrive, so a slow download on the visitor's side never triggers it. The service worker waits 15 s before using its own
copy, so the Worker's copy reaches the browser first.

The copy never answers a write (anything but GET or HEAD), `/wire/` (the PostHog proxy) or a request with a Range
header. Those always get the origin's answer, failure included.

Inside the copy, a file is served as itself. Any other path gets index.html, except under `/assets/` and `/fonts/` and
for `/.well-known/assetlinks.json`, the paths nginx answers 404 for. When the copy has no such file, the visitor gets
the origin's own error response, or a 502 if the origin never answered. That 502 is the status sw.js uses as its cue
to fall back to its own copy. When a deadline passes and the copy has no such file, the Worker keeps waiting for the
origin, as sw.js does.

Every answer from the copy carries `x-intentic-served-by: edge-fallback` and the security headers the live shell sent
when the copy was taken (CSP, HSTS, X-Frame-Options, Referrer-Policy, Permissions-Policy, X-Content-Type-Options).
Cache-Control follows nginx.conf's map: `no-store` for the shell and env.js, a year `immutable` for hashed `/assets/`.
These answers never carry `X-Web-Build`, so deploy-platform.sh cannot mistake the copy for the container it is waiting
on. The request header `x-intentic-edge-fallback: force` serves the copy without asking the origin. That is harmless,
since the copy holds only the public editor.

## How the copy ships

The copy follows the release, never runs ahead of it (`ship-web.sh` explains why). After `deploy-platform.sh` has seen
the origin serve the release, `ship-web.sh` runs `deploy-edge.sh <version>`. A rollback runs it too, through
`ship-web.sh`. The script:

1. extracts `/usr/share/nginx/html` from `ghcr.io/intentic/web:<version>` and drops the `.br`/`.gz` twins;
2. replaces `index.html` and `assets/js/env.js` with the origin's copies (the container rewrites both at start, so the
   image holds only placeholders), plus `/.well-known/assetlinks.json` when the origin serves one. It refuses any
   answer that came from the copy itself or from a build other than the image's (`X-Web-Build` against the image's
   `WEB_BUILD`), and any live shell that names a chunk the copy does not have;
3. writes the shell's security headers to `__edge/shell.json`, failing if any of the six is missing;
4. runs `wrangler deploy --assets <dir>`, then reads the shell back through the workers.dev address with the force
   header.

Without `CLOUDFLARE_API_TOKEN` it prints that it is skipping and exits 0. A failed copy is a warning on the release,
not a failure: the editor has already shipped, and the copy left on the release before still opens sandboxes. The
token needs Workers Scripts edit on the account. `deploy-edge.sh --dist <dir> [label]` takes a directory holding a
build instead of the image: a local `_editor/web/dist`, or a mirror of the live site. Its `/assets/` must be the build
the origin serves.

## Testing it

`EDGE_DRY_RUN=1 deploy-edge.sh …` builds the copy, checks it with `wrangler deploy --dry-run`, uploads nothing and
needs no token. It leaves the directory it built so you can read it.

`wrangler dev --assets <dir> --var UPSTREAM:http://127.0.0.1:<port>` points the Worker at a fake origin, which lets
you trigger each failure: a status, a reset connection, or a hang past the deadline. The workers.dev address passes
requests to `UPSTREAM` (https://app.intentic.dev), so it serves the live editor unless the force header is sent.
