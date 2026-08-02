import { type AgentEvent, type AgentSummary, type AgentTurn, deriveTitle, planParts } from "@intentic/sandbox-contract";
import { isFailureSentence } from "../agent/failure-sentences.js";
import { subagentCountsOf } from "../agent/subagents.js";
import { forgetLoops, loopProjectionOf, onLoopChange } from "../loops/loop-state.js";
import { recordConversationPrompt, recordPrompt } from "../sessions/prompt-index.js";
import { type AgentsStore, type AgentTitleSource, isIsolated, type PersistedAgent } from "./agents-store.js";
import type { LandOutcome } from "./land.js";
import type { LandStandings } from "./standing.js";

// The runtime half of the fleet registry: holds the authoritative in-memory entry list (loaded once from the
// store, write-through on persisted mutations) plus per-conversation turn state rebuilt from AgentEvent frames
// — status (running/awaiting), attention flags, the card's activity snippet, context fill, and the per-
// conversation turn mutex. Every card-visible change broadcasts the FULL roster (snapshots, not diffs — the
// same last-frame-wins contract as presence), which system.routes relays onto /events.

const MAX_TITLE_LENGTH = 80;
// The source ranking as a number, so promoteTitle's comparison is one `<=`. An entry written before it had a
// source reads as `derived`, i.e. as replaceable by anything better.
const TITLE_RANK: Record<AgentTitleSource, number> = { derived: 0, model: 1, plan: 2, user: 3 };
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
    /* The user pressed Stop and the abort has landed — this turn is on its way out but not out yet.
     *
     * It is runtime state rather than a status write because the turn is still LIVE: aborting the provider only
     * asks it to unwind, and the generator keeps the conversation (its worktree, its mutex) until it has walked
     * its own cleanup — seconds, on a turn with a big tool call in flight. That window used to be published as
     * plain `running`, so a stopped agent kept its spinner turning on every surface until it settled.
     *
     * Read twice: `summaryOf` publishes it as `stopping` the moment it is set, and `finish` reads it to write
     * the terminal `stopped` — the one thing that tells a turn a person ended from one the daemon died under. */
    stopping: boolean;
    activity: { tool?: string; target?: string; todo?: string } | undefined;
    contextTokens: number | undefined;
    contextWindow: number | undefined;
    startedAt: number | undefined;
    lastAt: number | undefined;
    // This turn's prompt, held only until it can be filed under a session id. A FIRST turn has none at begin
    // (the SDK mints it and announces it on the `session` frame), and the fleet filter searches by what the
    // user wrote — so without this the prompt that just started an agent is the one prompt that agent can't
    // be found by, for as long as its turn runs. Cleared the moment it is filed.
    pendingPrompt: string | undefined;
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
    stopping: false,
    activity: undefined,
    contextTokens: undefined,
    contextWindow: undefined,
    startedAt: undefined,
    lastAt: undefined,
    pendingPrompt: undefined,
    pendingSessionId: undefined,
    pendingCostUsd: 0,
    pendingInputTokens: 0,
    pendingOutputTokens: 0,
    pendingToolUses: 0,
});

// The registry input of any conversation turn — the fields begin() records onto the entry. Placement is kept
// here rather than inferred from the provider: isolated conversations own a branch; workspace conversations do
// not, while both share the same identity, status and transcript lifecycle.
export type AgentTurnIdentity = Pick<AgentTurn, "prompt"> &
    Partial<Pick<AgentTurn, "title" | "model" | "effort" | "thinking" | "fast" | "account" | "origin">> & {
        readonly conversationId: string;
        readonly isolated: boolean;
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
    // One conversation's CURRENT session id, including a running first turn's — the entry is only flushed with
    // it at finish, so `entry(id).sessionId` alone is undefined for exactly the turn most likely to be steered.
    readonly sessionIdOf: (id: string) => string | undefined;
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
    // Set/clear the per-agent autoLand override (null ⇒ back to "inherit the sandbox setting"). Like setTitle
    // it leaves updatedAt alone (configuring is not activity) and needs no running guard — the value is read
    // at turn COMPLETION, so flipping it mid-turn is exactly "hold THIS turn's work". Undefined ⇒ unknown id.
    readonly setAutoLand: (id: string, autoLand: boolean | null) => Promise<AgentSummary | undefined>;
    // "Mark all read" — one stamp across the whole fleet, so a board full of badges has a single escape hatch.
    readonly markAllSeen: (now: number) => Promise<void>;
    // Persist a land's outcome: the advanced per-repo landedTips (partial lands included — conflicted repos
    // keep theirs), the refreshed cumulative diffstat, and the conflict report behind the `conflict` status.
    // Takes the whole outcome rather than its pieces so the report cannot drift from the tips it belongs to —
    // an outcome with no conflicts CLEARS the stored one, which is what makes a resolved conflict resolve.
    readonly recordLanded: (id: string, outcome: LandOutcome) => Promise<void>;
    // Fold one turn frame into runtime state; broadcasts only on card-visible changes.
    readonly observe: (id: string, event: AgentEvent) => void;
    /* The user's Stop has aborted this turn — publish it as `stopping` NOW, ahead of the unwind.
     *
     * The whole point is the gap it closes. /agent/stop aborts the provider and then waits for the generator to
     * walk its cleanup, and until finish() runs the roster still reads `running`: the press had no visible
     * result anywhere, so every surface kept a spinner turning on a turn that was already dead. Called by the
     * stop route rather than inferred from a frame, because an abort's defining feature is that no frame
     * follows it. A no-op when nothing is running — a stop that raced the turn's own ending changes nothing.
     */
    readonly stopping: (id: string) => void;
    // End of turn (aborted included): flush pending usage/session into the entry, release the mutex, and write
    // how the turn ENDED — error on an observed error frame, `stopped` when the user cut it short, else idle.
    // Deliberately says nothing about where the work now stands: that is standing.ts's question, re-derived
    // here before the roster goes out.
    readonly finish: (id: string, now: number) => Promise<void>;
    /* Re-derive every live agent's land standing and publish the roster if any of them moved. Called wherever
     * the answer can have changed without this daemon doing it — most of all the roster READ, which is what
     * heals a card after work reached the main tree by a road the daemon never saw (a hand-merge in a
     * terminal). Cheap and idempotent: a pass whose shas are unchanged spends one rev-parse per repo and
     * broadcasts nothing. */
    readonly refreshStandings: () => Promise<void>;
    // Stamp/clear the archive marker. Both take the ids that ALREADY had their checkout retired (or restored)
    // — the registry owns the marker, agents/archive.ts owns the git side and the order between them.
    readonly setArchived: (ids: readonly string[], now: number) => Promise<void>;
    readonly clearArchived: (ids: readonly string[]) => Promise<void>;
    // Forget agents outright — `discard`, the archive's purge, and the boot sweep's vanished worktrees. Takes a
    // SET because every caller but discard has one, and a per-id call would spend a persist and a roster
    // broadcast on each agent of a batch.
    readonly remove: (ids: readonly string[]) => Promise<void>;
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

export const createAgentsRegistry = (store: AgentsStore, standings: LandStandings): AgentsRegistry => {
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
        /* THE STATUS PROJECTION, in precedence order: the live turn, then how the last one ENDED, then where
         * the work stands. The middle rung is why `idle` is the only persisted value that yields — it is the
         * one that means "the turn ended cleanly", i.e. that the entry has nothing more to say and the
         * question passes to git. `error` and `interrupted` outrank precisely because nothing else remembers
         * them: a turn that died is not made fine by a branch that happens to be empty.
         *
         * Within the live rung, a stop outranks a park: a turn aborted while holding a question is on its way
         * out, and publishing it as `awaiting` would keep asking the user to answer a card the abort has
         * already settled. */
        const landing = entry.branch === undefined ? "idle" : standings.of(entry.id);
        const status =
            state?.running === true
                ? state.stopping
                    ? "stopping"
                    : parked.length > 0
                      ? "awaiting"
                      : "running"
                : entry.status === "idle"
                  ? landing
                  : entry.status;
        const base = (entry.repos.find((repo) => repo.repo === "root") ?? entry.repos[0])?.base.slice(0, 7);
        // Live totals: persisted totals plus the running turn's not-yet-flushed usage.
        const costUsd = entry.costUsd + (state?.pendingCostUsd ?? 0);
        const inputTokens = entry.inputTokens + (state?.pendingInputTokens ?? 0);
        const outputTokens = entry.outputTokens + (state?.pendingOutputTokens ?? 0);
        const subagents = subagentCountsOf(entry.id);
        const loop = loopProjectionOf(entry.id);
        return {
            id: entry.id,
            status,
            provider: entry.provider,
            harness: entry.harness,
            ...(entry.branch !== undefined ? { branch: entry.branch } : {}),
            updatedAt: Math.max(entry.updatedAt, state?.lastAt ?? 0),
            attention: {
                plan: parked.includes("plan"),
                question: parked.includes("question"),
                permission: parked.includes("permission"),
                // Reads the DERIVED verdict, not the stored report. Deriving this from a cached status was the
                // shape of the original bug in miniature: a faithful projection over a stale input is stale.
                conflict: status === "conflict",
            },
            ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
            ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
            ...(entry.title !== undefined ? { title: entry.title } : {}),
            ...(entry.model !== undefined ? { model: entry.model } : {}),
            ...(entry.effort !== undefined ? { effort: entry.effort } : {}),
            ...(entry.thinking !== undefined ? { thinking: entry.thinking } : {}),
            ...(entry.fast !== undefined ? { fast: entry.fast } : {}),
            ...(entry.account !== undefined ? { account: entry.account } : {}),
            ...(entry.autoLand !== undefined ? { autoLand: entry.autoLand } : {}),
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
            // The agents this one started. Read straight off the subagent registry rather than accumulated here:
            // that registry already retains and sweeps its own records, and a second copy of the count would be
            // the same projection with its own staleness (see the derived-verdict note on `conflict` above).
            ...(subagents.total > 0 ? { subagents } : {}),
            ...(entry.diffFiles !== undefined
                ? { diff: { files: entry.diffFiles, insertions: entry.diffInsertions ?? 0, deletions: entry.diffDeletions ?? 0 } }
                : {}),
            // The loop driving this conversation, read off the pump's own live state for the same reason the
            // subagent counts are read off theirs — one projection, no second copy to go stale.
            ...(loop !== undefined ? { loop } : {}),
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

    /* A loop's state moves BETWEEN turns, which is the one card-visible change no frame announces: the last
     * iteration's finish() has already published, and only then does the pump decide the goal is met. Without
     * this the card would hold `running · iteration 12/12` until something unrelated moved the fleet — at
     * precisely the moment someone is watching it. Never unsubscribed: the registry outlives the process. */
    onLoopChange(broadcast);

    // Only the live, branch-backed roster is probed — see LandStandings.refresh on why an archived agent keeps
    // its last answer, and why a workspace conversation has no standing to probe at all.
    const reprobe = (): Promise<boolean> => standings.refresh(entries.filter(isIsolated).filter((entry) => entry.archivedAt === undefined));

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
     * sideways move. Everything else has to strictly outrank what is already there: a model name or a plan
     * heading may replace the prompt the title was derived from, a plan may replace a model name but never the
     * reverse, nothing may replace a rename, and a REPLAN may not rename the job the first plan already named.
     * The strictness is also what makes the naming pass self-limiting: once one model name lands, the next
     * turn's would be a sideways move and is never even attempted. Returns whether the entry changed, so
     * callers persist and broadcast only when something actually did. */
    const promoteTitle = (id: string, title: string | undefined, source: AgentTitleSource): boolean => {
        const entry = entryOf(id);
        const clean = title === undefined ? undefined : sanitizeTitle(title);
        if (entry === undefined || clean === undefined) {
            return false;
        }
        // A provider failure sentence ("You've hit your session limit · resets …", "Failed to authenticate.
        // API Error: 401 …") is never a NAME, however it got here — a naming pass whose own model call hit
        // the condition, a plan heading quoting the failure. Only a rename may say it, because a rename is the
        // user's to waste. And a STORED title that is one was stolen exactly that way: it forfeits its
        // source's rank, so the next honest promotion replaces it instead of bouncing off the sideways-move
        // rule below. The family, never a member of it — see failure-sentences.ts on what guarding one cost.
        if (source !== "user" && isFailureSentence(clean)) {
            return false;
        }
        const currentRank = entry.title !== undefined && isFailureSentence(entry.title) ? -1 : TITLE_RANK[entry.titleSource ?? "derived"];
        if (source !== "user" && TITLE_RANK[source] <= currentRank) {
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
            /* The roster goes out the moment it is loaded — an /events stream that connected during boot is
             * already holding an empty fleet and this frame is what fills it. Standings are probed BEHIND the
             * broadcast, not before it: a reboot's verdict cache is empty, so the probe is a git spawn per live
             * agent, and awaiting it here held the whole boot (and with it every route) behind minutes of git
             * on a machine that had just crashed. Unprobed agents read `idle` for the seconds until the
             * refresh's own broadcast corrects them. */
            broadcast();
            void reprobe()
                .then((moved) => {
                    if (moved) {
                        broadcast();
                    }
                })
                .catch(() => undefined);
        },
        refreshStandings: async () => {
            if (await reprobe()) {
                broadcast();
            }
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
        sessionIdOf: (id) => runtime.get(id)?.pendingSessionId ?? entryOf(id)?.sessionId,
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
            // Placement is latched with the identity. A stale tab may send its old `isolated` posture, but an
            // existing workspace conversation stays in /work and an existing worktree conversation keeps its
            // branch. Only a conversation the registry has never seen takes the request's placement choice.
            const isolated = existing === undefined ? turn.isolated : existing.branch !== undefined;
            // An authored title — the browser's own derivation, or a rename that landed mid-turn — is taken as
            // written. A turn that arrived WITHOUT one (an automation, a Discord mention, a webchat visitor)
            // is named by the same rule the browser runs, so one prompt opens under one name wherever it
            // entered; sanitizeTitle then does what it does for any title, including turning empty into none.
            const title =
                existing?.title ?? (turn.title !== undefined ? sanitizeTitle(turn.title) : undefined) ?? sanitizeTitle(deriveTitle(turn.prompt));
            // The turn's settings, each falling back to the last turn's: a caller that states none (an
            // automation, a Discord mention) keeps describing the agent by what it has actually been running.
            const model = turn.model ?? existing?.model;
            const effort = turn.effort ?? existing?.effort;
            const thinking = turn.thinking ?? existing?.thinking;
            const fast = turn.fast ?? existing?.fast;
            const account = turn.account ?? existing?.account;
            // Provenance belongs to the turn that CREATED the conversation and is never re-derived: the user's
            // own follow-up turns in a surfaced agent's tab carry no origin, and must not strip the Discord
            // mention that opened it off the card.
            const origin = existing?.origin ?? turn.origin;
            replace({
                id: turn.conversationId,
                ...(isolated ? { branch: existing?.branch ?? `agent/${turn.conversationId}` } : {}),
                provider: turn.provider,
                harness: turn.harness,
                repos: existing?.repos ?? [],
                // The state this turn should be found in if it never reports back — see the store's note on
                // PersistedAgentStatusSchema. finish() overwrites it moments later in the ordinary case (it
                // runs in a `finally`, so an abort and a failure both reach it); what it cannot overwrite is
                // the daemon being killed under the turn, and THAT is what this value is for.
                status: "interrupted",
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
                ...(effort !== undefined ? { effort } : {}),
                ...(thinking !== undefined ? { thinking } : {}),
                ...(fast !== undefined ? { fast } : {}),
                ...(account !== undefined ? { account } : {}),
                ...(origin !== undefined ? { origin } : {}),
                ...(existing?.sessionId !== undefined ? { sessionId: existing.sessionId } : {}),
                // The read marker survives the rebuild too — a new turn makes the agent unread again (updatedAt
                // now outruns it), but WHEN it was last opened is what tells "New" from "Updated".
                ...(existing?.seenAt !== undefined ? { seenAt: existing.seenAt } : {}),
                // `archivedAt` is deliberately NOT carried across: sending an archived agent a message is how
                // you un-archive it, so the entry rebuilt here is a live one again. The checkout follows
                // immediately — the ensure() right after this re-attaches it from the surviving branch.
                // The land posture survives the rebuild too: "hold this agent's work" is a standing choice
                // about the conversation, and the next turn is exactly when it matters.
                ...(existing?.autoLand !== undefined ? { autoLand: existing.autoLand } : {}),
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
            // File this turn's prompt against the session the fleet filter will search — right now if the
            // conversation already has one, else on the `session` frame that mints it (see observe). The
            // transcript gets the same prompt moments later, but "moments" is a whole turn long when the turn
            // is a twenty-minute one, and the prompt just sent is the likeliest thing to be searched for.
            if (existing?.sessionId !== undefined) {
                recordPrompt(existing.sessionId, turn.prompt);
            } else {
                state.pendingPrompt = turn.prompt;
            }
            runtime.set(turn.conversationId, state);
            recordConversationPrompt(turn.conversationId, turn.prompt);
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
        setAutoLand: async (id, autoLand) => {
            const entry = entryOf(id);
            if (entry === undefined) {
                return undefined;
            }
            // null strips the key entirely rather than storing it: absent IS the "inherit" state, and it is
            // what keeps the agent following the sandbox-wide toggle wherever it is pointed next.
            const { autoLand: _cleared, ...carried } = entry;
            const next = { ...carried, ...(autoLand !== null ? { autoLand } : {}) };
            replace(next);
            await persist();
            broadcast();
            return summaryOf(next);
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
                    // The turn's own prompt has been waiting for exactly this id (see begin) — file it so the
                    // agent is findable by what started it from its first frame, not from its last.
                    if (state.pendingPrompt !== undefined) {
                        recordPrompt(event.sessionId, state.pendingPrompt);
                        state.pendingPrompt = undefined;
                    }
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
                    // A turn being torn down cannot park on anything: the abort settles every waiter, so a card
                    // raised by a frame still in flight behind the stop would ask the user a question whose
                    // answer has nowhere to go — and would put the card back in Attention as it leaves.
                    if (state.stopping) {
                        return;
                    }
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
                    /* A failure the daemon has already scheduled a resume for is not how this turn ENDED — the
                     * turn is coming back (turn-resume.ts), and the card has to read as work in progress rather
                     * than as a card the user needs to go look at. Without this a provider blip painted the whole
                     * board red for the length of an outage, which is both wrong and the strongest possible
                     * argument for switching the automation off.
                     *
                     * Keyed on the frame's own verdict rather than on the code, so it covers every condition that
                     * resumes itself. "available" is NOT covered — nothing is armed, so the failure stands until
                     * the user arms it. */
                    if (event.autoResume === "scheduled") {
                        return;
                    }
                    state.errored = true;
                    break;
                default:
                    return; // delta/thinking/etc — not card-visible, skip the broadcast.
            }
            broadcast();
        },
        stopping: (id) => {
            const state = runtime.get(id);
            // Nothing running ⇒ nothing to say. A stop that raced the turn's own last frame is not news, and
            // marking a settled conversation would leave `stopping` on the entry for the NEXT turn to inherit.
            if (state === undefined || !state.running || state.stopping) {
                return;
            }
            state.stopping = true;
            // The abort settles every card this turn was parked on (agent-requests.ts) — including the ones
            // whose `resolved` frame will never make it out of the dying stream. Cleared here rather than at
            // finish so the card stops asking for an answer it can no longer take the moment the stop lands.
            state.pauses.clear();
            broadcast();
        },
        finish: async (id, now) => {
            const entry = entryOf(id);
            const state = runtime.get(id);
            // Captured BEFORE the reset: only a finish that ends a LIVE turn counts toward `turns` — the
            // manual land route finishes with an outcome outside any turn and must not inflate the counter.
            const ranTurn = state?.running === true;
            // Same reason, for the value this writes below: the reset clears it, and a manual land's finish
            // (no runtime state at all) must not read as a stop.
            const wasStopped = state?.stopping === true;
            if (state !== undefined) {
                state.running = false;
                state.stopping = false;
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
                    // How the turn ENDED, which is all this field says now: an observed error frame, the user's
                    // own Stop, else the clean ending that hands the question to standing.ts. A stop outranks
                    // nothing — the abort's own unwind no longer reaches here as an error (see agent.routes'
                    // frame loop), so an errored stop means the turn had already failed when it was stopped.
                    status: state?.errored === true ? "error" : wasStopped ? "stopped" : "idle",
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
            // The turn just moved the branch (and, on an auto-land, the main tree) — re-derive BEFORE the
            // roster goes out, so the card the user sees settle carries the new standing rather than the one
            // from before the turn ran.
            await reprobe();
            broadcast();
        },
        recordLanded: async (id, outcome) => {
            const entry = entryOf(id);
            if (entry === undefined) {
                return;
            }
            const { conflicts: _cleared, ...carried } = entry;
            replace({
                ...carried,
                repos: [...outcome.repos],
                diffFiles: outcome.diff.files,
                diffInsertions: outcome.diff.insertions,
                diffDeletions: outcome.diff.deletions,
                ...(outcome.conflicts !== undefined ? { conflicts: [...outcome.conflicts] } : {}),
            });
            await persist();
            // The landedTips just moved, which is half the anchor every standing is measured from.
            await reprobe();
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
        remove: async (ids) => {
            const targets = new Set(ids);
            entries = entries.filter((entry) => !targets.has(entry.id));
            for (const id of targets) {
                runtime.delete(id);
            }
            standings.forget(ids);
            forgetLoops(ids);
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
