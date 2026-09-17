# @intentic/ext-connectors

The systems an agent can be wired to: GitHub, GitLab, npm, Sentry, PostHog, Redmine, Outline, Notion, SharePoint,
SigNoz, Komodo, Cloudflare, Fly.io, Firecrawl, Postgres, MySQL.

Connecting one does two things at once: it turns on the capability other surfaces gate on (Pipelines appears when
github or gitlab is on; Deployments when Komodo is), and it teaches the agent how to use that system by shipping
a skill alongside the credential.

## Responsibilities

- Declare each connector: what it needs, and what capability it grants.
- Ship the skill that tells an agent how to actually operate that system.
- Provide the environment a connector needs where one is not just a token.

## Key files

- [intentic-extension.json](intentic-extension.json): every connector card, and what each one grants. This
  file IS the package; there is no `src/`.
- [skills/github](skills/github): a worked example of the shipped-skill half.
- [env/postgres.Dockerfile](env/postgres.Dockerfile): a connector that needs a client installed in the sandbox,
  not just a credential.

## How it fits

Purely declarative, a manifest and a directory of skills, no code. That is the point: a connector is a
*contribution*, and anything that needed logic would be a different kind of extension. Capability facts flow from
here to every view that gates on them.

## Conventions & gotchas

- A connector without its skill is a credential nobody knows how to use. The two ship together deliberately.
- Two connectors of the same kind are two estates. Surfaces that gate on these facts generally want one tile per
  connection rather than one per extension.
- npm's `totpSecret` field is marked `totp`: the daemon mints one-time codes from it (the agent's `otp` command)
  and the seed never enters the agent's environment: a manifest whose `env` referenced it would fail to parse.
- npm is two cards on purpose: the `npm` cli connector (token → the npm CLI) and the `npmjs` browser card, the
  only connector of `browser` kind here. The browser half exists for what no token can do anymore: WebAuthn
  2FA and publish approvals: which the sandbox answers with its own enrolled passkey (the daemon's browser
  passkey store).
- Fly.io ships no client fragment on purpose: its skill drives the Machines API with curl, so the card works the
  moment it is connected rather than after a rebuild. What it does carry is a bill that runs by the second,
  which is why its skill puts the state-changing calls behind a say-first rule.
- PostHog is the opposite trade and the only card here whose skill is mostly a pointer: the vendor ships
  `posthog-cli api`, an agent-first surface over hundreds of tools whose catalogue and instructions live inside
  the binary. So the fragment installs that CLI and the skill teaches the loop (`search` → `info` → `call`) and
  the traps, rather than restating an API that would rot here. The rebuild it costs is why the skill also names
  the `npx` form that works before one. Its `env` deliberately uses the plain `POSTHOG_*` names the CLI itself
  reads, which per-connection suffixing then makes `POSTHOG_API_KEY_<ID>` — hence the one-line wrapper at the
  top of that skill rather than a `--host` flag on every command.
- The webhook automations for these services are declared here too (`contributes.automationTemplates`): a
  GitHub or GitLab push, a Sentry alert, a Komodo deployment alert. A template that fires on the generic
  webhook has no trigger source to sit beside, so it goes with the pack carrying the card it needs connected,
  which is the same card the user had to connect for it to work at all. The automations surface names none of
  them.
