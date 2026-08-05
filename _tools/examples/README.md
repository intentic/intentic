# @intentic/examples

Worked `deploy.config.ts` files — what a real one looks like, and the thing the SDK's types are checked against.

## Responsibilities

- Show a complete deployment intent for each supported git host.
- Fail the build if the authoring surface stops accepting what the documentation says it does.

## Key files

- [deploy.config.ts](deploy.config.ts) — the general example.
- [deploy.github.config.ts](deploy.github.config.ts) — the GitHub-hosted variant.
- [deploy.gitlab.config.ts](deploy.gitlab.config.ts) — the GitLab-hosted variant.

## How it fits

These compile against `@intentic/sdk`, so they are a type-level test of the authoring surface as much as they are
documentation. A breaking change to the SDK breaks the build here first.

## Conventions & gotchas

- Keep them realistic. An example that omits the awkward parts is an example that stops predicting what a user
  will hit.
