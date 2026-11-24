import { nearestSwatch, SWATCHES, swatchHex } from "@intentic/ui";
import { readLogoStyle } from "./presets";

// A SANDBOX'S OWN COLOUR, the one its rail, wallpaper and composer are tinted with so two sandboxes open side by side are
// told apart at a glance (useSandboxColor.ts paints it). It is the sandbox's, set by its owner and the same for
// every member, never a reader's preference: a teammate's "the teal one" has to be teal for everyone.
//
// Every sandbox has one, picked or not, so the cue works from the first day:
// 1. the owner's pick (`color` on the platform's row);
// 2. else the colour of its preset logo (logo/presets.ts), the one colour the owner already chose for it;
// 3. else one derived from its id, stable across browsers and sessions with nothing stored.
// Each lands on the nearest of the picker's swatches, so whatever arrives reads at the same strength in light and dark,
// and the picker can always say which one is worn.

// The derived colour comes from the hued swatches only: graphite is a near-grey, and a sandbox nobody coloured should
// still read as a colour.
const DERIVED = SWATCHES.filter((swatch) => swatch.key !== `graphite`).map(swatchHex);

const HEX = /^#[0-9a-f]{6}$/iu;

const seeded = (seed: string): string => {
    let hash = 0;
    for (const char of seed) {
        hash = (hash * 31 + char.charCodeAt(0)) | 0;
    }
    return DERIVED[Math.abs(hash) % DERIVED.length]!;
};

/** What a sandbox row carries that its colour can come from. */
export interface ColoredSandbox {
    readonly id: string;
    readonly color?: string | null | undefined;
    readonly image?: string | null | undefined;
}

/** The colour a sandbox is painted in, as `#rrggbb` on the swatch ladder. */
export const sandboxColor = (sandbox: ColoredSandbox): string => {
    const picked = sandbox.color ?? ``;
    if (HEX.test(picked)) {
        return nearestSwatch(picked);
    }
    const preset = readLogoStyle(sandbox.image);
    return preset === undefined ? seeded(sandbox.id) : nearestSwatch(preset.color);
};
