// Protocol version matched by engines.intentic at load and reported as IntenticApi.apiVersion.
// Bump with the published package: additive surface changes require a minor, breaking changes a major.
// Keep published names compatible within a major; surface.json and the surface checks record API and UI-kit changes.
// 2.35.0 lets a command declare its shortcut as a Mac spells it: `mac` beside `keybinding` in `contributes.commands`,
// approved at install as a power of its own (a second chord the extension claims). Without one a Mac uses `keybinding`,
// as before; with one, a Mac binds `mac` instead. Whichever is declared, a Mac's text field keeps the chords it answers
// itself (⌃A, ⌃K, ⌥←, ⌘⌫). Additive: a manifest without `mac` is unchanged. The recorded surface grows the manifest
// schema.
// 2.36.0 records settings choice labels and explanations alongside the Mac shortcut schema.
// 2.37.0 adds the kit's own day and time fields, `DatePicker` and `TimeField`, in place of the browser's date popup and
// hour spinner. Additive.
// 2.38.0 tells a run button whether the model it would spend has allowance: `api.models.allowance(selection, now)` answers
// when a spent allowance reopens, by the rule the composer's Send books by, and `pick({ schedules })` has the panel's verbs
// say when a run on such a model starts. The kit's `useAgentRunPick` reads it as `spent` and `booking`, and
// `<AgentRunButton>` draws the press as the time it starts. Additive. The recorded surface grows `modelsApi`.
// 2.39.0 lets a view start an agent the board shows from the press: `api.chat.launchAgent(card, start)` opens the agents
// board at once with a dashed card standing in for the agent while `start` runs, hands over to the agent's own card when
// `start` answers with its id, and says a refusal on the card. Additive. The recorded surface grows `chatApi`.
// 2.40.0 lets a view start an agent from a branch while the shared workspace stays on its main line:
// `api.chat.composeFrom({ repo, branch })` opens a new chat whose private copy is cut from that branch. Additive. The
// recorded surface grows `chatApi`.
// 2.41.0 gives a view the app's pages to link to: `api.links` holds a constructor for each (the editor's own table,
// @intentic/sandbox-contract/app-routes), and `api.navigate` and `api.href` take the link one makes, drawn in the frame
// and the sandbox the reader is in. A path is still taken, deprecated: read as an address from before the editor's
// frames, it opens where a link to its page would. Additive. The recorded surface grows `api`.
// 2.42.0 grows a capability card's fields and test: `signIn` (`google`, `microsoft`) fills a refresh token from a sign-in
// button, `refreshToken.deviceCode` declares the device-code sign-in a `microsoft` one runs, `connection` answers a field
// by picking an existing connection, `keyValue` draws one as name and value rows, `keyRequest` has the sandbox keep a
// private key and show its certificate request, `probe.oauth` takes the `client_credentials` grant too, and `probe.ok`
// names where a 200 answer says it worked. Additive. The recorded surface grows the manifest schema.
// 2.43.0 names the signed-in user's trust tier `api.sandbox.tier()`. `role()` answers the same and is deprecated until
// 3.0.0: personas were renamed roles. Additive. The recorded surface grows `sandboxApi`.
// 2.44.0 versions the slice of @intentic/sandbox-contract an extension may read: `EXTENSION_WIRE`
// (@intentic/extension-api/wire) names the bare package and the subpaths an extension may import, and the lint and
// `intentic-kit-check` refuse any other. Additive. The recorded surface grows `wireExports`: each allowed subpath's export
// names and a digest of its zod schemas, so a schema an extension parses cannot change without a new entry.
// 2.45.0 records app-routes' `returnPath`, which validates a sign-in destination as a path on the editor's origin.
// 2.46.0 records the routed conversation prefix and account routing fields in the agent and subagent schemas.
// 2.47.0 records the listener protocol's reliable delivery: `id` on a /deliver body (a gateway posts one reply id once),
// `features` on a gateway's status (`DELIVER_ID_FEATURE`), and the dispatch key header (`LISTENER_DISPATCH_KEY_HEADER`)
// a gateway names a retried message by. Additive: each is optional, and an older side ignores it.
// 2.48.0 records the automations wire's webhook signature schemes (`WEBHOOK_SIGNATURE_SCHEMES`, `WebhookSignatureSchema`,
// `WebhookSignatureSchemeSchema`) and its `carried` run outcome, and the keyring wire's `isVaultKey`. Additive.
// 2.49.0 lets a cli card declare the outward actions it performs (2026-11-25): `broker.actions` names what a request
// through the credential gateway does (method, path, and where it names its channel and content), and `commandActions`
// what a command of the extension's own does (`whatsapp send`). The sandbox classifies, records and holds them to the
// owner's action rules (`<card id>.<action>`) from these, and Guardrails offers the enabled extensions' actions; it
// matches no provider's address or command itself any more. Additive. The recorded surface grows the manifest schema.
// 2.50.0 gives an extension's own code four primitives the daemon's engines had to itself (2026-11-26), each a power its
// manifest declares under `permissions` and the daemon refuses undeclared: `api.events` hears a run end in a conversation
// it started through POST /agent with its own token (`run`) and whether any agent turn runs (`activity`); `api.work.hold`
// keeps the sandbox awake and an update or restart waiting while work is in flight (`work`); `api.exec` runs a command
// under a workload class (`exec`: `command`, or `toolchain`, queued with the sandbox's builds); and an automation whose
// target is `{ kind: "extension" }` fires a handler the backend registers with `api.automations.onFire` (`fires`),
// under the scheduler's admission, holds and journal, handed over late when the backend was down. A declared process gets
// the first three. Additive: a manifest without them is unchanged, and `fakeExtensionApi` models each. The recorded
// surface grows `serverApi` and the manifest schema, and the wire's automations schemas (the new target).
// 2.51.0 (2026-11-26) lets an extension declare a watch kind and answer its check: `contributes.watchKinds` names each
// kind (its id, label, the sentence a source of it reads as, and its parameters as fields the composer, the
// `automations` command and the approval card draw and saving checks), and `api.checks.serve(kind, handler)` answers one
// check (`WatchCheck`: the parameters, what the last pass saw, and the credential-gateway addresses of the extension's own
// cards the kind names) with a pass and what it saw, or what it is still waiting for, reached from the daemon's
// automations engine alone through the backend host's door. `contributes.automationTemplates` takes every field the
// daemon's own templates carry (a `once` or webhook trigger's fields, `tz`, `afterSessions`, a watch's `source`, `fireOn`,
// `until` and `target`), so any template can be an extension's. The npm and GitHub release kinds left the daemon for the
// connectors extension, under the same ids. Additive: a manifest without them is unchanged, and `fakeExtensionApi`
// models `check`. The recorded surface grows `serverApi`, the manifest schema, and the wire's automations schemas (an
// open watch source, the catalogue's `watchKinds`).
// 2.52.0 (2026-11-26) lets an extension declare the jobs it starts agent runs for, `contributes.modelRoles` (an id, a label,
// an explanation, an icon and the setup it is suggested), which the owner puts on a model setup in Sandbox ▸ Agent ▸
// Models beside the sandbox's own; the daemon serves both (`GET /settings/model-roles`), and `job` on POST /agent and
// `api.models.agentRun(role)` take any job's id, the sandbox's own or one an extension declares (`runRole` keeps its
// closed list beside it, which every sandbox reads). The pipelines,
// deployments, maintenance, documentation and acceptance extensions declare the jobs the core's table held for them, under
// the same ids. And a card's `commandActions` entry says who decides its rule, `gatedBy: "sandbox"` (the command guard,
// the default) or `"backend"` (the card's backend, which asks the outward-action door), and what it comes to while no
// rule names it, `unruled: "allow"` (the default) or `"hold"`; `selfGated: true` is deprecated and read as the two
// together. Additive: a manifest without them is unchanged. The recorded surface grows the manifest schema and
// `contributes`, and the wire's agent schemas (`job`, an open id).
// 2.53.0 (2026-11-26) gives an extension three doors the core kept to its own features. `contributes.publicRoutes` declares
// routes anyone on the internet may call at /door/<id>/<path>, each a power the owner approves, and the daemon hands a
// call to `api.publicRoutes.serve` only once its own protections passed it (the body's size, a per-minute window and a
// daily ceiling, an automation's allowed origins or its door key, a proof-of-work challenge, a provider's signature over
// the body with a sandbox secret the extension never sees, a redelivery answered without it), with what it checked
// (`PublicRouteVerification`). `api.caller(request)` says who a request through `/x/<id>` comes from, as the daemon
// verified them (a person with their tier, areas and the folders those come to, a panel, a program, another extension,
// or nobody on a sandbox without sign-in), read off an assertion the daemon mints for that extension and signs with a
// key only it holds, good for two minutes; `api.daemon.asCaller(caller)` hands it back, and POST /agent then starts the
// turn as that person, held to their access as it stands. And `contributes.listener.strangers` says anyone on the
// internet reaches a source, which holds its wakes to the owner's floor for a visitor or a bug report instead of a team
// chat's. Additive: a manifest without them is unchanged, and `fakeExtensionApi` models `route(path, init, { caller })`
// and `publicRoute`. The recorded surface grows `serverApi`, `daemonApi`, `contributes`, the listener's fields and the
// manifest schema, and the wire's automations schemas (a trigger source's `strangers`).
// 2.54.0 (2026-11-26) lets a card declare what the core read from its own tables keyed by provider name. `channel` on a
// capability contribution says the platform's one-message limit (`messageLimit`, which the approvals inbox counts a post
// against and a gateway reads with connector-runtime's `declaredMessageLimit`), the targets its extension's backend
// publishes an approved post to itself (`publish.target`, a pattern; `api.approvals.publish` receives the post once the
// daemon matched and spent the person's yes, the way `perform` receives an action), and what a publishing turn should
// know about posting there (`posting`). `processors` says where a card sends people's data for the Data protection page
// (its flow, operator, region, third country, hosts and a field naming its server), and `status: { from: "listener" }`
// takes a card's status from its listener's report, with where a pairing code is typed. A public route may require a
// Cloudflare Turnstile token (`turnstile.secret`, a sandbox secret the daemon verifies with, sent as
// `x-intentic-turnstile`), told to the backend as `turnstile: true`. The four the bug intake lost moving onto a public
// door, for any extension: a route's `keyFromBrowsers` (an automation that opts in on its listener trigger,
// `keyFromBrowsers`, lets its key admit a browser whose Origin is not listed), `dailyMax: "none"` on a GET-only route, a
// listener message naming the one automation that hears it (`automationId`), and a held wake named on the dispatch
// stream with the conversation it will run in (`heldWake`). Additive: a manifest, a trigger or a message without them is
// unchanged, and `fakeExtensionApi` models `publish`. The recorded surface grows the manifest schema and the wire's
// listener protocol and automations schemas. The contract's `message-limits` subpath is frozen: nothing reads it but the
// approvals inbox facing an older daemon, and it leaves at 3.0.0.
// 2.55.0 (2026-11-26) tells an extension's agent tools what the turn calling them holds, and lets them act within it, each
// a power the manifest declares under `permissions.turn` and the daemon refuses undeclared. A call's `ToolCallContext`
// carries the turn's `grants` (the sandbox browser accounts it holds, each with the sites it signs in on; the owner's own
// browsers it holds; the cards of the extension's own kinds it holds) and a `ticket` the daemon minted for that call.
// `api.browser.call(context, { account, tool, args })` drives the turn's own signed-in browser for an account it holds,
// through the router and guards the agent's `browser` tools use, held to the page's own tools and the account's own
// sites (`browser`); `api.ownerBrowser.call(context, { browser, tool, args })` calls the owner's browser the turn holds
// through its peer door (`owner-browser`); and `api.jobs.start(context, spec)` files a background job in the calling
// conversation, in a lane of the extension's own, whose work runs in the backend while the agent collects it with `wait`
// and a turn that ended on it is woken by its end (`jobs`). Credentials never reach the extension, and anything the turn
// does not hold is refused. Additive: a manifest without `permissions.turn` and a tool that reads neither field are
// unchanged, and `fakeExtensionApi` models the grants, the ticket, the three calls (`browser`, `ownerBrowser`) and the jobs
// (`jobs`). The recorded surface grows `serverApi` and the manifest schema.
// 2.56.0 (2026-11-26) lets a backend hear CI and write the activity feed, what main's fix agent needed to leave the daemon
// for the pipelines extension. `permissions.events` takes `ci`, and `api.events.onCi(listener)` hears each frame of the
// CI feed as the core's ingestion hears it from a forge (a run that finished, a job that ended, a failed job's frame
// carrying what the forge said of it, `failed`), one frame a batch and an empty batch after a gap in the stream, as the
// workspace's kinds are told. `api.activity.append(row)` writes a row in the sandbox's activity feed as the extension's
// own, through a door every extension token reaches undeclared (`POST /extension/activity`). Additive: a manifest that
// declares neither is unchanged, and `fakeExtensionApi` emits `ci` frames and keeps the rows (`activities`). The recorded
// surface grows `serverApi`, the manifest schema and the wire's CI schemas (the feed's `failed` detail, the forge reads
// a backend asks of the core, main's repair state as it is handed over), and drops the contract routes main's fix agent
// answered from the daemon (`GET /ci/main`, `POST /ci/failures/forget`, `POST /ci/fix`), which its backend answers now.
// 2.57.0 (2026-11-27) lets an extension hear what arrives while a sandbox the platform hosts sleeps. A public route may
// declare `wakes: true` (its only `*` an automation's), a power the owner approves of its own: a call to it at the URL
// `api.sleep.wakeUrl(route, { automationId })` hands out (its wake secret in `?wake=`, the same URL across restarts, to
// paste into a provider's webhook setting) wakes the sleeping machine while an automation on the extension's listener
// provider is on, its sender answered 503 with `Retry-After` until it boots. `api.sleep.beforeSleep(handler)` runs right
// before a hosted sleep under one shared deadline of about ten seconds, and `api.sleep.boot()` says whether the last stop
// was such a sleep and whether a request at a wake door started this boot. The backend and every declared process get
// `api.sleep`, through four doors every extension token reaches undeclared (`/extension/sleep/...`). Additive: a manifest
// or a backend that uses none of it is unchanged, and `fakeExtensionApi` models it (`sleep`). The recorded surface grows
// `serverApi`, the manifest schema and the wire's extension protocol.
// 2.58.0 (2026-11-27) lets a card name the one credential Intentic's servers may hold while a hosted sandbox sleeps, for a
// service that delivers only over a live connection (Discord's gateway). A cli card declares `sleepWatch` (the service,
// its secret field, and a consent switch), and a field may declare `hosted: true`, drawn only on a sandbox Intentic hosts;
// a consent must be such a switch, off by default. Right before a hosted sleep the daemon hands the platform the
// credential of each connection whose owner turned the switch on while an automation listens on the card's provider;
// the platform notes where each message for the bot is and wakes the sandbox, and deletes the credential when it wakes.
// `api.sleep.heard()` answers those notes for the extension's own connections, once. A processor path may sit under a
// `when` over the card's answers. Additive: a manifest that declares none of it is unchanged, and `fakeExtensionApi`
// models `heard` (`sleep.heard`). The recorded surface grows the manifest schema.
// 2.59.0 (2026-11-27) adds a third kind of stranger a listener may declare, `contact` (a sandbox that is not a contact yet
// asking to become one), held to the owner's floor for a contact request, which holds by default; the daemon's own
// `s2s` source (what other sandboxes send) declares it. A trigger source's `strangers` and an agent's needs carry it
// too (a `contact` need, raised when an agent would make or accept a contact). Additive: a manifest without it is
// unchanged. The recorded surface grows the manifest schema and the wire's agents and automations schemas.
export const extensionApiVersion = "2.59.0";
