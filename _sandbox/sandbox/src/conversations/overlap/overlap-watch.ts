import type { Services } from "../../composition.js";
import type { RefListener } from "../../git/remote/ref-watch.js";
import { createDriftWatch, type DriftWatch } from "./branch-drift.js";

// What keeps files in flight and drift current, wired once at boot by the daemon that owns the container
// (bootstrap/change-reactions.ts). Readings follow the moments a branch's unlanded work changes: a turn settling (its
// close committed and measured the branch), a land, and a branch moved by hand while its conversation rests. The drift
// pass follows the line moving and a turn settling, coalesced (branch-drift.ts). Never per edit: a running turn's edits reach the
// index through its edit hook.

// How long after boot the first reading of every live conversation starts: after the boot's own work, like the other
// background sweeps.
const FIRST_READING_DELAY_MS = 60_000;

export type OverlapWatchDeps = Pick<
    Services,
    "agents" | "conversations" | "agentWorktrees" | "transcripts" | "activity" | "turns" | "logger" | "sandboxSettings" | "auth" | "members" | "ownerEmail" | "events" | "inFlight"
>;

// What a start hands back: the stop, and the drift watch it runs, for a suite to pass by hand.
export interface WorkOverlap {
    readonly stop: () => void;
    readonly drift: DriftWatch;
}

/** Starts both; answers the stop. `subscribeRefs` is the ref feed (git/remote/ref-watch.ts subscribeRefChanges). */
export const startWorkOverlap = (deps: OverlapWatchDeps, subscribeRefs: (listener: RefListener) => () => void, firstReadingMs = FIRST_READING_DELAY_MS): WorkOverlap => {
    const { inFlight, conversations } = deps;
    const drift = createDriftWatch(deps);
    // A pass is due whenever a branch's unlanded work may have changed under a line that already moved.
    const reread = (id: string): void => {
        void inFlight.refresh(id).then(() => drift.moved([], undefined));
    };
    const first = setTimeout(() => {
        void inFlight
            .refreshLive()
            .then(() => drift.pass())
            .catch((error: Error) => deps.logger.warn({ err: error }, "files in flight: the first reading did not finish"));
    }, firstReadingMs);
    first.unref?.();
    const stops = [
        deps.events.subscribe("run.settled", ({ conversationId }) => reread(conversationId)),
        deps.events.subscribe("workspace", (event) => {
            if (event.event === "agent.landed") {
                reread(event.agentId);
            }
        }),
        subscribeRefs((repos, moved) => {
            drift.moved(repos, moved);
            // A branch moved by hand (a rebase in its checkout, a discard) while its conversation rests; a running turn's own
            // commits are its settle's to read, and reading them now would drop the edits its hook noted.
            for (const id of moved ?? []) {
                if (!conversations.running(id) && inFlight.holders().includes(id)) {
                    reread(id);
                }
            }
        }),
    ];
    return {
        drift,
        stop: () => {
            clearTimeout(first);
            drift.stop();
            for (const stop of stops) {
                stop();
            }
        },
    };
};
