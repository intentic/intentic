// The keyboard's step over the visible row order (visibleRows.map(r => r.entry.path)); pure, so it runs without Vue.

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
