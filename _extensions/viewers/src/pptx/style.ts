import { attr, kid, kids, num } from "./xml-dom";

/* COLOR, the way a deck actually states it: almost never as a hex value, and almost always as "accent 1, 40% lighter"
   — a theme slot plus modifiers. Resolving that chain is what keeps a rendered slide the colour its author chose
   rather than black text on white. */

/** A deck's theme colours by slot name (`dk1`, `lt1`, `accent1`…), as bare `rrggbb`, mapped through the master's colour map. */
export type Palette = ReadonlyMap<string, string>;

// Carried as a pair rather than a CSS string: a colour is read, modified, and only then formatted, and a modifier
// applied to `rgb(0 0 0 / 50%)` is not a thing that can be done.
interface Color {
    /** Six hex digits, no `#`. */
    readonly hex: string;
    readonly alpha: number;
}

type Rgb = [number, number, number];

const HEX = /^[\da-f]{6}$/i;

// The named colours DrawingML allows as `a:prstClr`; only the handful a deck realistically uses is worth carrying,
// and an unknown name falls through to "inherit" rather than to a wrong colour.
const PRESET: Record<string, string> = {
    black: "000000",
    white: "FFFFFF",
    red: "FF0000",
    green: "008000",
    blue: "0000FF",
    yellow: "FFFF00",
    gray: "808080",
    grey: "808080",
    orange: "FFA500",
    purple: "800080",
};

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

const channels = (hex: string): Rgb => [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)];

const hexOf = (rgb: Rgb): string => rgb.map((part) => Math.round(clamp(part, 0, 255)).toString(16).padStart(2, "0")).join("");

// Luminance modifiers are stated against HSL lightness, so that is where they have to be applied; tint and shade are
// blends and stay in RGB, which is what every renderer does with them in practice.
const lightness = (rgb: Rgb): number => (Math.max(...rgb) + Math.min(...rgb)) / 510;

const withLightness = (rgb: Rgb, target: number): Rgb => {
    const current = lightness(rgb);
    if (current === 0) {
        const level = clamp(target, 0, 1) * 255;
        return [level, level, level];
    }
    // Scaling toward white above the midpoint and toward black below it keeps the hue, which a flat multiply loses.
    return target <= current
        ? (rgb.map((part) => part * (target / current)) as Rgb)
        : (rgb.map((part) => part + (255 - part) * ((target - current) / (1 - current))) as Rgb);
};

const MODIFIERS: Record<string, (rgb: Rgb, value: number) => Rgb> = {
    lumMod: (rgb, value) => withLightness(rgb, lightness(rgb) * value),
    lumOff: (rgb, value) => withLightness(rgb, lightness(rgb) + value),
    tint: (rgb, value) => rgb.map((part) => part * value + 255 * (1 - value)) as Rgb,
    shade: (rgb, value) => rgb.map((part) => part * value) as Rgb,
};

// `val` is in thousandths of a percent throughout DrawingML: 60000 is 60%.
const ratio = (node: Element | undefined): number | undefined => {
    const value = num(node, "val");
    return value === undefined ? undefined : value / 100_000;
};

// Applied in the order the file states them, since lumMod then lumOff is not lumOff then lumMod.
const applyModifiers = (start: string, node: Element): Color => {
    let rgb = channels(start);
    let alpha = 1;
    for (const modifier of node.children) {
        const value = ratio(modifier);
        if (value === undefined) {
            continue;
        }
        if (modifier.localName === "alpha") {
            alpha = value;
            continue;
        }
        rgb = MODIFIERS[modifier.localName]?.(rgb, value) ?? rgb;
    }
    return { hex: hexOf(rgb), alpha };
};

const literal = (value: string | undefined): string | undefined => (value !== undefined && HEX.test(value) ? value : undefined);

// One colour element's own value, before its modifiers, by the kind of colour it is.
const VALUES: Record<string, (node: Element, palette: Palette) => string | undefined> = {
    srgbClr: (node) => literal(attr(node, "val")),
    // The rendered value the producer last saw is the honest answer; "windowText" means nothing outside Windows.
    sysClr: (node) => literal(attr(node, "lastClr")),
    schemeClr: (node, palette) => palette.get(attr(node, "val") ?? ""),
    prstClr: (node) => PRESET[attr(node, "val") ?? ""],
};

// `undefined` means "this element says nothing about colour", which is never the same answer as black.
const readColor = (node: Element, palette: Palette): Color | undefined => {
    const base = VALUES[node.localName]?.(node, palette);
    return base === undefined ? undefined : applyModifiers(base, node);
};

const firstColor = (holder: Element | undefined, palette: Palette): Color | undefined => {
    for (const child of holder?.children ?? []) {
        const color = readColor(child, palette);
        if (color !== undefined) {
            return color;
        }
    }
    return undefined;
};

const cssOf = (color: Color): string => {
    if (color.alpha >= 1) {
        return `#${color.hex}`;
    }
    const [red, green, blue] = channels(color.hex);
    return `rgb(${red} ${green} ${blue} / ${Math.round(color.alpha * 100)}%)`;
};

/** The colour a fill-like element states (`a:solidFill`, `a:fillRef`, `a:fgClr`), or `undefined` when it states none. */
export const colorOf = (holder: Element | undefined, palette: Palette): string | undefined => {
    const color = firstColor(holder, palette);
    return color === undefined ? undefined : cssOf(color);
};

/** A shape's solid fill, if it has one. Gradients and picture fills answer `undefined`: a wrong flat colour is worse than none. */
export const solidFillOf = (properties: Element | undefined, palette: Palette): string | undefined => colorOf(kid(properties, "solidFill"), palette);

/**
 * The deck's colour slots, resolved once per master: the theme names the colours, the master's colour map says which
 * slot each of `bg1`/`tx1`/`bg2`/`tx2` points at, and a slide says `tx1` meaning whatever that came out as.
 */
export const readPalette = (theme: Element | undefined, colorMap: Element | undefined): Palette => {
    const slots = new Map<string, string>();
    const scheme = kid(kid(theme, "themeElements"), "clrScheme");
    // Resolved against an empty palette: a theme's own slots never reference each other.
    for (const slot of scheme?.children ?? []) {
        const value = firstColor(slot, new Map());
        if (value !== undefined) {
            slots.set(slot.localName, value.hex);
        }
    }
    // The map's own names resolve to theme slots; without a map, `tx1`/`bg1` still have to mean something.
    const mapped = new Map(slots);
    for (const [name, fallback] of [
        ["tx1", "dk1"],
        ["tx2", "dk2"],
        ["bg1", "lt1"],
        ["bg2", "lt2"],
    ] as const) {
        const value = slots.get(attr(colorMap, name) ?? fallback);
        if (value !== undefined) {
            mapped.set(name, value);
        }
    }
    return mapped;
};

/** The fill a shape's theme style reference names, which is how every shape from the gallery gets its colour. */
export const styleFillOf = (shape: Element | undefined, palette: Palette): string | undefined => colorOf(kid(kid(shape, "style"), "fillRef"), palette);

/** The text colour that same theme style names, used when nothing on the run itself says otherwise. */
export const styleTextColorOf = (shape: Element | undefined, palette: Palette): string | undefined => colorOf(kid(kid(shape, "style"), "fontRef"), palette);

/** The outline that same theme style names, for shapes drawn as an outline rather than a fill. */
export const styleLineColorOf = (shape: Element | undefined, palette: Palette): string | undefined => colorOf(kid(kid(shape, "style"), "lnRef"), palette);

/** Whether this properties element explicitly states "no fill", which has to beat anything it would otherwise inherit. */
export const hasNoFill = (properties: Element | undefined): boolean => kids(properties, "noFill").length > 0;
