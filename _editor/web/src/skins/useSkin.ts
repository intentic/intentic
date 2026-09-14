import type { Ref } from "vue";
import { definePreference } from "@intentic/ui/preference";
import { useTheme } from "@intentic/ui/theme";

// A skin (`sanctum` or `none`) is the workspace's whole look, applied as one `data-skin` attribute on <html>; a skin's
// CSS is scoped to `[data-skin=...]`, so `none` writes no attribute. Turning a skin on forces the dark scheme and
// leaves it dark when turned off. A skin used to fetch its own webfont as it was applied; every face the app uses is
// served from this origin now (src/styles/faces.css), so there is nothing left for a skin to load.

export type Skin = "none" | "sanctum";

const STORAGE_KEY = `ui-skin`;
const ATTRIBUTE = `data-skin`;
const isSkin = (value: unknown): value is Skin => value === `none` || value === `sanctum`;

const apply = (value: Skin): void => {
    if (value === `none`) {
        document.documentElement.removeAttribute(ATTRIBUTE);
    } else {
        document.documentElement.setAttribute(ATTRIBUTE, value);
    }
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
