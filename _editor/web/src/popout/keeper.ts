/* The pop-out window's own script, and the ONLY code in a floating panel that runs in that window's realm —
 * everything the panel shows is rendered by the page that opened it (see composables/usePopout.ts for why, and
 * for the liveness contract this serves). That makes the keeper the only party able to speak for the window
 * once the realm behind it dies, so every tick it asks whatever page currently answers on the opener whether
 * anyone is driving this window, and acts on the answer:
 *   · yes — a live page holds it (a fresh load takes it over on the very tick it first answers). Nothing to do.
 *   · no  — veil the panel NOW. It may be a page mid-reload, in which case the veil lifts a few ticks later;
 *           what it must never be is a dead panel that still looks like the app.
 *   · nobody, for ~12s — close. The tab was shut, or navigated away from the app; a floating window with
 *           nothing driving it is worse than no window.
 *
 * The first ask is immediate rather than a tick in, because the handshake is also how a panel ARRIVES: popping
 * out is window.open on this page plus this question, so opening a window and re-adopting one that outlived a
 * reload are the same path through the opener's store. `window.name` — the target name window.open gave this
 * window, and the key those stores are registered under — survives navigation, so a reload out here reports in
 * as the same panel. */

const VEIL_ATTR = `data-intentic-veil`;
const TICK_MS = 200;
// Ticks of nobody answering before the window gives up on the app: ~12s, long enough to outlast a slow reload
// of the opener (a cold dev server, a throttled background tab) and short enough that a window whose app is
// gone does not sit around.
const ORPHAN_TICKS = 60;

let orphaned = 0;

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
    let driven = false;
    try {
        // Running the opener's code IS the proof of life — a page mid-reload has no hook yet, and a dead realm
        // has none ever again. Either way the answer is false and this window says so.
        driven = opener.__intentic?.adoptPopout(window.name, window) === true;
    } catch {
        window.close(); // opener navigated cross-origin: its realm is unreachable, nobody can drive us
        return;
    }
    veil(!driven);
    orphaned = driven ? 0 : orphaned + 1;
    if (orphaned > ORPHAN_TICKS) {
        window.close();
    }
};

ask();
setInterval(ask, TICK_MS);
