import { type Ref } from "vue";
// The scheme singleton and the preference primitive off their own entry points rather than the barrel: this file
// is plain state on two attributes, and reaching them through @intentic/ui would drag the whole component graph
// (and mermaid, shiki and vue-flow behind it) into every module and unit test that only wants to know which skin
// is on.
import { definePreference } from "@intentic/ui/preference";
import { useTheme } from "@intentic/ui/theme";

/* THE SKIN, which whole-interface look the workspace wears, as opposed to which COLOUR it is painted in.
 *
 * The accent picker and the light/dark switch both answer "what colour"; a skin answers "what is this thing made
 * of". `none` is the app as designed. `hud` is the heads-up display in skins/hud.css, deep cool glass over a
 * survey grid, lit hairlines, angular geometry. `sanctum` is skins/sanctum.css, the SITE'S design system worn by
 * the app: warm ash stone with a whisper of tooth in it, a gold rule round everything, a flat unlit shadow for
 * the rail and the overlays, stone and bronze plaques for the two filled button tiers, and every edge eased.
 *
 * ONE ATTRIBUTE ON <html>, and that is the entire mechanism. Every rule in a skin's stylesheet is scoped to
 * `[data-skin="<name>"]`, so the workspace's normal look is not a set of overrides being undone, it is the
 * skin's rules never matching at all. `none` therefore writes no attribute, which keeps the markup quiet for the
 * look almost everyone runs and makes "is a skin on?" answerable by looking at the element.
 *
 * A SKIN IMPLIES A SCHEME. Both skins are dark by construction: their grounds, their materials and their light
 * are built for a near-black canvas, and PrimeVue's own component preset keys its dark treatment off `data-mode`
 * rather than off anything this file controls. So turning a skin on turns the scheme dark with it, one call,
 * here, rather than a stylesheet trying to out-shout a component library. The scheme the user had is not
 * remembered across that: leaving the skin leaves them in dark, which is where they can see they are.
 *
 * THE DISPLAY FACE IS FETCHED ON DEMAND, AND IT IS PER SKIN. A look's typography is part of the look, the HUD
 * wants an angular technical face, the Sanctum wants the site's own two, and an app that downloads either for a
 * skin nobody has selected is an app charging everyone for one person's taste. The <link> is swapped when the
 * skin changes and removed when there is none; if it never arrives, the skin's own font variables fall through
 * to the app's stack and everything still reads. */

export type Skin = "none" | "hud" | "sanctum";

const STORAGE_KEY = `ui-skin`;
const ATTRIBUTE = `data-skin`;
const FONT_ELEMENT_ID = `ui-skin-font`;

/* One entry per skin that wants a face of its own. The HUD takes Chakra Petch's angular technical caps. Sanctum
 * takes the SITE'S two faces: Baloo 2 for every heading and label in the chrome, Playfair Display for the one
 * heading in the app drawn at display size, so the workspace and the marketing pages are set in the same type.
 * A skin absent from this map simply loads nothing. */
const FONT_HREF: Partial<Record<Skin, string>> = {
    hud: `https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;500;600;700&display=swap`,
    sanctum: `https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;600;700&family=Playfair+Display:wght@600&display=swap`,
};

const isSkin = (value: unknown): value is Skin => value === `none` || value === `hud` || value === `sanctum`;

/** Point the skin webfont <link> at `value`'s face, or drop it when the skin wants none. */
const applyFont = (value: Skin): void => {
    const href = FONT_HREF[value];
    const existing = document.getElementById(FONT_ELEMENT_ID);
    if (href === undefined) {
        existing?.remove();
        return;
    }
    // Re-pointed rather than replaced, so switching between two skins that both want a face never leaves two
    // <link>s behind, and re-applying the same skin costs nothing at all.
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

/* The skin the app opens in: whatever index.html's anti-flash script left on <html>, read ONCE before anything
 * here writes it. That script reads this same key, so nothing stored means no attribute and no skin. Captured
 * rather than consulted on demand, for the reason useTheme's own boot value gives: after the first change the
 * attribute states what this window is WEARING, not what is stored. */
const bootAttribute = document.documentElement.getAttribute(ATTRIBUTE);
const BOOT_SKIN: Skin = isSkin(bootAttribute) ? bootAttribute : `none`;

const skin: Ref<Skin> = definePreference<Skin>({
    key: STORAGE_KEY,
    read: (raw) => (isSkin(raw) ? raw : BOOT_SKIN),
    write: (value) => value,
    apply,
});

const setSkin = (value: Skin): void => {
    skin.value = value;
    /* THE SCHEME GOES DARK WITH THE SKIN, in the window the skin was CHOSEN in, and only there. Every other
     * window learns the scheme the same way it learns the skin: `useTheme().set` is itself a preference write, so
     * the note that carries "the skin is now hud" is followed by the note that carries "the scheme is now dark",
     * and a window adopting them needs no rule of its own to connect the two. Putting the rule in `apply` above
     * would have every window that hears about a skin re-decide the scheme and write it back. */
    if (value !== `none`) {
        useTheme().set(`dark`);
    }
};

export function useSkin() {
    return { skin, setSkin };
}
