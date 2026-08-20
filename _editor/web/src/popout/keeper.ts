/* The pop-out window's own script, and the ONLY code in a floating panel that runs in that window's realm,
 * everything the panel shows is rendered by the page that opened it (see composables/usePopout.ts for why, and
 * for the liveness contract this serves). That makes the keeper the only party able to speak for the window
 * once the realm behind it dies, so it asks whatever page currently answers on the opener whether anyone is
 * drawing in this window, and acts on the answer:
 *   · `live`   , a panel is being rendered in here (a fresh load takes the window over on the very tick it
 *                 first answers). Nothing to do.
 *   · `waiting`, a live page owns this window but has nothing in it yet: an app still booting, or a panel host
 *                 between mounts. Veil, because an empty window must not read as the app, but keep the window,
 *                 because the page answering at all is proof someone is coming back for it.
 *   · `none`   , nobody drives this window. Veil NOW. It may be a page mid-reload, in which case the veil
 *                 lifts a moment later; what it must never be is a dead panel that still looks like the app.
 *
 * WHEN IT ASKS, which is the whole of what makes those three answers worth anything. The interval is the
 * BACKSTOP, not the mechanism: a window the user is not looking at has its timers throttled to one a second and
 * eventually to one a MINUTE, and a handshake that only rides the clock inherits that delay wholesale — the app
 * docks the panel, this window keeps the last frame it was handed, and the veil that would have given it away
 * is itself something the tick paints (popout/handshake.ts has the report this comes from). So the asking is
 * event-driven first:
 *   · a NUDGE from the app, posted whenever its answer would change, and once when a page loads and goes
 *     looking for the window a reload left floating. This is the fast path and it is immune to throttling.
 *   · the window being LOOKED AT, shown, or focused. The moment the user turns to this window it is correct,
 *     whatever the browser did to its clock while they were away.
 *   · the interval, for the one thing no event can cover: an opener that died without saying so.
 *
 * …and two deadlines, in real time rather than ticks, for the same reason. Nobody answering for ~12s is a
 * window whose app is gone. Being owned but empty for ~60s is a window whose app is there and has nothing for
 * it, a slower boot than any deadline should punish, but not an endless one. Counted in ticks, a throttled
 * window stretched the first of those into an hour; counted in milliseconds, it acts on the first tick it gets
 * however sparse they are. Either way the window closes itself: nothing on this page can be left floating
 * because the app forgot about it.
 *
 * The first ask is immediate rather than a tick in, because the handshake is also how a panel ARRIVES: popping
 * out is window.open on this page plus this question, so opening a window and re-adopting one that outlived a
 * reload are the same path through the opener's store. `window.name`, the target name window.open gave this
 * window, and the key those stores are registered under, survives navigation, so a reload out here reports in
 * as the same panel. */

// The one import, and it has to stay a leaf: this module is the whole of the pop-out page's bundle, and a
// runtime import of the app's own code here would drag the app into a window whose entire point is that it
// holds none. popout/handshake.ts is the shared contract and imports nothing itself.
import { onPopoutNudge, type PopoutAnswer } from "./handshake";

const VEIL_ATTR = `data-intentic-veil`;
const TICK_MS = 200;
// How long nobody may answer before the window gives up on the app: long enough to outlast a slow reload of the
// opener (a cold dev server, a throttled background tab) and short enough that a window whose app is gone does
// not sit around.
const ORPHAN_MS = 12_000;
// How long it may be OWNED but empty before it gives up anyway. A page that answers is alive, so this is not the
// orphan case and must not share its deadline, it is an app still booting, or one whose panel host is between
// mounts, and both legitimately outrun twelve seconds. Bounded all the same: an app that has reached a place
// with no panel in it at all (signed out, no sandbox selected, a viewport that fell to the mobile shell) would
// otherwise leave a veiled window floating for the rest of the day.
const BLANK_MS = 60_000;

// When the current run of unanswered (or answered-but-empty) asks began, cleared by the answer that ends it.
// Wall-clock spans rather than counted ticks, so a window whose interval the browser has throttled to once a
// minute still acts on the first ask it gets rather than a deadline sixty times too long.
let orphanedSince: number | undefined;
let blankSince: number | undefined;

// Covers the panel the moment nobody answers for it, so a frozen picture of the app can never be mistaken for
// the app. Re-created rather than toggled: an adoption re-dresses this document (its body is cleared), and the
// next ask simply puts the veil back if it is still needed.
const veil = (on: boolean): void => {
    const shown = document.querySelector(`[${VEIL_ATTR}]`);
    if (!on) {
        shown?.remove();
        return;
    }
    if (shown !== null) {
        return;
    }
    const element = document.createElement(`div`);
    element.setAttribute(VEIL_ATTR, ``);
    element.textContent = `Reconnecting…`;
    element.style.cssText = `position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;font:500 13px system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.62)`;
    document.body.appendChild(element);
};

// How long a run of unhelpful answers has been going, given the moment it started. `undefined` is no run at all.
const elapsed = (since: number | undefined, now: number): number => (since === undefined ? 0 : now - since);

const ask = (): void => {
    const opener = window.opener as Window | null;
    if (opener === null || opener.closed) {
        window.close();
        return;
    }
    let answer: PopoutAnswer = `none`;
    try {
        // Running the opener's code IS the proof of life, a page mid-reload has no hook yet, and a dead realm
        // has none ever again. Either way the answer is `none` and this window says so.
        answer = opener.__intentic?.adoptPopout(window.name, window) ?? `none`;
    } catch {
        window.close(); // opener navigated cross-origin: its realm is unreachable, nobody can drive us
        return;
    }
    // The veil asks only "is there a panel in here", so `waiting` is veiled exactly like `none`: from the
    // reader's side an empty window is an empty window, whatever the app's reason for it.
    veil(answer !== `live`);
    const now = performance.now();
    orphanedSince = answer === `none` ? (orphanedSince ?? now) : undefined;
    blankSince = answer === `live` ? undefined : (blankSince ?? now);
    if (elapsed(orphanedSince, now) > ORPHAN_MS || elapsed(blankSince, now) > BLANK_MS) {
        window.close();
    }
};

/* THE FAST PATH. The app posts a nudge the moment its answer would change — and, crucially, once on every page
 * load, which is how a window that outlived a reload is picked back up in a millisecond instead of on whatever
 * tick the browser next allows this window. Without it the app's own wait for the window ran out first and the
 * panel went back to its column with the window still standing there. */
onPopoutNudge(window.name, ask);

/* …and the user turning to this window is the other event worth asking on: whatever the browser did to the
 * clock while they were away, the window is correct by the time they have looked at it. `visibilitychange`
 * covers un-minimizing and un-occluding, `pageshow` a restore from the back/forward cache, `focus` a click into
 * a window that was visible all along. */
document.addEventListener(`visibilitychange`, ask);
window.addEventListener(`pageshow`, ask);
window.addEventListener(`focus`, ask);

ask();
setInterval(ask, TICK_MS);
