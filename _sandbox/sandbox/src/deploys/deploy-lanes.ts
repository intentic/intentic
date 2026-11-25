import { randomBytes } from "node:crypto";
import { errorMessage } from "@intentic/base/errors";
import type { ListenerMessage } from "@intentic/sandbox-contract/protocol/doors/listener-protocol";
import type { DeployRecord } from "@intentic/sandbox-contract/schemas/deploys";
import type { Logger } from "pino";
import { opt } from "../opt.js";
import { deployMessageOf } from "./deploy-events.js";
import { type Attempted, attemptDeploy, type RunDeps } from "./deploy-run.js";
import { type DeploysStore, stackKey } from "./deploys-store.js";

// THE ENGINE'S MOVING PARTS (deploys-engine.ts assembles them and says what the whole does): the record book every write
// goes through, the run of one record (its rollback included), and the lanes that run each stack's records one at a
// time.

export interface BookDeps {
    readonly store: DeploysStore;
    // A `deploys` listener message to the owner's automations (automations/listeners.ts).
    readonly dispatch: (message: ListenerMessage) => Promise<void>;
    readonly logger: Pick<Logger, "warn">;
    readonly now: () => number;
}

// Ids that sort in the order they were minted: the time, a counter for the same millisecond, then a few random bytes.
let minted = 0;
export const recordId = (now: number): string => {
    minted = (minted + 1) % 1296;
    return `dep-${now.toString(36).padStart(9, "0")}${minted.toString(36).padStart(2, "0")}-${randomBytes(3).toString("hex")}`;
};

// Every write of a record goes through here: told to the in-process listeners each time, and at its end to the owner's
// automations and to whoever waits on it.
export const createRecordBook = (deps: BookDeps) => {
    const listeners = new Set<(record: DeployRecord) => void>();
    // Told once per record, when the engine is done with it: what `settled` waits on.
    const endings = new Set<(record: DeployRecord) => void>();
    // Records whose handling has not finished: a failed one stays here while its rollback runs.
    const handling = new Set<string>();
    const stamp = (): string => new Date(deps.now()).toISOString();
    const publish = (record: DeployRecord): void => {
        for (const listener of listeners) {
            try {
                listener(record);
            } catch (error) {
                deps.logger.warn({ err: error, id: record.id }, "deploys: a listener failed on a record");
            }
        }
    };
    const settle = (record: DeployRecord): void => {
        for (const ending of endings) {
            ending(record);
        }
    };
    const announce = async (record: DeployRecord): Promise<void> => {
        const message = deployMessageOf(record, new Date(deps.now()));
        if (message !== undefined) {
            await deps.dispatch(message).catch((error: Error) => deps.logger.warn({ err: error, id: record.id }, "deploys: the event could not be dispatched"));
        }
    };
    const write = async (id: string, change: Partial<DeployRecord>): Promise<DeployRecord | undefined> => {
        const record = await deps.store.update(id, (current) => ({ ...current, ...change }));
        if (record !== undefined) {
            publish(record);
        }
        return record;
    };
    // A record's last word: written, told to every listener and automation, and settled.
    const end = async (id: string, change: Partial<DeployRecord>): Promise<DeployRecord | undefined> => {
        const record = await write(id, { ...change, endedAt: stamp() });
        if (record !== undefined) {
            await announce(record);
            settle(record);
        }
        return record;
    };
    const supersededBy =
        (newer: DeployRecord) =>
        (waiting: DeployRecord): DeployRecord => ({
            ...waiting,
            outcome: "superseded",
            endedAt: stamp(),
            error: `A newer deploy (${newer.id}, at ${newer.commit.slice(0, 12)}) replaced it while it waited.`,
        });
    return { store: deps.store, now: deps.now, stamp, listeners, endings, handling, publish, settle, write, end, supersededBy };
};
export type RecordBook = ReturnType<typeof createRecordBook>;

// The newest deploy of the stack that came up, other than `except`.
export const lastGood = async (book: Pick<RecordBook, "store">, repo: string, stack: string, except?: string): Promise<DeployRecord | undefined> =>
    (await book.store.all()).find((record) => record.repo === repo && record.stack === stack && record.outcome === "succeeded" && record.id !== except);

// Puts the stack back on `previous` after `failed` broke it: a record of its own, run in the failed one's lane.
const rollBack = async (book: RecordBook, run: RunDeps, failed: DeployRecord, previous: DeployRecord): Promise<DeployRecord | undefined> => {
    const record: DeployRecord = {
        id: recordId(book.now()),
        repo: failed.repo,
        stack: failed.stack,
        device: previous.device,
        commit: previous.commit,
        ...opt("ref", previous.ref),
        trigger: { kind: "rollback", detail: `after ${failed.id} failed, back to ${previous.id}` },
        outcome: "running",
        queuedAt: book.stamp(),
        startedAt: book.stamp(),
        secretNames: [],
        ...opt("pins", previous.digests),
    };
    await book.store.put(record);
    book.publish(record);
    const tried = await attemptDeploy(run, record, false);
    return book.end(record.id, tried.fields);
};

// Ends a failed attempt: rolled back when the stack asks for it, the machine said it broke, and there is a deploy to go
// back to.
const endFailed = async (book: RecordBook, run: RunDeps, record: DeployRecord, tried: Attempted): Promise<void> => {
    const wants = tried.brokenOnMachine && tried.spec?.onFailure === "rollback" && record.trigger.kind !== "rollback";
    const previous = wants ? await lastGood(book, record.repo, record.stack, record.id) : undefined;
    const said = tried.fields.error ?? "The deploy failed.";
    if (previous === undefined) {
        const nothing = wants ? " Nothing to roll back to: no earlier deploy of this stack from here came up." : "";
        await book.end(record.id, { ...tried.fields, error: `${said}${nothing}` });
        return;
    }
    // Written as failed now, so the board shows it; told once the rollback has ended, as one event.
    await book.write(record.id, { ...tried.fields, endedAt: book.stamp() });
    const back = await rollBack(book, run, record, previous);
    if (back?.outcome === "succeeded") {
        await book.end(record.id, { outcome: "rolled-back", rolledBackTo: previous.id });
        return;
    }
    await book.end(record.id, { error: `${said} Going back to ${previous.commit.slice(0, 12)} (${previous.id}) failed too: see ${back?.id ?? "its record"}.` });
};

// One record, from running to its end.
const executeRecord = async (book: RecordBook, run: RunDeps, record: DeployRecord): Promise<void> => {
    book.handling.add(record.id);
    try {
        const firstHere = (await lastGood(book, record.repo, record.stack)) === undefined;
        const tried = await attemptDeploy(run, record, firstHere).catch(
            (error: Error): Attempted => ({
                fields: { outcome: "failed", error: `The deploy stopped on an error of this sandbox's own: ${errorMessage(error)}` },
                brokenOnMachine: false,
            }),
        );
        if (tried.fields.outcome === "failed") {
            await endFailed(book, run, record, tried);
        } else {
            await book.end(record.id, tried.fields);
        }
    } finally {
        book.handling.delete(record.id);
    }
};

// One lane per stack: its newest waiting record runs, then the lane looks again, until none waits. A record that
// arrives while the lane runs marks it to look once more, so none is left behind between its last look and its end.
export const createLanes = (book: RecordBook, run: RunDeps, logger: Pick<Logger, "warn">) => {
    const lanes = new Set<string>();
    const pending = new Set<string>();
    const state = { stopped: false };
    const drain = async (key: string): Promise<void> => {
        while (!state.stopped) {
            const next = (await book.store.all()).find((record) => record.outcome === "queued" && stackKey(record.repo, record.stack) === key);
            if (next === undefined) {
                return;
            }
            const claimed = await book.store.update(next.id, (record) => (record.outcome === "queued" ? { ...record, outcome: "running", startedAt: book.stamp() } : record));
            if (claimed?.outcome === "running") {
                book.publish(claimed);
                await executeRecord(book, run, claimed);
            }
        }
    };
    const kick = (key: string): void => {
        pending.add(key);
        if (lanes.has(key)) {
            return;
        }
        lanes.add(key);
        void (async () => {
            try {
                while (pending.has(key) && !state.stopped) {
                    pending.delete(key);
                    await drain(key);
                }
            } catch (error) {
                logger.warn({ err: error, stack: key }, "deploys: a stack's lane stopped on an error");
            } finally {
                lanes.delete(key);
            }
        })();
    };
    // What runs now is left to finish or to be found `running` at the next boot; nothing new starts.
    const stop = (): void => {
        state.stopped = true;
    };
    return { kick, stop };
};
