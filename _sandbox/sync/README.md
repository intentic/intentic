# @intentic/sync

Keeps a folder on your own computer in step with a sandbox, both ways, so you can use your own editor.

One HTTP enrollment call, then Mutagen over SSH. After that the directory on your laptop and the workspace in
the box are the same directory, and your editor never needs to know a container exists.

The SSH goes through the sandbox's own web address rather than a tunnel of its own: this agent listens on a
loopback port and carries each connection to the sandbox daemon over a WebSocket, which hands it to the sshd in
the container. That is why syncing works the same for every sandbox — one served by the platform, one behind
its owner's domain, one on plain loopback — instead of depending on whether that sandbox's reachability happens
to carry raw TCP. It also means nothing but this agent has to be installed.

## Responsibilities

- Enrol: one call that exchanges a code for the connection details.
- Serve the SSH transport on loopback, and carry it to the sandbox over its own web address.
- Drive Mutagen: create the session, watch it, report what it is doing.
- Bridge git, so operations behave sanely across the mirror.
- Install itself as an autostarting background agent.

## Key files

- [src/mirror.ts](src/mirror.ts) — the sync session's lifecycle, and what it does when things go wrong.
- [src/mutagen.ts](src/mutagen.ts) — driving the Mutagen binary.
- [src/tunnel.ts](src/tunnel.ts) — the transport: a loopback port that IS the sandbox's sshd.
- [src/ssh.ts](src/ssh.ts) — the ssh config that points Mutagen at it.
- [src/git-bridge.ts](src/git-bridge.ts) — making git behave across the mirror.
- [src/autostart.ts](src/autostart.ts) — installing as a background agent, per platform.
- [src/commands.ts](src/commands.ts) — the CLI surface a user actually types.

## How it fits

Runs on the user's machine, not in the sandbox — one of the `@intentic/*` programs that live on your own
hardware. It shares the install-and-stay-alive plumbing in `@intentic/local-agent` with the other two.

## Conventions & gotchas

- **Bidirectional sync has no undo.** The integration tests here run against real directories and a real Mutagen
  for exactly that reason; a unit test that mocks the sync proves nothing about the case that loses work.
- Enrollment is one call on purpose. Every additional step is a step a user performs wrong on a bad connection.
- The transport lives in the background watcher, not in `setup`. `setup` therefore starts the watcher BEFORE it
  probes ssh or hands anything to Mutagen — every step after that one needs the port to be open.
