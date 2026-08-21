import type { Disposable } from "@intentic/extension-api";
import { ref } from "vue";
import { host } from "./host";
import { readNotes } from "./notes";

/* THE RAIL BADGE, module state owned by activate(), and the two things it is fed by.
 *
 * Not the view's query: nothing observes an unmounted view, so a badge fed from it could only tell you things
 * while you were already looking at the view that shows them.
 *
 * THE FILE WRITE, because that is where this answer lives. `contributes.files` names the notes file, and the
 * host announces a write to it (`onDidChangeFiles`) as well as invalidating the query key it feeds. The
 * invalidation is what makes an OPEN view live; the announcement is what makes a CLOSED tile react, and without
 * it a badge is only ever as true as its last tick, which for a count the reader can see on screen is how a
 * badge earns itself distrusted.
 *
 * AND A SLOW TIMER BEHIND IT, as a backstop rather than the feed: a watcher can drop an event, and a poll every
 * few minutes costs one read. If your subject is somebody else's API instead of a workspace file, nothing can
 * push and the timer is all you have, so make it the honest cadence of that source.
 *
 * What it counts is notes the reader has not opened the view for since. That clears by acting rather than by
 * waiting, which is the bar the api docs set for spending a permanent slot in the rail. */
const unseen = ref(0);
let lastSeen = 0;

// The backstop's interval, deliberately slow: the write above is what carries the news.
const POLL_MS = 10 * 60_000;

/* Never throws and never rejects. Nothing awaits this, so a failure has no caller to report to, it would land
 * as an unhandled rejection in the console of an app that is otherwise fine. It also runs at ACTIVATION, before
 * the shell has a sandbox at all, so "not reachable yet" is an ordinary first state and the next tick covers it. */
const scan = async (): Promise<void> => {
    try {
        if (!host().sandbox.reachable()) {
            return;
        }
        unseen.value = Math.max(0, (await readNotes()).length - lastSeen);
    } catch {
        unseen.value = 0;
    }
};

export const startBadge = (): Disposable => {
    void scan();
    const timer = setInterval(() => void scan(), POLL_MS);
    /* The notes file being written, which is every way this count can change. Wrapped because an older host has
     * no such channel (it arrived in api 2.10.0, and `engines.intentic` here allows anything from 2.0 up): losing
     * it should cost a slower badge, never a badge that failed to start.
     *
     * In a pack built on the SDK's `sandboxPoll`, this wiring is already inside `start()` and there is nothing
     * to write; it is spelled out here because this file is deliberately the from-scratch shape. */
    let watching: Disposable | undefined;
    try {
        watching = host().workspace.onDidChangeFiles(() => void scan());
    } catch {
        watching = undefined;
    }
    return {
        dispose: () => {
            clearInterval(timer);
            watching?.dispose();
        },
    };
};

// Read inside the host's own computed, so touching the ref here is what repaints the tile. Cheap and pure: it
// derives from state this module already holds and never fetches.
export const unseenCount = (): number => unseen.value;

// Called when the view mounts, opening the view IS the acknowledgement.
export const markSeen = (total: number): void => {
    lastSeen = total;
    unseen.value = 0;
};
