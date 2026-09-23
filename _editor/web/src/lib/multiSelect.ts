// A click on a multi-selectable row: Shift ranges from an anchor, Ctrl or Cmd toggles, anything else takes it alone.
export type ClickIntent = `range` | `toggle` | `single`;

// `anchored` is false where there is nothing to range from, and then Shift reads as the keys held beside it.
export const clickIntent = (keys: Pick<MouseEvent, `shiftKey` | `ctrlKey` | `metaKey`>, anchored = true): ClickIntent =>
    keys.shiftKey && anchored ? `range` : keys.ctrlKey || keys.metaKey ? `toggle` : `single`;

// Anchor to row inclusive, either way round; the row alone for an unlisted anchor, undefined for an unlisted row.
export const rangeSelect = <T>(order: readonly T[], anchor: T | undefined, row: T): T[] | undefined => {
    const to = order.indexOf(row);
    if (to === -1) {
        return undefined;
    }
    const from = anchor === undefined ? -1 : order.indexOf(anchor);
    return from === -1 ? [row] : order.slice(Math.min(from, to), Math.max(from, to) + 1);
};
