# The platform

The hosted plane behind app.intentic.dev: sign-in, the registry of every user's sandboxes, the edge that makes them reachable, hosted machines and billing.

```mermaid
flowchart LR
    browser["Browser"] --> web["web SPA<br/>app.intentic.dev"]
    browser -- "oRPC · sign-in" --> api(["api<br/>api.intentic.dev"])
    api --> db[("Postgres<br/>prisma schema")]
    api -- "Fly Machines API" --> hosted["Hosted sandbox<br/>Fly machine"]
    browser -- "sandbox-id hostname" --> ingress(["ingress<br/>*.sbx.intentic.dev"])
    ingress -- "does it exist?" --> api
    ingress -- "tunnel" --> own["User's sandbox<br/>own machine"]
    ingress -- "fly-replay" --> hosted
```

| Package | Role |
| --- | --- |
| [api](api) | Hono + oRPC server: accounts, sandbox registry, hosted machines, billing. |
| [ingress](ingress) | Edge routing sandbox hostnames to tunnels or Fly replays. |
| [prisma](prisma) | Postgres schema, migrations and the generated client. |

The SPA served at app.intentic.dev is [`_editor/web`](../_editor/web), and the contract between it and the api is [`@intentic/api-contract`](../_shared/api-contract).
