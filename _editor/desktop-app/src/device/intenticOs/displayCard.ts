import type { IntenticOsDisplay, IntenticOsDisplayMode } from "@intentic/sandbox-contract/schemas/intentic-os";

// THE SCREENS, READ (src-tauri/src/os_settings.rs runs `ic os display`, settings.ts holds them, DisplayCard.vue draws
// them): what a person calls each screen rather than its connector, the sizes it offers with the rates each redraws at,
// the mode a pick comes to, and how much bigger everything is drawn. Pure, so each case is tested by value
// (displayCard.test.ts).

/** How long a new mode or size waits for "Keep" before going back by itself: a screen that went black cannot be read to
 *  undo it. */
export const DISPLAY_TRIAL_MS = 15_000;

/** The sizes the picker offers, as every desktop offers them. A size the screen already has outside these is offered too. */
const SCALES: readonly number[] = [1, 1.25, 1.5, 1.75, 2];

/** Two rates are one where they differ by less than a hundredth: 59.999 is 60. */
const sameRate = (one: number, other: number): boolean => Math.abs(one - other) < 0.01;

export const sameMode = (one: IntenticOsDisplayMode, other: IntenticOsDisplayMode): boolean =>
    one.width === other.width && one.height === other.height && sameRate(one.refresh, other.refresh);

/** The screen built into a laptop or a tablet, which its connector says (`eDP-1`, `LVDS-1`, `DSI-1`). */
export const isBuiltIn = (display: IntenticOsDisplay): boolean => /^(?:eDP|LVDS|DSI)-/iu.test(display.name);

/** What a person calls a screen: the built-in one as such, else its model (a bare hex code says nothing), else its maker,
 *  else nothing, and the card numbers it. */
export type ScreenName = { readonly kind: `builtIn` } | { readonly kind: `named`; readonly name: string } | { readonly kind: `unnamed` };

const HEX_CODE = /^0x[\da-f]+$/iu;

export const screenNameOf = (display: IntenticOsDisplay): ScreenName => {
    if (isBuiltIn(display)) {
        return { kind: `builtIn` };
    }
    const model = display.model?.trim() ?? ``;
    if (model !== `` && !HEX_CODE.test(model)) {
        return { kind: `named`, name: model };
    }
    const make = display.make?.trim() ?? ``;
    return make === `` ? { kind: `unnamed` } : { kind: `named`, name: make };
};

/** One size a screen offers, with every rate it redraws at in it, fastest first. */
export interface Resolution {
    readonly key: string;
    readonly width: number;
    readonly height: number;
    readonly rates: readonly number[];
}

export const resolutionKeyOf = (mode: { readonly width: number; readonly height: number }): string => `${mode.width}x${mode.height}`;

/** Every size the screen offers, the most pixels first, each rate once. */
export const resolutionsOf = (display: IntenticOsDisplay): readonly Resolution[] => {
    const sizes = new Map<string, { width: number; height: number; rates: number[] }>();
    for (const mode of display.modes) {
        const key = resolutionKeyOf(mode);
        const size = sizes.get(key) ?? { width: mode.width, height: mode.height, rates: [] };
        if (!size.rates.some((rate) => sameRate(rate, mode.refresh))) {
            size.rates.push(mode.refresh);
        }
        sizes.set(key, size);
    }
    return [...sizes.entries()]
        .map(([key, size]) => ({ key, width: size.width, height: size.height, rates: size.rates.sort((one, other) => other - one) }))
        .sort((one, other) => other.width * other.height - one.width * one.height);
};

/** The size a screen shows sharpest: its largest, which is what it is built for. */
export const recommendedOf = (display: IntenticOsDisplay): string | undefined => resolutionsOf(display)[0]?.key;

/** A rate as a person reads it: two decimals at most, none where it is whole (`60`, `59.94`). */
export const rateLabelOf = (refresh: number): string => String(Number(refresh.toFixed(2)));

/** A rate as the picker keys it: three decimals, as ic writes it. */
export const rateKeyOf = (refresh: number): string => String(Number(refresh.toFixed(3)));

/** The mode a pick of another size comes to: the rate the screen runs at now where the size offers it, else its fastest. */
export const modeForSize = (display: IntenticOsDisplay, key: string): IntenticOsDisplayMode | undefined => {
    const size = resolutionsOf(display).find((resolution) => resolution.key === key);
    if (size === undefined) {
        return undefined;
    }
    const current = display.current?.refresh;
    const rate = (current === undefined ? undefined : size.rates.find((each) => sameRate(each, current))) ?? size.rates[0];
    return rate === undefined ? undefined : { width: size.width, height: size.height, refresh: rate };
};

/** The mode a pick of another rate comes to, at the size the screen shows now. */
export const modeForRate = (display: IntenticOsDisplay, key: string): IntenticOsDisplayMode | undefined => {
    const current = display.current;
    if (current === null) {
        return undefined;
    }
    const mode = display.modes.find((each) => each.width === current.width && each.height === current.height && rateKeyOf(each.refresh) === key);
    return mode === undefined ? undefined : { width: mode.width, height: mode.height, refresh: mode.refresh };
};

/** A size as a percentage, as the picker says it (`150%`). */
export const percentOf = (scale: number): number => Math.round(scale * 100);

/** The sizes offered for a screen: the usual five, and the one it has where that is none of them. */
export const scalesFor = (current: number | null): readonly number[] =>
    current === null || SCALES.some((scale) => Math.abs(scale - current) < 0.005) ? SCALES : [...SCALES, current].sort((one, other) => one - other);

/** A scale as the size picker keys it: its percentage. None while the screen is off. */
export const scaleKeyOf = (scale: number | null): string | undefined => (scale === null ? undefined : String(percentOf(scale)));
