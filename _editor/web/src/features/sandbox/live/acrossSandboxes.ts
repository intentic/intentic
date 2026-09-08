import type { SandboxSummary } from "@intentic/api-contract";
import { computed, type ComputedRef, shallowRef, watch } from "vue";
import { onScreen } from "../../../shell/window/onScreen";
import { useSandbox } from "../client/useSandbox";
import { connectedSandboxes } from "./roster";

// Reads every sandbox but the active one (the fleet board's All-sandboxes scope, the changes ledger) by polling,
// never streaming, and never wakes a machine. Runs only while subscribed, paused off-screen, and never reports a
// failed read as `0`: `readAt === undefined` means unknown.
export interface AcrossRecord {
    readonly sandbox: SandboxSummary;
    // When this box last answered, ever; undefined means nothing here has been true yet.
    readonly readAt: number | undefined;
}

export interface AcrossStore<T extends AcrossRecord> {
    // Every other sandbox, whether or not it has answered; a box that hasn't is present as its `blank`.
    readonly entries: ComputedRef<readonly T[]>;
    // Start reading; the returned disposer stops. Idempotent per call, reference counted across calls.
    readonly subscribe: () => () => void;
    // A caller's own "check now"; bypasses `freshMs` and no-ops when nothing is subscribed.
    readonly refresh: () => void;
    // Re-reads and awaits one box, for when only that box changed; cheaper than `refresh()` asking every box.
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

export const createAcrossStore = <T extends AcrossRecord>(options: AcrossOptions<T>): AcrossStore<T> => {
    const boxes = shallowRef<Record<string, T>>({});
    const { sandboxes, activeSandboxId } = useSandbox();

    // The sandboxes these stores read: ones that have checked in, excluding the one being streamed.
    const targets = computed<readonly SandboxSummary[]>(() =>
        connectedSandboxes(sandboxes.value).filter((sandbox) => sandbox.id !== activeSandboxId.value),
    );

    const write = (id: string, patch: Partial<T> & { readonly sandbox: SandboxSummary }): void => {
        boxes.value = { ...boxes.value, [id]: { ...(boxes.value[id] ?? options.blank(patch.sandbox)), ...patch } };
    };

    // One read per sandbox at a time; a poll tick landing mid-read must not stack a second request.
    const inFlight = new Set<string>();

    // `force` skips the freshness window but never the in-flight guard: two overlapping reads answer nothing new.
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

    // Registered per subscription, not at module scope, so merely importing this store starts nothing.
    let watching: (() => void)[] = [];

    const startWatching = (): void => {
        watching = [
            // A window regaining focus reads immediately rather than waiting out the rest of a hidden interval.
            watch(onScreen, (visible) => {
                syncLoop();
                if (visible && watchers > 0) {
                    readAll(true);
                }
            }),
            // Re-reads whatever newly enters `targets`; `force: false` skips boxes that answered seconds ago.
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
