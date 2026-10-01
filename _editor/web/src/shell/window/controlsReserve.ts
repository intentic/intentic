/* WHAT THE WINDOW'S OWN BUTTONS TAKE FROM THE PAGE. They float in the top-right corner, over whatever the layout put
   there; the one bar that meets that corner gives up that much of its width, so none of its own controls ends up
   under them. Which bar that is depends on the layout (the chat column may be gone, popped out or homed on the
   rail; a page's title row starts a padding below the top), so it is measured rather than declared.

   Not every column that reaches the corner has a bar to give up: a wide chat panel stands its tab row on the left as a
   roster, and the transcript, its pinned prompt and the checklist beside it all start on the top edge. Such a surface
   gives up the band's HEIGHT instead — it is handed `--window-band` and keeps that much of its own top clear, however
   its layout spends it (ChatPanel.vue). A bar still comes first: where one meets the corner, it is the surface's top row. */

/** Every row that can run into the corner, as one selector: a shell column's bar, and a page's title row. */
export const BAR = `.view-header, .ui-page-header`;

/** Every surface that has no bar along its top and so clears the buttons' band itself, when it is the one at the corner. */
export const SURFACE = `[data-window-band]`;

/** Whatever can hold the corner, bar or surface: what the document is watched for. */
export const OCCUPANT = `${BAR}, ${SURFACE}`;

/** As much of a bar's box as any question here needs. */
export interface BarEdges {
    readonly top: number;
    readonly bottom: number;
    readonly right: number;
}

/** The corner the buttons occupy, as the page sees it: from `left` to the right edge, from the top edge down to `bottom`. */
export interface Corner {
    readonly left: number;
    readonly bottom: number;
}

/* The corner bar is the one whose box overlaps the corner; of several, the one reaching furthest right, since its controls are the ones ending there. */
export const cornerBar = <Bar>(bars: readonly Bar[], edgesOf: (bar: Bar) => BarEdges, corner: Corner): Bar | undefined => {
    let found: Bar | undefined;
    let reach = Number.NEGATIVE_INFINITY;
    for (const bar of bars) {
        const edges = edgesOf(bar);
        if (edges.top < corner.bottom && edges.bottom > 0 && edges.right > corner.left && edges.right > reach) {
            found = bar;
            reach = edges.right;
        }
    }
    return found;
};

/** What holds the corner, and how it makes room: a bar by its width, a surface by its top. */
export type CornerHolder<Box> = { readonly box: Box; readonly gives: `width` | `band` };

/* A bar meeting the corner holds it; only with none does a surface, since a bar there is the surface's own top row. */
export const cornerHolder = <Box>(
    bars: readonly Box[],
    surfaces: readonly Box[],
    edgesOf: (box: Box) => BarEdges,
    corner: Corner,
): CornerHolder<Box> | undefined => {
    const bar = cornerBar(bars, edgesOf, corner);
    if (bar !== undefined) {
        return { box: bar, gives: `width` };
    }
    const surface = cornerBar(surfaces, edgesOf, corner);
    return surface === undefined ? undefined : { box: surface, gives: `band` };
};

/* A bar or surface arriving or leaving is the only DOM change that can make the corner belong to a different one than it did. */
const holdsBar = (nodes: NodeList): boolean =>
    [...nodes].some((node) => node instanceof Element && (node.matches(OCCUPANT) || node.querySelector(OCCUPANT) !== null));

/** Whether a batch of DOM records put a bar (or a surface) into the document or took one out of it. */
export const barsChanged = (records: readonly MutationRecord[]): boolean =>
    records.some((record) => holdsBar(record.addedNodes) || holdsBar(record.removedNodes));
