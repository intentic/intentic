import { type AgentHarness, type AgentProvider, type FixResume, sendableEffort } from "@intentic/sandbox-contract";
import { shallowRef } from "vue";
import { defaultRunSettings, type RunSettingsPatch } from "../run-settings/pickerRunSettings";
import { modelLabelFor } from "../../accounts/providerCatalog";

/* THE SHELL'S MODEL PICKER, OPENED BY SOMETHING THAT IS NOT THE COMPOSER: a run button about to start an agent (useAgentRunPick), an automation rung. */

export interface ModelChoice {
    readonly provider: AgentProvider;
    readonly model: string;
    // What the app calls this pair; lets a caller's trigger name the choice without its own catalog.
    readonly label: string;
    // The pins the footer adds to the list's answer; absent unless the caller already holds one.
    readonly account?: string;
    readonly harness?: AgentHarness;
/* HOW THE MODEL ITSELF IS RUN: the tier it thinks at, whether it reasons first, and whether the work is bought at the faster rate. */
    readonly effort?: string;
    readonly thinking?: boolean;
    readonly fast?: boolean;
/* WHICH VERB ENDED THE PANEL, for a request that carried an attempt (`attempt` below). */
    readonly resume?: FixResume;
}

/* THE ATTEMPT ALREADY MADE AT THE FAILURE THIS RUN WOULD ANSWER, when there is one. */
export interface AttemptOnOffer {
    // One line: which attempt, on what, how it stands — "Attempt 1 · Opus 4.6 · stopped · 3 files on its branch".
    readonly summary: string;
    // Continuing is offered only for an attempt that ENDED; one still working or parked is steered from its own chat.
    readonly continuable: boolean;
}

/* Everything the panel holds while it is open: the selection, growing as the user edits it, until the commit bar hands it back. */
interface StagedPick {
    readonly provider: AgentProvider;
    readonly model: string;
    readonly account?: string | undefined;
    readonly harness?: AgentHarness | undefined;
    readonly effort?: string;
    readonly thinking?: boolean;
    readonly fast?: boolean;
}

/* WHAT A ROW MAY STAGE, and the shape that carries the difference between the two halves of the panel. */
type StagedPatch = {
    readonly provider?: AgentProvider;
    readonly model?: string;
    readonly account?: string | undefined;
    readonly harness?: AgentHarness | undefined;
} & RunSettingsPatch;

interface ModelRequest extends StagedPick {
    // The element the picker hangs off, and the window it opens in, see AnchoredOverlay.
    readonly anchor: HTMLElement;
/* THE CALLER'S OWN VERB, on the button that ends the panel. */
    readonly action: string;
/* WHETHER TO OFFER THE MODEL'S OWN RUN SETTINGS — reasoning effort, extended thinking, speed — which is the caller's answer about what it CARRIES. */
    readonly chooseRun?: boolean;
    // The attempt the bar's verbs are about; absent, the bar carries `action` alone.
    readonly attempt?: AttemptOnOffer | undefined;
    readonly settle: (choice: ModelChoice | undefined) => void;
}

// The open request, or undefined; the body mounts from this, so it is fresh (search, catalogs) on every open.
export const modelRequest = shallowRef<ModelRequest | undefined>(undefined);

/* EVERY ROW IN THE PANEL WRITES HERE, the model list included. */
export const stageModelPick = (patch: StagedPatch): void => {
    const pending = modelRequest.value;
    if (pending === undefined) {
        return;
    }
    modelRequest.value = { ...pending, ...patch };
};

/* THE PRESS. */
export const commitModelPick = (resume?: FixResume): void => {
    const pending = modelRequest.value;
    if (pending === undefined) {
        return;
    }
    const effort = sendableEffort(pending.effort, pending.thinking);
    settleModelPick({
        // Only a bar drawn over an attempt can name a verb; the answer says which one, or nothing, as the bar did.
        ...(resume !== undefined && pending.attempt !== undefined ? { resume } : {}),
        provider: pending.provider,
        model: pending.model,
        label: modelLabelFor(pending.provider, pending.model),
        ...(pending.account !== undefined ? { account: pending.account } : {}),
        ...(pending.harness !== undefined ? { harness: pending.harness } : {}),
        ...(effort === undefined || effort === `` ? {} : { effort }),
        ...(pending.thinking !== undefined ? { thinking: pending.thinking } : {}),
        ...(pending.fast !== undefined ? { fast: pending.fast } : {}),
    });
};

/* Any dismissal except the panel button cancels the selection. */
export const dismissModelPick = (): void => settleModelPick(undefined);

// Answer the open request, with a choice, or with undefined for a dismissal. Cleared BEFORE the promise
// settles, so a continuation that opens the picker again isn't torn down by its own predecessor.
export const settleModelPick = (choice?: ModelChoice): void => {
    const pending = modelRequest.value;
    modelRequest.value = undefined;
    pending?.settle(choice);
};

export const requestModelPick = (
    request: Omit<ModelRequest, "settle" | "action"> & { readonly action?: string | undefined },
): Promise<ModelChoice | undefined> => {
/* Asking again from the SAME trigger is the user clicking the chip they just opened, and that has to CLOSE the picker rather than blink it. */
    const sameTrigger = modelRequest.value?.anchor === request.anchor;
    dismissModelPick();
    if (sameTrigger) {
        return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
/* THE ONE PLACE THE HARNESS'S OWN ANSWERS ARE READ, and only for a panel that CARRIES run settings. */
        const seeded = request.chooseRun === true ? defaultRunSettings() : undefined;
        modelRequest.value = {
            ...request,
            ...(seeded === undefined
                ? {}
                : { effort: request.effort ?? seeded.effort, thinking: request.thinking ?? seeded.thinking, fast: request.fast ?? seeded.fast }),
            action: request.action ?? `Use this model`,
            settle: resolve,
        };
    });
};
