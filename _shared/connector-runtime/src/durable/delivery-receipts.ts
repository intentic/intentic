import { mkdir } from "node:fs/promises";
import { readTextIfExists, writeFileAtomic } from "@intentic/base/fs";
import { dirname } from "node:path";
import type { Delivered } from "../gateway.js";
import type { Logger } from "../log.js";

// What the gateway's /deliver posted by reply id (the contract's ListenerDeliver `id`), kept on disk so the daemon's
// outbox can retry a reply whose answer never reached it, a timeout, a restart of either side, without the channel
// seeing it twice: a repeat of an id posted lately answers what the first post answered, and a repeat arriving while
// the first is still posting waits for it. A post that failed keeps nothing, so its retry posts. What is not covered:
// a gateway killed mid-post, between the provider taking the message and this file recording it.

// Far past the daemon's own day of retrying one reply, and enough ids for a busy day.
const KEPT_MS = 2 * 24 * 60 * 60 * 1000;
const KEPT_MAX = 2_000;

interface Receipt {
    readonly at: number;
    readonly delivered: Delivered;
}

export interface DeliveryReceipts {
    // Posts once per id: `post` runs for a new id (or none), and a repeat answers the first post's result.
    readonly once: (id: string | undefined, post: () => Promise<Delivered | void>) => Promise<Delivered | void>;
}

// Read whole from a file only this process writes; anything unreadable is a fresh start, said in the log.
const readReceipts = async (file: string, log: Logger): Promise<Map<string, Receipt>> => {
    const raw = await readTextIfExists(file);
    if (raw === undefined) {
        return new Map();
    }
    try {
        // SAFETY: only `write` below produces this file, as the entries of a Map<string, Receipt>.
        return new Map(JSON.parse(raw) as Array<[string, Receipt]>);
    } catch (error) {
        log.warn({ err: error, file }, "delivery receipts unreadable; starting without them");
        return new Map();
    }
};

export const deliveryReceipts = (file: string, log: Logger, now: () => number = Date.now): DeliveryReceipts => {
    let loaded: Promise<Map<string, Receipt>> | undefined;
    const receipts = (): Promise<Map<string, Receipt>> => (loaded ??= readReceipts(file, log));
    const posting = new Map<string, Promise<Delivered | void>>();
    let writing: Promise<void> = Promise.resolve();
    const write = (kept: Map<string, Receipt>): void => {
        for (const [id, receipt] of kept) {
            if (kept.size <= KEPT_MAX && now() - receipt.at <= KEPT_MS) {
                break;
            }
            kept.delete(id);
        }
        const body = JSON.stringify([...kept]);
        writing = writing
            .then(async () => {
                await mkdir(dirname(file), { recursive: true });
                await writeFileAtomic(file, body);
            })
            .catch((error: Error) => log.warn({ err: error, file }, "delivery receipts could not be written; a retried reply may post twice"));
    };
    return {
        once: async (id, post) => {
            if (id === undefined) {
                return post();
            }
            const inFlight = posting.get(id);
            if (inFlight !== undefined) {
                return inFlight;
            }
            // Registered before anything is awaited, so a repeat arriving meanwhile finds it.
            const attempt = (async (): Promise<Delivered | void> => {
                const kept = await receipts();
                const earlier = kept.get(id);
                if (earlier !== undefined && now() - earlier.at <= KEPT_MS) {
                    log.info({ id }, "a reply already posted was delivered again; answered without posting it twice");
                    return earlier.delivered;
                }
                const delivered = await post();
                kept.set(id, { at: now(), delivered: delivered ?? {} });
                write(kept);
                return delivered;
            })();
            posting.set(id, attempt);
            try {
                return await attempt;
            } finally {
                posting.delete(id);
            }
        },
    };
};
