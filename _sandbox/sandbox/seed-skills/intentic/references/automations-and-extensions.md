# Automations, watches, workflows, approvals and extensions

## Automations and watches

**Automations** are standing instructions that start a turn on their own (a cron expression, or a connector's
listener), kept in `.intentic/config/automations.json` and managed from the editor. One with a check (a guard command,
or a ready-made npm, GitHub-release or web-page source) is a **watch**: the check runs with no model, and only when it
passes does anything happen: a new agent, an existing conversation continued, or just a push to the owner. Which
persona each wears is in `personas-and-models.md`; how their runs share one card on the board is in `agents-board.md`.

For a recurring or event-triggered task, a scheduled watch is proposed with `automations propose` (below); for
anything else, draft the prompt and trigger for the owner. The owner approves a proposal on a card: never write
`automations.json` yourself.

**Waiting on something outside this sandbox.** For a CI run, a deploy or a remote queue, arm `mcp__watch__start` with a
cheap check command and end the turn; it lasts a day at most. To be told, or to pick this conversation back up, when
something happens out in the world that may take longer (a package version ships, a repository releases, a page
changes), propose a durable watch:

```
automations propose <id> --npm bun@'>=1.4.3' --until first-fire --note "…" --prompt "…" --why "…"
```

(or `--github owner/repo`, `--url … [--select <regex>]`, `--guard '<cmd>'`). Its check runs without a model every few
hours (`--every`, 6h unless changed; or `--cron`), and only when it passes does anything wake: this conversation by
default (`--target here`), only a push (`--target notify`), or a new agent (`--target new --model …`). `--fire-on
change` fires only when what it sees moves; `--expires 30d` gives up and says so; `--as <persona>` names the persona its
wakes act as. `automations check --npm …` shows what a source sees today; `automations` lists what runs, and
`automations show <id>` one of them with its recent runs.

## Workflows

**Workflows** are daemon-scheduled graphs of turns: every sandbox runs them and stops them from the agents board, but
the page that designs them (and saved loops) is the Workflows extension, installed from Sandbox ▸ Extensions ▸ Browse.
A workflow an agent writes itself (the `workflow` tool beside `spawn`) is in `personas-and-models.md`.

## Approvals

**Approvals** hold what the owner says yes to before it happens: posts to publish on X, Reddit, Discord, YouTube…, and
any outward-facing or irreversible action (a booking, a payment, a message sent as the owner, a deletion). Prepare one
with the `approvals` skill, present in every sandbox: one JSON file per item in `.intentic/config/approvals/`, shown
to the owner in the Approvals view. (They were called drafts, with a `drafts` skill, until 2026-09-02.)

## Extensions

**Extensions** add connectors, channels (Slack, Discord, Telegram, WhatsApp…), viewers and skills, found and installed
on Sandbox ▸ Extensions.

A change to an installed extension (a page under `/ext/…`, its panel, tools or skill) is made in its source checkout
under `/work/extensions/<name>` (`extension list` names each one's), never in the installed copy in
`.intentic/local/extensions/`, which every conversation runs live, nobody reviews, and the next update replaces. Build
in the checkout, then `extension dev <name>` so the sandbox runs it and the owner sees it on reload (`extension reload
<name>` after a later rebuild); `extension dev <name> --off` goes back. A baked extension's source is the intentic
repo's `_extensions/<name>`. With no checkout in the workspace, ask the owner for one: a clone made inside your
conversation does not land. Pushing to the extension's repository publishes it: ask first.
