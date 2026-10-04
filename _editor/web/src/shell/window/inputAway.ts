import { readonly, ref, type Ref } from "vue";

// Whether the window is on screen with nobody touching it: the half of "is anybody here" that visibility cannot answer.
// onScreen.ts says whether the window can be seen; a desktop left on overnight with the editor in front says yes all
// night, and the sandbox then believed somebody was at the editor until morning. Reported to the daemon beside `idle`
// (usePresence.ts), where an automatic update reads it to tell a person at work from an editor left open.
//
// Cheap on purpose: every input only stamps a time, and one timer looks at the stamp when the window could first have
// gone quiet. Focus inside an embedded frame (a preview) counts as a person at work, since their keys and clicks land in
// the frame and never reach this window.

export const AWAY_AFTER_MS = 10 * 60_000;

// allow(module-state): this window's own input, one per window like its visibility
const away = ref(false);
let lastInputAt = Date.now();
let timer: ReturnType<typeof setTimeout> | undefined;

const workingInFrame = (): boolean => typeof document !== `undefined` && document.hasFocus() && document.activeElement?.tagName === `IFRAME`;

// Looks when the window could first have gone quiet, and again at the next such moment if it was touched since.
const look = (): void => {
    timer = undefined;
    if (workingInFrame()) {
        lastInputAt = Date.now();
    }
    const quietFor = Date.now() - lastInputAt;
    if (quietFor >= AWAY_AFTER_MS) {
        away.value = true;
        return;
    }
    timer = setTimeout(look, AWAY_AFTER_MS - quietFor);
};

/** Somebody touched the window: stamped, and back from away at once. Exported for tests, which have no hands. */
export const touchWindow = (at: number = Date.now()): void => {
    lastInputAt = at;
    if (away.value) {
        away.value = false;
    }
    timer ??= setTimeout(look, AWAY_AFTER_MS);
};

/** True once the window has gone untouched for AWAY_AFTER_MS. */
export const awayFromWindow: Readonly<Ref<boolean>> = readonly(away);

if (typeof window !== `undefined`) {
    const touched = (): void => touchWindow();
    for (const event of [`keydown`, `pointerdown`, `pointermove`, `wheel`, `touchstart`] as const) {
        window.addEventListener(event, touched, { capture: true, passive: true });
    }
    timer = setTimeout(look, AWAY_AFTER_MS);
}
