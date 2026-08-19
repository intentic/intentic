---
name: provide
description: Turn the owner's existing API, model, or dataset into a paid service on the platform's services catalog — build the thin wrapper endpoint, self-test it against the admission probe's three checks, and hand the owner the exact values the listing form needs. Use when the owner wants to sell, list, or offer something they already run as a metered service agents can pay for.
---

# Offer a paid service

The platform's services catalog (the one `services list` reads) is open admission: anyone who proves a
publisher name and connects payouts can list an endpoint, and it goes live the second it passes the
published gates — no human review. A service is **not** an extension: no manifest, no bundle, no repo. It
is ONE public https endpoint that (1) verifies the platform's signature on every call and (2) answers an
NDJSON stream — `status` lines while it works, exactly one `result` that ends the run.

The owner usually already runs the thing worth selling. Your job is the thin wrapper around it, the
self-test, and a clean hand-off; the listing itself is filed by the owner in **Settings → Services**
(prerequisites: a claimed publisher name and payouts, both under Settings too — the agent cannot and must
not do those steps). A publisher name is proved from a registry-listed repository OR by claiming a
**domain**: the claim screen hands the owner one line to serve at `https://<domain>/.well-known/intentic-claim`,
which is the natural lane for a business with no extension — note that a domain publisher's endpoints must
then live on that domain or its subdomains.

## 1. Build the wrapper

Write a small standalone service (own repo or a directory in theirs) that fronts the owner's existing
API. The whole contract, verbatim:

**Verify every POST.** The platform sends `x-intentic-timestamp` and
`x-intentic-signature = HMAC-SHA256(secret, "{timestamp}.{body}")` — the Stripe webhook scheme. Recompute,
compare constant-time, refuse timestamps more than ~5 minutes from now. The signature is the entire auth
story: an endpoint that serves unsigned calls can be billed by anyone on the internet against the owner's
own upstream costs, and the admission probe refuses to list it.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

const verify = (body, timestamp, signature, secret) => {
    const at = Number(timestamp);
    if (!timestamp || !signature || !Number.isFinite(at) || Math.abs(Date.now() / 1000 - at) > 300) return false;
    const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    const a = Buffer.from(signature, "utf8");
    const b = Buffer.from(expected, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
};
```

**Answer NDJSON.** Content-type `application/x-ndjson`, one JSON object per line:
`{"event":"status","text":"…"}` as often as progress deserves (each replaces the last on the buyer's card —
a spinner label, not a log), then exactly one `{"event":"result","data":<the answer>}`. The whole run must
finish inside five minutes and two megabytes; a stream that ends without its `result` is refunded, which
means the owner served for free.

**Map outcomes honestly.** The owner's API succeeded → stream the result. The buyer's request was bad →
answer a complete 4xx JSON body (the buyer pays for it; "your query was malformed" is service). The owner's
API fell over → answer a 5xx (the platform refunds; nobody pays).

Do the work by calling the owner's existing endpoint server-side with their own credential, from an
environment variable — the wrapper is the only thing that ever holds it, and the platform never sees it.

Two working references you can read whole: intentic's example provider (a complete dependency-free file at
`_platform/example-provider/src/provider.ts` in the intentic repo, github.com/intentic) and the contract's
forwarding side (`_platform/api/src/pool/pool-services.ts`, same repo).

## 2. Self-test against the probe, locally

The platform's health check sends three calls; reproduce them against the wrapper on localhost before
anything is deployed, with a throwaway secret. Write and run this (adjust URL, secret, and the sample body
the owner's endpoint really serves):

```js
// probe-check.mjs — the admission probe's three checks, locally. node probe-check.mjs
import { createHmac } from "node:crypto";
const URL = process.env.URL ?? "http://127.0.0.1:8790";
const SECRET = process.env.SECRET ?? "test-secret";
const BODY = process.env.BODY ?? JSON.stringify({ query: "a worked example" });
const signed = (at) => createHmac("sha256", SECRET).update(`${at}.${BODY}`).digest("hex");
const call = (headers) => fetch(URL, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: BODY });

const now = Math.floor(Date.now() / 1000);
// 1. serves: correctly signed → 2xx NDJSON whose last event is a result.
const ok = await call({ "x-intentic-timestamp": String(now), "x-intentic-signature": signed(now) });
const lines = (await ok.text()).trim().split("\n").map((l) => JSON.parse(l));
console.log("serves:", ok.status < 300 && lines.at(-1)?.event === "result" ? "PASS" : `FAIL (${ok.status}, last=${lines.at(-1)?.event})`);
// 2. rejectsForgery: right shape, wrong bytes → any non-2xx.
const forged = await call({ "x-intentic-timestamp": String(now), "x-intentic-signature": "0".repeat(64) });
console.log("rejectsForgery:", forged.status < 200 || forged.status >= 300 ? "PASS" : "FAIL (served a forged call)");
// 3. rejectsReplay: correctly signed but an hour old → any non-2xx.
const stale = now - 3600;
const replay = await call({ "x-intentic-timestamp": String(stale), "x-intentic-signature": signed(stale) });
console.log("rejectsReplay:", replay.status < 200 || replay.status >= 300 ? "PASS" : "FAIL (served a replayed call)");
```

All three must PASS. The real probe runs check 1 through the platform's actual forwarding code, so also
eyeball that every stream line is a single JSON object with a trailing newline.

## 3. Deploy — the owner's infrastructure, not the sandbox

The listing rules require a **public https host**: no localhost, no private ranges, no `.local`/`.internal`
names — the platform calls it from its own network. The owner already hosts their real service, so the
wrapper deploys the same way (any PaaS, a reverse-proxy route on the existing box, an edge runtime — the
reference file is a plain fetch handler on purpose). If this sandbox has the owner's deploy machinery
connected, offer to ship it there; never serve a paid endpoint from the sandbox itself — its uptime is a
laptop's, and repeated failed canaries suspend the listing.

The signing secret is minted by the platform when the owner drafts the listing and shown **once** — plan
for it to arrive as an environment variable after the draft step, then redeploy and re-run the self-test
with the real value.

## 4. Hand off to Settings → Services

Prepare and present, ready to paste:

- **slug** (lowercase letters, digits, dashes) and **name** (3–60 chars).
- **description** (40–400 chars) — the only prose a buyer reads before paying; say what a run does and
  what comes back.
- **sample request** — a JSON body the endpoint genuinely serves. It is both the probe's test body and the
  worked example every agent shapes its requests after, so make it the service's best self-documentation.
- **price** in credits. The screen states the platform's current band and the probation ceiling (defaults:
  1–200, capped at 25 while new); quote the screen, not this file.

And say what happens next, so nothing surprises the owner: publish puts the listing live **on probation**
(a `new` badge, the tighter price cap) until it has served enough runs at a low refund rate (defaults: 50
runs, under 20% refunded); a canary re-probes it and consecutive failures suspend it; the price may move
once per day; swapping the endpoint URL later drops the listing back to draft for a fresh probe. Refunded
runs are free for the buyer and unpaid for the owner — the wrapper's honest 5xx on upstream failure is what
keeps the refund rate meaning something.

If the catalog might already serve the need, check `services list` first — a second listing of the same
thing competes on description and price, which is fine, but say so.
