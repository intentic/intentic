import type { FleetAdvice, FleetMachine, MachineStanding } from "@intentic/sandbox-contract";
import { reactive } from "vue";
import type { Conversation } from "../../session/conversation";

// What the composer does with the fleet advice for one draft (settings `offload.sessions`): which machine its strip
// offers, and where an automatic placement puts it. Pure decisions over the advice and what happened to the draft on
// this page, kept apart from the query (fleetAdvice.ts) so each is pinned without a sandbox to ask.

const RANK = { calm: 0, busy: 1, full: 2 } as const satisfies Readonly<Record<MachineStanding, number>>;

// What happened to one draft's placement on this page: who placed it (the fleet by itself, or the person), whether
// they waved the suggestion away, and the runner the strip last offered, which it keeps offering while that machine
// stays a good answer rather than hopping between equals.
export interface DraftFleet {
    by: `fleet` | `person` | undefined;
    dismissed: boolean;
    offered: string | undefined;
}

// Memory only: a reload forgets who placed a draft, and reads a placed one as the person's, which nothing moves again.
const drafts = new WeakMap<Conversation, DraftFleet>();
export const draftFleet = (conversation: Conversation): DraftFleet => {
    let state = drafts.get(conversation);
    if (state === undefined) {
        state = reactive<DraftFleet>({ by: undefined, dismissed: false, offered: undefined });
        drafts.set(conversation, state);
    }
    return state;
};

const fitMachine = (advice: FleetAdvice, runner: string | undefined): FleetMachine | undefined =>
    runner === undefined ? undefined : advice.machines.find((machine) => machine.runner === runner && machine.unfit === undefined);

// Whether a machine the fleet already chose is still a good answer: fit, measured, and no worse off than here. Kept while
// it is, so a draft does not bounce between two machines as either crosses a threshold.
const stillGood = (advice: FleetAdvice, runner: string | undefined): FleetMachine | undefined => {
    const machine = fitMachine(advice, runner);
    return machine?.load !== undefined && RANK[machine.load.standing] <= RANK[advice.here.standing] ? machine : undefined;
};

// The runner the strip offers: the one it already offered while that stays good and this machine is still not calm,
// else the advice's own suggestion. Undefined while there is nothing to say.
export const offeredMachine = (advice: FleetAdvice | undefined, offered: string | undefined): FleetMachine | undefined => {
    if (advice === undefined || advice.mode === `off` || advice.here.standing === `calm`) {
        return undefined;
    }
    return stillGood(advice, offered) ?? fitMachine(advice, advice.suggestion?.runner);
};

// Where an automatic placement should put a draft now, or undefined to leave it as it is. Only in `auto`, only a draft
// the person has not placed or waved away, and only one that is here or where the fleet put it: a draft the fleet moved
// stays while that machine is still a good answer, follows a better suggestion once it is not, and comes back here when
// there is none.
export const autoPlacement = (
    advice: FleetAdvice | undefined,
    draft: Pick<DraftFleet, `by` | `dismissed`> & { readonly runner: string | undefined },
): { readonly runner: string | undefined } | undefined => {
    if (advice === undefined || advice.mode !== `auto` || draft.by === `person` || draft.dismissed) {
        return undefined;
    }
    if (draft.by === `fleet`) {
        if (stillGood(advice, draft.runner) !== undefined) {
            return undefined;
        }
        const next = advice.suggestion?.runner;
        return next === draft.runner ? undefined : { runner: next };
    }
    // Placed before this page knew of it (a restored tab): somebody's choice, which the fleet does not overrule.
    if (draft.runner !== undefined) {
        return undefined;
    }
    return advice.suggestion === undefined ? undefined : { runner: advice.suggestion.runner };
};
