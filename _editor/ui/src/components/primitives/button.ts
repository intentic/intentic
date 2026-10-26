import { tv } from "tailwind-variants";

/* DOM-free button tiers. Bright means "the step we are asking you to take", so every call site names its tier, by
 * the first of these questions it answers yes to (button-tiers.mjs holds the repository to it, DesignKit shows it):
 *   quiet  — does it leave, cancel, dismiss, go back, show or hide? Chromeless. With tone danger: the press that only
 *            starts a removal, whose confirmation is the accent one.
 *   accent — does it complete what this surface is open for: a form's or dialog's submit, the yes to a question the
 *            app asked, the way forward from a failure, blocker or empty list? Brand fill, one at a time per surface.
 *   boring — everything else: a tool used when the reader chooses (scan, clean, rebuild, run, open, download, add to
 *            a list), and the alternatives beside the accent one. Neutral fill.
 *   loud   — the page's one paid or turn-it-on step; gilded is reserved for workspace updates.
 * Tones colour a tier: danger removes, warning risks, success ships. Size follows density: small 26px, default 38px.
 * Centralize PrimeVue/kit class mapping here; button-tiers.mjs rejects severity/text/ui-button-* at repository call sites.
 * Button.vue still honors those legacy forms, the accent default and the accent tone for installed extensions. */

export type ButtonTier = `loud` | `accent` | `boring` | `quiet`;

/** `danger` removes, `warning` risks, `success` ships. `accent` is retired in the repository (a link is
 *  `ui.textButton()`); installed extensions built against it still get the brand-coloured quiet button. */
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
