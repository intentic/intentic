# @intentic/ext-pi-agent

The [Pi coding agent](https://pi.dev) as a chat provider: declared here, served by the daemon's own Pi
runtime rather than ACP.

## Responsibilities

- Declare the reserved `pi` agent capability, so the fleet can offer Pi as a choice of who runs a turn.
- Carry the image fragment that bakes the Pi CLI into the sandbox (a one-time rebuild on install).

## Key files

- [intentic-extension.json](intentic-extension.json): the one capability and the environment fragment. This
  file IS the package; there is no `src/` and no skills directory.
- [env/pi.Dockerfile](env/pi.Dockerfile): `npm install -g` for the Pi CLI, composed into the image overlay.
- [package.json](package.json): the manifest that makes it a package at all.

## How it fits

Pi deliberately speaks no ACP: its embedding surface is its own RPC mode (strict-LF JSONL over stdio). So
unlike the `acp-agents` cards, whose ids are ordinary and land on the generic ACP floor, the `pi` id is
RESERVED in the contract's agent catalog: `capabilitiesOf("pi", …)` names the `pi` runtime, and
`_sandbox/sandbox/src/pi/` is what drives it. That runtime is why this card exists at all: it carries
abilities the ACP floor cannot: real mid-turn steering (Pi's `steer` queue), reasoning-effort control
(`set_thinking_level`), and a published slash-command list.

Pi owns its own model catalog and credentials: API keys ride the capability's environment block, and
subscription logins (`/login` inside Pi) persist in Pi's own store in the container: installed means
runnable, the `agent`-kind convention.

## Conventions & gotchas

- The `id` must stay `pi`: it is the contract's reserved name for this runtime. Renaming the card's display
  name is free; renaming the id would silently demote it to an ACP agent that speaks no ACP.
- Nearly the smallest package in the repository, deliberately: a capability that needs logic is not a
  capability. The logic lives behind the daemon's adapter seam.
