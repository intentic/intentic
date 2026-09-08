# Conventions and gotchas

The decisions this daemon is built on and the traps that cost somebody a day — each one written where the next person will hit it.

- Workspace-root daemon state has a lifecycle taxonomy: provider homes are secret under `.intentic/secrets/auth/`,
  resumable Claude state is carried under `.intentic/records/sessions/claude/`, rebuildable caches (the iq index, the
  whisper model) are under `.intentic/local/cache/`, durable attachments/browser captures/generated images/run
  evidence/workflow reports are under `.intentic/records/artifacts/`, extension scratch is derived under
  `.intentic/local/runtime/`, and agent scratch is derived under `.intentic/local/tmp/`. Small owner-edited manifests remain
  directly under `.intentic/` so their stable paths stay readable. A janitor
  (src/workspace/watch/state-janitor.ts) collects what the classes call disposable, and only that: tmp/ at boot,
  unreferenced pnpm-store blobs, browser captures past thirty days. A tree the table has no name for is left
  alone, since "I don't recognise this" must never resolve to a delete.
- An isolated turn sees the state dir split along the line git already draws (`SHARED_STATE_PATHS`, derived from
  the same table). What the root repo TRACKS, `.intentic/config/`, is the worktree's own checkout: an agent's edit
  to a setting, an approval, an environment fragment or a skill rides `agent/<id>` and reaches the main tree
  through `land`, with a diff and an author, and becomes visible to the daemon when the turn lands. Everything
  git does NOT track (`records/`, `local/`, `identity/`, `secrets/`, and the staged docs tree inside `config/`)
  is bind-mounted from the main tree by `agents/isolation.ts`, one directory for every conversation, because a
  transcript or a browser capture written into a per-worktree copy is lost. Nothing tracked sits behind a bind,
  so no checkout or rebase in a worktree can write through one, which is why worktrees no longer sparse-exclude
  the state dir. A turn that genuinely needs the LIVE configuration (the owner's uncommitted edits) reads it at
  `/mnt/intentic-main/.intentic/config/`.
- The Claude credential lives in the sandbox's own `.intentic/secrets/auth/claude/` store (connected via the daemon's
  `/claude/*` flow), resolved + injected into the SDK per turn: never held by the platform. The generic file API
  protects the whole `auth/` parent, provider-native `sessions/`, and logged-in `browser/` profiles; purpose-built
  routes expose only the safe slices those stores need.
- The daemon authenticates every request itself (a Google ID token only at exchange, then a daemon-minted session verified per request), since it is reached directly over its public tunnel, it owns its own auth. Access is tiered: the owner binds on first sign-in, and every invited member holds a granted role (viewer / collaborator / maintainer) stored in `.intentic/identity/members.json`. The bearer middleware holds each request to its route's floor (`src/auth/role-floor.ts`): viewers read, collaborators drive agents (their lands become requests on the agent card), maintainers ship and get the terminal, and credentials-adjacent surfaces stay owner-only. Rotating sessions or changing a member's grant closes that identity's live event, terminal, and browser transports and invalidates unused connection tickets. Account deletion retires browser authorization at the daemon before the platform record disappears; if the daemon cannot be reached, deletion stops and names the sandbox that still needs attention. The platform only mirrors the grants; this daemon is the enforcer.
- Resource diagnostics survive the container. Once a minute `src/platform/resources/resource-metrics.ts` appends one JSON
  object to `/history/logs/resource-metrics.jsonl`: daemon heap/native memory, GC and event-loop windows, cgroup
  pressure, process memory/CPU grouped by workload role, the agent-side git queue's depth (`daemon.gitSpawn`,
  which is what separates "git is slow" from "git was never started"), and cardinalities for the resident
  transcript, turn, browser, performance, and IQ owners. It is readable directly from a later sandbox shell (for example,
  `tail -n 20 /history/logs/resource-metrics.jsonl | jq .`) and through the existing authenticated
  `GET /logs/file?name=resource-metrics.jsonl&bytes=1000000` route. The normal logs retention applies: files are
  tail-truncated after 5 MB, expire after 30 days, and participate in the 100-file cap.
- **A failed turn leaves a record that outlives the feed it happened in.** Two facts about a turn used to live
  only in `activity.jsonl`, which prunes to its most recent entries, and in the client's event stream, which
  exists only while a browser is attached: that it failed, and what it failed with. So the most common failure in
  the product was the one least likely to leave a mark, and a burst of them, four sessions dying together, was
  unreadable an hour later. The spend ledger (`src/usage/usage-store.ts`) carries them instead, because it is the
  one daemon log that is never pruned: every turn appends a row with `outcome` (`ok` / `error` / `cancelled`),
  the failing frame's `errorCode` and trimmed `errorMessage`, and `modelRequested` beside the `model` that
  actually ran, so a routing surprise is a diff on one row rather than a walk through four resolution paths.
  Every turn, not only billed ones: a refusal that arrives before the provider charges a token is exactly the
  kind that arrives in bursts. `rollup` keeps the money honest by summing only turns the provider counted, and
  the experiment readers drop failed and cancelled turns, whose zero prose and zero searches are arithmetic
  rather than behaviour.
- **What each account has left is one service, read when something happened, and pushed.** Plan limits (how
  full a subscription's pools are) live in `src/usage/`: one snapshot shape per account (`account-usage.ts`,
  the store on `/history`), one reader per provider that fills it (`claude-usage.ts` on the account's own OAuth
  token; `translator-usage.ts` for ChatGPT, Google and Kimi through CLIProxyAPI's credential-scoped call), and
  one service that decides WHEN to ask (`headroom.ts`). Every window a reader produces carries `gates`, which
  models it stands in the way of, because a plan is not one allowance: Google meters Gemini apart from the
  Claude and GPT models it serves off the same sign-in, Claude keeps a per-model weekly slice, ChatGPT publishes
  a code-review limit no chat turn spends. Every decision that asks "is this account spent for this model" (the
  unnamed-account pick, a one-shot role's chain, a run role's pin, a refused turn's reset) goes through
  `fleet-limit.ts` on those gates rather than through a rule of its own. The service reads on triggers, a turn
  settled, a plan refused, a screen opened, a person pressed re-measure, the proxy came up, and on one long idle
  floor, never on the two five-minute timers this replaced; every write goes out on `/events` as an
  `accountUsage` frame, and every refusal as `providerRefusal`, which is what lets a browser's rings agree
  across windows without polling. A native Codex turn's own rate-limit push (`account/rateLimits/updated`)
  lands in the same store, and the translator's own bench of a credential (`unavailable` on its auth-file
  listing) rides each routed row as `cooling`, the one fact fresher than any reading.
- **And a turn that finished is told apart from one that only stopped talking.** A turn ends at least five
  different ways — its stop condition was met, the model ran out of things to say, the loop hit a cap, the
  budget ran out, or the model asserted it was done and nothing checked the claim — and `outcome` collapses
  four of them into `ok`. The daemon was computing the difference and discarding it at turn end, so the ledger
  now carries it: `verification` (`verified` / `unproven` / `failing` / `no-code`) with the `check` that spoke
  and `filesEdited`; `checklistTotal`/`checklistOpen`, because a turn ending on its own unfinished plan is what
  "it stopped talking" looks like from outside; `compactions` and `contextTokens`/`contextWindow`, which is the
  only record of whether a turn ended against the wall — and the only way anyone will ever answer whether badly
  timed compaction hurts, by joining those against outcome over months of real turns. All of it is folded off
  the normalized frame stream in `streamAgent`, subagents' calls included, so a Codex turn is judged exactly as
  a Claude one is. No single stop-reason word is stored: which of the five modes the facts add up to is a rule
  that will get better, and a word written down now would freeze today's rule into rows that outlive it. The
  harness's own non-success result is classified too, `turn-cap` for a loop out of iterations and
  `harness-incomplete` for the rest, where both used to land as an uncoded failure — the one shape nothing
  downstream knows how to handle.
- **A resumed turn's checklist is seeded from the CLI's own task store, not rebuilt from the verbs it sees**
  ([src/agent/run/task-store.ts](../src/agent/run/task-store.ts), read by `runAgent` before the CLI starts and
  adopted at the first frame that names the session). The fold in `task-checklist.ts` learns a task's id only
  from the result of the `TaskCreate` that made it, and a `TaskUpdate` naming an id it never saw is ignored
  rather than invented. That is right within one turn and wrong across two: the next turn of the same
  conversation started with an empty fold, every update to last turn's tasks was dropped, no `todos` frame went
  out, and the registry's finish carried the previous turn's `unfinished` count forward (its carry rule reads
  silence as "not observed", correctly). A conversation that finished all nine of its steps across a usage-limit
  resume wore "Unfinished, 6 of 9" for it, while the CLI's `tasks/<session>/` directory said all nine were done.
  Seeding off that directory makes the daemon's list the CLI's list from the turn's first moment, so the mark is
  measured on every turn's ending rather than on the last turn that happened to call `TaskList`. The seed is
  dropped when the stream names a different session (a CLI that could not resume mints fresh ids from 1).
- **A turn that ends with nothing to show for it is a failure, not a finish** (`silentEnding` in
  [src/agent/routes/agent.routes.ts](../src/agent/routes/agent.routes.ts)). A Gemini turn on the OpenCode runtime read and
  grepped 59 times, changed no file, wrote not one word, and was ended by an ordinary `session.idle`: no error
  frame, so the row said `outcome: "ok"`, the registry wrote the resting `idle`, and the card settled into the
  board's **Finished** lane over an empty assistant bubble — the lane that means "nothing to do here", on the
  one card that most needed somebody. The daemon now injects an `error` frame ahead of `done` for exactly that
  shape — the provider answered, and then no prose, no card the turn parked on and no file edited — which puts
  it on the one path every reader of a failed turn already watches: the transcript, the activity record, the
  ledger, and the registry's `errored`, which is what moves the card into **Attention**. Uncoded deliberately,
  because an uncoded failure is the one shape the chat answers with a Continue press, and a press on an intact
  session is the whole recovery. Two neighbouring endings are deliberately not this: a turn that EDITED
  something left a diff, a diffstat and a standing to land, and `outcome: "ok"` with `verification: "unproven"`
  above is already the honest account of it; and a turn the provider never answered has nothing to be silent
  about, which is the same reason the verdict above is withheld from it. The runtime's own
  version of the same silence is fixed where it starts ([src/runtimes/grok/grok-agent.ts](../src/runtimes/grok/grok-agent.ts)): an
  OpenCode event stream that ENDS without `session.idle` or `session.error` is the shared `opencode serve`
  going away mid-turn, and it now throws rather than returning as though the turn had finished.
- **The command rules at `turn.ending` run on every runtime too** (`agent.routes.ts` `daemonStopFindings`,
  `rules/turn-ending.ts` `commandRuleFindings`). "Verify before you finish" was a Claude Stop hook and nothing else:
  46% of the turns that edited code in the week of 2026-09-01 ended `unproven`, most of them Cursor, Gemini, Codex
  and Kimi turns whose first reader was the push. The daemon now runs those rules itself once such a turn's frames
  end, awaited, so their verdict reaches the land decision the way a hook's does, and hands what they found to the
  follow-up below as its first paragraph. One follow-up, not two: the nudge's own guard already stops a follow-up
  from answering a follow-up, and a turn still red after it is held on its branch like a Claude turn is.
- **And the follow-up that asks for proof now fires on every runtime** (`src/agent/verification/verify-nudge.ts`). The
  owner's `verify-edits` rule — a turn that changed code and ran no check after its last edit gets one bounded
  follow-up naming the checks this workspace actually has — reached the model through the Claude Agent SDK's
  Stop hook, which is to say it worked on one of six runtimes. On a Codex, Grok, Gemini, Cursor, Pi or ACP turn
  the rule sat in the list looking armed and did nothing, and the owner had no way to see that. What was
  missing was never the follow-up but the ledger: nothing outside the Claude arm knew which files a turn had
  edited or which of its commands were checks, and the frame-fed ledger above is exactly that. The Claude arm
  keeps its hooks, because an in-turn Stop follow-up costs no new session and no re-read of the context;
  everywhere else the follow-up arrives as its own turn down the ordinary daemon-started road, resuming the
  conversation's provider session. A fresh turn rather than a steer even where a steer exists (Pi): the
  decision is made while the turn is unwinding and its steering queue is on its way to closed, and a mechanism
  about unverified work must not be able to lose its own message. It spends a turn on the owner's behalf, so
  the guards are the point — the rule has to be standing with its conditions holding against the files this
  turn really touched, the work has to be genuinely unproven, the turn has to have ended `ok` (a cancelled one
  is never answered by the daemon starting another), it is never a spawned child (whose reader is its parent,
  already told what it proved), and a nudge never answers a nudge.
- **A nudge, and a watch wake, run as the turn they continue — every field of it**
  (`src/agent/run/turn/turn-seed.ts`). Both start a turn that picks an earlier one's thread back up, so both copy
  that turn's whole identity: provider, harness, account, model, effort, reasoning, speed, persona and job.
  They each used to spell that list out for themselves and each spelled a different, shorter one — provider,
  model and effort travelled while `thinking`, `fast` and `actsAs` did not — so a follow-up on a
  reasoning-off turn came back reasoning, and a follow-up on a persona's turn came back as nobody, losing that
  card's toolbox and signed-in accounts in a turn whose entire job is to go and run something. One list, one
  place. There is no `watch-wake` or `verify-nudge` model role behind either any more: both could only ever
  have bound for a turn that was unattended AND named no model AND no provider AND no role, which nothing here
  starts, so they were settings rows advertising exactly the model switch these two must never make.
- **Claude Code turns are told about automatic Stop commands before they run**
  (`src/rules/turn-ending-note.ts`). The note lists enabled `turn.ending` command rules and tells the model not
  to duplicate them. Built-ins add no prompt text. Native runtimes are omitted because their fallback does not
  execute command rules. Said on a conversation's opening message and on the first turn after a compaction, not
  on every turn (`src/agent/run/turn/turn-plan.ts`, the `send.turnEnding` gate): from the second message the note stands
  in the session's own history where the model can read it, and repeating it there is the per-turn cost the
  dependency notice and the rebase note were each walked back from. A compaction is the one event that takes it
  back out of that history, so it is the one event that earns it again — recorded per conversation as the turn
  it happened under (`PersistedAgent.compactedTurn`, written from the registry's `compact` case) and read one
  turn later by the plan.
- **An entrant is not allowed to bring the daemon's logical working directory in with it**
  (`src/agents/worktrees/isolation.ts`, `NO_INHERITED_CWD`, on both `nsenterArgv` and `nsenterPrefix`). `--wdns` moves
  the KERNEL's cwd after `setns`; `PWD` still rides in from the daemon, naming the worktree by its
  `/history/worktrees/<id>` path. A shell replaces a stale `$PWD` only when it no longer names the current
  directory, and here it always does — the namespace binds that worktree over `/work`, so both names are one
  inode — so the shell keeps the daemon's path and every RELATIVE path resolves outside every mirror mount.
  `cd intentic && pnpm verify`, the exact shape a `turn.ending` rule has, therefore ran in a tree whose
  dependency directories are bare mount points and reported a red tree over `prisma: not found` in a fully
  installed workspace, with `nsenter` right there in its own command line. Unset rather than reassigned: with
  nothing to trust, every shell takes it from `getcwd()`, which `--wdns` already made correct.
- **A `turn.ending` check says in the log where it ran** (`src/agent/run/turn/turn-plan.ts`): `checks: check started`
  and `checks: check settled` carry the command, `anchored`, the status, the exit code and the duration, the
  same shape `prepush` has. Without them a check that exited 127 over a missing workspace binary left the only
  record of itself in a model's transcript.
- **A worktree's dependency mirrors take their form from the TURN's runtime, not the container's capability**
  (`entersNamespace` in `src/agent/routes/agent.routes.ts` → `ensure` → `linkMirrors` in `src/agents/worktrees/worktrees.ts`).
  A container able to build a namespace left empty mount points for turns that never enter one (native Codex,
  ACP, Pi: `AgentCapabilities.isolation` `"cwd"`), so nothing in those checkouts resolved an import and no
  daemon-side command in them could find a workspace binary. Those turns get the symlink instead, and
  `linkMirrors` converges the form back on the next namespaced turn in the same conversation.
- **Nothing on the main tree may replace a directory a turn has mounted over — it is emptied instead**
  (`@intentic/constants/mirror-roots`, enforced by `_tools/checks/mirror-roots.mjs`). Each mirror is an overlay
  whose lowerdir is the MAIN checkout's copy, and an overlay resolves that lowerdir once, at mount time.
  Rewriting the files inside it is free and the merged view follows; giving the directory a new inode is not.
  `_platform/prisma`'s build script did exactly that (`rm -rf ./generated` before `prisma generate`), so a
  `turbo run build` on the main tree left every live turn holding a `generated` directory that `readdir`
  reported as EMPTY — its own upper layer included, while `stat` on the files still worked — and the
  declarations emit failed `TS6307` on `generated/client.ts` at the Stop of every open conversation, whatever
  it had changed. Only the mount ROOT is unrecoverable: a turn's own write to any directory below it copies
  that directory up and the stale lower stops mattering, which is why `prisma generate` replacing
  `generated/models` on every run is harmless. Measured both ways in
  `src/agents/worktrees/isolation.integration.test.ts` against a real overlay.
- **The branch is rebased again at the last moment before it lands, not only before the turn starts**
  (`src/agents/land/sync.ts` `syncBeforeLand`, called from the auto-land in `src/agent/routes/agent.routes.ts` and the
  manual land route). Turn-start is the right moment for the MODEL, which then reads today's code, and the
  wrong one for the LAND: the two are separated by the whole turn, and a long turn is half an hour in which the
  user lands other agents and commits them. A land is `git apply --check` of a patch against main's working
  tree, so every main-line commit that arrived inside that window is a fresh chance to refuse over CONTEXT
  LINES this agent never touched — nothing in conflict, the paperwork simply went stale. That refusal costs the
  conflict errand, the user's click, and a whole model turn re-resolving a merge, and it clustered on exactly
  the days with the most parallel work, which is the shape a fleet has. Every safety property of the turn-start
  sync carries over unchanged, because it is the same call: it aborts and rolls back, it commits the worktree
  remainder first so nothing is lost, and it writes only inside the conversation's own checkout. Best-effort at
  this end rather than fatal — the work is finished and sitting on the branch, so a git fault costs the rebase
  and never the land — and a repo that will not move lands from where it was, which is the old behaviour in
  full. The composition it hands back carries the moved `base` per repo, because landing from the pre-sync
  record would hand `anchorOf` a sha the rebase has just orphaned.
- **A rendered surface gets a different question asked of it than a parser does** (`src/agent/verification/agent-viewing.ts`,
  the `verify-ui-edits` built-in beside `verify-edits`, `verify-removals` and `verify-tests`). The proof ledger weighs edited
  code against the checks that ran, and for a reducer or a route that is the whole story. It is structurally
  unable to speak to a clipped label: a stylesheet edit type-checks, keeps every test green, and ships a button
  with its text cut off. So a second ledger counts a different population against different evidence — which
  `.vue`/`.css`/`.astro`/`.tsx` files the turn changed, against whether any browser call OBSERVED something
  afterwards — on the same shared counter, so "after" means after and a screenshot taken before the last three
  CSS edits is not evidence about them. Two deliberate narrowings. The extension list is an ALLOWLIST, the
  opposite call to the prose filter next door, because a spurious ask here costs a whole model turn and a
  browser session. And a `browser_close` or `browser_resize` clears nothing: a gate any browser call could
  clear is one cleared by the very turn it exists to catch. It asks for a COMPARISON rather than a glance,
  which is the half the sessions behind it actually failed — turns that were sent back for how they looked had
  already screenshotted MORE often than the ones that were accepted, so looking was never the scarce thing.
  Off by default like its two siblings, silent on any turn that touched no surface, and it reaches the five
  runtimes with no Stop hook by the same frame-fed road the proof follow-up takes.
- **One 4xx is the provider's fault, and it is classified as such.** A turn that runs for ten minutes and then
  dies on `400 prompt_cache_retention is not supported on this model` was refused over a parameter nothing here
  sends: the CLI's outgoing body was captured without it, the field appears nowhere in this repo, and the same
  provider's successful answers come back carrying it, so what was rejected was its own default (a proxy in front
  of it can add one too, which is why `image-packs/translator.Dockerfile` pins past the release whose compaction path
  forgot to strip the field). Every other 4xx stays uncoded on purpose, because re-sending a malformed request on
  a timer is a loop rather than a recovery; this one has no request of the user's to fix and goes through moments
  later, so `isUnsentParameterRefusalText` (`src/agent/providers/failure-sentences.ts`) codes it `provider-outage` and the
  existing breaker re-runs the turn from the session it already built. Read by every adapter that codes failures
  (the Claude harness's API error text, Codex's `turn.failed`, OpenCode's `session.error`) and read BEFORE the
  bad-model-pick branch in each: the sentence ends in "on this model", so the older branch would have thrown away
  a pinned model that was never at fault.
- **Automatic tier selection is judged in one place, said out loud, and refusable.** Every turn passes a pure
  keyword-and-weights judge before it is planned (`src/agent/run/turn/turn-tier.ts` over the contract's
  `prompt-complexity.ts`), which costs no call and, in the default `shadow` mode, no I/O either: the verdict is
  recorded and nothing is moved. It can only ever route DOWN, to a cheaper rung of the provider the turn is
  already on, because the standard tier is not a setting, it is whatever the user picked. Three things follow
  from that being invisible for as long as it was. The daemon emits a `tier` frame on every judged turn, so the
  chat can say which model actually ran and why (silence is what made the mechanism unauditable). The user can
  refuse: `AgentTurn.tierHold` is a per-conversation veto, persisted on the entry beside `fast`, honoured after
  the cheaper model is resolved so the chat can still name what was declined. And the ledger's tier columns are
  read back by `src/usage/tier-report.ts` into `SavingsReport.tier`, the fast share, what the fast-judged turns
  that stayed on the pick actually cost (never a counterfactual: this log holds what turns cost, not what they
  would have cost elsewhere), the realized routed spend, and the guardrail, how often the very next turn of the
  same conversation asked for a dearer model. A mechanism that changes what the user's money buys owes them all
  three: a warning, a veto, and the numbers.

  Two consequences of taking that seriously. The warning is RECORDED, not merely drawn: the transcript fold turns
  a routed `tier` frame into a notice row carrying its own one-press opt-out, because a line only the window that
  watched it ever saw is not a record of anything, and the question a week later is "was THIS answer the cheap
  one". And the cutoff is the owner's (`settings.autoTierEagerness`, three named stops over `FAST_CEILINGS`),
  since measurement with no way to act on it is a report nobody can use. The dial moves the cutoff and nothing
  else: a fast verdict additionally requires a positively-easy signal, enforced in the judge rather than left to
  the weights summing past the ceiling, so no setting of it can downgrade a short vague request. That is also
  why the ledger records the verdict and the ceiling beside the score, a bare 0.35 is standard on one stop and
  fast on the next, and a refit reading the score column alone could not tell those rows apart.
- **The conversation record is what was on screen, cards included, because both come from ONE fold.** A turn's
  frames are folded into transcript rows as they arrive, inside the run itself (`TurnRun` in src/agent/run/turn/turn-runs.ts,
  running the contract's `TranscriptFold`, `@intentic/sandbox-contract/transcript-fold`), and everything reads
  those rows: `/agent/attach` hands a window the run's rows whole and then every change as a patch, the record on
  `/history/transcripts` is appended the settled run's rows (src/sessions/turn-transcript.ts), a subagent's
  transcript is its parent run's rows tagged with its tool call, and the demo folds its recording through the same
  class. The browser never folds a frame: it applies patches. What the daemon does to a turn is therefore what
  every reader sees, live and a week later alike: a card is raised `pending` and the reply that releases it
  settles its `status` on the row (`settledCards`, src/policy/card-status.ts in the contract); a stop cancels whatever
  was pending and writes `Stopped.`; a refusal, a landing, a compaction, a repo sync and a routed tier each write
  their notice row. The daemon's own lines about a turn (`Plan approved.`, a rejection's feedback, a dismissed
  question) go in through `TurnRun.note`, so they reach every follower and the record alike. A card takes the open
  bubble and closes it, which keeps the row counts a fork copies a prefix of in agreement (`recordedRows` counts
  the rows the daemon holds; both sides ask the contract's `CARD_FIELDS`). The one provider-shaped recovery, a
  turn killed mid-flight read back from the SDK's session store (`recordInterruptedTurn`), rebuilds the question
  card from the ask tool's own call and result (`parseAnswers` is `formatAnswers` read backwards,
  src/agent/tools/question-answers.ts); a plan's text and a permission gate have no stored shape there and stay the
  record's alone.
- **`slow` spans live in their own file so that `daemon.log` can be read.** `src/platform/resources/perf.ts` warns one line
  per slow span, which is right, and in a live 3.5 MB `daemon.log` those lines were 5,465 of the warnings against
  six errors in the whole file: a log whose signal could not be found. The per-span lines now go to
  `logs/perf.jsonl` (`createPerfLogger`, same format and timestamps, so a merged timeline is one `sort` away),
  each stamped with the machine's one-minute load, because the same operation is a fifth of a second idle and
  5.7 seconds on a loaded builder and without the load beside the duration "slow" and "broken" are one line. The
  ranked summary stays in `daemon.log`, where somebody investigating an incident is already looking. A turn
  failure logs there too: `error` for an unclassified one, `warn` for the four codes that already own a durable
  trace elsewhere (a spent allowance, an outage, a refused token, a disabled seat).
- **The records are asked, not tailed** (`src/logs/diagnostics-tools.ts`). Everything above was written well and
  was, in practice, unreachable: measured over 728 sessions the `/logs` route was used *zero* times, `daemon.log`
  150 times and the resource series 69, against 1,679 hand-rolled `/tmp/*.log` files and 178 occasions where an
  agent added a `console.log` to find out what was happening. A raw tail of a 5MB JSON log is worse than the
  print statement it replaces — oldest-first, unfiltered, mostly routine — so the unit is a filtered read:
  `mcp__diagnostics__errors` (level floor, time window, substring, newest first), `slow` (the perf file, by
  operation), `turns` (how turns ended, from the ledger, narrowable to the ones that failed or to the ones that
  finished on code nothing checked) and `resources` (a dotted path into the metric series, with a summary). On the live sandbox that is 4,084 warnings and 6 errors in one file
  reduced to "the 35 warnings from the last ten minutes". An answer whose read started mid-file says so, because
  an empty result over a window nothing could see reads exactly like proof that nothing happened. The tools are
  read-only and confined to `historyRoot/logs` plus the ledger — a turn reads the record of what it did and can
  never edit it — and they are withheld from a persona whose `files` power is `none`. Being a tool was not
  enough to be found: the server is deferred, so what reaches the prompt is a name in a list, and over this
  workspace's 1,084 transcripts the four were called from 5 sessions (`errors` 10 times, `turns` once).
  `src/agent/prompt/system-prompt.ts` now names them, with the situations each answers, on every turn that mounted
  them. Their results are deliberately **not** in `INTERNAL_SERVERS`: two of the four relay a provider's own sentence verbatim, and a
  third party's words dressed as the platform's own log is what the outside-content envelope is for.
- **The browser is the only witness to its own crashes**, so it gets the one write on the logs router.
  `POST /logs/client` (`src/logs/logs.routes.ts`) accepts a capped batch of what the editor caught, measured or
  recovered from and appends it to `logs/client.jsonl`; `mcp__diagnostics__errors` reads it under
  `source: "browser"`. Its own file rather than `daemon.log`, and every line stamped `client: true`, because the
  other files are trustworthy precisely in that only the daemon writes them, and a reader who could not tell the
  two apart would eventually trust the wrong one. What the page sent rides under `report` so nothing it chooses
  to send can collide with `time`, `level` or `message` and rewrite the frame the daemon put around it. Its own
  level floor too, not the daemon's `logLevel`: a sandbox running at `warn` would otherwise drop the client's
  stall reports, which are the half that answers "the UI feels slow". It floors at **viewer** against a
  maintainer prefix and a maintainer mutation default, because a viewer whose page just white-screened is
  exactly who needs to report it and cannot raise their own role to do it.
- **One id joins a browser call to the daemon line that served it.** Both halves of a slow interaction were
  measured already and could not be paired: the browser times what the user waited for, the daemon times what it
  served, and on a sandbox answering several calls a second the only join was a timestamp and hope. The web app
  mints an id per call and sends it as `REQUEST_ID_HEADER` (`@intentic/sandbox-contract`, shared so the two sides
  cannot silently disagree on the name); the outermost middleware in `src/app.ts` echoes it onto the
  `http.request` span. The header is in the CORS allowlist deliberately — one the preflight does not allow is one
  the browser drops without telling anyone, which would leave this permanently and inexplicably empty.
- **An OOM kill is the loudest thing in the log, not a number in a file.** The cgroup counters were always in
  every sample, which is indistinguishable from not recording them: "agents spawn too many subagents and some get
  killed" cost 185 tool calls against data already on disk. `resource-metrics.ts` now diffs each sample's
  `event_oom_kill` against the previous one and logs at `error`, naming the roles that lost processes. A delta,
  not a level — the counters are cumulative for the container's life, so their absolute value is true forever
  after the first kill — and silent on the first sample after a restart, which has nothing to compare against.
  The series also gets its own retention (`FILE_CAPS` in `src/logs/log-files.ts`): at ~4KB a minute the shared
  5MB ceiling was about 21 hours, so it could not answer "what did memory do yesterday" no matter who asked.
- **This process is the control plane, so weight is kept out of it.** Every browser request, agent turn and git
  poll goes through one event loop, and what makes them slow is usually not their own work but the daemon's
  resident size: `fork()` copies page tables in proportion to it (1.5 ms from 55 MB, 27 ms at the 1.8 GB this
  used to run at, paid synchronously on the loop by whoever spawns), and a big process on a memory-pressured
  host gets paged out. Two things follow. Git is never forked from here: one tiny long-lived child does it
  (`@intentic/scaffold`'s forker), so every `git` costs a fork from ~50 MB. And the search engine runs in its
  own process (`@intentic/iq-engine/host`, logged with its pid at boot) rather than as worker threads sharing
  this address space, because threads move CPU off the loop but leave the models and the index cache resident
  here. Anything new that is large or forks often belongs on the far side of one of those boundaries.
- Built on Hono, zod, and provider-native runtimes. Claude uses the Agent SDK; Codex uses app-server, whose
  runner seam is injectable so co-located tests run without a provider process or network.
- There is more than one workspace, and a path alone does not say which. Every isolated conversation has its own checkout, so the same path names a different file in each, which is why the workspace read routes take an optional conversation and resolve the root in one place (`src/workspace/layout/workspace-scope.ts`). A checkout is **not** a superset of `/work` (a mirrored dir is a bare mount point from outside the namespace of a turn that enters one, a symlink into the main tree for a conversation whose runtime does not, and untracked workspace content was never in it either way), so a scoped read falls back to the shared tree and reports which one answered. Search is the stated exception: the iq index is built over `/work` and stays there.
- A conversation's repo **composition is frozen** at its first turn: repos cloned later never join it, so its review, its land and its standing always mean the same set of repos. Deletion is the one change that freeze cannot absorb, so it is reconciled rather than absorbed: a repo whose directory has gone leaves every composition that named it, live and archived, and its stranded checkouts are moved aside (`src/agents/registry/vanished-repos.ts`, riding the same repo-set watch the browser's repo list rides). Two costs of leaving the row in, both paid in this workspace: every per-repo pass keeps running git in a directory that is not there, and the checkout stops being excluded from the root repo the moment the repo stops being discovered, so root's own `add -A` would sweep a deleted repo's whole tree onto the agent's branch.
- A land's product is **uncommitted and composition-atomic**: it holds every repository lock while it preflights every patch, then writes all main working trees or none of them, and moves no commit. So every reading taken between two shas (`standing.ts`) is blind to what the user does with it afterwards, and the two readings that must not be blind ask the tree instead: `landed-presence.ts` for the card ("is the work still there?"), and `agent-changes.ts` `presentInMain` for the review, which measures the branch **against main as it stands** rather than against the fork point it left. That is what decides a row's fate: content your history has taken is no longer a difference and leaves the list (counted as `absorbed`), content sitting uncommitted in `/work` stays and is flagged landed, and content you discarded goes back to outstanding — none of which moves a sha anywhere. **Leaving the list is not leaving the panel**: `landed-history.ts` answers where the absorbed half went, since absorption is a content fact (main's committed content equals the branch's), so the newest commit in `landedHead..HEAD` that touched a path is the commit that left the agent's bytes there. `/agents/{id}/history` groups those rows under the commits carrying them, and the review renders them under a filter of their own rather than as a sentence saying the work is somewhere in your history. It is asked for only once the review reports something absorbed, costs one `git log` per repo, and reports the files no commit accounts for rather than guessing at one — the recorded `landedHead` pins the span while it is still on the main line, and a rewritten history falls back to the merge-base.
- Workflow run artifacts are shared state under `.intentic/workflow-runs/`. The JSON ledger retains every active
  run plus 50 ended runs and removes a run's artifacts when that record is evicted or forgotten.
- **The hosted flavor** (`SANDBOX_VM=1`) runs this image as a whole microVM the platform created, with one
  persistent volume standing in for the three docker ones (the entrypoint's VM mode links `/work`, `/history`
  and dockerd's data-root onto it: layout in `@intentic/sandbox-run/fly`). Three stated deviations from the
  container flavor: the whole box is the platform's machine rather than the user's; it is **reached directly**
  rather than through a tunnel it dials (the platform's edge replays requests for its hostname to the Fly app
  it is, and Fly's proxy lands them on the preview proxy, the same front door a tunnel would; so its env
  carries no grant, `startIngressTunnelWhenConfigured` logs the posture and dials nothing, no loopback
  certificate is ordered since no browser can ever be on the same machine, and `/health` says `reachedBy:
  "direct"`); and the daemon **stops itself when idle** (`IDLE_STOP_MINUTES` →
  `src/system/idle-stop.ts`: nobody connected, no turn, no live delegate, no armed condition watch, no terminal
  output for the window → the graceful exit, so the machine stops and the platform wakes it on the next visit). The corollary worth
  knowing: scheduled automations run only while the box is awake. Nested dockerd needs no privilege directive
  here: VM root already holds every capability, so the docker capability starts its engine without a rebuild.
- **A platform on your own machine arrives as a self-signed certificate on `host.docker.internal`**, and every
  sandbox→platform caller in this daemon is allowed not to verify it: one closed list of hosts, in
  `src/platform/tls/local-tls.ts`. One caller is not in this daemon: the bundled translator is a Go binary, it opens
  the free trial's own connection, and it verifies. Against a dev platform that failed every trial turn as a 500,
  which the harness reads as an outage: so the chat said "The model provider is not responding" about a
  certificate name. `src/platform/listeners/local-tunnel.ts` terminates that TLS on its behalf: a loopback listener the
  trial's base URL points at instead. Opened **only** for a platform on that same closed host list; a deployed
  one gets none of it and the URL is unchanged.
- **The free trial is offered by probe but routed by constant.** Whether the picker shows the trial follows the
  platform's live answer (`src/trial/trial.ts`, layered over the capability store); whether the translator can
  route `free-trial/auto` follows nothing but configuration (`trialCompatEntry` in `src/trial/trial-endpoint.ts`:
  platform address, connect token, one synthetic model id). The two were once one, and the one dependency was a
  boot race: the routing table rendered before the availability probe answered, so a fresh install offered a
  trial it could not route and every first message died with "unknown provider for model". Anything new about
  the trial keeps this split: offer surfaces may read the probe, the turn path and the routing table must not.
- Archiving a finished agent preserves its transcript and parked branches while reclaiming checkouts. Explicitly
  purging the archive also removes the daemon transcript, unshared attachment UUID dirs, and separately-owned
  Claude session files; provider-native state that still shares an auth home is never guessed at destructively.
- **The image runs a different dependency graph than the tests do**, and nothing but booting it says so. Every
  check upstream of the image jobs runs in the development install: all devDependencies present, every
  workspace package linked: while `prepare-image-trees.sh` prunes the shipped tree with `pnpm deploy --prod`.
  A host-side module that reaches a browser-facing barrel therefore type-checks, builds and tests green, and
  then dies at `ERR_MODULE_NOT_FOUND` as PID 1: that is how a `vue` re-export inside `@intentic/extension-api`
  killed the daemon on boot (hence `@intentic/extension-api/protocol`, the vue-free entry point host code
  imports). The rule that follows: **daemon code importing a package that also ships browser modules takes a
  node-safe entry point, never the root barrel**: type-only imports from the root are fine, they are erased.
  `_tools/scripts/image/smoke-image.sh` is the gate. It boots each freshly built half on the arch that produced it
  and requires `/health` to report `ok` with `boot.ready` and no failed step, before `images-merge` stitches
  `latest` and before the release can move `stable`: so a daemon that cannot start now fails the pipeline that
  built it rather than the nightly a day later.
