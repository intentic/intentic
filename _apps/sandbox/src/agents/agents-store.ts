import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AgentHarnessSchema, AgentProviderSchema } from "@intentic/sandbox-contract";
import { z } from "zod";

// The persisted half of the fleet registry (<historyRoot>/agents.json — on the /history volume so a
// conversation's identity survives container rebuilds alongside its worktree). One entry per ISOLATED
// conversation. Runtime-only state (running/awaiting, attention, activity, context fill) lives in the
// registry's memory and is rebuilt from turn frames; only what must survive a restart is here.

// Persisted status excludes the transient running/awaiting — a daemon restart mid-turn must rehydrate to a
// state the user can act on (the turn itself is gone).
const PersistedAgentStatusSchema = z.enum(["idle", "landed", "conflict", "error"]);

export const PersistedAgentSchema = z.object({
    // The conversationId — also the worktree dir name and the agent/<id> branch suffix.
    id: z.string(),
    branch: z.string(),
    // First prompt, sanitized to one bounded line.
    title: z.string().optional(),
    provider: AgentProviderSchema,
    harness: AgentHarnessSchema,
    model: z.string().optional(),
    account: z.string().optional(),
    sessionId: z.string().optional(),
    // The worktree composition: each workspace repo ("root" or a repo id — its root-relative dir) with the full
    // base sha its worktree branched from, and the branch tip whose delta has already LANDED into the main
    // tree (absent ⇒ nothing landed yet — the base is the reference). Diff/land read `landedTip ?? base`, so
    // the review shows only the not-yet-landed remainder and each land applies only the new delta.
    repos: z.array(z.object({ repo: z.string(), base: z.string(), landedTip: z.string().optional() })),
    status: PersistedAgentStatusSchema,
    costUsd: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    // Completed turns + lifetime tool calls (optional: entries predating the counters read as absent).
    turns: z.number().optional(),
    toolUses: z.number().optional(),
    // Cumulative base→tip output across the composition, refreshed on each land — the card's diffstat.
    diffFiles: z.number().optional(),
    diffInsertions: z.number().optional(),
    diffDeletions: z.number().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
});
export type PersistedAgent = z.infer<typeof PersistedAgentSchema>;

export interface AgentsStore {
    readonly load: () => Promise<PersistedAgent[]>;
    // Full-replace write (the registry owns the authoritative in-memory array after init).
    readonly save: (agents: readonly PersistedAgent[]) => Promise<void>;
}

export const fileAgentsStore = (path: string): AgentsStore => ({
    load: async () => {
        try {
            const parsed = z.array(PersistedAgentSchema).safeParse(JSON.parse(await readFile(path, "utf8")));
            return parsed.success ? parsed.data : [];
        } catch {
            return [];
        }
    },
    save: async (agents) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${JSON.stringify(agents, undefined, 2)}\n`);
    },
});
