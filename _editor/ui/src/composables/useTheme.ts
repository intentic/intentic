import { ref, type Ref } from "vue";
import { DEFAULT_ACCENT, normalizeAccent, themeCss, themeVars } from "../themeColor.js";

export type ColorScheme = "light" | "dark";

const STORAGE_KEY = `ui-color-scheme`;
const DARK_ATTRIBUTE = `data-mode`;
const ACCENT_STORAGE_KEY = `ui-accent`;
/* The accent's ramps, pre-serialized. Written here purely so index.html's anti-flash script can restore them
 * before the first paint without shipping the colour maths twice — see themeCss. This file stays the source of
 * truth; the string is a cache of what the hex above implies, rewritten on every change. */
const ACCENT_VARS_KEY = `ui-accent-vars`;

/* Owns the active color scheme and accent colour as module-level singletons. The scheme flips the `data-mode`
 * attribute on <html>, which is the selector both the PrimeVue dark preset and the role tokens key off, so a
 * single write recolors PrimeVue components and Tailwind surfaces together.
 *
 * The accent is a colour rather than one of a handful of named themes, so it cannot be an attribute with a
 * stylesheet block behind it: it is written as inline custom properties on <html>, which beat the ramps
 * declared in primitive-colors.css and re-resolve every semantic scale, role token and Tailwind utility built
 * on them. (The same mechanism an imported VSCode theme already uses, one tier further down: this sets the
 * primitive RAMPS, an import overrides the chrome tokens on top and still wins.) */

const read = (): ColorScheme => {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored === `light` || stored === `dark`) {
            return stored;
        }
    } catch {
        // Storage may be unavailable (private mode); fall back to the attribute.
    }
    return document.documentElement.getAttribute(DARK_ATTRIBUTE) ? `dark` : `light`;
};

const apply = (value: ColorScheme): void => {
    if (value === `dark`) {
        document.documentElement.setAttribute(DARK_ATTRIBUTE, `dark`);
    } else {
        document.documentElement.removeAttribute(DARK_ATTRIBUTE);
    }
};

const scheme: Ref<ColorScheme> = ref(read());
apply(scheme.value); // restore the saved scheme when the design system loads (was the service constructor)

const set = (value: ColorScheme): void => {
    scheme.value = value;
    apply(value);
    try {
        localStorage.setItem(STORAGE_KEY, value);
    } catch {
        // Storage may be unavailable (private mode); the in-memory ref still holds.
    }
};

const toggle = (): void => {
    set(scheme.value === `dark` ? `light` : `dark`);
};

const readAccentSetting = (): string => {
    try {
        const stored = localStorage.getItem(ACCENT_STORAGE_KEY);
        // Anything that isn't a colour — a hand-edited value, a leftover from another app — reads as the default.
        if (stored !== null && /^#[0-9a-fA-F]{6}$/.test(stored)) {
            return stored;
        }
    } catch {
        // Storage may be unavailable (private mode); the default accent stands.
    }
    return DEFAULT_ACCENT;
};

const applyAccent = (value: string): void => {
    const style = document.documentElement.style;
    // Property by property rather than a cssText assignment: an imported VSCode theme writes its own overrides
    // onto this same element, and replacing the whole declaration would drop them.
    for (const [name, colour] of Object.entries(themeVars(value))) {
        style.setProperty(name, colour);
    }
};

const accent: Ref<string> = ref(readAccentSetting());
applyAccent(accent.value);

/** Repaint the app in `hex` (`#rrggbb`), snapped to the accent's own lightness, and remember it. */
const setAccent = (hex: string): void => {
    const value = normalizeAccent(hex);
    accent.value = value;
    applyAccent(value);
    try {
        localStorage.setItem(ACCENT_STORAGE_KEY, value);
        localStorage.setItem(ACCENT_VARS_KEY, themeCss(value));
    } catch {
        // Storage may be unavailable (private mode); the in-memory ref still holds.
    }
};

export function useTheme() {
    return { scheme, set, toggle, accent, setAccent };
}
