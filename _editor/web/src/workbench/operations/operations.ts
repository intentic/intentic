import { type NoticeModel, noticeFrom } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed, type ComputedRef, getCurrentInstance, hasInjectionContext, type MaybeRefOrGetter, onScopeDispose, shallowReactive, toValue, watch } from "vue";
import { activeSandboxId } from "../../lib/activeSandbox";
import { beginHubWork, injectHubSection } from "../hub/hubWork";
import { useNotifications } from "../notifications/notifications";

// WORK THAT OUTLIVES THE VIEW THAT STARTED IT. A press that starts something taking longer than a glance (a container
// built on a laptop, a clone, a land, a migration) hands the server work that runs on whether or not anybody watches.
// Kept in the component, its progress, its log and its outcome die the moment the reader opens another view, and the
// view they come back to says nothing is happening and offers the button again. So the state of that work lives here,
// keyed by WHAT it is about rather than by who drew it, and any view naming the same key reads the same run:
//
//   const runner = useOperation<string, RunnerFailure>(() => `devices/${host}/runner`);
//   runner.run({ what: t(`…adding`, { name }), failed: (error, lines) => runnerFailure(…), task: (op) => createRunner(host, name, op.line) });
//
// The run is stamped with the sandbox it began on, so another sandbox's view never shows it and coming back does;
// work on the account itself goes under `account/` (ACCOUNT_SCOPE), which every sandbox reads alike.
// An outcome is kept until somebody has had it on screen and left: a run that ends while its view is open is read
// there and goes when the view does, as it always did; one that ends while nobody watches raises a receipt with a way
// back, and waits in its view until it has been seen. A view mounted in a hub also marks that hub's row while it runs.

export type OperationState = `running` | `done` | `failed`;

/** The app's own sentence for a failure, or a view's richer shape that carries one. */
export type OperationFailure = NoticeModel | { readonly notice: NoticeModel };

export interface Operation<T = unknown, F extends OperationFailure = NoticeModel, P = string> {
    readonly key: string;
    /** Present tense, as a hub row says it: "Adding runner omen". */
    readonly what: string;
    /** The starter's own word for which of its acts this is, where one subject takes several (a container's verbs). */
    readonly tag: string | undefined;
    readonly state: OperationState;
    /** The work's own output, as it streamed; kept after a failure as the record of how far it got. */
    readonly lines: readonly string[];
    /** Where it is now, for work that reports a step (a line, a stage card) rather than, or beside, a log. */
    readonly progress: P | undefined;
    readonly value: T | undefined;
    readonly failure: F | undefined;
    readonly startedAt: number;
    readonly endedAt: number | undefined;
    /** Start order across the ledger: two runs begun in one millisecond still have a newer one. */
    readonly order: number;
}

interface Entry extends Operation<unknown, OperationFailure, unknown> {
    readonly sandboxId: string | undefined;
    /** Somebody has had the outcome on screen; the last of its views to close takes it away. */
    readonly seen: boolean;
    /** Put away only by hand (RunOptions.keep). */
    readonly kept: boolean;
}

/** What the task is handed to report through, in place of a component's own refs. */
export interface OperationReport<P = string> {
    /** Appends one line of the work's own output. */
    readonly line: (text: string) => void;
    /** Replaces where it is now, or folds the next step into it. */
    readonly progress: (next: P | ((previous: P | undefined) => P)) => void;
    /** The lines heard so far. */
    readonly lines: () => readonly string[];
}

export interface RunOptions<T, F extends OperationFailure, P = string> {
    /** Present tense, for the hub row while it runs and the receipt after: "Adding runner omen". */
    readonly what: string;
    readonly tag?: string;
    /** Where it starts, for progress drawn from the first moment (a stage card on its first step). */
    readonly progress?: P;
    /** The app's sentence for a failure (made a notice with the cause as its detail), or a view's own shape. */
    readonly failed: ((error: unknown, lines: readonly string[]) => F) | (NoticeModel extends F ? string : never);
    readonly task: (report: OperationReport<P>) => Promise<T>;
    /** Past tense, for the receipt raised when it ends unwatched: "Runner omen added". Undefined falls back to `what`. */
    readonly done?: (value: T) => string | undefined;
    /** No receipt: for work whose end shows itself where the reader is anyway (a list row, the chat). */
    readonly quiet?: boolean;
    /**
     * Kept until put away by hand, even once read: for an answer that can never be asked for again (a minted token,
     * recovery codes, a link to pass on), which a reader who looked away to fetch a password manager must still find.
     */
    readonly keep?: boolean;
}

// The most of a run's output kept: a build that prints for an hour must not grow a view's memory for an hour.
const LINES_KEPT = 500;

// Keyed `<sandbox>\0<key>`. Each entry is replaced whole on every change, so a reader tracks the map, not the entry.
// allow(module-state): work in flight and its outcomes, each stamped with the sandbox it began on, outliving every view
const entries = shallowReactive(new Map<string, Entry>());
// How many mounted views watch each scope (a key, and every key under `<key>/`). Not reactive: read only when a run ends.
const watching = new Map<string, number>();
let started = 0;

const SEPARATOR = `\u0000`;
/**
 * The first segment of a key that is the account's rather than a sandbox's (a plan change, an account export): filed
 * once for every sandbox, so billing reached from any of them reads the same move and none of them can start a second.
 */
export const ACCOUNT_SCOPE = `account`;
const ACCOUNT_STAMP = `\u0001${ACCOUNT_SCOPE}`;
const stampOf = (key: string): string | undefined =>
    key === ACCOUNT_SCOPE || key.startsWith(`${ACCOUNT_SCOPE}/`) ? ACCOUNT_STAMP : activeSandboxId.value;
const addressOf = (key: string, sandboxId: string | undefined = stampOf(key)): string => `${sandboxId ?? ``}${SEPARATOR}${key}`;
const within = (scope: string, address: string): boolean => address === scope || address.startsWith(`${scope}/`);
const watched = (address: string): boolean => [...watching.keys()].some((scope) => within(scope, address));

const noticeOf = (failure: OperationFailure): NoticeModel => (`notice` in failure ? failure.notice : failure);

/** The run behind `key` on the sandbox on screen, running or ended and not yet put away. */
export const operationAt = <T = unknown, F extends OperationFailure = NoticeModel, P = string>(key: string): Operation<T, F, P> | undefined =>
    entries.get(addressOf(key)) as Operation<T, F, P> | undefined;

/** Every run under `scope` on the sandbox on screen, oldest first. */
export const operationsUnder = <T = unknown, F extends OperationFailure = NoticeModel, P = string>(scope: string): readonly Operation<T, F, P>[] => {
    const address = addressOf(scope);
    return ([...entries.entries()].filter(([at]) => within(address, at)).map(([, entry]) => entry) as Operation<T, F, P>[]).toSorted(
        (a, b) => a.order - b.order,
    );
};

/** Whether anything under `scope` (the key itself, or any key below `<scope>/`) is running on the sandbox on screen. */
export const operationRunning = (scope: string): boolean => {
    const address = addressOf(scope);
    return [...entries.entries()].some(([at, entry]) => entry.state === `running` && within(address, at));
};

/** Puts an ended run's outcome away. A running one stays: the work has not stopped because a notice was closed. */
export const dismissOperation = (key: string): void => {
    const address = addressOf(key);
    if (entries.get(address)?.state !== `running`) {
        entries.delete(address);
    }
};

interface StartContext {
    /** The hub row to mark while it runs. */
    readonly hub?: string;
    /** Takes the reader back to where it was started, offered on the receipt. */
    readonly back?: () => void;
}

/**
 * Starts `task` under `key` unless a run under that key is already going, in which case it is left alone and this
 * answers undefined. Never throws: a failure is kept as the run's outcome. Answers the ended run.
 */
export const startOperation = async <T, F extends OperationFailure = NoticeModel, P = string>(
    key: string,
    options: RunOptions<T, F, P>,
    context: StartContext = {},
): Promise<Operation<T, F, P> | undefined> => {
    const sandboxId = stampOf(key);
    const address = addressOf(key, sandboxId);
    if (entries.get(address)?.state === `running`) {
        return undefined;
    }
    started += 1;
    let entry: Entry = {
        key,
        what: options.what,
        tag: options.tag,
        state: `running`,
        lines: [],
        progress: options.progress,
        value: undefined,
        failure: undefined,
        startedAt: Date.now(),
        endedAt: undefined,
        order: started,
        sandboxId,
        seen: false,
        kept: options.keep === true,
    };
    entries.set(address, entry);
    // Writes land only while this run is still the one filed there; one put away by a test seam writes nowhere.
    const update = (patch: Partial<Entry>): void => {
        const current = entries.get(address) === entry;
        entry = { ...entry, ...patch };
        if (current) {
            entries.set(address, entry);
        }
    };
    const report: OperationReport<P> = {
        line: (text) => update({ lines: [...entry.lines, text].slice(-LINES_KEPT) }),
        progress: (next) =>
            update({ progress: typeof next === `function` ? (next as (previous: P | undefined) => P)(entry.progress as P | undefined) : next }),
        lines: () => entry.lines,
    };
    const unmark = context.hub === undefined ? undefined : beginHubWork(context.hub, options.what);
    const settle = (patch: Partial<Entry>): Operation<T, F, P> => {
        const seen = watched(address);
        update({ ...patch, endedAt: Date.now(), seen });
        if (!seen && options.quiet !== true) {
            announce(entry, options, context.back);
        }
        return entry as Operation<T, F, P>;
    };
    try {
        const value = await options.task(report);
        return settle({ state: `done`, value });
    } catch (error) {
        const failure = typeof options.failed === `string` ? noticeFrom(error, options.failed) : options.failed(error, entry.lines);
        return settle({ state: `failed`, failure });
    } finally {
        unmark?.();
    }
};

// A receipt for work that ended with nobody watching: the reader learns it ended wherever they are, with a way back.
const announce = <T, F extends OperationFailure, P>(entry: Entry, options: RunOptions<T, F, P>, back: (() => void) | undefined): void => {
    const actions = back === undefined ? undefined : [{ label: t(`shell.operations.show`), run: back }];
    if (entry.state === `failed` && entry.failure !== undefined) {
        const notice = noticeOf(entry.failure);
        useNotifications().report({ tone: `problem`, title: notice.title, detail: notice.detail, actions });
        return;
    }
    const value = entry.value as T;
    const said = typeof value === `string` && value !== `` ? value : undefined;
    const title = options.done?.(value);
    useNotifications().report({
        tone: `done`,
        title: title ?? t(`shell.operations.finished`, { what: entry.what }),
        detail: title === undefined ? said : undefined,
        actions,
    });
};

// A view comes onto the screen over `address`: what already ended there is now seen.
const watch_ = (address: string): void => {
    watching.set(address, (watching.get(address) ?? 0) + 1);
    for (const [at, entry] of entries) {
        if (within(address, at) && entry.state !== `running` && !entry.seen) {
            entries.set(at, { ...entry, seen: true });
        }
    }
};

// A view leaves: once nobody watches a scope, the outcomes read there are put away. Running work stays, unseen ones too.
const unwatch = (address: string): void => {
    const left = (watching.get(address) ?? 1) - 1;
    if (left > 0) {
        watching.set(address, left);
        return;
    }
    watching.delete(address);
    for (const [at, entry] of entries) {
        if (within(address, at) && entry.state !== `running` && entry.seen && !entry.kept && !watched(at)) {
            entries.delete(at);
        }
    }
};

// The app's router as the component's app holds it, read rather than imported: this ledger is workbench and knows no
// route, and an import would bind every suite that stubs vue-router to re-export what this reads. Absent outside an app.
interface Navigator {
    readonly currentRoute: { readonly value: { readonly fullPath: string } };
    readonly push: (to: string) => unknown;
}
const routerOf = (): Navigator | undefined => (getCurrentInstance()?.appContext.config.globalProperties as { $router?: Navigator } | undefined)?.$router;

export interface Operations<T, F extends OperationFailure, P = string> {
    /** The run under `<scope>/<sub>` (or the scope itself), running or ended. */
    readonly at: (sub?: string) => Operation<T, F, P> | undefined;
    /** Every run under the scope, oldest first: the newest is the one a surface with one answer line speaks for. */
    readonly all: ComputedRef<readonly Operation<T, F, P>[]>;
    /** Whether anything under the scope runs: one flow at a time is the usual rule on one subject. */
    readonly busy: ComputedRef<boolean>;
    readonly run: (sub: string | undefined, options: RunOptions<T, F, P>) => Promise<Operation<T, F, P> | undefined>;
    readonly dismiss: (sub?: string) => void;
}

/**
 * A view's door to the work under one scope, for a surface with several subjects (a row per device, a button per
 * container). Watching the scope for as long as the view is mounted is what makes an outcome ended in its absence
 * wait for it, and one read in its presence go with it.
 */
export const useOperations = <T = void, F extends OperationFailure = NoticeModel, P = string>(
    scope: MaybeRefOrGetter<string>,
): Operations<T, F, P> => {
    const hub = hasInjectionContext() ? injectHubSection() : undefined;
    const router = routerOf();
    const keyOf = (sub: string | undefined): string => (sub === undefined ? toValue(scope) : `${toValue(scope)}/${sub}`);

    // Moves with the scope (another device's page reusing this component) and with the sandbox on screen.
    const address = computed(() => addressOf(toValue(scope)));
    watch(
        address,
        (next, previous) => {
            if (previous !== undefined) {
                unwatch(previous);
            }
            watch_(next);
        },
        { immediate: true },
    );
    onScopeDispose(() => unwatch(address.value));

    return {
        at: (sub) => operationAt<T, F, P>(keyOf(sub)),
        all: computed(() => operationsUnder<T, F, P>(toValue(scope))),
        busy: computed(() => operationRunning(toValue(scope))),
        run: (sub, options) => {
            const from = router?.currentRoute.value.fullPath;
            return startOperation(keyOf(sub), options, {
                hub: hub?.value,
                back: router === undefined || from === undefined ? undefined : () => void router.push(from),
            });
        },
        dismiss: (sub) => dismissOperation(keyOf(sub)),
    };
};

export interface OperationView<T, F extends OperationFailure, P = string> {
    readonly operation: ComputedRef<Operation<T, F, P> | undefined>;
    readonly busy: ComputedRef<boolean>;
    readonly lines: ComputedRef<readonly string[]>;
    readonly progress: ComputedRef<P | undefined>;
    readonly failure: ComputedRef<F | undefined>;
    /** The answer of a run that ended well, until it is put away. */
    readonly value: ComputedRef<T | undefined>;
    readonly run: (options: RunOptions<T, F, P>) => Promise<Operation<T, F, P> | undefined>;
    readonly dismiss: () => void;
}

/** A view's door to the one run behind `key`: `useAsyncAction`'s busy-and-notice, kept beyond the view. */
export const useOperation = <T = void, F extends OperationFailure = NoticeModel, P = string>(
    key: MaybeRefOrGetter<string>,
): OperationView<T, F, P> => {
    const family = useOperations<T, F, P>(key);
    const operation = computed(() => family.at());
    return {
        operation,
        busy: computed(() => operation.value?.state === `running`),
        lines: computed(() => operation.value?.lines ?? []),
        progress: computed(() => operation.value?.progress),
        failure: computed(() => operation.value?.failure),
        value: computed(() => (operation.value?.state === `done` ? operation.value.value : undefined)),
        run: (options) => family.run(undefined, options),
        dismiss: () => family.dismiss(),
    };
};

/** Test seam: the ledger is module state, and a run left in it would follow one test into the next. */
export const forgetOperations = (): void => {
    entries.clear();
    watching.clear();
};
