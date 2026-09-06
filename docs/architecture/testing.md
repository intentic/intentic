# Local end-to-end testing

The tiers a suite can run in, what each one needs, and how a gated suite stands down instead of failing.

`createProviders()` ([_deploy/providers/src/providers.ts](../../_deploy/providers/src/providers.ts)) assembles the
full `ResourceType → Provider` map: the single seam between a compiled graph and execution. Passing
fakes drives the whole suite in-memory ([suite.engine.test.ts](../../_deploy/providers/src/suite.engine.test.ts));
passing nothing uses the real SSH/Cloudflare/Forgejo/Komodo implementations.

[cli.e2e.test.ts](../../_deploy/cli/src/cli.e2e.test.ts) is a **manual, real** run that drives the actual CLI
exactly as an operator would. It boots a Docker-in-Docker "host"
([_tools/dind-host/Dockerfile](../../_tools/dind-host/Dockerfile)) via `testcontainers`, scaffolds with `init`, authors a
`deploy.config.ts` pointed at the host's mapped SSH port (with a per-run generated key), fills
`desired-state/.env`, then runs `resolve` + `apply`. Phase 1 stands up the platform (Forgejo + its Actions
runner + Komodo + the workspace sandbox) and exposes `git.<zone>`/`deploy.<zone>` through a **real
Cloudflare tunnel**; phase 2 pushes a
tiny Dockerfile and authors an environment so `apply` wires CI/CD: the Forgejo Actions workflow builds +
pushes the image and Komodo rolls it out live at `app.<zone>`. It asserts the platform containers are up,
the public URLs respond, and the app serves its body, then purges the Cloudflare DNS + tunnel it created.

It is gated behind `INTENTIC_E2E` **and `CLOUDFLARE_API_TOKEN`**: both, so the suite stands down rather than
fails wherever its live credentials are absent, which is what lets the nightly CI job (`nightly.yml`'s `e2e`) run
`pnpm e2e` unconditionally and get whatever the pipeline's variables unlock. It is excluded from `pnpm test`
either way. Run it from the repo root with `pnpm e2e`: turbo builds the libs (`^build`) and each package's
e2e script sets the switch. That command asks **every** gated tier to run, and the ones you hold no
credentials for stand down; you supply only a Cloudflare token here (and, optionally, the zone to deploy
under). The host SSH key is generated per run, and the Forgejo/Komodo admin passwords are intentic-generated:

```sh
CLOUDFLARE_API_TOKEN=...        # Account → Tunnel → Edit; Zone → DNS → Edit; Zone → Zone → Read
CLOUDFLARE_ZONE=example.com \   # a zone you own — DNS records + a tunnel are created and then deleted
pnpm e2e
```

> Networking: providers run nested containers with `--network host`, so the engine reaches services at
> the host's internal IP and port. This works from a Linux/WSL2 host (routable bridge IPs); on Docker
> Desktop (macOS/Windows) run the harness as a sibling container on the same network.

### The hermetic tier (no secrets, runs on every MR)

[hermetic.e2e.test.ts](../../_deploy/cli/src/hermetic.e2e.test.ts) covers the deployment path that actually
breaks in the field: the **derived** Forgejo + runner + Komodo control plane coming up on a real Docker
host, with zero external dependencies. Two existing seams make it hermetic: an authored `zone` in
`i.have.cloudflare` resolves the artifact fully offline (the dummy token is never sent anywhere), and
`apply --target host-git,host-git-runner,host-deploy` reconciles a slice whose inputs reference nothing
but the host (pinned by a contract test in [_deploy/sdk/src/index.test.ts](../../_deploy/sdk/src/index.test.ts)).
The suite boots the same DinD host, then asserts: offline resolve derives the platform nodes; the targeted
apply converges with the real engine-level SSH readiness gate; a second apply is all-noop; `adopt
--baseUrl http://<host>:<mapped-3000>` pushes the intent + desired-state repos into the real Forgejo and
sets the Actions secrets, idempotently; and a reproduced readiness failure (the service healthy on
localhost but its `internalUrl` firewalled: the field failure class) prints the SSH diagnostic sweep
(`readinessDiagnostics` in [_deploy/providers/src/core/ssh-diagnostics.ts](../../_deploy/providers/src/core/ssh-diagnostics.ts):
docker state, the node's logs, listeners, addresses, one verbose probe) before the
`ReadinessTimeoutError` propagates. The same sweep runs on any real `intentic deploy apply` readiness timeout.

Run it locally with `pnpm e2e:hermetic` (privileged local Docker, Linux/WSL2). In CI it runs on
every pull request as a **non-blocking** sidecar (`e2e-hermetic` job, `continue-on-error: true`), pulling
the published `dind-host:latest` image (falling back to building [_tools/dind-host](../../_tools/dind-host)) and uploading
the CLI run logs as artifacts on failure. In the field `adopt` needs no flag at all: its default
transport is an SSH port-forward to Forgejo on the host (public DNS never enters the path); `--baseUrl`
remains an explicit transport override for reaching Forgejo over an already-mapped address like this test's.

### What each tier needs

`pnpm e2e` asks every gated tier to run at once, which only works because a tier that cannot reach its
service stands down instead of failing. Each declares its own requirement with `e2eTier`
([_tools/testing/src/e2e.ts](../../_tools/testing/src/e2e.ts)): the opt-in switch it reads, and the credentials it
is useless without:

| Tier | Suite | Needs beyond a Docker daemon |
| --- | --- | --- |
| sandbox-daemon | [sandbox.e2e.test.ts](../../_sandbox/sandbox/src/e2e/sandbox.e2e.test.ts) | nothing |
| cloudflare | [cli.e2e.test.ts](../../_deploy/cli/src/cli.e2e.test.ts) | `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ZONE` to pick the zone) |
| discord | [discord.e2e.test.ts](../../_sandbox/sandbox/src/e2e/discord.e2e.test.ts) | `DISCORD_E2E_BOT_TOKEN` + `_SENDER_TOKEN` + `_CHANNEL_ID`; `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` unlocks the real-agent-turn spec |

A tier that is asked to run and finds a credential missing puts the variable's name in its own suite title,
which is what vitest prints beside the `↓`: so the nightly's log states which tiers ran without anything
logging it. Widening the nightly is adding a protected CI variable, not editing a job. The credentials a
tier declares and the `passThroughEnv` list on turbo's `e2e` task are the same statement written twice: a
variable absent from `turbo.json` never reaches the suite, however CI is configured.

Two tiers deliberately sit outside that command, each under its own turbo task, and neither declares
credentials because neither needs any:

- **hermetic** ([hermetic.e2e.test.ts](../../_deploy/cli/src/hermetic.e2e.test.ts), `pnpm e2e:hermetic`): needing no
  secrets at all is exactly what earns it a run on every merge request rather than nightly, so it reads its
  own switch and must not wake with the gated ones.
- **browser** ([_tools/e2e](../../_tools/e2e), `pnpm e2e:browser`): a dev-machine tier. Its whole stack answers on
  `localhost`, and every CI job here drives a docker-in-docker *service* that publishes ports on its own
  namespace, so sharing the `e2e` name only ever swept it into a nightly it could not pass.
