import layout from "./assistants/modular/web/layout.json";

// One clay companion assembled from layers: a tinted body, a fixed gold crown, one large prop held in tinted hands.
// The web-sized parts and their fitted rectangles come from `assistants/modular/export-web.py`, which cuts them out of
// the PNG masters that `assistants/modular/manifest.json` describes.

/** What a companion can hold; the prop is what says, at a glance, what it helps with. */
export const ASSISTANT_ACCESSORIES = {
    terminal: { label: `Code`, object: `Terminal laptop`, src: new URL(`./assistants/modular/web/terminal.webp`, import.meta.url).href },
    palette: { label: `Design`, object: `Paint palette`, src: new URL(`./assistants/modular/web/palette.webp`, import.meta.url).href },
    magnifier: { label: `Research`, object: `Magnifying glass`, src: new URL(`./assistants/modular/web/magnifier.webp`, import.meta.url).href },
    scroll: { label: `Writing`, object: `Parchment scroll`, src: new URL(`./assistants/modular/web/scroll.webp`, import.meta.url).href },
    book: { label: `Learning`, object: `Open book`, src: new URL(`./assistants/modular/web/book.webp`, import.meta.url).href },
    compass: { label: `Planning`, object: `Compass`, src: new URL(`./assistants/modular/web/compass.webp`, import.meta.url).href },
    sprout: { label: `Growth`, object: `Potted sprout`, src: new URL(`./assistants/modular/web/sprout.webp`, import.meta.url).href },
    shield: { label: `Safety`, object: `Shield`, src: new URL(`./assistants/modular/web/shield.webp`, import.meta.url).href },
} as const;

export type AssistantAccessory = keyof typeof ASSISTANT_ACCESSORIES;

export interface AssistantColor {
    readonly id: string;
    readonly label: string;
    readonly hex: string;
}

/** The body colors a companion is drawn in: soft enough for the clay shading to read in either theme. */
export const ASSISTANT_COLORS: readonly AssistantColor[] = layout.palette;

/** `x, y, width, height` on the 1024-square canvas. */
export type AssistantRect = readonly [number, number, number, number];
const rect = (value: readonly number[]): AssistantRect => [value[0]!, value[1]!, value[2]!, value[3]!];

// Hands without an override hold the prop from both sides at the shared pose.
const hands = { left: rect(layout.layers.leftHand), right: rect(layout.layers.rightHand) };
const accessoryLayout = layout.accessories as Record<AssistantAccessory, { rect: number[]; hands?: { left: number[]; right: number[] } }>;

export const ASSISTANT_CANVAS = layout.canvas[0]!;

export interface AssistantLayer {
    readonly src: string;
    readonly rect: AssistantRect;
    /** Drawn in the body color (the clay), rather than as painted (gold, props). */
    readonly tint: boolean;
}

const parts = {
    body: new URL(`./assistants/modular/web/body.webp`, import.meta.url).href,
    crown: new URL(`./assistants/modular/web/crown.webp`, import.meta.url).href,
    leftHand: new URL(`./assistants/modular/web/hand-left.webp`, import.meta.url).href,
    rightHand: new URL(`./assistants/modular/web/hand-right.webp`, import.meta.url).href,
};

/** The layers of one companion, back to front: body, crown, prop, then the hands that grip it. */
export function assistantLayers(accessory: AssistantAccessory): readonly AssistantLayer[] {
    const placed = accessoryLayout[accessory];
    return [
        { src: parts.body, rect: rect(layout.layers.body), tint: true },
        { src: parts.crown, rect: rect(layout.layers.crown), tint: false },
        { src: ASSISTANT_ACCESSORIES[accessory].src, rect: rect(placed.rect), tint: false },
        { src: parts.leftHand, rect: placed.hands === undefined ? hands.left : rect(placed.hands.left), tint: true },
        { src: parts.rightHand, rect: placed.hands === undefined ? hands.right : rect(placed.hands.right), tint: true },
    ];
}

/**
 * The per-channel lookup that turns the grey clay into `hex`: shadows stay dark, midtones take a deeper shade, light
 * areas the color itself and highlights stay white. Applied after desaturating, in sRGB, to body and hands only.
 */
export function assistantTint(hex: string) {
    const channel = (at: number): string => {
        const value = Number.parseInt(hex.slice(1 + at * 2, 3 + at * 2), 16) / 255;
        return `0 0.1 ${(value * 0.6).toFixed(3)} ${value.toFixed(3)} 1`;
    };
    return { r: channel(0), g: channel(1), b: channel(2) };
}

/** A stable body color and independent motion phase, chosen from `seed` without random values or timers. */
export function assistantFace(seed: string) {
    let state = 0x81_1c_9d_c5;
    for (const char of seed) {
        state = Math.imul(state ^ char.codePointAt(0)!, 0x01_00_01_93) >>> 0;
    }
    if (state === 0) {
        state = 0x9e_37_79_b9;
    }
    const next = (): number => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
    return {
        color: ASSISTANT_COLORS[next() % ASSISTANT_COLORS.length]!,
        duration: 5.5 + (next() % 25) / 10,
        delay: -(next() % 100) / 10,
    };
}
