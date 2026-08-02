# @intentic/ext-activity

Who called the agent, what it did about it, and how that went.

```stats
{ "items": [
    {"label": "Lines", "value": "1.1k"},
    {"label": "Files", "value": "12"},
    {"label": "Used by", "value": "1 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

When something surprising happens, the first question is what the agent was doing at the time. The daemon
already writes the answer down — an append-only log of every inbound wake, every provider call it sniffed, and
every turn's lifecycle. This package is the surface that makes that log readable.

Readable is the whole difficulty, because the log is written one fact per append and that is not how anyone reads
it. A single turn writes four lifecycle marks plus one row per provider call it made; a real log holds 1,929
events for 837 turns. Rendered one row per event, the feed says "Turn started" and "Turn completed" over a
session UUID, twice per turn, forever.

So the view reads the log as **episodes** — one row per thing that happened, with the raw events one click
underneath — filed by **who set it off** rather than by what served it. That second half matters more than it
sounds: on a turn, the event's `provider` is the runtime (claude, codex, gemini), and the thing that *called* is
its `origin`. Filing turns by `provider` is what let the old surface show a "Connections: Discord" panel above
1,600 rows of the user's own typing.

## How it is put together

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_extensions/activity", "label": "activity", "note": "this package", "accent": "3"},
    {"id": "_libs/extension-api", "label": "extension-api", "note": "it uses", "accent": "3"},
    {"id": "_libs/extension-ui", "label": "extension-ui", "note": "it uses", "accent": "3"},
    {"id": "_libs/sandbox-contract", "label": "sandbox-contract", "note": "it uses", "accent": "2"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/web", "label": "web", "note": "uses it", "accent": "1"}
  ],
  "edges": [
    {"from": "_extensions/activity", "to": "_libs/extension-api"},
    {"from": "_extensions/activity", "to": "_libs/extension-ui"},
    {"from": "_extensions/activity", "to": "_libs/sandbox-contract"},
    {"from": "_extensions/activity", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/web", "to": "_extensions/activity"}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

`episodes.ts` is the package, and it is deliberately the largest file: all the grouping lives there as pure
functions over a fetched page — no request, no Vue — so the part that can be wrong is the part that is tested.
It turns events into episodes (grouping on the `turnId` the daemon stamps) and into sources (the rail's entries).
The three components are then thin: `SourceRail` renders who can call, `ActivityTimeline` renders the selected
one's day-sectioned story, `EpisodeRow` renders one entry and expands to the daemon's own rows.

The layout answers a scale problem rather than a taste one. The rail is bounded by **how many things can reach
the agent**, never by how much they send, so it stays a short list while the traffic behind it grows without
limit — and picking a row is what makes the timeline finite. Three filters compose over that and no more: who
(the rail), when (the window), and free text. All three live in the URL, so a bad hour on one connection is a
link somebody can be sent.

The window is not cosmetic: it decides how far back the feed pages through the log's `before` cursor, so
choosing 7d keeps fetching until seven days are actually covered. When the page bound stops it short, the view
says so — a truncated feed that looks complete would misreport a quiet week.

```bars
{ "title": "Size within Extensions (8 of 16)",
  "items": [
    {"label": "acceptance", "value": 3715, "display": "3.7k", "accent": "3"},
    {"label": "documentation", "value": 2982, "display": "3.0k", "accent": "3"},
    {"label": "automations", "value": 2978, "display": "3.0k", "accent": "3"},
    {"label": "pipelines", "value": 1665, "display": "1.7k", "accent": "3"},
    {"label": "deployments", "value": 1445, "display": "1.4k", "accent": "3"},
    {"label": "discord", "value": 1321, "display": "1.3k", "accent": "3"},
    {"label": "maintenance", "value": 1259, "display": "1.3k", "accent": "3"},
    {"label": "activity", "value": 1112, "display": "1.1k", "accent": "1"}
  ] }
```

## What it needs from the daemon

Two read-only routes (`GET /activity`, `GET /activity/status`) and four fields the daemon stamps onto every turn
event so this view can group and label them: `turnId` (one turn's events, tied together), `conversationId`,
`title`, and `origin`. `turnId` exists because `sessionId` cannot do the job — the runtime does not mint one
until the stream's first frame, which is *after* `turn.started`, so the one event carrying the prompt is the one
nothing could ever join to.

Events written before those fields existed have no `turnId`, and degrade honestly: one episode each, labelled by
their content rather than their type. There is no backfill.

## Where it is used

One sidebar tile, present when a monitored provider capability is connected. Read, not acted on — the log is
daemon-written and lives outside the agent's own reach, which is what makes it worth trusting.
