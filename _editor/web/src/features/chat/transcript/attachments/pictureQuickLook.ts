// Where a hovered picture's bigger version floats: in whichever free region, beside the chat panel, beside the picture
// or above/below it, draws the picture largest. Shared by the composer/bubble thumbs (ChatImageThumb) and a finished
// turn's screenshot strip (ChatTurnShots), so both look the same way.

// The fixed region the look is drawn in (each edge's distance from the window's same edge), and where in it the
// picture sits: a picture smaller than its region hugs the side nearest what it previews rather than floating off.
export interface QuickLookBox {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
    readonly justify: "start" | "center" | "end";
    readonly align: "start" | "center" | "end";
}

const MARGIN = 16; // px: breathing room against the window edges.
const GAP = 12; // px: between the picture and its look.
const MAX_WIDTH = 1100; // px: cap so the look stays a look on very wide windows.
const CENTRE_SHARE = 0.85; // of the window, when no region beside or around the picture is worth using.
const MIN_SCALE = 1.5; // a region drawing the picture under this many times the thumb's size isn't a look.
const WIDE = 16 / 10; // the aspect assumed until the picture's own is known.

// How large a picture of `aspect` draws inside a region, as its drawn width.
const drawnWidth = (box: QuickLookBox, viewport: { width: number; height: number }, aspect: number): number => {
    const width = viewport.width - box.left - box.right;
    const height = viewport.height - box.top - box.bottom;
    return width <= 0 || height <= 0 ? 0 : Math.min(width, height * aspect);
};

// The width-over-height of a decoded <img>, or the wide default while it hasn't decoded (or isn't there).
export const aspectOf = (image: HTMLImageElement | null | undefined): number =>
    image && image.naturalWidth > 0 && image.naturalHeight > 0 ? image.naturalWidth / image.naturalHeight : WIDE;

// `aspect` is the picture's width over height (aspectOf); the look is placed for it.
export const quickLookBox = (el: HTMLElement, aspect = WIDE): QuickLookBox => {
    // The picture may live in a floating window with its own viewport; clamp against that window, not globalThis.
    const win = el.ownerDocument.defaultView ?? globalThis;
    const width = win.innerWidth;
    const height = win.innerHeight;
    const viewport = { width, height };
    const rect = el.getBoundingClientRect();
    // Horizontal span centred on `centre`, at most MAX_WIDTH wide, kept inside the window's margins.
    const span = (centre: number): Pick<QuickLookBox, `left` | `right`> => {
        const wide = Math.min(MAX_WIDTH, width - MARGIN * 2);
        const left = Math.min(Math.max(MARGIN, centre - wide / 2), width - MARGIN - wide);
        return { left, right: width - left - wide };
    };
    // Hangs off the picture's height and grows toward whichever way (up or down) has more room.
    const growUp = rect.bottom >= height - rect.top;
    const vertical = {
        top: growUp ? MARGIN : Math.max(MARGIN, rect.top),
        bottom: growUp ? Math.max(MARGIN, height - rect.bottom) : MARGIN,
        align: growUp ? (`end` as const) : (`start` as const),
    };
    // Left of or right of an edge box: the chat panel's first, so the look covers workspace rather than the chat.
    const besides = (box: DOMRect): QuickLookBox[] => [
        { ...vertical, left: Math.max(MARGIN, box.left - GAP - MAX_WIDTH), right: width - box.left + GAP, justify: `end` },
        { ...vertical, left: box.right + GAP, right: Math.max(MARGIN, width - box.right - GAP - MAX_WIDTH), justify: `start` },
    ];
    const panel = el.closest(`.chat-panel`)?.getBoundingClientRect();
    const centred = span(rect.left + rect.width / 2);
    const candidates: QuickLookBox[] = [
        ...(panel === undefined ? [] : besides(panel)),
        ...besides(rect),
        { ...centred, top: MARGIN, bottom: height - rect.top + GAP, justify: `center`, align: `end` },
        { ...centred, top: rect.bottom + GAP, bottom: MARGIN, justify: `center`, align: `start` },
    ];
    // First-listed wins a tie, so beside the panel is kept whenever it is as good as anything else.
    let best: QuickLookBox | undefined;
    let bestWidth = 0;
    for (const candidate of candidates) {
        const drawn = drawnWidth(candidate, viewport, aspect);
        if (drawn > bestWidth + 1) {
            best = candidate;
            bestWidth = drawn;
        }
    }
    if (best !== undefined && bestWidth >= Math.max(rect.width, rect.height * aspect) * MIN_SCALE) {
        return best;
    }
    // A cramped window: over its middle, the picture underneath included, since the look never takes the pointer.
    const inset = Math.round((height * (1 - CENTRE_SHARE)) / 2);
    return { ...span(width / 2), top: inset, bottom: inset, justify: `center`, align: `center` };
};
