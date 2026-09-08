import type { ImageMetadata } from "astro";

// Shots from capture.mts, in src/assets/ not public/, so astro:assets emits a hashed, right-sized WebP ladder.
const files = import.meta.glob<{ default: ImageMetadata }>("../assets/product/*.png", { eager: true });

export function shotAsset(name: string): ImageMetadata {
    const file = files[`../assets/product/${name}.png`];
    if (file === undefined) {
        throw new Error(`No screenshot named "${name}": capture.mts writes them to src/assets/product/.`);
    }
    return file.default;
}

// Srcset rungs, spaced to avoid wasted variants; top rung matches capture.mts's own max width, never upscaled.
export const SHOT_WIDTHS = [480, 768, 1024, 1440, 1920, 2560];

// The two column widths every page shares, as `sizes` values; both derive from the one shared layout shell.
export const COLUMN_SIZES = "(min-width: 80rem) 1232px, calc(100vw - 3rem)";
export const HALF_COLUMN_SIZES = "(min-width: 80rem) 588px, (min-width: 64rem) calc((100vw - 6.5rem) / 2), calc(100vw - 3rem)";
