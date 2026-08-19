import { ref, type Ref } from "vue";
import { useTheme } from "@intentic/ui";

/* THE SKIN — which whole-interface look the workspace wears, as opposed to which COLOUR it is painted in.
 *
 * The accent picker and the light/dark switch both answer "what colour"; a skin answers "what is this thing made
 * of". `none` is the app as designed. `hud` is the heads-up display in skins/hud.css — deep cool glass over a
 * survey grid, lit hairlines, angular geometry. `sanctum` is skins/sanctum.css — flat carved stone, a gilded
 * hairline and an inner moulding round every plate, and inscriptional capitals.
 *
 * ONE ATTRIBUTE ON <html>, and that is the entire mechanism. Every rule in a skin's stylesheet is scoped to
 * `[data-skin="<name>"]`, so the workspace's normal look is not a set of overrides being undone — it is the
 * skin's rules never matching at all. `none` therefore writes no attribute, which keeps the markup quiet for the
 * look almost everyone runs and makes "is a skin on?" answerable by looking at the element.
 *
 * A SKIN IMPLIES A SCHEME. Both skins are dark by construction: their grounds, their materials and their light
 * are built for a near-black canvas, and PrimeVue's own component preset keys its dark treatment off `data-mode`
 * rather than off anything this file controls. So turning a skin on turns the scheme dark with it — one call,
 * here, rather than a stylesheet trying to out-shout a component library. The scheme the user had is not
 * remembered across that: leaving the skin leaves them in dark, which is where they can see they are.
 *
 * THE DISPLAY FACE IS FETCHED ON DEMAND, AND IT IS PER SKIN. A look's typography is part of the look — the HUD
 * wants an angular technical face, the Sanctum wants Roman capitals cut in stone — and an app that downloads
 * either for a skin nobody has selected is an app charging everyone for one person's taste. The <link> is
 * swapped when the skin changes and removed when there is none; if it never arrives, the skin's `--*-display`
 * variable falls through to the app's own stack and everything still reads. */

export type Skin = "none" | "hud" | "sanctum";

const STORAGE_KEY = `ui-skin`;
const ATTRIBUTE = `data-skin`;
const FONT_ELEMENT_ID = `ui-skin-font`;

/* One entry per skin that wants a face of its own. Sanctum takes Cinzel — an inscriptional Roman capital, which
 * is the closest a webfont gets to letters cut into a wall — and the HUD takes Chakra Petch's angular technical
 * caps. A skin absent from this map simply loads nothing. */
const FONT_HREF: Partial<Record<Skin, string>> = {
    hud: `https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;500;600;700&display=swap`,
    sanctum: `https://fonts.googleapis.com/css2?family=Cinzel:wght@400;500;600;700&display=swap`,
};

const isSkin = (value: unknown): value is Skin => value === `none` || value === `hud` || value === `sanctum`;

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

/** Point the skin webfont <link> at `value`'s face, or drop it when the skin wants none. */
const applyFont = (value: Skin): void => {
    const href = FONT_HREF[value];
    const existing = document.getElementById(FONT_ELEMENT_ID);
    if (href === undefined) {
        existing?.remove();
        return;
    }
    // Re-pointed rather than replaced, so switching between two skins that both want a face never leaves two
    // <link>s behind — and re-applying the same skin costs nothing at all.
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
