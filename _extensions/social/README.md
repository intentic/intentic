# @intentic/ext-social

Reddit, X and YouTube as places the agent can read and post.

## Responsibilities

- Declare the three social capabilities.
- Ship the skill that teaches an agent how to act on each — including when to draft for approval rather than post.

## Key files

- [intentic-extension.json](intentic-extension.json) — the three capabilities. This file IS the package; there is no `src/`.
- [skills/reddit](skills/reddit) — driving Reddit as the logged-in user.
- [skills/x](skills/x) — posting and reading on X.
- [skills/youtube](skills/youtube) — the YouTube surface.

## How it fits

Purely declarative — a manifest and skills, no code. Same shape as `ext-connectors`, for a different class of
system.

## Conventions & gotchas

- Posting is outward-facing and hard to take back. The skills route through the drafts flow — the agent prepares,
  the owner approves — rather than publishing on their own judgement.
