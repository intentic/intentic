import { getCurrentScope, onScopeDispose, watch } from "vue";
import type { RouteLocationRaw, Router } from "vue-router";
import { floatingWindowPanel, floatsElsewhere } from "./floating";
import { uuid } from "./uuid";

/* WHERE A LINK PRESSED INSIDE A POPPED-OUT PANEL LANDS.
 *
 * A floating panel is a whole window of the app with no shell around it (composables/floating.ts): no rail, no
 * outlet, nothing to navigate. So a file reference clicked in the popped-out chat used to route THAT window,
 * and the panel the reader had deliberately put on a second screen turned into a workspace view wearing an icon
 * rail. The reference was right and the window was wrong: the chat they were reading was simply gone.
 *
 * An ERRAND, then, rather than a navigation. The floating window hands the reference to a window that has the
 * app in it and stays exactly as it was; that window opens the file and raises itself. When there is no such
 * window left, one is opened, and the errand waits on the doorstep for it to arrive.
 *
 * WHICH WINDOW GETS IT is read off the same kind of heartbeat the panels use, for the same reason: a window
 * that dies without saying so is a beat that stops, so a closed main window and a crashed one arrive here as
 * the same silence and both end with a new window being opened. A window announces itself only while something
 * IS floating, since that is the only time anybody can ask, and it announces WHEN IT LAST HAD THE READER'S
 * ATTENTION, so with two app windows open the errand goes to the one they were last in rather than to whichever
 * happens to be oldest.
 *
 * The errand is ADDRESSED (`to`), not broadcast: two windows both deciding they were the right one would open
 * the same file twice and fight over the focus. The floating window holds the whole roster, so it picks, and
 * exactly one window acts on what it is handed.
 *
 * Same-origin, a BroadcastChannel's own scope, which is also the boundary of "the same app". */

/** What a popped-out window can ask the app's own window to do. A FILE carries more than a URL can say (the
 *  line to jump to, whose checkout the path names), which is why it rides as a reference rather than as a
 *  route; a ROUTE is any other in-app destination a tool card offers, a browser session, a subagent's page. */
export type MainWindowErrand =
    | {
          readonly kind: `file`;
          readonly path: string;
          readonly line: number | undefined;
          readonly scope: { readonly agent: string | undefined } | undefined;
      }
    | { readonly kind: `route`; readonly path: string };

/* WHAT THE WINDOWS SAY TO EACH OTHER. `here` is the only one carrying state; `roll` is how a window that has
 * just loaded finds out who is out there without waiting out a beat. */
export type MainWindowNote =
    | { readonly kind: `here`; readonly id: string; readonly at: number }
    | { readonly kind: `gone`; readonly id: string }
    | { readonly kind: `roll` }
    | { readonly kind: `errand`; readonly to: string; readonly errand: MainWindowErrand };

const HEARTBEAT_MS = 750;
const STALE_MS = 2500;

// How long an errand waits for the window it opened. Long enough for a cold boot (auth, the sandbox connection)
// on a slow machine, short enough that it cannot be delivered to some window opened much later by hand.
const DOORSTEP_MS = 30_000;

const channel = typeof window === `undefined` || window.BroadcastChannel === undefined ? undefined : new BroadcastChannel(`intentic.main-window`);

const post = (note: MainWindowNote): void => {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel, not window: this postMessage takes no targetOrigin
    channel?.postMessage(note);
};

/* THE WINDOWS WITH THE APP IN THEM, as this window has last heard them. Swept where it is read rather than on a
 * timer: nobody renders off this roster, it is consulted at the moment a link is clicked, so a stale row costs
 * nothing until then and there is no interval to keep alive. */
const sightings = new Map<string, { readonly at: number; readonly seenAt: number }>();

// The window an errand goes to: the one whose reader touched it last, ties broken by id so the choice is total.
const pick = (): string | undefined => {
    const now = Date.now();
    let best: string | undefined;
    let bestAt = Number.NEGATIVE_INFINITY;
    for (const [id, sighting] of sightings) {
        if (now - sighting.seenAt > STALE_MS) {
            sightings.delete(id);
        } else if (sighting.at > bestAt || (sighting.at === bestAt && best !== undefined && id < best)) {
            best = id;
            bestAt = sighting.at;
        }
    }
    return best;
};

// An errand with nowhere to go yet, held while the window it opened boots. One slot: a second click before the
// first has landed means the reader has changed their mind about what they want to see.
let doorstep: { readonly errand: MainWindowErrand; readonly until: number } | undefined;

const deliver = (): void => {
    if (doorstep === undefined) {
        return;
    }
    if (Date.now() > doorstep.until) {
        doorstep = undefined;
        return;
    }
    const to = pick();
    if (to !== undefined) {
        post({ kind: `errand`, to, errand: doorstep.errand });
        doorstep = undefined;
    }
};

// The claim this window holds, as a note reader (useMainWindow installs it). A set of one in practice, and a set
// rather than a slot so a hot update replacing the shell cannot leave a stale reader behind.
const readers = new Set<(note: MainWindowNote) => void>();

/** Another window's note, arriving here: the ONE way in, so what a test hands over and what the channel
 *  delivers travel the identical path (the seam composables/floating.ts and the chat's summons channel keep). */
export const receiveMainWindowNote = (note: MainWindowNote): void => {
    if (note.kind === `here`) {
        sightings.set(note.id, { at: note.at, seenAt: Date.now() });
        deliver();
    } else if (note.kind === `gone`) {
        sightings.delete(note.id);
    }
    for (const reader of readers) {
        reader(note);
    }
};

channel?.addEventListener(`message`, (event: MessageEvent<MainWindowNote>) => receiveMainWindowNote(event.data));

// The roll-call, once per load. A floating window has to know who is out there BEFORE the reader clicks, and
// asking is instant where waiting out a beat is not; every window answers, whether or not it is announcing yet.
post({ kind: `roll` });

/** Hand an errand to the app's own window, and say whether that happened.
 *
 * `false` in a window that is not a floating one, which is every ordinary window of the app: there is nothing
 * to hand anything to, the caller is already home, and it does the thing itself. The one call site that decides
 * this is the caller's, not this module's, so a surface that appears in both kinds of window (the chat panel is
 * the same component either way) keeps one code path with one branch in it. */
export const handOffToMainWindow = (errand: MainWindowErrand): boolean => {
    if (floatingWindowPanel.value === undefined) {
        return false;
    }
    const to = pick();
    if (to !== undefined) {
        post({ kind: `errand`, to, errand });
        return true;
    }
    /* NOBODY IS HOME. Opening the window is the whole point of this branch, and it happens straight off the
     * click so the browser still counts it as one the reader asked for. A route is a destination the URL can
     * carry, so that window simply boots there; a file reference is not, so the window opens on the workspace
     * and the errand follows it in as soon as it says it has arrived. */
    const path = errand.kind === `route` ? errand.path.replace(/^\//u, ``) : `workspace`;
    const win = window.open(`${import.meta.env.BASE_URL}${path}`, `intentic-main`);
    win?.focus(); // null when the popup blocker refused: the errand simply expires on the doorstep
    if (errand.kind === `file`) {
        doorstep = { errand, until: Date.now() + DOORSTEP_MS };
    }
    return true;
};

/** Take a route, from wherever the reader is standing. In an ordinary window this window goes; in a popped-out
 *  panel the app's own window goes and this one stays put. The one call every in-app navigation made from a
 *  surface that can be in either kind of window should use, so neither has to know which it is in. */
export const navigateInApp = (router: Router, to: RouteLocationRaw): void => {
    if (!handOffToMainWindow({ kind: `route`, path: router.resolve(to).fullPath })) {
        void router.push(to);
    }
};

/* EVERY LINK PRESSED INSIDE A POPPED-OUT WINDOW, caught before the router sees it (pages/FloatingArea.vue
 * installs it, on the document, in the CAPTURE phase, which is what lets the preventDefault below stop
 * RouterLink's own handler: it checks defaultPrevented before it pushes anything).
 *
 * Delegated, like the file links inside rendered markdown, and for a stronger version of the same reason: a
 * floating window draws a whole panel's worth of links it does not own, from a persona rail to a model picker
 * to whatever a card grows next, and per-link wiring would be a rule every one of them had to remember. One
 * listener is the rule.
 *
 * A modified click (new tab, new window) is left to the browser exactly as it is everywhere else: that reader
 * has already said where they want it. */
export const sendLinkToMainWindow = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
    }
    const link = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>(`a[href]`);
    if (link === null || link === undefined || link.hasAttribute(`download`) || (link.target !== `` && link.target !== `_self`)) {
        return;
    }
    // A file mention says more than its address does (the line to jump to, whose checkout it names), and its
    // own handler is already carrying all of it to the same place. Left alone rather than flattened to a route.
    if (link.classList.contains(`md-file-link`)) {
        return;
    }
    const base = import.meta.env.BASE_URL;
    const url = new URL(link.href, window.location.href);
    // Somewhere else entirely: another site, a mailto:, a preview on its own port. Not this app's to move.
    if (url.origin !== window.location.origin || !url.pathname.startsWith(base)) {
        return;
    }
    const path = `/${url.pathname.slice(base.length)}${url.search}${url.hash}`;
    if (path.startsWith(`/floating/`)) {
        return;
    }
    if (handOffToMainWindow({ kind: `route`, path })) {
        event.preventDefault();
    }
};

/** THIS WINDOW IS ONE OF THE APP'S OWN, for as long as the shell is mounted in it (shell/WorkspaceShell.vue,
 *  its only caller). Announcing it anywhere else would be a lie a floating window acts on: a window sitting on
 *  /login or /setup has no workspace to show a file in, and an errand handed to it would vanish. */
export const useMainWindow = (show: (errand: MainWindowErrand) => void): void => {
    const id = uuid();
    // When the reader was last in this window. Its load counts as attention, which is what makes a window just
    // opened FOR an errand the one that gets it.
    let at = Date.now();
    const touched = (): void => {
        at = Date.now();
    };
    const beat = (): void => post({ kind: `here`, id, at });

    /* Announced only while a panel is floating, because that is the only window that ever asks. An app with
     * nothing popped out pays nothing for this, the same trade the floating sweep makes. */
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = watch(
        floatsElsewhere,
        (floats) => {
            if (floats && timer === undefined) {
                beat();
                timer = setInterval(beat, HEARTBEAT_MS);
            } else if (!floats && timer !== undefined) {
                clearInterval(timer);
                timer = undefined;
            }
        },
        // Sync: this is bookkeeping between windows rather than anything rendered, and a window that pops out
        // must be able to find this one on the next tick rather than after a render pass.
        { immediate: true, flush: `sync` },
    );

    const heard = (note: MainWindowNote): void => {
        if (note.kind === `roll`) {
            beat();
        } else if (note.kind === `errand` && note.to === id) {
            // Raised as well as filled: the reader clicked a link to see something, and a file opened in a
            // window behind the one they are in is a file they have not been shown.
            window.focus();
            show(note.errand);
        }
    };
    readers.add(heard);

    // Saying so on the way out is the fast path, not the mechanism: a window that dies without getting here is
    // written off by its own silence a couple of seconds later, and the errand opens a fresh window instead.
    const leaving = (): void => post({ kind: `gone`, id });
    window.addEventListener(`focus`, touched);
    window.addEventListener(`pagehide`, leaving);

    const release = (): void => {
        stop();
        if (timer !== undefined) {
            clearInterval(timer);
        }
        readers.delete(heard);
        window.removeEventListener(`focus`, touched);
        window.removeEventListener(`pagehide`, leaving);
        leaving();
    };
    if (getCurrentScope() !== undefined) {
        onScopeDispose(release);
    }
};
