import { tv } from "tailwind-variants";

/* THE ACTION BUTTON'S VOCABULARY, DOM-free so a caller can name a tier without pulling in the SFC.

   Four tiers, ranked, and the tone is a colour laid on a tier rather than a fifth one:
   - `loud`: solid accent fill, the paid-relationship action. At most one per page. `gilded` casts it in the house
     gold, for the one action that moves the workspace up a version (the update card's), and nowhere else: gold spent
     on everything stops meaning anything.
   - `accent` (the default): tinted accent, the commit action (New, Create, Land).
   - `boring`: neutral fill, accent's silhouette, the app's one spelling of a non-primary action.
   - `quiet`: no chrome (Cancel, Dismiss). Neutral ink unless a tone says otherwise.
   Size follows the surface, not importance: `size="small"` (26px) on any dense surface, no `size` (38px) standing
   alone on a page or dialog.

   PrimeVue draws the button and primeng.css styles it by PrimeVue's own classes (`p-button-secondary`, `p-button-text`)
   and the kit's (`ui-button-loud`). This file is the only place that knows which of those a tier is, so a call site
   says what the button IS, and `_tools/checks/button-tiers.mjs` refuses `severity`, `text` and `ui-button-*` written
   on a <Button> in this repository. Installed extensions still pass them, and Button.vue still honours them. */

export type ButtonTier = `loud` | `accent` | `boring` | `quiet`;

/** `accent` is the brand colour: the accent tier's own, and the ink a quiet button takes when it should read as a
 *  link-coloured action rather than a neutral one. */
export type ButtonTone = `accent` | `danger` | `warning` | `success`;

export interface ButtonLook {
    readonly tier?: ButtonTier | undefined;
    readonly tone?: ButtonTone | undefined;
    readonly gilded?: boolean | undefined;
    readonly thumb?: boolean | undefined;
}

/** What PrimeVue is handed for a look: its own props, and the kit's classes on top. */
export interface PrimeLook {
    readonly severity: string | undefined;
    readonly text: boolean;
    readonly class: string;
}

// PrimeVue 4 emits `warn`; `severity="warning"` matches no rule in primeng.css and would paint in the brand colour.
const SEVERITY: Record<ButtonTone, string | undefined> = {
    accent: undefined,
    danger: `danger`,
    warning: `warn`,
    success: `success`,
};

const lookClass = tv({
    variants: {
        tier: { loud: `ui-button-loud`, accent: ``, boring: ``, quiet: `` },
        // Only ever beside the loud tier: primeLook makes a gilded button loud.
        gilded: { true: `ui-button-gilded` },
        // The 44px coarse-pointer target for a compact button a thumb has to find (primeng.css).
        thumb: { true: `ui-button-thumb` },
    },
});

// The severity PrimeVue draws a tier and a tone with: boring is always the neutral fill, a quiet button is neutral ink
// unless a tone colours it, accent takes its tone's tint, and loud's look is the kit's own class.
const severityOf = (tier: ButtonTier, tone: ButtonTone | undefined): string | undefined => {
    if (tier === `boring` || (tier === `quiet` && tone === undefined)) {
        return `secondary`;
    }
    return tier === `loud` || tone === undefined ? undefined : SEVERITY[tone];
};

/** The PrimeVue props and kit classes a tier and a tone come to. */
export const primeLook = ({ tier = `accent`, tone, gilded = false, thumb = false }: ButtonLook): PrimeLook => {
    const shown: ButtonTier = gilded ? `loud` : tier;
    return { severity: severityOf(shown, tone), text: shown === `quiet`, class: lookClass({ tier: shown, gilded, thumb }) ?? `` };
};
