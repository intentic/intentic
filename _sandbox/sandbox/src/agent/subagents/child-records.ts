import type { SandboxSettings } from "@intentic/sandbox-contract/schemas/settings";
import type { Services } from "../../composition.js";
import type { ConversationActors } from "../../conversations/actor/conversation-actors.js";
import type { Holding } from "../../conversations/actor/conversation-holdings.js";
import { ROSTER, subagentRunning } from "../../conversations/actor/subagent-roster.js";
import { opt } from "../../opt.js";
import { checkResult, type ResultSchema, type ResultValue, turnResult } from "./child-result.js";
import type { ChildRecord } from "./children.js";
import { type SpawnedChild, spawnedChildren, specOnFile } from "./spawned-children.js";
import { markSubagentEndingReported, settleSpawnedChild, type SubagentRecord } from "./subagents.js";

// A spawned child's record as everything beside the child engine reads it (children.ts drives it): where it is held, how
// its endings go out, its file across a restart, the horizon its spent turns re-run within, and the result it handed
// back. Kept apart from the engine so a reader of one of these needs none of the engine's moving parts.

// Where the records and every parent's seats are held: each conversation's actor.
type Actors = Pick<ConversationActors, "holdings">;

// A spawned child's record, held by its parent and filed about the child, so either one's dispose takes it.
export const CHILDREN: Holding<ChildRecord> = { name: "children" };
// A parent's child turns, live and lifetime, held by the parent under its own id.
export const SEATS: Holding<{ readonly live: number; readonly total: number }> = { name: "child seats" };

/** How a child's turn ended, for what follows it beside its parent (a workflow run waiting on its worker). */
export interface ChildSettlement {
    readonly status: "completed" | "failed" | "killed";
    readonly report: string;
    readonly error?: string;
}

// Told of every child turn's ending once its record and row have settled; in this process's memory, like the records.
const SETTLED = new Set<(childId: string, settlement: ChildSettlement) => void>();

/** Hears every spawned child's ending (not a pause, which is still to come); answers how to stop hearing. */
export const onChildSettled = (listener: (childId: string, settlement: ChildSettlement) => void): (() => void) => {
    SETTLED.add(listener);
    return () => void SETTLED.delete(listener);
};

// The one door a child's ending goes through: its roster row settles, a worker's ending counts as handed over (the run
// reads it, not a wait of its parent's), and whoever listens hears it.
export const settleChild = (actors: Pick<ConversationActors, "holdings" | "send">, childId: string, settlement: ChildSettlement): void => {
    settleSpawnedChild(actors, childId, settlement);
    if (actors.holdings(CHILDREN).get(childId)?.spec.run !== undefined) {
        markSubagentEndingReported(actors, childId);
    }
    for (const listener of SETTLED) {
        listener(childId, settlement);
    }
};

/**
 * A spawned child's last ending as its roster row settled it, with its whole closing message; undefined while a turn of
 * it is live (or waits to start), and for an id that names no spawned child.
 */
export const childSettlementOf = (actors: Actors, childId: string): ChildSettlement | undefined => {
    const row = actors.holdings(ROSTER).get(childId);
    if (row === undefined || row.kind !== "spawned" || (row.status !== "completed" && row.status !== "failed" && row.status !== "killed")) {
        return undefined;
    }
    return { status: row.status, report: actors.holdings(CHILDREN).get(childId)?.report ?? row.summary ?? "", ...opt("error", row.error) };
};

/** Whether a child is a workflow run's worker, whose endings its run reads rather than its parent (child-report.ts). */
export const isWorker = (actors: Actors, childId: string): boolean => actors.holdings(CHILDREN).get(childId)?.spec.run !== undefined;

/* HOW FAR OFF A RESET A CHILD WITH FALLBACKS IS STILL WORTH HOLDING FOR. A child's parent waits on it, and was told "do
   not give the task to another agent meanwhile" for a quota that reopened next week (2026-10-17). A child spawned with
   fallbacks keeps this horizon, so it moves to them rather than waiting; any other child waits as long as the owner's
   childRerunHorizonHours says (childRerunHorizonMs below, read by agent/run/frames/classify-failure.ts). */
export const FAR_RERUN_MS = 90 * 60_000;

/**
 * How far off a reset a spawned child's spent turn is still booked to re-run by itself (classify-failure.ts): the owner's
 * horizon, or, for a child spawned with fallbacks, the 90 minutes after which it moves to them rather than wait. Undefined
 * for a conversation nobody spawned.
 */
export const childRerunHorizonMs = (
    actors: Actors,
    conversationId: string | undefined,
    settings: Pick<SandboxSettings, "childRerunHorizonHours">,
): number | undefined => {
    const kid = conversationId === undefined ? undefined : actors.holdings(CHILDREN).get(conversationId);
    if (kid === undefined) {
        return undefined;
    }
    return (kid.spec.fallbacks?.length ?? 0) > 0 ? FAR_RERUN_MS : settings.childRerunHorizonHours * 3_600_000;
};

// What reads and writes a child's file: the history volume, and the log a failed write is said in.
export type KeepDeps = Pick<Services, "conversations" | "config" | "logger">;

export const ledgerOf = (services: Pick<Services, "config" | "logger">): ReturnType<typeof spawnedChildren> =>
    spawnedChildren(services.config.historyRoot, services.logger);

// The ending its roster row settled on, where it has one.
const endingOf = (row: SubagentRecordLike | undefined): SpawnedChild["ending"] => {
    if (row === undefined || subagentRunning(row) || (row.status !== "completed" && row.status !== "failed" && row.status !== "killed")) {
        return undefined;
    }
    const ending: NonNullable<SpawnedChild["ending"]> = { status: row.status, at: row.endedAt ?? row.activityAt };
    if (row.summary !== undefined) {
        ending.summary = row.summary;
    }
    if (row.error !== undefined) {
        ending.error = row.error;
    }
    if (row.verification !== undefined) {
        ending.verification = row.verification;
    }
    return ending;
};

// The roster row fields a child's file carries.
type SubagentRecordLike = Pick<SubagentRecord, "status" | "summary" | "error" | "verification" | "endedAt" | "activityAt">;

// A child as its file states it: its record, and how its roster row last ended.
const childOnFile = (kid: ChildRecord, row: SubagentRecordLike | undefined, now: number): SpawnedChild => {
    const state = kid.paused !== undefined ? "paused" : kid.running ? "running" : "settled";
    const entry: SpawnedChild = {
        parent: kid.parent,
        spec: specOnFile(kid.spec),
        depth: kid.depth,
        cwd: kid.cwd,
        startedAt: kid.startedAt,
        state,
        turns: kid.turns,
        at: now,
    };
    if (kid.sessionId !== undefined) {
        entry.sessionId = kid.sessionId;
    }
    const ending = state === "settled" ? endingOf(row) : undefined;
    if (ending !== undefined) {
        entry.ending = ending;
    }
    if (kid.paused !== undefined) {
        entry.pausedOn = kid.paused.failure;
    }
    if (kid.report !== undefined && kid.report !== "") {
        entry.report = kid.report;
    }
    if (kid.result !== undefined) {
        entry.result = kid.result;
    }
    return entry;
};

/** Writes a child down as it stands now: what the next boot restores it from. Never throws, never waits. */
export const keepChild = (services: KeepDeps, childId: string): void => {
    const kid = services.conversations.holdings(CHILDREN).get(childId);
    if (kid === undefined) {
        return;
    }
    ledgerOf(services).write(childId, childOnFile(kid, services.conversations.holdings(ROSTER).get(childId), Date.now()));
};

/**
 * What a child spawned with a result schema handed back in the turn that ended with this closing message: its tool's value,
 * else a value read off the message, else why there is none. Undefined for a child spawned without one. Read the same way
 * by the report a parent is woken with and by the settle that files it (settleChildTurn), whichever comes first.
 */
export const childTurnResult = (actors: Actors, childId: string, closing: string): ReturnType<typeof turnResult> => {
    const kid = actors.holdings(CHILDREN).get(childId);
    return kid === undefined ? undefined : turnResult(kid.spec.result?.schema, kid.submitted, closing);
};

/** A turn's result in the report's terms: the value written out as JSON, or why there is none. */
export const resultWords = (result: ReturnType<typeof turnResult>): { readonly json: string } | { readonly missing: string } | undefined => {
    if (result === undefined) {
        return undefined;
    }
    return "value" in result ? { json: JSON.stringify(result.value, undefined, 2) } : { missing: result.error };
};

/** Where a child turn's `result` tool hands its value: the schema it takes, and the door that checks and files it. */
export interface ChildResultDoor {
    readonly schema: ResultSchema;
    readonly take: (value: ResultValue) => { readonly value: ResultValue } | { readonly error: string };
}

/**
 * The `result` tool's door for a turn of this conversation, where it is a spawned child its parent gave a result schema;
 * undefined for every other turn. The value it takes is the turn's until the next one starts.
 */
export const childResultDoor = (services: KeepDeps, conversationId: string | undefined): ChildResultDoor | undefined => {
    const kid = conversationId === undefined ? undefined : services.conversations.holdings(CHILDREN).get(conversationId);
    const schema = kid?.spec.result?.schema;
    if (conversationId === undefined || kid === undefined || schema === undefined) {
        return undefined;
    }
    return {
        schema,
        take: (value) => {
            const checked = checkResult(schema, value);
            if ("value" in checked) {
                kid.submitted = checked;
                keepChild(services, conversationId);
            }
            return checked;
        },
    };
};

/** A child's last settled turn's result, for the wait that hands its ending over; undefined for one spawned without a schema. */
export const childResultOf = (actors: Actors, childId: string): ChildRecord["result"] => actors.holdings(CHILDREN).get(childId)?.result;
