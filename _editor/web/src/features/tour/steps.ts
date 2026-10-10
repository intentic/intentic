// THE GETTING-STARTED CHECKLIST, as data: which steps a first run walks, in what order, and where it stands. Pure, so
// the order and the rules about it are pinned by tests rather than by whichever screen happened to draw them.
//
// A step is DONE when the sandbox says so (files in the workspace, an agent started, a model of one's own connected,
// work landed), never by pressing "Next": the checklist teaches where things live by sending the reader to do them.
// What the sandbox cannot say, that the reader put the list away or passed a step over, is theirs and kept per member
// (gettingStartedChoices.ts).

export const STEP_IDS = [`work`, `agent`, `models`, `land`] as const;
export type StepId = (typeof STEP_IDS)[number];

// What the sandbox's own data says, each `undefined` until its read has landed: a step nobody has heard about yet is
// neither done nor current, so the list never flashes a step as next that a moment later turns out finished.
export interface StepFacts {
    // The workspace holds anything: a cloned repository, an upload, a folder an agent fetched.
    readonly work: boolean | undefined;
    // Any agent has run here (a sent turn registers one), the archive included.
    readonly agent: boolean | undefined;
    // A model of the reader's own can run: an account, a key, a local model, anything but the free trial.
    readonly models: boolean | undefined;
    // Work was brought in from an agent, or reviewed and filed: someone has been through the whole loop.
    readonly land: boolean | undefined;
    // Whether anything at all can run here right now, the free trial included. Without it the first agent cannot start,
    // so connecting a model comes first.
    readonly runnable: boolean | undefined;
    // An agent's work is waiting for review right now. That is the payoff the whole list leads to, so it goes next.
    readonly ready?: boolean;
    // The sandbox is past its first days: an agent on it last did anything more than a week ago. Work done in place
    // never lands (it was in the workspace all along), so a land alone cannot tell an old hand from a newcomer.
    readonly established?: boolean;
}

export interface Choices {
    readonly hidden: boolean;
    readonly skipped: readonly StepId[];
}

// Which steps a reader may pass over. Bringing work in can be "start from scratch"; one's own model can wait while the
// trial lasts. Starting an agent and landing its work are the loop the checklist exists to teach.
export const SKIPPABLE: ReadonlySet<StepId> = new Set<StepId>([`work`, `models`]);

export type StepState = `done` | `skipped` | `current` | `todo`;

export interface StepRow {
    readonly id: StepId;
    readonly state: StepState;
}

export interface Progress {
    readonly rows: readonly StepRow[];
    // The one step the beacons point at; absent while facts are still out, or once nothing is left.
    readonly current: StepId | undefined;
    // Done or passed over, out of all of them: what the ring fills to.
    readonly settled: number;
    readonly total: number;
    // Every fact is in.
    readonly known: boolean;
}

// The order steps are walked in: work first, since an agent with nothing to work on can only build from scratch; then
// the first agent on the trial, then one's own model while it works, then the land. With nothing runnable at all, the
// model moves to the front, since no agent can start before it; with work waiting for review, the land moves ahead of
// the model, since nobody should be sent to a settings page while the result they asked for sits unread.
export const stepOrder = (facts: StepFacts): readonly StepId[] => {
    if (facts.runnable === false && facts.models === false) {
        return [`models`, `work`, `agent`, `land`];
    }
    return facts.ready === true && facts.land !== true ? [`work`, `agent`, `land`, `models`] : STEP_IDS;
};

export const progress = (facts: StepFacts, choices: Choices): Progress => {
    const known = STEP_IDS.every((id) => facts[id] !== undefined) && facts.runnable !== undefined;
    const skipped = new Set(choices.skipped.filter((id) => SKIPPABLE.has(id)));
    const settledState = (id: StepId): StepState | undefined => (facts[id] === true ? `done` : skipped.has(id) ? `skipped` : undefined);
    const order = stepOrder(facts);
    const current = known ? order.find((id) => settledState(id) === undefined) : undefined;
    const rows = order.map((id): StepRow => ({ id, state: settledState(id) ?? (id === current ? `current` : `todo`) }));
    return { rows, current, settled: rows.filter((row) => row.state === `done` || row.state === `skipped`).length, total: rows.length, known };
};

// Whether the checklist is offered at all. Only to someone who can do every step (a maintainer: guests and
// collaborators can neither connect models nor land), only once every fact is in, and never on a sandbox past its
// first run: once work has landed, or once it has agents older than its first days, whatever else is unticked. So a
// long-standing owner is never handed a beginner's list the day this ships.
export const offered = (facts: StepFacts, choices: Choices, canShip: boolean): boolean => {
    const { known } = progress(facts, choices);
    return canShip && known && !choices.hidden && facts.land !== true && facts.established !== true;
};
