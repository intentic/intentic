import { tv } from "tailwind-variants";

/* DOM-free button tiers: loud is the single primary paid action; gilded is reserved for workspace updates.
 * accent (default) commits, boring is neutral-filled secondary, quiet is chromeless. Size follows density: small 26px, default 38px.
 * Centralize PrimeVue/kit class mapping here; button-tiers.mjs rejects severity/text/ui-button-* at repository call sites.
 * Button.vue still honors those legacy forms for installed extensions. */

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
