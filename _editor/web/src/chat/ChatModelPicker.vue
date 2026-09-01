<script setup lang="ts">
import { computed } from "vue";
import { limitationsOf } from "@intentic/sandbox-contract";
import { InfoHint } from "@intentic/ui";
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
const { provider, harness, model, thinking, fast, fastOffered, fastMode, tierHold, tierAnswer, streaming, account, capabilities, box } = conversation;

// The sandbox-wide automatic-tier mode, which decides what the tier block below is allowed to show: a dead
// control is worse than none, and this feature has two modes that can produce one (see tierHoldOffered).
const { settings } = useSandboxSettings();
const tierMode = computed(() => settings.value?.autoTier ?? `shadow`);

// Whether the shared block has anything to say for this provider: the one thing this component needs from it
// BEFORE rendering it, since the footer's border and padding belong to whoever draws them.
const { hasContent } = usePickerAccounts(provider, harness);

/* WHO SERVES THE TURN IS THE HOST BOX'S BUSINESS WHEN THE HOST BOX IS NOT THIS ONE. An account id is a key in
 * one daemon's credential store, so a conversation homed in another sandbox sends no account at all and that
 * daemon serves the turn on its own first account for the provider (turnRequest.ts). The rows are therefore
 * hidden rather than shown inert: a list of THIS box's logins under a turn none of them will pay for is the
 * picker asserting something it cannot make true. The MODEL list above stays, because a model id belongs to
 * the provider rather than to a box and does cross. */
const accountsShown = computed(() => hasContent.value && box.value === undefined);

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

/* Whether the veto is worth a row. `on` only, not "not off": in Measure mode nothing is ever substituted, so a
 * hold has nothing to hold back, and the switch would sit there flipping between two words that describe the
 * same non-event. It is the rule the composer's chip now follows too (tierPreview's header), for the same
 * reason — the mode that changes nothing is the mode that should show nothing. */
const tierHoldOffered = computed(() => tierMode.value === `on`);

/* The one line under the tier control, fastSpeedNotice's twin, and under the same discipline: only when the
 * judge's answer DISAGREES with what the pick alone would predict. A standard verdict ran the pick, which is
 * what the picker already says, so it renders nothing; the three states worth a sentence are the substitution
 * that happened, the substitution the user's veto stopped, and measure mode's "would have".
 *
 * MEASURE'S LINE SURVIVES HERE while the composer's chip is gone, and the difference is what each one is: this
 * reports a turn that already ran, inside a panel someone opened to think about models, and it is the honest
 * way to discover the feature at all. The chip was a standing label on a turn that had not happened yet. */
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
const footerVisible = computed(
    () => accountsShown.value || provider.value === `claude` || limitations.value.length > 0 || tierHoldOffered.value || tierNotice.value !== undefined,
);
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
            <!-- ON THE CANVAS, NOT THE PANEL. The list above is what the panel opened for; this block is the
                 session behind it, and a rule alone was not enough to say so on a tall picker. `bg-canvas` is
                 the app's own ground (textured wherever the skin textures it), so the footer reads as the
                 surface the list is standing on rather than more list. -->
            <div
                v-if="footerVisible"
                class="scrollbar-thin flex min-h-0 shrink flex-col gap-2 overflow-y-auto border-t border-line bg-canvas px-3 py-2"
            >
                <!-- WHO SERVES THE NEXT TURN: the account list and the harness axis, shared verbatim with the
                     shell's own picker (PickerAccounts). Bound to the conversation here: each row writes
                     straight through and the panel stays open, because these are settings of the session you
                     are in rather than an answer someone is waiting on. -->
                <PickerAccounts
                    v-if="accountsShown"
                    :provider="provider"
                    :harness="harness"
                    :account="account"
                    :disabled="streaming"
                    @select-account="conversation.selectAccount($event)"
                    @select-harness="conversation.selectHarness($event)"
                    @navigate="emit(`selected`)"
                />

                <!-- CLAUDE'S TWO PER-SESSION KNOBS, ON ONE LINE. Codex reasoning is always on (no toggle);
                     extended thinking is a Claude knob, and fast speed is offered only where all three
                     conditions hold (fastAllowed: the Claude Code loop, a first-party route, a model whose
                     catalog row publishes the `fast` badge), so it appears and disappears with the model rather
                     than sitting greyed out with an explanation nobody reads.

                     SELF-LABELLING CHIPS, NOT LABEL-LEFT/CONTROL-RIGHT. That grammar (which the harness row
                     and the limitations row still use, correctly) earns its column when the label is long and
                     the control is small. Here it was the reverse: two words on the left, a wide chip on the
                     right, and more than half the row width was the gap between them — twice, for two bits of
                     state, in a panel whose reason for existing is the model list above. The chip's own label
                     is the name, so the row costs one line instead of two and the 8px of vertical rhythm
                     between them goes back to the list.

                     WHAT THE OLD ROWS SPENT ON ONE BIT: a bolt icon, the word On/Off, and the active tint —
                     three channels, and the bolt was the same glyph on both rows and the same in both states,
                     so it distinguished nothing and made the pair read as one control seen twice. The dot is
                     what replaces all of it: filled or hollow is a SHAPE difference, so the state survives
                     without the word and without relying on the tint alone, which colour-blind readers would
                     have been left with once "Off" was gone. Fixed width either way, so a chip does not
                     resize under the thumb that just pressed it.

                     Labels carry sentence case on purpose. The uppercase/tracked dress these wore is this
                     footer's SECTION HEADER costume (the provider header over the account list wears it, so
                     does "Harness"), and worn by leaf controls too it flattened four structural ranks into one
                     stack of look-alike headings. -->
                <div v-if="provider === `claude`" class="flex flex-col gap-1">
                    <div class="flex flex-wrap items-center gap-1.5">
                        <button
                            type="button"
                            class="composer-ghost composer-toggle h-7 gap-1.5 px-2.5 text-2xs font-medium max-md:h-10"
                            :class="{ 'composer-active': thinking }"
                            @click="conversation.setThinking(!thinking)"
                            :aria-pressed="thinking"
                        >
                            <span
                                class="h-1.5 w-1.5 shrink-0 rounded-full border border-current"
                                :class="{ 'bg-current': thinking }"
                                aria-hidden="true"
                            ></span>
                            <span>Extended thinking</span>
                        </button>
                        <button
                            v-if="fastOffered"
                            type="button"
                            class="composer-ghost composer-toggle h-7 gap-1.5 px-2.5 text-2xs font-medium max-md:h-10"
                            :class="{ 'composer-active': fast }"
                            @click="conversation.setFast(!fast)"
                            :aria-pressed="fast"
                        >
                            <span
                                class="h-1.5 w-1.5 shrink-0 rounded-full border border-current"
                                :class="{ 'bg-current': fast }"
                                aria-hidden="true"
                            ></span>
                            <span>Fast speed</span>
                        </button>
                    </div>
                    <!-- What the harness actually did with the ask. Only ever shown when it DIFFERS from what was
                         asked for: agreeing with the toggle is what the toggle already says, and a notice under a
                         working control trains people to ignore notices.

                         It sits under the ROW rather than under a chip, which costs it nothing: every sentence it
                         can carry names fast speed itself (FAST_MODE_REASONS), so it does not borrow its subject
                         from a label above it the way a caption would. -->
                    <span v-if="fastSpeedNotice !== undefined" class="text-2xs text-subtle">{{ fastSpeedNotice }}</span>
                </div>

                <!-- AUTOMATIC TIER, this conversation's word against the sandbox setting: the toggle is the
                     standing veto (AgentTurn.tierHold), offered only where a hold can actually stop something,
                     and the line under it reports what the judge decided about the last turn, which is the one
                     fact the routing would otherwise change silently.

                     THE WAY OUT ENTIRELY IS NAMED HERE, not only in Settings. The veto above it is per
                     conversation on purpose (that is the honest blast radius of a click made inside one chat),
                     but "stop doing this to me" is a thing people want the moment they first see a model they
                     did not pick, and a feature whose off switch can only be found by guessing which settings
                     page owns it is a feature that gets sworn at instead of configured. One link, worded for
                     the reach it has. -->
                <div v-if="tierHoldOffered || tierNotice !== undefined" class="flex flex-col gap-1">
                    <div v-if="tierHoldOffered" class="flex items-center justify-between gap-2">
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
                    <RouterLink
                        v-if="tierHoldOffered"
                        to="/sandbox/agent#models"
                        class="text-2xs text-link hover:underline"
                        @click="emit(`selected`)"
                    >
                        Turn it off for every chat
                    </RouterLink>
                </div>

                <!-- The honest half of the choice: what this runtime can't do, named before the user relies on it.
                     ONE ROW, on the footer's own label-left/control-right grammar, with the list itself behind a
                     hover card. It used to be a wall of chips, and on the weaker runtimes that is a dozen of
                     them: eight lines of standing prose under the four controls, which pushed the model list
                     that the panel exists for into a third of its own height and read as a warning screen
                     rather than a footnote. The count carries what a bare (i) would hide: how much there is to
                     read is the part worth seeing without hovering, and it is what makes the difference between
                     the Claude Code loop (no row at all) and a routed one glanceable. -->
                <div v-if="limitations.length > 0" class="flex items-center justify-between gap-2">
                    <span class="text-2xs font-medium uppercase tracking-wide text-muted">Not available here</span>
                    <InfoHint label="What isn't available here" :text="`${limitations.length}`" class="shrink-0">
                        <!-- The card states its own heading: it is teleported to the tooltip tier and may land
                             clear of the row that raised it, so it cannot lean on that label for what it is. -->
                        <span class="block text-xs font-medium text-content">Not available here</span>
                        <ul class="mt-1 flex flex-col gap-1 text-xs">
                            <li v-for="limit in limitations" :key="limit" class="flex items-start gap-1.5">
                                <span class="mt-[0.4rem] h-1 w-1 shrink-0 rounded-full bg-line-strong" aria-hidden="true"></span>
                                <span class="text-muted">{{ limit }}</span>
                            </li>
                        </ul>
                    </InfoHint>
                </div>
            </div>
        </template>
    </ModelPicker>
</template>
