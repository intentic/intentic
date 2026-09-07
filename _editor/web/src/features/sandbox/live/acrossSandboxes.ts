import type { SandboxSummary } from "@intentic/api-contract";
import { computed, type ComputedRef, shallowRef, watch } from "vue";
import { onScreen } from "../../../shell/window/onScreen";
import { useSandbox } from "../client/useSandbox";
import { connectedSandboxes } from "./roster";

/* READING EVERY SANDBOX BUT THE ONE YOU ARE STANDING IN. The machinery under the surfaces that answer a
 * question across boxes — the fleet board's All-sandboxes scope, the changes ledger behind it — with the
 * question itself left to the caller. The rules below are the same for every such surface, they are the
 * expensive part to get right, and they were written out twice before this existed.
 *
 * THE ACTIVE SANDBOX IS DELIBERATELY ABSENT. It has a live `/events` stream and its own store is the
 * authority; including it here would be a second, slower account of the box the user is looking at, arriving
 * late and disagreeing.
 *
 * PULL, NOT STREAM, AND THAT IS THE WHOLE COST MODEL. The daemon's event stream is written for one connection
 * per browser: its watchdog, its backoff, its presence routing and its registry-revision epoch all assume a
 * single line whose failures mean something about the workspace on screen. Opening one per sandbox would
 * multiply every one of those, spend a socket from the origin's pool for each (which the transport already has
 * to ration, see streamBudget), and deliver frames about work nobody is watching. A read every `pollMs` costs
 * one request per sandbox and answers the only question these stores are asked.
 *
 * IT NEVER WAKES A MACHINE. A hosted sandbox stops itself when nobody is around, and the wake reflex in
 * useSandbox fires for the ACTIVE sandbox alone, on purpose. A poll that woke every box the account owns would
 * turn opening a board into a bill, and would defeat idle-stop entirely for anyone with the scope switched on.
 * So a box that does not answer is reported as not answering, its last-known values are kept, and waking it is
 * a press the user makes (which selects it, at which point it stops being this module's business).
 *
 * IT RUNS ONLY WHILE SOMETHING IS WATCHING. `subscribe()` starts the loop and its disposer stops it, reference
 * counted so two windows' worth of surfaces do not each start an interval; and it pauses whenever the window
 * is off screen, because a background tab polling every sandbox the account owns is the same bill as the wake
 * reflex above, arriving more slowly.
 *
 * NEVER ANSWER `0` FOR "DON'T KNOW". `readAt === undefined` is a box that has never told us anything, and it
 * is the state every surface over this must render as unknown rather than as an empty result — the constraint
 * is in the record type so a new store cannot forget it. */
export interface AcrossRecord {
    readonly sandbox: SandboxSummary;
    // When this box last answered, ever. Undefined means nothing here has been true yet.
    readonly readAt: number | undefined;
}

export interface AcrossStore<T extends AcrossRecord> {
    /* Every other sandbox, in the roster's own order, whether or not it has answered yet. A box that has not
     * is present as its `blank`, because a box MISSING from a board reads as a box with no work. */
    readonly entries: ComputedRef<readonly T[]>;
    // Start reading; the returned disposer stops. Idempotent per call, reference counted across calls.
    readonly subscribe: () => () => void;
    /* A caller's own "check now" — a retry press, the seam after an action landed on another box. Bypasses
     * `freshMs`, which is the point of asking, and is a NO-OP when nothing is subscribed, so the "only while
     * watched" rule holds without exception. Callers reach for this from surfaces that may not be on screen. */
    readonly refresh: () => void;
    /* Re-read ONE box now, and wait for it. For the seam after an action changed that box and only that box (a
     * push sent from a ledger row): the others did not change because this one did, and `refresh()` would
     * spend a request on each of them to find that out. Awaitable so the caller can settle its own busy state
     * on the corrected numbers rather than on the ones it just invalidated. */
    readonly readOne: (sandboxId: string) => Promise<void>;
    readonly get: (sandboxId: string) => T | undefined;
    // An optimistic local correction between polls (a card marked seen). The next read is the authority.
    readonly patch: (sandboxId: string, patch: Partial<T> & { readonly sandbox: SandboxSummary }) => void;
}

export interface AcrossOptions<T extends AcrossRecord> {
    readonly pollMs: number;
    // How long an answer stays good enough that a poll tick skips the box. `refresh()` ignores it.
    readonly freshMs: number;
    // A box that has never answered, and the base every patch is applied over.
    readonly blank: (sandbox: SandboxSummary) => T;
    readonly read: (sandbox: SandboxSummary) => Promise<Partial<T>>;
    /* What a box wears WHILE a read of it is out. Optional because most surfaces want nothing: only a box that
     * has never answered should show as busy, or a poll blinks a populated column back into a spinner. */
    readonly reading?: (previous: T | undefined) => Partial<T>;
    /* Every failure is one answer, because there is one useful thing to say. A sleeping hosted machine, a
     * tunnel that is down, a laptop that is closed and a sandbox mid-rebuild are indistinguishable from here
     * and identical in what they mean to a reader: this box is not answering, what you last saw is what there
     * is. Telling them apart would take a platform round trip per box per poll, to change a sentence nobody
     * acts on differently. */
    readonly unreachable: (previous: T | undefined) => Partial<T>;
}

export const createAcrossStore = <T extends AcrossRecord>(options: AcrossOptions<T>): AcrossStore<T> => {
    const boxes = shallowRef<Record<string, T>>({});
    const { sandboxes, activeSandboxId } = useSandbox();

    // The sandboxes these stores read: ones that have checked in at least once (an unfinished sandbox has no
    // daemon to ask, see roster.ts) and are not the one being streamed.
    const targets = computed<readonly SandboxSummary[]>(() =>
        connectedSandboxes(sandboxes.value).filter((sandbox) => sandbox.id !== activeSandboxId.value),
    );

    const write = (id: string, patch: Partial<T> & { readonly sandbox: SandboxSummary }): void => {
        boxes.value = { ...boxes.value, [id]: { ...(boxes.value[id] ?? options.blank(patch.sandbox)), ...patch } };
    };

    // One read per sandbox at a time. A poll tick that lands while the previous one is still out (a slow
    // tunnel, a sandbox under load) must not stack a second request behind it.
    const inFlight = new Set<string>();

    // Is a read worth issuing right now? `force` is a caller's own "check now" and skips the freshness window,
    // never the in-flight guard: two overlapping requests for one box answer the same question twice.
    const dueFor = (sandbox: SandboxSummary, force: boolean): boolean => {
        if (inFlight.has(sandbox.id)) {
            return false;
        }
        const readAt = boxes.value[sandbox.id]?.readAt;
        return force || readAt === undefined || Date.now() - readAt >= options.freshMs;
    };

    const readBox = async (sandbox: SandboxSummary, force: boolean): Promise<void> => {
        if (!dueFor(sandbox, force)) {
            return;
        }
        inFlight.add(sandbox.id);
        const before = options.reading?.(boxes.value[sandbox.id]);
        if (before !== undefined) {
            write(sandbox.id, { ...before, sandbox });
        }
        try {
            write(sandbox.id, { ...(await options.read(sandbox)), sandbox, readAt: Date.now() });
        } catch {
            write(sandbox.id, { ...options.unreachable(boxes.value[sandbox.id]), sandbox });
        } finally {
            inFlight.delete(sandbox.id);
        }
    };

    const readAll = (force: boolean): void => {
        for (const sandbox of targets.value) {
            void readBox(sandbox, force);
        }
    };

    let watchers = 0;
    let timer: ReturnType<typeof setInterval> | undefined;

    const syncLoop = (): void => {
        if (watchers > 0 && onScreen.value) {
            timer ??= setInterval(() => readAll(false), options.pollMs);
            return;
        }
        if (timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
        }
    };

    /* THE WATCHERS ARE PART OF THE SUBSCRIPTION, not of the module.
     *
     * Registered at module scope they would run on IMPORT, and `watch` evaluates its source to take a first
     * reading, so merely importing a store built here — which the switcher does, and the switcher is on every
     * screen — would pull the sandbox list into existence before anything had asked for it. That is the wrong
     * cost and the wrong order: these stores' whole claim is that they do nothing until a surface subscribes.
     *
     * Torn down with the last subscriber, so an app that flips the scope off goes back to holding an inert
     * store rather than two live effects over a list it is not reading. */
    let watching: (() => void)[] = [];

    const startWatching = (): void => {
        watching = [
            // A window coming back to the front reads immediately rather than waiting out the rest of an
            // interval it spent hidden: returning to a board a minute stale is the case a poll defends worst.
            watch(onScreen, (visible) => {
                syncLoop();
                if (visible && watchers > 0) {
                    readAll(true);
                }
            }),
            // The sandbox list changing (one added, one removed, a switch moving a box in or out of `targets`)
            // re-reads whatever is newly in scope. `force: false` is what keeps a switch from re-reading boxes
            // that answered seconds ago: only the box the user just LEFT is genuinely new to the store.
            watch(targets, () => {
                if (watchers > 0) {
                    readAll(false);
                }
            }),
        ];
    };

    return {
        entries: computed<readonly T[]>(() => targets.value.map((sandbox) => boxes.value[sandbox.id] ?? options.blank(sandbox))),
        get: (sandboxId) => boxes.value[sandboxId],
        patch: write,
        readOne: async (sandboxId) => {
            const sandbox = targets.value.find((candidate) => candidate.id === sandboxId);
            if (sandbox !== undefined) {
                await readBox(sandbox, true);
            }
        },
        refresh: () => {
            if (watchers > 0) {
                readAll(true);
            }
        },
        subscribe: () => {
            watchers += 1;
            if (watchers === 1) {
                startWatching();
            }
            syncLoop();
            readAll(false);
            let released = false;
            return () => {
                if (released) {
                    return;
                }
                released = true;
                watchers -= 1;
                if (watchers === 0) {
                    for (const stop of watching) {
                        stop();
                    }
                    watching = [];
                }
                syncLoop();
            };
        },
    };
};
