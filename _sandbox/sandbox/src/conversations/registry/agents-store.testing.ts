import type { IsolatedAgent, PersistedAgent, RepoRecord } from "./agents-store.js";

// A conversation's record as its first settle leaves it, in the shared tree; each suite states the records it reads.
export const conversationEntry = (overrides: Partial<PersistedAgent> = {}): PersistedAgent => ({
    id: "c1",
    placement: { kind: "main" },
    identity: {},
    profile: { provider: "claude", harness: "native" },
    ending: { kind: "idle" },
    postures: {},
    landing: {},
    social: { title: { text: "fix the thing", source: "derived" }, reactions: [] },
    totals: { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0, toolUses: 0, subagents: 0 },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
});

// A conversation `turns` turns in: what a turn's planner reads to decide what the opening turn alone is owed.
export const conversationAfter = (turns: number, overrides: Partial<PersistedAgent> = {}): PersistedAgent =>
    conversationEntry({ totals: { costUsd: 0, inputTokens: 0, outputTokens: 0, turns, toolUses: 0, subagents: 0 }, ...overrides });

// One agent card mid-life, nothing landed yet; IsolatedAgent (not PersistedAgent) since placement-reading code needs
// the worktree-carrying subtype. `repos` is readonly, matching what ConversationWorktree hands back.
export const isolatedAgent = (repos: readonly RepoRecord[], overrides: Partial<IsolatedAgent> = {}): IsolatedAgent => {
    const id = overrides.id ?? "c1";
    return {
        ...conversationEntry({ id }),
        placement: { kind: "worktree", branch: `agent/${id}`, repos: [...repos] },
        ...overrides,
    };
};
