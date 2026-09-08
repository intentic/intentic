import type { ViewBadge } from "@intentic/extension-api";
import { computed, onUnmounted, watch } from "vue";
import { subscribe as watchOtherBoxes, silentBoxes } from "../../sandbox/live/fleetAcross";
import { acrossAttention, listNames, readingAcross, watchRemoteSeen } from "../fleet/fleetScope";
import { useAgents } from "../fleet/useAgents";

// What the agents tile shows, wherever it is drawn (rail tile, phone tab): the attention count follows the board's
// scope, and the cross-sandbox sum exists only while the reader has opted into it, clearing itself as the work is done.

// Blocked, unread, and automation wakes held at the door, everywhere the board is currently reading.
export const agentsAttention = computed<number>(() => useAgents().attention.value + (readingAcross.value ? acrossAttention.value : 0));

// Whether the count spans every sandbox, and whether some didn't answer, said in words since the badge is one digit.
// Undefined while the board is about this box alone.
export const agentsScopeNote = computed<string | undefined>(() => {
    if (!readingAcross.value) {
        return undefined;
    }
    const names = silentBoxes.value.map((box) => box.sandbox.name);
    return names.length === 0
        ? `Counting every sandbox`
        : `Counting every sandbox except ${listNames(names)}, which ${names.length === 1 ? `isn't` : `aren't`} answering`;
});

// The badge shown by every rail tile and tab; the tooltip splits off the count elsewhere since that decides whether to
// open the board or cross to that box.
export const agentsBadge = computed<ViewBadge | undefined>(() => {
    const total = agentsAttention.value;
    if (total <= 0) {
        return undefined;
    }
    const elsewhere = readingAcross.value ? acrossAttention.value : 0;
    const owed = `${total} need${total === 1 ? `s` : ``} you`;
    return { count: total, tooltip: elsewhere > 0 ? `${owed}, ${elsewhere} in other sandboxes` : owed };
});

// Keeps other sandboxes live in fleetAcross while the scope is wide, releasing the moment it narrows. Called once from
// the shared shell so desktop and mobile share one subscription.
export const watchAgentsScope = (): void => {
    // Marks a remote chat read while it's open in front of the user, or it would count toward this number forever.
    watchRemoteSeen();
    let release: (() => void) | undefined;
    const stop = watch(
        readingAcross,
        (across) => {
            if (across) {
                release ??= watchOtherBoxes();
                return;
            }
            release?.();
            release = undefined;
        },
        { immediate: true },
    );
    onUnmounted(() => {
        stop();
        release?.();
        release = undefined;
    });
};
