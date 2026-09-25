import { copyFile, cp, mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { isMissing, undefinedIfMissing } from "@intentic/base/errors";
import {
    AgentHarnessSchema,
    AgentOriginSchema,
    AgentProviderSchema,
    AgentTurnSchema,
    ForkedFromSchema,
    isConversationId,
    LandConflictSchema,
    LimitPolicySchema,
    ParkedRequestSchema,
    RetryPolicySchema,
    SessionOwnerSchema,
    TurnProfileSchema,
    UnfinishedWorkSchema,
    WatchOutcomeSchema,
} from "@intentic/sandbox-contract";
import { z } from "zod";
import { turnJournalRows } from "../../agent/run/turn/turn-journal.js";
import { opt } from "../../opt.js";
import { sessionsDir } from "../../sessions/session-store.js";
import { legacyTranscriptFile, transcriptFile } from "../../sessions/transcript-record.js";
import { conversationUnit } from "../../store/conversation-units.js";
import { type ConversationsDb, conversationsDbPath, openConversationsDb } from "../../store/conversations-db.js";
import { defineStep, type StepContext, type StepPlan } from "../../store/evolution/state-steps.js";
import { writeTextFile } from "../../store/text-file.js";
import { type Ending, type PersistedAgent, PersistedAgentSchema, sqliteAgentsStore } from "./agents-store.js";

// 1.308 (c760a6028) moved the conversation state on the history volume with no importer: agents.json, turns/,
// turn-checkpoints.json and watches/ went into conversations.db, and transcripts/, system-prompts/ and each fenced
// conversation's sessions/ into conversations/<id>/. A sandbox that updated across it booted to an empty board over files
// still on disk; this step imports them. A conversation is inserted only where its id is absent, with its checkpoints,
// turn in flight and watches, and its files are copied only where nothing stands at the target.
//
// The old files are never deleted or renamed: 1.307 predates the state engine and cannot restore a journal, so a rollback
// to it must find them exactly where it left them. Because they stay, the import record (importRecordPath) names every id the import has settled,
// so a conversation removed after its import is not imported again from the files still here.

// Where each piece lived before 1.308, relative to the history volume (history-state.ts at c760a6028^).
const OLD = {
    agents: "agents.json",
    checkpoints: "turn-checkpoints.json",
    turns: "turns",
    watches: "watches",
    transcripts: "transcripts",
    prompts: "system-prompts",
    sessions: "sessions",
} as const;

// Where the import notes every id it has settled, so none is imported twice.
export const importRecordPath = (historyRoot: string): string => join(historyRoot, "pre-1308-import.json");

/* ---- the formats as ≤1.307 wrote them, reconstructed from c760a6028^ ---- */

// agents-store.ts: one flat record per conversation, with its tolerances (an unknown status read as idle, an unknown
// title source as derived), so every record the old build could read is one this can map.
const OldAgentSchema = z.object({
    id: z.string(),
    branch: z.string().optional(),
    runner: z.string().optional(),
    title: z.string().optional(),
    titleSource: z.enum(["derived", "model", "plan", "user"]).catch("derived").optional(),
    titleAction: z.string().optional(),
    provider: AgentProviderSchema,
    harness: AgentHarnessSchema,
    model: z.string().optional(),
    effort: z.string().optional(),
    thinking: z.boolean().optional(),
    fast: z.boolean().optional(),
    account: z.string().optional(),
    sessionId: z.string().optional(),
    compactedTurn: z.number().optional(),
    origin: AgentOriginSchema.optional(),
    startedBy: z.string().optional(),
    areas: z.array(z.string()).optional(),
    owner: SessionOwnerSchema.optional(),
    startIn: z.string().optional(),
    actsAs: z.string().optional(),
    forkedFrom: ForkedFromSchema.optional(),
    repos: z.array(
        z.object({
            repo: z.string(),
            base: z.string(),
            landedTip: z.string().optional(),
            landedHead: z.string().optional(),
            landedAt: z.number().optional(),
            absorbed: z.number().optional(),
        }),
    ),
    composition: z.object({ persona: z.string().optional(), repos: z.array(z.string()) }).optional(),
    landedSubject: z.string().optional(),
    landedNote: z.string().optional(),
    landedBreaking: z.string().optional(),
    status: z.enum(["idle", "interrupted", "stopped", "error"]).catch("idle"),
    failure: z.string().optional(),
    failureCode: z.string().optional(),
    limitResetsAt: z.number().optional(),
    // Read for the record's validity only: the old build dropped all three on load, as this one does.
    limitHeld: z.boolean().optional(),
    limitScheduled: z.boolean().optional(),
    limitMoving: z.string().optional(),
    autoLand: z.boolean().optional(),
    limitPolicy: LimitPolicySchema.optional(),
    outagePolicy: RetryPolicySchema.optional(),
    stopPolicy: RetryPolicySchema.optional(),
    landRequested: z.object({ email: z.string(), name: z.string().optional(), at: z.number() }).optional(),
    reactions: z.array(z.object({ emoji: z.string(), email: z.string(), name: z.string().optional(), at: z.number() })).optional(),
    conflicts: z.array(LandConflictSchema).optional(),
    unfinished: UnfinishedWorkSchema.optional(),
    costUsd: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    turns: z.number().optional(),
    toolUses: z.number().optional(),
    subagents: z.number().optional(),
    diffFiles: z.number().optional(),
    diffInsertions: z.number().optional(),
    diffDeletions: z.number().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    seenAt: z.number().optional(),
    archivedAt: z.number().optional(),
});
type OldAgent = z.infer<typeof OldAgentSchema>;

// turn-checkpoints.ts: { [conversationId]: { [message index]: anchor } } in one file.
const OldAnchorSchema = z.union([
    z.object({ kind: z.literal("tree"), snapshot: z.string().min(1) }),
    z.object({ kind: z.literal("worktree"), repos: z.array(z.object({ repo: z.string(), base: z.string().min(1) })).min(1) }),
]);
type OldAnchor = z.infer<typeof OldAnchorSchema>;
const OldCheckpointsSchema = z.record(z.string(), z.record(z.string(), z.unknown()));

// turn-journal.ts: turns/t-<conversation>.json for a turn in flight, turns/a-<automation>.json for a fire.
const inFlightSince = { startedAt: z.number(), attempts: z.number() };
const OldTurnSchema = z.object({
    ...inFlightSince,
    kind: z.literal("turn"),
    turn: z.intersection(AgentTurnSchema, z.object({ conversationId: z.string() })),
    sessionId: z.string().optional(),
    parked: z.array(ParkedRequestSchema).optional(),
});
type OldTurn = z.infer<typeof OldTurnSchema>;
const OldFireSchema = z.object({
    ...inFlightSince,
    kind: z.literal("automation"),
    automationId: z.string(),
    conversationId: z.string(),
    payload: z.string().optional(),
    origin: AgentOriginSchema.optional(),
    title: z.string().optional(),
});
type OldFire = z.infer<typeof OldFireSchema>;
const OldJournalEntrySchema = z.discriminatedUnion("kind", [OldTurnSchema, OldFireSchema]);

// watch-journal.ts: watches/<watch>.json. Its turn object listed exactly TurnProfileSchema's fields.
const OldWatchSchema = z.object({
    id: z.string(),
    conversationId: z.string(),
    command: z.string(),
    note: z.string(),
    intervalMs: z.number(),
    armedAt: z.number(),
    deadlineAt: z.number(),
    cwd: z.string(),
    placement: z.object({ worktree: z.string(), fenced: z.boolean() }).optional(),
    outside: z.string().optional(),
    firing: z
        .object({
            outcome: WatchOutcomeSchema,
            check: z.object({ exitCode: z.number().optional(), output: z.string(), broken: z.string().optional() }),
        })
        .optional(),
    envKeys: z.array(z.string()),
    turn: TurnProfileSchema,
});
type OldWatch = z.infer<typeof OldWatchSchema>;

const ImportRecordSchema = z.object({ conversations: z.array(z.string()), fires: z.array(z.string()) });
type ImportRecord = z.infer<typeof ImportRecordSchema>;

// A small file read through the schema it was written with; absent, torn or unreadable is undefined, as it was to ≤1.307.
const parsed = <T>(schema: z.ZodType<T>, text: string | undefined): T | undefined => {
    if (text === undefined) {
        return undefined;
    }
    try {
        return schema.safeParse(JSON.parse(text)).data;
    } catch {
        // allow(silent-catch): a file that is not JSON was unreadable to ≤1.307 as well, so there is nothing in it to import
        return undefined;
    }
};

/* ---- one old record as this build's ---- */

// A spent allowance was an `error` coded rate_limit; its hold and booking were process memory, dropped on load then as now.
const endingOf = (old: OldAgent): Ending => {
    switch (old.status) {
        case "idle":
            return { kind: "idle" };
        case "interrupted":
            return { kind: "interrupted" };
        case "stopped":
            return { kind: "stopped" };
        case "error":
            return old.failureCode === "rate_limit"
                ? { kind: "limited", ...opt("failure", old.failure), ...opt("resetsAt", old.limitResetsAt), held: false, scheduled: false }
                : { kind: "failed", ...opt("failure", old.failure), ...opt("code", old.failureCode) };
    }
};

// Only a branch made a conversation isolated before 1.308, whatever else its record carried.
const placementOf = (old: OldAgent): PersistedAgent["placement"] =>
    old.branch === undefined
        ? { kind: "main" }
        : { kind: "worktree", branch: old.branch, ...opt("runner", old.runner), repos: old.repos, ...opt("composition", old.composition) };

const landingOf = (old: OldAgent): PersistedAgent["landing"] => ({
    ...opt(
        "message",
        old.landedSubject === undefined
            ? undefined
            : { subject: old.landedSubject, ...opt("note", old.landedNote), ...opt("breaking", old.landedBreaking) },
    ),
    ...opt("conflicts", old.conflicts),
    ...opt(
        "diff",
        old.diffFiles === undefined && old.diffInsertions === undefined && old.diffDeletions === undefined
            ? undefined
            : { files: old.diffFiles ?? 0, insertions: old.diffInsertions ?? 0, deletions: old.diffDeletions ?? 0 },
    ),
});

// A title with no source ranked as derived in the old build, the lowest rung.
const socialOf = (old: OldAgent): PersistedAgent["social"] => ({
    ...opt(
        "title",
        old.title === undefined ? undefined : { text: old.title, source: old.titleSource ?? "derived", ...opt("action", old.titleAction) },
    ),
    ...opt("owner", old.owner),
    ...opt("landRequested", old.landRequested),
    reactions: old.reactions ?? [],
    ...opt("seenAt", old.seenAt),
});

// Counters an old record never had start where a fresh record's do, at zero.
const totalsOf = (old: OldAgent): PersistedAgent["totals"] => ({
    costUsd: old.costUsd,
    inputTokens: old.inputTokens,
    outputTokens: old.outputTokens,
    turns: old.turns ?? 0,
    toolUses: old.toolUses ?? 0,
    subagents: old.subagents ?? 0,
});

const agentOf = (old: OldAgent): PersistedAgent => ({
    id: old.id,
    placement: placementOf(old),
    identity: {
        ...opt("origin", old.origin),
        ...opt("startedBy", old.startedBy),
        ...opt("areas", old.areas),
        ...opt("startIn", old.startIn),
        ...opt("actsAs", old.actsAs),
        ...opt("forkedFrom", old.forkedFrom),
    },
    profile: {
        provider: old.provider,
        harness: old.harness,
        ...opt("model", old.model),
        ...opt("effort", old.effort),
        ...opt("thinking", old.thinking),
        ...opt("fast", old.fast),
        ...opt("account", old.account),
    },
    ...opt("sessionId", old.sessionId),
    ...opt("compactedTurn", old.compactedTurn),
    ending: endingOf(old),
    ...opt("unfinished", old.unfinished),
    postures: {
        ...opt("autoLand", old.autoLand),
        ...opt("limit", old.limitPolicy),
        ...opt("outage", old.outagePolicy),
        ...opt("stopped", old.stopPolicy),
    },
    landing: landingOf(old),
    social: socialOf(old),
    totals: totalsOf(old),
    createdAt: old.createdAt,
    updatedAt: old.updatedAt,
    ...opt("archivedAt", old.archivedAt),
});

// One element of agents.json: its id when it names a conversation, its record when this build can map it.
interface OldEntry {
    readonly id: string | undefined;
    readonly agent: PersistedAgent | undefined;
}

const IdSchema = z.object({ id: z.string() });

const entryOf = (element: unknown): OldEntry => {
    const id = IdSchema.safeParse(element).data?.id;
    if (id === undefined || !isConversationId(id)) {
        return { id: undefined, agent: undefined };
    }
    const old = OldAgentSchema.safeParse(element);
    return { id, agent: old.success ? PersistedAgentSchema.safeParse(agentOf(old.data)).data : undefined };
};

/* ---- reading the old layout ---- */

const stemsOf = (names: readonly string[], extension: string): string[] =>
    names
        .filter((name) => name.endsWith(extension))
        .flatMap((name) => (isConversationId(name.slice(0, -extension.length)) ? [name.slice(0, -extension.length)] : []));

// A file per entry in a journal directory, named as the old reader required (a conversation-id-shaped stem).
const journalFiles = async (context: StepContext, dir: string): Promise<(string | undefined)[]> =>
    Promise.all(stemsOf(await context.list(dir), ".json").map(async (stem) => context.read(join(dir, `${stem}.json`))));

interface OldJournal {
    readonly turns: ReadonlyMap<string, OldTurn>;
    readonly fires: readonly OldFire[];
}

// One turn per conversation and one fire per automation, as the old writer filed them; a duplicate keeps the first.
const journalOf = async (context: StepContext, dir: string): Promise<OldJournal> => {
    const turns = new Map<string, OldTurn>();
    const fires = new Map<string, OldFire>();
    for (const text of await journalFiles(context, dir)) {
        const entry = parsed(OldJournalEntrySchema, text);
        if (entry?.kind === "turn" && !turns.has(entry.turn.conversationId)) {
            turns.set(entry.turn.conversationId, entry);
        } else if (entry?.kind === "automation" && !fires.has(entry.automationId)) {
            fires.set(entry.automationId, entry);
        }
    }
    return { turns, fires: [...fires.values()] };
};

const watchesOf = async (context: StepContext, dir: string): Promise<ReadonlyMap<string, readonly OldWatch[]>> => {
    const byConversation = new Map<string, OldWatch[]>();
    for (const text of await journalFiles(context, dir)) {
        const watch = parsed(OldWatchSchema, text);
        if (watch !== undefined) {
            byConversation.set(watch.conversationId, [...(byConversation.get(watch.conversationId) ?? []), watch]);
        }
    }
    return byConversation;
};

// Anchor by anchor, so one the old build could not read costs only itself; message indices are the file's integer keys.
const checkpointsOf = (text: string | undefined): ReadonlyMap<string, readonly (readonly [number, OldAnchor])[]> =>
    new Map(
        Object.entries(parsed(OldCheckpointsSchema, text) ?? {}).map(([id, byIndex]) => [
            id,
            Object.entries(byIndex).flatMap(([index, raw]) => {
                const anchor = OldAnchorSchema.safeParse(raw).data;
                return /^\d+$/.test(index) && anchor !== undefined ? [[Number(index), anchor] as const] : [];
            }),
        ]),
    );

/* ---- what conversations.db already holds ---- */

interface Held {
    readonly conversations: ReadonlySet<string>;
    readonly fires: ReadonlySet<string>;
}

const NOTHING_HELD: Held = { conversations: new Set(), fires: new Set() };

const idsIn = (db: DatabaseSync, sql: string): Set<string> =>
    new Set(
        db
            .prepare(sql)
            .all()
            .flatMap(({ id }) => (typeof id === "string" ? [id] : [])),
    );

// Read without writing a byte: with no WAL beside it the file is the whole database, opened immutable so not even a
// sidecar appears; with one, a read-only open that reads the WAL too.
const heldIn = async (context: StepContext, path: string): Promise<Held> => {
    const beside = new Set(await context.list(dirname(path)));
    if (!beside.has(basename(path))) {
        return NOTHING_HELD;
    }
    const location = pathToFileURL(path);
    if (!beside.has(`${basename(path)}-wal`)) {
        location.searchParams.set("immutable", "1");
    }
    let db: DatabaseSync | undefined;
    try {
        db = new DatabaseSync(location, { readOnly: true });
        return { conversations: idsIn(db, "SELECT id FROM conversation"), fires: idsIn(db, "SELECT automation_id AS id FROM fire_journal") };
    } catch {
        // allow(silent-catch): a read-only mount cannot open a live WAL database; counting it as holding nothing plans the
        // import, and the effect checks each row against the database itself
        return NOTHING_HELD;
    } finally {
        db?.close();
    }
};

/* ---- the import ---- */

// A file (or a fenced conversation's session tree) copied into a conversation's directory, only where nothing stands.
interface Copy {
    readonly kind: "transcript" | "prompt" | "sessions";
    readonly from: string;
    readonly to: string;
    // A transcript's converted log, which holds the conversation's record as much as the plain file `to` names: a plain
    // copy beside it would later be converted over it (sessions/record/record-migration.ts), dropping every turn the log
    // gained since.
    readonly log?: string;
}

// Where the conversation may already hold what a copy brings; any one of them present means there is nothing to copy.
const heldAt = ({ to, log }: Copy): readonly string[] => (log === undefined ? [to] : [to, log]);

// One conversation to insert, with every row and file that is its own.
interface Import {
    readonly agent: PersistedAgent;
    readonly checkpoints: readonly (readonly [number, OldAnchor])[];
    readonly turn: OldTurn | undefined;
    readonly watches: readonly OldWatch[];
    readonly copies: readonly Copy[];
}

const occupied = async (path: string): Promise<boolean> => (await stat(path).catch(undefinedIfMissing)) !== undefined;

// Whole or not at all: copied beside the target, then renamed in. A source gone missing is nothing to copy.
const copyInto = async (copy: Copy): Promise<void> => {
    const { kind, from, to } = copy;
    if ((await Promise.all(heldAt(copy).map(occupied))).includes(true)) {
        return;
    }
    const temp = join(dirname(to), `.${basename(to)}.importing`);
    await rm(temp, { recursive: true, force: true });
    await mkdir(dirname(to), { recursive: true });
    try {
        // copyFile and cp stream in the kernel; a transcript runs to tens of megabytes and never passes through memory.
        await (kind === "sessions" ? cp(from, temp, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true }) : copyFile(from, temp));
    } catch (error) {
        if (isMissing(error)) {
            return;
        }
        throw error;
    }
    await rename(temp, to);
};

// Each table's rows in the shape its own store writes them; a checkpoint, watch or fire already there stays as it is.
const rowWriter = (conversations: ConversationsDb) => {
    const agents = sqliteAgentsStore(conversations);
    const journal = turnJournalRows(conversations);
    const { db } = conversations;
    const checkpoint = db.prepare("INSERT INTO checkpoint(conversation_id, message, anchor) VALUES (?, ?, ?) ON CONFLICT DO NOTHING");
    const watch = db.prepare("INSERT INTO watch(id, conversation_id, entry) VALUES (?, ?, ?) ON CONFLICT DO NOTHING");
    const fire = db.prepare(`
        INSERT INTO fire_journal(automation_id, conversation_id, started_at, attempts, payload, origin, title) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING
    `);
    return {
        holds: (id: string): boolean => agents.has(id),
        conversation: ({ agent, checkpoints, turn, watches }: Import): void => {
            agents.save([agent]);
            for (const [message, anchor] of checkpoints) {
                checkpoint.run(agent.id, message, JSON.stringify(anchor));
            }
            if (turn !== undefined) {
                journal.putTurn(turn);
            }
            for (const { id, conversationId, ...entry } of watches) {
                watch.run(id, conversationId, JSON.stringify(entry));
            }
        },
        fire: ({ automationId, conversationId, startedAt, attempts, payload, origin, title }: OldFire): void => {
            fire.run(
                automationId,
                conversationId,
                startedAt,
                attempts,
                payload ?? null,
                origin === undefined ? null : JSON.stringify(origin),
                title ?? null,
            );
        },
    };
};

// The database decides, not the plan: the plan may have been unable to read it. The record goes last, once every row
// and file it vouches for is down, so a crash anywhere before it leaves a re-run that finishes the job.
const importing = (history: string, imports: readonly Import[], fires: readonly OldFire[], record: string) => async (): Promise<void> => {
    const conversations = openConversationsDb(conversationsDbPath(history));
    try {
        const rows = rowWriter(conversations);
        const absent = imports.filter(({ agent }) => !rows.holds(agent.id));
        // Files before rows: a crash between leaves copies a re-run keeps, never a conversation without its transcript.
        for (const { copies } of absent) {
            for (const copy of copies) {
                await copyInto(copy);
            }
        }
        conversations.transaction(() => {
            for (const one of absent.filter(({ agent }) => !rows.holds(agent.id))) {
                rows.conversation(one);
            }
            for (const one of fires) {
                rows.fire(one);
            }
        });
    } finally {
        conversations.db.close();
    }
    await writeTextFile(importRecordPath(history), record);
};

interface OldFiles {
    readonly transcripts: ReadonlySet<string>;
    readonly prompts: ReadonlySet<string>;
}

// The copies a conversation still lacks, read off the old directories' listings and its own directory's.
const copiesOf = async (context: StepContext, id: string, old: OldFiles): Promise<Copy[]> => {
    const history = context.roots.history;
    const own = new Set(await context.list(conversationUnit(history, id)));
    const wanted: (Copy | undefined)[] = [
        // Plain, as the old build wrote it: this build converts every plain record to its log once boot is done.
        old.transcripts.has(id)
            ? {
                  kind: "transcript",
                  from: join(history, OLD.transcripts, `${id}.jsonl`),
                  to: legacyTranscriptFile(history, id),
                  log: transcriptFile(history, id),
              }
            : undefined,
        // Named as prompt-record.ts names it.
        old.prompts.has(id)
            ? { kind: "prompt", from: join(history, OLD.prompts, `${id}.json`), to: join(conversationUnit(history, id), "system-prompt.json") }
            : undefined,
        (await context.list(join(history, OLD.sessions, id))).length > 0
            ? { kind: "sessions", from: join(history, OLD.sessions, id), to: sessionsDir(history, id) }
            : undefined,
    ];
    return wanted.filter((copy): copy is Copy => copy !== undefined && !heldAt(copy).some((path) => own.has(basename(path))));
};

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

// One line per kind of change that happens at all.
const linesOf = (counts: readonly (readonly [number, (count: number) => string])[]): string[] =>
    counts.flatMap(([count, line]) => (count > 0 ? [line(count)] : []));

const recordText = ({ conversations, fires }: ImportRecord): string => {
    const settled = { conversations: [...new Set(conversations)].toSorted(), fires: [...new Set(fires)].toSorted() };
    return `${JSON.stringify(settled, undefined, 2)}\n`;
};

const NOTE = `notes what it settled in ${basename(importRecordPath("/"))}`;

// What the plan decided before reading anything a conversation brings along.
interface Decided {
    readonly toImport: readonly PersistedAgent[];
    readonly fires: readonly OldFire[];
    readonly journal: OldJournal;
    // Lines for what stays as it is: ids the database already holds, records this build cannot map.
    readonly standing: readonly string[];
    readonly record: string;
}

const importPlan = async (context: StepContext, decided: Decided): Promise<StepPlan> => {
    const history = context.roots.history;
    const checkpoints = checkpointsOf(await context.read(join(history, OLD.checkpoints)));
    const watches = await watchesOf(context, join(history, OLD.watches));
    const old: OldFiles = {
        transcripts: new Set(stemsOf(await context.list(join(history, OLD.transcripts)), ".jsonl")),
        prompts: new Set(stemsOf(await context.list(join(history, OLD.prompts)), ".json")),
    };
    const imports: Import[] = [];
    for (const agent of decided.toImport) {
        imports.push({
            agent,
            checkpoints: checkpoints.get(agent.id) ?? [],
            turn: decided.journal.turns.get(agent.id),
            watches: watches.get(agent.id) ?? [],
            copies: await copiesOf(context, agent.id, old),
        });
    }
    const copied = (kind: Copy["kind"]): number => imports.flatMap(({ copies }) => copies).filter((copy) => copy.kind === kind).length;
    const database = conversationsDbPath(history);
    const recordPath = importRecordPath(history);
    return {
        changes: [
            ...linesOf([[imports.length, (count) => `imports ${plural(count, "conversation")} from agents.json`]]),
            ...decided.standing,
            ...linesOf([
                [
                    imports.reduce((sum, one) => sum + one.checkpoints.length, 0),
                    (count) => `imports ${plural(count, "checkpoint")} from turn-checkpoints.json`,
                ],
                [imports.filter(({ turn }) => turn !== undefined).length, (count) => `imports ${plural(count, "turn")} in flight from turns/`],
                [decided.fires.length, (count) => `imports ${plural(count, "automation fire")} in flight from turns/`],
                [imports.reduce((sum, one) => sum + one.watches.length, 0), (count) => `imports ${plural(count, "watch", "watches")} from watches/`],
                [copied("transcript"), (count) => `copies ${plural(count, "transcript")} into conversations/<id>/`],
                [copied("prompt"), (count) => `copies ${plural(count, "system prompt")} into conversations/<id>/`],
                [copied("sessions"), (count) => `copies ${plural(count, "fenced session store")} into conversations/<id>/sessions/`],
            ]),
            NOTE,
        ],
        writes: new Map(),
        // Everything the effect creates or changes, copied aside first (each copy target is absent, so a rollback removes
        // it), so a rolled-back build gets back the volume it knew. The copies are the effect's own rather than the plan's
        // `copies`: renamed in whole, a crash never leaves a short transcript that a re-run would take for a finished one.
        // A transcript's log is among them, since this build converts the plain copy into it once boot is done.
        touches: [database, `${database}-wal`, `${database}-shm`, recordPath, ...imports.flatMap(({ copies }) => copies.flatMap(heldAt))],
        effect: importing(history, imports, decided.fires, decided.record),
    };
};

const plan = async (context: StepContext): Promise<StepPlan | undefined> => {
    const history = context.roots.history;
    const entries = (parsed(z.array(z.unknown()), await context.read(join(history, OLD.agents))) ?? []).map(entryOf);
    const journal = await journalOf(context, join(history, OLD.turns));
    const recordPath = importRecordPath(history);
    const record = parsed(ImportRecordSchema, await context.read(recordPath)) ?? { conversations: [], fires: [] };

    // The first record under an id is the one the old registry answered with.
    const byId = new Map<string, PersistedAgent | undefined>();
    for (const { id, agent } of entries) {
        if (id !== undefined && !byId.has(id)) {
            byId.set(id, agent);
        }
    }
    const settled = new Set(record.conversations);
    const settledFires = new Set(record.fires);
    const unsettled = [...byId].filter(([id]) => !settled.has(id));
    const unsettledFires = journal.fires.filter(({ automationId }) => !settledFires.has(automationId));
    if (unsettled.length === 0 && unsettledFires.length === 0) {
        return undefined;
    }

    const held = await heldIn(context, conversationsDbPath(history));
    const toImport = unsettled.flatMap(([id, agent]) => (agent !== undefined && !held.conversations.has(id) ? [agent] : []));
    const fires = unsettledFires.filter(({ automationId }) => !held.fires.has(automationId));
    const unmapped = unsettled.filter(([id, agent]) => agent === undefined && !held.conversations.has(id)).length;
    const standing = linesOf([
        [
            unsettled.filter(([id]) => held.conversations.has(id)).length,
            (count) => `leaves ${plural(count, "id")} already in conversations.db untouched`,
        ],
        [
            entries.filter(({ id }) => id === undefined).length + unmapped,
            (count) => `skips ${plural(count, "record")} in agents.json this build cannot map`,
        ],
        [unsettledFires.length - fires.length, (count) => `leaves ${plural(count, "automation fire")} already in conversations.db untouched`],
    ]);
    // Every id considered is settled from here on, whatever became of it: imported, already held, or unmappable.
    const next = recordText({
        conversations: [...record.conversations, ...unsettled.map(([id]) => id)],
        fires: [...record.fires, ...unsettledFires.map(({ automationId }) => automationId)],
    });
    // What is left is already in the database (a crash fell between its rows and the record): only the record to write.
    if (toImport.length === 0 && fires.length === 0) {
        return { changes: [...standing, NOTE], writes: new Map([[recordPath, next]]) };
    }
    return importPlan(context, { toImport, fires, journal, standing, record: next });
};

export const pre1308ImportStep = defineStep({
    id: "history-pre-1308-import",
    describe: "imports the conversations, journals and transcripts 1.308 left behind in the layout before it",
    plan,
});
