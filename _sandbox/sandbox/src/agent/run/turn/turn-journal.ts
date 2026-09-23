import { AgentOriginSchema, AgentTurnSchema, ParkedRequestSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import type { Services } from "../../../composition.js";
import type { ConversationsDb } from "../../../store/conversations-db.js";

// Persists what's needed to re-run an in-flight turn: process-local state (the run, steering, approval bridge) dies
// with the container, though frames and transcript survive elsewhere. A turn and an automation fire replay differently,
// so each is its own kind, re-run at boot by its own writer (turn-resume.ts, automations/fire-resume.ts).

// Covers a rebuild plus a long run, measured from the entry's start since nothing records when the daemon died.
const RESUME_MAX_AGE_MS = 6 * 60 * 60_000;

// Exactly once: written as spent before the re-run starts, so the counter survives the crash it guards against.
const MAX_RESUME_ATTEMPTS = 1;

// Re-resolved at resume time (fresh credentials, worktree state); intersected, not extended, so a turn invalid at the
// route can't be journalled either.
const JournalledInputSchema = z.intersection(AgentTurnSchema, z.object({ conversationId: z.string() }));

// startedAt backs the staleness check on resume; attempts caps re-running a turn whose own output loops the daemon into
// OOM forever.
const inFlightSince = { startedAt: z.number(), attempts: z.number() };

const JournalledTurnSchema = z.object({
    ...inFlightSince,
    kind: z.literal("turn"),
    turn: JournalledInputSchema,
    // The session last reported; resume continues from its partial work instead of starting the turn over.
    sessionId: z.string().optional(),
    // Parked cards, restored at boot so a turn waiting on the user isn't re-run; handover cards never appear here.
    parked: z.array(ParkedRequestSchema).optional(),
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
export type JournalledFire = z.infer<typeof JournalledFireSchema>;

export type JournalEntry = JournalledTurn | JournalledFire;

// Why a boot leaves an entry interrupted rather than re-running it: its attempt is spent, or it is too old to be wanted.
export const resumeBars = (entry: JournalEntry, now: number): { readonly spent: boolean; readonly stale: boolean } => ({
    spent: entry.attempts >= MAX_RESUME_ATTEMPTS,
    stale: now - entry.startedAt > RESUME_MAX_AGE_MS,
});

type JournalDeps = Pick<Services, "turnJournal" | "logger">;

// Takes the entry off the journal, its interruption left standing on whatever record it has.
export const consumeEntry = async (services: JournalDeps, entry: JournalEntry): Promise<void> => {
    const clear =
        entry.kind === "turn" ? services.turnJournal.clearTurn(entry.turn.conversationId) : services.turnJournal.clearFire(entry.automationId);
    await clear.catch((error: unknown) => services.logger.warn({ err: error }, "turn journal: interrupted entry not cleared"));
};

// A failed write is treated as unspendable: the entry drops, rather than risking a re-run that returns on every boot.
export const spendAttempt = async (services: JournalDeps, entry: JournalEntry): Promise<void> => {
    const next = { ...entry, attempts: entry.attempts + 1 };
    const write = next.kind === "turn" ? services.turnJournal.recordTurn(next) : services.turnJournal.recordFire(next);
    await write.catch(async (error: unknown) => {
        services.logger.warn({ err: error }, "turn journal: attempt not recorded, dropping the entry rather than risking a resume loop");
        await consumeEntry(services, entry);
    });
};

export interface TurnJournal {
    // Everything still in flight; after a boot, everything the daemon died under.
    readonly list: () => Promise<JournalEntry[]>;
    // Filed under the conversation, whose row must exist; a turn's opening entry is written with it by the fleet
    // (journalRows below), so this is the boot pass's rewrite of a spent attempt.
    readonly recordTurn: (turn: JournalledTurn) => Promise<void>;
    // Filed under the automation, which never overlaps itself (scheduler.ts's inFlight set).
    readonly recordFire: (fire: JournalledFire) => Promise<void>;
    readonly clearTurn: (conversationId: string) => Promise<void>;
    readonly clearFire: (automationId: string) => Promise<void>;
}

// The turn rows as statements, synchronous so a writer holding a transaction can put one inside it: the fleet writes a
// turn's opening entry and its journal row as one write (agents-registry.ts).
export interface TurnJournalRows {
    readonly putTurn: (turn: JournalledTurn) => void;
    readonly deleteTurn: (conversationId: string) => void;
}

interface TurnRow {
    readonly started_at: number;
    readonly attempts: number;
    readonly turn: string;
    readonly session_id: string | null;
    readonly parked: string | null;
}

interface FireRow {
    readonly automation_id: string;
    readonly conversation_id: string;
    readonly started_at: number;
    readonly attempts: number;
    readonly payload: string | null;
    readonly origin: string | null;
    readonly title: string | null;
}

export const turnJournalRows = ({ db }: ConversationsDb): TurnJournalRows => {
    const upsert = db.prepare(`
        INSERT INTO turn_journal(conversation_id, started_at, attempts, turn, session_id, parked) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET started_at = excluded.started_at, attempts = excluded.attempts,
            turn = excluded.turn, session_id = excluded.session_id, parked = excluded.parked
    `);
    const remove = db.prepare("DELETE FROM turn_journal WHERE conversation_id = ?");
    return {
        putTurn: (entry) => {
            upsert.run(
                entry.turn.conversationId,
                entry.startedAt,
                entry.attempts,
                JSON.stringify(entry.turn),
                entry.sessionId ?? null,
                entry.parked === undefined ? null : JSON.stringify(entry.parked),
            );
        },
        deleteTurn: (conversationId) => {
            remove.run(conversationId);
        },
    };
};

// A row this build can no longer read is skipped, never deleted: nothing here is worth a resume that runs blind.
const turnOf = (row: TurnRow): JournalledTurn[] => {
    const parsed = JournalledTurnSchema.safeParse({
        kind: "turn",
        startedAt: row.started_at,
        attempts: row.attempts,
        turn: JSON.parse(row.turn),
        ...(row.session_id === null ? {} : { sessionId: row.session_id }),
        ...(row.parked === null ? {} : { parked: JSON.parse(row.parked) }),
    });
    return parsed.success ? [parsed.data] : [];
};

const fireOf = (row: FireRow): JournalledFire[] => {
    const parsed = JournalledFireSchema.safeParse({
        kind: "automation",
        automationId: row.automation_id,
        conversationId: row.conversation_id,
        startedAt: row.started_at,
        attempts: row.attempts,
        ...(row.payload === null ? {} : { payload: row.payload }),
        ...(row.origin === null ? {} : { origin: JSON.parse(row.origin) }),
        ...(row.title === null ? {} : { title: row.title }),
    });
    return parsed.success ? [parsed.data] : [];
};

export const sqliteTurnJournal = (conversations: ConversationsDb): TurnJournal => {
    const { db } = conversations;
    const rows = turnJournalRows(conversations);
    const selectTurns = db.prepare("SELECT * FROM turn_journal ORDER BY started_at");
    const selectFires = db.prepare("SELECT * FROM fire_journal ORDER BY started_at");
    const upsertFire = db.prepare(`
        INSERT INTO fire_journal(automation_id, conversation_id, started_at, attempts, payload, origin, title) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(automation_id) DO UPDATE SET conversation_id = excluded.conversation_id, started_at = excluded.started_at,
            attempts = excluded.attempts, payload = excluded.payload, origin = excluded.origin, title = excluded.title
    `);
    const deleteFire = db.prepare("DELETE FROM fire_journal WHERE automation_id = ?");
    return {
        list: async () => [
            ...(selectTurns.all() as unknown as TurnRow[]).flatMap(turnOf),
            ...(selectFires.all() as unknown as FireRow[]).flatMap(fireOf),
        ],
        recordTurn: async (turn) => rows.putTurn(turn),
        recordFire: async (fire) => {
            upsertFire.run(
                fire.automationId,
                fire.conversationId,
                fire.startedAt,
                fire.attempts,
                fire.payload ?? null,
                fire.origin === undefined ? null : JSON.stringify(fire.origin),
                fire.title ?? null,
            );
        },
        clearTurn: async (conversationId) => rows.deleteTurn(conversationId),
        clearFire: async (automationId) => {
            deleteFire.run(automationId);
        },
    };
};
