<script setup lang="ts">
import { computed } from "vue";
import { limitationsOf } from "@intentic/sandbox-contract";
import type { Conversation } from "../composables/chat/conversation";
import type { PickerEntry } from "../composables/chat/modelPicker";
import { usePickerAccounts } from "../composables/chat/pickerAccounts";
import { modelLabelFor } from "../composables/chat/providerCatalog";
import { useSandboxSettings } from "../composables/sandbox/useSandboxSettings";
import ModelPicker from "./ModelPicker.vue";
import PickerAccounts from "./PickerAccounts.vue";

/* THE CHAT'S BINDING OF THE APP'S MODEL PICKER: the shared list (ModelPicker), the shared who-serves-the-turn
 * block (PickerAccounts) and the footer controls that only mean something when there IS a conversation: Claude's
 * extended-thinking knob, fast speed, and what this runtime cannot do.
 *
 * IT EDITS THE CONVERSATION IT IS GIVEN, not "the active tab". The composer hands it the active one; the
 * suggested-session box hands it a DRAFT that has no tab yet (SuggestedSessionBox.vue), so that a session being
 * proposed can be re-pointed at a different model before it is ever started. Binding to the active tab instead
 * would have made the proposal's picker silently edit whatever chat happened to be open behind it.
 *
 * The harness (the provider's own / Claude Code) is a separate axis from the model, chosen via the footer chips
 *: codex/grok run the same subscription model ids under either harness. A mid-chat cross-provider pick just
 * re-points the selection: the fresh session starts lazily at the next send. */

const emit = defineEmits<{ selected: [] }>();
const { conversation } = defineProps<{ conversation: Conversation }>();

/* Destructured ONCE, which is sound only because every host remounts this body per open: AnchoredOverlay
 * teleports behind a `v-if="open"` and BottomSheet does the same, in both ChatPanel and SuggestedSessionBox.
 * These are the refs of the conversation as it was at mount, so a host that swapped the prop in place would go
 * on editing the previous one. Remount, don't rebind. */
const { provider, harness, model, thinking, fast, fastOffered, fastMode, tierHold, tierAnswer, streaming, account, capabilities } = conversation;

// The sandbox-wide automatic-tier mode, which decides whether the per-conversation veto below is worth a row
// at all: with the feature off there is nothing to veto, and a dead control is worse than none.
const { settings } = useSandboxSettings();
const tierMode = computed(() => settings.value?.autoTier ?? `shadow`);

// Whether the shared block has anything to say for this provider: the one thing this component needs from it
// BEFORE rendering it, since the footer's border and padding belong to whoever draws them.
const { hasContent } = usePickerAccounts(provider, harness);

// Mid-stream, only a same-provider model swap is allowed (a provider switch retires the session).
const unpickable = (entry: PickerEntry): boolean => streaming.value && entry.provider !== provider.value;

const pick = (entry: PickerEntry): void => {
    conversation.selectModel(entry);
    emit(`selected`);
};

/* What the selected provider/harness pair does NOT do, straight off its declared record. The picker is where
 * the choice is made, so it is where the trade-off belongs: picking Grok gives up mid-turn steering and per-tool
 * approvals, and nothing else in the app was ever going to say so: the controls simply stopped working. An
 * empty list (the Claude Code loop, which is the ceiling) renders nothing at all. */
const limitations = computed(() => limitationsOf(capabilities.value));

/* WHY THE FAST TOGGLE DIDN'T DO WHAT IT SAYS: the sentence for each reason the harness can give (its own
 * FastModeDisabledReason vocabulary, forwarded verbatim on the `fast_mode` frame).
 *
 * Every one of these is a state the user can be in with the control switched on and nothing visibly different
 * about the turn except the speed, so each needs to say what happened AND whether they can do anything about
 * it. An unrecognized reason is not swallowed: a newer harness may report something this build hasn't heard
 * of, and the raw word beats silence: it is at least searchable. */
const FAST_MODE_REASONS: Record<string, string> = {
    free: `Fast speed needs a paid plan.`,
    preference: `Fast speed is switched off in this account's Claude settings.`,
    extra_usage_disabled: `Fast speed needs extra usage enabled on this account.`,
    model_not_allowed: `This model doesn't offer fast speed.`,
    not_first_party: `Fast speed isn't available on a routed endpoint.`,
    disabled_by_env: `Fast speed is disabled by this sandbox's environment.`,
    sdk_opt_in_required: `The harness declined the fast-speed request.`,
    network_error: `Couldn't reach Anthropic to confirm fast speed.`,
    pending: `Still confirming fast speed.`,
};

/* The one line under the toggle, and only when the answer DISAGREES with the ask. Three cases, in the order
 * they matter: cooldown (asked, had it, spent the separate fast-mode pool, it comes back by itself), refused
 * (asked, never got it: the reason says whether that is fixable), and served-anyway (didn't ask but got it,
 * which happens when the account's own Claude settings turn fast mode on, and is worth saying because it is
 * being billed). Agreement renders nothing: a notice confirming that a control did what it says is noise. */
const fastSpeedNotice = computed<string | undefined>(() => {
    const state = fastMode.value;
    if (state === undefined) {
        return undefined;
    }
    if (state.state === `cooldown`) {
        return `Fast speed is rate-limited right now: turns run at standard speed until it resets.`;
    }
    if (state.state === `on`) {
        return fast.value ? undefined : `Ran at fast speed, this account has fast mode switched on by default.`;
    }
    if (!fast.value) {
        return undefined;
    }
    return state.reason === undefined
        ? `The last turn ran at standard speed.`
        : (FAST_MODE_REASONS[state.reason] ?? `The last turn ran at standard speed (${state.reason}).`);
});

/* The one line under the tier control, fastSpeedNotice's twin, and under the same discipline: only when the
 * judge's answer DISAGREES with what the pick alone would predict. A standard verdict ran the pick, which is
 * what the picker already says, so it renders nothing; the three states worth a sentence are the substitution
 * that happened, the substitution the user's veto stopped, and measure mode's "would have" — the last one shown
 * because awareness is that mode's entire product. */
const tierNotice = computed<string | undefined>(() => {
    const answer = tierAnswer.value;
    if (answer === undefined || answer.tier !== `fast`) {
        return undefined;
    }
    if (answer.routed && answer.model !== undefined) {
        return `The last turn looked simple, so it ran on ${modelLabelFor(provider.value, answer.model)}.`;
    }
    if (answer.held === true) {
        return `The last turn looked simple; your hold kept it on your pick.`;
    }
    if (tierMode.value === `shadow`) {
        return `The last turn looked simple. Measuring: it still ran on your pick.`;
    }
    return undefined;
});

/* Whether the footer earns the border and padding it draws. The shared block answers for the account list, the
 * routed subscriptions, the harness axis and a standing refusal; everything after it is this conversation's own
 * runtime, and a rule drawn above nothing is what this check exists to prevent. */
const footerVisible = computed(() => hasContent.value || provider.value === `claude` || limitations.value.length > 0 || tierMode.value !== `off`);
</script>

<template>
    <ModelPicker :provider="provider" :model="model" :unpickable="unpickable" @pick="pick" @close="emit(`selected`)">
        <template #footer>
            <!-- Session controls that have no place in the shared list: who serves the next turn (the shared
                 block), then Claude's extended-thinking knob, fast speed, and what this runtime cannot do.
                 Controls and the state of them: no standing prose. -->
            <!-- Padded on the model list's own 12px rhythm (ModelPicker's rows and section headers are all
                 `px-3`), because the two read as one column: at the footer's old 8px every label in it sat
                 four pixels inboard of the headings directly above, close enough to the panel edge to look
                 like a crop rather than a margin. The row groups below take that padding back with `-mx-3`
                 so their tint spans the panel exactly as a model row's does: bleed is the LIST's idiom, and
                 the text still lands on the 12px line. -->
            <!-- It SHRINKS AND SCROLLS rather than holding its natural height, which is the backstop behind the
                 model list's floor (ModelPicker): the two together mean a tall footer and a short window can
                 shorten each other but neither can erase the other. Nothing scrolls here until the window is
                 genuinely too short: the account lists fold themselves long before that (PickerAccounts). -->
            <div v-if="footerVisible" class="scrollbar-thin flex min-h-0 shrink flex-col gap-2 overflow-y-auto border-t border-line px-3 py-2">
                <!-- WHO SERVES THE NEXT TURN: the account list and the harness axis, shared verbatim with the
                     shell's own picker (PickerAccounts). Bound to the conversation here: each row writes
                     straight through and the panel stays open, because these are settings of the session you
                     are in rather than an answer someone is waiting on. -->
                <PickerAccounts
                    :provider="provider"
                    :harness="harness"
                    :account="account"
                    :disabled="streaming"
                    @select-account="conversation.selectAccount($event)"
                    @select-harness="conversation.selectHarness($event)"
                    @navigate="emit(`selected`)"
                />

                <!-- Codex reasoning is always on (no toggle); extended thinking is a Claude knob. -->
                <div v-if="provider === `claude`" class="flex items-center justify-between gap-2">
                    <span class="text-2xs font-medium uppercase tracking-wide text-muted">Extended thinking</span>
                    <button
                        type="button"
                        class="composer-ghost h-7 gap-1 px-2.5 text-2xs font-medium max-md:h-10"
                        :class="{ 'composer-active': thinking }"
                        @click="conversation.setThinking(!thinking)"
                        :aria-pressed="thinking"
                        aria-label="Toggle extended thinking"
                    >
                        <Icon name="bolt" class="text-2xs" />
                        <span>{{ thinking ? "On" : "Off" }}</span>
                    </button>
                </div>

                <!-- FAST SPEED. Offered only where all three conditions hold (fastAllowed: the Claude Code loop, a
                     first-party route, a model whose catalog row publishes the `fast` badge), so it appears and
                     disappears with the model rather than sitting greyed out with an explanation nobody reads. The
                     toggle stands on its own: a standing caption under a switch is read once and skipped from then
                     on, and the only line worth the space is the conditional one below it, which reports what the
                     harness actually did rather than restating what the switch is. -->
                <div v-if="fastOffered" class="flex flex-col gap-1">
                    <div class="flex items-center justify-between gap-2">
                        <span class="text-2xs font-medium uppercase tracking-wide text-muted">Fast speed</span>
                        <button
                            type="button"
                            class="composer-ghost h-7 gap-1 px-2.5 text-2xs font-medium max-md:h-10"
                            :class="{ 'composer-active': fast }"
                            @click="conversation.setFast(!fast)"
                            :aria-pressed="fast"
                            aria-label="Toggle fast speed"
                        >
                            <Icon name="bolt" class="text-2xs" />
                            <span>{{ fast ? "On" : "Off" }}</span>
                        </button>
                    </div>
                    <!-- What the harness actually did with the ask. Only ever shown when it DIFFERS from what was
                         asked for: agreeing with the toggle is what the toggle already says, and a notice under a
                         working control trains people to ignore notices. -->
                    <span v-if="fastSpeedNotice !== undefined" class="text-2xs text-subtle">{{ fastSpeedNotice }}</span>
                </div>

                <!-- AUTOMATIC TIER, this conversation's word against the sandbox setting: the toggle is the
                     standing veto (AgentTurn.tierHold), offered only while the feature can do anything, and the
                     line under it reports what the judge actually decided about the last turn, which is the one
                     fact the routing would otherwise change silently. -->
                <div v-if="tierMode !== `off`" class="flex flex-col gap-1">
                    <div class="flex items-center justify-between gap-2">
                        <span class="text-2xs font-medium uppercase tracking-wide text-muted">Simple turns may run cheaper</span>
                        <button
                            type="button"
                            class="composer-ghost h-7 gap-1 px-2.5 text-2xs font-medium max-md:h-10"
                            :class="{ 'composer-active': tierHold }"
                            @click="conversation.setTierHold(!tierHold)"
                            :aria-pressed="tierHold"
                            aria-label="Keep this conversation on the picked model"
                        >
                            <Icon name="credit-card" class="text-2xs" />
                            <span>{{ tierHold ? "My pick only" : "Allowed" }}</span>
                        </button>
                    </div>
                    <span v-if="tierNotice !== undefined" class="text-2xs text-subtle">{{ tierNotice }}</span>
                </div>

                <!-- The honest half of the choice: what this runtime can't do, named before the user relies on it.
                     Chips rather than prose: the list is short, unordered, and each item is a control that would
                     otherwise appear to work. -->
                <div v-if="limitations.length > 0" class="flex flex-col gap-1">
                    <span class="text-2xs font-medium uppercase tracking-wide text-muted">Not available here</span>
                    <div class="flex flex-wrap gap-1">
                        <span v-for="limit in limitations" :key="limit" class="rounded border border-line px-1.5 py-0.5 text-2xs text-subtle">{{
                            limit
                        }}</span>
                    </div>
                </div>
            </div>
        </template>
    </ModelPicker>
</template>
