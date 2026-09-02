/* WHICH RUNNING THING BACKS WHICH VIEW, the twin of workspace-state.ts, for state that never touches a file.
 *
 * That table answers "the agent wrote a file, so which view is stale". This one answers the same question for
 * the half of the sandbox that has no file to watch: the tmux sessions, the dev-server panels, the listening
 * sockets, the agent's Chromiums, the children its turns spawn. None of them are on disk, so no
 * `workspaceChanged` batch can ever mention them, and for want of a push, every one of those views polled.
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
 * A key belongs to whoever queries it, the extension views that render ports and panels ask under the SAME key
 * as core (api.sandbox.key("ports") is sandboxKey("ports")), so one entry here refreshes both surfaces and an
 * extension needs no declaration of its own. */

/* One query key as the browser files it, a segment per level, so a binding can name a NESTED key and not only
 * a top-level one. Most domains here are a single segment and read as they always did; the review is not. Its
 * key is `["git", "changes"]` (the browser appends the sandbox id, and every open file diff hangs beneath it),
 * and a domain that could only say `"git"` would drop the commit log along with it, a second read of the graph
 * to deliver a sentence that has nothing to do with it. */
export type QueryKeyPath = readonly string[];

export interface RuntimeDomainBinding {
    // What moved, in the daemon's words. Wire data: it rides the runtimeChanged frame.
    readonly domain: string;
    /* The browser query keys this domain's state feeds. Invalidation reaches only queries something is
     * OBSERVING, so a domain nobody has on screen costs a frame and no request, which is what lets a domain be
     * pushed eagerly without billing every tab for a view it isn't showing. */
    readonly invalidates: readonly QueryKeyPath[];
}

/* Declared `as const` so the domain names survive as literal types (see RuntimeDomain below), then published
 * under the interface, the same two-binding shape, for the same reason, as WORKSPACE_STATE_FILES. */
const RUNTIME_DOMAINS = [
    /* Every attachable tmux session: the terminal panel's tab strip, the rail's activity badge, and the work
     * popover's background-process rows all read this one list. Sampled rather than announced, a pane dies
     * when its command exits and tmux tells nobody, but sampled ONCE in the daemon, on a connection the
     * browsers already hold, instead of once per browser per 10s over the tunnel. */
    { domain: "terminals", invalidates: [["terminals"]] },

    /* A repo's dev server: running, healthy, and the preview URL it answers on. Two independent things move it,
     * and it needs both, the process manager starting or reaping a session (announced), and the server
     * actually binding its port some seconds later, which is what flips "starting" to "healthy" (seen by the
     * port sampler, since panel health is read off the listening sockets, see panels.ts listenersByRepo).
     *
     * `apps` rides it because a monorepo's per-app previews ARE managed processes under the same manager
     * (workspace.routes appsList reads processes.portOf), just listed per repo instead of per repo-root. One
     * domain, because there is one fact: a dev server the daemon runs started, settled, or died. */
    { domain: "panels", invalidates: [["panels"], ["apps"]] },

    /* Every listening TCP socket in the sandbox, and which of them are forwarded to a public preview hostname.
     * The daemon runs no port poller for the ANSWER, attributing a socket to its process walks every /proc fd
     * table, far too much to do on a timer, so what is sampled is only the LISTEN set out of /proc/net/tcp:
     * two file reads, enough to know that the answer changed and worth nobody's while to compute until a view
     * asks. Change detection and payload are deliberately different sizes here. */
    { domain: "ports", invalidates: [["ports"]] },

    // The agent's Chromiums and the pages each holds open, daemon-held records, minted from the hooks that see
    // the agent's own browser tool calls, so every change to this roster passes through this process.
    { domain: "browsers", invalidates: [["browsers"]] },

    // The agents this sandbox's agents started. Daemon-held like the browsers, and the one roster here that
    // changes while nothing starts or stops: a working child reports tool uses and tokens continuously, which
    // is why the daemon rate-limits this domain rather than pushing every mutation (see runtime-watch.ts).
    { domain: "subagents", invalidates: [["subagents"]] },

    /* THE MACHINES ON THE OTHER END OF A SOCKET, three domains that are one story: the user's computers, the
     * browsers holding the extension, and this sandbox's runners.
     *
     * Announced, and about as announced as a fact can be. "Online" here is not sampled, inferred or timed out
     * of, it IS a socket in this process: the hub accepts one, replaces one, drops one on a failed heartbeat, or
     * cuts one on a revoke, and those four moments are the entire set of ways the answer changes. Nothing on
     * disk moves, no pane appears, and no other feed could carry it.
     *
     * They land on `capabilities` because a host or webext card's state is LITERALLY the hub's answer
     * (handlers/host.ts: `hub.online(id) ? active : pending`), which is what a person watches while they paste a
     * pairing command into a laptop. That wait is the whole reason these are here: it was three seconds of
     * polling per card, running only because nobody had told the browser that the daemon already knew. */
    { domain: "hosts", invalidates: [["capabilities"], ["computers"]] },
    { domain: "webext", invalidates: [["capabilities"]] },
    { domain: "runners", invalidates: [["runners"]] },

    /* The approvals queue, when the DAEMON moves it rather than the owner. Approving is the owner's own mutation
     * and refetches itself, but everything after that happens while nobody is touching the page: a held item
     * coming due, a Discord send landing, an executing turn writing back what happened. Those are the moments
     * the row on screen stops being true, and this queue is watched precisely because its rows act in public,
     * so it is the last place to leave someone reading a stale one. */
    { domain: "approvals", invalidates: [["approvals"]] },

    /* WHAT A LANDED AGENT'S WORK IS CALLED, the commit message drafted from the diff the moment that work
     * reaches the main tree (agents/landed-subject.ts), which the review's "From" chip files into the commit box.
     *
     * It needs a push of its own because it arrives LATE, and alone. The review refreshes when a turn ends; the
     * sentence is a model call that STARTS there and answers seconds later, so the refresh the landing itself
     * causes is always too early to carry it. Nothing followed. The message then sat in the daemon, correct and
     * unread, until some unrelated write happened to refresh the panel again, and a chip clicked in that window
     * filed nothing at all, which is indistinguishable from the feature having been removed.
     *
     * Neither a file nor a ref, so this is the only feed that could carry it: the entry holding it lives on
     * /history, outside the watched tree, and no ref moves when a sentence is written.
     *
     * Being in this table also puts the review on the reconnect re-ask (runtimeBoundQueryKeys), and that is the
     * half of the fix nothing else covers: a publish with no browser connected is dropped, so a landing drafted
     * while the app was closed or the tunnel was down would otherwise stay invisible for as long as the panel's
     * snapshot survived, which, at staleTime Infinity, is until something unrelated moved. It costs one review
     * read per (re)connect, against a chip that files nothing for the rest of the session. */
    { domain: "landings", invalidates: [["git", "changes"]] },
] as const satisfies readonly RuntimeDomainBinding[];

export const RUNTIME_DOMAIN_BINDINGS: readonly RuntimeDomainBinding[] = RUNTIME_DOMAINS;

/* Every domain this table declares, as a type, so a publish site names one of THESE and nothing else, and a
 * renamed domain is a compile error in the daemon rather than a frame the browser silently routes nowhere. */
export type RuntimeDomain = (typeof RUNTIME_DOMAINS)[number]["domain"];

/* Distinct key paths, in table order, two domains in one frame routinely feed the same view, and a Set cannot
 * see that because each path is its own array. Compared by their segments joined, which is exact: a segment is
 * one identifier from this file, never a caller's string, so there is no separator to collide on. */
const dedupe = (keys: readonly QueryKeyPath[]): readonly QueryKeyPath[] => [...new Map(keys.map((key) => [key.join(`/`), key])).values()];

/* The query keys a pushed set of domains makes stale, deduped and stable, the browser's `/events` handler
 * calls this, exactly as it calls staleQueryKeys for a path batch. Kept here rather than in the web so the rule
 * is unit-testable without a query client, and so the daemon can assert against the same table.
 *
 * An unknown domain contributes nothing rather than throwing: a daemon newer than the browser may name a domain
 * this build has never heard of, and the honest response to that is to refresh what we do understand. */
export const staleRuntimeQueryKeys = (domains: readonly string[]): readonly QueryKeyPath[] =>
    dedupe(RUNTIME_DOMAIN_BINDINGS.filter((binding) => domains.includes(binding.domain)).flatMap((binding) => binding.invalidates));

/* Every query key any runtime domain feeds, what a NEW /events connection re-asks wholesale, for precisely the
 * reason fileBoundQueryKeys exists: this push is these views' ONLY live feed, and a frame produced while the
 * stream was down is a frame nobody will resend. A panel that finished starting, a session that exited, a port
 * that closed while the browser was away would otherwise sit wrong until the next unrelated change. Re-asking
 * on connect bounds that at one cheap read per key, which is what lets these views go entirely unpolled. */
export const runtimeBoundQueryKeys = (): readonly QueryKeyPath[] => dedupe(RUNTIME_DOMAIN_BINDINGS.flatMap((binding) => binding.invalidates));
