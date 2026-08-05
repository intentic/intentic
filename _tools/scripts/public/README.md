# intentic

**An IDE for your agents. A window for you.** intentic turns a generic coding assistant into a *specialized
agent* — an autonomous employee with its own sandbox on hardware you own: its dev-tools really installed,
wired to the systems it operates, its context curated for one job. Run one, or ten in parallel, from any
browser. Works with Claude Code, Codex, Grok, Kimi Code, and Gemini, on your own subscription.

This repository is **everything that runs on your machine**, MIT-licensed: the sandbox daemon your agents live
in, the CLIs they use, the extensions they load, and the desktop app that installs it all. The hosted platform
(identity, billing, and the browser workspace) is not here — see [ARCHITECTURE.md](ARCHITECTURE.md) for the
split and why the platform cannot reach your code. That document covers the full system, so its links into the
platform's half of the tree point at directories this repository does not carry.

## Install

```sh
curl https://intentic.dev/sync | sh        # the sandbox on this machine
curl https://intentic.dev/computer | sh    # connect this computer to an agent
```

Or take the desktop app from [Releases](https://github.com/intentic/intentic/releases/latest) — `.AppImage`,
`.deb`, `.rpm`, and a Windows installer, all auto-updating.

## What's in here

| | |
| --- | --- |
| `_sandbox/sandbox` | the daemon: agents, worktrees, terminals, previews, the workspace API |
| `_deploy/cli` · `_search/iq` · `_search/lsp` | the agent-facing tools — deploy engine, code search, language server |
| `_sandbox/sync` · `_computers/host` | the cross-compiled machine agents behind the two install commands above |
| `_editor/desktop-app` | the Tauri app: installs Docker, starts the sandbox and its tunnel, keeps it updated |
| `_sandbox/acp-bridge` | Agent Client Protocol bridge |
| `_extensions/*` | the loadable capabilities — Discord, IMAP, Slack, deployments, pipelines, memory, … |
| the rest, by directory | each top-level `_` directory is a domain — `_sandbox` contracts and workspace machinery, `_deploy` the engine's libraries, `_search` retrieval, `_computers` the machine drivers, `_editor` the UI kit |

Most packages carry their own README with what they are responsible for and where to start reading.

The `intentic deploy` command group is a standalone **deployment engine** — a declarative, reconciling
infrastructure tool. It is one of the many tools a specialized agent can reach for, **not part of the intentic
product**; it ships here for convenience. See [docs/deploy-engine.md](docs/deploy-engine.md).

## Published artifacts

- **npm** — 23 packages under [`@intentic/*`](https://www.npmjs.com/org/intentic), published from this
  repository by GitHub Actions with [npm provenance](https://docs.npmjs.com/generating-provenance-statements),
  so every tarball links back to the commit and workflow run that built it.
- **Container images** — `ghcr.io/intentic/sandbox` and `.../dind-host`, at each release
  version plus a moving `stable` tag.
- **Desktop installers** — attached to each [GitHub Release](https://github.com/intentic/intentic/releases).

## Building it yourself

```sh
pnpm install
pnpm typecheck        # the gate — emits declarations first, needs no build
pnpm build && pnpm test
pnpm build:sandbox    # the sandbox image, from source
```

Dogfooding the daemon — build the image and swap a running sandbox onto it, keeping its `/work`, tunnel and
settings. Pass the slug when the machine runs more than one:

```sh
pnpm rebuild:sandbox [slug]   # build the image, then swap
pnpm swap:sandbox [slug]      # swap onto the image already built
pnpm dev:sandbox              # the watch loop: rebuild + swap on every change
```

Requires **Node 24** and **pnpm 11**. Conventions for working in the tree — where tests live, how packages
type-check, what the editing rules are — are in [AGENTS.md](AGENTS.md).

## How this repository is produced

Development happens in a private monorepo that also holds the hosted platform. Each release exports the public
path set into this repository as **one commit, tagged `v<version>`**, with the installers attached to the
matching GitHub Release. So the history here is a list of releases rather than a list of changes, and the tree
at any tag is exactly what was published under that version — nothing is filtered out of a file's past,
because no past is exported.

Issues and discussion are welcome here. Pull requests cannot be merged into a snapshot, so open an issue first
and we will carry the change upstream — [CONTRIBUTING.md](CONTRIBUTING.md) has the details. For security
problems, report them privately instead: [SECURITY.md](SECURITY.md).

## License

MIT © Artur Kurowski — see [LICENSE](LICENSE).

## Key files

- [README.md](README.md) — the file itself; this package exists to publish it.
- [package.json](package.json) — what makes the directory a package.
