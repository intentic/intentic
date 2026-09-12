# Capabilities

What a capability is, how one is connected, and what the daemon does with it once it is.

Everything a user adds to a sandbox is a **capability**: one `{ id, kind, config }` entry in a single
discriminated union (`CapabilitySchema` in [schemas/capabilities.ts](../../_shared/sandbox-contract/src/schemas/capabilities.ts)) over the
kinds: `devops`, `monorepo`, `mcp`, `service`, `integration`, `cli`, `plugin`, `extension`, `ssh`, `vpn`,
`exit`, `docker`, `browser`, `host`, `agent`, `endpoint`. There is deliberately **no top-level taxonomy** of "skills vs connectors vs
environments vs secrets": those are overlapping *ingredients*, not disjoint categories (a connector is a
skill + a secret + env injection + maybe an image fragment; an extension is a repo + skills + processes +
views + a fragment), so the model unifies the noun and differentiates behaviour per kind: the same bet
VSCode makes with "everything is an extension", disclosed per item instead of classified up front. The
machinery is uniform:

- **One manifest, and the credentials are not in it**:
  `/work/.intentic/config/capabilities.json` is the source of truth for what's active
  ([capabilities-store.ts](../../_sandbox/sandbox/src/capabilities/capabilities-store.ts)), but every secret FIELD is
  stored under the provider-credential root off `/work`
  ([secret-vault.ts](../../_sandbox/sandbox/src/capabilities/secret-vault.ts)) and the manifest carries a marker in
  its place. The manifest was denylisted from the daemon's file ROUTES, which was never a bound on the agent:
  it holds a shell and the file is deliberately readable and editable, so the credentials in it were one
  ordinary `Read` away from a model's context, the TOTP seed and the browser password included. Reads through
  the store rehydrate, so every consumer still receives a whole `Capability`; list responses echo secrets only
  as `hasToken`/`hasSecret` booleans, and which fields those are is derived from `echo` rather than declared
  twice ([secret-fields.ts](../../_sandbox/sandbox/src/capabilities/secret-fields.ts)). This is exposure removed, not
  a wall: daemon and agent are both root in one container, so the split closes the leak that does not require
  going looking, and the sandbox boundary remains the one that does. Deriving the credential keys as the
  COMPLEMENT of `echo` carries one obligation that is easy to miss and silent when missed: entries are validated
  on read BEFORE the vault is consulted, so a field left out of `echo` is vaulted and the schema must still
  accept the marker in its place: otherwise the entry fails validation and is skipped, and the capability
  vanishes rather than losing a label. `secret-fields.test.ts` pins that round-trip per kind.
- **One lifecycle**: `add` (streams its apply progress live), `remove`, `status`, `setSecret`
  ([capabilities.contract.ts](../../_shared/sandbox-contract/src/contracts/capabilities.contract.ts), orchestrated
  by [capabilities.routes.ts](../../_sandbox/sandbox/src/capabilities/capabilities.routes.ts): precondition check →
  streamed `apply` → manifest upsert → environment recompose).
- **One total registry**: `Record<CapabilityKind, CapabilityHandler>` where a handler is
  `{ requires?, fragment?, apply, status, remove? }`
  ([registry.ts](../../_sandbox/sandbox/src/capabilities/registry.ts),
  [capability.ts](../../_sandbox/sandbox/src/capabilities/capability.ts)): a new kind is a compile error
  until it is handled everywhere, including the effects deriver and the secret/echo switches.

**The catalog is extensible; the handlers are core.** This is the line the whole `/capabilities` grid is
drawn on, and it is the honest version of the VSCode bet for this system. VSCode's core owns the privileged
primitives and extensions *compose* them; here the handlers **are** the privileged primitives: `docker`
bakes `--privileged`, `vpn` and `exit` bake `NET_ADMIN`, `host` pushes the enforcement boundary onto somebody's
personal laptop, `extension` installs extensions. A manifest that could contribute one of those is a
manifest that grants itself privilege, so **no handler is contributable, ever**. What an extension supplies
instead is a **card**: the data that varies between two cards served by the *same* handler.

Four kinds are card-driven, and the restriction is the `CapabilityContributionSchema` discriminated union
([capabilities.ts](../../_shared/extension-manifest/src/points/capabilities.ts)) rather than prose: a manifest naming any other kind
fails to parse:

| Contributable kind | What the card carries | Who ships the first-party ones |
| --- | --- | --- |
| `cli` | fields + env templates + a SKILL.md + an optional client-image fragment | `connectors`, `discord`, `slack`, `imap` |
| `browser` | a login URL + a home URL + a SKILL.md (one Chromium serves every platform, that stays core). Both URLs are OPTIONAL: a site card pins them, and the generic `website` card ("Browser session") pins neither and declares the fields that supply them, which is what lets a user connect a site nobody shipped a card for. A skill template may quote the card's own fields (`${homeUrl}`), never a `secret` one. | `social`, `connectors` |
| `host` | an OS skill pack (enrollment, socket and scope enforcement stay core) | `devices` |
| `agent` | field defaults only: a preset over one config shape | `acp-agents` |

Everything else keeps a static card in `CAPABILITY_CATALOG`
([capability-catalog](../../_shared/capability-catalog/src/index.ts)), and every one of those is one-to-one with a
handler it cannot be separated from. `integration` is the instructive case: its card *looks* like pure data,
but it becomes an `i.have.<provider>` entry that only the desired-state resolver's closed
`InventoryProviderSchema` vocabulary understands: so the vocabulary belongs to the deploy engine, not to a
manifest, and Stripe stays static.

The web's grid ([Capabilities.vue](../../_editor/web/src/features/capabilities/Capabilities.vue)) merges the static cards with cards
**derived** from the **enabled** extensions' `contributes.capabilities` (`contributionCard()`). Enabled, not
merely installed: a switched-off extension stays listed so its switch stays reachable, but the daemon wires
none of its contributions up, so a card from one would advertise an add that fails. So a derived card exists
**iff** its capability is actually addable, third-party cards surface automatically, and the manifest is the
single source of a card's name/logo/fields/credential guide: nothing to drift.

Two things the core injects into a derived card rather than letting the manifest declare them, both because
a card that could restate them is a card that could get them wrong: the kind's **discriminator**
(`contributionDiscriminator()`: the `provider`/`platform` key pinned to the card's own id, which is what
traces a stored capability back to the card that made it), and the connected-computer **scope switches**
(the grant does not vary by OS, so two platform packs cannot drift on it and neither can a third-party one).
Contributed SKILL.md files get two substitutions on apply (`renderSkill()` in
[contributions.ts](../../_sandbox/sandbox/src/capabilities/contributions.ts)): `${id}` → the instance name, so a
host pack's examples read `mcp__my-laptop__run_command`; and `${tools}` → the kind's core tool-surface note,
which is core precisely because the same note duplicated across N packs is a note that drifts.

**Effects: what adding actually does, as data.** Kinds differ wildly in consequence (an extension runs
code with your session; a vpn bakes an image fragment with runtime directives; a cli connector just writes a
skill and stores a secret), so the consequences are a first-class taxonomy: the `CapabilityEffect` union, derived by
`capabilityEffects()` ([effects.ts](../../_shared/capability-catalog/src/effects.ts)) from kind + live config +
connector/extension contributions: the same data the handlers consume, so there is no per-card effects
list to maintain. It lives in the CATALOG, beside the cards that declare the same kinds, rather than in the wire
contract: nothing on the wire carries an effect, only the browser computes them, so a kind's user-facing story
(its card, its fields, what adding it does) is one package to open. A `Record<CapabilityKind, …>` table rather
than a switch, so a new kind is one entry with the same exhaustiveness the compiler enforced before. Rendered as
the "This will add to your sandbox" panel
([CapabilityEffects.vue](../../_editor/web/src/features/capabilities/connect/CapabilityEffects.vue)) before the add, as compact strips
on connected instances, and as grid badges for the consequential ones (image / runtime / trusted-code).

| Effect | Mechanics |
| --- | --- |
| `skill` | Writes `.agents/skills/<name>/SKILL.md`: the vendor-neutral loaded folder every runtime reads (Claude Code through per-skill symlinks under `.claude/skills/`, loader-less runtimes through an opening prompt catalogue), per-instance for `cli`/`browser` (the instance id is the skill name), shared for `ssh`/`vpn`/`exit` (whose skill is `geo`, after its command). |
| `secret` | `agent-env`: injected into the agent's environment each turn, never written to disk (`cli`). `disk`: a `0600` file, or a field in the off-workspace secret vault the manifest points at with a marker (ssh key/password, WireGuard conf, git token). |
| `clone` | Git checkout into `.intentic/records/plugins/<id>` or `.intentic/local/extensions/<id>` (staged → pinned detached checkout → swap; tokens ride `GIT_CONFIG_*`, never the URL). |
| `image` | A Dockerfile fragment composed into the environment overlay: needs a one-time owner-run rebuild. |
| `runtime` | Privileged directives riding a core fragment, the ONLY source of container privileges (the base run is unprivileged): `vpn` → `NET_ADMIN` + `/dev/net/tun`, `docker` → `--privileged`. A handler may return SEVERAL fragments, and the tun grant is one shared string ([net-privileges.ts](../../_sandbox/sandbox/src/capabilities/handlers/net-privileges.ts)) contributed byte-identically by `vpn` and `exit`: fragments dedupe by exact content, so two near-identical privileged blocks would survive the set and hand `docker run` the same `--device` twice. It also lets a kind ask only in the configurations that need it, a tor-only `exit` contributes no directive at all. |
| `process` | Long-lived tmux-managed background processes (an extension's declared `processes`), restored on boot. |
| `mcp` | The manifest entry itself becomes an `mcp__<id>__` server the agent connects to next turn. |
| `scaffold` | Repos created in the workspace: `devops` → the intent + desired-state repos; `monorepo` → an empty pnpm+turbo repo named after the instance. |
| `deploy` | A managed `deploy.config.ts` entry; `service` also runs the shared infra-apply job now, `integration` applies on the next provision. |
| `trusted-code` | Extension code runs inside the app with the owner's session: owner-only, full-sha-pinned install; the trust decision of the system. |
| `profile` | A persisted logged-in Chromium profile under `.intentic/local/browser/<id>`, keyed by the CAPABILITY, so one site can be connected several times over (a work Reddit and a personal one) and each account signs in, and is disconnected, on its own. Established through the guided-login WebSocket (`/system/browser-login`), the credential is a browser session, not a token. Beside it, `<id>.passkeys.json` holds any WebAuthn credential enrolled in that browser: a CDP virtual authenticator is armed on every page of a logged-in browser, so the sandbox owns a software security key for that account and answers its 2FA ceremonies itself ([passkeys.ts](../../_sandbox/sandbox/src/browser/tools/passkeys.ts)). Both die with the connection. |

**Environment fragments have two trust tiers.** Core handler fragments (`vpn`/`exit`/`browser`) are
code-authored and may carry privileged `# intentic:runtime` directives; extension/connector checkout
fragments are restricted to RUN/ENV instructions: the whole "what can an extension bake into the image"
security surface is `invalidExtensionFragment`
([overlay-lint.ts](../../_shared/sandbox-contract/src/policy/overlay-lint.ts) in the contract, where `lintOverlay` and
`hasOfficialBase` read a whole composed overlay by the same grammar for every executor, the platform's
hosted rebuild included; applied by
[fragment-sources.ts](../../_sandbox/sandbox/src/environment/fragment-sources.ts)). `composeEnvironment` folds
every active entry's fragments (a cli entry resolves its connector's fragment through the registry; an
extension entry its `contributes.environment`) into the overlay Dockerfile (`FROM` the base image), and an
owner-run rebuild applies it: until then the capability reads `pending` and the UI routes to the
Environment card.

The AGENT's half of that surface is the custom section, and it proposes into `.intentic/config/environment.d/`:
one `<tool>.Dockerfile` per thing it needs: rather than writing the proposal directly. Worktree-isolated
agents run in parallel, so a single shared proposal file would lose one of two concurrent drafts; naming each
draft for its tool also makes two agents needing ffmpeg converge on one entry. `readEnvironment` folds the
drafts plus the already-approved custom section into the one proposal the owner reviews (approval *replaces*
the custom section, so carrying it forward is what stops an approve from silently uninstalling everything
before it), and approve/reject clear the drafts. A `PreToolUse` hook
([agent-installs.ts](../../_sandbox/sandbox/src/agent/providers/agent-installs.ts)) is what starts the flow: an image-scoped
`apt-get install`/`pip install`/`npm -g` is met with a one-per-turn note that the install dies with the
container and a draft is how it survives. It steers rather than blocks: project-scoped installs and venvs
are ordinary and are left alone.

Per-kind mechanics ([handlers/](../../_sandbox/sandbox/src/capabilities/handlers/)):

| Kind | On add |
| --- | --- |
| `devops` | Scaffolds the intent + desired-state repos (each its own operator panel): the foundation `service`/`integration` require. Not removable. |
| `monorepo` | Scaffolds an empty pnpm+turbo repo named after the instance; apps are added from its operator panel. |
| `mcp` | Pure registration: no side effect beyond the manifest entry; `status` probes the URL. |
| `service` | Upserts an `i.want.service` entry into `deploy.config.ts`'s managed region and runs the infra-apply job, relaying its events. |
| `integration` | Upserts an `i.have.<provider>` backend entry; the secret (e.g. `STRIPE_API_KEY`) is read from sandbox env at provision time. |
| `cli` | Card-driven (data from `contributes.capabilities`): templates the connector's SKILL.md into `.agents/skills/<id>`, injects the credential into the agent's env each turn, optionally bakes a client-image fragment (psql, mysql, whisper). github/gitlab additionally run the core git-access hook (keypair registered to the account + an https credential, restored on every boot); `status` reports `pending` when that credential is missing, so the card can't read active while `git pull` fails. |
| `plugin` | Clones a Claude Code plugin repo into `.intentic/records/plugins/<id>`; the Agent SDK's loader reads its skills/agents/hooks/`.mcp.json` each turn. A marketplace repo (`.claude-plugin/marketplace.json`) can pre-fill the form. |
| `extension` | Owner-only, sha-pinned clone into `.intentic/local/extensions/<id>`, validated before swap (manifest parses, prebuilt entry exists, fragment RUN/ENV-only); starts declared `autoStart` processes. |
| `ssh` | Writes a per-machine Host block + `0600` key/password under `~/.ssh/intentic-hosts` (the /history-backed dir above) + the shared ssh skill; the instance id is the alias the agent uses (`ssh <id>`). |
| `vpn` | Stores ONE connection, discriminated by `provider`, `wireguard` (pasted `.conf`, `wg-quick`), `fortinet` (FortiGate SSL-VPN via `openconnect --protocol=fortinet`), `ipsec` (IKEv1/IKEv2 PSK + XAuth via strongSwan), plus the shared vpn skill. Connecting is NOT part of the config: see [VPN](#vpn) below. |
| `exit` | Stores ONE POOL to come out of, discriminated by `provider`, `tor` (free, no account, ~28 usable countries, and no container privilege at all), `vpngate` (free, no account, the University of Tsukuba's volunteer relays, mostly Japan/Korea), `wireguard` (one or more pasted `.conf` files, so Proton VPN's free tier or Mullvad become a pool), plus the shared `geo` skill. Starting, switching country and rotating are NOT part of the config: see [Geo exits](#geo-exits) below. |
| `docker` | The engine is baked into the base image, dormant; the fragment is a lone `--privileged` runtime directive (a cache-hit rebuild, not an install). Once privileged, runs `dockerd` in a persistent tmux session, restored on boot: so `pnpm db:up` works like a local dev machine. Not removable. |
| `browser` | ONE ACCOUNT on a site, not one site: per-instance platform skill (rendered from the contributed pack), and profile/login/passkey/tool-prefix all keyed by the instance id, so `reddit-work` and `reddit-personal` are two real accounts the agent drives separately in the same turn. Connecting is a guided live login that persists the profile the agent's `@playwright/mcp` drives, headed on a virtual X display with the stealth patch. That window, and the view onto the agent's own browser, are the SAME PICTURE: H.264 grabbed off the display with ffmpeg and driven back through XTEST (`browser/videocast.ts`, `browser/xinput.ts`), which is a change from the CDP screencast that came before it and a change of kind rather than degree. A screencast photographs one page's compositor surface, so it carries no cursor, no open `<select>`, no autofill drop-down, no file picker and no browser chrome — all of which are on the DISPLAY. Capturing the display puts every one of them in the picture, and driving the same display makes every one of them clickable, which deleted the drop-down-menu reimplementation and the HTML address bar that existed only because the picture was the page alone. It is also about a hundredth of the bytes: three seconds of a settled page is ~23 kB where one JPEG frame of it was 150-250 kB. One display per profile owner, because a pointer belongs to the X server rather than to a window and two browsers sharing one would share a cursor (`browser/display.ts`). The STEALTH PATCH presents ONE STABLE DEVICE PER PROFILE OWNER — GPU, core count, memory, clock — derived from a per-sandbox secret seed (`browser/fingerprint.ts`), so an owner's profiles are not linkable to each other by their hardware and no two sandboxes share a signature. The clock is the one part drawn per SANDBOX rather than per owner, because it has to agree with the address traffic leaves by and every profile shares one — unless it doesn't: a profile bound to a geo exit takes that exit's country instead, which is the same rule rather than an exception to it (see [Geo exits](#geo-exits)). Stable rather than randomised on purpose: these profiles hold live logins, and a device that shifts underneath a cookie is what session-binding checks exist to catch. The site cards (Reddit, X, YouTube, npmjs.com) are PRESETS over one generic card: `website` ("Browser session") asks for the page to open, an optional separate sign-in page and a one-line purpose, so any site is connectable without shipping an extension, and a preset is that card with the addresses pinned and a cheatsheet attached. This capability buys *identity*, not the browser itself: Chromium is baked into the base image and every turn already gets a credential-free `mcp__web__browser_*` server (`--isolated`, no profile on disk, headed on a display of its own and carrying the same stealth patch, falling back to headless only where the pack has never been installed — which is also the one case the view still shows CDP frames, because a headless browser has no window to grab), because reading a page is ordinary coding work and a WAF turns the headless shell away whether or not anyone is signed in. |
| `host` | A computer of the user's OWN, one capability per machine. Writes the contributed OS skill pack, then pushes the scope switches to the machine if it is up: an edit is a decision about what may happen on somebody's computer *now*, so it travels immediately rather than at the next reconnect. The machine connects itself out-of-band (the card's one-liner enrolls over `/system/hosts/enroll` and dials back); enforcement is on the machine, never here. |
| `agent` | An ACP agent as a chat provider. `apply`/`status` are a spawn + initialize probe, so a command that doesn't actually speak ACP is caught (with its stderr) before the first chat turn depends on it; the warm turn-serving connection lives in the acp pool. |
| `endpoint` | A model API the user pointed us at. `apply` and `status` are the SAME probe and neither is fatal: adding an endpoint whose server isn't up yet is the ordinary case, so the entry is stored either way and the card carries the truth ("3 models" vs "no models", the usual way an Ollama install disappoints its owner). |

## A reachable machine is never asked to type

A connected `host` capability is a way IN to somebody's computer, so anything that has to happen out there is
run from here rather than written out for them to paste. That includes the machine a sandbox itself runs on:
`hostRunningSandbox` ([schemas/devices.ts](../../_shared/sandbox-contract/src/schemas/devices.ts)) is the one predicate
for "which connected, online device reports this sandbox's container", read by the browser through
`useHostRunning` ([useDevices.ts](../../_editor/web/src/features/sandbox/devices/useDevices.ts)) and by the daemon
through `hostRunningSelf` ([self-host.ts](../../_sandbox/sandbox/src/hosts/self-host.ts)), which answers from readings
already held so composing a turn never waits on a laptop.

What that buys, per surface: a button where there used to be a command (the update/rebuild/rollback card, the
container repair, the dev reload, the rebuild of a checkout-built sandbox from its checkout, deleting a sandbox
from the machine holding it, enrolling desktop sync on a device already connected), and a paragraph in every
turn's prompt naming the machines it can act on
([system-prompt.ts](../../_sandbox/sandbox/src/agent/prompt/system-prompt.ts), plus the same rule in the per-device skill
pack, [host-skills.ts](../../_sandbox/sandbox/src/hosts/host-skills.ts)).

A machine can also be reachable without being a way in: desktop sync is deliberately capability-free, so a laptop
syncing files holds no card and `hostRunningSandbox` can never name it. That is the state the command block is
printed in most often, and it has a second question of its own — `deviceSyncingSandbox`
([deviceRows.ts](../../_editor/web/src/features/sandbox/devices/deviceRows.ts)), "which machine holds this sandbox's
sync pairing and no command door". It answers with a machine to OFFER connecting, never with the machine a sandbox
runs on: syncing is not proof of hosting, since a laptop can sync into a sandbox running elsewhere.

Three rules hold the line:

- **The command line is built here, from a closed set of names** ([device-commands.ts](../../_sandbox/sandbox/src/hosts/device-commands.ts)).
  The two commands whose argv needs more than a name take it from what only the daemon knows — the dev checkout
  recorded on the container, a pairing minted for that one call — never from the caller. The only
  caller-supplied string that reaches a line is a folder on the device, shaped by `DeviceLocalDirSchema`.
- **A copyable command remains, as the fallback.** A device that is asleep, absent or refusing the scope still
  leaves the owner a way, and so does a refusal the button itself earned. Bootstrap is the honest exception:
  the first connect, the setup one-liners and the compose file cannot be run on a machine we have no door to.
  Where the fallback is printed only because nothing has been connected yet, it carries the way out beside it
  ([ConnectDeviceHint.vue](../../_editor/web/src/features/sandbox/devices/ConnectDeviceHint.vue)): the machine
  already syncing this sandbox, named, and a link to the card that would give it commands.
- **A refusal is the machine's answer, in its words.** Nothing here judges a scope; the daemon relays and names
  the switch. Anything that restarts the sandbox serving the request is expected to lose its own answer, so the
  caller treats a dropped connection as the ending rather than a failure.

## One list of machines, two doors onto them

A machine reaches this sandbox through either of two doors, and only one of them is a capability. The `host` card
is a way in: commands, files, screen. A desktop-sync enrollment is not, on purpose — syncing a folder never had to
come with a shell — so it lives in `sync-enrollments.json` and holds no card.

`mergeDevices` ([device-reports.ts](../../_sandbox/sandbox/src/hosts/device-reports.ts)) reconciles both into the one
list served at `/system/devices`, and every screen that asks "which machines do I have" reads it: the Devices board,
and the Capabilities device cards, which state a sync-only machine as a row of their own
([deviceConnections.ts](../../_editor/web/src/features/capabilities/model/deviceConnections.ts)) with the word and
colour the board gives it and the one thing it cannot do yet. Before that, Capabilities knew only the card door, so a
live machine could be listed on one screen and missing from the other.

Folding two readings into one row is where a name stops being enough. **WSL hands a distro the Windows machine's own
hostname**, and a distro is usually named after the machine too, so both of merge's keys collide between environments
that share nothing else — separate filesystems, separate agents, separate containers. The agent therefore reports
which environment it is (`wsl`, [wsl.ts](../../_devices/machine/src/wsl.ts)), and a fold is refused whenever the two
sides positively disagree about that or about their platform (`differentEnvironment`,
[schemas/devices.ts](../../_shared/sandbox-contract/src/schemas/devices.ts)). Silence is not disagreement: an agent too
old to report `wsl` folds exactly as it did before the field existed. A distro says so in the loudest ink its row has
("Arch on WSL"), since that is the whole difference between it and the Windows row beside it.
