import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentOriginSchema, AgentTurnSchema, ParkedCardSchema } from "@intentic/sandbox-contract";
import { z } from "zod";

/* THE TURN JOURNAL — what is in flight right now, written down where the process cannot take it with it.
 *
 * A turn's frames live in memory (turn-runs.ts) and its transcript lives in the provider's session store, so a
 * reload, a second device and a dropped tunnel all survive already. What does NOT survive is the daemon: the
 * detached run, the steering registry and the approval bridge are all process-local, and the container is
 * recreated on every update, every environment approval and every `dev-sandbox.sh` swap — so intentic's own
 * flows kill turns. "Approve the Dockerfile change the agent asked for" must not mean "and lose its
 * forty-minute run".
 *
 * The journal is the missing half. Each in-flight turn writes down what would be needed to run it AGAIN, and
 * deletes that when it settles. Whatever is still here at boot is therefore exactly the set of turns the daemon
 * died under — no graceful shutdown required, which is the only way to get this right, since the killing signal
 * is usually SIGKILL from an outside `docker rm -f` (see agents-store.ts on the same reasoning behind the
 * persisted `interrupted` status). turn-resume.ts owns what to do with them.
 *
 * On the HISTORY volume, beside the activity and usage ledgers: the journal holds a turn's full prompt, so it is
 * daemon-private and outside the agent's reach. One file per entry, never a shared manifest — concurrent turns
 * would race a read-modify-write, the same argument the approvals queue makes.
 *
 * TWO KINDS, because the two things that start turns replay differently. A chat turn replays as itself: the
 * input the client sent, re-resolved from scratch. An automation fire replays as a FIRE — the trigger inputs
 * handed back to fireAutomation, which is exactly what the approve route already does with a held wake. That
 * keeps the overlap guard, the run record and the activity append, and it re-reads the automation's config, so
 * a prompt the owner has since fixed comes back fixed. */

// The charset shared by ConversationIdSchema and the contract's entryId, so both kinds' ids are filename-safe.
// A filename that doesn't match is ignored, never trusted — the same rule the approvals queue applies.
const FILE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

// What every entry carries whatever started it: when the interrupted turn began (the resume's staleness test),
// and how many times a boot has already re-run it — a turn whose own tool output OOM-kills the daemon would
// otherwise resurrect it on every boot forever, so the resume spends this before it fires.
const inFlightSince = { startedAt: z.number(), attempts: z.number() };

const JournalledTurnSchema = z.object({
    ...inFlightSince,
    kind: z.literal("turn"),
    // The turn as the client sent it, re-resolved at resume time (fresh credentials, fresh worktree state) —
    // nothing perishable is snapshotted here, the same contract turn-resume's in-memory failures keep. Intersected
    // rather than extended: AgentTurnSchema carries the refinements that make a turn coherent (a prompt or
    // attachments, history XOR sessionId), and the journal has no business accepting a turn that would be
    // refused at the route — it would only fail again on resume.
    turn: z.intersection(AgentTurnSchema, z.object({ conversationId: z.string() })),
    // The session the turn last reported. It holds the partial work the resume continues from, which is the
    // difference between picking the thread back up and starting the whole turn over.
    sessionId: z.string().optional(),
    /* The cards this turn is PARKED on right now — the raised plan/question/permission frames verbatim,
     * appended as each goes up and removed as each resolves. Their presence at boot is what tells a turn that
     * was WAITING ON THE USER from one the daemon died under mid-work: the first is not re-run and not left
     * `interrupted` — its cards are restored as they stood, and the user's answer is what runs next
     * (turn-resume.ts). browser_help is never here: the browser session its card points at died with the
     * container, so that park has nothing to restore. */
    parked: z.array(ParkedCardSchema).optional(),
});
export type JournalledTurn = z.infer<typeof JournalledTurnSchema>;

const JournalledFireSchema = z.object({
    ...inFlightSince,
    kind: z.literal("automation"),
    automationId: z.string(),
    // The stable conversation opened by this fire. Reused by the restart path so an interrupted wake resumes
    // the same fleet card instead of minting a second identity for one logical run.
    conversationId: z.string(),
    // The trigger inputs of the fire, snapshotted exactly as the approvals queue snapshots a held wake — a
    // webhook body or a Discord mention exists nowhere else, and a re-fire without it would run blind.
    payload: z.string().optional(),
    origin: AgentOriginSchema.optional(),
    title: z.string().optional(),
});
export type JournalledFire = z.infer<typeof JournalledFireSchema>;

const JournalEntrySchema = z.discriminatedUnion("kind", [JournalledTurnSchema, JournalledFireSchema]);
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

export interface TurnJournal {
    // Everything still in flight, which after a boot means everything the daemon died under.
    readonly list: () => Promise<JournalEntry[]>;
    // Record (or replace) the conversation's in-flight turn. Filed under the conversation, so a new turn
    // overwrites a stale entry rather than leaving two: turn-runs already refuses a second concurrent run per
    // conversation, and self-healing beats a leak when a clear fails.
    readonly recordTurn: (turn: JournalEntry & { kind: "turn" }) => Promise<void>;
    // Record (or replace) an automation's in-flight fire, filed under the automation — which never overlaps
    // itself either (scheduler.ts's inFlight set).
    readonly recordFire: (fire: JournalEntry & { kind: "automation" }) => Promise<void>;
    readonly clearTurn: (conversationId: string) => Promise<void>;
    readonly clearFire: (automationId: string) => Promise<void>;
}

// A per-file JSON store, used in production at <historyRoot>/turns/. The two kinds share the directory under
// distinct prefixes, so a conversation and an automation of the same name cannot collide.
export const fileTurnJournal = (dir: string): TurnJournal => {
    const write = async (file: string, entry: JournalEntry): Promise<void> => {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${file}.json`), `${JSON.stringify(entry, undefined, 2)}\n`);
    };
    // A clear that finds nothing has nothing to do: the turn settled twice, or a boot pass already took it.
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
                if (!FILE_ID.test(id)) {
                    continue;
                }
                // An entry that won't parse is SKIPPED, never deleted. Reading is not the moment to destroy a
                // record: a file caught mid-write parses as garbage for an instant, and a lister that answered
                // that by unlinking would delete the live entry of a turn that had only just started. The cost of
                // keeping it is one failed parse per boot.
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
