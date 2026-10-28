import { sandboxShallowRef } from "@intentic/extension-api";
import { t } from "@intentic/ui/i18n";
import { basename } from "@intentic/ui/path";
import { hold, type NotificationInput } from "../../../workbench/notifications/notifications";

// A long file operation as a file manager's status panel shows one: how far a move, copy, delete or restore of many
// entries has got, a Stop that leaves the rest where they are, and, once it ends, which entries it could not carry, by
// name. Only a gesture of many entries gets a card: a handful lands faster than a card could be read. A clean finish
// retires the card, since the delete's receipt and Mod+Z already say what happened and take it back.

export type OperationKind = `move` | `copy` | `delete` | `restore`;

// How many entries a gesture holds before its progress is worth a card.
export const SHOWN_FROM = 10;
// How often the card hears about progress, at most: a gesture of thousands must not render once per entry.
const PUBLISH_MS = 100;
// Names the card lists of what was not done; the count covers the rest.
const NAMED = 3;

export interface OperationView {
    readonly kind: OperationKind;
    readonly total: number;
    readonly done: number;
    // The entries refused, by path.
    readonly failed: readonly string[];
    readonly stopped: boolean;
    readonly finished: boolean;
    readonly stop: () => void;
}

/** The operation on the card; a sandbox switch drops it with the tree it was about. */
export const fileOperation = sandboxShallowRef<OperationView | undefined>(() => undefined);

export interface OperationTracker {
    // Whether the reader pressed Stop: an entry not yet begun is then left where it is.
    readonly stopped: () => boolean;
    readonly landed: (path: string, ok: boolean) => void;
    readonly end: () => void;
}

const QUIET: OperationTracker = { stopped: () => false, landed: () => undefined, end: () => undefined };

/** Follows a gesture over `total` entries, on a card when it holds enough of them to be worth one. */
export const trackOperation = (kind: OperationKind | undefined, total: number): OperationTracker => {
    if (kind === undefined || total < SHOWN_FROM) {
        return QUIET;
    }
    let done = 0;
    let stopped = false;
    let publishedAt = 0;
    const failed: string[] = [];
    let view: OperationView | undefined;
    const publish = (finished: boolean): void => {
        view = { kind, total, done, failed: [...failed], stopped, finished, stop };
        // A clean finish has nothing left to say; anything short of one stays until it is dismissed.
        fileOperation.value = finished && failed.length === 0 && !stopped ? undefined : view;
        publishedAt = performance.now();
    };
    const stop = (): void => {
        stopped = true;
        publish(false);
    };
    publish(false);
    return {
        stopped: () => stopped,
        landed: (path, ok) => {
            if (ok) {
                done += 1;
            } else {
                failed.push(path);
            }
            if (performance.now() - publishedAt >= PUBLISH_MS) {
                publish(false);
            }
        },
        // Only the operation still on the card is retired: a later one may have taken it over meanwhile.
        end: () => {
            if (fileOperation.value === undefined || fileOperation.value === view) {
                publish(true);
            }
        },
    };
};

// What was not done, by name, the first few and a count of the rest.
const notDone = (failed: readonly string[]): string | undefined => {
    if (failed.length === 0) {
        return undefined;
    }
    const names = failed
        .slice(0, NAMED)
        .map((path) => basename(path))
        .join(`, `);
    const listed = failed.length > NAMED ? t(`workspace.fileOperation.andMore`, { names, count: failed.length - NAMED }) : names;
    return t(`workspace.fileOperation.notDone`, { names: listed });
};

// Literal keys, one per kind, so the catalog check can see every one of them in use.
const runningTitle = (kind: OperationKind, counts: { readonly done: number; readonly total: number }): string => {
    switch (kind) {
        case `move`:
            return t(`workspace.fileOperation.moving`, counts);
        case `copy`:
            return t(`workspace.fileOperation.copying`, counts);
        case `delete`:
            return t(`workspace.fileOperation.deleting`, counts);
        case `restore`:
            return t(`workspace.fileOperation.restoring`, counts);
    }
};
const endedTitle = (kind: OperationKind, counts: { readonly done: number; readonly total: number }): string => {
    switch (kind) {
        case `move`:
            return t(`workspace.fileOperation.moved`, counts);
        case `copy`:
            return t(`workspace.fileOperation.copied`, counts);
        case `delete`:
            return t(`workspace.fileOperation.deleted`, counts);
        case `restore`:
            return t(`workspace.fileOperation.restored`, counts);
    }
};

/** The card for an operation: its progress and Stop while it runs, what it left undone once it ends. */
export const fileOperationNotice = (view: OperationView | undefined, dismiss: () => void): NotificationInput | undefined => {
    if (view === undefined) {
        return undefined;
    }
    const counts = { done: view.done, total: view.total };
    if (!view.finished) {
        return {
            kind: `condition`,
            tone: `info`,
            icon: `spinner`,
            spin: true,
            title: runningTitle(view.kind, counts),
            detail: view.stopped ? t(`workspace.fileOperation.stopping`) : notDone(view.failed),
            actions: view.stopped ? [] : [{ label: t(`ui.action.stop`), run: view.stop }],
        };
    }
    return { kind: `condition`, tone: `warning`, title: endedTitle(view.kind, counts), detail: notDone(view.failed), dismiss };
};

/** Holds the operation card in the notification lane for as long as the page lives. */
export const holdFileOperationNotice = (): (() => void) =>
    hold(`file-operation`, () =>
        fileOperationNotice(fileOperation.value, () => {
            fileOperation.value = undefined;
        }),
    );
