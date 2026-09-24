# Security policy

How to report a vulnerability in intentic privately, and which parts of the project a report can cover.

## Reporting

1. Open a private report through GitHub's private vulnerability reporting: <https://github.com/intentic/intentic/security/advisories/new>.
2. If you cannot use GitHub, email <contact@intentic.dev>, the project's published contact, and put "security" in the subject.
3. Say which component and which release version you tested, how to reproduce it, and what an attacker gains.

Do not open a public issue, pull request or discussion about an unfixed vulnerability.

## In scope

Everything this repository builds and ships:

- the sandbox image and its daemon, including the per-route authentication and member-tier policy declared in `@intentic/sandbox-contract`
- `ic`, the `intentic-machine` agents and the install scripts served from intentic.dev
- the desktop app and its updater, the browser extension and the mobile apps
- the hosted service at app.intentic.dev (api, editor, ingress) and hosted sandboxes, including anything that reaches another account's data or sandbox
- the published `@intentic/*` npm packages and the GitHub Action
- this repository's CI and release pipeline, for example a way for a fork's code to run on the self-hosted runners or to alter a published artifact

## Out of scope

- The third-party agent programs a sandbox runs (Claude Code, Codex, OpenCode, the Cursor SDK) and the model vendors behind them: report those upstream, unless intentic's integration is what makes the problem worse.
- An agent doing what its sandbox's owner allowed it to do inside that sandbox.
- Attacks that need an already-compromised device or host, social engineering, or volumetric denial of service.

## Fixes

Releases are cut only from `main`, and the current `stable` release is the only supported version. A fix ships in the next release and reaches users through the ordinary update; there are no maintenance branches and no backports. A fix that removes something users rely on is marked as breaking before anyone takes the update ([COMPATIBILITY.md](COMPATIBILITY.md)).
