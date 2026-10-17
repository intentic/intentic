import { lessMotion } from "./choice.js";
import { canAnimate } from "./fold.js";

// THE "HERE IT IS" GLOW: what a press answers with when it lands on something already on screen, and what a search
// answer lands on. A press that changes nothing reads as a dead control and is pressed again (replays counted twenty
// presses on one board card, twelve on one link), so the thing it points at answers instead.
//
// It lights the thing, it does not box it. Two layers, both fading together over a breath:
//   · a WASH of the accent over the element's own ground: an inset box-shadow wide enough to fill it, so it sits under
//     the words and over the background, follows the element's own corners, and can never be clipped by an ancestor.
//     It is ADDED to the element's own shadows (`composite: add`), so a card's lift or a selection edge stays put.
//   · an EDGE of one pixel, drawn as an outline on the element's own border line (offset -1px): above whatever the
//     element holds, so a panel whose rows are opaque still shows it, and on the border, so it never crowds the words.
// A ring drawn two pixels inside the edge, which this replaced, read as a thick box pressed against the text and as a
// square cut into a rounded card. Asked for less motion, the glow holds still for the same time and then goes: a
// state shown, never a move.

export const FLASH_MS = 1_600;
// Tags this module's layers among an element's animations, so a second press restarts them rather than stacking more.
const FLASH = `flash-ring`;

const EDGE = `color-mix(in srgb, var(--color-primary-500) 60%, transparent)`;
const WASH = `color-mix(in srgb, var(--color-primary-500) 11%, transparent)`;
// Wider than any element is tall, so the inset shadow fills it whatever its size.
const FILL = `inset 0 0 0 100vmax`;
const EDGE_DRAWN = { outlineStyle: `solid`, outlineWidth: `1px`, outlineOffset: `-1px` };

// In quickly, held while the eye finds it, then out slowly: each segment eases on its own, so the hold is a hold.
const fade = <T extends Keyframe>(on: T, off: T): Keyframe[] =>
    lessMotion()
        ? [on, on]
        : [
              { ...off, offset: 0, easing: `ease-out` },
              { ...on, offset: 0.08 },
              { ...on, offset: 0.4, easing: `ease-in-out` },
              { ...off, offset: 1 },
          ];

// Lights `el` for FLASH_MS. A page without the Web Animations API (a test DOM) lights nothing.
export const flashElement = (el: Element | null | undefined): void => {
    if (!canAnimate(el)) {
        return;
    }
    for (const run of el.getAnimations?.() ?? []) {
        if (run.id === FLASH) {
            run.cancel();
        }
    }
    const timing = { duration: FLASH_MS, id: FLASH };
    el.animate(fade({ ...EDGE_DRAWN, outlineColor: EDGE }, { ...EDGE_DRAWN, outlineColor: `transparent` }), timing);
    el.animate(fade({ boxShadow: `${FILL} ${WASH}` }, { boxShadow: `${FILL} transparent` }), { ...timing, composite: `add` });
};
