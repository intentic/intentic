import { t } from "@intentic/ui/i18n";
import { MODELS_PATH } from "../../lib/routes/modelsPath";
import type { MarkStep } from "./tourMarks";
import type { StepId } from "./steps";
import type { TourAction } from "./tourState";

// Every word the getting-started tour says, in one table: what each step is called on the checklist, and what each
// place that points at it says when its hint opens. A hint names where the reader is and the one thing to do there;
// a place whose own control is the press offers no action, and one that only leads somewhere offers the way there.

export interface StepWords {
    readonly title: string;
    readonly line: string;
    // Where the checklist's row sends the reader to do it.
    readonly to: string;
}

export const stepWords = (step: StepId): StepWords => {
    switch (step) {
        case `work`:
            return { title: t(`gettingStarted.steps.work.title`), line: t(`gettingStarted.steps.work.line`), to: `/workspace` };
        case `agent`:
            return { title: t(`gettingStarted.steps.agent.title`), line: t(`gettingStarted.steps.agent.line`), to: `/agents` };
        case `models`:
            return { title: t(`gettingStarted.steps.models.title`), line: t(`gettingStarted.steps.models.line`), to: MODELS_PATH };
        case `land`:
            return { title: t(`gettingStarted.steps.land.title`), line: t(`gettingStarted.steps.land.line`), to: `/agents` };
    }
};

// What passing a step over is called, where a step may be: work can start from nothing, a model can wait for the trial.
export const skipWords = (step: StepId): string => (step === `work` ? t(`gettingStarted.skip.work`) : t(`gettingStarted.skip.later`));

export interface HintWords {
    readonly title: string;
    readonly line: string;
    readonly action?: { readonly label: string; readonly to?: string; readonly run?: TourAction };
}

// The places a mark is drawn, and what each says. A place missing for a step says the step's own words.
export type MarkPlace = `rail` | `workspace` | `composer` | `board` | `models` | `card`;

export const hintWords = (step: MarkStep, place: MarkPlace, trial: boolean): HintWords => {
    const open = (label: string, to: string): HintWords[`action`] => ({ label, to });
    switch (`${step}:${place}`) {
        case `work:rail`:
            return { ...words(`workRail`), action: open(t(`gettingStarted.hints.openWorkspace`), `/workspace`) };
        case `work:workspace`:
            return { ...words(`workHere`), action: { label: t(`gettingStarted.skip.work`), run: `skipWork` } };
        case `agent:board`:
            return {
                title: t(`gettingStarted.hints.agentBoard.title`),
                line: trial ? t(`gettingStarted.hints.agentBoard.lineTrial`) : t(`gettingStarted.hints.agentBoard.line`),
                action: { label: t(`gettingStarted.hints.writeTask`), run: `writeTask` },
            };
        case `agent:composer`:
            return {
                title: t(`gettingStarted.hints.agentComposer.title`),
                line: trial ? t(`gettingStarted.hints.agentComposer.lineTrial`) : t(`gettingStarted.hints.agentComposer.line`),
            };
        case `agent:rail`:
            return { ...words(`agentRail`), action: open(t(`gettingStarted.hints.openBoard`), `/agents`) };
        case `board:rail`:
            return { ...words(`boardRail`), action: open(t(`gettingStarted.hints.openBoard`), `/agents`) };
        case `models:rail`:
            return { ...words(`modelsRail`), action: open(t(`gettingStarted.hints.openModels`), MODELS_PATH) };
        case `models:models`:
            return words(`modelsHere`);
        case `land:card`:
            return words(`landCard`);
        case `land:rail`:
            return { ...words(`landRail`), action: open(t(`gettingStarted.hints.openBoard`), `/agents`) };
        default:
            return step === `board` ? words(`boardRail`) : { title: stepWords(step).title, line: stepWords(step).line };
    }
};

const words = (key: string): HintWords => ({ title: t(`gettingStarted.hints.${key}.title`), line: t(`gettingStarted.hints.${key}.line`) });
