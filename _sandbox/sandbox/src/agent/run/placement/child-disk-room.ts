import type { Services } from "../../../composition.js";
import { ROSTER } from "../../../conversations/actor/subagent-roster.js";
import { CheckoutSpaceRefused } from "../../../system/resources/storage/checkout-space.js";

/** Keep a child queued for the same horizon as the memory room line. */
const DISK_ROOM_CEILING_MS = 6 * 60 * 60_000;
const RETRY_MS = 30_000;

interface Waiting {
    readonly childId: string;
    readonly since: number;
}

const LINE: Waiting[] = [];
const STOPS = new Map<string, AbortController>();
const ordinal = (position: number): string => ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"][position - 1] ?? `number ${position}`;
const clock = (at: number): string => new Date(at).toISOString().slice(11, 16);

const note = (services: Pick<Services, "conversations">, childId: string, status: "pending" | "running", summary: string): void => {
    const row = services.conversations.holdings(ROSTER).get(childId);
    if (row === undefined || row.kind !== "spawned") {
        return;
    }
    row.status = status;
    row.summary = summary;
    row.activityAt = Date.now();
    void services.conversations.send(row.conversationId, {
        kind: "frame",
        frame: { kind: "subagent_update", id: childId, status, summary },
    });
};

const renote = (services: Pick<Services, "conversations">): void => {
    for (const [index, waiting] of LINE.entries()) {
        const place = LINE.length > 1 ? `, ${ordinal(index + 1)} of ${LINE.length} subagents waiting for room` : "";
        note(
            services,
            waiting.childId,
            "pending",
            `Waiting for disk space since ${clock(waiting.since)} UTC${place}: the checkout does not fit on the history volume. It starts by itself when space is available (it gives up after 6 hours).`,
        );
    }
};

const leave = (services: Pick<Services, "conversations">, childId: string): void => {
    const index = LINE.findIndex((waiting) => waiting.childId === childId);
    if (index >= 0) {
        LINE.splice(index, 1);
        renote(services);
    }
};

const firstInLine = (childId: string): boolean => LINE[0]?.childId === childId;

/** Stops a child waiting for checkout space, so cancellation does not wait for another retry. */
export const stopChildDiskRoomWait = (childId: string): void => STOPS.get(childId)?.abort();

const pause = (signal: AbortSignal, ms: number): Promise<void> =>
    new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new DOMException("The child start was cancelled.", "AbortError"));
            return;
        }
        const timer = setTimeout(done, ms);
        const abort = (): void => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            reject(new DOMException("The child start was cancelled.", "AbortError"));
        };
        function done(): void {
            signal.removeEventListener("abort", abort);
            resolve();
        }
        signal.addEventListener("abort", abort, { once: true });
    });

const attemptCompose = async <T>(compose: () => Promise<T>): Promise<{ readonly value: T } | { readonly refusal: CheckoutSpaceRefused }> => {
    try {
        return { value: await compose() };
    } catch (error) {
        if (error instanceof CheckoutSpaceRefused) {
            return { refusal: error };
        }
        throw error;
    }
};

const waitForRoom = async (
    services: Pick<Services, "conversations">,
    childId: string,
    signal: AbortSignal,
    began: number,
    refusal: CheckoutSpaceRefused,
    waiting: boolean,
    now: () => number,
    retryMs: number,
): Promise<void> => {
    if (now() - began >= DISK_ROOM_CEILING_MS) {
        throw new Error(`Not started: waited 6 hours for disk space and the checkout still did not fit. ${refusal.message}`, { cause: refusal });
    }
    if (!waiting) {
        LINE.push({ childId, since: now() });
        renote(services);
    }
    await pause(signal, retryMs);
};

/** Retries a spawned child's disk-space refusal before its model gets a turn. */
export const composeWithChildDiskRoom = async <T>(
    services: Pick<Services, "conversations">,
    childId: string,
    signal: AbortSignal | undefined,
    compose: () => Promise<T>,
    options: { readonly retryMs?: number; readonly now?: () => number } = {},
): Promise<T> => {
    const row = services.conversations.holdings(ROSTER).get(childId);
    if (row?.kind !== "spawned") {
        return compose();
    }
    const stop = new AbortController();
    const externalAbort = (): void => stop.abort();
    signal?.addEventListener("abort", externalAbort, { once: true });
    STOPS.set(childId, stop);
    let waiting = false;
    const now = options.now ?? Date.now;
    const retryMs = options.retryMs ?? RETRY_MS;
    const began = now();
    try {
        for (;;) {
            if (stop.signal.aborted) {
                throw new DOMException("The child start was cancelled.", "AbortError");
            }
            if (waiting && !firstInLine(childId)) {
                await pause(stop.signal, retryMs);
                continue;
            }
            const attempt = await attemptCompose(compose);
            if ("value" in attempt) {
                if (waiting) {
                    note(services, childId, "running", "");
                }
                return attempt.value;
            }
            await waitForRoom(services, childId, stop.signal, began, attempt.refusal, waiting, now, retryMs);
            waiting = true;
        }
    } finally {
        signal?.removeEventListener("abort", externalAbort);
        if (STOPS.get(childId) === stop) {
            STOPS.delete(childId);
        }
        leave(services, childId);
    }
};

export const resetChildDiskRoomLineForTest = (): void => {
    LINE.length = 0;
    STOPS.clear();
};
