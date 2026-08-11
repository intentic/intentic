# The example extension's seed

[`seed/`](seed) is what the repository `github.com/intentic/extension-example` was created from. It lives its own
life over there now — the same arrangement as
[the registry's seed](../registry-scan/seed), and for the same reason: it belongs to a repo this monorepo does not
contain, so keeping it here as a synced copy would be two sources of truth for one thing.

It is deliberately NOT a workspace package. `pnpm-workspace.yaml` globs `_tools/*`, so the manifest sits one level
down (`seed/package.json`) where the glob cannot reach it — `_tools/ci-base`, `_tools/scripts` and
`_tools/selfhost` are manifest-less wrapper directories for the same reason. An extension for the marketplace must
build against **npm-published** packages with no workspace linking, which is exactly what makes it a real test of
the author path; wiring it into this monorepo's install would destroy that property.

## Why it exists

Everything about publishing an extension was implemented before anything had ever been published. Nothing carried
the `intentic-extension` topic, the registry repository did not exist, and no first-party extension is built as a
single-file bundle — the UI ones are compiled into the web bundle instead — so the author path in
`/api/build/` had never once been executed end to end. This is that execution, kept.

Building it surfaced three things that no amount of reading would have:

1. **`@intentic/sandbox-contract` could not be installed from npm.** Its published tarball declares
   `@intentic/registry@0.0.0`, a version that was never published, because `_sandbox/registry` was missing from the
   release set in `_tools/scripts/packages.sh`. `npm i @intentic/sandbox-contract` — step one of the published
   build guide — failed for everyone. Fixed by adding `_sandbox/registry` (and `_tools/registry-scan`, whose absence left
   the registry's own nightly job with no `@intentic/registry-scan` to `npx`) to `PUB`.
2. **A third-party view cannot use Tailwind utilities.** The app's Tailwind build scans its own sources and the
   first-party extension packages; it cannot scan a bundle it does not build, so a utility class in an installed
   extension resolves only when the app happens to use it elsewhere. The design system's shipped `.ui-*` classes
   and role tokens are the reliable surface, and `seed/src/ExampleView.vue` uses only those.
3. **`@intentic/extension-ui` has no npm artifact**, so an outside author has no types for the component kit the
   host provides at runtime. Publishing it needs `@intentic/ui` published or a rolled-up `.d.ts`; until then,
   plain markup is the honest example.

## It is published, and the chain has been walked

Both repositories now exist, and the discovery path ran end to end for the first time:

| | |
| --- | --- |
| The extension | [`intentic/extension-example`](https://github.com/intentic/extension-example) @ `b129cfc4` |
| The registry | [`intentic/registry`](https://github.com/intentic/registry) |
| The listing it produced | [`intentic/registry#1`](https://github.com/intentic/registry/pull/1), labelled `listing`, **merged** |

The published repo sat at `9305c108` — `engines.intentic: "^0.4.0"` — for long enough to outlive two major
bumps of the extension API, so the one repository an author is told to copy was the one guaranteed not to
load. `b129cfc4` is that fix, and the listing moved to it in
[`intentic/registry#4`](https://github.com/intentic/registry/pull/4), **merged** — which also moved the four
other listings, every one of which was pinned before the `2.x` bump and therefore refused at install.

**A listing pins a commit, so bumping `engines` anywhere means opening a listing PR in the same sitting** — the
repo being right is not the same as the thing anyone installs being right, and the gap between those two is what
an owner experiences as "I installed it and the row says incompatible". The delay here had a second cost worth
recording: `#4` sat open long enough for somebody to install `9305c108` from the live catalogue, so the fix
existed upstream while the only commit anyone could get was the broken one.

That pull request was not hand-written. `_tools/registry-scan`'s scan ran against the live GitHub API, found the repo by
its `intentic-extension` topic, parsed the manifest, resolved the head sha, and emitted the proposal, title and body
that were pushed — the same code `npx @intentic/registry-scan` runs inside the workflow, driven by hand here only
because that package is not on npm yet.

Running it a second time, against a registry that now lists the repo, is what caught the bug fixed in
`_tools/registry-scan/src/outputs.ts`: with **zero** proposals the scan deleted its output directory and never recreated
it, so writing `summary.md` threw `ENOENT` and the workflow's next step — `cat .scan/summary.md` — had nothing to
read. Every nightly run that found nothing new would have failed, which is the steady state once every tagged repo
is listed. `outputs.test.ts` covers it.

Re-running it is the CLI plus a checkout, which is also how to debug a scan without waiting for the nightly job:

```sh
GITHUB_TOKEN=… REGISTRY_DIR=/path/to/a/registry/checkout node _tools/registry-scan/dist/cli.js
```

## What is proven, and what is not

Proven against the published repository rather than a fixture:

- **Discovery indexes.** `topic:intentic-extension` returns this repo. It had never returned anything.
- **The scan proposes correctly.** The generated entry pins `9305c108…`, the exact commit pushed, and takes its
  description from the manifest.
- **A real install works.** `extensionHandler.apply()` clones `https://github.com/intentic/extension-example` at
  that sha, validates the manifest and the prebuilt entry, reports the pinned head, and hands `plugin/` to
  `extensionAgentDirsOf`, which finds the `example-notes` skill.
- **The build recipe holds.** `npm install && npm run typecheck && npm run build && npm test` in `seed/`, from a
  clean `dist/`, produces one 5.14 kB ESM file importing only `vue` and `@tanstack/vue-query` — the two bare
  specifiers the app's import map resolves. `test/activate.test.mjs` then runs that bundle against a host stub
  enforcing the manifest: the view and command register under their declared ids, the lazily imported SFC resolves
  from inside the single file, and the badge's scan reads `/workspace/file`, the one route the manifest allows.
- **`bin/intentic-example add "…"`** writes `.intentic/example-notes.json`, resolving the workspace root by walking
  up from any subdirectory.
- **The gallery renders it.** With the listing merged and `pnpm -C _site/site sync:registry` run, `/extensions/`
  shows the entry under *Listed* with its version, description and pinned sha, in place of "nothing listed yet".
  A deploy is what puts that on the web.

Not proven, each blocked on something specific:

1. **The scan workflow has never run on GitHub.** `seed/.github/workflows/scan.yml` is *not in the pushed registry* —
   that push was refused because the token carries `repo` but not `workflow` scope. Add the scope, or add the file
   through the web UI.
2. **Actions cannot open pull requests yet.** Setting *Allow GitHub Actions to create and approve pull requests*
   returned `409`, and the org-level policy is unreadable without `admin:org`. It is a toggle for an org admin, and
   the workflow's last step fails without it.
3. **`@intentic/registry-scan` is not on npm**, so the workflow's `npx --yes @intentic/registry-scan` would fail
   today. The `packages.sh` fix above puts it and `@intentic/registry` in the release set; it ships on the next
   release.
4. **The gallery is not deployed.** `/extensions/` renders the listing locally; putting it on the web is a deploy.
5. **The browser half is still untested anywhere** — the authenticated bundle fetch, the blob-URL `import()`, and the
   import-map shims resolving to the shell's own module instances. That needs an owner-authenticated app session, so
   it is the first thing to watch after installing from **Capabilities → Add → Extension → From a registry**.
