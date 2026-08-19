import { ref, type Ref } from "vue";
import { useTheme } from "@intentic/ui";

/* THE SKIN — which whole-interface look the workspace wears, as opposed to which COLOUR it is painted in.
 *
 * The accent picker and the light/dark switch both answer "what colour"; a skin answers "what is this thing made
 * of". `none` is the app as designed. `hud` is the heads-up display in skins/hud.css — deep cool glass over a
 * survey grid, lit hairlines, corner brackets, angular geometry.
 *
 * ONE ATTRIBUTE ON <html>, and that is the entire mechanism. Every rule in the skin's stylesheet is scoped to
 * `[data-skin="hud"]`, so the workspace's normal look is not a set of overrides being undone — it is the skin's
 * rules never matching at all. `none` therefore writes no attribute, which keeps the markup quiet for the look
 * almost everyone runs and makes "is a skin on?" answerable by looking at the element.
 *
 * A SKIN IMPLIES A SCHEME. The HUD is a dark instrument panel: its ground, its glass and its glow are all built
 * for a near-black canvas, and PrimeVue's own component preset keys its dark treatment off `data-mode` rather
 * than off anything this file controls. So turning the skin on turns the scheme dark with it — one call, here,
 * rather than a stylesheet trying to out-shout a component library. The scheme the user had is not remembered
 * across that: leaving the skin leaves them in dark, which is where they can see they are.
 *
 * THE DISPLAY FACE IS FETCHED ON DEMAND. Chakra Petch is the skin's headings and nothing else, and an app that
 * downloads a font for a look nobody has selected is an app that charges everyone for one person's taste. The
 * <link> is appended when the skin goes on and removed when it goes off; if it never arrives, --hud-display
 * falls through to the app's own stack and the skin simply reads in Inter. */

export type Skin = "none" | "hud";

const STORAGE_KEY = `ui-skin`;
const ATTRIBUTE = `data-skin`;
const FONT_ELEMENT_ID = `ui-skin-font`;
const FONT_HREF = `https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;500;600;700&display=swap`;

const isSkin = (value: unknown): value is Skin => value === `none` || value === `hud`;

const read = (): Skin => {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (isSkin(stored)) {
            return stored;
        }
    } catch {
        // Storage may be unavailable (private mode); fall back to whatever the anti-flash script left on <html>.
    }
    const attribute = document.documentElement.getAttribute(ATTRIBUTE);
    return isSkin(attribute) ? attribute : `none`;
};

/** Add or drop the skin's webfont <link>. Idempotent, so re-applying the same skin costs nothing. */
const applyFont = (value: Skin): void => {
    const existing = document.getElementById(FONT_ELEMENT_ID);
    if (value === `none`) {
        existing?.remove();
        return;
    }
    if (existing !== null) {
        return;
    }
    const link = document.createElement(`link`);
    link.id = FONT_ELEMENT_ID;
    link.rel = `stylesheet`;
    link.href = FONT_HREF;
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

const skin: Ref<Skin> = ref(read());
apply(skin.value); // restore the saved skin on load (index.html only beats the flash)

const setSkin = (value: Skin): void => {
    skin.value = value;
    apply(value);
    if (value !== `none`) {
        useTheme().set(`dark`);
    }
    try {
        localStorage.setItem(STORAGE_KEY, value);
    } catch {
        // Storage may be unavailable (private mode); the in-memory ref still holds.
    }
};

export function useSkin() {
    return { skin, setSkin };
}
