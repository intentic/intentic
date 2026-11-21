import { type RunnerSummary, runnerSlug } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import type { DeviceSandbox } from "@intentic/sandbox-contract/schemas/devices";
import { t } from "@intentic/ui/i18n";

/* WHAT A NEW RUNNER MAY BE CALLED. Its name is its id: the container `runner-<name>` on that computer and this sandbox's
   enrollment for it. Both are one name each, so a name already used is said here, before a flow that would be refused
   minutes in (ic finds the container taken) or, worse, would replace the enrollment of this sandbox's runner of that name
   on another computer. A runner is renamed for people afterwards, by its label, without touching either. */

const NAME_RULE = /^[a-z0-9-]+$/;

// Why `name` cannot be a new runner's name on a computer listing `here`, given this sandbox's own runners; undefined when
// it can (or nothing is typed yet). Pure but for the words.
export const runnerNameProblem = (name: string, own: readonly Pick<RunnerSummary, `id`>[], here: readonly Pick<DeviceSandbox, `slug` | `runnerOf`>[]): string | undefined => {
    if (name === ``) {
        return undefined;
    }
    if (!NAME_RULE.test(name)) {
        return t(`sandbox.deviceRunners.nameRule`);
    }
    if (own.some((runner) => runner.id === name)) {
        return t(`sandbox.deviceRunners.nameTaken`, { name });
    }
    const taken = here.find((sandbox) => sandbox.slug === runnerSlug(name));
    if (taken === undefined) {
        return undefined;
    }
    const parent = taken.runnerOf?.name ?? undefined;
    return parent === undefined || parent === `` ? t(`sandbox.deviceRunners.nameTakenHereUnknown`, { name }) : t(`sandbox.deviceRunners.nameTakenHere`, { name, parent });
};
