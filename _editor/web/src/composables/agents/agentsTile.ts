import type { ViewBadge } from "@intentic/extension-api";
import { computed, onUnmounted, watch } from "vue";
import { subscribe as watchOtherBoxes, silentBoxes } from "../sandbox/fleetAcross";
import { acrossAttention, listNames, readingAcross, watchRemoteSeen } from "./fleetScope";
import { useAgents } from "./useAgents";

/* WHAT THE AGENTS TILE SAYS, WHEREVER IT IS DRAWN: the desktop rail's tile and the phone's Agents tab, which
 * are two renderings of one claim and used to compute it twice.
 *
 * THE COUNT FOLLOWS THE BOARD'S SCOPE, which is the rule docs/across-sandboxes-design.md §9 set for this badge
 * and the one part of that section that never got wired: `useAgents.attention` counts the streamed box, so a
 * reader with the board on All sandboxes saw a rail badge of 2 open onto a board showing 5, and an agent
 * blocked in another box left the rail silent while the surface it points at had it in the Attention lane. A
 * badge that opens a view where the thing it counted is not visible is worse than no badge, and so is one that
 * stays quiet about the work its own view is about.
 *
 * THE SUM IS ONLY DEFENSIBLE BECAUSE IT IS OPT-IN. §9's objection to a cross-sandbox badge stands: summing four
 * boxes lights the tile permanently and teaches the reader to stop looking. What answers it is that this sum
 * exists only while the reader has set the board wide, for exactly the boxes that board is about, and clears by
 * doing the work it counted. Set back to This sandbox, the badge is the box's own count again, unchanged.
 *
 * SCOPE IS A STATE, NOT A PLACE, and that is why it is said HERE rather than by where the tile sits in the rail.
 * The rail's bands were being read as a scope boundary (ShellDesktop's seam note) because the tile itself was
 * silent about the one scope the product has. The mark and the note below are that silence answered. */

// Blocked, unread, and the automation wakes held at the door, everywhere the board is currently reading.
export const agentsAttention = computed<number>(() => useAgents().attention.value + (readingAcross.value ? acrossAttention.value : 0));

/* THE STANDING FACT ABOUT THE TILE, as opposed to the news in its badge: this count is about every sandbox, and
 * (when it is true) that some of them did not answer.
 *
 * The silence is told in WORDS because the badge is a single digit: `partialAnswer` can put a line under the
 * board's header, but a tile has one number and no way to render "5, plus an unknown amount in Foo". Saying
 * nothing would let the digit read as the whole answer, which is the `live: true` failure this design keeps
 * catching. Undefined while the board is about this box alone, where the tile has always been complete. */
export const agentsScopeNote = computed<string | undefined>(() => {
    if (!readingAcross.value) {
        return undefined;
    }
    const names = silentBoxes.value.map((box) => box.sandbox.name);
    return names.length === 0
        ? `Counting every sandbox`
        : `Counting every sandbox except ${listNames(names)}, which ${names.length === 1 ? `isn't` : `aren't`} answering`;
});

/* The badge itself, in the shape every rail tile and tab uses. The tooltip splits the total when part of it is
 * elsewhere, because that is the number that decides whether the next press is "open the board" or "cross to
 * that box": one sentence, and no second badge. */
export const agentsBadge = computed<ViewBadge | undefined>(() => {
    const total = agentsAttention.value;
    if (total <= 0) {
        return undefined;
    }
    const elsewhere = readingAcross.value ? acrossAttention.value : 0;
    const owed = `${total} need${total === 1 ? `s` : ``} you`;
    return { count: total, tooltip: elsewhere > 0 ? `${owed}, ${elsewhere} in other sandboxes` : owed };
});

/* KEEP THE OTHER BOXES LIVE WHILE THE BADGE IS ABOUT THEM, and not one moment longer.
 *
 * `fleetAcross` is inert until a surface subscribes, and its subscribers were surfaces you have to be LOOKING at
 * (the board, the switcher's popover). A badge is the opposite: its whole job is to be right while you are
 * somewhere else, so the shell holds the subscription for as long as the scope is wide.
 *
 * That store's own rules are what make this affordable rather than a poll per box per minute forever: it reads
 * only while the window is on screen, never wakes a stopped machine, and spaces its reads 45 seconds apart. The
 * cost is one request per other sandbox per interval, and it is the cost of the setting the reader chose.
 *
 * Called once from the shared shell (WorkspaceShell), so the desktop rail and the phone's tab bar are covered by
 * one subscription instead of one each. */
export const watchAgentsScope = (): void => {
    // …and while it is live, the other half of a badge that clears: a remote chat the user is sitting in front
    // of is marked read in its own box, or it would count toward this number for good (fleetScope).
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
