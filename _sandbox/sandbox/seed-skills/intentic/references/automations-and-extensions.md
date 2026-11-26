# Automations, watches, workflows, approvals and extensions

## Automations and watches

**Automations** are standing instructions that start a turn on their own (a cron expression, or a connector's
listener), kept in `.intentic/config/automations.json` and managed from the editor. One with a check (a guard command,
or a ready-made npm, GitHub-release or web-page source) is a **watch**: the check runs with no model, and only when it
passes does anything happen: a new agent, an existing conversation continued, or just a push to the owner. Which
role each wears is in `roles-and-models.md`; how their runs share one card on the board is in `agents-board.md`.

Propose automations yourself with `automations propose`: a scheduled watch (below), or a listener that wakes when
something arrives through a connection. The owner approves a proposal on a card. Never write `automations.json`
yourself, and never send the owner to the Automations view to build one you could have proposed.

**Reacting to what arrives (mail, chat, CI).** When the task is "when an email / message / run comes in, do X", propose
a listener, not a guard that polls the same service:

```
automations propose <id> --on google --event mail --from someone@example.com --model claude/claude-opus-5-5 \
  --as <role> --note "…" --prompt "…" --why "…"
```

`automations sources` lists the providers this sandbox can listen to (each connected extension declares its own:
`google`, `microsoft365`, `slack`, `discord`, `telegram`, `whatsapp`, `imap`, `ci`…), with their `--event` values and
whether they take `--from`. `--channel <id>` narrows to one channel, label or folder; `--mentioned` to what is
addressed to the agent; `--from <sender>` (repeatable) admits only those senders and ignores everyone else. A listener
always starts a new agent per arrival, so it needs `--model`, and it gets what arrived as its payload. It is as fast
as its source: chat at once, Gmail within about a minute.

**Woken by another service's webhook.** `automations propose <id> --webhook --prompt "…" --why "…"` makes an
automation that fires when something POSTs to `/automations/<id>/fire` with its token (shown on the Automations view
once approved). Add `--signed <scheme>:<SECRET_NAME>` when the sender signs its deliveries (`github`, `linear`,
`sentry`, `stripe` or `standard-webhooks`): every call then also needs a valid, recent signature made with the secret
stored under that name (ask for it with `secrets ask SECRET_NAME` first; the definition holds only the name), a
redelivery of a call already taken answers `duplicate` and wakes nothing, and credential-named keys in the body are
masked before the agent sees it. The webhook's answer says `receipt`: `queued`, `duplicate` or `ignored` (GitHub's ping).

**Waiting on something outside this sandbox.** For a CI run, a deploy or a remote queue, arm `mcp__watch__start` with a
cheap check command and end the turn; it lasts a day at most. To be told, or to pick this conversation back up, when
something happens out in the world that may take longer (a package version ships, a repository releases, a page
changes), propose a durable watch:

```
automations propose <id> --watch npm --with package=bun --with 'range=>=1.4.3' --until first-fire --note "…" --prompt "…" --why "…"
```

(or `--watch github-release --with repo=owner/repo`, `--url … [--select <regex>]`, `--guard '<cmd>'`). `--watch` names a
watch kind an installed extension checks, and `automations kinds` lists them with the `--with` parameters each takes;
a page (`--url`) is the sandbox's own. Its check runs without a model every few
hours (`--every`, 6h unless changed; or `--cron`), and only when it passes does anything wake: this conversation by
default (`--target here`), only a push (`--target notify`), or a new agent (`--target new --model …`). `--fire-on
change` fires only when what it sees moves; `--expires 30d` gives up and says so; `--as <role>` names the role its
wakes act as: a card's id, `full-access` or `no-accounts` (the default, which keeps connector credentials such as a
connected Gmail but reaches no signed-in site account). `automations check --watch … --with …` (or `--url …`) shows what a source sees today; `automations` lists what runs, and
`automations show <id>` one of them with its recent runs.

## Workflows

**Workflows** are daemon-scheduled graphs of turns: every sandbox runs them and stops them from the agents board, but
the page that designs them (and saved loops) is the Workflows extension, installed from Sandbox ▸ Extensions ▸ Browse.
A workflow an agent writes itself (the `workflow` tool beside `spawn`) is in `roles-and-models.md`.

A **loop** repeats one conversation's prompt in fresh sessions until it is done, and is started from a composer or from a
shell with `agents loop '<prompt>' [--until '<command>'] [--on <handle>|self]` (`agents loop --help`). Each round writes
whether it is done and, for a list of items, how many `remaining`; zero, or `--until` exiting 0, ends it, and so do its
round, stall and spend ceilings. Rounds land, or are held, by the land policy. `agents ls` and `agents show` say which
round it is on; `agents loop --stop <handle>` makes the round in flight the last.

## Approvals

**Approvals** hold what the owner says yes to before it happens: posts to publish on X, Reddit, Discord, YouTube…, and
any outward-facing or irreversible action (a booking, a payment, a message sent as the owner, a deletion). Prepare one
with the `approvals` skill, present in every sandbox: one JSON file per item in `.intentic/config/approvals/`, shown
to the owner in the Approvals view. (They were called drafts, with a `drafts` skill, until 2026-09-02.)

## Extensions

**Extensions** add connectors, channels (Slack, Discord, Telegram, WhatsApp…), viewers and skills, found and installed
on Sandbox ▸ Extensions.

An extension installed from a registry updates itself by default. The sandbox compares it with its registry every six
hours and whenever Extensions is opened. A release the registry admitted that asks for no new powers and fits this
sandbox's version is installed by itself, watched for a minute, and put back if it comes up broken. A release that asks
for more waits for the owner, with the reason on the extension's page. "Update automatically", the switch over the
Extensions lists, sets this for every extension. One extension can answer for itself in its page's Updates section
(Notify, Agent-prepared or Auto), and "Use the setting for all" there goes back to the switch. A baked extension updates
with the sandbox instead.

A change to an installed extension (a page under `/ext/…`, its panel, tools or skill) is made in its source checkout
under `/work/extensions/<name>` (`extension list` names each one's), never in the installed copy in
`.intentic/local/extensions/`, which every conversation runs live, nobody reviews, and the next update replaces. Build
in the checkout, then `extension dev <name>` so the sandbox runs it and the owner sees it on reload (`extension reload
<name>` after a later rebuild); `extension dev <name> --off` goes back. A baked extension's source is the intentic
repo's `_extensions/<name>`. With no checkout in the workspace, ask the owner for one: a clone made inside your
conversation does not land. Pushing to the extension's repository publishes it: ask first.
