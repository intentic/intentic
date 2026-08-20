import type { Disposable } from "@intentic/extension-api";
import { ref } from "vue";
import { host } from "./host";
import { readNotes } from "./notes";

/* THE RAIL BADGE, module state owned by activate(), on its own timer, and why it can't be either of the two
 * things that look simpler.
 *
 * Not the view's query: nothing observes an unmounted view, so a badge fed from it could only tell you things
 * while you were already looking at the view that shows them.
 *
 * Not the file-change push either, for the same reason, `contributes.files` invalidates query keys, and
 * invalidation only reaches a query something is watching. The push is what makes an OPEN view live; a timer is
 * what makes a CLOSED tile informative. This extension uses both, which is the honest general shape.
 *
 * What it counts is notes the reader has not opened the view for since. That clears by acting rather than by
 * waiting, which is the bar the api docs set for spending a permanent slot in the rail. */
const unseen = ref(0);
let lastSeen = 0;

// Slow on purpose: this drives a glance, not a workflow. The view's own query serves anyone actually reading.
const POLL_MS = 30_000;

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
    return { dispose: () => clearInterval(timer) };
};

// Read inside the host's own computed, so touching the ref here is what repaints the tile. Cheap and pure: it
// derives from state this module already holds and never fetches.
export const unseenCount = (): number => unseen.value;

// Called when the view mounts, opening the view IS the acknowledgement.
export const markSeen = (total: number): void => {
    lastSeen = total;
    unseen.value = 0;
};
