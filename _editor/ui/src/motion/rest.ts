// WHILE NOBODY WATCHES, THE LOOPS HOLD STILL. A looping glyph (a turning spinner, the thinking rosette, a live band's
// sheen) keeps Chromium drawing a frame on every refresh of the display for as long as it runs, however little it moves
// and even on the compositor: measured 2026-11-25 in WebView2 158 on a 165 Hz panel, the /agents board with one spinner
// running held 30–37% of a core between the GPU process and the renderer, and 2–4% with it paused, frame for frame the
// same page. It is the count that matters, not the kind: a single loop is enough to keep every frame coming. The app is
// left open beside other work for hours, so nearly all of those frames were drawn for a window nobody was looking at.
//
// So the window rests: once it is hidden, once it has been out of focus and untouched for UNWATCHED_MS, or once it has
// been untouched for IDLE_MS even in focus, every endless animation holds the frame it is on, and the first input (or
// focus, or the window coming back) lets them go on from there. A still glyph beside a live turn reads as a hung one
// (loops.ts), which is why a focused window waits a full minute and a pointer merely passing over an unfocused one wakes
// it: anybody looking is likely to move something. Finite animations are left alone, since an arrival frozen on its
// first frame would hide what arrived.
//
// A CSS loop is held by the stylesheet, not by the Web Animations API: its element is marked LOOP_ATTRIBUTE, and
// motion.css pauses a marked element (and its ::before and ::after) while <html> carries REST_ATTRIBUTE. Pausing it from
// script would take its play state away from CSS for good, and a component that pauses its own loop (AgentHouse) would
// lose that. A loop started from script has no stylesheet to answer to, so it is paused and played from here. A loop that
// starts while the window rests is caught by its `animationstart`, and a sweep every SWEEP_MS catches a script's.
// Scroll- and view-driven animations are not loops on the clock and draw only when scrolled, so they are never touched.
//
// SMIL is not in `document.getAnimations()`. The SMIL drawn as CSS images (the skeleton's sheen and the freshness edge in
// utilities.css, the selection blade in the app's styles.css) is swapped for a still image by its own stylesheet under
// REST_ATTRIBUTE; the developer build's SMIL glyphs (useCompositedLoops) go on turning.

export const REST_ATTRIBUTE = `data-motion-rest`;
export const LOOP_ATTRIBUTE = `data-motion-loop`;
export const UNWATCHED_MS = 4_000;
export const IDLE_MS = 60_000;
export const SWEEP_MS = 10_000;

const INPUT = [`pointermove`, `pointerdown`, `keydown`, `wheel`, `touchstart`] as const;

const endless = (run: Animation): boolean => run.timeline === document.timeline && run.effect?.getTiming().iterations === Infinity;

// Marks every endless CSS loop's element for motion.css, and pauses every endless script loop into `held`.
const holdLoops = (held: Set<Animation>): void => {
    for (const run of document.getAnimations()) {
        if (!endless(run)) {
            continue;
        }
        if (`animationName` in run) {
            // SAFETY: a CSSAnimation's effect is always a KeyframeEffect, whose target is the element it runs on, or the one
            // whose ::before or ::after it runs on.
            const target = (run.effect as KeyframeEffect | null)?.target;
            if (target && !target.hasAttribute(LOOP_ATTRIBUTE)) {
                target.setAttribute(LOOP_ATTRIBUTE, ``);
            }
        } else if (run.playState === `running`) {
            run.pause();
            held.add(run);
        }
    }
};

// Lets the script loops held go on; the CSS ones go on by themselves once <html> drops REST_ATTRIBUTE.
const releaseLoops = (held: Set<Animation>): void => {
    for (const run of held) {
        if (run.playState === `paused`) {
            run.play();
        }
    }
    held.clear();
};

/**
 * Starts resting the window's endless animations while nobody watches it. Once per window, at boot; answers the function
 * that undoes it (for tests). Does nothing where there is no document or no Web Animations.
 */
export function installMotionRest(): () => void {
    if (!(`document` in globalThis) || !(`getAnimations` in document)) {
        return () => {};
    }
    const root = document.documentElement;
    const held = new Set<Animation>();
    let lastInputAt = Date.now();
    let resting = false;
    let look: ReturnType<typeof setTimeout> | undefined;
    let sweep: ReturnType<typeof setInterval> | undefined;

    const rest = (): void => {
        if (resting) {
            return;
        }
        resting = true;
        holdLoops(held);
        root.setAttribute(REST_ATTRIBUTE, ``);
        sweep = setInterval(() => holdLoops(held), SWEEP_MS);
    };
    const wake = (): void => {
        if (!resting) {
            return;
        }
        resting = false;
        root.removeAttribute(REST_ATTRIBUTE);
        clearInterval(sweep);
        sweep = undefined;
        releaseLoops(held);
    };

    // How long the window may go untouched before it rests: a minute in focus, moments out of it.
    const patience = (): number => (document.hasFocus() ? IDLE_MS : UNWATCHED_MS);

    // Looks when the window could first have gone quiet, and again at the next such moment if it was touched since. Focus
    // inside an embedded frame (a preview) is somebody at work, as inputAway.ts counts it: their input lands in the frame.
    const lookAgain = (): void => {
        clearTimeout(look);
        look = undefined;
        if (document.hasFocus() && document.activeElement?.tagName === `IFRAME`) {
            lastInputAt = Date.now();
        }
        const wait = patience() - (Date.now() - lastInputAt);
        if (document.visibilityState === `hidden` || wait <= 0) {
            rest();
            return;
        }
        look = setTimeout(lookAgain, wait);
    };

    // Every input only stamps a time: pointermove arrives at the pointer's own rate, so nothing else may happen here.
    const touched = (): void => {
        lastInputAt = Date.now();
        wake();
        look ??= setTimeout(lookAgain, patience());
    };
    const startedWhileResting = (): void => {
        if (resting) {
            holdLoops(held);
        }
    };
    const shown = (): void => (document.visibilityState === `hidden` ? lookAgain() : touched());

    for (const event of INPUT) {
        globalThis.addEventListener(event, touched, { capture: true, passive: true });
    }
    globalThis.addEventListener(`focus`, touched);
    // Losing focus shortens the patience, so the look is brought forward.
    globalThis.addEventListener(`blur`, lookAgain);
    document.addEventListener(`visibilitychange`, shown);
    document.addEventListener(`animationstart`, startedWhileResting, true);
    look = setTimeout(lookAgain, patience());

    return () => {
        wake();
        clearTimeout(look);
        for (const event of INPUT) {
            globalThis.removeEventListener(event, touched, { capture: true });
        }
        globalThis.removeEventListener(`focus`, touched);
        globalThis.removeEventListener(`blur`, lookAgain);
        document.removeEventListener(`visibilitychange`, shown);
        document.removeEventListener(`animationstart`, startedWhileResting, true);
    };
}
