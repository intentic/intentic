// Twin of workspace-state.ts for state with no file to watch: tmux sessions, dev-server panels, sockets, browsers,
// spawned children. The daemon pushes a domain on the existing stream instead of the browser polling; keeping the
// mapping here only prevents drift. A key belongs to whoever queries it, so one entry can refresh several surfaces.

// A segment per level, so a binding can name a nested key, not only a top-level one: the review's key is
// ["git","changes"], distinct from the commit log's ["git","log"].
export type QueryKeyPath = readonly string[];

export interface RuntimeDomainBinding {
    // What moved, in the daemon's words; wire data riding the runtimeChanged frame.
    readonly domain: string;
    // Reaches only queries something is observing, so pushing a domain eagerly costs unwatched tabs nothing.
    readonly invalidates: readonly QueryKeyPath[];
}

// Declared `as const` so domain names survive as literal types (RuntimeDomain below).
const RUNTIME_DOMAINS = [
    // Every attachable tmux session: the tab strip, activity badge and process rows; sampled once, daemon-side.
    { domain: "terminals", invalidates: [["terminals"]] },

    // A dev server's state (running, healthy, preview URL); apps shares it, same underlying managed-process fact.
    { domain: "panels", invalidates: [["panels"], ["apps"]] },

    // Every listening socket and which are forwarded publicly; only the LISTEN set is sampled cheaply.
    { domain: "ports", invalidates: [["ports"]] },

    // The agent's Chromiums and open pages, daemon-held, minted from its own browser tool-call hooks.
    { domain: "browsers", invalidates: [["browsers"]] },

    // Daemon-held; changes continuously (tokens, tool uses), so it's rate-limited rather than pushed per mutation.
    { domain: "subagents", invalidates: [["subagents"]] },

    // Machines on the other end of a socket (devices, browsers, runners); "online" is the socket itself, never sampled.
    // hosts/webext land on capabilities since a pairing card's state is literally the hub's online answer.
    { domain: "hosts", invalidates: [["capabilities"], ["devices"]] },
    { domain: "webext", invalidates: [["capabilities"]] },
    { domain: "runners", invalidates: [["runners"]] },

    // Watched because rows act on their own while nobody's watching (coming due, a turn writing back).
    { domain: "approvals", invalidates: [["approvals"]] },

    // Commit subject drafted after landing; arrives too late for the turn-end refresh, needs its own push.
    { domain: "landings", invalidates: [["git", "changes"]] },
] as const satisfies readonly RuntimeDomainBinding[];

export const RUNTIME_DOMAIN_BINDINGS: readonly RuntimeDomainBinding[] = RUNTIME_DOMAINS;

// Every declared domain as a type, so a rename is a compile error rather than a silently dropped frame.
export type RuntimeDomain = (typeof RUNTIME_DOMAINS)[number]["domain"];

// Dedupes by joined segments: two domains can feed the same key, but each path is its own array so a Set won't catch
// it. Exact, since a segment is always this file's own identifier, never a caller's string.
const dedupe = (keys: readonly QueryKeyPath[]): readonly QueryKeyPath[] => [...new Map(keys.map((key) => [key.join(`/`), key])).values()];

// The query keys a pushed domain set makes stale, deduped; called by the browser's /events handler so daemon and
// browser share one table. An unknown domain is dropped rather than throwing, for forward compatibility.
export const staleRuntimeQueryKeys = (domains: readonly string[]): readonly QueryKeyPath[] =>
    dedupe(RUNTIME_DOMAIN_BINDINGS.filter((binding) => domains.includes(binding.domain)).flatMap((binding) => binding.invalidates));

// Every key any runtime domain feeds; what a fresh /events connection re-asks wholesale, since a missed push here is
// gone for good. Bounds the cost to one read per key, letting these views stay unpolled.
export const runtimeBoundQueryKeys = (): readonly QueryKeyPath[] => dedupe(RUNTIME_DOMAIN_BINDINGS.flatMap((binding) => binding.invalidates));
