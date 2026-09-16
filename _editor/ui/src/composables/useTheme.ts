import { computed, ref, watch, type ComputedRef, type Ref } from "vue";
import { DEFAULT_ACCENT, normalizeAccent, themeCss, themeVars } from "../lib/themeColor.js";
import { definePreference } from "./preference.js";

export type ColorScheme = "light" | "dark";
/** What the setting holds. `system` is the default, and the only value that can change without anyone choosing. */
export type SchemeChoice = "system" | ColorScheme;

const STORAGE_KEY = `ui-color-scheme`;
const DARK_ATTRIBUTE = `data-mode`;
const ACCENT_STORAGE_KEY = `ui-accent`;
// Pre-serialized accent ramps, restored by index.html's anti-flash script before first paint (see themeCss).
const ACCENT_VARS_KEY = `ui-accent-vars`;

// Scheme and accent are account preferences, live in every window at once. Scheme flips `data-mode` on <html>,
// the selector both the PrimeVue dark preset and role tokens key off. Accent is a colour, not a named theme, so
// it's written as inline custom properties on <html>, which beat the ramps in primitive-colors.css.

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

// The desktop app's own faces (its setup card, its close question) are handed the workspace's scheme by the
// binary before they paint (`face_init_script` in windows.rs). That is a fact about the window they stand in, not
// a preference this page may hold, so it wins over both the setting and the OS. The app leaves it unset when it
// has nothing to announce, and the page falls back to the rule above. Read as a KEY rather than a property: the
// name belongs to the binary that writes it, not to this file.
const announced = (globalThis as unknown as Record<string, unknown>)[`__INTENTIC_MODE__`];
const PINNED: ColorScheme | undefined = announced === `light` || announced === `dark` ? announced : undefined;

const choice: Ref<SchemeChoice> = definePreference<SchemeChoice>({
    key: STORAGE_KEY,
    read: (raw) => (raw === `light` || raw === `dark` ? raw : `system`),
    write: (value) => value,
});

/** The scheme actually on screen; `system` resolved, and read-only because the way to change it is `set`. */
const scheme: ComputedRef<ColorScheme> = computed(() => PINNED ?? (choice.value === `system` ? system.value : choice.value));

// The DOM side hangs off the RESOLVED scheme, not off the setting, or an OS flip under `system` would repaint
// nothing. `sync` for the reason definePreference applies synchronously: a frame in the old look is the bug.
watch(scheme, apply, { immediate: true, flush: `sync` });

const set = (value: SchemeChoice): void => {
    choice.value = value;
};

/** Pins the scheme opposite to what is on screen: a toggle is a choice, so it never leaves the setting on `system`. */
const toggle = (): void => {
    set(scheme.value === `dark` ? `light` : `dark`);
};

const applyAccent = (value: string): void => {
    const style = document.documentElement.style;
    for (const [name, colour] of Object.entries(themeVars(value))) {
        style.setProperty(name, colour);
    }
};

const accent: Ref<string> = definePreference<string>({
    key: ACCENT_STORAGE_KEY,
    // Falls back to default and snaps off-ladder values; `accent` is always one canonical string for comparison.
    read: (raw) => (raw === null ? DEFAULT_ACCENT : normalizeAccent(raw)),
    write: (value) => value,
    apply: applyAccent,
});

/** Repaint the app in `hex` (`#rrggbb`), snapped to the accent's own lightness, and remember it. */
const setAccent = (hex: string): void => {
    const value = normalizeAccent(hex);
    accent.value = value;
    // Anti-flash cache; only the window that picked the colour refreshes it (pure function of the stored hex).
    try {
        localStorage.setItem(ACCENT_VARS_KEY, themeCss(value));
    } catch {
        // Storage may be unavailable (private mode); the colour still applies, it just flashes on next boot.
    }
};

export function useTheme() {
    return { scheme, choice, set, toggle, accent, setAccent };
}
