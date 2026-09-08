# The sandbox daemon

What runs inside the box: the process that owns the files, serves the editor, and drives every agent turn.

The daemon ([_sandbox/sandbox](../../_sandbox/sandbox)) is the whole per-user product surface, not just a chat
endpoint. One Node process serves the oRPC contract on `:8787` and a preview proxy on `:5173`;
terminals, panel dev servers, and agent shell commands all run in a shared `tmux` server so they
survive reconnects. Its subsystems:

- **Agent backends**: Claude (agent SDK, spawned per turn), Codex, Grok/opencode, Kimi Code, Gemini, and
  Cursor. Kimi
  and Google's models are re-served from subscription OAuth through the bundled translator on the Claude Code
  harness
  ([agent/](../../_sandbox/sandbox/src/agent/)), plus an anonymous website **webchat** widget over SSE. Native Codex
  points app-server at that same subscription-backed translator; generated image items are copied into
  `.intentic/records/artifacts/imagegen/` and stream as paths, never transcript-embedded base64. The five runtimes
  behind that seam (the Claude Code loop, Codex app-server, OpenCode, ACP, Pi's RPC mode under the
  reserved `pi` capability id: [pi/](../../_sandbox/sandbox/src/runtimes/pi/), and Cursor's own runtime run in-process
  through `@cursor/sdk`: [cursor/](../../_sandbox/sandbox/src/runtimes/cursor/)) do not do the same things, so
  what each one *can* do is **declared**, not inferred: `capabilitiesOf(provider, harness)`
  ([sandbox-contract/agent-catalog.ts](../../_shared/sandbox-contract/src/models/agent-catalog.ts)) is one row per runtime:
  steering, permissions, questions, MCP, effort, isolation, commands, terminals, recovery: and both sides of
  the wire read it. The daemon gates its seams on it and strips the controls a runtime would silently drop
  ([agent/turn-plan.ts](../../_sandbox/sandbox/src/agent/run/turn/turn-plan.ts)); the composer offers only the modes and knobs
  something applies, and names the rest as what this provider can't do. A capability is listed only if
  something reads it, and `agent-catalog.test.ts` walks PROVIDERS × HARNESSES so a new provider cannot arrive
  without a row
  ([webchat/](../../_sandbox/sandbox/src/webchat/)). A chat turn executes as a **detached run**
  ([agent/turn-runs.ts](../../_sandbox/sandbox/src/agent/run/turn/turn-runs.ts)): `POST /agent` acks with a run id, the
  daemon folds the provider's frames into the conversation's rows as they arrive (one fold, the contract's
  [transcript-fold.ts](../../_shared/sandbox-contract/src/text/transcript-fold.ts), shared with the demo), and any number
  of clients render them via `/agent/attach`: the head carries the run's rows whole, then every change lands as
  a patch and every fact about the turn (session, worktree, usage, error) as itself. The browser applies patches
  and folds nothing, so a turn survives reloads and dropped connections, and every window or device on the
  conversation streams it concurrently. Only `/agent/stop` cancels it. A turn also survives **the
  daemon**: every in-flight turn and automation fire is written to a **turn journal** on the history volume
  ([agent/turn-journal.ts](../../_sandbox/sandbox/src/agent/run/turn/turn-journal.ts)) and cleared when it settles, so whatever
  is still there at boot is exactly what the process died under: and `resumeInterruptedTurns`
  ([agent/turn-resume.ts](../../_sandbox/sandbox/src/agent/run/turn/turn-resume.ts)) re-runs it on the session holding its
  partial work. That matters because intentic's own flows cause the deaths: every update, environment approval
  and `dev-sandbox.sh` swap recreates the container, so approving the Dockerfile change an agent asked for used
  to cost the run that asked for it. Off by default (`autoResumeOnRestart`) because a re-run spends the owner's
  allowance unwatched; once turned on it fires once per turn, and only for turns under six hours old: a turn
  that OOM-kills the daemon must not resurrect it on every boot. Not resuming is still recorded, and records
  the WORK and not just the fact: the boot pass reads the dead turn back out of the provider's session store and
  appends it to the conversation's transcript before consuming the journal entry that names it, so an hour of
  tool calls that never settled is still there to read. The fleet card reads `interrupted` and an automation's
  row shows an `interrupted` run.
  A run's rows stay in memory only until it settles: the durable copy is the daemon's own **transcript record**,
  one file per conversation on the history volume
  ([sessions/transcript-record.ts](../../_sandbox/sandbox/src/sessions/transcript-record.ts)), appended the settled
  run's rows, the same rows every window drew. The provider's session store is only the recovery source above,
  which is why a provider that keeps no readable store still opens.
- **Terminals**: tmux control-mode clients over WebSocket, the pane's raw bytes into the browser's xterm ([terminal/terminal.ts](../../_sandbox/sandbox/src/terminal/terminal.ts)).
- **Panels & previews**: per-repo dev servers behind `preview-<panel>-<id>.<zone>` hostnames
  ([panels/](../../_sandbox/sandbox/src/panels/)); plus generic **port forwarding** for anything run in a terminal
  (a procfs scan lists listening ports, an explicit forward maps one onto a fixed slot behind
  `port-<slot>-<id>.<zone>`, and Ctrl+clicking a `localhost:<port>` link in a terminal rides this
  automatically) ([ports/](../../_sandbox/sandbox/src/ports/)). Port targets get Host/Origin rewritten to
  `localhost:<port>` at the proxy, so stock dev-server host checks pass unconfigured. Desktop-sync users get the
  stronger guarantee automatically: the sync agent's port-mirror watcher binds those same ports on their own
  machine's localhost (see `@intentic/machine`), the only path where a frontend hard-coded to
  `localhost:<other-port>` works untouched.
- **Automations**: cron schedules, webhooks (`/automations/:id/fire`), and event listeners
  ([automations/](../../_sandbox/sandbox/src/automations/)). Any of them can be fired by hand with **Run now**
  (`POST /automations/:id/run`), down the same path the real trigger takes: a schedule stays a headless
  main-tree wake, and its guard still runs, because a test-fire that proved something else ran would prove
  nothing about the 3 a.m. one. Only the approval gate is skipped (the click is the approval), and a *disabled*
  automation fires too: trying a prompt before switching it on is the main reason to press it. Every run records
  the session it ran in, so the row's run history opens the transcript: the answer to "it failed overnight and
  I can't see why".
- **Front Desk**: a chat bubble a customer embeds on their own website, talking to a `webchat` listener
  automation ([webchat/](../../_sandbox/sandbox/src/webchat/), widget in
  [\_sandbox/webchat-widget](../../_sandbox/webchat-widget)). It is the inbound-HTTP mirror of the gateway-process pattern:
  no extension holds a connection, because the connection is a `<script>` tag on someone else's page. Four
  routes are exempt from the bearer middleware: `widget.js`, and per-automation `config` / `challenge` /
  `message`: and that set, written as **one predicate** in [app.ts](../../_sandbox/sandbox/src/app.ts), is the whole of
  what an anonymous internet user can reach on a daemon. The visitor holds no credential in any mode: even
  with Google sign-in on, the ID token is verified daemon-side against the *site's own* client id (intentic's
  cannot list every customer domain) and becomes a claim in the prompt, never a grant. Admission is the
  trigger's `allowedOrigins` plus a per-conversation rate limit and an optional bot check: Cloudflare
  Turnstile, or a built-in proof of work for sites with no Cloudflare account, spent once per visitor thread.
  Each thread maps to ONE sandbox conversation, resumed by session id
  ([webchat.routes.ts](../../_sandbox/sandbox/src/webchat/webchat.routes.ts)), so a five-message support chat is one
  fleet card the owner can watch live and take over: not five worktrees with amnesia. And because an
  automation turn runs `bypassPermissions` by default, a Front Desk's real boundary is `Automation.allowedTools`,
  carried into the SDK's own allowlist: prompt wording is advice, an empty toolbox is not. The config fetch
  doubles as the **install probe** ([store/installs.ts](../../_sandbox/sandbox/src/store/installs.ts)):
  every widget load records its origin and whether it was admitted, which is the only thing that can tell a
  working Front Desk nobody has written to from a snippet that was never pasted: and turns the commonest
  mistake of all (`example.com` listed, `www.example.com` not) into a named origin with an Allow button.
- **CI pipelines**: the workspace repos' GitHub Actions / GitLab pipelines, as both an automation source and a
  UI surface ([ci/](../../_sandbox/sandbox/src/ci/)). A repo participates when its remote's hostname matches a connected
  github/gitlab capability (`projects.ts`: self-hosted GitLab included, via the capability's instance url). A
  reconciler keeps a webhook on every mapped repo pointing at the public receiver `/ci/webhook/:host`,
  authenticated by a per-sandbox secret in `.intentic/secrets/ci.json` (GitHub signs the body, GitLab echoes the
  token); a refusal (token scope, role) degrades that repo to a warning, with the manual hook recipe (secret
  included) attached for a maintainer or the owner only, the ssh-key-registration posture. The other public
  doors, an event automation's webhook, a workflow's release gate and a bug intake's key, keep their credentials
  in `.intentic/secrets/doors.json` ([door-tokens.ts](../../_sandbox/sandbox/src/auth/door-tokens.ts)) rather than in
  the versioned manifests that declare them, accept them as `?token=` or a bearer header, and are rotatable. A
  pipeline that wants to DRIVE the agent rather than knock on a door holds a control token instead:
  `intentic/gate-action` and `npx @intentic/gate run` start an isolated turn, poll its card and land it on
  request ([gate/src/run.ts](../../_sandbox/gate/src/run.ts)). Completed pipelines dispatch the core listener provider **`ci`**: the webchat
  precedent: no gateway extension, the daemon's own receiver is the source, with event types
  `pipeline_failed` / `pipeline_succeeded` / `pipeline_fixed` (a success ending a recorded failure streak on
  that repo+branch, remembered across restarts in `ci.json`), so a listener automation narrows by repo
  (`channelId`) and result. The same deliveries freshen the runs cache behind `GET /ci/runs`, which the
  **Pipelines** rail view ([\_extensions/pipelines](../../_extensions/pipelines)) polls: backfilled over the
  vendors' REST APIs when stale, so the view has history even where webhooks never registered. Row actions
  proxy rerun/cancel to the vendor, and **Fix with agent** (`POST /ci/fix`) opens an isolated conversation
  seeded with the failed jobs' log tails: a fleet card like any other agent.
- **Push notifications**: the daemon is the sender, because it is the only tier that knows what the agent is
  doing ([push/](../../_sandbox/sandbox/src/push/)). It owns a per-sandbox VAPID keypair and one subscription per
  subscribed browser, stored on the **history volume** rather than under `/work/.intentic`: the private key can
  forge notifications to the owner's devices, so it sits outside the agent's reach. Three moments notify: a
  turn settled, a turn parked on the user (plan/question/permission), and an automation held for approval:
  and every one is suppressed while anyone is present and non-idle on the sandbox (`idleEverywhere`, read off
  the same presence roster `/events` maintains), so a turn you watch finish tells you nothing. The service
  worker ([_editor/web/public/sw.js](../../_editor/web/public/sw.js)) is registered lazily and caches nothing; a
  subscription is per-browser, and lives on the web origin while the sender is the daemon on its tunnel:
  which works because a push endpoint is an absolute URL minted by the browser's own push service.
- **Capabilities**: everything a user adds to the sandbox (connectors, vpn, mcp, plugins, …),
  one unified model with a per-kind handler ([capabilities/](../../_sandbox/sandbox/src/capabilities/)): see
  [Capabilities](#capabilities).
- **VPN** (putting the sandbox on a private network ([vpn/](../../_sandbox/sandbox/src/vpn/))) see [VPN](#vpn).
- **Geo exits** (making chosen traffic LEAVE from another country, without touching the sandbox's own
  connection ([exit/](../../_sandbox/sandbox/src/exit/))) see [Geo exits](#geo-exits).
- **Members**: shared access for invited collaborators, enforced by the daemon
  ([auth.ts](../../_sandbox/sandbox/src/auth/auth.ts)).
- **Workspace file service**: search, tree, watch, diff, and chunked multi-GB uploads
  ([workspace/](../../_sandbox/sandbox/src/workspace/)); desktop sync is Mutagen over tunnel SSH
  (`ssh-<id>.<zone>`, paired via `@intentic/machine`). Enrollment ([platform/sync.ts](../../_sandbox/sandbox/src/platform/sync.ts))
  carries a **mode**: `sync` (bidirectional file sync, SINGLE-HOLDER, two machines two-way-syncing `/work`
  would race) or `mirror` (port mirroring only, UNLIMITED: forwards are per-machine and independent, so every
  collaborator mirrors the ports to their own localhost at once). The **owner** may enroll either; a **member**
  is capped to `mirror` at pairing-mint. Each enrolled machine gets its own key in `authorized_keys` and its own
  `/ports`-scoped sync token, so machines revoke independently (self-revoke on uninstall; owner clears all).
- **History**: git snapshots every 60 s + per agent turn, on a `/history` volume mounted *outside*
  `/work` so an agent `rm -rf` can't reach it ([history/](../../_sandbox/sandbox/src/history/)). The same volume holds
  the managed ssh dir (`/history/ssh-hosts`, symlinked to `~/.ssh/intentic-hosts` at boot by
  [`linkSshHosts`](../../_sandbox/sandbox/src/capabilities/ssh-hosts.ts)): container recreates, every rebuild, update
  and `dev-sandbox.sh` swap: wipe `/root`, so a git-provider identity or an `ssh` capability's key kept there
  died on each one while the manifest still read "connected". What genuinely can't be persisted (`~/.gitconfig`,
  `~/.git-credentials`) is re-derived from the manifest at boot by
  [`restoreConnectorGitAccess`](../../_sandbox/sandbox/src/capabilities/cli/git-access.ts), the git counterpart to
  `reconnectVpns`. Every one of these HOME-level convergences: the ssh dir, the `~/.claude` session stores,
  `authorized_keys`, the git credentials: runs only for the daemon holding the container claim
  ([`claimContainer`](../../_sandbox/sandbox/src/platform/boot/container-owner.ts)), and so does everything else there is
  only one of per container: the process sweep, the tmux session sweep, the translator, the platform announce,
  the scheduler, the approvals executor and the CI hooks. A container can hold more than one daemon: this
  repository IS the daemon, so a run of it from source is an ordinary thing for an agent to do: and the second
  one otherwise repoints HOME at its own empty roots (taking the live sandbox's git access, transcripts and
  desktop enrollment down without an error anywhere). A guest daemon serves its own routes and owns nothing that
  was here before it. What a guest cannot reach at all is the live daemon's PROCESSES: the leftover sweep
  ([`leftovers.ts`](../../_sandbox/sandbox/src/platform/boot/leftovers.ts)) enumerates its own process group rather than
  filtering every process in the container by a label, so another daemon's work is not something it can decide
  wrongly about: it is not in the set. The label that survives says only WHOSE turn a process belongs to, read
  after group membership has already answered whose daemon it is.
- **Environment overlays**: agent-proposed Dockerfile layers, applied only after owner approval, by `ic` on
  a docker host or by the platform's builder on a hosted machine
  ([environment/](../../_sandbox/sandbox/src/environment/)).
- **Discord**, chat/stream/voice integration, now an image-baked extension: a gateway `process` +
  `listener` in [\_extensions/discord](../../_extensions/discord).

**One image, two ways to start.** The sandbox `connect.sh` runs on your PC and the one the
`i.want.workspace` provider deploys onto a remote host (over SSH) are the *same image*. `connect.sh` itself is
a bootstrap shim: it gets Docker on, fetches the `ic` host-side CLI ([_sandbox/ic](../../_sandbox/ic)) and hands the
flow to `ic sandbox connect`: so is the desktop app ([_editor/desktop-app](../../_editor/desktop-app)) not a third
way: it *spawns that same `connect.sh`*, which is what makes its onboarding identical to the pasted one rather
than a second implementation to keep in step. Every lane on a machine the user owns then reaches the box the
same way, and there is only one way: the daemon dials ONE outbound WebSocket to the ingress and presents the
platform-signed grant naming `<id> = sha256(connectToken).slice(0, 12)`
([tunnel-ids.ts](../../_shared/sandbox-contract/src/ids/tunnel-ids.ts)); the edge reads the `Host` header of each
request and sends it down that sandbox's tunnel. The hosted lane is the one box that is dialled instead of
dialling: the same image, booted as a Fly machine (`SANDBOX_VM`), declares its preview proxy as a Fly service
([sandbox-run/fly.ts](../../_shared/sandbox-run/src/fly.ts)) and the edge replays requests for its hostnames to
the app named after the same `<id>`.

Publishing anything is therefore free of provisioning, because every name a sandbox serves already carries its
id: `sandbox-<id>` for the daemon, `preview-<panel>-<id>` for a panel, `port-<slot>-<id>` for a forwarded port,
`public-<slot>-<id>` for the outbox ([hostnames.ts](../../_shared/sandbox-contract/src/ids/hostnames.ts)). A new panel or
a dev server on a fresh port is reachable the moment it exists: no record to mint, no name to claim, no pool to
keep warm, nothing to reap when it goes. Desktop sync rides the same surface rather than a name of its own,
Mutagen's SSH tunnelled over the daemon's HTTPS (`/system/sync/ssh`), and when the agent and the sandbox are on
one machine every dial the machine agent makes, the computer half's socket included, resolves to the loopback
address first and never crosses the edge at all ([daemon-base.ts](../../_devices/machine/src/daemon-base.ts)).

Two lanes stay off the shared edge entirely. **A sandbox published under its owner's own domain** is reached
through whatever that owner already runs; the platform stores its URL and nothing else, which is the whole of
the attach lane. And **on a server** the workspace is just another service on that host's shared tunnel,
exposing only the preview wildcard (the daemon stays host-internal: the server workspace is preview-only;
`connect.sh` is the browser-direct path). The infrastructure a sandbox *provisions*, meanwhile, builds
Cloudflare tunnels on its target hosts (see below): which is how the system fans out to "workers on many
machines."
