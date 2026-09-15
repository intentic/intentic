/* WHAT THE WINDOW'S OWN BUTTONS TAKE FROM THE PAGE. They float in the top-right corner, over whatever the layout put
   there; the one bar that meets that corner gives up that much of its width, so none of its own controls ends up
   under them. Which bar that is depends on the layout (the chat column may be gone, popped out or homed on the
   rail; a page's title row starts a padding below the top), so it is measured rather than declared. */

/** Every row that can run into the corner, as one selector: a shell column's bar, and a page's title row. */
export const BAR = `.view-header, .ui-page-header`;

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

/* A bar arriving or leaving is the only DOM change that can make the corner belong to a different bar than it did. */
const holdsBar = (nodes: NodeList): boolean =>
    [...nodes].some((node) => node instanceof Element && (node.matches(BAR) || node.querySelector(BAR) !== null));

/** Whether a batch of DOM records put a bar into the document or took one out of it. */
export const barsChanged = (records: readonly MutationRecord[]): boolean =>
    records.some((record) => holdsBar(record.addedNodes) || holdsBar(record.removedNodes));
