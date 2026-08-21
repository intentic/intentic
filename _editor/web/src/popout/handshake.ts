/* WHAT A FLOATING PANEL'S WINDOW AND THE PAGE DRAWING IN IT AGREE ON: the two halves live in different realms
 * (composables/usePopout.ts opens the window and renders into it, popout/keeper.ts runs inside it), so the
 * contract between them lives here rather than in either. A leaf module with no imports of its own, deliberately:
 * the pop-out page's whole bundle is the keeper, and anything the keeper reaches for is dragged into a window
 * whose entire point is that it holds no app.
 *
 * WHY A CHANNEL AND NOT JUST THE TICK. The window's liveness question used to be asked on a timer alone, and a
 * timer is the one thing a browser is free to take away: a window that is not on screen, behind another, on a
 * monitor that has gone to sleep, minimized: has its intervals throttled to one a second, and after a few
 * minutes of that to one a MINUTE. Both sides counted their deadlines in those ticks, so the handshake that
 * settles in 200ms on a visible window took up to an hour on a hidden one. Meanwhile the app, which gave up
 * waiting on a fixed two-and-a-half-second countdown of its own, had already put the panel back in its column.
 * That gap is the "docked chat in the column AND a chat floating on the other screen" report, and the floating
 * one was a photograph: not even veiled, because painting the veil is itself something the tick does.
 *
 * So the tick is the BACKSTOP now and this is the fast path. Either side posts a nudge, the other answers on the
 * spot: a message is delivered as a task rather than fired by a clock, so throttling does not touch it, and
 * "wait for the window to answer" stops meaning "wait out a countdown and hope". */

/** What a pop-out window is told when its keeper asks whether anyone is driving it (composables/usePopout.ts
 *  holds the three-value contract and why it has three). */
export type PopoutAnswer = `live` | `waiting` | `none`;

// Same-origin, which is also the boundary of "the same app": the scope a BroadcastChannel already has.
const CHANNEL = `intentic.popout`;

/** "Report in, now": carries only the panel whose window is being asked, so a window answers for its own name
 *  and ignores the rest (two app windows can each have a chat floating, and each obeys only its own opener). */
interface Nudge {
    readonly panel: string;
}

/* One channel per realm, from the first import. Guarded like the summons channel: a runtime without
 * BroadcastChannel simply leaves the tick on its own, which is the behaviour this replaces rather than breaks. */
const channel = typeof BroadcastChannel === `undefined` ? undefined : new BroadcastChannel(CHANNEL);

/** Ask whatever window holds this panel to re-ask its opener right now. Posted by the page that draws the panel
 *  whenever its own answer would change: the panel arriving, its host leaving, a deliberate dock, and once at
 *  load, which is the roll-call a page reload comes back through. */
export const nudgePopout = (panel: string): void => {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel, not window: this postMessage takes no targetOrigin
    channel?.postMessage({ panel } satisfies Nudge);
};

/** The window's half: answer every nudge addressed to this panel. A BroadcastChannel never delivers to its own
 *  poster, so this only ever hears the app's side. */
export const onPopoutNudge = (panel: string, reply: () => void): void => {
    channel?.addEventListener(`message`, (event: MessageEvent<Nudge>) => {
        if (event.data?.panel === panel) {
            reply();
        }
    });
};
