import type { ListenerPlanItem, ListenerStep } from "@intentic/sandbox-contract";
import { currentStep, elapsedOf, formatElapsed, stepPhrase, type TurnProgress } from "./progress.js";

// What a chat's status card says about a turn, before any platform draws it: where the turn stands (working, done,
// waiting for approval…), the last few steps, the checklist, and which buttons it offers. Every chat gateway draws this
// one model in its own markup (a Discord embed, Slack blocks), so a card reads the same wherever the team works. Pure:
// the same progress always gives the same card.

// How much of the agent's work a card shows: every step with what it touched, the steps without it (for a channel that
// should see that the agent works, not which files and commands), or no card at all.
export type ProgressDetail = "steps" | "quiet" | "off";

export const progressDetailOf = (value: string | undefined): ProgressDetail => (value === "quiet" || value === "off" ? value : "steps");

// A Stop button's id carries the conversation it stops; the gateway reads it back when someone presses it.
export const STOP_BUTTON = "intentic:stop:";

export const stopButtonId = (conversationId: string): string => `${STOP_BUTTON}${conversationId}`;

export const stopTarget = (buttonId: string): string | undefined =>
    buttonId.startsWith(STOP_BUTTON) && buttonId.length > STOP_BUTTON.length ? buttonId.slice(STOP_BUTTON.length) : undefined;

export interface CardView {
    readonly progress: TurnProgress;
    readonly now: number;
    readonly detail: Exclude<ProgressDetail, "off">;
    // The agent's latest short line of narration, which reads better on the card than as a message of its own.
    readonly headline?: string;
    // Someone pressed Stop: who, while it winds down and after.
    readonly stoppedBy?: string;
}

// How many steps a card lists, and checklist items; the rest are counted.
export const STEPS_SHOWN = 6;
export const PLAN_SHOWN = 8;
// How long one line of a card may run before it is cut.
export const CARD_LINE_MAX = 140;

export const clipLine = (text: string, max = CARD_LINE_MAX): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

// Where the turn stands. `held`, `queued`, `not-started` and `not-run` are a turn that never opened: parked for a
// person, waiting behind another turn, refused, or never run at all.
export type CardState = "working" | "done" | "failed" | "stopping" | "stopped" | "held" | "queued" | "not-started" | "not-run";

// One step as a card lists it, already worded.
export interface CardStep {
    readonly status: ListenerStep["status"];
    readonly verb: string;
    readonly object?: string;
}

export interface StatusCard {
    readonly state: CardState;
    // A working card: it still changes, and only it offers Stop.
    readonly live: boolean;
    // How long the turn has worked, as a status reads it ("1m 12s").
    readonly elapsed: string;
    readonly stepCount: number;
    readonly stoppedBy?: string;
    // The sentence a held or queued card says about why it waits.
    readonly note?: string;
    // While working: the narration line, the steps not listed, the steps listed (oldest first), and what the agent does
    // when no step runs.
    readonly headline?: string;
    readonly earlier: number;
    readonly steps: readonly CardStep[];
    readonly idle?: "thinking" | "writing";
    // The checklist (the first PLAN_SHOWN items) and how many more it has; a turn that never opened has none.
    readonly plan: readonly ListenerPlanItem[];
    readonly planMore: number;
    // The conversation a Stop button stops, when the card offers one.
    readonly stop?: string;
    // Where the conversation opens in the app.
    readonly link?: string;
}

const notOpenedState = (progress: TurnProgress): Pick<StatusCard, "state" | "note"> | undefined => {
    if (progress.held !== undefined) {
        return { state: "held", note: progress.held };
    }
    if (progress.failed !== undefined) {
        return { state: "not-started" };
    }
    if (progress.ended) {
        return { state: "not-run" };
    }
    if (progress.queued !== undefined) {
        return { state: "queued", note: progress.queued };
    }
    return undefined;
};

const stateOf = (view: CardView): Pick<StatusCard, "state" | "note"> => {
    const { progress } = view;
    const waiting = progress.opened === undefined ? notOpenedState(progress) : undefined;
    if (waiting !== undefined) {
        return waiting;
    }
    if (view.stoppedBy !== undefined) {
        return { state: progress.ended ? "stopped" : "stopping" };
    }
    if (progress.ended) {
        return { state: progress.failed === undefined ? "done" : "failed" };
    }
    return { state: "working" };
};

export const statusCardOf = (view: CardView): StatusCard => {
    const { progress } = view;
    const { state, note } = stateOf(view);
    const live = state === "working";
    const shown = live ? progress.steps.slice(-STEPS_SHOWN) : [];
    const plan = progress.opened === undefined ? [] : (progress.plan ?? []);
    let card: StatusCard = {
        state,
        live,
        elapsed: formatElapsed(elapsedOf(progress, view.now)),
        stepCount: progress.stepCount,
        earlier: live ? progress.stepCount - shown.length : 0,
        steps: shown.map((step) => ({ status: step.status, ...stepPhrase(step, view.detail === "quiet") })),
        plan: plan.slice(0, PLAN_SHOWN),
        planMore: Math.max(0, plan.length - PLAN_SHOWN),
    };
    if (note !== undefined) {
        card = { ...card, note };
    }
    if (view.stoppedBy !== undefined) {
        card = { ...card, stoppedBy: view.stoppedBy };
    }
    if (live && view.headline !== undefined) {
        card = { ...card, headline: view.headline };
    }
    if (live && currentStep(progress) === undefined) {
        card = { ...card, idle: progress.writing ? "writing" : "thinking" };
    }
    const opened = progress.opened;
    if (live && opened !== undefined && view.stoppedBy === undefined) {
        card = { ...card, stop: opened.conversationId };
    }
    if (opened?.link !== undefined) {
        card = { ...card, link: opened.link };
    }
    return card;
};
