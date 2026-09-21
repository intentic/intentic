import type { ImageMetadata } from "astro";

// Shots from capture.mts, in src/assets/ not public/, so astro:assets emits a hashed, right-sized WebP ladder.
// There are two sets, one per skin, paired by filename: the dark set is the app wearing the Sanctum skin (the
// site's own carved design), the light set is the app unskinned in its light scheme — which is the theme the maker
// pages are built from. Sanctum cannot be light; its own README says turning it on forces the dark scheme.
const files = import.meta.glob<{ default: ImageMetadata }>("../assets/product/*.png", { eager: true });
const lightFiles = import.meta.glob<{ default: ImageMetadata }>("../assets/product-light/*.png", { eager: true });

export function shotAsset(name: string): ImageMetadata {
    const file = files[`../assets/product/${name}.png`];
    if (file === undefined) {
        throw new Error(`No screenshot named "${name}": capture.mts writes them to src/assets/product/.`);
    }
    return file.default;
}

/** Both skins' copies of one shot. Every shot needs both; a missing twin is a capture run that did not finish. */
export function shotPair(name: string): { dark: ImageMetadata; light: ImageMetadata } {
    return { dark: shotAsset(name), light: lightShot(name) };
}

/**
 * One picture from the light set alone: a default shot's light twin, or a shot of the maker recording (`maker-*`,
 * `capture.mts --maker`), which has no dark twin because the maker product's page is only ever light.
 */
export function lightShot(name: string): ImageMetadata {
    const light = lightFiles[`../assets/product-light/${name}.png`];
    if (light === undefined) {
        throw new Error(
            `No light screenshot named "${name}". Write it with:\n` +
                `  node --experimental-strip-types _tools/e2e/shots/capture.mts ${name.startsWith(`maker-`) ? `--maker` : `--light`} ${name}`,
        );
    }
    return light.default;
}

// Srcset rungs, spaced to avoid wasted variants; top rung matches capture.mts's own max width, never upscaled.
export const SHOT_WIDTHS = [480, 768, 1024, 1440, 1920, 2560];

// The two column widths every page shares, as `sizes` values; both derive from the one shared layout shell.
export const COLUMN_SIZES = "(min-width: 80rem) 1232px, calc(100vw - 3rem)";
export const HALF_COLUMN_SIZES = "(min-width: 80rem) 588px, (min-width: 64rem) calc((100vw - 6.5rem) / 2), calc(100vw - 3rem)";
