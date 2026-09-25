import { inject, type InjectionKey, provide, type Ref, shallowRef } from "vue";
import { activeSandboxId } from "../../features/sandbox/overview/activeSandbox";

// WORK IN FLIGHT BEHIND A HUB ROW. A hub mounts one section at a time, so the rebuild started on Environment leaves
// nothing on screen the moment Devices is opened — and these are the runs that take minutes. The ledger is module
// state rather than any component's: the work outlives the section that started it, so the row keeps its mark until
// the work ends, not until the reader clicks away. It says only that something is moving, never what it will do:
// the section itself is where a run is read.

interface HubRun {
    readonly id: number;
    readonly key: string;
    /** A continuation of "Environment: …", like ViewBadge.running, since that is where it ends up. */
    readonly what: string;
    /** The sandbox on screen when the work began: a rebuild runs on that box, and marks that box's row alone. */
    readonly sandboxId: string | undefined;
}

// allow(module-state): work in flight behind a hub row, each run stamped with the sandbox it began on and retired by its own end
const runs = shallowRef<readonly HubRun[]>([]);
let last = 0;

/** `<hub route name>:<section slug>` — the one address a row and the work behind it agree on. */
export const hubWorkKey = (hub: string, slug: string): string => `${hub}:${slug}`;

/** Marks work in flight behind `key` until the returned end is called. Ending twice ends it once. */
export const beginHubWork = (key: string, what: string): (() => void) => {
    last += 1;
    const id = last;
    runs.value = [...runs.value, { id, key, what, sandboxId: activeSandboxId.value }];
    return (): void => {
        runs.value = runs.value.filter((run) => run.id !== id);
    };
};

/** Runs `task` with `key` marked for exactly as long as it takes, however it settles. */
export const trackHubWork = async <T>(key: string, what: string, task: () => Promise<T>): Promise<T> => {
    const end = beginHubWork(key, what);
    try {
        return await task();
    } finally {
        end();
    }
};

/**
 * A row's `ViewBadge.running`: one run speaks for itself, several are counted rather than listed. A row about one
 * sandbox names it, and counts only the work begun on that sandbox.
 */
export const hubWorkRunning = (key: string, sandboxId?: string): string | undefined => {
    const here = runs.value.filter((run) => run.key === key && (sandboxId === undefined || run.sandboxId === sandboxId));
    const first = here[0];
    if (first === undefined) {
        return undefined;
    }
    return here.length === 1 ? first.what : `${here.length} running`;
};

/** Test seam: the ledger is module state, and a leaked ticket would follow one test into the next. */
export const forgetHubWork = (): void => {
    runs.value = [];
};

// The section a view is mounted in, provided by <HubLayout> so no view has to be told its own address. Read at the
// moment work starts, not at setup: the same component can be reused across two sections of one hub.
const HUB_SECTION: InjectionKey<Ref<string>> = Symbol(`hub-section`);

export const provideHubSection = (key: Ref<string>): void => provide(HUB_SECTION, key);

export interface HubWork {
    /** Marks this section until the returned end is called, for work whose end is not a promise settling. */
    readonly begin: (what: string) => () => void;
    /** Marks this section for as long as `task` runs. */
    readonly track: <T>(what: string, task: () => Promise<T>) => Promise<T>;
}

/**
 * Reports this view's long-running work on the hub row that owns it. Outside a hub — the same card rendered on a
 * rail view, a dialog — there is no row to mark and both calls are inert.
 */
export const useHubWork = (): HubWork => {
    const section = inject(HUB_SECTION, undefined);
    return {
        begin: (what) => {
            const key = section?.value;
            return key === undefined ? (): void => {} : beginHubWork(key, what);
        },
        track: async (what, task) => {
            const key = section?.value;
            return key === undefined ? task() : trackHubWork(key, what, task);
        },
    };
};
