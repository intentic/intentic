import type { Disposable } from "@intentic/extension-api";
import { ref } from "vue";
import { host } from "./host";
import { readNotes } from "./notes";

// Module-owned unseen count, fed by the workspace file-write event (not the view's own query: an unmounted view is
// never observed) with a slow poll as backstop for feeds that can't push. Clears when the reader opens the view, not on
// a timer.
const unseen = ref(0);
let lastSeen = 0;

// Backstop interval, deliberately slow: the file-write event above is the real news.
const POLL_MS = 10 * 60_000;

// Never throws: nothing awaits this call, so a rejection would surface as an unhandled one in an otherwise fine app.
// Runs at activation, before a sandbox may exist; unreachable is a normal first state, resolved on the next tick.
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
    // Try/catch: hosts below api 2.10.0 lack onDidChangeFiles; watching degrades, not failing to start.
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

// Read inside the host's own computed; touching the ref here is what repaints the tile. Pure, no fetch.
export const unseenCount = (): number => unseen.value;

// Called when the view mounts: opening it is the acknowledgement that clears the count.
export const markSeen = (total: number): void => {
    lastSeen = total;
    unseen.value = 0;
};
