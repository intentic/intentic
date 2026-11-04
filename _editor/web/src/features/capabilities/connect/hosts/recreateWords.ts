import { t } from "@intentic/ui/i18n";
import type { RecreateMode } from "../../../../app/environments/processes/processReport";
import type { RestartQuiet } from "../../../../models/sandbox/live/sandboxRestart";

// THE THREE SWAPS IN WORDS, shared by every lane that runs one (HostRecreate.vue, AppRecreateButton.vue). `Action` is the
// enum those switch on and the script they run, so its members are not the words on screen: every label takes these.

export type RecreateAction = `Update` | `Rebuild` | `Roll back`;

const VERBS = { Update: `update`, Rebuild: `rebuild`, "Roll back": `rollBack` } as const satisfies Readonly<Record<RecreateAction, string>>;

/** The action as a reader sees it: "Update", "Rebuild", "Roll back". */
export const verbOf = (action: RecreateAction): string => t(`capabilities.hostRecreate.${VERBS[action]}Verb`);

/** What the hub row, the receipt and the sandbox tile say while it works: "Updating this sandbox". */
export const workingWords = (action: RecreateAction): string => {
    switch (action) {
        case `Update`:
            return t(`capabilities.hostRecreate.workingUpdate`);
        case `Rebuild`:
            return t(`capabilities.hostRecreate.workingRebuild`);
        case `Roll back`:
            return t(`capabilities.hostRecreate.workingRollBack`);
    }
};

/** What the sandbox going quiet means while it runs, for every surface that isn't the card that pressed it. */
export const quietOf = (action: RecreateAction): RestartQuiet => {
    const detail = t(`common.restartQuiet.detail`);
    switch (action) {
        case `Update`:
            return { title: t(`capabilities.hostRecreate.restartingOntoUpdate`), detail };
        case `Rebuild`:
            return { title: t(`capabilities.hostRecreate.restartingOntoRebuiltEnvironment`), detail };
        case `Roll back`:
            return { title: t(`capabilities.hostRecreate.rollingSandboxBack`), detail };
    }
};

/** The action a recreate's report names (processReport.ts `RECREATE_MODES`). */
export const actionOfMode = (mode: RecreateMode): RecreateAction => {
    switch (mode) {
        case `update`:
            return `Update`;
        case `rebuild`:
            return `Rebuild`;
        case `rollback`:
            return `Roll back`;
    }
};
