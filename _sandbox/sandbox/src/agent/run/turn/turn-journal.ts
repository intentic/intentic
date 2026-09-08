import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { AgentOriginSchema, AgentTurnSchema, isConversationId, ParkedCardSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { writeJsonFile } from "../../../store/json-file.js";

// Persists what's needed to re-run an in-flight turn: process-local state (the run, steering, approval bridge) dies
// with the container, though frames and transcript survive elsewhere. One file per entry, not a shared manifest. A turn
// and an automation fire replay differently, so each is its own entry kind; turn-resume.ts owns what's done with what's
// found at boot.

// startedAt backs the staleness check on resume; attempts caps re-running a turn whose own output loops the daemon into
// OOM forever.
const inFlightSince = { startedAt: z.number(), attempts: z.number() };

const JournalledTurnSchema = z.object({
    ...inFlightSince,
    kind: z.literal("turn"),
    // Re-resolved at resume time (fresh credentials, worktree state); intersected, not extended, so a turn invalid at
    // the route can't be journalled either.
    turn: z.intersection(AgentTurnSchema, z.object({ conversationId: z.string() })),
    // The session last reported; resume continues from its partial work instead of starting the turn over.
    sessionId: z.string().optional(),
    // Parked cards, restored at boot so a turn waiting on the user isn't re-run; handover cards never appear here.
    parked: z.array(ParkedCardSchema).optional(),
});
export type JournalledTurn = z.infer<typeof JournalledTurnSchema>;

const JournalledFireSchema = z.object({
    ...inFlightSince,
    kind: z.literal("automation"),
    automationId: z.string(),
    // The stable conversation this fire opened; reused by restart so an interrupted wake resumes the same fleet card.
    conversationId: z.string(),
    // Trigger inputs snapshotted like a held wake in the approvals queue; a re-fire without them would run blind.
    payload: z.string().optional(),
    origin: AgentOriginSchema.optional(),
    title: z.string().optional(),
});

const JournalEntrySchema = z.discriminatedUnion("kind", [JournalledTurnSchema, JournalledFireSchema]);
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

export interface TurnJournal {
    // Everything still in flight; after a boot, everything the daemon died under.
    readonly list: () => Promise<JournalEntry[]>;
    // Filed under the conversation so a new turn overwrites a stale entry instead of leaving two.
    readonly recordTurn: (turn: JournalEntry & { kind: "turn" }) => Promise<void>;
    // Filed under the automation, which likewise never overlaps itself (scheduler.ts's inFlight set).
    readonly recordFire: (fire: JournalEntry & { kind: "automation" }) => Promise<void>;
    readonly clearTurn: (conversationId: string) => Promise<void>;
    readonly clearFire: (automationId: string) => Promise<void>;
}

// Per-file JSON store, used in production at <historyRoot>/turns/. Turn and fire entries share the directory under
// distinct prefixes so same-named ids can't collide.
export const fileTurnJournal = (dir: string): TurnJournal => {
    const write = async (file: string, entry: JournalEntry): Promise<void> => {
        // Uses the same sibling-temp + atomic-rename write as every manifest store, so a crash mid-write never leaves
        // an unparseable half-entry.
        await writeJsonFile(join(dir, `${file}.json`), entry);
    };
    // A clear that finds nothing has nothing to do: the turn already settled or a boot pass already took it.
    const drop = async (file: string): Promise<void> => {
        await unlink(join(dir, `${file}.json`)).catch(() => undefined);
    };
    const read = async (name: string): Promise<JournalEntry | undefined> => {
        try {
            const parsed = JournalEntrySchema.safeParse(JSON.parse(await readFile(join(dir, name), "utf8")));
            return parsed.success ? parsed.data : undefined;
        } catch {
            return undefined;
        }
    };
    return {
        list: async () => {
            let names: string[];
            try {
                names = await readdir(dir);
            } catch {
                return [];
            }
            const entries: JournalEntry[] = [];
            for (const name of names.filter((file) => file.endsWith(".json"))) {
                const id = name.slice(0, -".json".length);
                if (!isConversationId(id)) {
                    continue;
                }
                // An entry that fails to parse is skipped, never deleted: a file caught mid-write must not be unlinked
                // as if it were dead.
                const entry = await read(name);
                if (entry !== undefined) {
                    entries.push(entry);
                }
            }
            return entries;
        },
        recordTurn: (turn) => write(`t-${turn.turn.conversationId}`, turn),
        recordFire: (fire) => write(`a-${fire.automationId}`, fire),
        clearTurn: (conversationId) => drop(`t-${conversationId}`),
        clearFire: (automationId) => drop(`a-${automationId}`),
    };
};
