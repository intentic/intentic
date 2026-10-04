// THE MOTION MODULE: everything about whether and how the interface moves, in one place.
//
// - choice.ts — the Appearance setting (System, On, Off), the `data-motion="reduced"` switch it writes on <html>,
//   and `lessMotion()`, which every move played from script asks before it starts.
// - loops.ts — the pace of a glyph that loops to say work is happening (a spinner, the thinking rosette): slowed rather
//   than stopped when motion is off, and where it may run on the compositor.
// - fold.ts — a tray folding out from under its card, and a column sliding its units to make room (FLIP).
// - reveal.ts — rows arriving in reading order when a list of sessions shows.
//
// Its stylesheet is ../styles/motion.css: the duration and curve tokens, the switch that stills every transition, and
// the few CSS recipes the views use (a chart growing from its baseline, the workspace arriving).

export {
    isMotionChoice,
    lessMotion,
    MOTION_CHOICES,
    type MotionChoice,
    motionChoice,
    REDUCE_MOTION_QUERY,
    resolveReducedMotion,
    useMotion,
} from "./choice.js";
export { setDeveloperBuild, useCompositedLoops, useReducedMotion, useTouchMotion } from "./loops.js";
export { canAnimate, FOLD_EASE, FOLD_MS, slideFrom, stopSlide, trayFold, useFoldFlip } from "./fold.js";
export { REVEAL_MS, REVEAL_RISE_PX, REVEAL_ROWS, REVEAL_STEP_MS, revealRows, type RowReveal, type RowRevealOptions, rowsUnder, useRowReveal } from "./reveal.js";
