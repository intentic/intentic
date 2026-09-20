# Connecting a first model: the design

How somebody who has just spent their free trial gets a model of their own, in one place, in one decision. This
records what the path was, why each of its four surfaces was the wrong host for the choice, and the three lanes that
replaced them. §6 records what was built, including two numbers that turned out to be wrong on the way.

## 1. The gap

The trial is the first experience, and it ends. What a user met at that moment was **four surfaces and six decisions**:

1. `ChatPaneNotices.vue` — a strip above the composer with **two competing actions**, `Choose a model` and
   `Connect Google`. Neither is wrong; together they are a fork with no stated difference.
2. `ChatChooseModelButton` → `ModelPicker.vue` — a popover with a rail of nine provider lanes, every locked row
   wearing a lock glyph and a price badge, each section header carrying its own `Connect` link. The question being
   asked is *which provider*, and it is asked in a list whose rows are *models*.
3. That link navigated to `/sandbox/agent?connect=X` — a **settings page**. `AiAccountSection` flashed a ring,
   scrolled itself into view, auto-started a handshake, and unfolded `ConnectFlow` inside a row.
4. `ChatAccountPanel.vue` hosted the *same* `ConnectFlow` in a three-line strip over the composer, where the
   paste-back instruction, the Open button, the "already have it?" escape and the dead-end-page explainer competed
   for about eighty pixels.

Two further problems those four surfaces cannot show:

- **The only free-forever, no-signup option was not on the path.** The `localmodel` capability is fully built
  (`local-models-design.md`) and lives on `/capabilities/localmodel` under "extend", behind a form with a static
  select and memory arithmetic the reader does by hand.
- **A self-hosted sandbox has no trial at all.** `trial/trial.ts` probes the platform; with no platform there is no
  trial, so for those users this path is not the sequel to the first experience, it *is* the first experience.

## 2. Options considered

**A. Fix the strips.** Tighten the copy, drop one of the two buttons, give `ConnectFlow` more room in place. Cheapest,
and it treats the symptom: the strips are *reports* about a conversation's standing, and a two-step handshake with a
trip to another tab in the middle is not a thing a report can host. It also leaves the local model off the path, which
is the half that makes the product free.

**B. A modal wizard over the workspace.** Same content, less plumbing, keeps the chat visible behind it. Rejected
because it adds one more dismissible layer to a complaint whose subject is layers, and because a handshake that spans a
tab switch must survive a page the user can lose by pressing Escape.

**C. Rebuild the Agent tab.** Make `/sandbox/agent` the guided flow. Rejected: it is where an account is *managed*
(named, re-authed, dropped, spent), and that is a different job from choosing one for the first time. It would also keep
the first-run path pointing at settings, which is where the trouble started.

**D. One full-window view that owns first connection.** Chosen. §3 is D.

## 3. The design: `/connect`

A shell child route, sibling of `/capabilities`. Three lanes, **in cost order**, one open at a time:

| Lane | What it is | Who it is for |
| --- | --- | --- |
| Free, with a Google account | the one `access.kind === "free"` provider | somebody who will sign in but not pay |
| On this machine | the `localmodel` capability, sized to this box | somebody who wants it free, private, or offline |
| A subscription you already pay for | every `access.kind === "subscription"` provider | somebody who is already paying somebody |

Below them, one quiet line to `/capabilities/endpoint`: a reader already running vLLM does not need a tour.

Four rules the view is built on:

- **Cost leads, not vendor.** A reader who has connected nothing can see, without connecting anything, which of these
  costs money. Lane membership is derived from `PROVIDER_SPECS[].access.kind`, never a list, so a provider that stops
  being free stops being promoted without an edit.
- **The lane that opens is the first with nothing in it** (`firstUnmetLane`). Somebody who already signed in to Google
  is offered the next question, not the one they answered.
- **The handshake takes the whole lane.** `ConnectFlow` is reused unchanged in logic, with one `roomy` prop that only
  decides sizes and whether the dead-end picture starts open. There is one handshake panel in the app, not two.
- **Landing is a state, not a redirect.** The view says what just connected and offers one press, *Start a
  conversation*, which points the next turn at it (`rememberPick`) and goes to the chat. The errand ends in a chat.

### The strips lose the handshake, and keep the pointer

`ChatAccountPanel` no longer starts or hosts a sign-in. It has three states: nothing to send with (the model list plus
a link here), a sign-in live anywhere (*Signing in to X — it is waiting for you · Finish sign-in*), and the early offer
below. The trial-spent strip drops to one action for the same reason: the model list beside it was the same answer
reached sideways, since every row in that list a spent reader could use is behind this door anyway.

### Said early, not only at the end

A reader meeting "choose a provider" for the first time at the moment their allowance runs out is being asked
mid-task. So a sandbox running on nothing but the trial carries one quiet, dismissible line from the start — an offer,
never a nag: it stands down past the halfway mark (where the trial strip takes over and says it with a count), and
never appears at all once anything real is connected.

## 4. The local lane knows this machine

Everything it needs was already in `localmodel.handler.ts`, used only to *refuse* a start: the cgroup cap or
`/proc/meminfo`, `nvidia-smi` where the GPU was granted, and the weights-plus-cache estimate. It moved to
`endpoints/local-model-fit.ts` and is now served by `GET /endpoints/local-model/fit`, so **the view sizes its offer
against the same number the start check refuses on** — a recommendation the daemon would then reject is the failure
that module exists to make impossible.

Two offers, both honest:

- **Start now** — the instant tier, ~1.2 GB, ready in about a minute, sold as what it is: *good for commit messages,
  titles and trying the app out; too small to drive a full agent turn.* That sentence is not decoration. A 2B model
  cannot hold the tool-calling loop's own fixed cost (`context-budget-design.md` measured 49,181 tokens on an opening
  turn of two words), and a view that implied otherwise would make the product look broken.
- **Best for this machine** — the heaviest curated weights that fit, at the largest window up to the turn-sized
  default. Never a rung marked quick-jobs-only.

**The GPU is the one thing this cannot measure in advance, and it says so.** Before the grant the sandbox cannot see
VRAM at all; only the host runner's docker-runtime probe knows an NVIDIA runtime exists. So `granted` quotes real VRAM,
`unsupported` prints the host's missing toolkit, and `absent` — nobody asked yet — sizes against RAM and points at the
switch on the card.

### The prefetch

`llama-server` is already baked into the `standard` image; only weights are missing. So opening this view starts the
instant model's download in the background (`POST /endpoints/local-model/prefetch`), reusing the handler's own job:
keyed by destination path, joining a transfer already in flight, resuming through `.part` + `Range`. A later Add finds
the file or joins the transfer rather than starting a second one.

It is **visible and stoppable**, never a silent gigabyte: the lane reads *"Getting it ready — 340 MB of 1.2 GB"*, and
stopping leaves the part file so a later start resumes. The alternative considered was baking the weights into the
published image, which would have made it instant with zero download and charged every user the pull — including the
ones who connect Claude in thirty seconds and never touch it.

## 5. What stays

`/sandbox/agent` keeps the AI-accounts section, and it is better for losing the handshake: it is the page for what is
connected, under which identity, spending what, and how to drop it. `/capabilities/localmodel` keeps the full form —
other models, a custom GGUF, the GPU switch — and the lane links to it by name. The old `?connect=X` deep link is
forwarded rather than broken.

## 6. What was built, and two numbers that were wrong

- **Contract**: `LOCAL_MODELS` (the curated list, with each file's real size), `LOCAL_MODEL_INSTANT`,
  `LOCAL_MODEL_KV_BYTES_PER_TOKEN`, and the `localModelFit` / `localModelPrefetch` routes.
- **Daemon**: `endpoints/local-model-fit.ts` (memory, GPU, per-model fit, the two offers) and
  `endpoints/local-model-weights.ts` — the cache, its downloads and the prefetch, moved out of the capability handler.
  That move is a boundary, not tidying: the prefetch writes weights before any card exists, so having the endpoints
  routes reach into `capabilities/` for it made the two subsystems import each other. A download is about a file in a
  shared cache, not about one card's lifecycle, so it belongs on this side and capabilities reach one way into it.
- **Web**: `features/connect/` (the view, the lane frame, the provider tile, the local lane, the tested lane logic),
  the `roomy` prop on `ConnectFlow`, and the four surfaces above repointed.

**The card's model sizes were overstated, two of them badly.** The labels were hand-written GB figures; measured
against the Hugging Face tree API, gemma-4 12B is 7.1 GB against a label reading ~14, and Qwen3.8 27B is 16.5 against
~22. A label nobody can check is a label that drifts, so the sizes are bytes in the contract now and every surface —
the card's option label, the fit arithmetic, the download estimate — derives from that one row.

**And the units were decimal, which made the one figure a reader can check wrong.** A 32 GB laptop read back
"34 GB", because `/proc/meminfo` in decimal gigabytes is not the number on the box. Every figure this feature prints
is a memory quantity compared against a machine's RAM, and RAM is binary, so all of them are now — a download, a
working set, a window's cache and the machine itself, in one unit that compares correctly. The KV rate moved to
65,536 B/token with it: inside the measured 50–60 KB band, rounded up rather than down (over-reserving costs a rung,
under-reserving costs an allocation failure the card had promised against), and it makes the window rungs come out at
exactly 1, 2, 4 and 8 GB.

## 7. Open questions

- **The prefetch's bandwidth.** Visible and stoppable is the mitigation, not a metered-connection detector; there is
  no signal in the browser worth trusting for that. If it proves annoying, the fix is press-to-start, which is one
  `v-if`.
- **A second free lane.** The design assumes exactly one free provider because the spec table currently has one. Two
  would make the lane a list, which it already renders as.
- **Where a desk lands.** A member who may drive a turn but not read `/accounts` sees lanes derived from
  `nativeReady`; whether such a reader should be offered a sign-in at all is a permissions question this view inherits
  rather than answers.
