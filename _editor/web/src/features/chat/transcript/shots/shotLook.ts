// What a shot's small whole-picture rendition says about it, judged from its pixels: whether it is plain (a page caught
// before it painted, a flat white or black frame, an empty page holding only a floating pill or a scrollbar) and a print
// that two pixel-identical shots share. Pure over the pixels, so the rule is tested without a canvas.
//
// Tuned on 3,371 browser screenshots agents took in a working sandbox: 101 were one flat colour, and about 80 more held
// nothing but a pill or a scrollbar, the anything-else in them inside 0.4–1.6% of the frame. The nearest real content
// (one line of text on an empty editor) took 2.0%, loading and error screens 3% and up, which is the gap PLAIN_SHARE
// sits in.

export interface ShotLook {
    // Nothing on it worth a person's look.
    readonly plain: boolean;
    // Equal for pixel-identical pictures; undefined when the pixels could not be read, which matches nothing.
    readonly print: string | undefined;
}

// What a picture that could not be judged counts as: shown, and the same as nothing else.
export const UNJUDGED: ShotLook = { plain: false, print: undefined };

// The share of the frame the box around everything off the background may cover for the picture to read as plain.
const PLAIN_SHARE = 0.018;
// Trimmed from each edge before judging, as a share of that side: a page's scrollbar lives there, and says nothing.
const EDGE_TRIM = 0.02;
// How far a channel may stray from the background and still be background: re-encoding blurs a flat colour's edges.
const TOLERANCE = 16;
// Judged only between these aspect ratios (width over height): a thin crop of one element (a row, an icon) is mostly
// background by nature and was taken to show that one thing.
const ASPECTS = { min: 0.4, max: 2.5 } as const;
// Judged only from this long side up (the tile is the picture's own size below 256 px): a capture this small is a crop
// of one element, an icon or a swatch, mostly background by nature.
const MIN_SIDE = 128;

// A colour to 4 bits a channel, alpha included, so a fully transparent capture has a background too.
const bucketOf = (data: ArrayLike<number>, at: number): number =>
    ((data[at]! >> 4) << 12) | ((data[at + 1]! >> 4) << 8) | ((data[at + 2]! >> 4) << 4) | (data[at + 3]! >> 4);

interface Frame {
    readonly data: ArrayLike<number>;
    readonly width: number;
    readonly x0: number;
    readonly x1: number;
    readonly y0: number;
    readonly y1: number;
}

// Every pixel inside the trimmed frame, as its offset into the RGBA data.
const eachPixel = (frame: Frame, visit: (at: number) => void): void => {
    for (let y = frame.y0; y < frame.y1; y++) {
        for (let x = frame.x0; x < frame.x1; x++) {
            visit((y * frame.width + x) * 4);
        }
    }
};

// The commonest colour, as the mean of the pixels in its bucket rather than the bucket's corner.
const backgroundOf = (frame: Frame): readonly number[] => {
    const counts = new Map<number, number>();
    eachPixel(frame, (at) => {
        const bucket = bucketOf(frame.data, at);
        counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    });
    let top = 0;
    let most = 0;
    for (const [bucket, count] of counts) {
        if (count > most) {
            most = count;
            top = bucket;
        }
    }
    const sum = [0, 0, 0, 0];
    eachPixel(frame, (at) => {
        if (bucketOf(frame.data, at) === top) {
            for (let channel = 0; channel < 4; channel++) {
                sum[channel]! += frame.data[at + channel]!;
            }
        }
    });
    return sum.map((total) => total / most);
};

// The share of the frame covered by the box around every pixel that is not background; 0 for a flat picture.
const inkShare = (frame: Frame): number => {
    const background = backgroundOf(frame);
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (let y = frame.y0; y < frame.y1; y++) {
        for (let x = frame.x0; x < frame.x1; x++) {
            const at = (y * frame.width + x) * 4;
            let off = false;
            for (let channel = 0; channel < 4 && !off; channel++) {
                off = Math.abs(frame.data[at + channel]! - background[channel]!) > TOLERANCE;
            }
            if (off) {
                left = Math.min(left, x);
                right = Math.max(right, x);
                top = Math.min(top, y);
                bottom = Math.max(bottom, y);
            }
        }
    }
    if (right < left) {
        return 0;
    }
    return ((right - left + 1) * (bottom - top + 1)) / ((frame.x1 - frame.x0) * (frame.y1 - frame.y0));
};

// FNV-1a over the dimensions and every byte: identical pictures decode to identical renditions, so exact is right, and a
// near match is not wanted (a ticked checkbox is a few pixels, and can be the whole point of the second shot).
const printOf = (data: ArrayLike<number>, width: number, height: number): string => {
    let hash = 0x811c9dc5;
    const mix = (byte: number): void => {
        hash = Math.imul(hash ^ byte, 0x01000193);
    };
    for (const byte of [width >> 8, width & 255, height >> 8, height & 255]) {
        mix(byte);
    }
    for (let index = 0; index < data.length; index++) {
        mix(data[index]!);
    }
    return `${width}x${height}:${(hash >>> 0).toString(16)}`;
};

/** A picture's look from its RGBA pixels, row by row from the top-left. */
export const lookOf = (data: ArrayLike<number>, width: number, height: number): ShotLook => {
    if (width <= 0 || height <= 0 || data.length < width * height * 4) {
        return UNJUDGED;
    }
    const print = printOf(data, width, height);
    const aspect = width / height;
    if (aspect < ASPECTS.min || aspect > ASPECTS.max || Math.max(width, height) < MIN_SIDE) {
        return { plain: false, print };
    }
    const trimX = Math.round(width * EDGE_TRIM);
    const trimY = Math.round(height * EDGE_TRIM);
    const frame = { data, width, x0: trimX, x1: width - trimX, y0: trimY, y1: height - trimY };
    return { plain: inkShare(frame) <= PLAIN_SHARE, print };
};
