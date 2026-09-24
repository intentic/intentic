# Compatibility

Which versions of intentic's pieces must match each other, and what every release promises the installs already running.

```mermaid
flowchart LR
    main["main<br/>green pipeline"] --> rel(["release<br/>one version stamp"])
    rel --> pointers["moving pointers<br/>:stable · latest Release · stable tag"]
    pointers --> users["connect scripts · download links<br/>update cards"]
    rel --> kept["versioned tags<br/>stay published"]
    rollback["rollback-stable.sh"] -.-> pointers
```

## One release, one version

- `set-versions.sh` stamps the release version on every first-party package before anything builds; git keeps `0.0.0`. Every artifact of a release, from npm packages and binaries to installers and images, comes from one commit with one stamp, and `release-prepare.sh` refuses one stamped otherwise.
- Node and pnpm are pinned in `package.json` (`engines`, `packageManager`), and the `ci-base` image bakes the same pins.

## A green pipeline is the ship

There is one release lane. A release that passes the whole pipeline becomes what everyone gets in the same run: `release-images.sh` moves the sandbox's `stable` and `core-stable` tags and dind-host's `stable`, then `ship-stable.sh` moves the git `stable` tag and marks the GitHub Release as latest. Connect scripts, the deploy engine's image references, download links and every sandbox's update check follow those pointers as unpinned tags, never digests, so nothing else changes when a release ships.

Un-shipping is `rollback-stable.sh <version>`, which moves the same pointers back, the latest flag first. The bad release stays published under its version, so anything pinned to it keeps running.

## Across versions

Sandboxes update when their owner accepts the update card, so the hosted editor talks to daemons of several versions at once.

- The wire contract is [`@intentic/sandbox-contract`](_shared/sandbox-contract). Its `contract.lock.json` records every exported schema. Additions pass; a push that removes or narrows one is refused unless a commit declares it with a `type!:` subject or a `Breaking-Note:` trailer.
- A `Breaking-Note:` becomes the release's `## Breaking changes` section, and the update card turns into a warning that names what stops working before anyone takes the update.
- The daemon lists its routes and their shape fingerprints on the `/events` hello frame. The editor hides a feature an older daemon lacks instead of calling a route that is not there.
- Extensions declare `engines.intentic`, a semver range matched against `extensionApiVersion` in [`_shared/extension-api/src/version.ts`](_shared/extension-api/src/version.ts): a minor bump for an addition, a major one for a break. That package is the one exception to the repository's no-legacy rule.

## Agent engines

[`engines.json`](engines.json) names the `blessed` version of each agent program. Sandboxes on the `blessed` channel read it from `main` every hour, so a new blessing reaches them without a release. `_tools/checks/engines-blessed.mjs` requires each blessed version to be one this repository's suite pins and runs, and `engines.yml` moves those pins daily through an auto-merging pull request. An owner can put an engine on `latest` or pin a version instead.

## What every update keeps

- The owner's files in `/work` and `/history` survive an update, a rollback and a failed update; `verify-update-survival.sh` drills all three nightly.
- An update that cannot come up healthy puts the previous sandbox back.
- Only the surfaces above carry a promise. Workspace packages, including the published `@intentic/*` ones, change their APIs without shims under the no-legacy rule in [AGENTS.md](AGENTS.md).
