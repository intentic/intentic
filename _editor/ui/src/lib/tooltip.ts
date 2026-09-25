import type { Directive, DirectiveBinding } from "vue";
import { placeAnchored, type Side } from "./anchorPlacement.js";

/* `v-tooltip.top="'Archive'"`, the app's own hover label, replacing PrimeVue's directive. */

const GAP = 6; // px between the anchor and the box: leaves room for the arrow
const EDGE = 8; // px of viewport kept clear on every side
const ARROW = 4; // px: half the arrow's width, mirrored by the border-width in tooltip.css

type Modifier = Side | "overflow" | "lines";

interface TooltipState {
    label: string | undefined;
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

const states = new WeakMap<HTMLElement, TooltipState>();

const read = (binding: DirectiveBinding<string | undefined, Modifier>): Pick<TooltipState, "label" | "side" | "overflowOnly" | "lines"> => ({
    label: typeof binding.value === `string` && binding.value.trim() !== `` ? binding.value : undefined,
    side:
        binding.modifiers.bottom === true ? `bottom` : binding.modifiers.left === true ? `left` : binding.modifiers.right === true ? `right` : `top`,
    overflowOnly: binding.modifiers.overflow === true,
    lines: binding.modifiers.lines === true,
});

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

export const vTooltip: Directive<HTMLElement, string | undefined, Modifier> = {
    mounted(el, binding) {
        const state: TooltipState = {
            ...read(binding),
            box: undefined,
            show: () => {
                state.hide();
                if (state.label === undefined || (state.overflowOnly && !isClipped(el))) {
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
                body.textContent = state.label; // a text node, so a label can never inject markup
                if (state.lines) {
                    body.style.whiteSpace = `pre-line`;
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
        // different, or a tooltip held open over a streaming panel would restart its fade on every frame.
        const changed =
            next.label !== state.label || next.side !== state.side || next.overflowOnly !== state.overflowOnly || next.lines !== state.lines;
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
