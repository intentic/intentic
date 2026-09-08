import type { Ref } from "vue";
import { DEFAULT_ACCENT, normalizeAccent, themeCss, themeVars } from "../lib/themeColor.js";
import { definePreference } from "./preference.js";

export type ColorScheme = "light" | "dark";

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

// Read once from `data-mode` at boot; afterward the attribute reflects live state, not storage.
const BOOT_SCHEME: ColorScheme = document.documentElement.getAttribute(DARK_ATTRIBUTE) ? `dark` : `light`;

const scheme: Ref<ColorScheme> = definePreference<ColorScheme>({
    key: STORAGE_KEY,
    read: (raw) => (raw === `light` || raw === `dark` ? raw : BOOT_SCHEME),
    write: (value) => value,
    apply,
});

const set = (value: ColorScheme): void => {
    scheme.value = value;
};

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
    return { scheme, set, toggle, accent, setAccent };
}
