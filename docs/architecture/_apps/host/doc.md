# @intentic/host

The small agent you install on your own computer so the sandbox can work there.

```stats
{
  "items": [
    {"label": "Lines", "value": "2.2k"},
    {"label": "Files", "value": "24"},
    {"label": "Used by", "value": "0 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

Some work is only possible on the user's own machine — their files, their shell, their logged-in
browser, their screen. A sandbox cannot reach a laptop: it is behind NAT, a proxy and a closed lid.
So the laptop dials out, holds one ordinary outbound WebSocket, and everything the agent asks for
travels over it. No open ports, no VPN, no router configuration.

```dag
{ "title": "Its neighbours", "direction": "LR",
  "nodes": [
    {"id": "_apps/host", "label": "host", "note": "this package", "accent": "2"},
    {"id": "_libs/browser", "label": "browser", "note": "it uses", "accent": "2"},
    {"id": "_libs/desktop", "label": "desktop", "note": "it uses", "accent": "2"},
    {"id": "_libs/local-agent", "label": "local-agent", "note": "it uses", "accent": "2"},
    {"id": "_libs/sandbox-contract", "label": "sandbox-contract", "note": "it uses", "accent": "2"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"}
  ],
  "edges": [
    {"from": "_apps/host", "to": "_libs/browser"},
    {"from": "_apps/host", "to": "_libs/desktop"},
    {"from": "_apps/host", "to": "_libs/local-agent"},
    {"from": "_apps/host", "to": "_libs/sandbox-contract"},
    {"from": "_apps/host", "to": "_tools/tsconfig", "dashed": true}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within The sandbox (10 of 13)",
  "items": [
    {"label": "sandbox", "value": 87958, "display": "88.0k", "accent": "2"},
    {"label": "sandbox-contract", "value": 13428, "display": "13.4k", "accent": "2"},
    {"label": "sync", "value": 2744, "display": "2.7k", "accent": "2"},
    {"label": "host (this one)", "value": 2244, "display": "2.2k", "accent": "2"},
    {"label": "scaffold", "value": 1925, "display": "1.9k", "accent": "2"},
    {"label": "webchat-widget", "value": 1457, "display": "1.5k", "accent": "2"},
    {"label": "desktop", "value": 1251, "display": "1.3k", "accent": "2"},
    {"label": "acp-bridge", "value": 1001, "display": "1.0k", "accent": "2"},
    {"label": "local-agent", "value": 687, "display": "687", "accent": "2"},
    {"label": "sandbox-run", "value": 650, "display": "650", "accent": "2"}
  ] }
```

## The two decisions that shape it

**The machine placed the call, and the machine is the server.** After a plain-JSON hello carrying
the enrollment token, the socket becomes a typed contract link, and this package serves it while the
daemon holds the client. That inversion is what makes validation and error shape the link's problem
instead of hand-rolled framing.

**The tool list lives here, not in the sandbox.** One procedure on that contract is deliberately
untyped and carries the agent's tool traffic verbatim. If the contract described each tool, this
computer could not learn a new one without a matching daemon release. What the machine can do is
decided in `src/mcp.ts`, and whether it is *allowed* is decided in `src/policy.ts` — the single
place a scope is checked, on the machine rather than in the sandbox that asked.

## Where it is used

Installed by the owner from a capability card's one-liner, and published to npm as `intentic-host`.
The sandbox's half of the conversation is `_apps/sandbox/src/hosts/`.
