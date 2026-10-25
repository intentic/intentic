// Shared motion: choice.ts owns System/On/Off and lessMotion(), which script animations check before starting.
// loops.ts slows activity glyphs under reduced motion; fold/reveal/flash handle layout, row arrival and target feedback.
// swipe.ts resolves gestures; spring.ts carries release velocity into compositor easing without per-frame script.
// ../styles/motion.css owns duration/curve tokens, CSS recipes and the data-motion="reduced" transition switch.

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
export { FLASH_MS, flashElement } from "./flash.js";
export {
    ARRIVE,
    FLING,
    SETTLE,
    type Spring,
    springAt,
    springPoints,
    springReaches,
    springSettles,
    type SpringTiming,
    springTiming,
    travelsPerSecond,
} from "./spring.js";
export { type Axis, AXIS_SLOP_PX, commits, lockAxis, type Release, rubberBand, tick, velocityTracker, type VelocityTracker } from "./swipe.js";
export {
    DISMISS_MS,
    DISMISS_STEP_MS,
    dismissRows,
    REVEAL_MS,
    REVEAL_RISE_PX,
    REVEAL_ROWS,
    REVEAL_STEP_MS,
    revealRows,
    type RowReveal,
    type RowRevealOptions,
    rowsUnder,
    settleDismissed,
    useRowReveal,
} from "./reveal.js";
