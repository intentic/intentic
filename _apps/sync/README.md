# @intentic/sync

Keeps a folder on your own computer in step with a sandbox, both ways, so you can use your own editor.

One HTTP enrollment call, then Mutagen over the tunnel's SSH. After that the directory on your laptop and the
workspace in the box are the same directory, and your editor never needs to know a container exists.

## Responsibilities

- Enrol: one call that exchanges a code for the connection details.
- Hold the SSH connection over the tunnel, and rebuild it when it drops.
- Drive Mutagen: create the session, watch it, report what it is doing.
- Bridge git, so operations behave sanely across the mirror.
- Install itself as an autostarting background agent.

## Key files

- [src/mirror.ts](src/mirror.ts) — the sync session's lifecycle, and what it does when things go wrong.
- [src/mutagen.ts](src/mutagen.ts) — driving the Mutagen binary.
- [src/ssh.ts](src/ssh.ts) — the tunnel connection under it.
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
