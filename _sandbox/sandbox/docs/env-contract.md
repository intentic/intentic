# The environment a command sees

What every process an agent turn starts — the Bash tool, a web terminal's zsh, an extension's CLI, a build
in `/work` — receives, where each part comes from, and what an extension author can rely on. Three layers,
composed in this order, later winning over earlier; each is owned by one file, named so the layer can be
read rather than remembered.

## 1. The image (`Dockerfile`, and the feature packs and overlay fragments spliced into it)

Set once at build time, present in every process in the container:

| Variable | Value | Why |
| --- | --- | --- |
| `WORKSPACE_ROOT` | `/work` | the workspace volume; an isolated turn's worktree is bind-mounted over it, so the path is the same whether or not a turn is isolated |
| `SANDBOX_PORT` | `8787` | the daemon's loopback port; the agent CLIs (`agents`, `secrets`, `services`, `capabilities`, `wallet`, `vpn`, `geo`, `otp`) dial it |
| `LANG` | `C.utf8` | without a UTF-8 locale zsh counts bytes as columns and the prompt corrupts |
| `EXTENSIONS_DIR` | `/opt/extensions` | the image-baked first-party extensions the daemon enumerates |
| `IQ_MODEL_DIR`, `IQ_PLUGIN_DIR`, `WEBQ_PLUGIN_DIR` | `/opt/iq-models`, `/opt/iq-plugin`, `/opt/webq-plugin` | the search models (absent on the core profile ⇒ lexical only) and the two always-loaded plugins |
| `TRANSLATOR_URL`, `TRANSLATOR_TOKEN` | `http://127.0.0.1:8789`, a loopback-only bearer | the subscription translator's fixed endpoint; a pointer, the binary is the `translator` pack |
| `COREPACK_ENABLE_DOWNLOAD_PROMPT` | `0` | pnpm is baked; no first-run prompt |
| `HOME` | `/root` | the daemon and every turn run as root; baked skills live under `/root/.claude/skills` |
| privacy | `DO_NOT_TRACK=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1`, `DISABLE_FEEDBACK_COMMAND=1`, `DISABLE_AUTOUPDATER=1`, `OPENCODE_DISABLE_AUTOUPDATE=1` | every agent CLI is version-pinned, so an update probe is pure phone-home |
| toolchain opt-outs | `NPM_CONFIG_AUDIT=false`, `NPM_CONFIG_FUND=false`, `NEXT_TELEMETRY_DISABLED=1`, `NUXT_TELEMETRY_DISABLED=1`, `ASTRO_TELEMETRY_DISABLED=1`, `TURBO_TELEMETRY_DISABLED=1`, `EXPO_NO_TELEMETRY=1`, `STORYBOOK_DISABLE_TELEMETRY=1`, `NG_CLI_ANALYTICS=false`, `DOTNET_CLI_TELEMETRY_OPTOUT=1`, `GATSBY_TELEMETRY_DISABLED=1`, `SCARF_ANALYTICS=false`, `YARN_ENABLE_TELEMETRY=0`, `DISABLE_OPENCOLLECTIVE=1`, `ADBLOCK=true`, `POWERSHELL_TELEMETRY_OPTOUT=1`, `SAM_CLI_TELEMETRY=0`, `CHECKPOINT_DISABLE=1`, `CLOUDSDK_CORE_DISABLE_USAGE_REPORTING=true`, `AZURE_CORE_COLLECT_TELEMETRY=0`, `WRANGLER_SEND_METRICS=false`, `STRIPE_CLI_TELEMETRY_OPTOUT=1`, `HASURA_GRAPHQL_ENABLE_TELEMETRY=false`, `HF_HUB_DISABLE_TELEMETRY=1`, `CONDA_ANACONDA_ANON_USAGE=false` | tools not baked are covered on purpose: an agent installs toolchains at will and an unused variable is inert |

Inheritance is not universal, and the Dockerfile says so: containers under the sandbox's own dockerd get
none of this, and a task runner that reconstructs its environment (Turborepo 2's strict `envMode`) drops
what its config does not pass through. A name added to the image block must be added to `turbo.json`'s
`globalPassThroughEnv` in this repo, and any project with a filtering runner needs the same care.

An owner-approved overlay fragment or a feature pack may add `ENV` lines of its own, and they land in the
same layer: the `office` extension's fragment sets `NODE_PATH=/usr/local/lib/node_modules` so a scratch
script resolves its global libraries, and the `translator` pack is why `TRANSLATOR_*` exist on every profile.

## 2. The turn (`capabilities/turn-env.ts`, derived live, never stored)

Built fresh for every turn, and re-derived rather than snapshotted when a condition watch is restored after a
restart, so a credential rotated while the daemon was down comes back current and one revoked does not come
back at all:

- **Connected `cli`-kind capability cards** contribute their `env` map (`capabilities/contributions.ts`):
  each value is a template over the card's fields — `${field}` substitutes, `${field:uri}` percent-encodes
  (a database URL), an absent field yields `""` — and every key is suffixed with an id derived from the
  capability, so two accounts of the same card coexist. The card's own skill (written to
  `.agents/skills/<capability id>/`) is where the variable names are spelled for the agent.
- **Extension settings** declared with an `env` name (`contributes.settings`) inject their current value
  (`extensions/extension-env.ts`).
- **`PATH`** is every enabled extension's `contributes.bin` directory, prepended to the image's PATH
  (`extensions/installed-extensions.ts` `extensionBinDirsOf`), which is how `office`, `voice`, `paperwork`
  or `discord-voice` resolve by name in every runtime's shell. A file in that directory without the execute bit
  is a command that cannot run: PATH resolution skips it.
- **Then narrowed by the persona** (`personas/personas.ts` `personaCliEnv`): a connector the turn's persona
  was not granted has every variable carrying its suffix REMOVED from the environment, not hidden behind an
  instruction. Driven by the denied list, so the PATH and an extension's own settings survive a persona that
  never asked for anything connector-shaped.

Automation turns additionally receive `AUTOMATION_PAYLOAD`, the webhook body or event lines the trigger
delivered (the automation templates on `connectors` and `imap` read it).

## 3. The process (`platform/leftovers.ts`)

`INTENTIC_TURN_OWNER=<conversation id>` stamps every workload the daemon spawns on a turn's behalf: the
agent process, its shell, a `tmux-run` command. Two reserved owners are not conversations: `daemon` (the
pooled ACP agent processes the daemon keeps across turns) and `one-shot` (the toolless helper calls). The
stamp is how the `agents` CLI knows whose children a shell is asking about, and how the leftovers sweep tells
a live workload from one a previous daemon left behind — an unstamped process is somebody's own and is never
touched.

## Files that act as environment

- `/run/intentic/agent.token` — the per-boot agent token the CLIs above send as `x-intentic-agent`; admitted
  to exactly the routes they drive, never to anything credential-shaped (`auth/grants.ts`).
- `/run/intentic/shell/prompt` — truncated by the zsh `preexec`/`precmd` hooks so the daemon knows the exact
  moment a terminal command starts and ends.
- `/history` — the daemon's volume: terminal pane logs, shell history, the git dirs behind every workspace
  repo, sessions. Survives a container recreate; the container's own layer does not.
- `.intentic/` under the workspace — daemon state shared across every session (the same inode as main's for
  the untracked groups), which is why a child agent's bench artefacts land under `.intentic/local/` where the
  parent can read them and a worktree cannot hide them.
- Panels get two more from `panels/`: `INTENTIC_DAEMON` (the daemon base URL) and `INTENTIC_PANEL_TOKEN`
  (accepted as `x-intentic-panel`), for a panel's own backend; never for its browser code.

## Secrets are references, not values

A stored secret never appears as a value in this environment or in a transcript. Where one would show, the
agent sees `{{secret:name}}`, and the same token written into a command is substituted at execution
(`secrets/secret-registry.ts`); a gated secret raises a card for its approver instead. A connector's
credential IS in the turn environment (layer 2) because the CLI it drives needs it, which is exactly why the
persona narrowing removes it rather than advising against it, and why every tool result is masked back to the
reference on its way into the model's context.

## What an extension author can rely on

- The floor the core image bakes (`Dockerfile`): node 24 (`tsx` is a shim over it), python3 with pip/venv
  and PyYAML + Pillow, git + git-lfs, ripgrep, jq, yq, sqlite3, curl/wget, zip/unzip/xz/zstd, `file`, `tree`,
  lsof/psmisc/net-tools, tmux, zsh — and the first-party CLIs `intentic`, `iq`, `lsp`, `webq`, `fileq`.
- Your `contributes.bin` directory on PATH every turn, committed with the execute bit.
- Your `contributes.settings` values as environment variables when they declare an `env` name.
- A capability card's `env` templates, suffixed, for every connected instance the persona allows.
- `ENV` lines in your environment fragment, image-wide, after the owner approves and rebuilds.
- Nothing else: no `FROM`, no `COPY`, no runtime install that outlives the container, no variable a tool
  cannot read because a runner filtered it (see layer 1).

The shape of this document is borrowed from the `meta/env-contract.md` of the claude.ai sandbox
reproduction analysed in `docs/wiggle-borrowings.md` (workspace root); the contents are this daemon's.
