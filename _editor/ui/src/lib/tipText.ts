import type { Tip, TooltipValue } from "./tooltip.js";

/** Whether a tooltip is a tip card rather than a one- or two-word label. */
export const isTip = (value: TooltipValue): value is Tip => typeof value === `object` && value !== null;

/** A tooltip as one line of text, for an accessible name: a label as it is, a tip card as its headline and figures. */
export const tipText = (value: TooltipValue): string | undefined => {
    if (!isTip(value)) {
        return value === false || value === null || value === undefined || value.trim() === `` ? undefined : value;
    }
    if (value.title.trim() === ``) {
        return undefined;
    }
    const rows = (value.rows ?? [])
        .filter((row) => row.label.trim() !== `` && String(row.value).trim() !== ``)
        .map((row) => `${row.label} ${row.value}`);
    return [value.title, ...rows, value.note ?? ``].filter((part) => part.trim() !== ``).join(`, `);
};
