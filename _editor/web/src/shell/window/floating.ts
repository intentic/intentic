import { computed, type ComputedRef, getCurrentScope, onScopeDispose, shallowRef } from "vue";
import { raiseOwnWindow, widenOwnWindow } from "../../app/environments/desktop";
import { reloadOnHotUpdate } from "../../app/hotReload";
import { uuid } from "../../lib/uuid";

// A floating panel (chat, terminal, preview) is a real window at /floating/<panel> (FloatingSection.vue); every window
// derives `floats`/`here`/`shows` from the claims it hears. A claim is alive while its window holds the claim's Web Lock:
// the browser drops that lock with the realm (a close, a crash, a kill, a reload), and every other window, queued on
// the same lock, is granted it at that moment, so nothing polls. A hand-back (`gone`) ends a claim at once; a reload
// says `unloading` first and keeps the panel's place for a moment, so the panel does not flash back between two realms.
// Duplicates resolve oldest-claim-wins. Where Web Locks are unavailable (a plain-http origin), the claim beats instead
// and a silent one expires: the one timer this module keeps.

export type FloatingPanel = `chat` | `terminal` | `preview`;

// Resolved against BASE_URL, not root-absolute: this build can be served under a path prefix.
const floatingPath = (panel: FloatingPanel): string => `${import.meta.env.BASE_URL}floating/${panel}`;

// How long a reloading window's place is held for its successor to claim it.
const RELOAD_HOLD_MS = 3000;
// How long after its lock drops a claim is kept, so an `unloading` sent in the same breath is still heard as a reload.
const LOCK_GRACE_MS = 500;
// Only without Web Locks: how often a claim says it is still there, and how long its silence is taken for a close.
const HEARTBEAT_MS = 750;
const STALE_MS = 2500;

// Frames smaller than this are treated as a bad reading (closing/minimized window), not a real size.
const MIN_FRAME = 240;

// Notes exchanged between floating windows over BroadcastChannel; `here`, `unloading` and `gone` carry state, the rest
// are requests. `roll` lets a newly loaded window learn current state without waiting for anything.
export type FloatingNote =
    | { readonly kind: `here`; readonly panel: FloatingPanel; readonly id: string; readonly since: number }
    // A reload unloads exactly like a close, so this holds the panel's place rather than handing it back.
    | { readonly kind: `unloading`; readonly panel: FloatingPanel; readonly id: string }
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

const locks = (): LockManager | undefined => globalThis.navigator?.locks;

// One Web Lock per claim, named `panel.id`, held by its window for the realm's lifetime; never used as a mutex.
const lockName = (panel: FloatingPanel, id: string): string => `intentic.floating.${panel}.${id}`;

// Other windows' claims only; a BroadcastChannel never delivers to its own poster, so this window's own claim is
// `own`. Kept in a plain Map rather than reactive state, since presence changes rarely.
interface Sighting {
    readonly panel: FloatingPanel;
    readonly id: string;
    // When that window's claim began; used to break ties between competing claims for the same panel.
    readonly since: number;
    // When the claim is retired unless something renews it; none while its lock says it is alive.
    readonly until: number | undefined;
    // Its window said it was unloading: the claim only holds the panel's place until a live claim or the deadline.
    readonly unloading: boolean;
    // Stops waiting on its lock, once the claim ends by some other route.
    readonly unwatch: () => void;
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

const forget = (id: string): void => {
    sightings.get(id)?.unwatch();
    sightings.delete(id);
};

// THE ONE TIMER: armed for the earliest deadline among the claims that have one, and re-armed whenever those change.
let expiry: ReturnType<typeof setTimeout> | undefined;
const expire = (): void => {
    clearTimeout(expiry);
    expiry = undefined;
    const now = Date.now();
    for (const [id, sighting] of sightings) {
        if (sighting.until !== undefined && sighting.until <= now) {
            forget(id);
        }
    }
    publish();
    const next = Math.min(...[...sightings.values()].map((sighting) => sighting.until ?? Number.POSITIVE_INFINITY));
    if (Number.isFinite(next)) {
        expiry = setTimeout(expire, Math.max(0, next - now));
    }
};

const setDeadline = (id: string, until: number | undefined, change: Partial<Pick<Sighting, `unloading`>> = {}): void => {
    const sighting = sightings.get(id);
    if (sighting !== undefined) {
        sightings.set(id, { ...sighting, ...change, until });
        expire();
    }
};

/**
 * Queues on a claim's lock: granted only once its window lets go, which is the moment that window is gone. Resolves
 * nothing and holds the lock no longer than it takes to say so. Returns the way to stop waiting.
 */
const watchLock = (panel: FloatingPanel, id: string): (() => void) => {
    const manager = locks();
    if (manager === undefined) {
        return () => undefined;
    }
    const stop = new AbortController();
    void manager
        .request(lockName(panel, id), { signal: stop.signal }, () => {
            const sighting = sightings.get(id);
            // An unloading claim already has its hold; any other gets a moment for its `unloading` to arrive.
            if (sighting !== undefined && !sighting.unloading) {
                setDeadline(id, Date.now() + LOCK_GRACE_MS);
            }
        })
        // Aborted (the claim ended some other way) or refused: either way there is nothing left to wait for.
        .catch(() => undefined);
    return () => stop.abort();
};

/**
 * Holds the lock for this realm's lifetime and returns a function to release it early, e.g. a route unmounting while
 * the window stays open. No-op if Web Locks is unavailable.
 */
const holdLiveness = (name: string): (() => void) => {
    const manager = locks();
    if (manager === undefined) {
        return () => undefined;
    }
    let drop: (() => void) | undefined;
    let dropped = false;
    void manager
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
        // silent-catch: refused, the claim beats instead (claimFloating's fallback), which a lockless window does anyway.
        .catch(() => undefined);
    return () => {
        dropped = true;
        drop?.();
    };
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

    // Acquired before the claim is announced, so any window that queues on it queues behind this one.
    let dropLiveness = holdLiveness(lockName(panel, id));

    const announce = (): void => post({ kind: `here`, panel, id, since });
    // Only without Web Locks: a claim nothing else can see alive has to keep saying so.
    const timer = locks() === undefined ? setInterval(announce, HEARTBEAT_MS) : undefined;
    // Position changes fire no event, so the frame is written when it can matter: a resize, and every way out.
    const remember = (): void => rememberOwnFrame(panel);

    // pagehide is alike for a reload, a close and bfcache: hold the place, say so.
    const unloading = (): void => {
        rememberOwnFrame(panel);
        post({ kind: `unloading`, panel, id });
    };
    // Back from bfcache as this same realm: the lock may have gone with the freeze, so it is taken again first.
    const resumed = (event: PageTransitionEvent): void => {
        if (event.persisted) {
            dropLiveness();
            dropLiveness = holdLiveness(lockName(panel, id));
        }
        announce();
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
        window.removeEventListener(`pageshow`, resumed);
        window.removeEventListener(`resize`, remember);
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
            announce();
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
    window.addEventListener(`pageshow`, resumed);
    window.addEventListener(`resize`, remember);
    announce();
    remember();
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
            forget(other);
            ended = true;
        }
    }
    if (!ended) {
        return;
    }
    expire();
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
        const known = sightings.get(note.id);
        // With Web Locks a claim is alive until its lock drops; without, until it goes quiet.
        const until = locks() === undefined ? Date.now() + STALE_MS : undefined;
        sightings.set(note.id, {
            panel: note.panel,
            id: note.id,
            since: note.since,
            until,
            unloading: false,
            unwatch: known?.unwatch ?? watchLock(note.panel, note.id),
        });
        expire();
    } else if (note.kind === `unloading`) {
        if (sightings.get(note.id)?.panel === note.panel) {
            setDeadline(note.id, Date.now() + RELOAD_HOLD_MS, { unloading: true });
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

// A newly loaded window can't see who's already floating, so it asks.
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
