import { ref, watch, type Ref } from "vue";

// A preference is per-account, not per-window: without this, a popped-out panel's own document never
// learns of a change made elsewhere. Changes travel via BroadcastChannel and the browser's `storage`
// event (which also catches non-preference writes, e.g. a self-heal clear); a preference is live only
// in windows that import its module.

export interface PreferenceOptions<T> {
    /**
     * The localStorage key; preferences live under `ui-`, namespaced away from a window's own view state
     * (`intentic.*`).
     */
    readonly key: string;
    /** What a stored string means, `null` for nothing stored; owns the default and validation together. */
    readonly read: (raw: string | null) => T;
    /** How to store it; `null` removes the key, for a preference whose value can be "none". */
    readonly write: (value: T) => string | null;
    /**
     * The DOM side, if any (an attribute on <html>, custom properties); run at load and on every change,
     * in whichever window it happened.
     */
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

// Preferences this window holds, keyed by storage key, so a change made elsewhere finds the one it names.
const held = new Map<string, (raw: string | null) => void>();

/** What one window tells the others: a key and its new raw value. `key: null` means the whole store was cleared. */
export interface PreferenceNote {
    readonly key: string | null;
    readonly raw: string | null;
}

const channel = typeof window === `undefined` || window.BroadcastChannel === undefined ? undefined : new BroadcastChannel(`intentic.preferences`);

/**
 * A preference changed in another window, arriving here as the one path in. A key this window holds none
 * for is ignored; `null` means every preference resets to its default.
 */
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

/**
 * Declare one preference and hand back the ref the app reads and writes; assigning it applies, persists,
 * and notifies every other window.
 */
export const definePreference = <T>({ key, read, write, apply }: PreferenceOptions<T>): Ref<T> => {
    const state = ref(read(stored(key))) as Ref<T>;
    apply?.(state.value);

    // Adopting a change is not making one: a window that hears a change applies it without re-writing, since
    // `read` normalises and an echo would ratchet another window's value down. `flush: sync` keeps the flag
    // correct against the write happening in the same tick.
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

/** Read one stored preference string without holding it, for the one caller that needs it before this is set up. */
export const storedPreference = (key: string): string | null => stored(key);
