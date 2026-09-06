import { type ModelPin, type ModelRole, NATIVE_PROVIDERS, readyChain } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { useSandboxSettings } from "../../sandbox/overview/useSandboxSettings";
import { providerReady } from "../session/access";
import { modelChoiceLabel } from "../models/modelPins";
import { endpointProviders } from "./providerCatalog";

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

/* WHAT THE RESOLVER DECIDES OVER: every native provider and every configured model endpoint, and whether a
 * turn on it can be sent (the same predicate the picker's rows and the connect gate use).
 *
 * Endpoints are here because their models are in the picker's OPTIONS, and a pin the daemon would honour but
 * this side dropped would name one model in the settings row and run another.
 *
 * NO CATALOGS ARE READ, and none are needed. `readyChain` takes a pin verbatim — the picker offers a custom-id
 * escape hatch, so a model this build has never heard of is a supported pin rather than a mistake — which
 * leaves readiness as the only fact it wants. The models used to be gathered here for the derived Auto ladder
 * that stood under an unset `helper` role; nothing derives anything now, so a connected provider whose catalog
 * has not answered yet can no longer change what this side reports, which was the one hazard the gathering was
 * being careful about.
 *
 * Exported for the one other ladder the composer resolves: a persona card's own (contract personaModels), which
 * decides over exactly the same providers and must not disagree with these rows about which are reachable. */
export const roleSources = computed(() =>
    [...NATIVE_PROVIDERS, ...endpointProviders.value.map((endpoint) => endpoint.id)].map((provider) => ({
        provider,
        ready: providerReady(provider),
        models: [],
    })),
);

export interface RoleModel {
    // Every pin this job may run, in the order the daemon will try them: the owner's own list, minus the
    // entries whose account has gone. Empty while settings load and for a job nobody has set a model for,
    // which is a real state — the callers render it as "whatever the composer is set to" for a whole session,
    // and as the job being off for a one-shot, never as an error.
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
    // Settings not loaded yet ⇒ no answer rather than a guessed one: naming a model the user has not set would
    // flash the wrong spend on every button on screen.
    const chain = computed<readonly ModelPin[]>(() => (settings.value === undefined ? [] : readyChain(roleSources.value, pinned.value)));
    const choice = computed(() => chain.value[0]);
    return {
        chain,
        choice,
        label: computed(() => (choice.value === undefined ? undefined : modelChoiceLabel(choice.value))),
        fallbackLabels: computed(() => chain.value.slice(1).map(modelChoiceLabel)),
        pinned,
    };
}
