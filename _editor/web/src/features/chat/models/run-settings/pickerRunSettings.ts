import {
    type AgentHarness,
    type AgentProvider,
    type ModelPin,
    capabilitiesOf,
    fastAllowed,
} from "@intentic/sandbox-contract";
import { computed, type Ref } from "vue";
import { clampEffort, effortLabelOf, effortsFor } from "./effortScale";
import { providerModels } from "../../accounts/providerCatalog";

/* HOW THE MODEL ITSELF IS RUN — the tier it thinks at, whether it reasons first, whether the work is bought at the faster rate. */

// What a chip or a rung hands back. One field per press, and every one of them concrete: nothing in these
// pickers can express "unset", so nothing here has to be able to spell it.
export interface RunSettingsPatch {
    readonly effort?: string;
    readonly thinking?: boolean;
    readonly fast?: boolean;
}

/* THE STATE EVERY SELECTION OPENS AT. */
export const DEFAULT_EFFORT = `xhigh`;
// Claude reasons unless told not to, so ON is what a turn carrying no thinking field actually does.
export const DEFAULT_THINKING = true;

/* THE STATE A SELECTION IS BORN AT, and the only place those defaults are spent. */
export const defaultRunSettings = (): { effort: string; thinking: boolean; fast: boolean } => ({
    effort: DEFAULT_EFFORT,
    thinking: DEFAULT_THINKING,
    fast: false,
});

// Extended thinking is a Claude knob; nothing else publishes one to turn off.
export const thinkingOfferedFor = (provider: AgentProvider): boolean => provider === `claude`;

const badgesFor = (provider: AgentProvider, modelId: string | undefined) =>
    (providerModels.value[provider] ?? []).find((option) => option.value === modelId)?.badges;

// Defaults for a stored pin: only knobs the provider and harness would honor on a turn.
export const defaultPinRunSettings = (
    provider: AgentProvider,
    harness: AgentHarness,
): Partial<Pick<ModelPin, `effort` | `thinking` | `fast`>> => {
    const capabilities = capabilitiesOf(provider, harness);
    return {
        ...(capabilities.effort ? { effort: DEFAULT_EFFORT } : {}),
        ...(thinkingOfferedFor(provider) ? { thinking: DEFAULT_THINKING } : {}),
    };
};

// Cross-provider re-point: carry only knobs the new provider can run.
export const carryPinKnobs = (
    from: ModelPin | undefined,
    provider: AgentProvider,
    harness: AgentHarness,
): Partial<ModelPin> => {
    if (from === undefined) {
        return {};
    }
    const capabilities = capabilitiesOf(provider, harness);
    return {
        ...(capabilities.effort && from.effort !== undefined && from.effort !== `` ? { effort: from.effort } : {}),
        ...(thinkingOfferedFor(provider) && from.thinking !== undefined ? { thinking: from.thinking } : {}),
    };
};

// Drops stored knobs a runtime ignores so pins and summaries cannot lie about what will run.
export const honoredPinKnobs = (pin: ModelPin): ModelPin => {
    const harness = pin.harness ?? `native`;
    const capabilities = capabilitiesOf(pin.provider, harness);
    const badges = badgesFor(pin.provider, pin.model);
    return {
        provider: pin.provider,
        model: pin.model,
        ...(pin.harness !== undefined ? { harness: pin.harness } : {}),
        ...(capabilities.effort && pin.effort !== undefined && pin.effort !== `` ? { effort: pin.effort } : {}),
        ...(thinkingOfferedFor(pin.provider) && pin.thinking !== undefined ? { thinking: pin.thinking } : {}),
        ...(pin.fast === true && fastAllowed(capabilities, pin.provider, badges) ? { fast: true } : {}),
    };
};

// One-line summary beside a pin row; omits knobs the run would not read.
export const pinKnobSummary = (pin: ModelPin): string | undefined => {
    const honored = honoredPinKnobs(pin);
    const effort = effortLabelOf(honored.effort, honored.provider, honored.model, honored.thinking);
    return (
        [
            ...(effort === undefined ? [] : [effort]),
            ...(honored.thinking === undefined ? [] : [honored.thinking ? `thinking` : `no thinking`]),
            ...(honored.fast === true ? [`fast`] : []),
            ...(honored.harness === `claude-code` ? [`Claude Code`] : []),
        ].join(` · `) || undefined
    );
};

/* READING a selection whose fields may still be absent — one made by a route, an extension or an older build, none of which came through a picker. */
export const runSettingsOf = (settings: {
    readonly effort?: string | undefined;
    readonly thinking?: boolean | undefined;
    readonly fast?: boolean | undefined;
}): { effort: string; thinking: boolean; fast: boolean } => ({
    effort: settings.effort === undefined || settings.effort === `` ? DEFAULT_EFFORT : settings.effort,
    thinking: settings.thinking !== false,
    fast: settings.fast === true,
});

export const usePickerRunSettings = (
    provider: Ref<AgentProvider>,
    model: Ref<string | undefined>,
    harness: Ref<AgentHarness>,
    // The selection's own values, which a picker resolves through `runSettingsOf` rather than reading raw: what
    // it draws is always a state, never the absence of one.
    thinking: Ref<boolean | undefined>,
    effort: Ref<string | undefined>,
/* THE COMPONENT'S `effortRow` SWITCH, repeated here because `hasContent` would otherwise lie to the one caller that uses it. */
    effortRow = true,
) => {
    const capabilities = computed(() => capabilitiesOf(provider.value, harness.value));

    // Whether the selection reasons before it answers, as the chip draws it and as the effort scale reads it.
    const thinkingOn = computed(() => thinking.value !== false);

    // A runtime that owns its own reasoning settings (ACP, OpenCode) publishes no scale and draws no row.
    const efforts = computed(() => (capabilities.value.effort ? effortsFor(provider.value, model.value, thinkingOn.value) : []));

/* CLAMPED FOR DISPLAY, NEVER WRITTEN BACK (effortScale.ts's own rule). */
    const level = computed(() => clampEffort(runSettingsOf({ effort: effort.value }).effort, provider.value, model.value, thinkingOn.value));

    const thinkingOffered = computed(() => thinkingOfferedFor(provider.value));

    // Fast speed exists only where the runtime, the route AND the model's own catalog row allow it, so the
    // control appears and disappears with the model instead of sitting greyed under an explanation nobody reads.
    const fastOffered = computed(() =>
        fastAllowed(
            capabilities.value,
            provider.value,
            (providerModels.value[provider.value] ?? []).find((option) => option.value === model.value)?.badges,
        ),
    );

    // Exactly what the component will draw, row for row — see `effortRow` above for why the switch is counted.
    const effortShown = computed(() => effortRow && efforts.value.length > 0);

    const hasContent = computed(() => effortShown.value || thinkingOffered.value || fastOffered.value);

    return { efforts, level, thinkingOn, thinkingOffered, fastOffered, hasContent };
};
