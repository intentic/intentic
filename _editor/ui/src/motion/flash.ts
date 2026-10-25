import { lessMotion } from "./choice.js";
import { canAnimate } from "./fold.js";

// Highlights an already-visible target so a press or search result gives feedback even when nothing moves.
// An inset accent wash follows its corners without clipping; composite:add preserves existing shadows and selection edges.
// A 1px outline at offset -1px stays visible over opaque children without crowding text. Both layers fade together.
// Under reduced motion the glow holds still for the same duration, then disappears.

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
