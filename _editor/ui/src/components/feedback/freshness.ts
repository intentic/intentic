import { hasInjectionContext, inject, type InjectionKey, onScopeDispose } from "vue";

// WHETHER WHAT A PANE SHOWS IS STILL TRUE. A pane draws its reads' last answers at once (the persisted cache, a revisit)
// and asks for newer ones behind them, so most of the time what is on screen is a stored copy waiting to be confirmed.
// Every read with an answer on screen reports here how old that answer is and whether a newer one is on its way, to the
// <FreshnessFrame> around it, which says so for the pane as a whole: one quiet line at its top edge, and the age of what
// is shown once that is worth reading. The views themselves draw nothing for it, so none can forget to.

export interface ReadFreshness {
    /** The read has an answer on screen. A read without one is a wait, which <Await> draws, not a stale answer. */
    readonly shown: boolean;
    /** When the answer on screen was received (epoch ms), when known. */
    readonly updatedAt: number | undefined;
    /** When the newer answer now on its way was asked for; undefined while none is. */
    readonly refreshingSince: number | undefined;
    /** The last try at a newer answer failed, in words; the answer on screen is the one before it. */
    readonly refreshError: string | undefined;
}

interface FreshnessScope {
    readonly join: (read: () => ReadFreshness) => void;
    readonly leave: (read: () => ReadFreshness) => void;
}

export const FRESHNESS_SCOPE: InjectionKey<FreshnessScope> = Symbol(`freshness-scope`);

/**
 * Reports a read to the pane it is read in, for as long as the caller lives. False outside one (a read made from a plain
 * handler, a store, a test), where nothing is listening and the caller need not keep any state for it.
 */
export const reportFreshness = (read: () => ReadFreshness): boolean => {
    if (!hasInjectionContext()) {
        return false;
    }
    const scope = inject(FRESHNESS_SCOPE, undefined);
    if (scope === undefined) {
        return false;
    }
    scope.join(read);
    onScopeDispose(() => scope.leave(read));
    return true;
};
