# @intentic/sandbox

The **per-project AI-agent dev daemon**, a Docker image that runs as the project's workspace container on the customer's host. It exposes an HTTP API the browser drives **directly** over the sandbox's own tunnel (Google-backed renewable sessions): run provider-native agent turns over the project's repos, run the `intentic` CLI, do git operations, read/write inventory, and report the dev-server preview. Ships to GHCR as `ghcr.io/intentic/sandbox`. A private package (not published to npm).

The daemon runs in one of two **profiles** ([src/platform/boot/profile.ts](src/platform/boot/profile.ts)). `container`
(the default) is everything above. `local` is the same daemon as a plain process on the user's own machine,
serving a folder they already own: for host applications (an editor extension, a CLI) that embed the product
without a sandbox. Local means: loopback only and refuses any env that says otherwise (the fail-closed floor
beside the auth floor), no auth (the person at the keyboard is the owner), HOME never claimed or converged,
repos never reshaped (no separate git dirs, no gitlink surgery: a `.gitmodules`-declared submodule is spared
in *both* profiles), no unasked-for writes to the user's folder (no skill/seed/shelf convergence; the state
dir is appended to the repo's own `info/exclude` instead), and no container furniture (tmux sweeps, preview
proxy, TLS loopback listener, dockerd, CI hooks, probes, automations scheduler, drafts publisher, extension
processes, image-update checks). What stays on is the product the host embeds: agent turns, the fleet with
per-agent worktrees and review/land, accounts and usage, the guard, watchers, search, resume. `/health`
reports the profile.

## Responsibilities

- **Serve the daemon API** the browser drives directly over the sandbox's own tunnel — agent turns, the CLI,
  git, inventory, preview, health — each request authenticated by a session minted from a verified identity.
- **Run every agent turn**: pick the runtime, build the prompt, stream the frames, hold the cards the person
  has to answer, and write down what happened.
- **Own the fleet**: one worktree per conversation, review, land, and the record of where each agent's work went.
- **Own the box**: the environment overlay, the capabilities the owner connected, the secrets they hold, the
  terminals, the watchers, the tunnel and the boot.
- **Keep the workspace true**: the tree, the search, the changes, the pushes, and the state files every view
  refreshes from.

The long form — every surface, and why each one lives here rather than in the editor or the platform — is
[docs/responsibilities.md](docs/responsibilities.md).

## Key files

- [src/app.ts](src/app.ts): the HTTP composition root — every route the browser and the CLI reach, mounted in
  one fixed order, because that order is behaviour.
- [src/composition.ts](src/composition.ts): what is wired to what. Start here to find the owner of a seam.
- [src/agent/](src/agent), **singular**: one conversation — the turn loop (`run/`), what the model is told
  (`prompt/`), what it can do (`tools/`), and whether it proved anything (`verification/`).
- [src/agents/](src/agents), **plural**: the fleet — the roster (`registry/`), the isolated checkouts
  (`worktrees/`) and the work coming back (`land/`).
- [src/runtimes/](src/runtimes): the nine agent runtimes behind one seam ([src/agent/providers/adapter.ts](src/agent/providers/adapter.ts)).
- [src/capabilities/](src/capabilities) and [src/environment/](src/environment): what the owner connected, and
  the image overlay that makes it real.

A directory-by-directory tour is [docs/subsystems.md](docs/subsystems.md); the decisions and the traps are in
[docs/gotchas.md](docs/gotchas.md).

## How it fits

The agent half of the dev plane. The browser talks to this daemon **directly** over the sandbox's own tunnel; the daemon verifies Google identity when establishing a renewable session, resolves the selected provider's credential from its **own** stored accounts, and starts that provider's runtime per turn. The platform is never on this path and never contacts the sandbox: it only stores the sandbox's public URL (which the browser derived and wrote) so the browser knows where to reach it; the browser alone probes the daemon for liveness (`/health` + the `/events` stream).

Native Codex turns use `codex app-server --stdio`. A subscription turn gives app-server a custom Responses
provider aimed at the bundled CLIProxyAPI translator; the translator authenticates upstream with the owner's
connected ChatGPT account, so image generation consumes that subscription rather than an `OPENAI_API_KEY`.
Generated PNGs are copied out of Codex's provider state into `.intentic/records/artifacts/imagegen/`; only the durable
workspace-relative path enters the event stream and transcript. The `@openai/codex-sdk` dependency remains the
exact CLI-version anchor and the locator for a vendored development fallback, not the native turn transport.

Cursor turns run in THIS PROCESS, through `@cursor/sdk` ([src/runtimes/cursor](src/runtimes/cursor)), which makes them the odd
one out twice over. First on shape: there is no child process, so there is no mount namespace to put a turn in
(its worktree is enforced by working directory) and no environment to hand a credential to (the selected
account's key rides the request instead, so the account a turn was planned against is the account it spends).
Second on distribution: `@cursor/sdk` is the one dependency here whose licence grants no redistribution, so it
is pruned out of every published image. An explicit Connect press downloads the pack's pinned copy onto that
owner's running sandbox so sign-in can bootstrap itself; once the credential lands, the daemon composes the
same pack into the owner-approved overlay for the next recreation. The module stays dynamically loaded, so a
sandbox that has never asked for Cursor boots cleanly without it.

What that buys is the second-richest capability row in the catalog. The daemon's own functions can BE tools
(`customTools`), so a Cursor turn gets a real question card while Cursor's own `askQuestion` is withheld — in
headless runs it has been reported to answer itself with a fabricated "Questions skipped by the user", which is
consent nobody gave. Plan mode is Cursor's own read-only posture rather than this repo's prompt-level
emulation. And the owner's command rulebook is enforced at the full `hooks` tier, the only foreign runtime that
reaches it: the daemon writes Cursor's machine-wide hooks file and answers `beforeShellExecution` over a Unix
socket ([src/runtimes/cursor/cursor-hooks.ts](src/runtimes/cursor/cursor-hooks.ts)), so a `hold` genuinely parks on a card while
Cursor waits on a script rather than being downgraded to a refusal.

That transport is bidirectional, which is what lifts the native Codex runtime off the foreign-loop floor. A
mid-turn message from `/agent/steer` is delivered as `turn/steer` rather than forcing an abort-and-resend; the
thread's skills are published as the composer's `/` commands and a picked one rides back as a structured skill
input; and the experimental question request (`item/tool/requestUserInput`, which Codex only offers the model
once the thread config asks for it) raises the same card the Claude Code loop's `ask` tool does. Approvals stay
declined on purpose (the container is the isolation boundary) so app-server's other server-initiated requests
are refused the moment they arrive, before anything can block a turn on an answer that is never coming. Isolation
is the same mount namespace the Claude Code loop gets: app-server is a child process, so `nsenter` puts it (and
everything it forks, its shell and its browser servers included) in the turn's anchor, where `/work` **is** the
conversation's worktree instead of a path that still reaches the shared checkout.
