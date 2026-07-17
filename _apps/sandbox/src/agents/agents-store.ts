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
export const PersistedAgentStatusSchema = z.enum(["idle", "landed", "conflict", "error"]);

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
    // The worktree composition: each workspace repo ("root" or a repositories/<name> dir name) with the full
    // base sha its worktree branched from — the diff + land reference points.
    repos: z.array(z.object({ repo: z.string(), base: z.string() })),
    status: PersistedAgentStatusSchema,
    costUsd: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
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
