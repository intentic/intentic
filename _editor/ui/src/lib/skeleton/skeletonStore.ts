import { shallowRef } from "vue";
import { IMPRINT_VERSION, sameImprint, type SkeletonImprint } from "./skeletonImprint.js";

// The imprints views last left, per scope (the app's scope is the sandbox: two sandboxes' secrets lists are two
// different lengths), then per name. Memory is what a render reads, synchronously, so a placeholder is drawn in its
// remembered form on its first frame; the app hands a persistence underneath (web's IndexedDB) that fills a scope
// before its views mount and takes batched writes at idle. Without one, imprints last as long as the page.

/** Where imprints outlive the page: one record per (scope, name), so a capture writes one record and not a scope's all. */
export interface SkeletonPersistence {
    /** Every imprint held for one scope. */
    readonly load: (scope: string) => Promise<ReadonlyMap<string, SkeletonImprint>>;
    readonly save: (scope: string, imprints: ReadonlyMap<string, SkeletonImprint>) => Promise<void>;
    readonly clear: () => Promise<void>;
}

export interface SkeletonSnapshotOptions {
    /** The current scope, read reactively: a render that reads an imprint re-runs when it changes. */
    readonly scope?: () => string;
    readonly persistence?: SkeletonPersistence;
}

// Writes wait this long for more to join them, then for the page to be idle: a view settling writes once, not per
// resize, and never on a frame the reader is waiting on.
const WRITE_WINDOW_MS = 2_000;
const IDLE_TIMEOUT_MS = 2_000;
// An imprint already held, and unchanged, is rewritten only this often: enough for pruning to see it is still in use.
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;
const UNSCOPED = `default`;

// allow(module-state): one store for the page; each entry is already keyed by its scope
const held = new Map<string, Map<string, SkeletonImprint>>();
// Scopes whose persisted imprints have been asked for, settled or not.
const loads = new Map<string, Promise<void>>();
// Bumped when imprints arrive (from persistence, or taken in this page), so a placeholder already drawn redraws in its
// remembered form.
// allow(module-state): a revision of the page-wide store above, not of one sandbox
const revision = shallowRef(0);
const unsaved = new Map<string, Map<string, SkeletonImprint>>();
let flushing: ReturnType<typeof setTimeout> | undefined;
let scopeOf: () => string = () => UNSCOPED;
let persistence: SkeletonPersistence | undefined;

const idle = (task: () => void): void => {
    if (`requestIdleCallback` in globalThis) {
        requestIdleCallback(() => task(), { timeout: IDLE_TIMEOUT_MS });
        return;
    }
    setTimeout(task, 0);
};

const imprintsOf = (scope: string): Map<string, SkeletonImprint> => {
    let imprints = held.get(scope);
    if (imprints === undefined) {
        imprints = new Map();
        held.set(scope, imprints);
    }
    return imprints;
};

// Stored imprints join what memory holds; one taken in this page already is newer than anything on disk.
const merge = (scope: string, stored: ReadonlyMap<string, SkeletonImprint>): void => {
    const imprints = imprintsOf(scope);
    for (const [name, imprint] of stored) {
        if (imprint.v === IMPRINT_VERSION && !imprints.has(name)) {
            imprints.set(name, imprint);
        }
    }
    revision.value += 1;
};

// A page going away (a reload, a closed tab, a phone backgrounding it) writes what is waiting at once, rather than
// losing every imprint its last two seconds took.
const flushNow = (): void => {
    if (flushing !== undefined) {
        clearTimeout(flushing);
        flush();
    }
};
let listening = false;
const flushOnLeave = (): void => {
    if (listening || !(`document` in globalThis)) {
        return;
    }
    listening = true;
    addEventListener(`pagehide`, flushNow);
    document.addEventListener(`visibilitychange`, () => {
        if (document.visibilityState === `hidden`) {
            flushNow();
        }
    });
};

/** Points the store at the app's scope and its persistence. Called once at boot; a later call replaces both. */
export const configureSkeletonSnapshots = (options: SkeletonSnapshotOptions): void => {
    scopeOf = options.scope ?? (() => UNSCOPED);
    persistence = options.persistence;
    loads.clear();
    if (persistence !== undefined) {
        flushOnLeave();
    }
};

/** The scope an imprint is read and written under right now. */
export const skeletonScope = (): string => scopeOf();

/** Fills one scope from persistence, once; later calls share the first. A failed load leaves views to refill it. */
export const loadImprintScope = (scope: string): Promise<void> => {
    const known = loads.get(scope);
    if (known !== undefined) {
        return known;
    }
    const store = persistence;
    const loading =
        store === undefined
            ? Promise.resolve()
            : store
                  .load(scope)
                  .then((stored) => merge(scope, stored))
                  // allow(silent-catch): an unreadable store only costs this scope its remembered imprints; views refill it.
                  .catch(() => undefined);
    loads.set(scope, loading);
    return loading;
};

/** Hands the store imprints another reader already holds (a sweep over every scope), without asking persistence again. */
export const adoptImprints = (scope: string, stored: ReadonlyMap<string, SkeletonImprint>): void => {
    merge(scope, stored);
    loads.set(scope, Promise.resolve());
};

/** The imprint `name` last left in the current scope. Reactive: on the scope, and on its imprints arriving from disk. */
export const imprintOf = (name: string): SkeletonImprint | undefined => {
    // Read for the dependency alone: a render that found nothing redraws once the scope's imprints land.
    void revision.value;
    const scope = scopeOf();
    void loadImprintScope(scope);
    return held.get(scope)?.get(name);
};

const flush = (): void => {
    flushing = undefined;
    const store = persistence;
    const batches = [...unsaved];
    unsaved.clear();
    if (store === undefined) {
        return;
    }
    for (const [scope, imprints] of batches) {
        // allow(silent-catch): a refused write costs only the next visit's remembered imprint.
        void store.save(scope, imprints).catch(() => undefined);
    }
};

/**
 * Remembers what `name` shows in `scope` now. Memory changes at once; disk follows in one batched write at idle. An
 * unchanged imprint is not rewritten, except now and then so pruning can tell it is still in use.
 */
export const rememberImprint = (scope: string, name: string, imprint: SkeletonImprint): void => {
    const imprints = imprintsOf(scope);
    const previous = imprints.get(name);
    if (previous !== undefined && imprint.at - previous.at < TOUCH_AFTER_MS && sameImprint(previous, imprint)) {
        return;
    }
    imprints.set(name, imprint);
    // A placeholder already on screen for this name (another pane still loading it) redraws in the new form.
    revision.value += 1;
    let pending = unsaved.get(scope);
    if (pending === undefined) {
        pending = new Map();
        unsaved.set(scope, pending);
    }
    pending.set(name, imprint);
    flushing ??= setTimeout(() => idle(flush), WRITE_WINDOW_MS);
};

/** Forgets every imprint, in memory and on disk: the account they were taken for has signed out. */
export const clearImprints = async (): Promise<void> => {
    clearTimeout(flushing);
    flushing = undefined;
    unsaved.clear();
    held.clear();
    loads.clear();
    revision.value += 1;
    await persistence?.clear();
};
