// A window's tabs in the order its strip shows them. Chromium keeps an order of its own, which nobody sees (the picture
// is the page alone, never Chromium's strip), so the daemon's is the one every viewer draws and the one a restore
// reopens: kept as the order of the window's page map, which is otherwise the order the tabs opened in.

// Moves one entry of an insertion-ordered map to `index` among the entries `counts` keeps (the open tabs, not the closed
// ones a finished window still lists), in place: an index past the last of them puts it after the last. Answers whether
// anything moved.
export const moveEntry = <V>(map: Map<string, V>, id: string, index: number, counts: (value: V) => boolean = () => true): boolean => {
    const moved = map.get(id);
    if (moved === undefined) {
        return false;
    }
    const entries = [...map.entries()];
    const others = entries.filter(([key]) => key !== id);
    // Where it lands among everything, found by counting the kept entries before it.
    let at = others.length;
    let seen = 0;
    for (const [position, [, value]] of others.entries()) {
        if (counts(value)) {
            if (seen === Math.max(0, index)) {
                at = position;
                break;
            }
            seen += 1;
        }
    }
    const next = [...others.slice(0, at), [id, moved] as const, ...others.slice(at)];
    if (next.every(([key], position) => entries[position]?.[0] === key)) {
        return false;
    }
    map.clear();
    for (const [key, value] of next) {
        map.set(key, value);
    }
    return true;
};

// Where one entry stands among the kept ones; -1 when it is not one of them.
export const indexAmong = <V>(map: ReadonlyMap<string, V>, id: string, counts: (value: V) => boolean = () => true): number =>
    [...map.entries()].filter(([, value]) => counts(value)).findIndex(([key]) => key === id);
