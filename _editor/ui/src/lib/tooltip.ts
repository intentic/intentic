import type { Directive, DirectiveBinding } from "vue";
import { placeAnchored, type Side } from "./anchorPlacement.js";
import { isTip } from "./tipText.js";

/* `v-tooltip.top="'Archive'"`, the app's own hover label, replacing PrimeVue's directive.

   TWO SHAPES, ONE DIRECTIVE. A string is a label, and a label is a word or two: "Archive", "New tab". Anything that
   needs more is a `Tip`, drawn as a compact card: a short headline, its facts as label/figure rows, an optional
   key cap and one short closing line. A sentence in a hover box is read by nobody, so there is no third shape for
   one: `v-tooltip="{ title: 'Memory low', rows: [{ label: 'Resident', value: '7.4 GiB' }] }"`. */

const GAP = 6; // px between the anchor and the box: leaves room for the arrow
const EDGE = 8; // px of viewport kept clear on every side
const ARROW = 4; // px: half the arrow's width, mirrored by the border-width in tooltip.css

type Modifier = Side | "overflow" | "lines";

/** Colours a tip's headline dot or one of its figures. */
export type TipTone = "info" | "ok" | "warn" | "danger";

/** One fact on a tip card: a word or two, and the figure or name it comes to. */
export interface TipRow {
    readonly label: string;
    readonly value: string | number;
    readonly tone?: TipTone | undefined;
}

/** A hover card, for what a one- or two-word label cannot say. Every part stays short: it is glanced at, not read.
 *  An absent part may be passed as `undefined`, so a card is one literal rather than a chain of conditional spreads. */
export interface Tip {
    /** The headline, a word or two: "Memory low", "Delete all". */
    readonly title: string;
    /** A shortcut, drawn as a key cap beside the headline: "Shift+Enter". */
    readonly keys?: string | undefined;
    /** A dot before the headline, for a state rather than an action. */
    readonly tone?: TipTone | undefined;
    /** The facts, one per row. Numbers and names, not clauses. */
    readonly rows?: readonly TipRow[] | undefined;
    /** One closing line of a few words: "Can't be undone". */
    readonly note?: string | undefined;
}

/** What `v-tooltip` takes: a short label, a tip card, or nothing (no box). */
export type TooltipValue = string | Tip | false | null | undefined;

// What an anchor's box says, read once from the binding: a label's words, or a tip's parts.
type Said = { readonly kind: `label`; readonly text: string } | { readonly kind: `tip`; readonly tip: Tip };

interface TooltipState {
    said: Said | undefined;
    // What the box would say, as one string, so a re-render that rebuilds an equal `Tip` literal is not a change.
    key: string;
    side: Side;
    // `.overflow`: the anchor's text is the label, so it only earns a box while that text is actually cut off.
    overflowOnly: boolean;
    // `.lines`: the label is a short list, one reading per line, so its line breaks are kept rather than folded to spaces.
    lines: boolean;
    box: HTMLElement | undefined;
    show: () => void;
    hide: () => void;
    onKeydown: (event: KeyboardEvent) => void;
    onFocus: () => void;
}

// Nothing to say is no box: a blank label, a tip with no headline, or no value at all.
const saidOf = (value: TooltipValue): Said | undefined => {
    if (!isTip(value)) {
        return value === false || value === null || value === undefined || value.trim() === `` ? undefined : { kind: `label`, text: value };
    }
    return value.title.trim() === `` ? undefined : { kind: `tip`, tip: value };
};

const states = new WeakMap<HTMLElement, TooltipState>();

const read = (binding: DirectiveBinding<TooltipValue, Modifier>): Pick<TooltipState, "said" | "key" | "side" | "overflowOnly" | "lines"> => {
    const said = saidOf(binding.value);
    return {
        said,
        key: said === undefined ? `` : said.kind === `label` ? said.text : JSON.stringify(said.tip),
        side:
            binding.modifiers.bottom === true ? `bottom` : binding.modifiers.left === true ? `left` : binding.modifiers.right === true ? `right` : `top`,
        overflowOnly: binding.modifiers.overflow === true,
        lines: binding.modifiers.lines === true,
    };
};

// A tip's parts as elements, every word a text node so a label can never inject markup.
const part = (doc: Document, tag: string, className: string, text?: string): HTMLElement => {
    const el = doc.createElement(tag);
    el.className = className;
    if (text !== undefined) {
        el.textContent = text;
    }
    return el;
};

const drawTip = (doc: Document, body: HTMLElement, tip: Tip): void => {
    const head = part(doc, `div`, `ui-tip-head`);
    if (tip.tone !== undefined) {
        const dot = part(doc, `span`, `ui-tip-dot`);
        dot.dataset[`tone`] = tip.tone;
        head.appendChild(dot);
    }
    head.appendChild(part(doc, `span`, `ui-tip-title`, tip.title));
    if (tip.keys !== undefined && tip.keys.trim() !== ``) {
        head.appendChild(part(doc, `kbd`, `ui-tip-keys`, tip.keys));
    }
    body.appendChild(head);
    const rows = (tip.rows ?? []).filter((row) => row.label.trim() !== `` && String(row.value).trim() !== ``);
    if (rows.length > 0) {
        const list = part(doc, `dl`, `ui-tip-rows`);
        for (const row of rows) {
            list.appendChild(part(doc, `dt`, ``, row.label));
            const value = part(doc, `dd`, ``, String(row.value));
            if (row.tone !== undefined) {
                value.dataset[`tone`] = row.tone;
            }
            list.appendChild(value);
        }
        body.appendChild(list);
    }
    if (tip.note !== undefined && tip.note.trim() !== ``) {
        body.appendChild(part(doc, `div`, `ui-tip-note`, tip.note));
    }
};

// Rounding hides sub-pixel differences that would otherwise read as "clipped" on every zoom level.
const isClipped = (el: HTMLElement): boolean =>
    Math.round(el.scrollWidth) > Math.round(el.clientWidth) || Math.round(el.scrollHeight) > Math.round(el.clientHeight);

// Where the box goes, in the anchor's own window: centred across the anchor on the wanted side, flipped only
// when that helps (placeAnchored's rule). The arrow tracks the anchor's centre rather than the box's, so a box
// shoved off-centre to stay on screen still points at what it describes; it is kept a corner's width in from
// either end so it stays on the box's straight edge.
const place = (box: HTMLElement, anchor: DOMRect, wanted: Side, view: Window): Side => {
    const { width, height } = box.getBoundingClientRect();
    const placed = placeAnchored({
        anchor,
        box: { width, height },
        view: { width: view.innerWidth, height: view.innerHeight },
        side: wanted,
        cross: `center`,
        gap: GAP,
        edge: EDGE,
    });
    const span = placed.side === `top` || placed.side === `bottom` ? width : height;
    box.style.setProperty(`--ui-tooltip-arrow`, `${Math.round(Math.max(ARROW * 3, Math.min(placed.arrow, span - ARROW * 3)))}px`);
    box.style.left = `${Math.round(placed.left)}px`;
    box.style.top = `${Math.round(placed.top)}px`;
    return placed.side;
};

export const vTooltip: Directive<HTMLElement, TooltipValue, Modifier> = {
    mounted(el, binding) {
        const state: TooltipState = {
            ...read(binding),
            box: undefined,
            show: () => {
                state.hide();
                const said = state.said;
                if (said === undefined || (said.kind === `label` && state.overflowOnly && !isClipped(el))) {
                    return;
                }
                // Uses the anchor's own document/window, whether it's on the page or a popped-out panel.
                const doc = el.ownerDocument;
                const view = doc.defaultView;
                if (view === null) {
                    return;
                }
                const box = doc.createElement(`div`);
                box.className = `ui-tooltip`;
                box.setAttribute(`role`, `tooltip`);
                box.style.visibility = `hidden`; // measured before it is placed; revealed once it is
                const body = doc.createElement(`div`);
                body.className = `ui-tooltip-body`;
                if (said.kind === `label`) {
                    body.textContent = said.text; // a text node, so a label can never inject markup
                    if (state.lines) {
                        body.style.whiteSpace = `pre-line`;
                    }
                } else {
                    box.classList.add(`ui-tooltip-card`);
                    drawTip(doc, body, said.tip);
                }
                box.appendChild(body);
                doc.body.appendChild(box);
                box.classList.add(`ui-tooltip-${place(box, el.getBoundingClientRect(), state.side, view)}`);
                box.style.visibility = ``;
                state.box = box;
                // Scroll or resize moves the anchor from under a fixed box; capture catches whichever ancestor
                // scrolled.
                doc.addEventListener(`scroll`, state.hide, true);
                view.addEventListener(`resize`, state.hide);
            },
            hide: () => {
                const box = state.box;
                if (box === undefined) {
                    return;
                }
                state.box = undefined;
                box.ownerDocument.removeEventListener(`scroll`, state.hide, true);
                box.ownerDocument.defaultView?.removeEventListener(`resize`, state.hide);
                box.remove();
            },
            onKeydown: (event) => {
                if (event.key === `Escape`) {
                    state.hide();
                }
            },
            // Keyboard focus shows the label too; click-focus doesn't, or every pressed button would keep its tooltip
            // up.
            onFocus: () => {
                if (el.matches(`:focus-visible`)) {
                    state.show();
                }
            },
        };
        states.set(el, state);
        el.addEventListener(`mouseenter`, state.show);
        el.addEventListener(`mouseleave`, state.hide);
        el.addEventListener(`click`, state.hide);
        el.addEventListener(`focus`, state.onFocus);
        el.addEventListener(`blur`, state.hide);
        el.addEventListener(`keydown`, state.onKeydown);
    },
    updated(el, binding) {
        const state = states.get(el);
        if (state === undefined) {
            return;
        }
        const next = read(binding);
        // `updated` fires on every re-render of the owning component, not just when the label changes, and a
        // chat mid-stream re-renders constantly. Rebuild the box only when it would actually say something
        // different, or a tooltip held open over a streaming panel would restart its fade on every frame. A `Tip` is
        // compared by what it says, since a template builds a fresh object literal on every render.
        const changed = next.key !== state.key || next.side !== state.side || next.overflowOnly !== state.overflowOnly || next.lines !== state.lines;
        Object.assign(state, next);
        if (changed && state.box !== undefined) {
            state.show();
        }
    },
    unmounted(el) {
        const state = states.get(el);
        if (state === undefined) {
            return;
        }
        state.hide();
        el.removeEventListener(`mouseenter`, state.show);
        el.removeEventListener(`mouseleave`, state.hide);
        el.removeEventListener(`click`, state.hide);
        el.removeEventListener(`focus`, state.onFocus);
        el.removeEventListener(`blur`, state.hide);
        el.removeEventListener(`keydown`, state.onKeydown);
        states.delete(el);
    },
};

// Every template's `v-tooltip` is type-checked against what the directive takes, so a sentence-shaped object or a
// misspelt `Tip` field is a build error rather than an empty box.
declare module "vue" {
    interface GlobalDirectives {
        vTooltip: typeof vTooltip;
    }
}
