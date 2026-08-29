import type { Ref } from "vue";
import { DEFAULT_ACCENT, normalizeAccent, themeCss, themeVars } from "../lib/themeColor.js";
import { definePreference } from "./preference.js";

export type ColorScheme = "light" | "dark";

const STORAGE_KEY = `ui-color-scheme`;
const DARK_ATTRIBUTE = `data-mode`;
const ACCENT_STORAGE_KEY = `ui-accent`;
/* The accent's ramps, pre-serialized. Written here purely so index.html's anti-flash script can restore them
 * before the first paint without shipping the colour maths twice, see themeCss. This file stays the source of
 * truth; the string is a cache of what the hex above implies, rewritten on every change. */
const ACCENT_VARS_KEY = `ui-accent-vars`;

/* Owns the active color scheme and accent colour as account preferences (composables/preference.ts), so both are
 * live in every window of the app at once: a scheme flipped on the settings page repaints the popped-out chat on
 * the second screen without it being reloaded.
 *
 * The scheme flips the `data-mode` attribute on <html>, which is the selector both the PrimeVue dark preset and
 * the role tokens key off, so a single write recolors PrimeVue components and Tailwind surfaces together.
 *
 * The accent is a colour rather than one of a handful of named themes, so it cannot be an attribute with a
 * stylesheet block behind it: it is written as inline custom properties on <html>, which beat the ramps
 * declared in primitive-colors.css and re-resolve every semantic scale, role token and Tailwind utility built
 * on them. (The same mechanism an imported VSCode theme already uses, one tier further down: this sets the
 * primitive RAMPS, an import overrides the chrome tokens on top and still wins.) */

const apply = (value: ColorScheme): void => {
    if (value === `dark`) {
        document.documentElement.setAttribute(DARK_ATTRIBUTE, `dark`);
    } else {
        document.documentElement.removeAttribute(DARK_ATTRIBUTE);
    }
};

/* THE SCHEME THE APP OPENS IN, off the attribute index.html ships (`data-mode="dark"`), read ONCE before
 * anything here has written to that element. Captured rather than consulted on demand, because from the first
 * change onward the attribute says what this window is SHOWING, which is no longer an answer about what is
 * stored: a preference that fell back to it would answer an inbound "nothing is stored any more" with the colour
 * already on screen and never return to the default at all. */
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
    // Property by property rather than a cssText assignment: an imported VSCode theme writes its own overrides
    // onto this same element, and replacing the whole declaration would drop them.
    for (const [name, colour] of Object.entries(themeVars(value))) {
        style.setProperty(name, colour);
    }
};

const accent: Ref<string> = definePreference<string>({
    key: ACCENT_STORAGE_KEY,
    // Through the same door a fresh pick goes through: anything that isn't a colour, a hand-edited value, a
    // leftover from another app, comes back as the default, and anything off the ladder is snapped onto it.
    // So `accent` holds one canonical spelling of a legal accent, whatever is in storage, and the picker can
    // tell which of its swatches is the live one by comparing strings.
    read: (raw) => (raw === null ? DEFAULT_ACCENT : normalizeAccent(raw)),
    write: (value) => value,
    apply: applyAccent,
});

/** Repaint the app in `hex` (`#rrggbb`), snapped to the accent's own lightness, and remember it. */
const setAccent = (hex: string): void => {
    const value = normalizeAccent(hex);
    accent.value = value;
    /* The anti-flash cache, refreshed by the window the colour was PICKED in rather than by every window that
     * hears about it. It is one key for the origin and a pure function of the hex beside it, so the window that
     * wrote the hex is the one that owes the cache; a window adopting the change has nothing to add to it. */
    try {
        localStorage.setItem(ACCENT_VARS_KEY, themeCss(value));
    } catch {
        // Storage may be unavailable (private mode); the colour still applies, it just flashes on next boot.
    }
};

export function useTheme() {
    return { scheme, set, toggle, accent, setAccent };
}
