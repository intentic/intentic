import { computed, type ComputedRef } from "vue";
import { type MarkdownDecorator, renderMarkdown } from "../../markdown/render.js";
import { RENDERED } from "../../markdown/sourceDom.js";

// What the editing surface draws for a block it can only spell (raw HTML, a picture, inline tags): the block as the
// rendered document draws it, through the same engine and the same decorator, so the README a reader writes in reads
// like the README GitHub shows. sourceDom.ts leaves an empty holder in each such block; this fills it.

// Elements that show something with no text of their own; a rendering with none of these and no text draws nothing.
const SELF_SHOWING = `img, svg, video, audio, canvas, input, hr, picture, iframe`;

// Bounds the cache to a few documents' worth of blocks; the oldest rendering goes first.
const RENDERINGS_MAX = 256;

export interface RenderedDrawing {
    /** Fills every rendering holder under `root` whose rendering changed since it was last drawn. */
    draw: (root: HTMLElement, definitions: string) => void;
}

/**
 * A drawer for one surface. Each rendering is a computed, so it is parsed once per (source, definitions) and again only
 * when what the decorator read changes: a picture's bytes landing, the scheme it picks a `<source>` by. Call `draw`
 * inside an effect and those changes redraw the holders that use them.
 */
export const createRenderedDrawing = (decorate: () => MarkdownDecorator | undefined): RenderedDrawing => {
    const renderings = new Map<string, ComputedRef<string>>();
    const renderingOf = (key: string): ComputedRef<string> => {
        const known = renderings.get(key);
        if (known !== undefined) {
            return known;
        }
        const made = computed(() => renderMarkdown(key, decorate()));
        renderings.set(key, made);
        if (renderings.size > RENDERINGS_MAX) {
            const oldest = renderings.keys().next().value;
            if (oldest !== undefined) {
                renderings.delete(oldest);
            }
        }
        return made;
    };

    // What each holder was last filled with, so a redraw that changes nothing leaves the DOM (and a loaded picture) alone.
    const drawn = new WeakMap<HTMLElement, string>();

    const draw = (root: HTMLElement, definitions: string): void => {
        for (const holder of root.querySelectorAll<HTMLElement>(`.${RENDERED}`)) {
            const source = holder.dataset[`mdRenderSource`] ?? ``;
            const key = definitions === `` ? source : `${source}\n\n${definitions}`;
            const html = renderingOf(key).value;
            if (drawn.get(holder) === html) {
                continue;
            }
            drawn.set(holder, html);
            holder.innerHTML = html;
            // A rendering that draws nothing (a lone `<div align="center">`, a comment) would leave the block with no
            // height to click into; it is marked, and the stylesheet keeps its source on the page, quietly. The engine
            // answers such a block with its own source as text (render.ts `vanished`), so that counts as nothing too.
            const text = holder.textContent ?? ``;
            const nothing = holder.querySelector(SELF_SHOWING) === null && (text.trim() === `` || text === key);
            holder.parentElement?.toggleAttribute(`data-md-quiet`, nothing);
            if (nothing) {
                holder.replaceChildren();
            }
        }
    };

    return { draw };
};

// Elements whose opening tag, left open by one block, wraps the blocks after it until a later block closes it: the
// `<div align="center">` … `</div>` a README centres its header with, blank lines and markdown in between.
const CONTAINER = /<(\/?)(div|p|center|section|article|header|footer|main|aside|nav|figure)\b([^>]*)>/giu;
const ALIGN_ATTRIBUTE = /\balign\s*=\s*["']?(left|center|right)\b/iu;
const ALIGN_STYLE = /text-align\s*:\s*(left|center|right)\b/iu;

const alignOf = (tag: string, attributes: string): string | undefined =>
    tag.toLowerCase() === `center` ? `center` : (ALIGN_ATTRIBUTE.exec(attributes)?.[1] ?? ALIGN_STYLE.exec(attributes)?.[1])?.toLowerCase();

/**
 * Carries an alignment an HTML container opens across the blocks it wraps: each block inside a container that says
 * `align="center"` (or `text-align`) gets `data-md-align`, which the stylesheet reads. Only a block of HTML opens or
 * closes one.
 */
export const alignContainers = (blocks: readonly { readonly body: string; readonly element: HTMLElement }[]): void => {
    const open: (string | undefined)[] = [];
    for (const block of blocks) {
        const align = open.findLast((each) => each !== undefined);
        if (align === undefined) {
            delete block.element.dataset[`mdAlign`];
        } else {
            block.element.dataset[`mdAlign`] = align;
        }
        if (!block.body.trimStart().startsWith(`<`)) {
            continue;
        }
        for (const match of block.body.matchAll(CONTAINER)) {
            if (match[1] === `/`) {
                open.pop();
            } else {
                open.push(alignOf(match[2] ?? ``, match[3] ?? ``));
            }
        }
    }
};

// The text of a rendering, found in the source it was drawn from: the first place it occurs outside a tag (an `alt`
// can repeat a caption word for word, and a click on the caption means the caption).
const outsideTags = (source: string, needle: string): number => {
    for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + 1)) {
        if (source.lastIndexOf(`<`, at) <= source.lastIndexOf(`>`, at)) {
            return at;
        }
    }
    return source.indexOf(needle);
};

// What the browser says is under a point, in whichever spelling it implements.
const pointAt = (x: number, y: number): { readonly node: Node; readonly offset: number } | undefined => {
    // Optional at run time whatever the DOM typings say: Chromium shipped the standard spelling only in 128.
    const position = `caretPositionFromPoint` in document ? document.caretPositionFromPoint(x, y) : null;
    if (position !== null) {
        return { node: position.offsetNode, offset: position.offset };
    }
    const range = `caretRangeFromPoint` in document ? document.caretRangeFromPoint(x, y) : null;
    return range === null ? undefined : { node: range.startContainer, offset: range.startOffset };
};

/**
 * Where in a block's source a press on its rendering points: the word under the pointer, or a picture by its `alt`.
 * Zero, the block's start, when the rendering's text cannot be found in the source as written (an entity, a line the
 * renderer reflowed).
 */
export const sourceOffsetOfPress = (event: MouseEvent, holder: HTMLElement, source: string): number => {
    const target = event.target;
    if (target instanceof HTMLImageElement) {
        const alt = target.getAttribute(`alt`) ?? ``;
        const at = alt === `` ? -1 : source.indexOf(alt);
        return Math.max(0, at);
    }
    const point = pointAt(event.clientX, event.clientY);
    if (point === undefined || point.node.nodeType !== Node.TEXT_NODE || !holder.contains(point.node)) {
        return 0;
    }
    const text = point.node.textContent ?? ``;
    const at = text.trim() === `` ? -1 : outsideTags(source, text);
    return at === -1 ? 0 : at + Math.min(point.offset, text.length);
};
