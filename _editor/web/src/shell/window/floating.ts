import { computed, type ComputedRef, getCurrentScope, onScopeDispose, shallowRef } from "vue";
import { reloadOnHotUpdate } from "../../app/hotReload";
import { uuid } from "../../lib/uuid";

// A floating panel (chat, terminal, preview) is a real window at /floating/<panel>, rendering full-bleed
// (FloatingArea.vue). `floats`/`here`/`shows` derive from BroadcastChannel heartbeats, not ownership; a stale claim
// (heartbeat and lock both gone past STALE_MS) is swept, and duplicates resolve oldest-claim-wins.

export type FloatingPanel = `chat` | `terminal` | `preview`;

// Resolved against BASE_URL, not root-absolute: this build can be served under a path prefix.
const floatingPath = (panel: FloatingPanel): string => `${import.meta.env.BASE_URL}floating/${panel}`;

// STALE_MS must outlast a reload's heartbeat gap, or a reloading window gets written off as gone.
const HEARTBEAT_MS = 750;
const STALE_MS = 2500;
const SWEEP_MS = 500;

// Frames smaller than this are treated as a bad reading (closing/minimized window), not a real size.
const MIN_FRAME = 240;

// Notes exchanged between floating windows over BroadcastChannel; only `here` carries state, the rest are requests.
// `roll` lets a newly loaded window learn current state without waiting for a heartbeat.
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

// Other windows' claims only; a BroadcastChannel never delivers to its own poster, so this window's own claim is
// `mine`. Kept in a plain Map rather than reactive state, since presence changes rarely.
interface Sighting {
    readonly id: string;
    // When that window's claim began; used to break ties between competing claims for the same panel.
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

// Snapshot of held lock names, refreshed once per sweep; can lag behind by up to one sweep interval.
let heldLocks: ReadonlySet<string> = new Set();
let looking = false;

const lookAtLocks = (): void => {
    if (globalThis.navigator?.locks === undefined || looking) {
        return;
    }
    looking = true;
    void navigator.locks
        .query()
        .then((state) => {
            heldLocks = new Set((state.held ?? []).flatMap((lock) => (lock.name === undefined ? [] : [lock.name])));
        })
        // Unavailable: fall back to heartbeat alone by clearing held locks.
        .catch(() => {
            heldLocks = new Set();
        })
        .finally(() => {
            looking = false;
        });
};

let sweep: ReturnType<typeof setInterval> | undefined;

// Retires a panel once its heartbeat is stale past STALE_MS and its liveness lock is not held; runs only while
// something is floating.
const startSweeping = (): void => {
    if (sweep !== undefined) {
        return;
    }
    lookAtLocks();
    sweep = setInterval(() => {
        const now = Date.now();
        for (const [panel, sighting] of sightings) {
            if (now - sighting.seenAt > STALE_MS && !heldLocks.has(lockName(panel, sighting.id))) {
                sightings.delete(panel);
            }
        }
        publish();
        if (sightings.size === 0 && sweep !== undefined) {
            clearInterval(sweep);
            sweep = undefined;
            return;
        }
        lookAtLocks();
    }, SWEEP_MS);
};

// This window's own claim, if any; set when a floating route mounts and cleared when its scope disposes.
const mine = shallowRef<FloatingPanel | undefined>(undefined);

// Readers of incoming notes held by this window's claim; a set so a hot update can't leave a stale reader behind.
const claimants = new Set<(note: FloatingNote) => void>();

/**
 * Which panel this window floats, if any; read by the app shell so a floating window keeps its panel mounted under the
 * mobile breakpoint.
 */
export const floatingWindowPanel: ComputedRef<FloatingPanel | undefined> = computed(() => mine.value);

/**
 * True when some panel floats in another window; this window may need to hand work back to it
 * (composables/mainWindow.ts).
 */
export const floatsElsewhere: ComputedRef<boolean> = computed(() => elsewhere.value.size > 0);

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
 * Claims a panel for this window, announcing it until the scope disposes (call once from the floating route's setup);
 * `onDock` handles a dock request, since only this realm can decide whether to close.
 */
export const claimFloating = (panel: FloatingPanel, onDock: () => void): void => {
    const id = uuid();
    const since = Date.now();
    mine.value = panel;

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
        // Older claim wins, ties broken by id: exactly one of two racing claims for the same panel closes itself.
        if (note.kind === `here` && note.id !== id && (note.since < since || (note.since === since && note.id < id))) {
            onDock();
        }
    };
    claimants.add(heard);

    // Runs eagerly on pagehide as the fast path; a window that dies without it is written off once its lock releases.
    // The lock stays held here since pagehide also fires for bfcache, which resumes this same claim.
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
        dropLiveness();
        leaving();
    };
    if (getCurrentScope() !== undefined) {
        onScopeDispose(release);
    }
};

// Every window's half: hear the claims and act on them.

/**
 * The single entry point for an incoming note, shared by the BroadcastChannel listener and tests. Updates presence for
 * every window, then forwards the note to this window's own claim, if any.
 */
export const receiveFloatingNote = (note: FloatingNote): void => {
    if (note.kind === `here`) {
        sightings.set(note.panel, { id: note.id, since: note.since, seenAt: Date.now() });
        publish();
        startSweeping();
    } else if (note.kind === `gone` && sightings.get(note.panel)?.id === note.id) {
        // Matched by id: a losing window's `gone` must not retire the winner's claim it raced against.
        sightings.delete(note.panel);
        publish();
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
}

/**
 * Whether this window draws the given panel, without the rest of a full surface (see chat/useChat.ts); depends on
 * nothing but vue.
 */
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
        // Useful only within one browsing context group; oldest-claim is what actually caps duplicates across tabs.
        const win = window.open(floatingPath(panel), `intentic-${panel}`, features(rememberedFrame(panel) ?? centred(size())));
        win?.focus(); // null when the popup blocker refused; the panel stays where it is.
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
        // Room to this window's right; an unmeasurable screen yields a negative offset, floored to "leave it".
        const room = Math.max(window.outerWidth, window.screen.availWidth - window.screenX);
        window.resizeTo(Math.round(Math.min(width, room)), window.outerHeight);
    };

    return { panel, floats, here, shows, open, dock, toggle: () => (floats.value ? dock() : open()), fit };
};

// One claim, sighting set and channel per window: a hot update must not leave stale state behind.
reloadOnHotUpdate(import.meta);
