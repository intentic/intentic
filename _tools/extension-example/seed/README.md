# intentic example extension

The reference [intentic](https://intentic.dev) extension: one contribution of **every** kind the extension API
offers, in as little code as each one takes. It is meant to be read start to finish in a sitting, and cloned as
the starting point for a real extension.

It is also the thing that proves the publishing path works. Everything here was built with npm-published packages
only (no monorepo, no private registry, no build service) and installed into a real sandbox from a commit sha.

## What it does

The agent leaves short notes with a CLI; the owner reads them in a rail tile that updates the moment one lands.

```
intentic-example add "the flaky test only fails with a cold cache"
        ↓ writes .intentic/example-notes.json
        ↓ the daemon's file watcher matches contributes.files
        ↓ invalidates the `example-notes` query key   → the OPEN view repaints
        ↓ and announces the write (onDidChangeFiles)  → the CLOSED tile's badge re-reads
   both halves of the Example tile refresh — no polling for either
```

The second arrow is the one that is easy to leave out. An invalidation only reaches a query something is
observing, and a badge is read with nothing mounted, so a tile wired to the first arrow alone is only ever as
true as its own timer.

That loop is the smallest thing that touches both halves of an extension: the agent's side (a tool on PATH, a
skill telling it when to reach for it) and the owner's side (a view, a badge, a setting).

## What each file is for

| Path | Contribution | Why it's interesting |
| --- | --- | --- |
| `intentic-extension.json` | all of them | The approval surface. The install dialog renders exactly this, and the host refuses anything the file didn't declare. |
| `src/extension.ts` | `activate()` | Registers the view and the command, and starts the badge. Everything it registers is disposed through `context.subscriptions`. |
| `src/ExampleView.vue` | `views` | The rail view. Read the comment at the top before styling anything of your own. |
| `src/useNotes.ts` | `files` | The query key whose first part is what `contributes.files` invalidates: the entire wiring for live updates. |
| `src/badge.ts` | `views[].badge` | Module state, why it cannot be the view's query, and the write-driven refresh with a slow timer behind it as a backstop. |
| `bin/intentic-example` | `bin` | Plain ESM, no build step: the daemon puts this directory on the agent's PATH and the file itself is the approved code. |
| `plugin/` | `agent` | A Claude Code plugin directory, handed to the Agent SDK as-is. The skill is how the agent learns the CLI exists. |
| `test/activate.test.mjs` |: | Runs the built bundle against a host stub that enforces the manifest. Catches code/manifest drift, which is the failure that actually happens. |

## Build, test, install

```sh
pnpm install
pnpm typecheck        # vue-tsc over src/
pnpm test                 # node --test against dist/ — build first
pnpm build            # → dist/extension.js, one file, 5 kB

git add -f dist/extension.js && git commit -m "release 1.0.0" && git push
git rev-parse HEAD       # this sha is what you install
```

Then in the app: **Capabilities → Add → Extension**, paste the repo URL and that sha. There is no packaging step
and no upload: the daemon clones the sha you name and runs what is in it, which is why `dist/` is committed and
why `.gitignore` deliberately does not list it.

Reload the app to load the UI; the agent-side contributions (`bin`, `agent`) apply from the next turn.

## Two rules that are not preferences

**The bundle must be one file with the host's packages external.** The loader fetches it with an auth header and
imports it from a `blob:` URL, so a relative chunk import has no base to resolve against, and a second copy of
`vue` or `@tanstack/vue-query` would fork reactivity and the query cache. `vite.config.ts` has both settings with
the reasoning inline.

**Styling is not Tailwind.** The app's Tailwind build scans its own sources; it cannot scan a bundle it does not
build, so a utility class in a third-party view resolves only if the app happens to use it somewhere else:
three-quarters of a design system, at random. What *is* reliably available is what the design system ships as
authored CSS: the `.ui-*` classes (`.ui-page`, `.ui-card`, `.ui-card-dashed`, `.ui-field`, `.ui-code`) and the
role tokens behind them (`--color-card`, `--color-content`, `--color-muted`, `--color-line`, `--color-canvas`),
which flip between light and dark on their own. This view uses only those, and recolors with the shell for free.

Note also that vite's library build emits an SFC style block as a *separate* CSS asset, and nothing fetches it.
Style inline, or inject a sheet from `activate()`.

## Two things that are missing, honestly

- **`@intentic/extension-ui` is not on npm.** It is the component kit first-party views render with, and the host
  publishes it at runtime through its import map: so an extension may mark it external and use it, but there is
  no package to install for the types. Until there is, an outside author builds views from plain markup, as this
  one does.
- **`@intentic/sandbox-contract` cannot be installed** as of this writing: its published tarball depends on
  `@intentic/registry@0.0.0`, which was never published. It carries the daemon's wire schemas, so once it
  installs, `WorkspaceFileSchema.parse(...)` replaces the hand-rolled type guard in `src/notes.ts`.

## Getting listed

Add the topic `intentic-extension` to the repository. A nightly job on the
[registry](https://github.com/intentic/registry) finds it, checks the manifest parses, resolves the latest commit
and opens the listing pull request for you. That is the whole submission process: there is nowhere to sign up,
and the listing is a pointer to this repo at a sha, not a copy of it.

MIT.

## Key files

- [src/extension.ts](src/extension.ts): activation, and one registration of every kind.
- [src/host.ts](src/host.ts): the host handle, bound once.
- [src/ExampleView.vue](src/ExampleView.vue): a view, rendered with the extension UI kit.
- [src/useNotes.ts](src/useNotes.ts): reading and writing through the public API.
- [src/badge.ts](src/badge.ts): the attention badge pattern, at its smallest.
- [plugin/skills/example-notes/SKILL.md](plugin/skills/example-notes/SKILL.md): the agent-facing half of an extension.
