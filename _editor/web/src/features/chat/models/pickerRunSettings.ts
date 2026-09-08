import { type AgentHarness, type AgentProvider, capabilitiesOf, fastAllowed } from "@intentic/sandbox-contract";
import { computed, type Ref } from "vue";
import { clampEffort, effortsFor } from "./effortScale";
import { providerModels } from "../accounts/providerCatalog";

/* HOW THE MODEL ITSELF IS RUN — the tier it thinks at, whether it reasons first, whether the work is bought at
 * the faster rate — derived once for every picker that asks those three questions: the shell's own panel
 * (HostPickerBody: a run about to start, an automation rung, a workflow step), the settings page's
 * (ModelPinPickerBody: a stored entry of one of the owner's model lists) and the composer's (ChatModelPicker:
 * this conversation's next turn).
 *
 * ONE COMPOSABLE BECAUSE THEY HAD IT THREE TIMES: the effort meter was duplicated line for line between the
 * first two, each with its own copy of the clamp rule and its own answer to "is this row offered at all", and
 * the composer asked the same two Claude questions again in a control of its own. They agreed on the day they
 * were written and had nothing keeping them agreeing.
 *
 * EVERY SETTING IS ALWAYS SET. There is no "leave it out and let the harness decide" stop anywhere in these
 * pickers: a control offering one is a control whose reader cannot tell what their run will do, and it bought
 * a third state in every type that touches it. The harness's own answers are read ONCE, to open a picker on
 * (`defaultRunSettings`, at the two places a selection is born), and after that the selection carries its own.
 * `runSettingsOf` is the same resolution for READING a selection that predates its own birth seed.
 *
 * WHAT A CALLER STILL CHOOSES is only what its own surface already answers: the composer keeps its effort
 * meter beside the model pill, so its picker leaves that row out. The controls themselves are not a choice.
 *
 * A COMPOSABLE AND NOT ONLY A COMPONENT, for the reason usePickerAccounts is one: every caller needs the answer
 * BEFORE the markup exists, whether there is anything here to draw, and each wraps the rows in its own footer.
 * A footer drawing a border and padding around nothing is the defect this seam exists to make impossible.
 *
 * THESE THREE TRAVEL TOGETHER AND ACROSS A RE-POINT, which is why they are one block. Each is a property of the
 * MODEL, not of the provider that vends it: every native scale has tiers, and the clamp below already says what
 * a shorter one will run a carried pick at. The account and the harness are the opposite (an account id is one
 * provider's store key), so those live with the accounts block and are dropped when the provider changes. */

// What a chip or a rung hands back. One field per press, and every one of them concrete: nothing in these
// pickers can express "unset", so nothing here has to be able to spell it.
export interface RunSettingsPatch {
    readonly effort?: string;
    readonly thinking?: boolean;
    readonly fast?: boolean;
}

/* THE STATE EVERY SELECTION OPENS AT. Two facts and they live here, not in `turnDefaults`, which reads them as
 * the fallbacks behind its own stored keys: "how a model is run" is this module's subject, and a conversation's
 * remembered picks are a consumer of it rather than its owner. Importing the other way round would also drag a
 * shared picker module through the chat's account and access state to learn one word and one boolean. */
export const DEFAULT_EFFORT = `xhigh`;
// Claude reasons unless told not to, so ON is what a turn carrying no thinking field actually does.
export const DEFAULT_THINKING = true;

/* THE STATE A SELECTION IS BORN AT, and the only place those defaults are spent. Called where a selection comes
 * into existence — `requestModelPick` opening a panel that carries run settings, and the settings page minting
 * a pin — so that everything downstream reads a value somebody could have seen on screen rather than an absence
 * it has to interpret.
 *
 * Speed is the exception that proves the rule: it is `false` flat, with no remembered preference behind it,
 * because fast mode is bought at a higher rate and a default nobody chose must never be the one that spends
 * more. */
export const defaultRunSettings = (): { effort: string; thinking: boolean; fast: boolean } => ({
    effort: DEFAULT_EFFORT,
    thinking: DEFAULT_THINKING,
    fast: false,
});

/* READING a selection whose fields may still be absent — one made by a route, an extension or an older build,
 * none of which came through a picker. Absent thinking reads as ON for the reason above, so the chip shows what
 * the run will actually do; absent effort reads as the seed, since there is no way to ask a model what its own
 * default rung is. */
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
    /* THE COMPONENT'S `effortRow` SWITCH, repeated here because `hasContent` would otherwise lie to the one
     * caller that uses it. The composer draws its meter beside the model pill, so its picker turns the row off —
     * and on a provider whose ONLY row is the meter (anything that isn't Claude, without a fast badge) a
     * `hasContent` that still counted the rungs would earn a footer with a border, a rule and nothing inside it.
     * Not a Ref: it says which SURFACE this is, which never changes under a mounted picker. */
    effortRow = true,
) => {
    const capabilities = computed(() => capabilitiesOf(provider.value, harness.value));

    // Whether the selection reasons before it answers, as the chip draws it and as the effort scale reads it.
    const thinkingOn = computed(() => thinking.value !== false);

    // A runtime that owns its own reasoning settings (ACP, OpenCode) publishes no scale and draws no row.
    const efforts = computed(() => (capabilities.value.effort ? effortsFor(provider.value, model.value, thinkingOn.value) : []));

    /* CLAMPED FOR DISPLAY, NEVER WRITTEN BACK (effortScale.ts's own rule). A tier carried over from a model with
     * a longer scale, or left standing when thinking was switched off, would otherwise light no rung at all and
     * read as an unset control. What the selection SENDS stays the user's pick, for the day it is re-pointed at
     * a longer scale again. */
    const level = computed(() => clampEffort(runSettingsOf({ effort: effort.value }).effort, provider.value, model.value, thinkingOn.value));

    // Extended thinking is a Claude knob; nothing else publishes one to turn off.
    const thinkingOffered = computed(() => provider.value === `claude`);

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
