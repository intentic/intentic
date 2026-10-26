import { t } from "@intentic/ui/i18n";
import { gigabytes } from "./engineMove";

// A MOVE BETWEEN ENGINES IN THE READER'S WORDS, wherever one is drawn: the engine card's own move (components/EngineCard.vue)
// and the one a PC's setup carries (pcSetup/setupLine.ts). Its step, which sandbox of how many, and its bytes.

// The steps this app has words for (`desktop.engine.step.*`); a step a newer ic adds is left unsaid.
const WORDED: ReadonlySet<string> = new Set([`source`, `engine`, `begin`, `stopping`, `image`, `volume`, `starting`, `moved`]);

/** A step of ic's, said: "Copying its files". */
export const stepWords = (step: string | undefined): string | undefined =>
    step !== undefined && WORDED.has(step) ? t(`desktop.engine.step.${step}`) : undefined;

/** Which sandbox of how many, from 0, once there is more than one: "sandbox 2 of 3". */
export const positionWords = (index: number | undefined, count: number | undefined): string | undefined =>
    index === undefined || count === undefined || count < 2 ? undefined : t(`desktop.engine.position`, { index: index + 1, count });

/** A copy's bytes: so far, and of how many where ic says. An image's size is ic's estimate before it is saved, so it is
 *  said as one. Nothing for a step that copies nothing. */
export const copiedWords = (step: string | undefined, done: number | undefined, total: number | undefined): string | undefined => {
    if ((step !== `image` && step !== `volume`) || done === undefined) {
        return undefined;
    }
    const so = gigabytes(done);
    if (total === undefined || total === 0) {
        return t(`desktop.engine.copiedSoFar`, { done: so });
    }
    return step === `image`
        ? t(`desktop.engine.copiedAbout`, { done: so, total: gigabytes(total) })
        : t(`desktop.engine.copied`, { done: so, total: gigabytes(total) });
};
