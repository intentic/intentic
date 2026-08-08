/* WHICH RUNNING THING BACKS WHICH VIEW — the twin of workspace-state.ts, for state that never touches a file.
 *
 * That table answers "the agent wrote a file, so which view is stale". This one answers the same question for
 * the half of the sandbox that has no file to watch: the tmux sessions, the dev-server panels, the listening
 * sockets, the agent's Chromiums, the children its turns spawn. None of them are on disk, so no
 * `workspaceChanged` batch can ever mention them — and for want of a push, every one of those views polled.
 *
 * The polls were the tell. Six always-on timers (a 10s terminals relist behind THREE mounted surfaces, a 15s
 * port scan behind the shell rail, a 4s panel relist for as long as any dev server ran) that each asked a
 * question whose answer is almost always "nothing changed", forever, in every open tab. The daemon knew the real
 * answer the whole time: it is the process that starts the panel, mints the browser, and opens the session.
 *
 * So the daemon says so, on the stream that already carries every other change, and the browser asks only when
 * told to. The declaration lives HERE for the reason its twin does: the daemon publishes a DOMAIN and the
 * browser turns it into query keys, and those two facts drift the moment they are written down in two packages.
 *
 * A key belongs to whoever queries it — the extension views that render ports and panels ask under the SAME key
 * as core (api.sandbox.key("ports") is sandboxKey("ports")), so one entry here refreshes both surfaces and an
 * extension needs no declaration of its own. */

export interface RuntimeDomainBinding {
    // What moved, in the daemon's words. Wire data: it rides the runtimeChanged frame.
    readonly domain: string;
    /* The browser query keys this domain's state feeds. Invalidation reaches only queries something is
     * OBSERVING, so a domain nobody has on screen costs a frame and no request — which is what lets a domain be
     * pushed eagerly without billing every tab for a view it isn't showing. */
    readonly invalidates: readonly string[];
}

/* Declared `as const` so the domain names survive as literal types (see RuntimeDomain below), then published
 * under the interface — the same two-binding shape, for the same reason, as WORKSPACE_STATE_FILES. */
const RUNTIME_DOMAINS = [
    /* Every attachable tmux session: the terminal panel's tab strip, the rail's activity badge, and the work
     * popover's background-process rows all read this one list. Sampled rather than announced — a pane dies
     * when its command exits and tmux tells nobody — but sampled ONCE in the daemon, on a connection the
     * browsers already hold, instead of once per browser per 10s over the tunnel. */
    { domain: "terminals", invalidates: ["terminals"] },

    /* A repo's dev server: running, healthy, and the preview URL it answers on. Two independent things move it,
     * and it needs both — the process manager starting or reaping a session (announced), and the server
     * actually binding its port some seconds later, which is what flips "starting" to "healthy" (seen by the
     * port sampler, since panel health is read off the listening sockets — see panels.ts listenersByRepo).
     *
     * `apps` rides it because a monorepo's per-app previews ARE managed processes under the same manager
     * (workspace.routes appsList reads processes.portOf), just listed per repo instead of per repo-root. One
     * domain, because there is one fact: a dev server the daemon runs started, settled, or died. */
    { domain: "panels", invalidates: ["panels", "apps"] },

    /* Every listening TCP socket in the sandbox, and which of them are forwarded to a public preview hostname.
     * The daemon runs no port poller for the ANSWER — attributing a socket to its process walks every /proc fd
     * table, far too much to do on a timer — so what is sampled is only the LISTEN set out of /proc/net/tcp:
     * two file reads, enough to know that the answer changed and worth nobody's while to compute until a view
     * asks. Change detection and payload are deliberately different sizes here. */
    { domain: "ports", invalidates: ["ports"] },

    // The agent's Chromiums and the pages each holds open — daemon-held records, minted from the hooks that see
    // the agent's own browser tool calls, so every change to this roster passes through this process.
    { domain: "browsers", invalidates: ["browsers"] },

    // The agents this sandbox's agents started. Daemon-held like the browsers, and the one roster here that
    // changes while nothing starts or stops: a working child reports tool uses and tokens continuously, which
    // is why the daemon rate-limits this domain rather than pushing every mutation (see runtime-watch.ts).
    { domain: "subagents", invalidates: ["subagents"] },
] as const satisfies readonly RuntimeDomainBinding[];

export const RUNTIME_DOMAIN_BINDINGS: readonly RuntimeDomainBinding[] = RUNTIME_DOMAINS;

/* Every domain this table declares, as a type — so a publish site names one of THESE and nothing else, and a
 * renamed domain is a compile error in the daemon rather than a frame the browser silently routes nowhere. */
export type RuntimeDomain = (typeof RUNTIME_DOMAINS)[number]["domain"];

/* The query keys a pushed set of domains makes stale, deduped and stable — the browser's `/events` handler
 * calls this, exactly as it calls staleQueryKeys for a path batch. Kept here rather than in the web so the rule
 * is unit-testable without a query client, and so the daemon can assert against the same table.
 *
 * An unknown domain contributes nothing rather than throwing: a daemon newer than the browser may name a domain
 * this build has never heard of, and the honest response to that is to refresh what we do understand. */
export const staleRuntimeQueryKeys = (domains: readonly string[]): readonly string[] => [
    ...new Set(RUNTIME_DOMAIN_BINDINGS.filter((binding) => domains.includes(binding.domain)).flatMap((binding) => binding.invalidates)),
];

/* Every query key any runtime domain feeds — what a NEW /events connection re-asks wholesale, for precisely the
 * reason fileBoundQueryKeys exists: this push is these views' ONLY live feed, and a frame produced while the
 * stream was down is a frame nobody will resend. A panel that finished starting, a session that exited, a port
 * that closed while the browser was away would otherwise sit wrong until the next unrelated change. Re-asking
 * on connect bounds that at one cheap read per key, which is what lets these views go entirely unpolled. */
export const runtimeBoundQueryKeys = (): readonly string[] => [...new Set(RUNTIME_DOMAIN_BINDINGS.flatMap((binding) => binding.invalidates))];
