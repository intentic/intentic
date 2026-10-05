import type { LocalProjectBuild } from "@intentic/web/local-host";
import type { SetupArgs, SetupReport } from "../desktop";
import type { ProgressView } from "../setupPlan";

// A FOLDER'S BUILD AS ITS CARD DRAWS IT (the web's local/LocalProjectBuild.vue): this window's setup store, adopted for
// the folder (setup.ts `adoptSetup`), read into the few facts the card shows. Pure, so the one rule in it is testable:
// a folder is READY once its copy is in, while the device's own connection still finishes behind it.

export interface BuildFacts {
    /** The folder build this window adopted, kept past the run's end. */
    readonly adopted: SetupArgs | undefined;
    /** How the setup stands (setup.ts `setupState`). */
    readonly state: SetupReport[`state`];
    readonly view: ProgressView | undefined;
    /** Why it stopped, in the setup's own words. */
    readonly error: string | undefined;
}

// The last phase of a setup, connecting this machine as a device so the workspace can manage its sandboxes: nothing in
// it is the folder's, so the folder's sandbox is ready from the moment it starts (and the reader is spared its ~20s).
const AFTER_THE_FOLDER = `connecting-machine`;

const stateOf = (facts: BuildFacts, phase: string | undefined): LocalProjectBuild[`state`] => {
    switch (facts.state) {
        case `running`:
            return phase === AFTER_THE_FOLDER ? `ready` : `building`;
        case `waiting`:
            return `waiting`;
        case `stopped`:
            return `stopped`;
        case `done`:
            return `ready`;
        default:
            return `failed`;
    }
};

export const projectBuildOf = (facts: BuildFacts): LocalProjectBuild | undefined => {
    const args = facts.adopted;
    if (args === undefined) {
        return undefined;
    }
    const steps = facts.view?.steps ?? [];
    const running = steps.find((step) => step.state === `running`);
    // A run that ended keeps the phase it ended on: the house stands as far as it got.
    const reachedTo = running ?? steps.findLast((step) => step.state === `done`);
    const phase = reachedTo?.phase;
    const state = stateOf(facts, running?.phase);
    return {
        name: args.name ?? args.project ?? ``,
        state,
        phase,
        phaseProgress: facts.view?.stepProgress ?? 0,
        step: running?.label,
        percent: state === `ready` ? 100 : (facts.view?.percent ?? 0),
        remainingMs: state === `building` ? facts.view?.remainingMs : undefined,
        error: state === `failed` ? facts.error : undefined,
    };
};

/** The workspace's address for the built sandbox, opened on the folder (the app's project.rs `project_path`). */
export const projectPathOf = (args: Pick<SetupArgs, `sandboxId` | `project`>): string | undefined => {
    if (args.sandboxId === undefined || args.sandboxId === ``) {
        return undefined;
    }
    const query = new URLSearchParams({ sandbox: args.sandboxId });
    if (args.project !== undefined && args.project !== ``) {
        query.set(`project`, args.project);
    }
    return `/?${query.toString()}`;
};
