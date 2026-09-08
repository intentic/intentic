import { type AgentHarness, type AgentProvider, capabilitiesOf, fastAllowed } from "@intentic/sandbox-contract";
import { computed, type Ref } from "vue";
import { clampEffort, effortsFor } from "./effortScale";
import { providerModels } from "../accounts/providerCatalog";

/* HOW THE MODEL ITSELF IS RUN — the tier it thinks at, whether it reasons first, whether the work is bought at
 * the faster rate — derived once for the two pickers that configure a selection rather than a session: the
 * shell's own panel (HostPickerBody: a run about to start, an automation rung, a workflow step) and the settings
 * page's (ModelPinPickerBody: a stored entry of one of the owner's model lists).
 *
 * ONE COMPOSABLE BECAUSE THEY HAD IT TWICE, verbatim: the effort meter with its × reset was duplicated line for
 * line between those two files, each with its own copy of the clamp rule and its own answer to "is this row
 * offered at all". They agreed on the day they were written and had nothing keeping them agreeing.
 *
 * A COMPOSABLE AND NOT ONLY A COMPONENT, for the reason usePickerAccounts is one: both callers need the answer
 * BEFORE the markup exists, whether there is anything here to draw, and each wraps the rows in its own footer.
 * A footer drawing a border and padding around nothing is the defect this seam exists to make impossible.
 *
 * THESE THREE TRAVEL TOGETHER AND ACROSS A RE-POINT, which is why they are one block. Each is a property of the
 * MODEL, not of the provider that vends it: every native scale has tiers, and the clamp below already says what
 * a shorter one will run a carried pick at. The account and the harness are the opposite (an account id is one
 * provider's store key), so those live with the accounts block and are dropped when the provider changes. */

// What a row hands back. Every field optional AND `| undefined`, because clearing one is a patch that names it:
// the × beside the meter is `{ effort: undefined }`, and under this repo's exactOptionalPropertyTypes there
// would otherwise be no way to spell the clear.
export interface RunSettingsPatch {
    readonly effort?: string | undefined;
    readonly thinking?: boolean | undefined;
    readonly fast?: boolean | undefined;
}

// Three stops rather than a toggle, because absent is not the same as off: a selection that says nothing about
// thinking sends nothing, and the harness's own default (Claude reasons) answers. A two-state chip would draw
// that as "off" and be wrong about what the run does.
export const THINKING_OPTIONS = [
    { label: `Default`, value: `` },
    { label: `On`, value: `on` },
    { label: `Off`, value: `off` },
];
// Speed IS binary: an absent `fast` means standard speed, which is what the turn schema says it means.
export const SPEED_OPTIONS = [
    { label: `Standard`, value: `standard` },
    { label: `Fast`, value: `fast` },
];

export const usePickerRunSettings = (
    provider: Ref<AgentProvider>,
    model: Ref<string | undefined>,
    harness: Ref<AgentHarness>,
    // This selection's own thinking, and THREE-STATE on purpose: `undefined` is "nothing pinned", which is not
    // "off". Claude's API refuses 'max' with thinking explicitly disabled, so off loses the top rung while
    // absent keeps it — the turn then goes out with no thinking field and the daemon names the reasoning that
    // tier needs on the way (sendableThinking). Collapsing the two hid a rung behind a chip nobody had touched.
    thinking: Ref<boolean | undefined>,
    effort: Ref<string | undefined>,
) => {
    const capabilities = computed(() => capabilitiesOf(provider.value, harness.value));

    // A runtime that owns its own reasoning settings (ACP, OpenCode) publishes no scale and draws no row.
    const efforts = computed(() => (capabilities.value.effort ? effortsFor(provider.value, model.value, thinking.value) : []));

    /* CLAMPED FOR DISPLAY, NEVER WRITTEN BACK (effortScale.ts's own rule). A tier carried over from a model with
     * a longer scale, or left standing when thinking was switched off, would otherwise light no rung at all and
     * read as an unset control. What the selection SENDS stays the user's pick, for the day it is re-pointed at
     * a longer scale again. */
    const level = computed(() =>
        effort.value === undefined || effort.value === `` ? `` : clampEffort(effort.value, provider.value, model.value, thinking.value),
    );

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

    const hasContent = computed(() => efforts.value.length > 0 || thinkingOffered.value || fastOffered.value);

    return { efforts, level, thinkingOffered, fastOffered, hasContent };
};
