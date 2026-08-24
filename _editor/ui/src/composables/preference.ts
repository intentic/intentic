import { ref, watch, type Ref } from "vue";

/* AN ACCOUNT PREFERENCE, AND THE FACT THAT AN ACCOUNT HAS MORE THAN ONE WINDOW.
 *
 * Every setting on /settings/appearance is one answer per account, not per window: which colour the app is
 * painted in, how big its type is, whether a transcript draws its tool calls. The app already stored them that
 * way, one localStorage key each, shared by the whole origin. What it did not do is TELL the other windows, and
 * a popped-out panel is a whole other window of the app (composables/floating.ts): its own modules, its own
 * refs, its own <html>. So the settings page repainted the window it was in and nothing else, and the chat the
 * reader had deliberately put on a second screen sat in yesterday's theme until it was reloaded. Not a stale
 * render, a different copy of the preference, which is why nothing in the panel could have noticed.
 *
 * THE FIX IS THE PRIMITIVE, not a listener per setting. A preference declared here is live in every window
 * because that is the only way to declare one: read it, write it, apply it, and hear it change elsewhere are one
 * definition, so the next setting somebody adds cannot forget the last of the four. What was three near-identical
 * hand-rolled copies per composable (a guarded read with its own fallback, a guarded write, a DOM apply) is now
 * a `read`/`write`/`apply` triple, which is the part that actually differs between them.
 *
 * IT TRAVELS TWO WAYS, and they are not redundant, they cover different things.
 *
 *   · A BroadcastChannel, posted by the window the choice was made in. This is the app's own mechanism for
 *     exactly this pair of windows: a floating window's very EXISTENCE is announced on one
 *     (web/composables/floating.ts), so if it did not reach the popped-out window then popping out would not
 *     work at all and the panel would never collapse in the main window. It is therefore the path this fix
 *     rests on, rather than the one that merely ought to work.
 *   · `storage`, the browser's own notification, which fires in every OTHER same-origin window the moment
 *     localStorage changes. Free, and it catches what a posted note structurally cannot: a key written by
 *     something that is not a preference write at all. The app has several, a `localStorage.clear()` from the
 *     self-heal path, the anti-flash script in index.html, the accent's pre-serialized ramp cache, a hand edit in
 *     devtools. A window that hears one of those adopts it instead of drifting until its next reload.
 *
 * Both land in `receivePreferenceChange`, so there is ONE path in and duplicates cost nothing: adopting a value
 * this window already holds does not change the ref, so it does not re-apply and does not echo.
 *
 * A PREFERENCE IS DECLARED WHEN ITS MODULE LOADS, which is the one thing a caller still has to think about. A
 * window that never imports the module holds no such preference: it hears nothing, and, if the preference has an
 * `apply`, it never applied the stored value either. That is fine for a setting read by the surface it governs,
 * since the window drawing that surface is the window that imported it. It is NOT fine for one that paints the
 * whole document, so those are installed for every window in one place rather than left to the import graph, see
 * web/composables/theme/documentAppearance.ts.
 *
 * Storage can be missing entirely (private mode, disabled site data) and merely TOUCHING it throws there, so
 * every access below is guarded: a read degrades to "no answer stored", a write to a no-op, and the in-memory ref
 * stays authoritative for the life of the window. */

export interface PreferenceOptions<T> {
    /** The localStorage key. Preferences live under `ui-`; a window's own view state is namespaced away from
     *  them (`intentic.*`, see web/composables/windowStore.ts) precisely so the two can never be confused. */
    readonly key: string;
    /** What a stored string means, `null` for "nothing stored". Owns the default and the validation together, so
     *  an absent key, a value from an older build and a hand-edited one all land on the same answer. */
    readonly read: (raw: string | null) => T;
    /** How to store it, `null` to remove the key (the shape a preference whose value can be "none" wants). */
    readonly write: (value: T) => string | null;
    /** The DOM side, if the preference has one: an attribute on <html>, a set of inline custom properties. Run
     *  for the stored value at load and for every change after it, whichever window the change was made in. */
    readonly apply?: (value: T) => void;
}

const local = (): Storage | undefined => {
    try {
        return globalThis.localStorage;
    } catch {
        return undefined;
    }
};

const stored = (key: string): string | null => {
    try {
        return local()?.getItem(key) ?? null;
    } catch {
        return null;
    }
};

const persist = (key: string, raw: string | null): void => {
    try {
        if (raw === null) {
            local()?.removeItem(key);
        } else {
            local()?.setItem(key, raw);
        }
    } catch {
        // Unavailable or over quota; the in-memory ref still holds for the life of this window.
    }
};

/* THE PREFERENCES THIS WINDOW HOLDS, by the key each is stored under, so a change made in another window finds
 * the one it names and nothing else has to be consulted. Keyed rather than a list of listeners for two reasons:
 * one key is one preference, so a lookup is the whole dispatch; and a hot update that re-evaluates a composable
 * REPLACES that key's entry instead of leaving a stale ref behind still being written to. */
const held = new Map<string, (raw: string | null) => void>();

/** What one window tells the others: a key, and what it now reads as. `key: null` is "the whole store went",
 *  which is the shape the browser's own `storage` event uses for a clear and which the self-heal path produces. */
export interface PreferenceNote {
    readonly key: string | null;
    readonly raw: string | null;
}

const channel = typeof window === `undefined` || window.BroadcastChannel === undefined ? undefined : new BroadcastChannel(`intentic.preferences`);

/** A preference changed in ANOTHER window, arriving here: the ONE way in, so what a test hands over, what the
 *  channel delivers and what the browser's `storage` event reports travel the identical path (the seam
 *  composables/floating.ts and mainWindow.ts keep).
 *
 *  A key this window holds no preference for is ignored, which is what keeps every other thing the app stores out
 *  of here: a window's own view state (namespaced `intentic.*` for exactly this reason, see
 *  web/composables/windowStore.ts), the auth session, the floating frames. `null` is "the store was cleared", and
 *  every preference is back to its default at once. */
export const receivePreferenceChange = ({ key, raw }: PreferenceNote): void => {
    if (key === null) {
        for (const adopt of held.values()) {
            adopt(null);
        }
        return;
    }
    held.get(key)?.(raw);
};

channel?.addEventListener(`message`, (event: MessageEvent<PreferenceNote>) => receivePreferenceChange(event.data));

if (typeof window !== `undefined`) {
    window.addEventListener(`storage`, (event: StorageEvent) => receivePreferenceChange({ key: event.key, raw: event.newValue }));
}

/** Declare one preference and hand back the ref the app reads. Assigning to it is how the reader's choice is
 *  made: it applies, it persists, and every other window adopts it. A composable with something extra to do on a
 *  local choice (a skin turning the scheme dark with it) keeps a setter that wraps the assignment; a composable
 *  with nothing extra hands the ref straight out and needs no setter at all. */
export const definePreference = <T>({ key, read, write, apply }: PreferenceOptions<T>): Ref<T> => {
    const state = ref(read(stored(key))) as Ref<T>;
    apply?.(state.value);

    /* ADOPTING A CHANGE IS NOT MAKING ONE, and the difference is one flag because both end at the same ref.
     * A window that hears a change applies it and stops: the write already happened in the window the reader was
     * in. Writing it again would be worse than redundant, since `read` NORMALIZES (a width is clamped to what
     * this window can hold, an unknown value falls back to a default), so a narrow window echoing its own
     * reading back would ratchet the wide window's column down to fit a screen it isn't on.
     *
     * `flush: sync` is what makes the flag correct rather than a race: the watcher runs inside the assignment,
     * while `adopting` still stands. It is also what the DOM side needs, an attribute on <html> arriving a render
     * late is a frame of the old theme, and it is the same reading mainWindow.ts's own sync watch makes: this is
     * bookkeeping between windows, not something rendered. */
    let adopting = false;
    held.set(key, (raw) => {
        adopting = true;
        try {
            state.value = read(raw);
        } finally {
            adopting = false;
        }
    });

    watch(
        state,
        (value) => {
            apply?.(value);
            if (adopting) {
                return;
            }
            const raw = write(value);
            persist(key, raw);
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel, not window: this postMessage takes no targetOrigin
            channel?.postMessage({ key, raw } satisfies PreferenceNote);
        },
        { flush: `sync` },
    );

    return state;
};

/** Read one stored preference string without holding it. For the one caller that needs a preference's raw value
 *  before any of this is set up: an `<html>` attribute an anti-flash script already wrote (index.html), which a
 *  `read` treats as the fallback rather than as the answer. */
export const storedPreference = (key: string): string | null => stored(key);
