# Architecture

intentic is a **co-piloted specialized-agent workspace**: each agent runs in its own sandbox on hardware you
own, and from a browser you configure its context, supervise its work, and approve the calls that matter.

This page is an index. Each page below is one subject, short enough to read whole — which the 1,226-line
document this replaced was not: it was opened thirty-seven times in a month of agent sessions and read to the
end almost never, because reading it cost more than the answer was worth.

## The product

- [topology.md](docs/architecture/topology.md) — the shape of the running system: the two tiers, the lifecycle
  of a sandbox, and the DNS that makes both reachable.
- [sandbox.md](docs/architecture/sandbox.md) — the daemon inside the box: one process that owns the files,
  serves the editor and drives every agent turn.
- [platform.md](docs/architecture/platform.md) — the hosted plane, the line between it and the product, and
  what happens as the fleet grows.
- [app-plane.md](docs/architecture/app-plane.md) — the editor and its surfaces: personas, the VPN, geo exits,
  and the two dependency islands that belong to nothing else.
- [extensions.md](docs/architecture/extensions.md) — how a feature is added without touching the core.
- [capabilities.md](docs/architecture/capabilities.md) — what a capability is, and what the daemon does with
  one once it is connected.

## The repository

- [packages.md](docs/architecture/packages.md) — every workspace package and the one job it holds.
- [conventions.md](docs/architecture/conventions.md) — the rules the tree is held to, and the check that holds
  it to them.
- [testing.md](docs/architecture/testing.md) — the tiers a suite runs in and what each one needs.
- [repo.json](docs/architecture/repo.json) / [repo.md](docs/architecture/repo.md) — the repository-level map:
  which packages form which component. `index.json` beside them is generated.

## Not the product

- [deploy-engine.md](docs/architecture/deploy-engine.md) — the bundled deployment engine: intent → needs →
  desired state → reconcile. It ships in this monorepo and is one of the many tools an agent can run.

See [AGENTS.md](AGENTS.md) for the code-style rules every change must follow, and each package's own
`README.md` for what that package is — those are the map an agent actually reads.
