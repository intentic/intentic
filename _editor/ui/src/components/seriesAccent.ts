import type { FigureAccent } from "../markdown/figures.js";

/* An authored figure accent → the design system's chart palette.
 *
 * The palette exposes five categorical slots plus `series-other`, an achromatic fold-to bucket for everything
 * past the fifth (semantic-colors.css). A figure names a slot rather than being handed one by position, so
 * dropping a node from a diagram cannot repaint its neighbours.
 *
 * Building the var name at runtime is safe HERE and nowhere by accident: those tokens live in an `@theme static`
 * block precisely because Tailwind only emits a theme variable it can SEE used, and a chart picks its slot at
 * runtime. That block's comment records what happened when they were not static — slots 3 and 4 vanished from
 * the bundle and painted nothing. */
export const seriesColor = (accent: FigureAccent | undefined): string => {
    if (accent === undefined) {
        // A single-series figure is the common case, and it takes slot 1: colour carries no information when
        // there is one series, so the only requirement is that it be the palette's first voice every time.
        return `var(--color-series-1)`;
    }
    return accent === `neutral` ? `var(--color-series-other)` : `var(--color-series-${accent})`;
};
