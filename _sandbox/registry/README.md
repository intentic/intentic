# @intentic/registry

The **extension-registry file format** — what a registry repo contains, how its two files join, and the order
the result is shown in. Published to npm, and depended on by three otherwise-unrelated consumers, which is the
whole reason it is a package: the daemon that clones a registry, the site that builds the public gallery, and
the [scanner](../../_tools/registry-scan) that writes the files. One zod schema instead of three that drift.

See [Publish & the marketplace](https://intentic.dev/docs/extensions/publish/) for the author-facing version
of everything below.

## The shape of it

intentic hosts no extension code, builds none, and signs none. **A registry is a git repo of pointers** —
each entry names somebody else's repository at a commit, and installing follows that pointer from the owner's
sandbox straight to the author's git host. Listing costs a pull request; delisting removes a pointer and
deletes nothing.

The file is `.claude-plugin/marketplace.json`, Claude Code's plugin-marketplace format, deliberately.
`kind` and `trust` are intentic's own fields and Claude Code ignores what it doesn't recognise, so one repo
lists a team's agent plugins and its intentic extensions together.

## Two files, and why

| File | Written by | Holds |
| --- | --- | --- |
| `.claude-plugin/marketplace.json` | humans, via pull request | every decision — what is listed, and at which commit and trust level |
| `.claude-plugin/registry.generated.json` | the nightly scanner | only facts read back off the source host: stars, last push |

Keeping the derived data out of the curated file is load-bearing, not tidiness. Star counts in the hand-edited
file would make every nightly refresh a merge conflict against every open listing pull request, and would bury
the decision under churn in the review diff. A registry with no generated file is a registry with no stars,
which renders fine — most registries are a dozen internal extensions in a private repo and run no scanner.

[`resolveRegistry`](src/registry.ts) joins them by entry name into `RegistryEntry`, which is also the daemon's
browse wire shape, so the app's list and the website's gallery are the same rows in the same order.

## Trust, and what each state claims

`listed` is the honest default: the pointer resolves, the manifest parses, the publisher owns the source repo,
and **nobody read the code**. `verified` means a human read the source at that commit. `blocked` means
known-malicious or known-broken, with the reason alongside.

A blocked entry stays in the file. Deleting the row hides it from people browsing and tells the people who
already installed it nothing, which is backwards — they are the ones at risk. Absent on a third-party registry
resolves to `listed`, because a registry that doesn't use the field hasn't asserted anything.

## Tier, and what premium buys into

`tier` is the listing's price: `free` (the default, and the whole story for most rows) or `premium` — the
listing opts into the **creator pool**. A premium row needs an intentic membership to install and enable, both
surfaces badge it before the click, and its retained active use is what earns its publisher a share of
membership revenue. The economics live in
[The creator pool](https://intentic.dev/docs/extensions/economics/); only the official registry's premium
markers are read by the platform's pool, so the field on a private registry asserts nothing.

## The mark

A row carries the two display tiers the manifest declares — `logo` (a simple-icons slug) and `icon` (a glyph
from the app's own set) — and the [scanner](../../_tools/registry-scan) copies whichever is set into the listing it
proposes, exactly as it copies the version. A row with neither is drawn as the extension's initials.

They ride the **curated** file, which looks wrong for a copied value until you ask what the two files are for:
the mark is part of how a listing presents itself, so it belongs in the row a human reviews and can correct.
It also has to be here to be worth anything — the gallery and the app's browse list render this row and have
no access to the manifest, because the whole point of browsing is that the code has not been cloned yet.

## The order

[`compareEntries`](src/registry.ts): verified first, then stars, then most-recently-pushed, then name. Stars
are the obvious sort and the wrong one alone — every listing sits at nought to three of them for months, so a
pure star sort is a random order wearing a merit badge, and it is the most purchasable number on GitHub.
Recency is what actually does the ordering early on. Stars stay visible; they just don't get to be the
ranking.

## Identity

An entry's `name` is `publisher.name` from the manifest — [`extensionIdOf`](../extension-api/src/manifest.ts),
the same identity the app installs under. It is derived, never declared by the registry, so a registry entry
cannot rename or spoof an extension, and a repo that copies somebody else's manifest collides with their
listing instead of shadowing it.

[`isShaPinned`](src/source.ts) is the other half: an extension install requires a full 40-character commit sha,
because extension code runs trusted in the owner's browser and a branch name is a promise the upstream can
break with a force-push. A registry entry without one still lists and still reads; it just can't be installed
in a click.

## Key files

- [src/registry.ts](src/registry.ts) — the file format: what a registry repo contains.
- [src/source.ts](src/source.ts) — how a sha-pinned pointer names an extension.
- [src/index.ts](src/index.ts) — the public surface.
