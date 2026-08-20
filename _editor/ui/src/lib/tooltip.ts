import type { Directive, DirectiveBinding } from "vue";

/* `v-tooltip.top="'Archive'"`, the app's own hover label, replacing PrimeVue's directive.
 *
 * It is ours because PrimeVue's operates on the MODULE-SCOPE `document`: it appends to `document.body`,
 * looks its element up with `document.getElementById`, and aligns against the main window's viewport and
 * scroll. Half this app's tooltips live in the chat and terminal panels, which teleport into a REAL
 * `window.open` document while their JS stays in this realm (see usePopout), so hovering anything in a
 * popped-out panel drew the label in the ORIGINAL window, at the pop-out's coordinates, over whatever
 * happened to be there. Owning the directive fixes that for every call site at once: the box is created in
 * `el.ownerDocument` and measured against `el.ownerDocument.defaultView`, so it is correct in either window
 * by construction rather than by remembering to pass a target.
 *
 * Positioning is `fixed` against that window, which is also why there is no scroll math: a scroll moves the
 * anchor out from under the box, so the box is dismissed instead of chased (the pointer has left it anyway).
 *
 * Sizing is capped in CSS, not here, see --ui-tooltip-max-width / --ui-tooltip-max-lines in tokens.css. The
 * cap is deliberately wide: a tooltip is read in one glance, and a narrow box turns a long line of prose into
 * a tall slab that covers the thing it describes.
 *
 * Modifiers: `top` (default) | `bottom` | `left` | `right` pick the preferred side, it flips to the opposite
 * one when there is no room; `overflow` shows the label ONLY while the anchor's own text is clipped, which is
 * what a truncated cell wants (repeating text the user can already read in full is noise). Put `.overflow` on
 * the element that actually clips, not on a wrapper around it, the check is that element's own scrollWidth.
 *
 * This is the app's ONE tooltip. Native `title=` survives in exactly two places, both deliberate: an `<iframe
 * title>`, which is a required accessible name rather than a hint, and the panel resize handles, where the
 * browser's ~1s delay is the point, these open instantly, and a handle you sweep past on the way somewhere
 * else should not flash a box each time. Everything else that hints belongs here, so it can be restyled,
 * re-measured and kept out of the wrong window from one file.
 *
 * WHEN A CONTROL EARNS ONE. A tooltip is a LABEL FOR A CONTROL THAT HAS NO VISIBLE LABEL, not a place to
 * park prose that didn't fit. The audit that produced this list found 241 call sites, a third of them
 * telling the user something already on their screen, so the bar is written down rather than re-litigated:
 *
 *   1. An icon-only button, link or rail tile: yes. Three words or fewer, naming the action.
 *   2. `.overflow` on the element that actually clips: yes, always, that is text the user asked for and
 *      cannot read.
 *   3. A disabled control may say why it is disabled.
 *   4. A NON-INTERACTIVE element does not get a hover label. If a glyph or a number needs decoding, decode
 *      it on screen or drop the glyph, hovering a chip to be told the word you are reading is the kind of
 *      hint that teaches people to stop hovering anything. The one exception is a mark carrying a VALUE
 *      that exists nowhere else: an error string, a status detail, the name behind a bare dot.
 *   5. ONE TOOLTIP PER HOVER TARGET. Never put one on a descendant of a tooltipped element, `mouseenter`
 *      fires on both and the two boxes open on top of each other (the rail's tile-plus-badge did exactly
 *      this). Fold the child's text into the parent's label instead.
 *   6. Placement follows the layout: `.top`/`.bottom` inside a horizontal cluster, `.right`/`.left` inside
 *      a vertical stack. Sideways is for a narrow column spilling into the wide area next door, never for a
 *      button spilling onto the button beside it.
 *   7. Consequence disclosure belongs BESIDE the control as muted text, not in here. A hover paragraph
 *      never reaches a touch device, and it is gone the moment the pointer moves, see AgentConflictReport,
 *      which pairs every button with the sentence that qualifies it. */

const GAP = 6; // px between the anchor and the box — leaves room for the arrow
const EDGE = 8; // px of viewport kept clear on every side
const ARROW = 4; // px — half the arrow's width, mirrored by the border-width in tooltip.css

type Placement = "top" | "bottom" | "left" | "right";
type Modifier = Placement | "overflow";

const OPPOSITE: Record<Placement, Placement> = { top: `bottom`, bottom: `top`, left: `right`, right: `left` };

interface TooltipState {
    label: string | undefined;
    placement: Placement;
    // `.overflow`: the anchor's text is the label, so it only earns a box while that text is actually cut off.
    overflowOnly: boolean;
    box: HTMLElement | undefined;
    show: () => void;
    hide: () => void;
    onKeydown: (event: KeyboardEvent) => void;
    onFocus: () => void;
}

const states = new WeakMap<HTMLElement, TooltipState>();

const read = (binding: DirectiveBinding<string | undefined, Modifier>): Pick<TooltipState, "label" | "placement" | "overflowOnly"> => ({
    label: typeof binding.value === `string` && binding.value.trim() !== `` ? binding.value : undefined,
    placement:
        binding.modifiers.bottom === true ? `bottom` : binding.modifiers.left === true ? `left` : binding.modifiers.right === true ? `right` : `top`,
    overflowOnly: binding.modifiers.overflow === true,
});

// Rounding hides sub-pixel differences that would otherwise read as "clipped" on every zoom level.
const isClipped = (el: HTMLElement): boolean =>
    Math.round(el.scrollWidth) > Math.round(el.clientWidth) || Math.round(el.scrollHeight) > Math.round(el.clientHeight);

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), Math.max(min, max));

// Where the box goes, given the room this window actually has. The preferred side wins unless it does not
// fit AND its opposite does, flipping into an equally cramped side would only move the clipping.
const place = (box: HTMLElement, anchor: DOMRect, wanted: Placement, view: Window): Placement => {
    const { width, height } = box.getBoundingClientRect();
    const room: Record<Placement, boolean> = {
        top: anchor.top - GAP - height >= EDGE,
        bottom: anchor.bottom + GAP + height <= view.innerHeight - EDGE,
        left: anchor.left - GAP - width >= EDGE,
        right: anchor.right + GAP + width <= view.innerWidth - EDGE,
    };
    const placement = room[wanted] || !room[OPPOSITE[wanted]] ? wanted : OPPOSITE[wanted];
    const vertical = placement === `top` || placement === `bottom`;

    // Along the anchor's axis the box is pinned; across it, centred and then pulled inside the viewport.
    const left = vertical
        ? clamp(anchor.left + anchor.width / 2 - width / 2, EDGE, view.innerWidth - width - EDGE)
        : placement === `left`
          ? anchor.left - GAP - width
          : anchor.right + GAP;
    const top = vertical
        ? placement === `top`
            ? anchor.top - GAP - height
            : anchor.bottom + GAP
        : clamp(anchor.top + anchor.height / 2 - height / 2, EDGE, view.innerHeight - height - EDGE);

    // The arrow tracks the anchor's centre rather than the box's, so a box shoved off-centre by the clamp
    // above still points at what it describes. Kept a corner's width in from either end so it stays on the
    // box's straight edge.
    const centre = vertical ? anchor.left + anchor.width / 2 - left : anchor.top + anchor.height / 2 - top;
    const span = vertical ? width : height;
    box.style.setProperty(`--ui-tooltip-arrow`, `${Math.round(clamp(centre, ARROW * 3, span - ARROW * 3))}px`);
    box.style.left = `${Math.round(left)}px`;
    box.style.top = `${Math.round(top)}px`;
    return placement;
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
                // The anchor's OWN document, the pop-out's while the panel floats out there, this page's
                // otherwise. Everything below (append, measure, dismiss listeners) follows from it.
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
                box.appendChild(body);
                doc.body.appendChild(box);
                box.classList.add(`ui-tooltip-${place(box, el.getBoundingClientRect(), state.placement, view)}`);
                box.style.visibility = ``;
                state.box = box;
                // A scroll or resize moves the anchor out from under a fixed box; capture catches the
                // scrolling ancestor, whichever it is.
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
            // Keyboard focus earns the same label a hover gets; a click-focus does not, or every button
            // would keep its tooltip up after being pressed.
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
        const changed = next.label !== state.label || next.placement !== state.placement || next.overflowOnly !== state.overflowOnly;
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
