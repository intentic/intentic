import { computed, type ComputedRef, getCurrentScope, onScopeDispose, shallowRef } from "vue";
import { raiseOwnWindow, widenOwnWindow } from "../../app/environments/desktop";
import { reloadOnHotUpdate } from "../../app/hotReload";
import { uuid } from "../../lib/uuid";

// A floating panel (chat, terminal, preview) is a real window at /floating/<panel> (FloatingSection.vue); every window
// derives `floats`/`here`/`shows` from its heartbeats. Only a hand-back (`gone`) ends a claim at once; any other end,
// a reload's included, waits out the claim's deadline and its lock. Duplicates resolve oldest-claim-wins.

export type FloatingPanel = `chat` | `terminal` | `preview`;

// Resolved against BASE_URL, not root-absolute: this build can be served under a path prefix.
const floatingPath = (panel: FloatingPanel): string => `${import.meta.env.BASE_URL}floating/${panel}`;

// STALE_MS is silence after which a running window is gone; a reloading one says so first and holds its place longer.
const HEARTBEAT_MS = 750;
const STALE_MS = 2500;
const SWEEP_MS = 500;

// Caps an unloading window's promised return: a first boot that sat on a sign-in is no measure of a reload.
const MAX_RETURN_MS = 10_000;

// Frames smaller than this are treated as a bad reading (closing/minimized window), not a real size.
const MIN_FRAME = 240;

// Notes exchanged between floating windows over BroadcastChannel; `here`, `unloading` and `gone` carry state, the rest
// are requests. `roll` lets a newly loaded window learn current state without waiting for a heartbeat.
export type FloatingNote =
    | { readonly kind: `here`; readonly panel: FloatingPanel; readonly id: string; readonly since: number }
    // A reload unloads exactly like a close, so this holds the panel's place for `within` ms rather than handing it back.
    | { readonly kind: `unloading`; readonly panel: FloatingPanel; readonly id: string; readonly within: number }
    // Handed back on purpose (a Dock press, the window's ×, a lost race), while that window was still running.
    | { readonly kind: `gone`; readonly panel: FloatingPanel; readonly id: string }
    | { readonly kind: `dock`; readonly panel: FloatingPanel }
    | { readonly kind: `raise`; readonly panel: FloatingPanel }
    | { readonly kind: `roll` };

const channel = typeof window === `undefined` || window.BroadcastChannel === undefined ? undefined : new BroadcastChannel(`intentic.floating`);

const post = (note: FloatingNote): void => {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel has no targetOrigin.
    channel?.postMessage(note);
};

// Other windows' claims only; a BroadcastChannel never delivers to its own poster, so this window's own claim is
// `own`. Kept in a plain Map rather than reactive state, since presence changes rarely.
interface Sighting {
    readonly panel: FloatingPanel;
    readonly id: string;
    // When that window's claim began; used to break ties between competing claims for the same panel.
    readonly since: number;
    // When the claim may be retired, if its lock agrees: STALE_MS past its last beat, or its promised return.
    readonly until: number;
    // Its window said it was unloading: the claim only holds the panel's place until a live claim or the deadline.
    readonly unloading: boolean;
}

const sightings = new Map<string, Sighting>();
// allow(module-state): which window draws which panel: identity of this window, not of a sandbox
const elsewhere = shallowRef<ReadonlyMap<FloatingPanel, string>>(new Map());

const publish = (): void => {
    const next = new Map<FloatingPanel, string>();
    // A live claim outranks an unloading one whatever their ages, so a reload's successor holds the panel once it claims.
    const ordered = [...sightings.values()].sort(
        (a, b) => Number(a.unloading) - Number(b.unloading) || a.since - b.since || (a.id < b.id ? -1 : a.id === b.id ? 0 : 1),
    );
    for (const sighting of ordered) {
        if (!next.has(sighting.panel)) {
            next.set(sighting.panel, sighting.id);
        }
    }
    if (next.size === elsewhere.value.size && [...next].every(([panel, id]) => elsewhere.value.get(panel) === id)) {
        return;
    }
    elsewhere.value = next;
};

// One Web Lock per claim, named `panel.id` and held by the browser for the realm's lifetime; it catches a throttled or
// frozen window a heartbeat alone would miss, and never acts as a mutex.
const lockName = (panel: FloatingPanel, id: string): string => `intentic.floating.${panel}.${id}`;

/**
 * Holds the lock for this realm's lifetime and returns a function to release it early, e.g. a route unmounting while
 * the window stays open. No-op if Web Locks is unavailable.
 */
const holdLiveness = (name: string): (() => void) => {
    if (globalThis.navigator?.locks === undefined) {
        return () => undefined;
    }
    let drop: (() => void) | undefined;
    let dropped = false;
    void navigator.locks
        .request(
            name,
            () =>
                // The lock is held while this promise is pending; `dropped` guards against a grant landing after
                // release.
                new Promise<void>((resolve) => {
                    if (dropped) {
                        resolve();
                        return;
                    }
                    drop = resolve;
                }),
        )
        .catch(() => undefined); // If refused, the heartbeat alone carries this window.
    return () => {
        dropped = true;
        drop?.();
    };
};

let looking = false;
let sweep: ReturnType<typeof setInterval> | undefined;

// Expiry must use a fresh lock query; a cached result can predate a browser suspension or a new claim.
const retireSightings = (heldLocks: ReadonlySet<string>): void => {
    for (const [id, sighting] of sightings) {
        if (Date.now() > sighting.until && !heldLocks.has(lockName(sighting.panel, id))) {
            sightings.delete(id);
        }
    }
    publish();
    if (sightings.size === 0 && sweep !== undefined) {
        clearInterval(sweep);
        sweep = undefined;
    }
};

const sweepSightings = (): void => {
    if (looking) {
        return;
    }
    if (globalThis.navigator?.locks === undefined) {
        retireSightings(new Set());
        return;
    }
    looking = true;
    void navigator.locks
        .query()
        .then((state) => {
            retireSightings(new Set((state.held ?? []).flatMap((lock) => (lock.name === undefined ? [] : [lock.name]))));
        })
        // Unavailable: fall back to heartbeat alone by clearing held locks.
        .catch(() => {
            retireSightings(new Set());
        })
        .finally(() => {
            looking = false;
        });
};

// Retires a panel once its heartbeat is stale past STALE_MS and its liveness lock is not held; runs only while
// something is floating.
const startSweeping = (): void => {
    if (sweep !== undefined) {
        return;
    }
    sweep = setInterval(sweepSightings, SWEEP_MS);
};

// This window's own claim, if any; set when a floating route mounts and cleared when it lets go.
interface OwnClaim {
    readonly panel: FloatingPanel;
    readonly id: string;
    // Lets go on purpose, then closes the window.
    readonly handBack: () => void;
}

// allow(module-state): which window draws which panel: identity of this window, not of a sandbox
const own = shallowRef<OwnClaim | undefined>(undefined);

// A replacement realm has a different owner even when the panel never stops floating.
export const floatingOwner = (panel: FloatingPanel): ComputedRef<string | undefined> =>
    computed(() => (own.value?.panel === panel ? own.value.id : elsewhere.value.get(panel)));

// Readers of incoming notes held by this window's claim; a set so a hot update can't leave a stale reader behind.
const claimants = new Set<(note: FloatingNote) => void>();

// Reactions to a panel docked on purpose (FloatingSurface.onDocked); a claim merely expiring never reaches them.
const dockedReactions = new Set<(panel: FloatingPanel) => void>();

/**
 * Which panel this window floats, if any; read by the app shell so a floating window keeps its panel mounted under the
 * mobile breakpoint.
 */
export const floatingWindowPanel: ComputedRef<FloatingPanel | undefined> = computed(() => own.value?.panel);

/** Hands this window's panel back and closes the window, as its Dock press does; false in a window that floats nothing. */
export const handBackOwnPanel = (): boolean => {
    const claim = own.value;
    claim?.handBack();
    return claim !== undefined;
};

/**
 * True when some panel floats in another window; this window may need to hand work back to it
 * (composables/mainWindow.ts).
 */
export const floatsElsewhere: ComputedRef<boolean> = computed(() => elsewhere.value.size > 0);

/** Brings the window already floating a panel forward, for work handed to it; never opens one (see FloatingSurface.open). */
export const raiseFloating = (panel: FloatingPanel): void => {
    if (elsewhere.value.has(panel)) {
        post({ kind: `raise`, panel });
    }
};

// Last remembered position and size for a panel's floating window, kept in localStorage (not session) so it survives
// restarts; written only by that window itself.
interface Frame {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

const frameKey = (panel: FloatingPanel): string => `intentic.floating.frame.${panel}`;

// `isExtended` is Chromium-only and absent from TypeScript's DOM lib; treat undefined as unknown, not as false.
declare global {
    interface Screen {
        readonly isExtended?: boolean;
    }
}

// A remembered frame is honored even off-screen, since a second monitor is often where a floating panel lives. Only
// `isExtended === false` (a single screen) can strand it; undefined or true leaves the frame alone.
const onSomeScreen = (frame: Frame): boolean =>
    window.screen.isExtended !== false ||
    (frame.left < window.screen.availWidth && frame.top < window.screen.availHeight && frame.left + frame.width > 0 && frame.top + frame.height > 0);

const rememberedFrame = (panel: FloatingPanel): Frame | undefined => {
    let stored: string | null = null;
    try {
        stored = localStorage.getItem(frameKey(panel));
    } catch {
        return undefined; // Storage access can throw when site data is disabled.
    }
    if (stored === null) {
        return undefined;
    }
    const [left, top, width, height] = stored.split(`,`).map(Number);
    if (left === undefined || top === undefined || width === undefined || height === undefined) {
        return undefined;
    }
    // Any NaN or Infinity in a hand-edited or partial value makes the sum non-finite.
    if (!Number.isFinite(left + top + width + height) || width < MIN_FRAME || height < MIN_FRAME) {
        return undefined;
    }
    const frame = { left, top, width, height };
    return onSomeScreen(frame) ? frame : undefined;
};

// Skips saving a frame smaller than MIN_FRAME: a window mid-close reports zeros, which is worse to remember than
// nothing.
const rememberOwnFrame = (panel: FloatingPanel): void => {
    if (window.outerWidth < MIN_FRAME || window.outerHeight < MIN_FRAME) {
        return;
    }
    try {
        localStorage.setItem(frameKey(panel), [window.screenX, window.screenY, window.outerWidth, window.outerHeight].join(`,`));
    } catch {
        // Storage unavailable or over quota; the window opens at its default frame next time.
    }
};

// `popup=1` is required for Chrome to open a separate window instead of a tab.
const features = (frame: Frame): string =>
    `popup=1,width=${Math.round(frame.width)},height=${Math.round(frame.height)},left=${Math.round(frame.left)},top=${Math.round(frame.top)}`;

// Default placement when nothing is remembered: centred on the screen this window is on.
const centred = (size: { width: number; height: number }): Frame => ({
    width: size.width,
    height: size.height,
    left: window.screenX + Math.max(0, (window.outerWidth - size.width) / 2),
    top: window.screenY + Math.max(0, (window.outerHeight - size.height) / 2),
});

// The floating window's half: hold the claim for as long as this window is that window.

/**
 * Claims a panel for this window until the scope disposes (call once from the floating route's setup); `close` takes
 * the window away, which only this realm can do. Returns the hand-back: let go on purpose, then close.
 */
export const claimFloating = (panel: FloatingPanel, close: () => void): (() => void) => {
    const id = uuid();
    const since = Date.now();
    // A reload is a boot, so this realm's own boot (navigation to claim) says how soon a reload of it is back.
    const within = Math.round(Math.min(Math.max(STALE_MS, 2 * performance.now()), MAX_RETURN_MS));

    // Acquired before the first heartbeat, so the window is never announced without its liveness token.
    const dropLiveness = holdLiveness(lockName(panel, id));

    let lastFrame = ``;
    const beat = (): void => {
        post({ kind: `here`, panel, id, since });
        // Position changes fire no event, so the frame is polled on each heartbeat; only saved when it changes.
        const frame = [window.screenX, window.screenY, window.outerWidth, window.outerHeight].join(`,`);
        if (frame !== lastFrame) {
            lastFrame = frame;
            rememberOwnFrame(panel);
        }
    };
    const timer = setInterval(beat, HEARTBEAT_MS);

    // pagehide is alike for a reload, a close and bfcache (whose pageshow resumes this claim): hold the place, keep the lock.
    const unloading = (): void => {
        rememberOwnFrame(panel);
        post({ kind: `unloading`, panel, id, within });
    };

    let released = false;
    // Idempotent: a hand-back releases before it closes, and the route unmounting behind it releases again.
    const release = (): void => {
        if (released) {
            return;
        }
        released = true;
        clearInterval(timer);
        claimants.delete(heard);
        window.removeEventListener(`pagehide`, unloading);
        window.removeEventListener(`pageshow`, beat);
        if (own.value?.id === id) {
            own.value = undefined;
        }
        dropLiveness();
        rememberOwnFrame(panel);
        post({ kind: `gone`, panel, id });
    };
    const handBack = (): void => {
        release();
        close();
    };

    const heard = (note: FloatingNote): void => {
        if (note.kind === `roll`) {
            beat();
            return;
        }
        if (note.panel !== panel) {
            return;
        }
        if (note.kind === `dock`) {
            handBack();
            return;
        }
        if (note.kind === `raise`) {
            raiseOwnWindow();
            return;
        }
        // Older claim wins, ties broken by id: exactly one of two racing claims for the same panel closes itself.
        if (note.kind === `here` && note.id !== id && (note.since < since || (note.since === since && note.id < id))) {
            handBack();
        }
    };

    own.value = { panel, id, handBack };
    claimants.add(heard);
    window.addEventListener(`pagehide`, unloading);
    window.addEventListener(`pageshow`, beat);
    beat();
    if (getCurrentScope() !== undefined) {
        onScopeDispose(release);
    }
    return handBack;
};

// Every window's half: hear the claims and act on them.

/**
 * Ends a panel's float on purpose: the claim `id` names, matched by id so a race loser cannot retire the winner, and
 * every unloading claim on the panel, which nobody is left to answer for. A no-op when neither is sighted.
 */
const endFloat = (panel: FloatingPanel, id: string | undefined): void => {
    let ended = false;
    for (const [other, sighting] of sightings) {
        if (sighting.panel === panel && (other === id || sighting.unloading)) {
            sightings.delete(other);
            ended = true;
        }
    }
    if (!ended) {
        return;
    }
    publish();
    for (const react of dockedReactions) {
        react(panel);
    }
};

/**
 * The single entry point for an incoming note, shared by the BroadcastChannel listener and tests. Updates presence for
 * every window, then forwards the note to this window's own claim, if any.
 */
export const receiveFloatingNote = (note: FloatingNote): void => {
    if (note.kind === `here`) {
        sightings.set(note.id, { panel: note.panel, id: note.id, since: note.since, until: Date.now() + STALE_MS, unloading: false });
        publish();
        startSweeping();
    } else if (note.kind === `unloading`) {
        const sighting = sightings.get(note.id);
        if (sighting?.panel === note.panel) {
            sightings.set(note.id, { ...sighting, until: Date.now() + note.within, unloading: true });
            publish();
        }
    } else if (note.kind === `gone`) {
        endFloat(note.panel, note.id);
    } else if (note.kind === `dock`) {
        endFloat(note.panel, undefined);
    }
    for (const claimant of claimants) {
        claimant(note);
    }
};

channel?.addEventListener(`message`, (event: MessageEvent<FloatingNote>) => receiveFloatingNote(event.data));

// A newly loaded window can't see who's already floating; asking is cheaper than waiting for a heartbeat.
if (channel !== undefined) {
    post({ kind: `roll` });
}

/** One panel's arrangement, readable from any window; built once per panel (chat/chatFloating.ts and its siblings). */
export interface FloatingSurface {
    readonly panel: FloatingPanel;
    // Whether the panel is in a window of its own, from any window's perspective.
    readonly floats: ComputedRef<boolean>;
    // Whether that window is this one.
    readonly here: ComputedRef<boolean>;
    // Whether this window draws the panel now: the floating window, or nobody else is floating it.
    readonly shows: ComputedRef<boolean>;
    // Floats the panel, or raises the window that already holds it; never opens a second one.
    readonly open: () => void;
    // Docks the panel, wherever the press came from.
    readonly dock: () => void;
    readonly toggle: () => void;
    // Grows the floating window to at least this width; a no-op anywhere else.
    readonly fit: (width: number) => void;
    // Runs `react` while the calling scope lives, whenever a dock brings the panel back; never when its window just went.
    readonly onDocked: (react: () => void) => void;
}

/**
 * Whether this window draws the given panel, without the rest of a full surface (see chat/useChat.ts); depends on
 * nothing but vue.
 */
export const showsPanel = (panel: FloatingPanel): ComputedRef<boolean> => computed(() => own.value?.panel === panel || !elsewhere.value.has(panel));

export const createFloatingSurface = (panel: FloatingPanel, size: () => { width: number; height: number }): FloatingSurface => {
    const here = computed(() => own.value?.panel === panel);
    const floats = computed(() => here.value || elsewhere.value.has(panel));
    const shows = showsPanel(panel);

    const open = (): void => {
        if (floats.value) {
            if (here.value) {
                raiseOwnWindow();
            } else {
                post({ kind: `raise`, panel });
            }
            return;
        }
        // Useful only within one browsing context group; oldest-claim is what actually caps duplicates across tabs.
        // Inside the desktop app the same call is answered with a window of the app's own (windows.rs) and returns
        // null, exactly like a refused popup: the panel stays here until that window announces itself.
        const win = window.open(floatingPath(panel), `intentic-${panel}`, features(rememberedFrame(panel) ?? centred(size())));
        win?.focus(); // null when the popup blocker refused; the panel stays where it is.
    };

    const dock = (): void => {
        if (here.value) {
            own.value?.handBack();
            return;
        }
        post({ kind: `dock`, panel });
        // What every other window does on hearing the request; the channel never echoes it back to this one.
        endFloat(panel, undefined);
    };

    const fit = (width: number): void => {
        if (!here.value || window.outerWidth >= width) {
            return;
        }
        // Room to this window's right; an unmeasurable screen yields a negative offset, floored to "leave it".
        const room = Math.max(window.outerWidth, window.screen.availWidth - window.screenX);
        widenOwnWindow(Math.min(width, room));
    };

    const onDocked = (react: () => void): void => {
        // A hand-back of this panel that another claim survives (a race loser's, an older window's) brings nothing back.
        const reaction = (docked: FloatingPanel): void => {
            if (docked === panel && !floats.value) {
                react();
            }
        };
        dockedReactions.add(reaction);
        if (getCurrentScope() !== undefined) {
            onScopeDispose(() => dockedReactions.delete(reaction));
        }
    };

    return { panel, floats, here, shows, open, dock, toggle: () => (floats.value ? dock() : open()), fit, onDocked };
};

// One claim, sighting set and channel per window: a hot update must not leave stale state behind.
reloadOnHotUpdate(import.meta);
