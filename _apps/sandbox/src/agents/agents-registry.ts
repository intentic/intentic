import type { AgentEvent, AgentSummary, AgentTurn } from "@intentic/sandbox-contract";
import type { AgentsStore, PersistedAgent } from "./agents-store.js";

// The runtime half of the fleet registry: holds the authoritative in-memory entry list (loaded once from the
// store, write-through on persisted mutations) plus per-conversation turn state rebuilt from AgentEvent frames
// — status (running/awaiting), attention flags, the card's activity snippet, context fill, and the per-
// conversation turn mutex. Every card-visible change broadcasts the FULL roster (snapshots, not diffs — the
// same last-frame-wins contract as presence), which system.routes relays onto /events.

const MAX_TITLE_LENGTH = 80;
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
    awaiting: boolean;
    plan: boolean;
    question: boolean;
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
    awaiting: false,
    plan: false,
    question: false,
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
export type AgentTurnIdentity = Pick<AgentTurn, "prompt" | "model" | "account"> & {
    readonly conversationId: string;
    readonly provider: NonNullable<AgentTurn["agent"]>;
    readonly harness: NonNullable<AgentTurn["harness"]>;
};

export interface AgentsRegistry {
    readonly init: () => Promise<void>;
    readonly ids: () => string[];
    readonly list: () => AgentSummary[];
    readonly get: (id: string) => AgentSummary | undefined;
    // The persisted entry — the worktree composition (per-repo bases) diff/land need.
    readonly entry: (id: string) => PersistedAgent | undefined;
    readonly running: (id: string) => boolean;
    // Acquire the conversation's turn mutex and mark it running, creating/updating the entry. False ⇒ a turn
    // is already running for that conversation (the caller surfaces the coded busy error).
    readonly begin: (turn: AgentTurnIdentity, now: number) => Promise<boolean>;
    // Record the worktree composition on first creation (per-repo full base shas).
    readonly recordWorktree: (id: string, repos: readonly PersistedAgent["repos"][number][]) => Promise<void>;
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
    readonly remove: (id: string) => Promise<void>;
    // Immediate snapshot on subscribe, so a fresh /events connection paints the fleet without waiting.
    readonly subscribe: (listener: (agents: AgentSummary[]) => void) => () => void;
}

export const createAgentsRegistry = (store: AgentsStore): AgentsRegistry => {
    let entries: PersistedAgent[] = [];
    const runtime = new Map<string, RuntimeState>();
    const listeners = new Set<(agents: AgentSummary[]) => void>();

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
        const status = state?.running === true ? (state.awaiting ? "awaiting" : "running") : entry.status;
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
            attention: { plan: state?.plan ?? false, question: state?.question ?? false, conflict: entry.status === "conflict" },
            ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
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
            ...(entry.turns !== undefined ? { turns: entry.turns } : {}),
            // Live count: the running turn's tool calls show on the card as they happen.
            ...((entry.toolUses ?? 0) + (state?.pendingToolUses ?? 0) > 0
                ? { toolUses: (entry.toolUses ?? 0) + (state?.pendingToolUses ?? 0) }
                : {}),
            ...(entry.diffFiles !== undefined
                ? { diff: { files: entry.diffFiles, insertions: entry.diffInsertions ?? 0, deletions: entry.diffDeletions ?? 0 } }
                : {}),
        };
    };

    const list = (): AgentSummary[] => entries.map(summaryOf);

    const broadcast = (): void => {
        const agents = list();
        for (const listener of listeners) {
            listener(agents);
        }
    };

    const persist = (): Promise<void> => store.save(entries);

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
        get: (id) => {
            const entry = entryOf(id);
            return entry === undefined ? undefined : summaryOf(entry);
        },
        entry: entryOf,
        running: (id) => runtime.get(id)?.running === true,
        begin: async (turn, now) => {
            if (runtime.get(turn.conversationId)?.running === true) {
                return false;
            }
            const existing = entryOf(turn.conversationId);
            const title = existing?.title ?? sanitizeTitle(turn.prompt);
            const model = turn.model ?? existing?.model;
            const account = turn.account ?? existing?.account;
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
                ...(title !== undefined ? { title } : {}),
                ...(model !== undefined ? { model } : {}),
                ...(account !== undefined ? { account } : {}),
                ...(existing?.sessionId !== undefined ? { sessionId: existing.sessionId } : {}),
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
        observe: (id, event) => {
            const state = runtimeOf(id);
            state.lastAt = Date.now();
            // A frame after a pause means the user answered — the turn is executing again.
            const resumed = state.awaiting && event.kind !== "plan" && event.kind !== "question";
            if (resumed) {
                state.awaiting = false;
                state.plan = false;
                state.question = false;
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
                    state.awaiting = true;
                    state.plan = true;
                    break;
                case "question":
                    state.awaiting = true;
                    state.question = true;
                    break;
                case "tool_call":
                    state.pendingToolUses += 1;
                    state.activity = { tool: event.name, ...(event.target !== undefined ? { target: event.target } : {}), ...(state.activity?.todo !== undefined ? { todo: state.activity.todo } : {}) };
                    break;
                case "todos": {
                    const current = event.items.find((item) => item.status === "in_progress")?.content;
                    state.activity = { ...(state.activity ?? {}), ...(current !== undefined ? { todo: current } : {}) };
                    break;
                }
                case "error":
                    state.errored = true;
                    break;
                default:
                    if (!resumed) {
                        return; // delta/thinking/etc — not card-visible, skip the broadcast.
                    }
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
                state.awaiting = false;
                state.plan = false;
                state.question = false;
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
        remove: async (id) => {
            entries = entries.filter((entry) => entry.id !== id);
            runtime.delete(id);
            await persist();
            broadcast();
        },
        subscribe: (listener) => {
            listeners.add(listener);
            listener(list());
            return () => listeners.delete(listener);
        },
    };
};
