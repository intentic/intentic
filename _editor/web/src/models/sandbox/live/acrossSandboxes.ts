import { noteUnreachable } from "../../../client/sandbox/reachability";
import type { SandboxSummary } from "@intentic/api-contract";
import { sleep } from "@intentic/base/async";
import { usePoll } from "@intentic/ui/async";
import { computed, type ComputedRef, effectScope, type EffectScope, shallowRef, watch } from "vue";
import { onScreen } from "../../../workbench/window/onScreen";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { sleepOfSandbox } from "../../../client/sandbox/wake/sandboxAnswer";
import { connectedSandboxes } from "./roster";

// Reads every sandbox but the active one (the fleet board's All-sandboxes scope, the changes ledger) by polling,
// never streaming, and never wakes a machine. Runs only while subscribed, paused off-screen, and never reports a
// failed read as `0`: `readAt === undefined` means unknown.
//
// A SLEEPING SANDBOX IS NOT POLLED (2026-10-29). Nothing changes in a stopped sandbox, so its last answer stays true
// until it wakes, and every read of it only failed: a request down a tunnel that is not there, then a list refresh, every
// tick. Once the list says it sleeps (client/sandbox/wake/sandboxAnswer.ts) and its last read here did not answer, the poll leaves it alone
// and asks the platform's list instead, once a tick while any sleeps, and reads it again when the list says it woke.
// A box that comes back into the targets (switched away from) is read whatever the list says, and so is one a caller
// asks for by name (`readOne`, `awaitAnswer`: a Wake press).
export interface AcrossRecord {
    readonly sandbox: SandboxSummary;
    // When this box last answered, ever; undefined means nothing here has been true yet.
    readonly readAt: number | undefined;
    // How its last read here went: true answered, false failed; absent before any, numbers kept from an earlier page
    // (a store's `blank`) included.
    readonly answered?: boolean;
}

export interface AcrossStore<T extends AcrossRecord> {
    // Every other sandbox, whether or not it has answered; a box that hasn't is present as its `blank`.
    readonly entries: ComputedRef<readonly T[]>;
    // Start reading; the returned disposer stops. Idempotent per call, reference counted across calls.
    readonly subscribe: () => () => void;
    // A caller's own "check now"; bypasses `freshMs` and no-ops when nothing is subscribed.
    readonly refresh: () => void;
    // Re-reads and awaits one box, for when only that box changed; cheaper than `refresh()` asking every box. Read even
    // while the list says it sleeps: somebody asked for this one.
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
    // What a box wears while a read is out; only a never-answered box should show as busy.
    readonly reading?: (previous: T | undefined) => Partial<T>;
    // Every failure reads the same: this box isn't answering, what you last saw is what there is.
    readonly unreachable: (previous: T | undefined) => Partial<T>;
}

// After a failed read, the box's placement may have changed (a machine that fell asleep): refresh the cached list, which
// coalesces concurrent readers, and take the row as it now reads.
const withFreshPlacement = async (sandbox: SandboxSummary, list: () => Promise<readonly SandboxSummary[]>, current: () => readonly SandboxSummary[]): Promise<SandboxSummary> => {
    // allow(silent-catch): the placement refresh is best effort; the read's own failure is already written as unreachable
    await Promise.resolve().then(() => list()).catch(() => undefined);
    return current().find((box) => box.id === sandbox.id) ?? sandbox;
};

interface Watched {
    readonly pollMs: number;
    readonly targets: ComputedRef<readonly SandboxSummary[]>;
    readonly resting: (sandbox: SandboxSummary) => boolean;
    readonly tick: () => void;
    readonly readAll: (force: boolean) => void;
    readonly readEntered: (sandbox: SandboxSummary) => Promise<void>;
}

// What a subscribed store watches, inside its own effect scope.
const watchAcross = ({ pollMs, targets, resting, tick, readAll, readEntered }: Watched): void => {
    // The clock, paused off-screen; a tick never waits for a slow box, which readBox's in-flight guard keeps from stacking.
    usePoll({ everyMs: pollMs, immediate: false, visible: onScreen, check: tick }).start();
    // A window regaining focus reads every box now rather than waiting out the rest of a hidden interval.
    watch(onScreen, (visible) => {
        if (visible) {
            readAll(true);
        }
    });
    // Re-reads whatever newly enters `targets`, sleeping or not: one switched away from was just in use, and the list may
    // not have heard it woke. `force: false` skips boxes that answered seconds ago.
    watch(
        () => targets.value.map((box) => box.id),
        (_now, before) => {
            const known = new Set(before);
            for (const sandbox of targets.value.filter((box) => !known.has(box.id))) {
                void readEntered(sandbox);
            }
            readAll(false);
        },
    );
    // A sleeper the list now says woke is read at once rather than at the next tick.
    watch(() => targets.value.filter(resting).map((box) => box.id).join(`,`), () => readAll(false));
};

// Reads one box every `everyMs` until it answers or `withinMs` has passed: a sandbox just asked to wake. True once it
// answered; false for one that did not in time, or is no longer one the store reads.
export const awaitAnswer = async <T extends AcrossRecord>(
    store: Pick<AcrossStore<T>, `readOne` | `get`>,
    sandboxId: string,
    { everyMs, withinMs }: { readonly everyMs: number; readonly withinMs: number },
): Promise<boolean> => {
    const until = Date.now() + withinMs;
    for (;;) {
        await store.readOne(sandboxId);
        if (store.get(sandboxId)?.answered === true) {
            return true;
        }
        if (Date.now() + everyMs > until) {
            return false;
        }
        await sleep(everyMs);
    }
};

export const createAcrossStore = <T extends AcrossRecord>(options: AcrossOptions<T>): AcrossStore<T> => {
    const boxes = shallowRef<Record<string, T>>({});
    const { sandboxes, activeSandboxId, list } = useSandbox();
    // allow(silent-catch): the list is best effort here; a sleeper whose wake it would have shown is read on the next tick
    const relist = (): void => void Promise.resolve().then(() => list()).catch(() => undefined);

    // The sandboxes these stores read: ones that have checked in, excluding the one being streamed.
    const targets = computed<readonly SandboxSummary[]>(() =>
        connectedSandboxes(sandboxes.value).filter((sandbox) => sandbox.id !== activeSandboxId.value),
    );

    const write = (id: string, patch: Partial<T> & { readonly sandbox: SandboxSummary }): void => {
        boxes.value = { ...boxes.value, [id]: { ...(boxes.value[id] ?? options.blank(patch.sandbox)), ...patch } };
    };

    // One read per sandbox at a time; a poll tick landing mid-read must not stack a second request.
    const inFlight = new Set<string>();

    // Left alone while the list says it sleeps, unless it answered here since (the list is the older word then).
    const resting = (sandbox: SandboxSummary): boolean => sleepOfSandbox(sandbox) !== undefined && boxes.value[sandbox.id]?.answered !== true;

    // `force` skips the freshness window but never the in-flight guard: two overlapping reads answer nothing new.
    // `asked` (a caller naming the box, or the box coming back into view) reads a sleeper too.
    const dueFor = (sandbox: SandboxSummary, force: boolean, asked: boolean): boolean => {
        if (inFlight.has(sandbox.id) || (!asked && resting(sandbox))) {
            return false;
        }
        const readAt = boxes.value[sandbox.id]?.readAt;
        return force || readAt === undefined || Date.now() - readAt >= options.freshMs;
    };

    const readBox = async (sandbox: SandboxSummary, force: boolean, asked = false): Promise<void> => {
        if (!dueFor(sandbox, force, asked)) {
            return;
        }
        inFlight.add(sandbox.id);
        const before = options.reading?.(boxes.value[sandbox.id]);
        if (before !== undefined) {
            write(sandbox.id, { ...before, sandbox });
        }
        try {
            write(sandbox.id, { ...(await options.read(sandbox)), sandbox, readAt: Date.now(), answered: true });
        } catch {
            write(sandbox.id, { ...options.unreachable(boxes.value[sandbox.id]), sandbox, answered: false });
            sandbox = await withFreshPlacement(sandbox, list, () => sandboxes.value);
            noteUnreachable(sandbox);
            write(sandbox.id, { ...options.unreachable(boxes.value[sandbox.id]), sandbox, answered: false });
        } finally {
            inFlight.delete(sandbox.id);
        }
    };

    const readAll = (force: boolean): void => {
        for (const sandbox of targets.value) {
            void readBox(sandbox, force);
        }
    };

    // A tick: every box due, and the list once while any sleeps, which is how a sleeper's wake reaches this store.
    const tick = (): void => {
        readAll(false);
        if (targets.value.some(resting)) {
            relist();
        }
    };

    let watchers = 0;
    // Registered per subscription, so merely importing this store starts nothing; stopping the scope ends it all.
    let watching: EffectScope | undefined;

    const startWatching = (): void => {
        watching = effectScope(true);
        watching.run(() => watchAcross({ pollMs: options.pollMs, targets, resting, tick, readAll, readEntered: (sandbox) => readBox(sandbox, false, true) }));
    };

    return {
        entries: computed<readonly T[]>(() => targets.value.map((sandbox) => ({ ...(boxes.value[sandbox.id] ?? options.blank(sandbox)), sandbox }))),
        get: (sandboxId) => boxes.value[sandboxId],
        patch: write,
        readOne: async (sandboxId) => {
            const sandbox = targets.value.find((candidate) => candidate.id === sandboxId);
            if (sandbox !== undefined) {
                await readBox(sandbox, true, true);
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
            readAll(false);
            let released = false;
            return () => {
                if (released) {
                    return;
                }
                released = true;
                watchers -= 1;
                if (watchers === 0) {
                    watching?.stop();
                    watching = undefined;
                }
            };
        },
    };
};
