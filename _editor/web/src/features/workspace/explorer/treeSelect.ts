// Pure selection math over the visible (flattened) row order, no Vue, so it's unit-checkable
// (see scripts/treeSelect.check.mjs). `order` is visibleRows.map(r => r.entry.path).

// The inclusive range of paths between the anchor and the lead, in visible order (VSCode Shift-select). Falls back
// to just the lead if either endpoint has scrolled out of the visible set (e.g. a collapsed branch).
export const selectRange = (order: readonly string[], anchor: string, lead: string): string[] => {
    const a = order.indexOf(anchor);
    const b = order.indexOf(lead);
    if (a === -1 || b === -1) {
        return [lead];
    }
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    return order.slice(lo, hi + 1);
};

// The next lead after moving `delta` rows (arrow keys), clamped to the ends. From no lead, an initial down/up lands
// on the first/last row.
export const stepLead = (order: readonly string[], lead: string | null, delta: number): string | null => {
    if (order.length === 0) {
        return null;
    }
    const i = lead === null ? -1 : order.indexOf(lead);
    if (i === -1) {
        return (delta > 0 ? order[0] : order.at(-1)) ?? null;
    }
    return order[Math.min(order.length - 1, Math.max(0, i + delta))] ?? null;
};
