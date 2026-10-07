import { lessMotion } from "./choice.js";
import { canAnimate } from "./fold.js";

// THE "HERE IT IS" RING: what a press answers with when it lands on something already on screen. A press that changes
// nothing reads as a dead control and is pressed again (replays counted twenty presses on one board card, twelve on one
// link), so the thing it points at answers instead: a ring round it, fading over a breath. An outline drawn inside the
// element's own edge, so no ancestor's clip cuts it off and no box-shadow of its own (a card's selection edge) is
// replaced while it plays. Asked for less motion, the ring holds still for the same time and then goes: a state shown,
// never a move.

export const FLASH_MS = 1_000;
// Tags this module's ring among an element's animations, so a second press restarts it rather than stacking a second.
const FLASH = `flash-ring`;

const RING = `color-mix(in srgb, var(--color-primary-500) 70%, transparent)`;
const DRAWN = { outlineStyle: `solid`, outlineWidth: `2px`, outlineOffset: `-2px` };

// Rings `el` for FLASH_MS. A page without the Web Animations API (a test DOM) rings nothing.
export const flashElement = (el: Element | null | undefined): void => {
    if (!canAnimate(el)) {
        return;
    }
    for (const run of el.getAnimations?.() ?? []) {
        if (run.id === FLASH) {
            run.cancel();
        }
    }
    const frames = lessMotion()
        ? [
              { ...DRAWN, outlineColor: RING },
              { ...DRAWN, outlineColor: RING },
          ]
        : [
              { ...DRAWN, outlineColor: RING },
              { ...DRAWN, outlineColor: RING, offset: 0.45 },
              { ...DRAWN, outlineColor: `transparent` },
          ];
    el.animate(frames, { duration: FLASH_MS, easing: `ease-out`, id: FLASH });
};
