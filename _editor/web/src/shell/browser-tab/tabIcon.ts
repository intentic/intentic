import type { TabMark } from "./tabSignal";

// The tab's icon for a mark: the lotus (public/favicon.svg, the same paths) with a disc in its lower right corner, cut
// out of the flower by a ring so it reads on a light tab strip and a dark one alike. Drawn at 32 units and meant to be
// seen at 16 pixels, so the disc is half the icon wide and carries one glyph at most.

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

export const iconSvg = (mark: TabMark): string => {
    const disc = discOf(mark);
    const flower = lotus(mark.kind === `offline` ? LOTUS_OFFLINE : LOTUS);
    const body =
        disc === undefined
            ? flower
            : // The quadrant above and right of the disc goes too: only the outer petal's tip reaches there, and past the
              // ring it would float as a speck.
              `<mask id="cut"><rect width="32" height="32" fill="#fff"/><circle cx="${disc.at}" cy="${disc.at}" r="${disc.radius + 2.5}" fill="#000"/>` +
              `<rect x="${disc.at}" width="${32 - disc.at}" height="${disc.at}" fill="#000"/></mask>` +
              `<g mask="url(#cut)">${flower}</g><circle cx="${disc.at}" cy="${disc.at}" r="${disc.radius}" fill="${disc.fill}"/>${disc.glyph}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 32 32">${body}</svg>`;
};

// Two marks draw the same icon exactly when these match; the count only matters while it fits the disc.
export const iconKey = (mark: TabMark | undefined): string | undefined => {
    if (mark === undefined) {
        return undefined;
    }
    return mark.kind === `asks` ? `asks:${mark.count > 9 ? `many` : mark.count}` : mark.kind;
};

const svgUrl = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

// A PNG, where the browser can draw one: Safari shows no SVG icon a page sets, and every browser shows a PNG.
const rasterize = (svg: string): Promise<{ readonly href: string; readonly type: string }> =>
    new Promise((resolve) => {
        const fallback = { href: svgUrl(svg), type: `image/svg+xml` };
        const image = new Image(64, 64);
        image.addEventListener(`load`, () => {
            try {
                const canvas = document.createElement(`canvas`);
                canvas.width = 64;
                canvas.height = 64;
                const context = canvas.getContext(`2d`);
                if (context === null) {
                    resolve(fallback);
                    return;
                }
                context.drawImage(image, 0, 0, 64, 64);
                resolve({ href: canvas.toDataURL(`image/png`), type: `image/png` });
            } catch {
                resolve(fallback);
            }
        });
        image.addEventListener(`error`, () => resolve(fallback));
        image.src = svgUrl(svg);
    });

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

/** Shows the icon for this mark, or the page's own for none; a mark already showing costs nothing. */
export const showTabIcon = (mark: TabMark | undefined): void => {
    const key = iconKey(mark);
    if (key === shown) {
        return;
    }
    shown = key;
    drawing += 1;
    const turn = drawing;
    if (mark === undefined) {
        restore();
        return;
    }
    void rasterize(iconSvg(mark)).then(({ href, type }) => {
        if (turn === drawing) {
            place(href, type);
        }
    });
};
