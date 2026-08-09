/* The pop-out window's own script, and the ONLY code in a floating panel that runs in that window's realm —
 * everything the panel shows is rendered by the page that opened it (see composables/usePopout.ts for why, and
 * for the liveness contract this serves). That makes the keeper the only party able to speak for the window
 * once the realm behind it dies, so every tick it asks whatever page currently answers on the opener whether
 * anyone is drawing in this window, and acts on the answer:
 *   · `live`    — a panel is being rendered in here (a fresh load takes the window over on the very tick it
 *                 first answers). Nothing to do.
 *   · `waiting` — a live page owns this window but has nothing in it yet: an app still booting, or a panel host
 *                 between mounts. Veil, because an empty window must not read as the app — but keep the window,
 *                 because the page answering at all is proof someone is coming back for it.
 *   · `none`    — nobody drives this window. Veil NOW. It may be a page mid-reload, in which case the veil
 *                 lifts a few ticks later; what it must never be is a dead panel that still looks like the app.
 *
 * …and two deadlines, because the two ways of being empty are not equally hopeful. Nobody answering for ~12s is
 * a window whose app is gone. Being owned but empty for ~60s is a window whose app is there and has nothing for
 * it — a slower boot than any deadline should punish, but not an endless one. Either way the window closes
 * itself: nothing on this page can be left floating because the app forgot about it.
 *
 * The first ask is immediate rather than a tick in, because the handshake is also how a panel ARRIVES: popping
 * out is window.open on this page plus this question, so opening a window and re-adopting one that outlived a
 * reload are the same path through the opener's store. `window.name` — the target name window.open gave this
 * window, and the key those stores are registered under — survives navigation, so a reload out here reports in
 * as the same panel. */

// Type-only, and it has to stay that way: this module is the whole of the pop-out page's bundle, and a runtime
// import of the app's own code here would drag the app into a window whose entire point is that it holds none.
import type { PopoutAnswer } from "../composables/usePopout";

const VEIL_ATTR = `data-intentic-veil`;
const TICK_MS = 200;
// Ticks of nobody answering before the window gives up on the app: ~12s, long enough to outlast a slow reload
// of the opener (a cold dev server, a throttled background tab) and short enough that a window whose app is
// gone does not sit around.
const ORPHAN_TICKS = 60;
// Ticks of being OWNED but empty before it gives up anyway: ~60s. A page that answers is alive, so this is not
// the orphan case and must not share its deadline — it is an app still booting, or one whose panel host is
// between mounts, and both legitimately outrun twelve seconds. Bounded all the same: an app that has reached a
// place with no panel in it at all (signed out, no sandbox selected, a viewport that fell to the mobile shell)
// would otherwise leave a veiled window floating for the rest of the day.
const BLANK_TICKS = 300;

let orphaned = 0;
let blank = 0;

// Covers the panel the moment nobody answers for it, so a frozen picture of the app can never be mistaken for
// the app. Re-created rather than toggled: an adoption re-dresses this document (its body is cleared), and the
// next tick simply puts the veil back if it is still needed.
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

const ask = (): void => {
    const opener = window.opener as Window | null;
    if (opener === null || opener.closed) {
        window.close();
        return;
    }
    let answer: PopoutAnswer = `none`;
    try {
        // Running the opener's code IS the proof of life — a page mid-reload has no hook yet, and a dead realm
        // has none ever again. Either way the answer is `none` and this window says so.
        answer = opener.__intentic?.adoptPopout(window.name, window) ?? `none`;
    } catch {
        window.close(); // opener navigated cross-origin: its realm is unreachable, nobody can drive us
        return;
    }
    // The veil asks only "is there a panel in here", so `waiting` is veiled exactly like `none`: from the
    // reader's side an empty window is an empty window, whatever the app's reason for it.
    veil(answer !== `live`);
    orphaned = answer === `none` ? orphaned + 1 : 0;
    blank = answer === `live` ? 0 : blank + 1;
    if (orphaned > ORPHAN_TICKS || blank > BLANK_TICKS) {
        window.close();
    }
};

ask();
setInterval(ask, TICK_MS);
