import type { Ref } from "vue";
import { definePreference } from "@intentic/ui/preference";
import { useTheme } from "@intentic/ui/theme";

// A skin (`sanctum` or `none`) is the workspace's whole look, applied as one `data-skin` attribute on <html>; a skin's
// CSS is scoped to `[data-skin=...]`, so `none` writes no attribute. Turning a skin on forces the dark scheme and
// leaves it dark when turned off. Its webfont <link> loads only while that skin is active.

export type Skin = "none" | "sanctum";

const STORAGE_KEY = `ui-skin`;
const ATTRIBUTE = `data-skin`;
const FONT_ELEMENT_ID = `ui-skin-font`;

// One entry per skin with its own webfont: Baloo 2 for headings, Playfair Display for the display heading.
const FONT_HREF: Partial<Record<Skin, string>> = {
    sanctum: `https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;600;700&family=Playfair+Display:wght@600&display=swap`,
};

const isSkin = (value: unknown): value is Skin => value === `none` || value === `sanctum`;

/** Point the skin webfont <link> at `value`'s face, or drop it when the skin wants none. */
const applyFont = (value: Skin): void => {
    const href = FONT_HREF[value];
    const existing = document.getElementById(FONT_ELEMENT_ID);
    if (href === undefined) {
        existing?.remove();
        return;
    }
    // Re-pointed rather than replaced, so switching skins never leaves two links, and reapplying costs nothing.
    if (existing instanceof HTMLLinkElement) {
        if (existing.href !== href) {
            existing.href = href;
        }
        return;
    }
    const link = document.createElement(`link`);
    link.id = FONT_ELEMENT_ID;
    link.rel = `stylesheet`;
    link.href = href;
    document.head.append(link);
};

const apply = (value: Skin): void => {
    if (value === `none`) {
        document.documentElement.removeAttribute(ATTRIBUTE);
    } else {
        document.documentElement.setAttribute(ATTRIBUTE, value);
    }
    applyFont(value);
};

// The skin index.html's anti-flash script already set on <html>, read once before this module writes anything; captured
// rather than re-read, since the attribute reflects what's applied, not what's stored.
const bootAttribute = document.documentElement.getAttribute(ATTRIBUTE);
const BOOT_SKIN: Skin = isSkin(bootAttribute) ? bootAttribute : `sanctum`;

const skin: Ref<Skin> = definePreference<Skin>({
    key: STORAGE_KEY,
    read: (raw) => (isSkin(raw) ? raw : BOOT_SKIN),
    write: (value) => value,
    apply,
});

const setSkin = (value: Skin): void => {
    skin.value = value;
    // Dark is forced only in the window that made the change; other windows learn the scheme via useTheme's own
    // preference write, not by re-deriving it in `apply`, or every window would redundantly rewrite it.
    if (value !== `none`) {
        useTheme().set(`dark`);
    }
};

export function useSkin() {
    return { skin, setSkin };
}
