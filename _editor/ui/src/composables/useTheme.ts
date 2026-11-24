import { computed, ref, watch, type ComputedRef, type Ref } from "vue";
import { definePreference } from "./preference.js";

export type ColorScheme = "light" | "dark";
/** What the setting holds. `system` is the default, and the only value that can change without anyone choosing. */
export type SchemeChoice = "system" | ColorScheme;

const STORAGE_KEY = `ui-color-scheme`;
const DARK_ATTRIBUTE = `data-mode`;

// The scheme is an account preference, live in every window at once. It flips `data-mode` on <html>, the selector both the
// PrimeVue dark preset and role tokens key off. There is no personal accent colour since 2026-11-24: the colour a
// person sees is the sandbox's own (web models/sandbox/sandboxColor.ts), the same for every member.

const apply = (value: ColorScheme): void => {
    if (value === `dark`) {
        document.documentElement.setAttribute(DARK_ATTRIBUTE, `dark`);
    } else {
        document.documentElement.removeAttribute(DARK_ATTRIBUTE);
    }
};

// THE OS'S ANSWER, LIVE. `no-preference` matches neither query, so a browser that will not say reads as light —
// which is the whole of "light unless we are told otherwise". index.html's pre-paint script runs the same rule a
// module earlier, so the first frame and this module never disagree.
const darkQuery = typeof window === `undefined` || window.matchMedia === undefined ? undefined : window.matchMedia(`(prefers-color-scheme: dark)`);
const system = ref<ColorScheme>(darkQuery?.matches === true ? `dark` : `light`);
darkQuery?.addEventListener(`change`, (event) => {
    system.value = event.matches ? `dark` : `light`;
});

// A SCHEME THE WINDOW IS HANDED rather than one this page keeps. The desktop app's own faces (its setup card, its close
// question) are handed the workspace's scheme by the binary before they paint (`face_init_script` in windows.rs), and
// the Android app hands its WebView the look it wears (web's app/environments/nativeApp.ts, through `hand`). That is a
// fact about the window they stand in, not a preference this page may hold, so it wins over both the setting and the
// OS, and it is never stored: the reader's own choice is still there underneath once nothing is handed. `system`
// handed follows the OS whatever the setting says. The desktop app leaves its key unset when it has nothing to
// announce. Read as a KEY rather than a property: the name belongs to the binary that writes it, not to this file.
const announced = (globalThis as unknown as Record<string, unknown>)[`__INTENTIC_MODE__`];
const given = ref<SchemeChoice | undefined>(announced === `light` || announced === `dark` ? announced : undefined);

const choice: Ref<SchemeChoice> = definePreference<SchemeChoice>({
    key: STORAGE_KEY,
    read: (raw) => (raw === `light` || raw === `dark` ? raw : `system`),
    write: (value) => value,
});

/** The scheme actually on screen; `system` resolved, and read-only because the way to change it is `set`. */
const scheme: ComputedRef<ColorScheme> = computed(() => {
    const asked = given.value ?? choice.value;
    return asked === `system` ? system.value : asked;
});

/** The scheme the window was handed, undefined while the setting decides. */
const handed: ComputedRef<SchemeChoice | undefined> = computed(() => given.value);

// The DOM side hangs off the RESOLVED scheme, not off the setting, or an OS flip under `system` would repaint
// nothing. `sync` for the reason definePreference applies synchronously: a frame in the old look is the bug.
watch(scheme, apply, { immediate: true, flush: `sync` });

const set = (value: SchemeChoice): void => {
    choice.value = value;
};

/** Wears `value` over the setting without storing it; undefined hands the scheme back to the setting. */
const hand = (value: SchemeChoice | undefined): void => {
    given.value = value;
};

/** Pins the scheme opposite to what is on screen: a toggle is a choice, so it never leaves the setting on `system`. */
const toggle = (): void => {
    set(scheme.value === `dark` ? `light` : `dark`);
};

export function useTheme() {
    return { scheme, choice, handed, set, hand, toggle };
}
