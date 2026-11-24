import { forkedExec } from "@intentic/base/git";
import { PANE_FORMAT } from "./pane-state.js";

// ONE `tmux list-panes -a` FOR THE DAEMON'S PERIODIC READERS. The runtime sampler (runtime-watch.ts) and the managed
// processes' state poll (managed-processes.ts) each listed every pane on a timer of about two seconds: 2026-11-24, 55 of
// the forker's children a minute. They read the same server, so they read one listing in PANE_FORMAT.
//
// A reader that must see what was just done (the terminals list after a start, an adopt at boot) takes `freshPanes`: a
// listing begun after it asked. A timed reader takes `recentPanes(1000)`: the listing in flight or the last one, if it
// began at most a second ago, so two 2 s timers at any phase share one listing a tick, each at most a second late on
// a change made outside the daemon. A change the daemon makes itself says `panesChanged`, so no listing from before it
// is handed out after it.

// How old a listing a timed reader takes: half of the two timers' period, so at any phase one listing serves both.
export const SHARED_LISTING_MS = 1000;

interface Listing {
    readonly at: number;
    readonly reading: Promise<{ readonly stdout: string }>;
}

type ListPanes = () => Promise<{ readonly stdout: string }>;

export interface PaneListing {
    /** Every pane in PANE_FORMAT, listed after this call: what a reader acting on the answer takes. Rejects as tmux did. */
    readonly fresh: () => Promise<{ readonly stdout: string }>;
    /** A listing begun at most `maxAgeMs` ago, the one in flight or the last one read, else a fresh one. */
    readonly recent: (maxAgeMs: number) => Promise<{ readonly stdout: string }>;
    /** The daemon changed tmux (a session started or ended): no listing begun before now answers a later reader. */
    readonly changed: () => void;
}

export const createPaneListing = (listPanes: ListPanes, now: () => number = Date.now): PaneListing => {
    let last: Listing | undefined;
    let inFlight: Listing | undefined;
    // Moves at every `changed`: a listing begun at an earlier count is never kept to be handed out.
    let changes = 0;

    const list = (): Listing => {
        const begun = changes;
        const listing: Listing = { at: now(), reading: listPanes() };
        inFlight = listing;
        const settled = (): void => {
            if (inFlight === listing) {
                inFlight = undefined;
            }
        };
        // A failed listing (no server, a dead forker) is nothing to share: the next reader asks tmux itself.
        listing.reading.then(
            () => {
                settled();
                if (begun === changes) {
                    last = listing;
                }
            },
            settled,
        );
        return listing;
    };

    return {
        fresh: () => list().reading,
        recent: (maxAgeMs) => {
            const at = now();
            const held = [inFlight, last].find((listing) => listing !== undefined && at - listing.at <= maxAgeMs);
            return (held ?? list()).reading;
        },
        changed: () => {
            changes += 1;
            last = undefined;
            inFlight = undefined;
        },
    };
};

const daemonPanes = createPaneListing(() => forkedExec("tmux", ["list-panes", "-a", "-F", PANE_FORMAT]));
export const freshPanes = daemonPanes.fresh;
export const recentPanes = daemonPanes.recent;
export const panesChanged = daemonPanes.changed;
