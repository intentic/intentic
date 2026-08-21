import { computed, type ComputedRef, getCurrentScope, onScopeDispose, shallowRef } from "vue";
import { uuid } from "./uuid";

/* A PANEL IN A WINDOW OF ITS OWN, as ONE SHARED FACT rather than a relationship between two windows.
 *
 * Three panels can float: the chat, the sandbox-global terminal, the app preview. A floating one is a REAL
 * window of this app, opened on /floating/<panel>, booting its own copy of the app and rendering that panel
 * full-bleed (pages/FloatingArea.vue). Nothing paints into it from outside; nothing owns it.
 *
 * WHY THAT MATTERS, because the shape before this one was the opposite and every defect followed from it. A
 * floating panel used to be a near-empty page whose DOM was teleported in from the window that opened it, over
 * the `window.opener` bond. It bought one thing, a streaming turn and an attached xterm rode along without
 * re-attaching, and it cost:
 *   · OWNERSHIP. A window can only be painted by the window that opened it, so the floating panel obeyed
 *     exactly one copy of the app. Every gesture in any other window was invisible out there, with both windows
 *     perfectly healthy, and no liveness machinery could ever catch it.
 *   · MULTIPLICITY. `window.open(url, "chat")` reuses a window by name only inside the same browsing context
 *     group, and two app tabs are in different groups. Two tabs, two floating chats, and nothing anywhere held
 *     "there is one".
 *   · A LIVENESS PROTOCOL. The window had to keep asking whether the realm drawing it was still alive, because
 *     a dead realm leaves the same pixels on screen with no state behind them. Three answers, a veil, an orphan
 *     deadline, a blank deadline, a nudge channel, a reclaim grace, a hand-back grace, a holder count.
 * All of that is deleted. A window that renders its own panel cannot be a photograph of one.
 *
 * WHAT REPLACES IT IS ONE SIGNAL: a floating window ANNOUNCES itself, on a heartbeat, and stops when it goes.
 * Every window derives its whole view of the arrangement from that:
 *   · `floats`, the panel is in a window of its own (this one or another). What labels and layouts read.
 *   · `here`  , and that window is this one.
 *   · `shows` , this window is the one that draws the panel: `here`, or nobody else is floating it.
 * Three computed views of one fact, and no branch anywhere asks "who owns it". A window that goes away without
 * saying so is a heartbeat that stops, which every other window notices within STALE_MS: the same mechanism
 * that reports a dock reports a crash, a killed window and a webview that swallowed its unload handlers, so
 * there is no state the app can be left stuck in.
 *
 * DUPLICATES CANNOT SURVIVE, by construction rather than by named-window luck. Every floating window hears
 * every other one's heartbeat, and one that hears an OLDER claim for its own panel closes itself. Whatever
 * raced, whatever browsing context group they were opened from, exactly one is left.
 *
 * THE PRICE, stated where it is paid: popping out and docking now RE-ATTACH. The chat re-attaches its running
 * turn from the daemon by seq cursor, the terminal reattaches tmux (which redraws), the preview's iframe
 * reloads. A blink, once, per move, in exchange for a window that can never be frozen, orphaned, veiled,
 * stuck, or duplicated.
 *
 * Same-origin, which is also the boundary of "the same app": the scope a BroadcastChannel already has. */

export type FloatingPanel = `chat` | `terminal` | `preview`;

// The route a floating window lives on, resolved against the app's BASE rather than the origin root, the same
// thing the router does with its history: this build is also served under a prefix (the recorded demo lives at
// `/demo/` on the marketing site), and there a root-absolute path opens that site's 404 page.
const floatingPath = (panel: FloatingPanel): string => `${import.meta.env.BASE_URL}floating/${panel}`;

// How often a floating window says it is there, and how long its silence has to last before the rest of the app
// writes it off. The gap between them is deliberate and it is what a RELOAD of a floating window fits through:
// it goes quiet for a load and comes back well inside the deadline, so no other window flashes its column.
const HEARTBEAT_MS = 750;
const STALE_MS = 2500;
const SWEEP_MS = 500;

// Nobody deliberately leaves a window this small, so a frame under it is a bad reading (a window mid-close, a
// minimized one reporting zeros) rather than a preference: reopening into it would hand back an unusable sliver.
const MIN_FRAME = 240;

/* WHAT THE WINDOWS SAY TO EACH OTHER. Five notes, and only the first carries state, everything else is a
 * request. `roll` is how a window that has just loaded finds out what is already floating without waiting out a
 * heartbeat; the rest are self-describing. */
export type FloatingNote =
    | { readonly kind: `here`; readonly panel: FloatingPanel; readonly id: string; readonly since: number }
    | { readonly kind: `gone`; readonly panel: FloatingPanel; readonly id: string }
    | { readonly kind: `dock`; readonly panel: FloatingPanel }
    | { readonly kind: `raise`; readonly panel: FloatingPanel }
    | { readonly kind: `roll` };

const channel = typeof window === `undefined` || window.BroadcastChannel === undefined ? undefined : new BroadcastChannel(`intentic.floating`);

const post = (note: FloatingNote): void => {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel, not window: this postMessage takes no targetOrigin
    channel?.postMessage(note);
};

/* WHO IS FLOATING WHAT, as this window knows it. A BroadcastChannel never delivers to its own poster, so this
 * map holds OTHER windows only, which is exactly the reading `shows` needs: "somebody else is drawing this
 * panel". This window's own claim is `mine` below, and the two are deliberately separate facts.
 *
 * The timestamps live in a plain Map and the membership in a ref, because presence is what the app renders off
 * and it changes about once an hour, while the heartbeat behind it lands twice a second: a reactive map would
 * invalidate every computed and every dependent render on every beat, for a set that did not change. */
interface Sighting {
    readonly id: string;
    // When that window's claim BEGAN, which is what settles a race between two of them (see `here` below).
    readonly since: number;
    readonly seenAt: number;
}

const sightings = new Map<FloatingPanel, Sighting>();
const elsewhere = shallowRef<ReadonlySet<FloatingPanel>>(new Set());

const publish = (): void => {
    const next = new Set(sightings.keys());
    if (next.size === elsewhere.value.size && [...next].every((panel) => elsewhere.value.has(panel))) {
        return;
    }
    elsewhere.value = next;
};

let sweep: ReturnType<typeof setInterval> | undefined;

// Written off, one panel at a time, the moment a floating window's silence outlasts the deadline. The sweep runs
// only while there is something to sweep, so an app with nothing floating pays nothing for this.
const startSweeping = (): void => {
    if (sweep !== undefined) {
        return;
    }
    sweep = setInterval(() => {
        const now = Date.now();
        for (const [panel, sighting] of sightings) {
            if (now - sighting.seenAt > STALE_MS) {
                sightings.delete(panel);
            }
        }
        publish();
        if (sightings.size === 0 && sweep !== undefined) {
            clearInterval(sweep);
            sweep = undefined;
        }
    }, SWEEP_MS);
};

/* THIS WINDOW'S OWN CLAIM. A ref rather than a constant because it arrives with the route: the app boots, the
 * floating route mounts, and from then on this window IS the chat's window (or the terminal's, or the
 * preview's). It is released with that route's scope, which covers the ways a floating window can stop being
 * one without closing, a lost session bounced to /login, the last sandbox deselected. */
const mine = shallowRef<FloatingPanel | undefined>(undefined);

// The claim this window holds, as a note reader (claimFloating installs it). A set of one in practice, and a set
// rather than a slot so a hot update replacing the route component cannot leave a stale reader behind.
const claimants = new Set<(note: FloatingNote) => void>();

/** Which panel THIS window floats, if it is a floating window at all. Read by the app shell, which otherwise
 *  mounts no poppable panel on a viewport under the mobile breakpoint: a floating window is desktop by intent
 *  whatever its width, and a chat window the user has dragged narrow must still hold a chat rather than turning
 *  into an empty rectangle. */
export const floatingWindowPanel: ComputedRef<FloatingPanel | undefined> = computed(() => mine.value);

/* WHERE A FLOATING WINDOW COMES BACK. Kept per panel in localStorage, not the session, because the two are
 * different claims: where the user keeps this window is a habit that outlives tabs and browser restarts. Only
 * the floating window itself writes it, from its own realm, so the four numbers are always its own honest
 * geometry rather than a cross-window reading taken while it was closing. */
interface Frame {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

const frameKey = (panel: FloatingPanel): string => `intentic.floating.frame.${panel}`;

/* The one fact the Window Management API gives a page without asking permission: whether the desktop spans more
 * than one screen. Chromium answers, the DOM lib TypeScript builds against doesn't know it yet, and everyone
 * else stays silent, so it is declared OPTIONAL, because "the browser didn't say" is a third answer this module
 * acts on. */
declare global {
    interface Screen {
        readonly isExtended?: boolean;
    }
}

/* A remembered frame is honored verbatim, INCLUDING a position on a screen this page cannot measure, that is
 * the whole point, since the second monitor is where a floating panel tends to live. The one case worth
 * second-guessing is the monitor that has since been unplugged, whose coordinates now name nothing: a window
 * opened out there is one the user can neither find nor close. Only `isExtended === false` is actionable, one
 * screen attached, so a frame that doesn't overlap it is stranded; undefined or true leaves the frame alone. */
const onSomeScreen = (frame: Frame): boolean =>
    window.screen.isExtended !== false ||
    (frame.left < window.screen.availWidth && frame.top < window.screen.availHeight && frame.left + frame.width > 0 && frame.top + frame.height > 0);

const rememberedFrame = (panel: FloatingPanel): Frame | undefined => {
    let stored: string | null = null;
    try {
        stored = localStorage.getItem(frameKey(panel));
    } catch {
        return undefined; // site data off: merely touching storage throws there
    }
    if (stored === null) {
        return undefined;
    }
    const [left, top, width, height] = stored.split(`,`).map(Number);
    if (left === undefined || top === undefined || width === undefined || height === undefined) {
        return undefined;
    }
    // A NaN or an Infinity anywhere in a hand-edited (or half-written) note makes the sum non-finite.
    if (!Number.isFinite(left + top + width + height) || width < MIN_FRAME || height < MIN_FRAME) {
        return undefined;
    }
    const frame = { left, top, width, height };
    return onSomeScreen(frame) ? frame : undefined;
};

// This window's own frame, written by the floating window itself. A window mid-close reports zeros, and parking
// the next one in the top-left corner at 0×0 is worse than forgetting where this one was.
const rememberOwnFrame = (panel: FloatingPanel): void => {
    if (window.outerWidth < MIN_FRAME || window.outerHeight < MIN_FRAME) {
        return;
    }
    try {
        localStorage.setItem(frameKey(panel), [window.screenX, window.screenY, window.outerWidth, window.outerHeight].join(`,`));
    } catch {
        // Unavailable or over quota; the window simply opens at its default frame next time.
    }
};

// Chrome only honors a separate window (rather than a tab) when `popup` is asked for.
const features = (frame: Frame): string =>
    `popup=1,width=${Math.round(frame.width)},height=${Math.round(frame.height)},left=${Math.round(frame.left)},top=${Math.round(frame.top)}`;

// Where a panel with nothing remembered opens: its asked-for size, centred on the screen the app is on.
const centred = (size: { width: number; height: number }): Frame => ({
    width: size.width,
    height: size.height,
    left: window.screenX + Math.max(0, (window.outerWidth - size.width) / 2),
    top: window.screenY + Math.max(0, (window.outerHeight - size.height) / 2),
});

/* ────────────────────────────────────────────────────────────────────────────────────────────────────────────
 * THE FLOATING WINDOW'S OWN HALF: hold the claim for as long as this window is that window.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** Claim a panel for THIS window and keep announcing it. Called once from the floating route's setup; the claim
 *  is dropped with that scope, and the beat is what every other window reads. `onDock` is how the window is
 *  asked to go: another window's Dock press arrives as a request, never as an act performed on it from outside,
 *  because only this realm knows whether closing itself is even allowed (a window opened by hand cannot). */
export const claimFloating = (panel: FloatingPanel, onDock: () => void): void => {
    const id = uuid();
    const since = Date.now();
    mine.value = panel;

    let lastFrame = ``;
    const beat = (): void => {
        post({ kind: `here`, panel, id, since });
        // Riding the beat rather than a resize listener: a window's POSITION changes with no event at all, so
        // the only honest way to know where the user left it is to keep looking while it is open. Compared
        // first, so the common case (a window nobody is dragging) writes nothing.
        const frame = [window.screenX, window.screenY, window.outerWidth, window.outerHeight].join(`,`);
        if (frame !== lastFrame) {
            lastFrame = frame;
            rememberOwnFrame(panel);
        }
    };
    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);

    const heard = (note: FloatingNote): void => {
        if (note.kind === `roll`) {
            beat();
            return;
        }
        if (note.panel !== panel) {
            return;
        }
        if (note.kind === `dock`) {
            onDock();
            return;
        }
        if (note.kind === `raise`) {
            window.focus();
            return;
        }
        /* ANOTHER WINDOW CLAIMS THIS PANEL. The older claim wins and the younger closes itself, which is the
         * whole of how duplicates die: both windows run this, both reach the same verdict about the same pair,
         * and exactly one acts. Ties on the millisecond are broken by id, so the rule is total. */
        if (note.kind === `here` && note.id !== id && (note.since < since || (note.since === since && note.id < id))) {
            onDock();
        }
    };
    claimants.add(heard);

    // Saying so on the way out is the fast path, not the mechanism: a window that dies without getting here is
    // written off by its own silence a couple of seconds later, which is why there is nothing else to clean up.
    const leaving = (): void => {
        rememberOwnFrame(panel);
        post({ kind: `gone`, panel, id });
    };
    window.addEventListener(`pagehide`, leaving);

    const release = (): void => {
        clearInterval(timer);
        claimants.delete(heard);
        window.removeEventListener(`pagehide`, leaving);
        if (mine.value === panel) {
            mine.value = undefined;
        }
        leaving();
    };
    if (getCurrentScope() !== undefined) {
        onScopeDispose(release);
    }
};

/* ────────────────────────────────────────────────────────────────────────────────────────────────────────────
 * EVERY WINDOW'S HALF: hear the claims, and act on them.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** Another window's note, arriving here: the ONE way in, so what a test hands over and what the channel
 *  delivers travel the identical path (the seam the chat's summons channel keeps, chat/summon.ts).
 *
 *  Two readers, and they are the two halves of this file. Presence is updated for every window; the claim held
 *  by THIS window, if it has one, is handed the note too, since a dock request, a raise and a rival's claim are
 *  all addressed to it rather than to the bookkeeping. */
export const receiveFloatingNote = (note: FloatingNote): void => {
    if (note.kind === `here`) {
        sightings.set(note.panel, { id: note.id, since: note.since, seenAt: Date.now() });
        publish();
        startSweeping();
    } else if (note.kind === `gone` && sightings.get(note.panel)?.id === note.id) {
        // Matched on id, because a LOSING window's farewell must not retire the winner it just lost to: both
        // announce the same panel, and the loser's `gone` lands after the winner's `here`.
        sightings.delete(note.panel);
        publish();
    }
    for (const claimant of claimants) {
        claimant(note);
    }
};

channel?.addEventListener(`message`, (event: MessageEvent<FloatingNote>) => receiveFloatingNote(event.data));

// The roll-call, once per load: a window that has just come up cannot see what is already floating, and asking
// is cheaper than waiting out a heartbeat with the panel briefly drawn in the wrong place.
if (channel !== undefined) {
    post({ kind: `roll` });
}

/** One panel's arrangement, read from any window. Built once per panel (chat/chatFloating.ts and its two
 *  siblings), because the three views below are the entire vocabulary the app needs for "where is this panel". */
export interface FloatingSurface {
    readonly panel: FloatingPanel;
    // The panel is in a window of its own, whichever window is asking. What labels, layouts and the wide form
    // read: it is a fact about the panel, not about the reader.
    readonly floats: ComputedRef<boolean>;
    // …and that window is this one.
    readonly here: ComputedRef<boolean>;
    // THIS window is the one that draws the panel right now: it is the floating window, or nobody else is.
    // Every dock slot and every mount condition in the app is this one reading.
    readonly shows: ComputedRef<boolean>;
    // Float it, or raise the window that already holds it. Never opens a second one.
    readonly open: () => void;
    // Bring it back: the floating window closes itself, wherever the press came from.
    readonly dock: () => void;
    readonly toggle: () => void;
    // Ask for at least this much width, what the chat panel does when it has just added a pane the current
    // frame has no room for. Only the floating window can grow itself, so this is a no-op anywhere else.
    readonly fit: (width: number) => void;
}

/** "THIS window is the one that draws the panel", on its own, for the modules that need the reading without the
 *  window controls that come with a surface (chat/useChat.ts, deciding whether it is the window whose tab strip
 *  is worth remembering). A leaf: this file reaches for nothing but vue, so anything may depend on it. */
export const showsPanel = (panel: FloatingPanel): ComputedRef<boolean> => computed(() => mine.value === panel || !elsewhere.value.has(panel));

export const createFloatingSurface = (panel: FloatingPanel, size: () => { width: number; height: number }): FloatingSurface => {
    const here = computed(() => mine.value === panel);
    const floats = computed(() => here.value || elsewhere.value.has(panel));
    const shows = showsPanel(panel);

    const open = (): void => {
        if (floats.value) {
            if (here.value) {
                window.focus();
            } else {
                post({ kind: `raise`, panel });
            }
            return;
        }
        // A target name still helps inside one browsing context group (re-pressing the button in the same tab
        // navigates the window it already opened rather than stacking one), but nothing DEPENDS on it: the
        // oldest-claim rule above is what actually keeps the count at one across unrelated tabs.
        const win = window.open(floatingPath(panel), `intentic-${panel}`, features(rememberedFrame(panel) ?? centred(size())));
        win?.focus(); // null when the popup blocker refused: the panel simply stays where it is
    };

    const dock = (): void => {
        if (here.value) {
            window.close();
            return;
        }
        post({ kind: `dock`, panel });
    };

    const fit = (width: number): void => {
        if (!here.value || window.outerWidth >= width) {
            return;
        }
        // What is left of the screen to this window's right. A window on a monitor this page cannot measure
        // reports an offset past that screen and comes out negative, which the floor turns into "leave it".
        const room = Math.max(window.outerWidth, window.screen.availWidth - window.screenX);
        window.resizeTo(Math.round(Math.min(width, room)), window.outerHeight);
    };

    return { panel, floats, here, shows, open, dock, toggle: () => (floats.value ? dock() : open()), fit };
};
