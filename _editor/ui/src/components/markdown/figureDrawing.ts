import { renderMermaid } from "../charts/mermaidRender.js";
import { FIGURE_HOLDER } from "../../markdown/sourceDom.js";

// The editing surface rebuilds a block's element on every keystroke in it, and on a highlight landing, so a diagram is
// drawn once per (look, source) and every rebuilt holder takes the cached picture; `null` is a source mermaid refused.
const drawn = new Map<string, string | null>();
// Bounds the cache to a few documents' worth of diagrams; the oldest drawing goes first.
const DRAWN_MAX = 64;

const remember = (key: string, svg: string | null): void => {
    drawn.set(key, svg);
    if (drawn.size > DRAWN_MAX) {
        const oldest = drawn.keys().next().value;
        if (oldest !== undefined) {
            drawn.delete(oldest);
        }
    }
};

// The block shows its picture at rest only once there is one; a refused diagram stays the code that failed.
const show = (holder: HTMLElement, svg: string | null): void => {
    const block = holder.parentElement;
    if (svg === null) {
        holder.replaceChildren();
        delete block?.dataset[`mdDrawn`];
        return;
    }
    holder.innerHTML = svg;
    if (block !== null) {
        block.dataset[`mdDrawn`] = ``;
    }
};

/** Draws every diagram holder under `root` not yet drawn in `look` (the scheme and accent the palette is read from). */
export const drawFigures = (root: HTMLElement, scheme: "light" | "dark", look: string): void => {
    const font = getComputedStyle(root).fontFamily;
    for (const holder of root.querySelectorAll<HTMLElement>(`.${FIGURE_HOLDER}`)) {
        if (holder.dataset[`mdFigureLook`] === look) {
            continue;
        }
        holder.dataset[`mdFigureLook`] = look;
        const code = holder.dataset[`mdFigureCode`] ?? ``;
        const key = `${look}\n${code}`;
        const cached = drawn.get(key);
        if (cached !== undefined) {
            show(holder, cached);
            continue;
        }
        void renderMermaid(code, scheme, font).then(
            (svg) => {
                remember(key, svg);
                if (holder.isConnected && holder.dataset[`mdFigureLook`] === look) {
                    show(holder, svg);
                }
            },
            () => {
                remember(key, null);
                if (holder.isConnected && holder.dataset[`mdFigureLook`] === look) {
                    show(holder, null);
                }
            },
        );
    }
};
