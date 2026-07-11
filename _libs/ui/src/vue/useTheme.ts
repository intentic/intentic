import { ref, type Ref } from "vue";

export type ColorScheme = "light" | "dark";
export type BrandTheme = "ember" | "carbon" | "meadow" | "honey";

const STORAGE_KEY = `ui-color-scheme`;
const DARK_ATTRIBUTE = `data-mode`;
const THEME_STORAGE_KEY = `ui-theme`;
const THEME_ATTRIBUTE = `data-theme`;

export const themes: BrandTheme[] = [`ember`, `carbon`, `meadow`, `honey`];

/* Owns the active color scheme and brand theme as module-level singletons. The scheme flips the
 * `data-mode` attribute on <html>, which is the selector both the PrimeVue dark preset and the role
 * tokens key off, so a single write recolors PrimeVue components and Tailwind surfaces together.
 * The brand theme flips `data-theme` (absent = ember), which themes.css keys off for token overrides. */

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

const isBrandTheme = (value: unknown): value is BrandTheme => themes.includes(value as BrandTheme);

const readTheme = (): BrandTheme => {
    try {
        const stored = localStorage.getItem(THEME_STORAGE_KEY);
        if (isBrandTheme(stored)) {
            return stored;
        }
    } catch {
        // Storage may be unavailable (private mode); fall back to the attribute.
    }
    const attribute = document.documentElement.getAttribute(THEME_ATTRIBUTE);
    return isBrandTheme(attribute) ? attribute : `ember`;
};

const applyTheme = (value: BrandTheme): void => {
    if (value === `ember`) {
        document.documentElement.removeAttribute(THEME_ATTRIBUTE);
    } else {
        document.documentElement.setAttribute(THEME_ATTRIBUTE, value);
    }
};

const theme: Ref<BrandTheme> = ref(readTheme());
applyTheme(theme.value);

const setTheme = (value: BrandTheme): void => {
    theme.value = value;
    applyTheme(value);
    try {
        localStorage.setItem(THEME_STORAGE_KEY, value);
    } catch {
        // Storage may be unavailable (private mode); the in-memory ref still holds.
    }
};

export function useTheme() {
    return { scheme, set, toggle, theme, setTheme, themes };
}
