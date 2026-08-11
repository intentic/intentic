# @intentic/ext-connectors

The systems an agent can be wired to — GitHub, GitLab, npm, Sentry, Redmine, Outline, SigNoz, Komodo, Postgres, MySQL.

Connecting one does two things at once: it turns on the capability other surfaces gate on (Pipelines appears when
github or gitlab is on; Deployments when Komodo is), and it teaches the agent how to use that system by shipping
a skill alongside the credential.

## Responsibilities

- Declare each connector: what it needs, and what capability it grants.
- Ship the skill that tells an agent how to actually operate that system.
- Provide the environment a connector needs where one is not just a token.

## Key files

- [intentic-extension.json](intentic-extension.json) — the eleven connectors, and what each one grants. This
  file IS the package; there is no `src/`.
- [skills/github](skills/github) — a worked example of the shipped-skill half.
- [env/postgres.Dockerfile](env/postgres.Dockerfile) — a connector that needs a client installed in the sandbox,
  not just a credential.

## How it fits

Purely declarative — a manifest and a directory of skills, no code. That is the point: a connector is a
*contribution*, and anything that needed logic would be a different kind of extension. Capability facts flow from
here to every view that gates on them.

## Conventions & gotchas

- A connector without its skill is a credential nobody knows how to use. The two ship together deliberately.
- Two connectors of the same kind are two estates. Surfaces that gate on these facts generally want one tile per
  connection rather than one per extension.
- npm's `totpSecret` field is marked `totp`: the daemon mints one-time codes from it (the agent's `otp` command)
  and the seed never enters the agent's environment — a manifest whose `env` referenced it would fail to parse.
- npm is two cards on purpose: the `npm` cli connector (token → the npm CLI) and the `npmjs` browser card, the
  only connector of `browser` kind here. The browser half exists for what no token can do anymore — WebAuthn
  2FA and publish approvals — which the sandbox answers with its own enrolled passkey (the daemon's browser
  passkey store).
- The webhook automations for these services are declared here too (`contributes.automationTemplates`) — a
  GitHub or GitLab push, a Sentry alert, a Komodo deployment alert. A template that fires on the generic
  webhook has no trigger source to sit beside, so it goes with the pack carrying the card it needs connected,
  which is the same card the user had to connect for it to work at all. The automations surface names none of
  them.
