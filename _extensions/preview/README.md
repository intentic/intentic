# @intentic/ext-preview

What the outside world can reach: the ports the box is forwarding, and the files in `public/`.

## Responsibilities

- List what is listening inside the box: each port NAMED, with a sentence saying what it does and who started
  it, the terminal it is running in, and what the tunnel currently exposes: and let exposure be revoked.
- Show what is published from the workspace's `public/` folder with nothing running at all.

## Key files

- [src/usePorts.ts](src/usePorts.ts): what is listening, what is forwarded, and revoking it.
- [src/PortRow.vue](src/PortRow.vue), one port as a row: the name and the sentence up front, the command,
  folder, terminal and address behind the row's own disclosure.
- [src/usePublic.ts](src/usePublic.ts): the `public/` folder as a served surface.
- [src/extension.ts](src/extension.ts): activation, and why neither view is a rail tile.

## How it fits

LOOKING at a running app is not this extension's job: that is the shell's own Preview area (a rail tile whose
panel pops out like the chat), which previews repos' dev servers, monorepo apps and the public page from the
same daemon routes. This extension used to carry a per-repo dev-server iframe as a fallback directory view;
one preview surface is enough.

Ports and Public are **Sandbox hub tabs**, not rail tiles. Both answer "what can the outside reach": Ports while
something is running, Public with nothing running: which is a fact about the box, alongside Status and Access.
The everyday path to a dev server is already elsewhere: Ctrl+clicking the localhost URL a terminal printed
forwards and opens it. The rail carries only the EXPOSURE signal: an indicator that appears exactly while a port
is forwarded, the way a VPN shield does.

## Conventions & gotchas

- Everything in `public/` is served to anyone with the link, with no sign-in. The view says so where it matters;
  the directory not existing means nothing is published.
- A row leads with WHAT is listening, not with what it ran. The name, the sentence and the origin come off the
  wire (the daemon's `ports/port-identity.ts`), so this view never parses an argv itself and the desktop mirror,
  the rail and this list can't disagree about what a port is. The argv is still there: under the row's
  disclosure, where somebody debugging will look for it and nobody else has to read it.
- A port is reported with the terminal it descends from, so the row is somewhere to GO, not just something to
  read. Ports with none (the box's own runtimes, a container's published port) simply show no terminal chip,
  and the disclosure says why: nothing here can show their output or stop them, and a button that opens an empty
  panel is worse than the plain fact.
- The two groups answer "is this mine?" before anything else. Your services lead; the sandbox's own machinery is
  muted below with a hint saying it came with the box, because "did I start this?" is the question the section
  provokes and "no" is what makes it safe to skip.
