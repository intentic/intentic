import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { defineDocument } from "../../../store/evolution/documents.js";
import { openDocument } from "../../../store/open-document.js";

/* ONE CALL, ONE EFFECT, WHEREVER THE ANSWER WAS LOST (2026-11-24). A runner's turn hands `spawn`, `send` and `cancel` to
   its parent (waiting/parent-forward.ts), and a link that drops after the parent acted but before its answer arrived left
   the turn told only to check with wait before spawning again: nothing on the parent knew a second call for the same thing
   from a fresh one, so a retry started a second child, with its own worktree and spend. Each such call now carries an id
   its caller keeps across the retry (the runner's own call id, or a shell's `Idempotency-Key`), and is filed here under
   its conversation, tool and that id with a hash of what it asked. The same key with the same payload answers what the
   first call answered and does nothing again; the same key with another payload is refused; a call this process never
   finished (the daemon restarted under it) is answered by its tool's own recovery (call-receipts.ts). The idea is Orca's
   mutation receipts (src/main/runtime/orchestration/db/mutation-receipts), kept here as one bounded file rather than a
   table. */

const ReceiptSchema = z.object({
    hash: z.string(),
    // `pending` while the call runs; one read pending by a process that holds no live call for it is a previous life's.
    state: z.enum(["pending", "done"]),
    // When the call was first taken, which a recovery reads (a child started at or after it is the call's).
    at: z.number(),
    // What the call answered, replayed to every retry.
    result: z.json().optional(),
});
type Receipt = z.infer<typeof ReceiptSchema>;

export const subagentReceiptsDocument = defineDocument({
    root: "history",
    path: "subagent-receipts.json",
    // What a spawn, send or cancel answered, kept a day so a retry of it is answered rather than acted on again. Only
    // meaningful to the daemon that took the calls: a bundle restored elsewhere starts with none.
    portability: "derived",
    schema: ReceiptSchema,
    granularity: "record",
});

// Long enough for a runner's link to come back and its turn to call again; short enough that the file stays small.
export const RECEIPT_KEPT_MS = 24 * 3_600_000;
// The most receipts on file, the oldest dropped first: a burst of fan-outs cannot grow it without bound.
export const RECEIPTS_KEPT = 1_000;
// An id longer than this is no caller's call id; such a call runs unreceipted.
const REQUEST_ID_MAX = 200;

export interface MutationKey {
    readonly conversationId: string;
    readonly tool: string;
    readonly requestId: string;
}

export type Receipted<T> =
    // Acted on now, for the first time.
    | { readonly kind: "ran"; readonly value: T }
    // Answered from the first call's receipt: nothing was done again.
    | { readonly kind: "replayed"; readonly value: T }
    // Answered by the tool's recovery: the first call was cut off by a restart.
    | { readonly kind: "recovered"; readonly value: T }
    | { readonly kind: "mismatch"; readonly message: string };

/** Whether a caller's id may key a receipt. */
export const usableRequestId = (requestId: string | undefined): requestId is string =>
    requestId !== undefined && requestId.length > 0 && requestId.length <= REQUEST_ID_MAX;

type Json = z.infer<ReturnType<typeof z.json>>;

/** A value as JSON reads it back: what a receipt stores and a payload is hashed as. */
export const toJson = <T>(value: T): Json => z.json().parse(JSON.parse(JSON.stringify(value) ?? "null"));

// Keys sorted at every depth, so two payloads that differ only in key order hash alike.
const canonical = (value: Json): Json => {
    if (Array.isArray(value)) {
        return value.map(canonical);
    }
    if (value === null || !(value instanceof Object)) {
        return value;
    }
    return Object.fromEntries(
        Object.entries(value)
            .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([name, field]) => [name, canonical(field)]),
    );
};

/** A payload's hash: what makes a retry the same call. */
export const payloadHash = (payload: Json): string => createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");

const keyOf = (key: MutationKey): string => `${key.conversationId}\u0000${key.tool}\u0000${key.requestId}`;

const mismatch = (key: MutationKey): Receipted<never> => ({
    kind: "mismatch",
    message:
        `This \`${key.tool}\` call reuses the id of an earlier call that asked for something else, so it was refused and nothing was done. ` +
        "A retry must ask for exactly what the first call asked; a different ask is a new call.",
});

// Within the bounds: nothing older than a day, and the newest RECEIPTS_KEPT.
const bounded = (all: Readonly<Record<string, Receipt>>, now: number): Record<string, Receipt> =>
    Object.fromEntries(
        Object.entries(all)
            .filter(([, receipt]) => now - receipt.at <= RECEIPT_KEPT_MS)
            .toSorted(([, left], [, right]) => right.at - left.at)
            .slice(0, RECEIPTS_KEPT),
    );

export interface MutationReceipts {
    /**
     * Runs `act` once per key: a retry with the same payload is answered with the first call's value, one with another
     * payload is refused, and a call a previous process left pending is answered by `recover` (given when it was taken).
     * A call whose `act` throws leaves no receipt, so its retry acts afresh.
     */
    readonly run: <T>(key: MutationKey, payload: Json, act: () => Promise<T>, recover: (at: number) => Promise<T>) => Promise<Receipted<T>>;
}

interface Live {
    readonly hash: string;
    readonly outcome: Promise<Receipted<unknown>>;
}

// One handle per history root, so every caller shares the calls in flight.
const OPENED = new Map<string, MutationReceipts>();

export const mutationReceipts = (historyRoot: string, logger: Pick<Logger, "warn">, now: () => number = Date.now): MutationReceipts => {
    const known = OPENED.get(historyRoot);
    if (known !== undefined) {
        return known;
    }
    const file = openDocument(subagentReceiptsDocument, join(historyRoot, subagentReceiptsDocument.path), { fallback: () => ({}) });
    // Never throws: a receipt that cannot be written costs the dedupe of one retry, never the call.
    const write = async (key: string, receipt: Receipt | undefined): Promise<void> => {
        try {
            await file.update((all) => {
                const { [key]: _old, ...rest } = all;
                return bounded(receipt === undefined ? rest : { ...rest, [key]: receipt }, now());
            });
        } catch (error) {
            logger.warn({ err: error }, "subagents: a call's receipt could not be written, a retry of it may act again");
        }
    };
    // The calls this process is running, so a retry arriving while the first still runs waits for its answer.
    const live = new Map<string, Live>();
    const settle = async <T>(key: MutationKey, hash: string, act: () => Promise<T>, recover: (at: number) => Promise<T>): Promise<Receipted<T>> => {
        const name = keyOf(key);
        const prior = (await file.read())[name];
        if (prior !== undefined && prior.hash !== hash) {
            return mismatch(key);
        }
        if (prior?.state === "done") {
            // SAFETY: written by this same key's call, whose tool answers T; JSON round-tripped as the tool's own answer.
            return { kind: "replayed", value: prior.result as T };
        }
        if (prior !== undefined) {
            const value = await recover(prior.at);
            await write(name, { hash, state: "done", at: prior.at, result: toJson(value) });
            return { kind: "recovered", value };
        }
        const at = now();
        await write(name, { hash, state: "pending", at });
        let value: T;
        try {
            value = await act();
        } catch (error) {
            await write(name, undefined);
            throw error;
        }
        await write(name, { hash, state: "done", at, result: toJson(value) });
        return { kind: "ran", value };
    };
    const opened: MutationReceipts = {
        run: async (key, payload, act, recover) => {
            const name = keyOf(key);
            const hash = payloadHash(payload);
            const running = live.get(name);
            if (running !== undefined) {
                if (running.hash !== hash) {
                    return mismatch(key);
                }
                const first = await running.outcome;
                // SAFETY: the live call under this key runs the same tool, whose answer is T.
                return (first.kind === "mismatch" ? first : { kind: "replayed", value: first.value }) as Receipted<never>;
            }
            const outcome = settle(key, hash, act, recover);
            live.set(name, { hash, outcome });
            const clear = (): void => {
                if (live.get(name)?.outcome === outcome) {
                    live.delete(name);
                }
            };
            outcome.then(clear, clear);
            return outcome;
        },
    };
    OPENED.set(historyRoot, opened);
    return opened;
};
