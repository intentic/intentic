# @intentic/registry

The **extension-registry file format** — what a registry repo contains, how its two files join, and the order
the result is shown in. Published to npm, and depended on by three otherwise-unrelated consumers, which is the
whole reason it is a package: the daemon that clones a registry, the site that builds the public gallery, and
the [scanner](../../_tools/registry-scan) that writes the files. One zod schema instead of three that drift.

See [Publish & registries](https://intentic.dev/api/publish/) for the author-facing version of everything
below, and [Verification & trust](https://intentic.dev/api/verify/) for what each trust state claims.

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
| `.claude-plugin/marketplace.json` | humans + protected admission workflow | every decision — what is listed, the exact source, trust level, and source-bound security record |
| `.claude-plugin/registry.generated.json` | the nightly scanner | only facts read back off the source host: stars, last push |

Keeping the derived data out of the curated file is load-bearing, not tidiness. Star counts in the hand-edited
file would make every nightly refresh a merge conflict against every open listing pull request, and would bury
the decision under churn in the review diff. A registry with no generated file is a registry with no stars,
which renders fine — most registries are a dozen internal extensions in a private repo and run no scanner.

[`resolveRegistry`](src/registry.ts) joins them by entry name into `RegistryEntry`, which is also the daemon's
browse wire shape, so the app's list and the website's gallery are the same rows in the same order.

## Trust, and what each state claims

In the official registry, `listed` means the exact source passed the deterministic scan and intentic agent audit,
but no human source review is claimed. `verified` means a human also read that same source. `blocked` means
known-malicious or known-broken, with the required reason alongside. A `verified` row without a
`securityReview`, a review copied from another repository/sha/subdirectory, or a blocked row without a reason does not parse.

`securityReview` records the repository, commit, subdirectory, both versioned policies, scanner and version,
timestamp, Trivy workflow run and agent-gate run. The official resolver accepts only current Trivy and Intentic
policies with that complete subject equal to the install pointer. A row missing either stays visible in the app
with install disabled and is omitted from the public gallery; it cannot become an update offer either. This is
the runtime backstop behind the registry's required PR check.

A blocked entry stays in the file. Deleting the row hides it from people browsing and tells the people who
already installed it nothing, which is backwards — they are the ones at risk. Absent on a third-party registry
resolves to `listed`, because a registry that doesn't use the field hasn't asserted anything.
Third-party registries are their own admission boundary: their non-blocked rows remain installable without
adopting intentic's gate or policy, and the app states when they carry no audit record.

Installed sandboxes read these states back on a daily comparison, so trust reaches the people past the browse
moment too: a row turned `blocked` raises an advisory on the installed extension (and, by default, switches it
off), and `securityFix: true` on an entry marks its pinned commit as fixing a security problem in earlier ones
— the installed side promotes its update badge from ambient to loud, because there the OLD version is the
dangerous one. Both are asserted by pull request, like `trust`, and are worth exactly that review.

## Tier, and what premium buys into

`tier` is the listing's price: `free` (the default, and the whole story for most rows) or `premium` — the
listing opts into the **creator pool**. A premium row needs an intentic membership, both surfaces badge it
before the click, and installing it **donates a published number of the member's credits to the publisher**
(once, deduped monthly — updates donate again at most monthly). No usage is metered or reported anywhere;
the deliberate install is the whole signal. The economics live in
[The creator pool](https://intentic.dev/api/earn/).

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

The sha is necessary but does not confine the code. A browser entry runs in the app's JavaScript realm with
page, browser-storage and network access; server/process/agent/bin/environment contributions have their own
execution surfaces. The manifest gates cooperative calls through the extension API, not arbitrary browser
behavior. Deterministic scanning catches known dependency, secret and configuration findings; the agent audit
exists because neither those signatures nor manifest validation can answer malicious intent.

## Key files

- [src/registry.ts](src/registry.ts) — the file format: what a registry repo contains.
- [src/source.ts](src/source.ts) — how a sha-pinned pointer names an extension.
- [src/index.ts](src/index.ts) — the public surface.
