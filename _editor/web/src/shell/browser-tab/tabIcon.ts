import { glyphBody } from "@intentic/ui/glyph";
import { ICONS } from "@intentic/ui/icons";
import { type LogoStyle, readLogoStyle } from "../../features/sandbox/overview/logo/presets";
import type { TabMark } from "./tabSignal";

// The tab's icon for a mark: the open sandbox's logo, or the lotus (public/favicon.svg, the same paths) where it has
// none, with a disc in its lower right corner, cut out of the picture by a ring so it reads on a light tab strip and a
// dark one alike. Drawn at 32 units and meant to be seen at 16 pixels, so the disc is half the icon wide and carries
// one glyph at most.

const LOTUS_PATHS = [
    `<path d="M16 9.5c2.1 3 3.2 5.7 3.2 8.1 0 2.2-1.1 4.1-3.2 5.6-2.1-1.5-3.2-3.4-3.2-5.6 0-2.4 1.1-5.1 3.2-8.1z" transform="rotate(-74 16 22.6)" opacity=".55"/>`,
    `<path d="M16 9.5c2.1 3 3.2 5.7 3.2 8.1 0 2.2-1.1 4.1-3.2 5.6-2.1-1.5-3.2-3.4-3.2-5.6 0-2.4 1.1-5.1 3.2-8.1z" transform="rotate(74 16 22.6)" opacity=".55"/>`,
    `<path d="M16 6.4c2.4 3.4 3.6 6.4 3.6 9.1 0 2.5-1.2 4.6-3.6 6.3-2.4-1.7-3.6-3.8-3.6-6.3 0-2.7 1.2-5.7 3.6-9.1z" transform="rotate(-39 16 21.7)" opacity=".78"/>`,
    `<path d="M16 6.4c2.4 3.4 3.6 6.4 3.6 9.1 0 2.5-1.2 4.6-3.6 6.3-2.4-1.7-3.6-3.8-3.6-6.3 0-2.7 1.2-5.7 3.6-9.1z" transform="rotate(39 16 21.7)" opacity=".78"/>`,
    `<path d="M16 3.4c2.8 4 4.2 7.5 4.2 10.6 0 2.9-1.4 5.4-4.2 7.3-2.8-1.9-4.2-4.4-4.2-7.3 0-3.1 1.4-6.6 4.2-10.6z"/>`,
].join(``);

// Colours are literal: an icon is drawn outside the page, where no custom property reaches. Picked to hold at 16px on
// both tab strips rather than copied from the tokens, which are tuned for text on this app's own canvas.
const LOTUS = `#e07b27`;
// Warm grey, the lotus with its colour taken out: the universal "not connected".
const LOTUS_OFFLINE = `#8f8a84`;
const ASKS = `#e5484d`;
const DONE = `#2f9e64`;
const WORKING = `#3d8bf2`;

const lotus = (fill: string): string => `<svg x="0" y="0" width="32" height="32" viewBox="7.2 2.6 17.6 20.2" fill="${fill}">${LOTUS_PATHS}</svg>`;

// Only an inline picture: an SVG drawn as an image loads nothing from the network, and every sandbox logo is one
// (an upload is downscaled to a data URL, a preset is an SVG data URL), so anything else keeps the lotus.
export const drawableLogo = (logo: string | undefined): string | undefined => (logo?.startsWith(`data:image/`) === true ? logo : undefined);

const attribute = (value: string): string => value.replaceAll(`&`, `&amp;`).replaceAll(`"`, `&quot;`).replaceAll(`<`, `&lt;`);

/** The part of an uploaded logo worth showing, in its own pixels: a square around what is not transparent. */
export interface LogoCrop {
    readonly width: number;
    readonly height: number;
    readonly x: number;
    readonly y: number;
    readonly side: number;
}

// Offline takes the colour out of a logo as it does out of the lotus, and fades it a little, so the grey reads as
// "not connected" rather than as a grey logo.
const GREY = `<filter id="grey"><feColorMatrix type="saturate" values="0"/></filter>`;

// A preset (logo/presets.ts) is its glyph on a faint plate with a wide margin, sized for a tile in the rail; at 16
// pixels the plate is invisible and the margin shrinks the glyph to half the icon. The tab draws the glyph alone and
// full size instead, as tight as the lotus it replaces.
const presetArt = ({ icon, color }: LogoStyle, offline: boolean): string =>
    `<g transform="scale(${32 / 24})" color="${offline ? LOTUS_OFFLINE : color}">${glyphBody(ICONS[icon])}</g>`;

// An upload is a square with its picture fitted inside (imageDataUrl.ts, `contain`), so a wide logo or one drawn
// with a margin arrives with a transparent border; the crop, where the page could measure one, trims it.
const imageArt = (logo: string, offline: boolean, crop: LogoCrop | undefined): string => {
    const look = offline ? ` filter="url(#grey)" opacity=".7"` : ``;
    const image =
        crop === undefined
            ? `<image href="${attribute(logo)}" x="0" y="0" width="32" height="32" preserveAspectRatio="xMidYMid slice"${look}/>`
            : `<svg x="0" y="0" width="32" height="32" viewBox="${crop.x} ${crop.y} ${crop.side} ${crop.side}"><image href="${attribute(logo)}" width="${crop.width}" height="${crop.height}"${look}/></svg>`;
    return `${offline ? GREY : ``}${image}`;
};

const picture = (logo: string, offline: boolean, crop: LogoCrop | undefined): string => {
    const preset = readLogoStyle(logo);
    return preset === undefined ? imageArt(logo, offline, crop) : presetArt(preset, offline);
};

// Pixels fainter than this are a soft edge or a shadow's tail, not the picture.
const SOLID = 24;

/** The square around a picture's visible pixels (RGBA, row by row), or undefined for one with none. */
export const visibleSquare = (pixels: Uint8ClampedArray, width: number, height: number): LogoCrop | undefined => {
    let left = width;
    let top = height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if ((pixels[(y * width + x) * 4 + 3] ?? 0) > SOLID) {
                left = Math.min(left, x);
                right = Math.max(right, x);
                top = Math.min(top, y);
                bottom = Math.max(bottom, y);
            }
        }
    }
    if (right < 0) {
        return undefined;
    }
    const side = Math.max(right - left, bottom - top) + 1;
    return { width, height, side, x: (left + right + 1 - side) / 2, y: (top + bottom + 1 - side) / 2 };
};

// A digit up to nine; past that a bare disc, since two digits at this size are a smudge and the title spells the count.
const asksGlyph = (count: number): string =>
    count > 9
        ? ``
        : `<text x="23" y="28" text-anchor="middle" font-family="system-ui,-apple-system,'Segoe UI',Roboto,Arial,Helvetica,sans-serif" font-size="14" font-weight="700" fill="#fff">${count}</text>`;

const CHECK = `<path d="M18.9 23.3l2.8 2.8 5.4-5.6" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;

interface Disc {
    readonly fill: string;
    // Its centre, on the diagonal: one number for both axes.
    readonly at: number;
    readonly radius: number;
    readonly glyph: string;
}

const discOf = (mark: TabMark): Disc | undefined => {
    switch (mark.kind) {
        case `asks`:
            return { fill: ASKS, at: 23, radius: 9, glyph: asksGlyph(mark.count) };
        case `done`:
            return { fill: DONE, at: 23, radius: 9, glyph: CHECK };
        // Smaller, bare and further into the corner: the ambient mark, which never outshouts one asking for the reader.
        case `working`:
            return { fill: WORKING, at: 25, radius: 6.5, glyph: `` };
        case `offline`:
            return undefined;
    }
};

/** The tab's icon: the logo (or the lotus) with the mark's disc, if any. Neither leaves the page's own icon, never drawn. */
export const iconSvg = (mark: TabMark | undefined, logo?: string, crop?: LogoCrop): string => {
    const disc = mark === undefined ? undefined : discOf(mark);
    const offline = mark?.kind === `offline`;
    const own = drawableLogo(logo);
    const art = own === undefined ? lotus(offline ? LOTUS_OFFLINE : LOTUS) : picture(own, offline, crop);
    // Under the lotus, the quadrant above and right of the disc goes too: only the outer petal's tip reaches there,
    // and past the ring it would float as a speck. A logo fills its square, so there it is only the ring.
    const corner = disc === undefined || own !== undefined ? `` : `<rect x="${disc.at}" width="${32 - disc.at}" height="${disc.at}" fill="#000"/>`;
    const body =
        disc === undefined
            ? art
            : `<mask id="cut"><rect width="32" height="32" fill="#fff"/><circle cx="${disc.at}" cy="${disc.at}" r="${disc.radius + 2.5}" fill="#000"/>${corner}</mask>` +
              `<g mask="url(#cut)">${art}</g><circle cx="${disc.at}" cy="${disc.at}" r="${disc.radius}" fill="${disc.fill}"/>${disc.glyph}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 32 32">${body}</svg>`;
};

// Two marks draw the same icon exactly when these match; the count only matters while it fits the disc.
export const iconKey = (mark: TabMark | undefined): string | undefined => {
    if (mark === undefined) {
        return undefined;
    }
    return mark.kind === `asks` ? `asks:${mark.count > 9 ? `many` : mark.count}` : mark.kind;
};

// The mark alone, for the desktop app's taskbar button (desktop-app badge.rs): Windows draws an app's overlay in the
// corner of its button, over the app's own icon, so the disc fills the overlay's square and carries the same glyph the
// tab's does. Work under way keeps its smaller, quieter dot, and offline, which greys the lotus on the tab, is a grey
// one: the taskbar's icon is the app's and cannot be greyed.
const OVERLAY_CHECK = `<path d="M9.2 16.5l4.6 4.7 9-9.4" fill="none" stroke="#fff" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/>`;

const overlayDigit = (count: number): string =>
    count > 9
        ? ``
        : `<text x="16" y="23.5" text-anchor="middle" font-family="system-ui,-apple-system,'Segoe UI',Roboto,Arial,Helvetica,sans-serif" font-size="21" font-weight="700" fill="#fff">${count}</text>`;

export const overlaySvg = (mark: TabMark): string => {
    let body: string;
    switch (mark.kind) {
        case `asks`:
            body = `<circle cx="16" cy="16" r="15" fill="${ASKS}"/>${overlayDigit(mark.count)}`;
            break;
        case `done`:
            body = `<circle cx="16" cy="16" r="15" fill="${DONE}"/>${OVERLAY_CHECK}`;
            break;
        case `working`:
            body = `<circle cx="16" cy="16" r="11" fill="${WORKING}"/>`;
            break;
        case `offline`:
            body = `<circle cx="16" cy="16" r="11" fill="${LOTUS_OFFLINE}"/>`;
            break;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${body}</svg>`;
};

const svgUrl = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** The SVG drawn as a PNG `size` pixels square, as a data URL, or undefined where this page cannot draw one. */
export const drawPng = (svg: string, size: number): Promise<string | undefined> =>
    new Promise((resolve) => {
        const image = new Image(size, size);
        image.addEventListener(`load`, () => {
            try {
                const canvas = document.createElement(`canvas`);
                canvas.width = size;
                canvas.height = size;
                const context = canvas.getContext(`2d`);
                if (context === null) {
                    resolve(undefined);
                    return;
                }
                context.drawImage(image, 0, 0, size, size);
                resolve(canvas.toDataURL(`image/png`));
                // allow(silent-catch): A canvas the page may not read back (or none at all) leaves the icon to the caller's fallback.
            } catch {
                resolve(undefined);
            }
        });
        image.addEventListener(`error`, () => resolve(undefined));
        image.src = svgUrl(svg);
    });

// Measured once per logo: the page keeps one or two, and a mark changing must not read the pixels again.
const crops = new Map<string, Promise<LogoCrop | undefined>>();

const measure = (logo: string): Promise<LogoCrop | undefined> =>
    new Promise((resolve) => {
        const image = new Image();
        image.addEventListener(`load`, () => {
            try {
                const { naturalWidth: width, naturalHeight: height } = image;
                const canvas = document.createElement(`canvas`);
                canvas.width = width;
                canvas.height = height;
                const context = canvas.getContext(`2d`, { willReadFrequently: true });
                if (context === null || width === 0 || height === 0) {
                    resolve(undefined);
                    return;
                }
                context.drawImage(image, 0, 0);
                resolve(visibleSquare(context.getImageData(0, 0, width, height).data, width, height));
                // allow(silent-catch): A picture the page may not read back is drawn whole, margin and all.
            } catch {
                resolve(undefined);
            }
        });
        image.addEventListener(`error`, () => resolve(undefined));
        image.src = logo;
    });

export const cropOf = (logo: string | undefined): Promise<LogoCrop | undefined> => {
    if (logo === undefined || readLogoStyle(logo) !== undefined) {
        return Promise.resolve(undefined);
    }
    let crop = crops.get(logo);
    if (crop === undefined) {
        crop = measure(logo);
        crops.set(logo, crop);
    }
    return crop;
};

// A PNG, where the browser can draw one: Safari shows no SVG icon a page sets, and every browser shows a PNG.
const rasterize = async (svg: string): Promise<{ readonly href: string; readonly type: string }> => {
    const png = await drawPng(svg, 64);
    return png === undefined ? { href: svgUrl(svg), type: `image/svg+xml` } : { href: png, type: `image/png` };
};

// The page's own icon links, set aside while a mark shows and put back when it goes. Removed rather than repointed: a
// browser choosing among several icons may keep the one it already chose, and a lone link inserted anew is read by all.
let originals: readonly HTMLLinkElement[] | undefined;
let ours: HTMLLinkElement | undefined;
let shown: string | undefined;
// Which request is the latest, so a slow draw for an older mark cannot land over a newer one.
let drawing = 0;

const place = (href: string, type: string): void => {
    originals ??= [...document.head.querySelectorAll<HTMLLinkElement>(`link[rel~="icon"]`)];
    for (const link of originals) {
        link.remove();
    }
    ours ??= document.createElement(`link`);
    ours.rel = `icon`;
    ours.type = type;
    ours.href = href;
    document.head.append(ours);
};

const restore = (): void => {
    ours?.remove();
    ours = undefined;
    for (const link of originals ?? []) {
        document.head.append(link);
    }
    originals = undefined;
};

/** Shows the icon for this mark over this logo, or the page's own for neither; one already showing costs nothing. */
export const showTabIcon = (mark: TabMark | undefined, logo?: string): void => {
    const own = drawableLogo(logo);
    const markKey = iconKey(mark);
    const key = own === undefined ? markKey : `${markKey ?? `none`}|${own}`;
    if (key === shown) {
        return;
    }
    shown = key;
    drawing += 1;
    const turn = drawing;
    if (key === undefined) {
        restore();
        return;
    }
    void cropOf(own)
        .then((crop) => rasterize(iconSvg(mark, own, crop)))
        .then(({ href, type }) => {
            if (turn === drawing) {
                place(href, type);
            }
        });
};
