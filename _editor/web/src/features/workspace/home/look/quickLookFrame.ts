// Where the home's quick look stands and how large it is drawn. Pure, no DOM: the card hands in its anchor, the window
// and how large it would be in a given room, and gets back its box.
//
// The card is tried beside its tile on each side, and takes the side where it comes out largest. A side only counts if
// the card there is plainly larger than the tile it looks into (LOOK_GROWTH), since a look no larger than the picture
// already on screen says nothing; where no side gives that much, the card is laid over the tile, centred on it. It takes
// no pointer, so the tile under it still hears the pointer. Whatever it does, it stays inside the window.

export interface Size {
    readonly width: number;
    readonly height: number;
}

// The tile looked into, in the window's client coordinates (a DOMRect is one).
export interface AnchorRect extends Size {
    readonly top: number;
    readonly left: number;
}

export type LookSide = "right" | "left" | "bottom" | "top" | "over";

export interface LookFrame extends Size {
    readonly side: LookSide;
    readonly left: number;
    readonly top: number;
}

export interface LookFrameInput<Card extends Size> {
    readonly anchor: AnchorRect;
    readonly view: Size;
    // Between the tile and the card.
    readonly gap: number;
    // Kept clear on every edge of the window.
    readonly edge: number;
    /** The card's size in a room: never larger than the room, smaller where its content is. */
    readonly size: (room: Size) => Card;
}

// How much larger than its tile, each way, a card beside it must be to be worth standing there.
const LOOK_GROWTH = 1.5;

const SIDES = [`right`, `left`, `bottom`, `top`] as const;

const area = (size: Size): number => Math.max(0, size.width) * Math.max(0, size.height);

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), Math.max(min, max));

export const lookFrame = <Card extends Size>({ anchor, view, gap, edge, size }: LookFrameInput<Card>): LookFrame & Card => {
    const anchorRight = anchor.left + anchor.width;
    const anchorBottom = anchor.top + anchor.height;
    const full: Size = { width: view.width - 2 * edge, height: view.height - 2 * edge };
    const rooms = {
        right: { width: view.width - anchorRight - gap - edge, height: full.height },
        left: { width: anchor.left - gap - edge, height: full.height },
        bottom: { width: full.width, height: view.height - anchorBottom - gap - edge },
        top: { width: full.width, height: anchor.top - gap - edge },
    } satisfies Record<(typeof SIDES)[number], Size>;
    const over = size(full);
    // Enough is plainly larger than the tile, or as large as the card gets anywhere: a small picture shown at its own
    // size is no larger over the tile than beside it.
    const enough = Math.min(area(over) * 0.98, area(anchor) * LOOK_GROWTH * LOOK_GROWTH);

    let best: { readonly side: (typeof SIDES)[number]; readonly size: Card } | undefined;
    for (const side of SIDES) {
        const room = rooms[side];
        if (room.width <= 0 || room.height <= 0) {
            continue;
        }
        const card = size(room);
        // The first side reaching the largest size keeps it, so a card that fits anywhere stands to the right.
        if (area(card) >= enough && (best === undefined || area(card) > area(best.size))) {
            best = { side, size: card };
        }
    }

    const centreX = anchor.left + anchor.width / 2;
    const centreY = anchor.top + anchor.height / 2;
    const alongX = (width: number): number => clamp(centreX - width / 2, edge, view.width - width - edge);
    const alongY = (height: number): number => clamp(centreY - height / 2, edge, view.height - height - edge);

    if (best === undefined) {
        return { side: `over`, ...over, left: alongX(over.width), top: alongY(over.height) };
    }
    const { side, size: card } = best;
    switch (side) {
        case `right`:
            return { side, ...card, left: anchorRight + gap, top: alongY(card.height) };
        case `left`:
            return { side, ...card, left: anchor.left - gap - card.width, top: alongY(card.height) };
        case `bottom`:
            return { side, ...card, left: alongX(card.width), top: anchorBottom + gap };
        case `top`:
            return { side, ...card, left: alongX(card.width), top: anchor.top - gap - card.height };
    }
};

export interface MediaLimits {
    // The picture's largest box, whatever the room.
    readonly cap: Size;
    // The picture's own pixels where known: a look never blows a small picture up past them.
    readonly own?: Size | undefined;
    // What the card adds around the picture: its borders, and the header above.
    readonly chrome: Size;
    // The narrowest the card is drawn, so its header can be read over a tall, thin picture.
    readonly minWidth: number;
}

export interface MediaSize extends Size {
    // The picture's own box inside the card.
    readonly media: Size;
}

/** A picture of proportions `aspect` (width over height) as large as it can be drawn in `room`, card and all. */
export const mediaCard = (room: Size, aspect: number, limits: MediaLimits): MediaSize => {
    const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 10;
    const { cap, own, chrome, minWidth } = limits;
    const widest = Math.min(room.width - chrome.width, cap.width, own?.width ?? Number.POSITIVE_INFINITY);
    const tallest = Math.min(room.height - chrome.height, cap.height, own?.height ?? Number.POSITIVE_INFINITY);
    const width = Math.max(0, Math.floor(Math.min(widest, tallest * ratio)));
    const media = { width, height: Math.floor(width / ratio) };
    return {
        width: Math.min(room.width, Math.max(minWidth, media.width + chrome.width)),
        height: Math.min(room.height, media.height + chrome.height),
        media,
    };
};
