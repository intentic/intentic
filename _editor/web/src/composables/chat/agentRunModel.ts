import { type AgentRunPin, NATIVE_PROVIDERS, resolveAgentRunModels } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { useSandboxSettings } from "../sandbox/useSandboxSettings";
import { providerReady } from "./access";
import { modelChoiceLabel } from "./modelPins";
import { endpointProviders } from "./providerCatalog";

/* WHICH MODEL A RUN SOMEBODY'S BUTTON STARTED WILL OPEN ON, browser-side, the same rule the daemon reads
 * before it spends the session (contract agent-run-model.ts), read here for what only a UI needs: NAMING the
 * model on the run button before the click, and drawing the ordered list in Sandbox ▸ Agent ▸ Models.
 *
 * Sibling to quickModel.ts, and the differences between the two files are all differences between the settings
 * they serve rather than incidental: the options are in CATALOG order rather than cheapest-first (these runs
 * have to read a failing suite and repair it, so being on the budget tier is not a virtue here), and an empty
 * chain resolves to NOTHING rather than to an Auto ladder, the caller's floor is the user's own composer pick,
 * which is a choice they made rather than one this file guessed. */

/* NO OPTION LIST HERE ANY MORE. This file used to publish `agentRunModelGroups`, a provider-grouped list of
 * every pinnable model, for a 14rem dropdown in the settings row. That row now opens the app's own model picker
 * (ModelPinPicker → ModelPicker), which reads `pickerEntries` directly and brings the search, the provider rail
 * and the access badges the grouped copy could never carry. */

export interface AgentRunModel {
    // Every pin a surface-started run may open on, in the order the daemon will try them. Empty while settings
    // load, and once they have when nothing pinned is reachable, which is a real state the callers render as
    // "whatever the composer is set to" rather than as an error.
    readonly chain: ComputedRef<readonly AgentRunPin[]>;
    // The one a run actually opens on, WHOLE: its own effort, harness and speed are what the turn is composed
    // from. Undefined ⇒ the caller's own floor answers instead.
    readonly choice: ComputedRef<AgentRunPin | undefined>;
    readonly label: ComputedRef<string | undefined>;
    // The rest of the chain as people read it, for the line that says what happens if the first account is out.
    // Empty when there is no fallback to describe.
    readonly fallbackLabels: ComputedRef<readonly string[]>;
    // The stored setting: the ordered pins, as the user wrote them. Empty while settings load.
    readonly pinned: ComputedRef<readonly AgentRunPin[]>;
}

/* What the resolver decides over. Built from READINESS rather than from the option groups above, because the
 * two disagree in one case that matters: a connected provider whose catalog has not answered yet publishes no
 * options, and dropping its pin on that basis would make the run button name a different model for the first
 * second of every page load than the one the daemon is about to spend. */
const agentRunSources = computed(() =>
    [...NATIVE_PROVIDERS, ...endpointProviders.value.map((endpoint) => endpoint.id)].map((provider) => ({
        provider,
        ready: providerReady(provider),
        models: [],
    })),
);

export function useAgentRunModel(): AgentRunModel {
    const { settings } = useSandboxSettings();
    const pinned = computed<readonly AgentRunPin[]>(() => settings.value?.agentRunModels ?? []);
    // Settings not loaded yet ⇒ no answer rather than a guessed one: naming a model the user has not pinned
    // would flash the wrong spend on every run button on screen.
    const chain = computed<readonly AgentRunPin[]>(() =>
        settings.value === undefined ? [] : resolveAgentRunModels(agentRunSources.value, pinned.value),
    );
    const choice = computed(() => chain.value[0]);
    return {
        chain,
        choice,
        label: computed(() => (choice.value === undefined ? undefined : modelChoiceLabel(choice.value))),
        fallbackLabels: computed(() => chain.value.slice(1).map(modelChoiceLabel)),
        pinned,
    };
}
