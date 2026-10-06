// Layers a dependency graph by generation: the items waiting on nothing, then whatever those unblock, and so on, each
// layer in input order. On a graph without cycles an item's layer is the longest chain of needs below it. A need that
// names no item, or the item itself, is ignored. Several items may share an id (a CI matrix's legs share a job name);
// a need on that id waits for all of them. A cycle cannot hang it: once nothing more can be placed, everything left
// goes in one final layer, cycle and downstream alike, rather than an order the graph does not have.
export const dagLayers = <T>(items: readonly T[], idOf: (item: T) => string, needsOf: (item: T) => readonly string[]): T[][] => {
    const unplaced = new Map<string, number>();
    for (const item of items) {
        unplaced.set(idOf(item), (unplaced.get(idOf(item)) ?? 0) + 1);
    }
    const settled = (item: T, need: string): boolean => need === idOf(item) || (unplaced.get(need) ?? 0) === 0;
    const layers: T[][] = [];
    let waiting = [...items];
    while (waiting.length > 0) {
        const ready = waiting.filter((item) => needsOf(item).every((need) => settled(item, need)));
        const layer = ready.length > 0 ? ready : waiting;
        const placed = new Set(layer);
        for (const item of layer) {
            unplaced.set(idOf(item), (unplaced.get(idOf(item)) ?? 1) - 1);
        }
        layers.push(layer);
        waiting = waiting.filter((item) => !placed.has(item));
    }
    return layers;
};
