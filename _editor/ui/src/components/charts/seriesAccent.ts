import type { FigureAccent } from "../../markdown/figures.js";

// Maps an authored figure accent to the design system's five categorical chart slots, plus `series-other`, an
// achromatic fold for anything past the fifth. Building the var name at runtime is safe only because these tokens live
// in an `@theme static` block; Tailwind otherwise only emits variables it sees used statically.
export const seriesColor = (accent: FigureAccent | undefined): string => {
    if (accent === undefined) {
        // Single-series figures always take slot 1; color carries no information when there's only one series.
        return `var(--color-series-1)`;
    }
    return accent === `neutral` ? `var(--color-series-other)` : `var(--color-series-${accent})`;
};
