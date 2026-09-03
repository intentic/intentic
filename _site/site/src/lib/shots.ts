import type { ImageMetadata } from "astro";

/* Every screenshot `_tools/e2e/shots/capture.mts` wrote, under the shot name the harness gave it, which is
 * the only handle the content packages carry.
 *
 * They live in src/assets/ rather than public/ because a file in public/ ships byte-for-byte: a visitor was
 * downloading a 2144px-wide PNG to paint 900 of those pixels, most of a megabyte on the landing page alone.
 * From src/ the build owns them: astro:assets emits a WebP ladder per shot at content-hashed URLs, and every
 * component says with `sizes` how wide its layout actually paints the thing, so the browser fetches the rung
 * that fits and no more.
 *
 * Eager, because a shot's intrinsic size decides the layout around it: a portrait hero gets a narrow column,
 * a 3:2-or-wider capture takes the whole one, and that decision is made while the page renders. */
const files = import.meta.glob<{ default: ImageMetadata }>("../assets/product/*.png", { eager: true });

export function shotAsset(name: string): ImageMetadata {
    const file = files[`../assets/product/${name}.png`];
    if (file === undefined) {
        throw new Error(`No screenshot named "${name}": capture.mts writes them to src/assets/product/.`);
    }
    return file.default;
}

/* The rungs of every shot's srcset. Far enough apart that no page ships a variant it will never serve, close
 * enough that a phone at 2× and a laptop at 1× each land within a few percent of what they paint. One list for
 * every shot: astro:assets drops the rungs a given file cannot reach and closes the ladder at its real width,
 * so a portrait capture closes early rather than being upscaled into a blurry 1920.
 *
 * THE TOP RUNG IS 2560, AND IT IS FOR RETINA AT FULL-COLUMN WIDTH. The ladder used to close at 1920, which
 * meant a full-column shot on a 2× display — 1232px on the docs and feature pages, 1296 on the home page's
 * verb stages — asked for around 2500 and got 1920. That is a picture drawn a third larger than the pixels
 * behind it, and on a screenshot whose whole job is being READ it shows, as soft type. 2560 is where the
 * captures themselves stop (`capture.mts` shoots 1760 at 1.5×), so this rung is the file itself and no shot
 * is ever upscaled to reach it. */
export const SHOT_WIDTHS = [480, 768, 1024, 1440, 1920, 2560];

/* The two column widths every page of this site shares, as the `sizes` a browser needs to pick a rung with.
 * Both come from the same shell: `mx-auto max-w-7xl px-6`, so a 1232px column once the viewport reaches 80rem
 * and the viewport minus its gutters below that, and the half is that column split by `lg:grid-cols-2
 * lg:gap-14`. Written here rather than at each call site because the shell is one decision, not five. */
export const COLUMN_SIZES = "(min-width: 80rem) 1232px, calc(100vw - 3rem)";
export const HALF_COLUMN_SIZES = "(min-width: 80rem) 588px, (min-width: 64rem) calc((100vw - 6.5rem) / 2), calc(100vw - 3rem)";
