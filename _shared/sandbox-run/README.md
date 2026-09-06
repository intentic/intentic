# @intentic/sandbox-run

The sandbox container's run contract: every path that creates a sandbox composes its `docker run` from here.

Names, capability posture, the environment allowlist, runtime directives, and the emitter that turns all of it
into a command line. There are several ways a sandbox comes into existence (the CLI, the daemon, the desktop
app); this package is why they cannot disagree about what one is.

## Responsibilities

- Define the container's identity: its name, image, labels and volumes.
- Define its posture: which capabilities it gets, and which it is denied.
- Bound a local workspace to its share of the machine, and carry the owner's own asks about that share. The
  derived memory cap is everything the docker engine has minus a fixed 3 GiB the host keeps (floor 4 GiB,
  swap unbounded; `index.ts` says why each of those replaced a fraction and a no-swap rule that froze real
  machines). CPUs are unbounded unless asked. Three replayed env vars carry what the owner asked for instead,
  said once ON the container and re-emitted onto every container that replaces it: `SANDBOX_MEMORY` (whole
  GiB, held inside the same bounds), `SANDBOX_CPUS` (whole cores, at most the engine's), and `SANDBOX_RUNTIME`
  (allowlisted directives the owner added beyond the approved overlay's, `--privileged`, `--gpus=all`). The
  run carries the UNION of the overlay's directives and the owner's, and stamps the overlay's half on the
  container as `SANDBOX_OVERLAY_RUNTIME`, so a reader can tell a capability's demand (which a view draws locked)
  from an owner's ask (which they may withdraw). The policy is pure arithmetic so this package stays
  browser-importable; the caller that can measure (`intentic sandbox run-command`, inside the image) reads
  /proc and the probe's own env for the seeds and passes the results in. Hosted providers keep owning their
  machine limits.
- Define the environment allowlist: what is allowed to cross into the box.
- Carry an optional sandbox definition (`definition`, a `sandbox.toml` text) into the box as
  `SANDBOX_DEFINITION_SEED` (base64, so its quotes and newlines never meet a shell): the daemon seeds an EMPTY
  workspace from it on first boot — repos cloned, connections listed unauthenticated, the overlay parked at the
  approval gate — which is how one definition stamps out a fleet.
- Emit the `docker run` invocation, correctly quoted.

## Key files

- [src/index.ts](src/index.ts): the contract and the docker-run emitter; the surface every docker-shaped flow uses.
- [src/fly.ts](src/fly.ts), the hosted flavor: the same contract emitted as a Fly Machine config (one VM per
  sandbox, one volume standing in for the three docker ones, the `SANDBOX_VM` switch, the approved overlay's
  hash as `SANDBOX_ENVIRONMENT_HASH` when the image was built from one), the shape of the one other machine a
  hosted sandbox runs (`flyBuildMachineConfig`: the builder the platform creates in the sandbox's app to build
  that overlay, its recipe delivered as `files`, no volume, no restart), plus the one thing a
  docker run never declares: the machine's **front door**, the preview proxy as a Fly service with a health
  check under the sandbox's own hostname, because a hosted machine is reached by a replay from the platform's
  edge rather than through a tunnel it dials.
- [src/quote.ts](src/quote.ts): shell quoting, which is the part that is easy to get subtly wrong.
- [src/quote-contract.integration.test.ts](src/quote-contract.integration.test.ts): the emitted command run for
  real, because a quoting bug is invisible to a unit test that only compares strings.

## How it fits

Consumed by every creation path. It depends on nothing that would stop a browser importing it, which is
deliberate: the UI that offers to create a sandbox and the daemon that creates one describe it identically.

## Conventions & gotchas

- The allowlist is a floor, not a suggestion. Anything not named does not cross into the container, and widening
  it is a security decision rather than a convenience one.
