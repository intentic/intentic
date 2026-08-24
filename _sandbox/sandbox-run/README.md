# @intentic/sandbox-run

The sandbox container's run contract: every path that creates a sandbox composes its `docker run` from here.

Names, capability posture, the environment allowlist, runtime directives, and the emitter that turns all of it
into a command line. There are several ways a sandbox comes into existence (the CLI, the daemon, the desktop
app); this package is why they cannot disagree about what one is.

## Responsibilities

- Define the container's identity: its name, image, labels and volumes.
- Define its posture: which capabilities it gets, and which it is denied.
- Bound a local workspace to 14 GiB RAM plus 4 GiB swap, so a runaway build or local model is killed inside
  its cgroup instead of exhausting the desktop or WSL VM; hosted providers keep owning their machine limits.
- Define the environment allowlist: what is allowed to cross into the box.
- Emit the `docker run` invocation, correctly quoted.

## Key files

- [src/index.ts](src/index.ts): the contract and the docker-run emitter; the surface every docker-shaped flow uses.
- [src/fly.ts](src/fly.ts), the hosted flavor: the same contract emitted as a Fly Machine config (one VM per
  sandbox, one volume standing in for the three docker ones, cloudflared in-box behind the `SANDBOX_VM` switch).
- [src/quote.ts](src/quote.ts): shell quoting, which is the part that is easy to get subtly wrong.
- [src/quote-contract.integration.test.ts](src/quote-contract.integration.test.ts): the emitted command run for
  real, because a quoting bug is invisible to a unit test that only compares strings.

## How it fits

Consumed by every creation path. It depends on nothing that would stop a browser importing it, which is
deliberate: the UI that offers to create a sandbox and the daemon that creates one describe it identically.

## Conventions & gotchas

- The allowlist is a floor, not a suggestion. Anything not named does not cross into the container, and widening
  it is a security decision rather than a convenience one.
