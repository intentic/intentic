import { type ModelPin, type ModelRole, NATIVE_PROVIDERS, resolveRoleModels } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { useSandboxSettings } from "../sandbox/useSandboxSettings";
import { providerReady } from "./access";
import { modelChoiceLabel } from "./modelPins";
import { endpointProviders, modelOptionsFor } from "./providerCatalog";

/* WHICH MODELS ONE JOB WILL RUN, AND IN WHAT ORDER, browser-side: the same rule the daemon walks before it
 * spends anything (contract model-pins.ts), read here for the three things only a UI needs — NAMING the model
 * on the button that is about to spend it, drawing each row in Sandbox ▸ Agent ▸ Models, and showing the
 * fallbacks underneath so the order is something you can see rather than something you have to remember.
 *
 * The first of those is the discoverability path for the whole feature, and it is the reason the settings can
 * afford to live on a settings page at all: the button says which model it will use and where to change it, so
 * nobody has to go looking for a control they never knew existed. That only works if this answer and the
 * daemon's are the same answer, which is why the rule lives in the contract rather than in either of them.
 *
 * ONE COMPOSABLE, PARAMETERISED BY ROLE. There were two — `useQuickModel` and `useAgentRunModel` — and the
 * difference between them was never really code: it was which of two bundled settings they read, and one of the
 * two `undefined`-means clauses. Both of those are properties the role now declares (model-roles.ts), so
 * everything else was the same file twice. */

/* WHAT THE RESOLVER DECIDES OVER: every native provider and every configured model endpoint, whether a turn on
 * it can be sent (the same predicate the picker's rows and the connect gate use) and what its catalog holds.
 *
 * Options come from the live daemon catalog with the static seed floor beneath it, so this is answerable before
 * any catalog has loaded. Endpoints are here because their models are in the picker's OPTIONS, and a pin the
 * daemon would honour but this side dropped would name one model in the settings row and run another.
 *
 * THE MODELS ARE ONLY READ FOR THE AUTO LADDER, which is a `helper` role's floor: a pin is taken verbatim and a
 * `run` role has no ladder at all. Kept in one source list rather than split per kind, because a connected
 * provider whose catalog has not answered yet publishes no options, and dropping its PIN on that basis would
 * make a run button name a different model for the first second of every page load than the one the daemon is
 * about to spend. `resolveRoleModels` filters pins on readiness alone, so that cannot happen here.
 *
 * Exported for the one other ladder the composer resolves: a persona card's own (contract personaModels), which
 * decides over exactly the same providers and must not disagree with these rows about which are reachable. */
export const roleSources = computed(() =>
    [...NATIVE_PROVIDERS, ...endpointProviders.value.map((endpoint) => endpoint.id)].map((provider) => ({
        provider,
        ready: providerReady(provider),
        models: modelOptionsFor(provider).map((option) => option.value),
    })),
);

export interface RoleModel {
    // Every pin this job may run, in the order the daemon will try them: the owner's list, or the role's own
    // floor when they have written none. Empty while settings load, and for a `run` role nobody has pinned,
    // which is a real state the callers render as "whatever the composer is set to" rather than as an error.
    readonly chain: ComputedRef<readonly ModelPin[]>;
    // The one that answers when nothing goes wrong, WHOLE: its own effort, harness and speed are what the work
    // is composed from. Undefined ⇒ the caller's own floor answers instead.
    readonly choice: ComputedRef<ModelPin | undefined>;
    readonly label: ComputedRef<string | undefined>;
    // The rest of the chain as people read it, for the line that says what happens if the first account is out.
    // Empty when there is no fallback to describe.
    readonly fallbackLabels: ComputedRef<readonly string[]>;
    // The stored setting, as the user wrote it. Empty while settings load.
    readonly pinned: ComputedRef<readonly ModelPin[]>;
}

export function useRoleModel(role: ModelRole): RoleModel {
    const { settings } = useSandboxSettings();
    const pinned = computed<readonly ModelPin[]>(() => settings.value?.modelRoles[role] ?? []);
    // Settings not loaded yet ⇒ no answer rather than a guessed one: naming a model the user has not pinned
    // would flash the wrong spend on every button on screen, and reporting a helper's Auto here would flash the
    // wrong model in the row of anyone who has pinned one.
    const chain = computed<readonly ModelPin[]>(() =>
        settings.value === undefined ? [] : resolveRoleModels(roleSources.value, pinned.value, role),
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
