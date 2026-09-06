# The app plane: the product you look at

The editor and the surfaces it draws — personas, the VPN and geo exits, and the two dependency islands that
are deliberately not part of anything else.

## The app plane: the product

The **app plane** is the intentic product: the co-piloted agent workspace a user actually looks at, a
VSCode-shaped file editor. (The intent→reconcile **deployment engine** documented in the preceding sections
is a *bundled tool* the sandbox can run (one tool among many) not part of this product.) The app plane's
dependency edges into `@intentic/*` all go through `sandbox-contract` (and one type-only reach into
`@intentic/resources` from `api-contract`); the engine core never depends back on the app.

| Package | Role |
| --- | --- |
| [`@intentic/web`](../../_editor/web) | The Vue 3 SPA shell: the editor UI (rail · workspace tree + file viewers + Monaco · chat). Signs in against the platform, then drives the sandbox daemon **directly** over its tunnel. The **extension host** lives here. |
| [`@intentic/api`](../../_platform/api) | The thin platform: Better Auth sign-in + the `setup.*` handshake. Off the command path (see topology above). |
| [`@intentic/desktop-app`](../../_editor/desktop-app) | The Windows/Linux desktop app (Tauri 2). Its workspace window IS the hosted SPA, with no IPC: the only channel in is an intercepted `intentic://` link. The native half runs the SHIPPED scripts (`connect.sh`, `recreate.sh`, `cleanup.sh` and their PowerShell twins) rather than reimplementing them, so the desktop and terminal paths are the same file; and because the daemon holds no host Docker socket, this app is the only thing that can turn "paste this command on the machine that runs your sandbox" into a button. Sign-in happens in the user's real browser and returns over the deep link (Google refuses embedded webviews). See [_editor/desktop-app/README.md](../../_editor/desktop-app/README.md). |
| [`@intentic/sandbox`](../../_sandbox/sandbox) | The per-user daemon (documented under [The sandbox daemon](#the-sandbox-daemon)), also the app plane's whole backend: workspace files, chat, terminals, panels, search, settings, and the daemon-side half of the extension system. |
| [`@intentic/sandbox-contract`](../../_shared/sandbox-contract) | **The keystone wire contract**, the oRPC route + schema surface shared by the daemon, the web client, and every UI extension (~15 dependents). It is deliberately *the* first-party data contract: because everything that consumes it is in-repo and compiled together, a wire change is caught by the compiler and fixed atomically, so there is no separate "stable API" shim to maintain. |
| [`@intentic/api-contract`](../../_shared/api-contract) | The platform (web↔api) oRPC contract. |
| [`@intentic/ui`](../../_editor/ui) | The app design system (PrimeVue + Tailwind primitives). |
| [`@intentic/capability-catalog`](../../_shared/capability-catalog) | Capability/connector catalog data: rendered by the web, and read by the daemon to validate an agent's in-chat ask to connect a capability. |


### Personas

A `browser` capability is ONE ACCOUNT; a **persona** is the card that says which of those accounts are the
same someone (`.intentic/config/personas.json`: part of the config slice under `.intentic` that is committed, because
it holds no secret). A turn names one via `actsAs`, and `turnPersona()`
([personas.ts](../../_sandbox/sandbox/src/personas/personas.ts)) resolves it in one place: an attended turn naming
none keeps every account, an **unattended** one naming none gets NONE, a named card gets exactly its accounts,
and a named card that does not exist gets none: fail-closed, because falling back to "all" would turn a typo
into the one mistake that cannot be undone. The narrowing filters the MANIFEST before the browser servers are
built, so a disallowed account has no MCP server, no Chromium and no opened profile. The card also carries what a
session wearing it may DO (`powers`: the shelves, and the connectors, devices and MCP connections it may reach
by id) and where it works, and nothing an owner has to compose: a card holds no prose and no publish-or-draft
switch, because the approvals queue is what actually holds a post back. Two surfaces name one: an automation's form, answered
once when the job is written, and the chat composer's persona pill, which starts at *anyone* and is per
conversation rather than remembered: resolved per TURN, so a chat can change who it is mid-conversation. Full
model, diagrams and the honest limits: [docs/accounts-and-personas.md](../../docs/design/accounts-and-personas.md).

### VPN

A VPN is the one capability whose *stored* form and *live* form come apart, so it is modelled as two surfaces
rather than one. **Adding** a VPN is an ordinary capability (`vpn`): credentials plus `autoConnect`, in the
manifest, per the table above. **Connecting** one is a runtime operation on the `/vpn` routes
([vpn.contract.ts](../../_shared/sandbox-contract/src/contracts/vpn.contract.ts),
[vpn/](../../_sandbox/sandbox/src/vpn/)): because a single stored connection is dialled and dropped many times, its
result is far richer than a `CapabilityStatus` (assigned address, routed CIDRs, pushed DNS, uptime), and a
2FA-gated dial needs a per-attempt code that must never be persisted.

The design rule that makes this safe is that **a link's state is always read back from the OS**: `wg show`,
openconnect's pidfile plus `ip -j addr/route`, `ipsec statusall`: and never remembered by the daemon. So a
tunnel the agent dropped, one the operator dropped, and one whose gateway died all read identically, and a
daemon restart observes the truth instead of a stale guess.

Three protocols, one driver each, total over the provider union
([vpn-drivers.ts](../../_sandbox/sandbox/src/vpn/vpn-drivers.ts)) so a new arm on the contract is a compile error until
it is implemented:

| Provider | Client | Notes |
| --- | --- | --- |
| `wireguard` | `wg-quick` | The pasted `.conf` IS the connection; the dial is synchronous, so there is no client process to supervise. |
| `fortinet` | `openconnect --protocol=fortinet` | FortiGate SSL-VPN, what FortiClient's `<sslvpn>` connections speak. **openconnect, not openfortivpn**: it routes over tun instead of spawning `pppd`, so it needs exactly the `/dev/net/tun` + `NET_ADMIN` grant this capability already carries and no `/dev/ppp` (which the rebuild executors' runtime allowlist deliberately does not include). The password reaches it on **stdin**, never argv, so it is absent from `ps` and from disk. |
| `ipsec` | strongSwan | IKEv1/IKEv2 with a PSK and optional XAuth, FortiClient's `<ipsecvpn>` connections, aggressive mode included. Each connection is its own pair of files under `/etc/ipsec.d/intentic`, which `/etc/ipsec.conf` and `/etc/ipsec.secrets` `include`, so one tunnel is written and torn down without regenerating the others. `routedNetworks` is the traffic selector this client offers (strongSwan's `rightsubnet`), and it is a **config field rather than a fixed `0.0.0.0/0`** because a gateway does not have to narrow what it is offered: a FortiGate accepts the catch-all and then drops what it has no route for, which takes the sandbox's own outbound connections (the agent's included) down with it. It still defaults to `0.0.0.0/0`, since narrowing it for everyone would cut existing tunnels off from networks they reach today. |

All three ride **one** environment fragment rather than one per protocol: adding a second kind of VPN later must
not cost a second container rebuild. The runtime directives are a SECOND fragment, shared verbatim with the
`exit` kind ([net-privileges.ts](../../_sandbox/sandbox/src/capabilities/handlers/net-privileges.ts)), because they
must appear exactly once in the composed overlay: fragments dedupe by exact content, and rebuild.sh appends
each directive token it reads without deduplicating, so a doubled `--device` would fail the run.

**The agent drives the same routes the browser does.** `/usr/local/bin/vpn`
([bin/vpn](../../_sandbox/sandbox/bin/vpn)) is a thin client over `/vpn`, taught by the shared `vpn` skill, so a tunnel
the agent dials appears in the operator's UI with nothing synchronising the two: there is one implementation
of what connecting means. It authenticates with a per-boot token from `/run/intentic/agent.token`
([agent-token.ts](../../_sandbox/sandbox/src/auth/agent-token.ts)) that `app.ts` admits **only** to `/vpn`: the agent
may dial and drop the tunnels the owner configured, and can never read the credentials behind them.

A user holding an exported FortiClient configuration imports it rather than re-keying endpoints
([forticlient-config.ts](../../_sandbox/sandbox/src/vpn/forticlient-config.ts)). Credentials in that file are wrapped in
FortiClient's machine-bound `EncX` encryption and are **not** recoverable, so every encrypted value is dropped
and reported as a field the user must supply: importing an unusable value would be worse than asking.

### Geo exits

A **geo exit** is somewhere chosen traffic can *leave* from, so a page fetches as if read in Berlin or Osaka.
It is its own capability kind rather than a fourth `vpn` provider, and the distinction is what makes it safe:

| | `vpn` | `exit` |
| --- | --- | --- |
| Purpose | reach a private network | appear somewhere else |
| Shape | one stored gateway | a pool with a catalog |
| Runtime verbs | connect / disconnect | start, use `<country>`, rotate, stop |
| Routing | pushes routes into the main table | routes **nothing** into the main table |
| Success test | "the tunnel is up" | "my egress address is now in DE" |

**It never touches the default route, and everything else follows from that.** An exit is a full tunnel by
construction, so a default route in table `main` would swallow the daemon's own uplink, the model endpoint and
the tunnel that makes this sandbox reachable, and the symptom is the agent going silent mid-turn with no
mention of a VPN (`IpsecVpnConfigSchema.routedNetworks` documents the same trap on the `vpn` kind, where it is
at least the user's explicit choice; here it would be the happy path). So each exit puts its default route in
a **private routing table** and installs exactly one `ip rule` into it: traffic whose *source* is the tunnel's
own address ([exit-routing.ts](../../_sandbox/sandbox/src/exit/exit-routing.ts)). Nothing acquires that source
address by accident: a socket has to ask for it with `localAddress`, which the exit's own SOCKS proxy does
([exit-socks.ts](../../_sandbox/sandbox/src/exit/exit-socks.ts)) and nothing else in the container does. A live exit
is therefore completely inert until something opts in, which is also what keeps a volunteer relay from ever
carrying the agent's own working traffic. Source-address matching rather than uid ranges or firewall marks
because it needs only `CAP_NET_ADMIN`, which the `vpn` fragment already grants; a netns would want
`CAP_SYS_ADMIN` and put the capability in a higher privilege bracket for nothing.

**A switch is only true once it has been observed.** The drivers know how to bring a tunnel up; the links
layer ([exit-links.ts](../../_sandbox/sandbox/src/exit/exit-links.ts)) insists it came up *where it was asked to*, by
fetching an `ExitObservation` — the egress address and its country — **through the exit's own proxy** before
reporting success. A start or a `use` that cannot prove its country takes the exit back **down** rather than
leaving something running that a browser would happily use while believing it was elsewhere. Hostnames resolve
through the exit too ([exit-dns.ts](../../_sandbox/sandbox/src/exit/exit-dns.ts), DNS over TCP from the tunnel's
source address, because Node's resolver cannot be told one): a lookup over the plain uplink does not leak the
address, it leaks the *location*, and geo-aware CDNs and search engines route on the resolver's.

Three providers, one driver each, total over the provider union
([exit-drivers.ts](../../_sandbox/sandbox/src/exit/exit-drivers.ts)):

| Provider | Free | Countries | Client | Notes |
| --- | --- | --- | --- | --- |
| `tor` | yes, no account | ~52, **28 usable** | `tor` | The free default, and the only one that needs **no container privilege at all**: tor publishes its own SOCKS port, so there is no tun device, no routing table and no `ip rule` in this driver. Country is a torrc line and a new address is a control-port `NEWNYM`, both applied to a running process in under a second. `StrictNodes 1` always accompanies `ExitNodes`, or tor treats the country as a preference and leaves from elsewhere when it is congested, which is the one outcome this feature must never produce silently. |
| `vpngate` | yes, no account | 10, **87% JP/KR** | `openvpn` | The University of Tsukuba's volunteer pool. Its public CSV *is* the catalog, so a user picks a country and never sees a hostname. Worth having beside tor precisely because it covers the half of the map tor covers worst. `route-nopull` is the load-bearing directive: without it OpenVPN installs the server's pushed default route into table `main`. |
| `wireguard` | bring your own | as many as pasted | `wg-quick` | One or more `.conf` files pasted together become one pool, which is what turns Proton VPN's free tier or a Mullvad account into a country switcher. Country is auto-labelled from what providers already write (`# NL-FREE#1`, `de-ber-wg-001.…`), narrowly, because a mislabel is worse than no label. `DNS =` is **stripped** (wg-quick applies it by rewriting `/etc/resolv.conf` for the whole container) and `Table = off` injected. |

**The exit belongs to the browser PROFILE, not to the account.** `profileOwner`
([session-store.ts](../../_sandbox/sandbox/src/browser/sessions/session-store.ts)) already decides what an account's browser
*is*: an identity-born account shares its identity's Chromium profile, cookies and passkeys included. Where
that browser appears to be is such a fact, so an account inside an identity takes the identity's exit and its
own field is ignored ([browser-exit.ts](../../_sandbox/sandbox/src/browser/sessions/browser-exit.ts)). Letting an account
override its identity would let one signed-in Google session appear from two countries at once, and sites do
not flag "datacenter address" anywhere near as hard as they flag a session that teleports. A bound profile also
gets the **timezone, locale and `navigator.languages`** of the country it comes out of: a German address under
a New York clock is a sharper signal than never having moved. Those three are not set here, they are handed to
[fingerprint.ts](../../_sandbox/sandbox/src/browser/sessions/fingerprint.ts) as that profile's `place`, because that module
already owns the rule that the clock follows the EGRESS and a bound profile is simply one whose egress is not
the sandbox's; everything else about its device (GPU, cores, memory) still comes from the seed, so it is the
same machine sitting somewhere else. The country codes become a zone and a language through ICU rather than a
table ([exit-countries.ts](../../_sandbox/sandbox/src/exit/exit-countries.ts)). `Accept-Language` is spelled out from
that list rather than left to Playwright, which derives the header from the locale alone and would send one tag
under a three-tag `navigator.languages` — a header contradicting a page property about the same fact is the
kind of internal inconsistency detectors weight above any unusual value. An exit that cannot be brought up
**refuses the browser** rather than opening it from the sandbox's own address.

**A bound profile's exit is started on a budget, and only on the turn path.** Resolving the binding runs before
*every* turn, for every bound owner, whether or not the turn goes near a browser, so an unbounded start put a
cold tor bootstrap's two minutes in front of a turn that only wanted to edit a file. Turn setup now resolves
every owner concurrently and waits a few seconds each
([browser-tools.ts](../../_sandbox/sandbox/src/browser/tools/browser-tools.ts)); the owner's own login window, where a
person is watching a spinner, still waits as long as it takes. Neither half of the guarantee is traded away: a
start that outruns the budget carries on in the background under `startExitOnce`, which shares one attempt per
exit so the next turn joins it rather than dialling a second time against the same interface and proxy port,
and the owner is simply **absent from this turn** — never a browser opened without the proxy.

**The agent drives the same routes the operator does.** `/usr/local/bin/geo`
([bin/geo](../../_sandbox/sandbox/bin/geo)) is a thin client over `/exit`, taught by the shared `geo` skill, on the
same per-boot token as `vpn`. It is called `geo` rather than `exit` because **`exit` is a shell builtin**: a
binary of that name is unreachable from any command line (`exit list` closes the shell instead of running it),
which is a failure that would only have surfaced the first time an agent tried. The capability, the routes and
the manifest entry keep the word, where nothing shadows it. The skill states the three things an agent
otherwise gets wrong: nothing is
proxied unless pointed at the proxy, a large share of the web blocks tor exits (that is the destination's
choice, not a broken exit), and these are datacenter addresses that a site which checks will see.

Two runtime invariants ([exit/invariant.ts](../../_sandbox/sandbox/src/exit/invariant.ts)), both for promises that
are established once and then never re-checked on the normal path: no exit interface ever appears in table
`main`, and an exit that reads `up` still comes out where it was verified.

### Dependency islands: iq & lsp

Two recent subsystems are **agent-facing subprocess CLIs baked into the sandbox image**: the agent invokes
them by spawning a process, never by import:

- **iq** ([`@intentic/iq`](../../_search/iq) + [`@intentic/iq-engine`](../../_search/iq-engine) +
  [`@intentic/iq-recall`](../../_search/iq-recall) + [`@intentic/iq-bench`](../../_search/iq-bench)): an agent-native
  workspace-search engine: a local index (SQLite) fused across lexical (ripgrep), structural (ast-grep),
  semantic (local embed + rerank), and git signals, rendered to a token-budgeted ranked answer. It replaces
  an agent's grep/find chains with one call. The **CLI** stays a subprocess (the agent's Bash calls), but the
  **engine library** is also linked into the daemon: `/workspace/search` runs a resident
  `createResidentEngine` instance in-process (index DB held open, sweep cached, revalidation driven by the
  workspace watcher), sharing the on-disk index with the CLI. Search is a **core editor feature**; iq is
  merely the interchangeable engine behind that route.
- **lsp** ([`@intentic/lsp`](../../_search/lsp)): an agent-facing TypeScript CLI (`lsp rename`, `lsp diag`) over the
  **native TypeScript compiler** (`@typescript/native-preview`, the Go port), advertised to the agent through
  a gated skill file. TypeScript/JavaScript only. Unlike iq there is no resident half at all: every question:
  the agent's `lsp diag`/`lsp rename` and the daemon's post-edit hook
  ([agent-diagnostics.ts](../../_sandbox/sandbox/src/agent/verification/agent-diagnostics.ts), which imports
  `@intentic/lsp/client`): is a fresh compiler run that parses the file's tsconfig project, answers, and
  exits. The native compiler checks a package-sized project cold in 0.1–2s, at or below what the previous
  resident JS-compiler daemon answered in *warm* through its socket, so per-edit checking stays affordable
  with zero resident memory: where the daemon it replaces held ~1 GB of warm program per view of the tree
  (one per concurrent agent worktree) for a 15-minute idle window. The client single-flights concurrent asks
  per project and pools a burst of edits into one trailing rerun, so six edits in a second cost two runs, not
  six. Rename holds one short `tsgo --lsp` conversation for the server-computed project-wide edit, then tears
  the process down. WHERE a check runs still follows the agent's view of the tree: an anchored turn's
  dependencies exist ONLY inside its namespace, so the hook enters the compiler in there (through an `nsenter`
  wrapper it supplies) and asks about the agent's own paths, rather than translating the path and checking a
  tree with nothing installed in it. A project whose tsconfig chain or type foundations cannot be loaded from
  where the checker runs is answered with an explicit per-file refusal (and `lsp diag` exits 2) instead of
  phantom errors on healthy code: including the native-era case where @types sit in a parent node_modules the
  native compiler does not auto-include; the hook relays that as one "diagnostics unavailable" notice per turn
  rather than injecting errors.
