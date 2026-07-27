import { type AgentEvent, type AgentSummary, type AgentTurn, deriveTitle, planParts } from "@intentic/sandbox-contract";
import type { AgentsStore, AgentTitleSource, PersistedAgent } from "./agents-store.js";

// The runtime half of the fleet registry: holds the authoritative in-memory entry list (loaded once from the
// store, write-through on persisted mutations) plus per-conversation turn state rebuilt from AgentEvent frames
// — status (running/awaiting), attention flags, the card's activity snippet, context fill, and the per-
// conversation turn mutex. Every card-visible change broadcasts the FULL roster (snapshots, not diffs — the
// same last-frame-wins contract as presence), which system.routes relays onto /events.

const MAX_TITLE_LENGTH = 80;
// The source ranking as a number, so promoteTitle's comparison is one `<=`. An entry written before it had a
// source reads as `derived`, i.e. as replaceable by anything better.
const TITLE_RANK: Record<AgentTitleSource, number> = { derived: 0, plan: 1, user: 2 };
const sanitizeTitle = (prompt: string): string | undefined => {
    const clean = prompt
        .replaceAll(/[\p{Cc}\p{Cf}]+/gu, " ")
        .replaceAll(/\s+/gu, " ")
        .trim()
        .slice(0, MAX_TITLE_LENGTH);
    return clean === "" ? undefined : clean;
};

interface RuntimeState {
    running: boolean;
    // The cards the turn is parked on RIGHT NOW, by the requestId each was raised with — the fleet's attention
    // flags are read straight off it. Keyed rather than counted because a turn can be parked on more than one
    // card at a time (a question raised beside a parallel tool call's permission prompt), and each is released
    // by its own `resolved` frame. Emphatically NOT inferred from the frames that follow a park: frames keep
    // arriving while a turn waits — the pausing tool's own `tool_call` regularly trails its card — and reading
    // one of those as "the user answered" is what kept an agent asking a question out of the Attention lane.
    pauses: Map<string, "plan" | "question" | "permission">;
    errored: boolean;
    activity: { tool?: string; target?: string; todo?: string } | undefined;
    contextTokens: number | undefined;
    contextWindow: number | undefined;
    startedAt: number | undefined;
    lastAt: number | undefined;
    // Frame-carried fields flushed into the persisted entry at finish (one write per turn, not per frame).
    pendingSessionId: string | undefined;
    pendingCostUsd: number;
    pendingInputTokens: number;
    pendingOutputTokens: number;
    pendingToolUses: number;
}

const freshRuntime = (): RuntimeState => ({
    running: false,
    pauses: new Map(),
    errored: false,
    activity: undefined,
    contextTokens: undefined,
    contextWindow: undefined,
    startedAt: undefined,
    lastAt: undefined,
    pendingSessionId: undefined,
    pendingCostUsd: 0,
    pendingInputTokens: 0,
    pendingOutputTokens: 0,
    pendingToolUses: 0,
});

// The registry input of an isolated turn — the fields begin() records onto the entry.
export type AgentTurnIdentity = Pick<AgentTurn, "prompt" | "title" | "model" | "account" | "origin"> & {
    readonly conversationId: string;
    readonly provider: NonNullable<AgentTurn["agent"]>;
    readonly harness: NonNullable<AgentTurn["harness"]>;
};

export interface AgentsRegistry {
    readonly init: () => Promise<void>;
    readonly ids: () => string[];
    // The BOARD's roster — live agents only. Archived ones are excluded here (and from every broadcast) so a
    // sandbox with a thousand retired agents still streams a roster the size of the work in flight.
    readonly list: () => AgentSummary[];
    // The cold half, newest-archived first. Read on demand by the board's archive view; never broadcast.
    readonly listArchived: () => AgentSummary[];
    readonly get: (id: string) => AgentSummary | undefined;
    // The persisted entry — the worktree composition (per-repo bases) diff/land need.
    readonly entry: (id: string) => PersistedAgent | undefined;
    readonly running: (id: string) => boolean;
    // The SDK session ids of the turns in flight RIGHT NOW. The terminals list maps them to the `agent-*` tmux
    // sessions those turns run their Bash in (agent/agent-terminals.ts), so a working agent's terminal doesn't
    // read as finished while it thinks — between two commands its only window is the last one's dead pane, and
    // pane liveness alone would call that done. Known from the turn's first SDK frame (`session`), well before
    // its first command; an id the entry has not been flushed with yet falls back to the last turn's.
    readonly liveSessionIds: () => string[];
    // Acquire the conversation's turn mutex and mark it running, creating/updating the entry. False ⇒ a turn
    // is already running for that conversation (the caller surfaces the coded busy error).
    readonly begin: (turn: AgentTurnIdentity, now: number) => Promise<boolean>;
    // Record the worktree composition on first creation (per-repo full base shas).
    readonly recordWorktree: (id: string, repos: readonly PersistedAgent["repos"][number][]) => Promise<void>;
    // Set the display title, subject to the source ranking (see AgentTitleSourceSchema): a rename always
    // lands, an automatic source only ever moves the title up. Deliberately does NOT bump updatedAt (a rename
    // must not fake-unread other browsers or reorder lanes) and takes no running guard — begin()/finish()
    // re-read the entry, so a mid-turn rename survives. Undefined ⇒ unknown id or a title that sanitizes to
    // nothing; a rejected promotion returns the entry's CURRENT summary rather than undefined.
    readonly setTitle: (id: string, title: string, source: AgentTitleSource) => Promise<AgentSummary | undefined>;
    // Stamp the read marker the cards' unread badge is measured against. Like setTitle it leaves updatedAt
    // alone (reading is not activity) and needs no running guard. Undefined ⇒ unknown id.
    readonly markSeen: (id: string, now: number) => Promise<AgentSummary | undefined>;
    // "Mark all read" — one stamp across the whole fleet, so a board full of badges has a single escape hatch.
    readonly markAllSeen: (now: number) => Promise<void>;
    // Persist a land's advanced per-repo landedTips (partial lands included — conflicted repos keep theirs)
    // and the refreshed cumulative diffstat.
    readonly recordLanded: (
        id: string,
        repos: readonly PersistedAgent["repos"][number][],
        diff?: { files: number; insertions: number; deletions: number },
    ) => Promise<void>;
    // Fold one turn frame into runtime state; broadcasts only on card-visible changes.
    readonly observe: (id: string, event: AgentEvent) => void;
    // End of turn (aborted included): flush pending usage/session into the entry, release the mutex.
    // `outcome` carries the auto-land verdict of a clean turn — it wins over the default idle status
    // (an observed error frame still wins over everything).
    readonly finish: (id: string, now: number, outcome?: "landed" | "conflict") => Promise<void>;
    // Stamp/clear the archive marker. Both take the ids that ALREADY had their checkout retired (or restored)
    // — the registry owns the marker, agents/archive.ts owns the git side and the order between them.
    readonly setArchived: (ids: readonly string[], now: number) => Promise<void>;
    readonly clearArchived: (ids: readonly string[]) => Promise<void>;
    readonly remove: (id: string) => Promise<void>;
    // Immediate snapshot on subscribe, so a fresh /events connection paints the fleet without waiting. The
    // listener also receives the revision the snapshot was taken at (see `revision`).
    readonly subscribe: (listener: (agents: AgentSummary[], rev: number) => void) => () => void;
    // A counter bumped on every broadcast, i.e. on every registry change. The roster is published as full
    // snapshots, and the browser reconciles three sources of it — this stream, its own GET /agents, and its
    // optimistic writes — so each snapshot has to say WHEN it was true. Monotonic within a daemon process;
    // it restarts at 0 on reboot, which is safe because the stream reconnects and the browser adopts the first
    // roster it sees on a fresh connection.
    readonly revision: () => number;
}

export const createAgentsRegistry = (store: AgentsStore): AgentsRegistry => {
    let entries: PersistedAgent[] = [];
    const runtime = new Map<string, RuntimeState>();
    const listeners = new Set<(agents: AgentSummary[], rev: number) => void>();
    // Bumped by broadcast(), so it advances exactly once per published change — see `revision` on the interface.
    let revision = 0;

    const runtimeOf = (id: string): RuntimeState => {
        const existing = runtime.get(id);
        if (existing !== undefined) {
            return existing;
        }
        const fresh = freshRuntime();
        runtime.set(id, fresh);
        return fresh;
    };

    const summaryOf = (entry: PersistedAgent): AgentSummary => {
        const state = runtime.get(entry.id);
        // A turn holding an unanswered card is AWAITING, however much else it has in flight beside it.
        const parked = state === undefined ? [] : [...state.pauses.values()];
        const status = state?.running === true ? (parked.length > 0 ? "awaiting" : "running") : entry.status;
        const base = (entry.repos.find((repo) => repo.repo === "root") ?? entry.repos[0])?.base.slice(0, 7);
        // Live totals: persisted totals plus the running turn's not-yet-flushed usage.
        const costUsd = entry.costUsd + (state?.pendingCostUsd ?? 0);
        const inputTokens = entry.inputTokens + (state?.pendingInputTokens ?? 0);
        const outputTokens = entry.outputTokens + (state?.pendingOutputTokens ?? 0);
        return {
            id: entry.id,
            status,
            provider: entry.provider,
            harness: entry.harness,
            branch: entry.branch,
            updatedAt: Math.max(entry.updatedAt, state?.lastAt ?? 0),
            attention: {
                plan: parked.includes("plan"),
                question: parked.includes("question"),
                permission: parked.includes("permission"),
                conflict: entry.status === "conflict",
            },
            ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
            ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
            ...(entry.title !== undefined ? { title: entry.title } : {}),
            ...(entry.model !== undefined ? { model: entry.model } : {}),
            ...(entry.account !== undefined ? { account: entry.account } : {}),
            ...(base !== undefined ? { base } : {}),
            ...(costUsd > 0 ? { costUsd } : {}),
            ...(inputTokens > 0 ? { inputTokens } : {}),
            ...(outputTokens > 0 ? { outputTokens } : {}),
            ...(state?.contextTokens !== undefined ? { contextTokens: state.contextTokens } : {}),
            ...(state?.contextWindow !== undefined ? { contextWindow: state.contextWindow } : {}),
            ...(state?.activity !== undefined ? { activity: state.activity } : {}),
            ...(state?.running === true && state.startedAt !== undefined ? { startedAt: state.startedAt } : {}),
            ...(entry.seenAt !== undefined ? { seenAt: entry.seenAt } : {}),
            ...(entry.archivedAt !== undefined ? { archivedAt: entry.archivedAt } : {}),
            ...(entry.turns !== undefined ? { turns: entry.turns } : {}),
            // Live count: the running turn's tool calls show on the card as they happen.
            ...((entry.toolUses ?? 0) + (state?.pendingToolUses ?? 0) > 0 ? { toolUses: (entry.toolUses ?? 0) + (state?.pendingToolUses ?? 0) } : {}),
            ...(entry.diffFiles !== undefined
                ? { diff: { files: entry.diffFiles, insertions: entry.diffInsertions ?? 0, deletions: entry.diffDeletions ?? 0 } }
                : {}),
        };
    };

    const list = (): AgentSummary[] => entries.filter((entry) => entry.archivedAt === undefined).map(summaryOf);

    // One bump per published change, BEFORE the fan-out, so every listener on this broadcast sees the same
    // revision and a mutation route reading revision() afterwards reports the one its own change produced.
    const broadcast = (): void => {
        const agents = list();
        revision += 1;
        for (const listener of listeners) {
            listener(agents, revision);
        }
    };

    // Chained, not fire-and-forget: `entries` is REPLACED (not mutated) by every write path, so two overlapping
    // persists would each serialize the array they captured — and the one that finishes last would write back a
    // snapshot missing the other's change. Archiving several agents at once is exactly that shape. Chaining also
    // means the closure reads `entries` at EXECUTION time, so a queued write always persists the latest state.
    // (`.then(save, save)` so one rejected write doesn't poison the queue — the push-store idiom.)
    let writes: Promise<unknown> = Promise.resolve();
    /* Move a title UP the source ranking, or leave it exactly as it is. The single place the ranking is
     * applied, so the rename route and the frame path cannot disagree about who may rename what.
     *
     * A rename always lands — including the second one, which an ordinary rank comparison would reject as a
     * sideways move. Everything else has to strictly outrank what is already there: a plan heading may replace
     * the prompt the title was derived from, nothing may replace a rename, and a REPLAN may not rename the job
     * the first plan already named. Returns whether the entry changed, so callers persist and broadcast only
     * when something actually did. */
    const promoteTitle = (id: string, title: string | undefined, source: AgentTitleSource): boolean => {
        const entry = entryOf(id);
        const clean = title === undefined ? undefined : sanitizeTitle(title);
        if (entry === undefined || clean === undefined) {
            return false;
        }
        if (source !== "user" && TITLE_RANK[source] <= TITLE_RANK[entry.titleSource ?? "derived"]) {
            return false;
        }
        if (entry.title === clean && entry.titleSource === source) {
            return false;
        }
        replace({ ...entry, title: clean, titleSource: source });
        return true;
    };

    const persist = (): Promise<void> => {
        const next = writes.then(
            () => store.save(entries),
            () => store.save(entries),
        );
        writes = next.catch(() => undefined);
        return next;
    };

    const entryOf = (id: string): PersistedAgent | undefined => entries.find((entry) => entry.id === id);

    const replace = (next: PersistedAgent): void => {
        entries = [...entries.filter((entry) => entry.id !== next.id), next];
    };

    return {
        init: async () => {
            entries = await store.load();
        },
        ids: () => entries.map((entry) => entry.id),
        list,
        listArchived: () =>
            entries
                .filter((entry) => entry.archivedAt !== undefined)
                .toSorted((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
                .map(summaryOf),
        get: (id) => {
            const entry = entryOf(id);
            return entry === undefined ? undefined : summaryOf(entry);
        },
        entry: entryOf,
        running: (id) => runtime.get(id)?.running === true,
        liveSessionIds: () =>
            [...runtime]
                .filter(([, state]) => state.running)
                .flatMap(([id, state]) => {
                    const sessionId = state.pendingSessionId ?? entryOf(id)?.sessionId;
                    return sessionId === undefined ? [] : [sessionId];
                }),
        begin: async (turn, now) => {
            if (runtime.get(turn.conversationId)?.running === true) {
                return false;
            }
            const existing = entryOf(turn.conversationId);
            // An authored title — the browser's own derivation, or a rename that landed mid-turn — is taken as
            // written. A turn that arrived WITHOUT one (an automation, a Discord mention, a webchat visitor)
            // is named by the same rule the browser runs, so one prompt opens under one name wherever it
            // entered; sanitizeTitle then does what it does for any title, including turning empty into none.
            const title =
                existing?.title ?? (turn.title !== undefined ? sanitizeTitle(turn.title) : undefined) ?? sanitizeTitle(deriveTitle(turn.prompt));
            const model = turn.model ?? existing?.model;
            const account = turn.account ?? existing?.account;
            // Provenance belongs to the turn that CREATED the conversation and is never re-derived: the user's
            // own follow-up turns in a surfaced agent's tab carry no origin, and must not strip the Discord
            // mention that opened it off the card.
            const origin = existing?.origin ?? turn.origin;
            replace({
                id: turn.conversationId,
                branch: `agent/${turn.conversationId}`,
                provider: turn.provider,
                harness: turn.harness,
                repos: existing?.repos ?? [],
                status: "idle",
                costUsd: existing?.costUsd ?? 0,
                inputTokens: existing?.inputTokens ?? 0,
                outputTokens: existing?.outputTokens ?? 0,
                createdAt: existing?.createdAt ?? now,
                updatedAt: now,
                // The source rides with the title: an entry rebuilt for a follow-up turn keeps whatever
                // promoted it (a rename stays a rename), and a fresh one starts at the bottom of the ranking
                // so the turn's first plan can name it properly.
                ...(title !== undefined ? { title, titleSource: existing?.titleSource ?? "derived" } : {}),
                ...(model !== undefined ? { model } : {}),
                ...(account !== undefined ? { account } : {}),
                ...(origin !== undefined ? { origin } : {}),
                ...(existing?.sessionId !== undefined ? { sessionId: existing.sessionId } : {}),
                // The read marker survives the rebuild too — a new turn makes the agent unread again (updatedAt
                // now outruns it), but WHEN it was last opened is what tells "New" from "Updated".
                ...(existing?.seenAt !== undefined ? { seenAt: existing.seenAt } : {}),
                // `archivedAt` is deliberately NOT carried across: sending an archived agent a message is how
                // you un-archive it, so the entry rebuilt here is a live one again. The checkout follows
                // immediately — the ensure() right after this re-attaches it from the surviving branch.
                // Lifetime counters + diffstat survive the per-turn entry rebuild.
                ...(existing?.turns !== undefined ? { turns: existing.turns } : {}),
                ...(existing?.toolUses !== undefined ? { toolUses: existing.toolUses } : {}),
                ...(existing?.diffFiles !== undefined ? { diffFiles: existing.diffFiles } : {}),
                ...(existing?.diffInsertions !== undefined ? { diffInsertions: existing.diffInsertions } : {}),
                ...(existing?.diffDeletions !== undefined ? { diffDeletions: existing.diffDeletions } : {}),
            });
            const state = freshRuntime();
            state.running = true;
            state.startedAt = now;
            state.lastAt = now;
            runtime.set(turn.conversationId, state);
            await persist();
            broadcast();
            return true;
        },
        recordWorktree: async (id, repos) => {
            const entry = entryOf(id);
            if (entry === undefined) {
                return;
            }
            replace({ ...entry, repos: [...repos] });
            await persist();
        },
        setTitle: async (id, title, source) => {
            if (entryOf(id) === undefined || sanitizeTitle(title) === undefined) {
                return undefined;
            }
            if (promoteTitle(id, title, source)) {
                await persist();
                broadcast();
            }
            const entry = entryOf(id);
            return entry === undefined ? undefined : summaryOf(entry);
        },
        markSeen: async (id, now) => {
            const entry = entryOf(id);
            if (entry === undefined) {
                return undefined;
            }
            const next = { ...entry, seenAt: now };
            replace(next);
            await persist();
            // Broadcast so the badge clears on EVERY connected surface at once — the phone that opened it and
            // the desktop rail counting it are looking at the same fleet.
            broadcast();
            return summaryOf(next);
        },
        markAllSeen: async (now) => {
            entries = entries.map((entry) => ({ ...entry, seenAt: now }));
            await persist();
            broadcast();
        },
        observe: (id, event) => {
            const state = runtimeOf(id);
            state.lastAt = Date.now();
            // A plan's heading is the agent's own name for the whole job, which the opening prompt rarely was.
            // Promoted out here rather than under `case "plan"` so that case keeps falling through to the
            // shared pause registration, and applied to the entry immediately so the card and every open tab
            // pick the name up on the broadcast this frame was already going to make — a plan parks the turn
            // on the user, and it may sit there a while. The write out is fire-and-forget: it is ordered
            // behind whatever else is in the store's write chain, and a daemon that dies before it lands loses
            // a title the next plan frame re-derives anyway.
            if (event.kind === "plan" && promoteTitle(id, planParts(event.text).title, "plan")) {
                void persist();
            }
            switch (event.kind) {
                case "session":
                    state.pendingSessionId = event.sessionId;
                    return;
                case "usage":
                    state.pendingCostUsd += event.costUsd ?? 0;
                    state.pendingInputTokens += event.inputTokens ?? 0;
                    state.pendingOutputTokens += event.outputTokens ?? 0;
                    break;
                case "context_usage":
                    state.contextTokens = event.tokens;
                    state.contextWindow = event.contextWindow;
                    break;
                case "plan":
                case "question":
                case "permission":
                    state.pauses.set(event.requestId, event.kind);
                    break;
                case "resolved":
                    // Nothing to release ⇒ nothing to publish: a daemon that restarted mid-park never saw the
                    // card go up, and re-broadcasting for it would only churn the board.
                    if (!state.pauses.delete(event.requestId)) {
                        return;
                    }
                    break;
                case "tool_call":
                    state.pendingToolUses += 1;
                    state.activity = {
                        tool: event.name,
                        ...(event.target !== undefined ? { target: event.target } : {}),
                        ...(state.activity?.todo !== undefined ? { todo: state.activity.todo } : {}),
                    };
                    break;
                case "todos": {
                    const current = event.items.find((item) => item.status === "in_progress")?.content;
                    state.activity = { ...state.activity, ...(current !== undefined ? { todo: current } : {}) };
                    break;
                }
                case "error":
                    state.errored = true;
                    break;
                default:
                    return; // delta/thinking/etc — not card-visible, skip the broadcast.
            }
            broadcast();
        },
        finish: async (id, now, outcome) => {
            const entry = entryOf(id);
            const state = runtime.get(id);
            // Captured BEFORE the reset: only a finish that ends a LIVE turn counts toward `turns` — the
            // manual land route finishes with an outcome outside any turn and must not inflate the counter.
            const ranTurn = state?.running === true;
            if (state !== undefined) {
                state.running = false;
                // A turn that ended holds nobody up any more, however it ended: an aborted card's waiter is
                // settled by the same abort, and its `resolved` frame may never make it out of the stream.
                state.pauses.clear();
                state.startedAt = undefined;
            }
            // Tolerates a missing runtime state: the manual land route finishes with an outcome outside any
            // turn (possibly right after a daemon restart), and must still write the status through.
            if (entry !== undefined) {
                const sessionId = state?.pendingSessionId ?? entry.sessionId;
                replace({
                    ...entry,
                    // An observed error frame outranks everything; else the land verdict; else idle.
                    status: state?.errored === true ? "error" : (outcome ?? "idle"),
                    costUsd: entry.costUsd + (state?.pendingCostUsd ?? 0),
                    inputTokens: entry.inputTokens + (state?.pendingInputTokens ?? 0),
                    outputTokens: entry.outputTokens + (state?.pendingOutputTokens ?? 0),
                    turns: (entry.turns ?? 0) + (ranTurn ? 1 : 0),
                    toolUses: (entry.toolUses ?? 0) + (state?.pendingToolUses ?? 0),
                    updatedAt: now,
                    ...(sessionId !== undefined ? { sessionId } : {}),
                });
                if (state !== undefined) {
                    state.pendingCostUsd = 0;
                    state.pendingInputTokens = 0;
                    state.pendingOutputTokens = 0;
                    state.pendingToolUses = 0;
                    state.pendingSessionId = undefined;
                    state.errored = false;
                }
                await persist();
            }
            broadcast();
        },
        recordLanded: async (id, repos, diff) => {
            const entry = entryOf(id);
            if (entry === undefined) {
                return;
            }
            replace({
                ...entry,
                repos: [...repos],
                ...(diff !== undefined ? { diffFiles: diff.files, diffInsertions: diff.insertions, diffDeletions: diff.deletions } : {}),
            });
            await persist();
            broadcast();
        },
        setArchived: async (ids, now) => {
            const targets = new Set(ids);
            entries = entries.map((entry) => (targets.has(entry.id) ? { ...entry, archivedAt: now } : entry));
            await persist();
            // The roster this broadcasts no longer contains them — which IS how every connected surface learns
            // the cards left the board.
            broadcast();
        },
        clearArchived: async (ids) => {
            const targets = new Set(ids);
            entries = entries.map((entry) => {
                if (!targets.has(entry.id)) {
                    return entry;
                }
                const { archivedAt: _archived, ...live } = entry;
                return live;
            });
            await persist();
            broadcast();
        },
        remove: async (id) => {
            entries = entries.filter((entry) => entry.id !== id);
            runtime.delete(id);
            await persist();
            broadcast();
        },
        subscribe: (listener) => {
            listeners.add(listener);
            // The immediate paint carries the CURRENT revision without bumping it: subscribing is not a change,
            // and inventing a revision here would make a new connection look newer than the rosters already
            // applied by tabs that have been connected all along.
            listener(list(), revision);
            return () => listeners.delete(listener);
        },
        revision: () => revision,
    };
};
