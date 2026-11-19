// glance's pixels: the RGB canvas a sheet is drawn on, its 8x16 label font, the grid fitter that keeps a sheet inside the
// budget an agent's image Read takes whole, and the before/after difference. Node builtins only; the engines that decode
// and encode (ffmpeg, else ImageMagick) are glance-engine.mjs, so a sheet looks the same whichever one the image ships.

// What one image Read shows without scaling it down first: the longest side and the area past which a vision model
// resizes, and a file size that keeps a Read cheap. A sheet larger than this would be shrunk again where its labels
// stop being legible, so glance lays out for it rather than encoding big and hoping.
export const BUDGET = { maxSide: 1568, maxPixels: 1_150_000, maxBytes: 1_000_000 };

// GNU Unifont's ASCII glyphs (U+0020..U+007E, SIL OFL 1.1), 16 rows of 8 pixels each, most significant bit leftmost.
// Embedded so labels need no font, no fontconfig and no drawtext on the image: the core image has none of them.
const FONT = Buffer.from(
    "AAAAAAAAAAAAAAAAAAAAAAAAAAgICAgICAgACAgAAAAAIiIiIgAAAAAAAAAAAAAAAAAAEhISfiQkfkhISAAAAAAAAAg+SUg4DglJPggAAAAAAAAx" +
        "Sko0CAgWKSlGAAAAAAAAHCIiFBgpRUJGOQAAAAAICAgIAAAAAAAAAAAAAAAAAAQICBAQEBAQEAgIBAAAAAAgEBAICAgICAgQECAAAAAAAAAACEkq" +
        "HCpJCAAAAAAAAAAAAAgICH8ICAgAAAAAAAAAAAAAAAAAAAAYCAgQAAAAAAAAAAAAPAAAAAAAAAAAAAAAAAAAAAAAABgYAAAAAAAAAgIECAgQECBA" +
        "QAAAAAAAABgkQkZKUmJCJBgAAAAAAAAIGCgICAgICAg+AAAAAAAAPEJCAgwQIEBAfgAAAAAAADxCQgIcAgJCQjwAAAAAAAAEDBQkRER+BAQEAAAA" +
        "AAAAfkBAQHwCAgJCPAAAAAAAABwgQEB8QkJCQjwAAAAAAAB+AgIEBAQICAgIAAAAAAAAPEJCQjxCQkJCPAAAAAAAADxCQkI+AgICBDgAAAAAAAAA" +
        "ABgYAAAAGBgAAAAAAAAAAAAYGAAAABgICBAAAAAAAAACBAgQIBAIBAIAAAAAAAAAAAB+AAAAfgAAAAAAAAAAAEAgEAgECBAgQAAAAAAAADxCQgIE" +
        "CAgACAgAAAAAAAAcIkpWUlJSTiAeAAAAAAAAGCQkQkJ+QkJCQgAAAAAAAHxCQkJ8QkJCQnwAAAAAAAA8QkJAQEBAQkI8AAAAAAAAeERCQkJCQkJE" +
        "eAAAAAAAAH5AQEB8QEBAQH4AAAAAAAB+QEBAfEBAQEBAAAAAAAAAPEJCQEBOQkJGOgAAAAAAAEJCQkJ+QkJCQkIAAAAAAAA+CAgICAgICAg+AAAA" +
        "AAAAHwQEBAQEBEREOAAAAAAAAEJESFBgYFBIREIAAAAAAABAQEBAQEBAQEB+AAAAAAAAQkJmZlpaQkJCQgAAAAAAAEJiYlJSSkpGRkIAAAAAAAA8" +
        "QkJCQkJCQkI8AAAAAAAAfEJCQnxAQEBAQAAAAAAAADxCQkJCQkJaZjwDAAAAAAB8QkJCfEhEREJCAAAAAAAAPEJCQDAMAkJCPAAAAAAAAH8ICAgI" +
        "CAgICAgAAAAAAABCQkJCQkJCQkI8AAAAAAAAQUFBIiIiFBQICAAAAAAAAEJCQkJaWmZmQkIAAAAAAABCQiQkGBgkJEJCAAAAAAAAQUEiIhQICAgI" +
        "CAAAAAAAAH4CAgQIECBAQH4AAAAAAA4ICAgICAgICAgIDgAAAAAAQEAgEBAICAQCAgAAAAAAcBAQEBAQEBAQEBBwAAAAGCRCAAAAAAAAAAAAAAAA" +
        "AAAAAAAAAAAAAAAAAH8AACAQCAAAAAAAAAAAAAAAAAAAAAAAADxCAj5CQkY6AAAAAABAQEBcYkJCQkJiXAAAAAAAAAAAPEJAQEBAQjwAAAAAAAIC" +
        "AjpGQkJCQkY6AAAAAAAAAAA8QkJ+QEBCPAAAAAAADBAQEHwQEBAQEBAAAAAAAAAAAjpEREQ4IDxCQjwAAABAQEBcYkJCQkJCQgAAAAAACAgAGAgI" +
        "CAgICD4AAAAAAAQEAAwEBAQEBAQESDAAAABAQEBESFBgUEhEQgAAAAAAGAgICAgICAgICD4AAAAAAAAAAHZJSUlJSUlJAAAAAAAAAABcYkJCQkJC" +
        "QgAAAAAAAAAAPEJCQkJCQjwAAAAAAAAAAFxiQkJCQmJcQEAAAAAAAAA6RkJCQkJGOgICAAAAAAAAXGJCQEBAQEAAAAAAAAAAADxCQDAMAkI8AAAA" +
        "AAAAEBAQfBAQEBAQDAAAAAAAAAAAQkJCQkJCRjoAAAAAAAAAAEJCQiQkJBgYAAAAAAAAAABBSUlJSUlJNgAAAAAAAAAAQkIkGBgkQkIAAAAAAAAA" +
        "AEJCQkJCJhoCAjwAAAAAAAB+AgQIECBAfgAAAAAADBAQCAgQIBAICBAQDAAACAgICAgICAgICAgICAgAAAAwCAgQEAgECBAQCAgwAAAAMUlGAAAA" +
        "AAAAAAAAAAA=",
    "base64",
);
export const GLYPH_W = 8;
export const GLYPH_H = 16;

export const COLORS = {
    page: [22, 22, 24],
    cell: [34, 34, 38],
    text: [232, 232, 232],
    dim: [150, 150, 155],
    checkerA: [58, 58, 62],
    checkerB: [74, 74, 78],
    change: [255, 40, 90],
    box: [255, 214, 0],
};

export const canvas = (width, height, color = COLORS.page) => {
    const data = Buffer.alloc(width * height * 3);
    for (let i = 0; i < data.length; i += 3) {
        data[i] = color[0];
        data[i + 1] = color[1];
        data[i + 2] = color[2];
    }
    return { width, height, data };
};

const put = (c, x, y, color) => {
    if (x < 0 || y < 0 || x >= c.width || y >= c.height) {
        return;
    }
    const at = (y * c.width + x) * 3;
    c.data[at] = color[0];
    c.data[at + 1] = color[1];
    c.data[at + 2] = color[2];
};

export const fillRect = (c, x, y, width, height, color) => {
    for (let row = y; row < y + height; row++) {
        for (let col = x; col < x + width; col++) {
            put(c, col, row, color);
        }
    }
};

export const strokeRect = (c, x, y, width, height, color) => {
    fillRect(c, x, y, width, 1, color);
    fillRect(c, x, y + height - 1, width, 1, color);
    fillRect(c, x, y, 1, height, color);
    fillRect(c, x + width - 1, y, 1, height, color);
};

// An RGBA image drawn at (x, y), its transparent parts over a checkerboard so "transparent" reads as such.
export const drawRgba = (c, rgba, width, height, x, y) => {
    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const from = (row * width + col) * 4;
            const alpha = rgba[from + 3] / 255;
            const under = ((col >> 3) + (row >> 3)) % 2 === 0 ? COLORS.checkerA : COLORS.checkerB;
            put(c, x + col, y + row, [0, 1, 2].map((k) => Math.round(rgba[from + k] * alpha + under[k] * (1 - alpha))));
        }
    }
};

// One line of text, top-left at (x, y); a character outside printable ASCII draws as '?'.
export const drawText = (c, text, x, y, color = COLORS.text) => {
    [...text].forEach((char, index) => {
        const code = char.codePointAt(0) ?? 63;
        const glyph = code >= 32 && code <= 126 ? code - 32 : 31;
        for (let row = 0; row < GLYPH_H; row++) {
            const bits = FONT[glyph * GLYPH_H + row];
            for (let col = 0; col < GLYPH_W; col++) {
                if ((bits & (0x80 >> col)) !== 0) {
                    put(c, x + index * GLYPH_W + col, y + row, color);
                }
            }
        }
    });
};

// `text` cut to `max` characters, keeping its start and its end (a file name's end is what tells frames apart).
export const fitText = (text, max) => {
    if (text.length <= max) {
        return text;
    }
    if (max <= 2) {
        return text.slice(0, Math.max(0, max));
    }
    const tail = Math.ceil((max - 2) / 2);
    return `${text.slice(0, max - 2 - tail)}..${text.slice(text.length - tail)}`;
};

// The box an image takes inside a w×h cell, never stretched: a small one is enlarged by a whole factor only (pixel art
// stays crisp, sampled nearest), a large one is shrunk by area averaging.
export const fitInside = (width, height, boxW, boxH) => {
    const scale = Math.min(boxW / width, boxH / height);
    if (scale >= 2) {
        const whole = Math.floor(scale);
        return { width: width * whole, height: height * whole, sampling: "nearest" };
    }
    if (scale >= 1) {
        return { width, height, sampling: "nearest" };
    }
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), sampling: "area" };
};

const GAP = 6;
export const LABEL_H = GLYPH_H + 4;

const sheetSize = (cols, rows, cellW, cellH, labelH) => ({ width: cols * cellW + (cols + 1) * GAP, height: rows * (cellH + labelH) + (rows + 1) * GAP });

const fits = (size, budget) => size.width <= budget.maxSide && size.height <= budget.maxSide && size.width * size.height <= budget.maxPixels;

// The widest cell `cols` columns of `aspect`-shaped cells can have inside the budget (and `maxWidth`), by bisection.
const widestCell = (n, cols, aspect, labelH, budget, maxWidth) => {
    const rows = Math.ceil(n / cols);
    let low = 0;
    let high = Math.floor((Math.min(maxWidth, budget.maxSide) - (cols + 1) * GAP) / cols);
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(sheetSize(cols, rows, mid, Math.round(mid / aspect), labelH), budget)) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    return low;
};

// The grid for n cells: the column count (given, or the one giving the biggest cells, up to `target` wide, and of
// those the smallest sheet) and the cell size inside the budget. `aspect` is width/height of the cells' common shape.
export const fitGrid = ({ n, aspect, cols, labelH, target = Number.POSITIVE_INFINITY, budget = BUDGET, maxWidth = BUDGET.maxSide }) => {
    const cellAspect = Math.min(4, Math.max(0.25, aspect));
    const choices = cols === undefined ? Array.from({ length: n }, (_, index) => index + 1) : [Math.min(cols, n)];
    let best;
    for (const each of choices) {
        const cellW = Math.min(target, widestCell(n, each, cellAspect, labelH, budget, maxWidth));
        const size = sheetSize(each, Math.ceil(n / each), cellW, Math.round(cellW / cellAspect), labelH);
        const area = size.width * size.height;
        if (best === undefined || cellW > best.cellW || (cellW === best.cellW && area < best.area)) {
            best = { cols: each, cellW, area };
        }
    }
    const rows = Math.ceil(n / best.cols);
    const cellH = Math.max(1, Math.round(best.cellW / cellAspect));
    return { cols: best.cols, rows, cellW: best.cellW, cellH, labelH, ...sheetSize(best.cols, rows, best.cellW, cellH, labelH) };
};

// Where cell `index` of a grid starts: its image box at (x, y), its label strip below it.
export const cellOrigin = (grid, index) => ({
    x: GAP + (index % grid.cols) * (grid.cellW + GAP),
    y: GAP + Math.floor(index / grid.cols) * (grid.cellH + (grid.labelH ?? 0) + GAP),
});

export const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length === 0 ? 1 : sorted[Math.floor(sorted.length / 2)];
};

const deltaAt = (a, b, at) => Math.max(Math.abs(a[at] - b[at]), Math.abs(a[at + 1] - b[at + 1]), Math.abs(a[at + 2] - b[at + 2]), Math.abs(a[at + 3] - b[at + 3]));

// Per-pixel difference of two same-sized RGBA images: the largest channel delta of each pixel (alpha included), and
// what an agent needs to call it changed or not without looking.
export const diffImages = (a, b, width, height, tolerance = 0) => {
    const delta = new Uint8Array(width * height);
    let changed = 0;
    let large = 0;
    let max = 0;
    let sum = 0;
    const box = { x0: width, y0: height, x1: -1, y1: -1 };
    for (let i = 0; i < delta.length; i++) {
        const value = deltaAt(a, b, i * 4);
        delta[i] = value;
        sum += value;
        max = Math.max(max, value);
        large += value > 16 ? 1 : 0;
        if (value > tolerance) {
            changed++;
            const x = i % width;
            const y = (i - x) / width;
            box.x0 = Math.min(box.x0, x);
            box.y0 = Math.min(box.y0, y);
            box.x1 = Math.max(box.x1, x);
            box.y1 = Math.max(box.y1, y);
        }
    }
    const region = changed === 0 ? undefined : { x: box.x0, y: box.y0, width: box.x1 - box.x0 + 1, height: box.y1 - box.y0 + 1 };
    return { delta, total: delta.length, changed, large, max, mean: sum / delta.length, region };
};

// The difference drawn at (x, y) as a w×h panel: the after image as dim grey, every changed pixel bright, shrunk by
// taking each panel pixel's largest delta, so a single changed pixel in a big image still shows. The changed region is
// outlined.
export const drawDiff = (c, { after, delta, width, height, region, tolerance }, x, y, w, h) => {
    for (let row = 0; row < h; row++) {
        const sy0 = Math.floor((row * height) / h);
        const sy1 = Math.max(sy0 + 1, Math.floor(((row + 1) * height) / h));
        for (let col = 0; col < w; col++) {
            const sx0 = Math.floor((col * width) / w);
            const sx1 = Math.max(sx0 + 1, Math.floor(((col + 1) * width) / w));
            const centre = (Math.floor((sy0 + sy1 - 1) / 2) * width + Math.floor((sx0 + sx1 - 1) / 2)) * 4;
            let most = 0;
            for (let sy = sy0; sy < sy1; sy++) {
                for (let sx = sx0; sx < sx1; sx++) {
                    most = Math.max(most, delta[sy * width + sx]);
                }
            }
            const grey = Math.round((after[centre] * 0.3 + after[centre + 1] * 0.59 + after[centre + 2] * 0.11) * 0.3 * (after[centre + 3] / 255)) + 16;
            put(c, x + col, y + row, most > tolerance ? COLORS.change.map((k) => Math.round(k * (0.55 + (0.45 * most) / 255))) : [grey, grey, grey]);
        }
    }
    if (region !== undefined) {
        // At least 12 px across, so a one-pixel change is found by its box.
        const bw = Math.max(12, Math.ceil((region.width * w) / width) + 4);
        const bh = Math.max(12, Math.ceil((region.height * h) / height) + 4);
        const cx = x + ((region.x + region.width / 2) * w) / width;
        const cy = y + ((region.y + region.height / 2) * h) / height;
        strokeRect(c, Math.round(cx - bw / 2), Math.round(cy - bh / 2), bw, bh, COLORS.box);
    }
};
