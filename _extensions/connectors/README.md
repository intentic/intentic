# connectors

A data-only extension that adds the first-party connection cards for developer and business services, from GitHub and Sentry to Postgres and Stripe, each with its agent skill.

```mermaid
flowchart LR
    card(["connectors<br/>cli + browser cards"]) --> form["Capabilities grid<br/>form · probe"]
    form --> daemon["Daemon cli handler"]
    daemon -->|"per-instance SKILL.md"| agent["Agent turn"]
    daemon -->|"token as env var"| agent
    card -->|"env/*.Dockerfile"| overlay["Image overlay<br/>psql · mysql · …"]
    card -->|"automationTemplates"| automations["Automation offers<br/>push · alert"]
```

- Holds no code. Every entry under `contributes.capabilities` is one card: its form fields, an `env` template, an optional `probe` that checks the credential reaches the service, the `hosts` its credential is meant for, and the `skills/<id>/SKILL.md` the agent reads once it is connected.
- `hosts` (templated over the fields like `env`, so a self-hosted card names `${url}`) turns the credential's host guard on by default, set to these hosts: its `{{secret:<id>/<field>}}` reference goes without a person's click only there. The owner can change the hosts or turn the guard off on the Secrets view. It does not reach the environment variable the same credential rides in.
- Most cards are `cli` kind: the daemon injects the credential into the agent's environment each turn, suffixed with the instance id so two accounts of one service coexist, and never writes it to a file. `npmjs` and `website` are `browser` kind: a signed-in session in the sandbox's own browser.
- Cards that need a client tool (`postgres`, `mysql`, `posthog`) name a Dockerfile fragment in `env/`, restricted to `RUN` and `ENV` and built into the sandbox's image overlay.
- The manifest also offers automation templates tied to these cards: push webhooks for GitHub and GitLab, and Sentry alerts.
- Baked into every sandbox image; switching it off on the Extensions tab removes exactly these cards.

## Key files

- [intentic-extension.json](intentic-extension.json) — every card, its fields, env, hosts, probe and skill, plus the automation templates.
- [skills/github/SKILL.md](skills/github/SKILL.md) — a typical connector skill, templated per connected instance.
- [env/postgres.Dockerfile](env/postgres.Dockerfile) — a client-tool fragment for the image overlay.
- [../../_sandbox/sandbox/src/capabilities/handlers/cli.handler.ts](../../_sandbox/sandbox/src/capabilities/handlers/cli.handler.ts) — the generic handler every `cli` card runs through.
