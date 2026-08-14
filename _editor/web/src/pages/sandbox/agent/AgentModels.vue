<script setup lang="ts">
import { type AgentProvider, quickModelKey } from "@intentic/sandbox-contract";
import { Picker, type PickerOptions, Row, RowGroup, Segmented } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { agentRunModelGroups, useAgentRunModel } from "../../../composables/chat/agentRunModel";
import { clampEffort, effortsFor } from "../../../composables/chat/effortScale";
import { describeModelPin } from "../../../composables/chat/modelPins";
import { quickModelGroups, useQuickModel } from "../../../composables/chat/quickModel";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";
import ProviderLogo from "../../../chat/ProviderLogo.vue";
import ModelPinList from "./ModelPinList.vue";

/* WHICH MODEL SPENDS THIS SANDBOX'S MONEY WHEN NOBODY IS AT THE COMPOSER — the two tiers of that, in the order
 * they escalate. It sits directly under the AI accounts because both rows are a choice OVER them: a model
 * pinned here can never name a provider this sandbox has no credential for, which is exactly the promise a
 * cross-sandbox preference in personal Settings could not make.
 *
 * The tiers are split by what the model is asked to DO, not by which feature calls it, because that is the only
 * axis on which the right answer differs:
 *
 *   QUICK MODEL — no conversation, no tools, one string back (a commit message, a session title). An ORDERED
 *   LIST, walked top to bottom until one answers, because the failure this row actually has is a connected
 *   model that will not answer today: the account's allowance went on the chat, and one spent provider takes
 *   every one of those jobs down for hours while the others sit idle. Auto is the default and it is DERIVED,
 *   not stored: an empty list means "work it out from whatever is connected right now" (resolveQuickModels —
 *   cheapest tier first, free channel before a paid one, every connected provider in that order), so connecting
 *   an account tomorrow improves the answer by itself. Cheapest wins BECAUSE the job is small; being frontier
 *   here is not generosity, it is the wrong tool.
 *
 *   AGENT RUNS — a full isolated session with tools and a worktree, started by a surface rather than by a person
 *   typing: Fix with agent on a pipeline or a deployment, a Maintenance chore, a Documentation or Acceptance
 *   run, the fix a failed pre-push check proposes. ALSO AN ORDERED LIST, for the one reason the row above is:
 *   an account that has stopped answering takes every one of those surfaces down at once, and the next entry
 *   catches it. PINNED, never derived, and THAT is the deliberate opposite of the row above: nothing here can
 *   judge whether a job is worth the frontier tier, and a wrong guess is billed in whole sessions — so an empty
 *   list falls to the composer's own pick, which keeps following the user as they change it, rather than to a
 *   ladder this page worked out. Any of those surfaces can still override the list for a single run, from the
 *   caret on the button that starts it; this is what they open on when nobody touches it.
 *
 * The chat's own model is the third tier and has no row here — it lives in the composer, where it is chosen per
 * turn and per conversation. */

const { settings, patch } = useSandboxSettings();
const quickModel = useQuickModel();
const agentRun = useAgentRunModel();

/* BOTH ROWS ARE THE SAME LIST WIDGET over two different settings, so the editing is written once. It became
 * worth extracting the moment the second row grew a list: add, promote and remove are three ways to write the
 * same array, and three hand-rolled copies per row is where two rows quietly stop agreeing about what "already
 * in the order" means.
 *
 * `read`/`write` rather than a settings key, because the two lists are read through their own composables — each
 * one resolves its own chain, and the row has to draw THE LIST AS THE USER WROTE IT either way. A pin whose
 * account was disconnected still belongs on screen, greyed: it is a setting they made, and a row that silently
 * stopped drawing it would look like the app had eaten it. (Both resolvers drop it at run time, which is the
 * right answer THERE: neither feature may fail on a credential the sandbox no longer has.) */
const pinList = (read: () => readonly string[], write: (keys: readonly string[]) => void) => {
    /* The picker ADDS rather than selects, which is why it is bound to a scratch ref that empties itself again:
     * the trigger has to keep saying "Add a model" instead of latching onto the last pick, since the list below
     * is where a choice actually lands. A model already in the order is shown greyed rather than hidden — a
     * picker whose contents change as you use it makes you hunt for a row that was there a moment ago. */
    const adding = ref<string | undefined>(undefined);
    watch(adding, (key) => {
        if (key !== undefined && key !== `` && !read().includes(key)) {
            write([...read(), key]);
        }
        adding.value = undefined;
    });
    return {
        adding,
        entries: computed(() =>
            read().map((key, index) => {
                const pin = describeModelPin(key);
                return { key, index, choice: pin.choice, label: pin.label, ready: pin.ready };
            }),
        ),
        // Emptying the list is not a broken state — it is how each row gets back to its own floor, which is why
        // removing the last one needs no confirmation and no separate "reset" control.
        remove: (index: number): void => write(read().filter((_, at) => at !== index)),
        // One step up the order. Only up, and only where there is a step to take: with a whole list on screen,
        // "move this one earlier" repeated is the entire vocabulary needed, and a second button per row in a
        // 14rem column is how a settings page turns into a control panel.
        promote: (index: number): void => {
            const keys = [...read()];
            const [moved] = keys.splice(index, 1);
            keys.splice(index - 1, 0, moved!);
            write(keys);
        },
    };
};

// The option list, with what is already in the order greyed out. Shared for the same reason the editing is:
// the two rows offer different models and owe the reader the identical treatment of one already chosen.
const pickerOptionsFor = (
    groups: readonly { readonly label: string; readonly options: readonly { readonly key: string; readonly label: string }[] }[],
    chosen: readonly string[],
): PickerOptions =>
    groups.map((group) => ({
        label: group.label,
        options: group.options.map((option) => ({
            value: option.key,
            label: option.label,
            ...(chosen.includes(option.key) ? { disabled: true, description: `In the order` } : {}),
        })),
    }));

const quick = pinList(
    () => quickModel.pinned.value,
    (keys) => patch({ quickModel: [...keys] }),
);
const quickModelPickerOptions = computed(() => pickerOptionsFor(quickModelGroups.value, quickModel.pinned.value));

/* WHAT AUTO WOULD DO, spelled out — the same ladder the daemon would walk, named in order. It is the row's
 * whole discoverability story: a user who has never opened this page still sees which account their commit
 * messages come from and which one catches them when it runs out, and the difference between "Auto" and a list
 * they wrote themselves becomes a thing they can compare rather than a thing they have to imagine. */
const autoOrder = computed(() =>
    quickModel.chain.value.map(
        (choice) =>
            quickModelGroups.value.flatMap((group) => group.options).find((option) => option.key === quickModelKey(choice))?.label ?? choice.model,
    ),
);

/* WHAT AN AGENT RUN OPENS ON. Every connected provider's full catalog in CATALOG order — pointedly not
 * cheapest-first like the quick model's list above, because these are opposite jobs: that one exists to keep a
 * one-click helper off the frontier tier, while this one has to read a failing suite, or a container log, and
 * repair the thing.
 *
 * A LIST here for the same reason it is one above, and for no other: one connected account whose allowance went
 * on the chat this morning takes every Fix with agent, chore and documentation run in the sandbox down with it.
 * What the empty list means is where the two part company — Auto up there, and down here the composer's own
 * pick, because nothing can judge which tier a whole session is worth. */
const runs = pinList(
    () => agentRun.pinned.value,
    (keys) => patch({ agentRunModels: [...keys] }),
);
const agentRunPickerOptions = computed(() => pickerOptionsFor(agentRunModelGroups.value, agentRun.pinned.value));

/* THE EFFORT BELONGS TO WHICHEVER MODEL IS ACTUALLY GOING TO RUN — the head of the chain, not the head of the
 * list, since a disconnected first entry is stepped over before anything is spent. Nothing to offer until one
 * of them is reachable, because a tier scale is a property of the model.
 *
 * `thinking: false` because the setting pins a starting effort, not a turn: extended thinking is a per-turn
 * Claude knob a proposed session still owns, and Conversation.effort re-clamps this pick against whatever it
 * is when a session actually opens.
 *
 * "Default" leads with the empty value and is not decoration: an unpinned effort really does mean "whatever the
 * composer is set to", and rendering the scale's lowest segment as selected instead would claim this sandbox
 * had pinned `low` when it had pinned nothing. */
const agentRunEffortOptions = computed(() =>
    agentRun.choice.value === undefined
        ? []
        : [
              { label: `Default`, value: `` },
              ...effortsFor(agentRun.choice.value.provider, agentRun.choice.value.model, false).map((e) => ({ label: e.label, value: e.value })),
          ],
);

/* CLAMPED FOR DISPLAY, never written back — the composer's own rule (effortScale.ts). Reordering the list can
 * put a model with a shorter scale at the head, and a stored `max` would then light no segment at all and read
 * as an unset control. Clamping shows the tier that will actually run while leaving the user's own pick intact
 * for the day the longer-scaled model leads again. */
const agentRunEffort = computed(() => {
    const stored = settings.value?.agentRunEffort ?? ``;
    const head = agentRun.choice.value;
    return stored === `` || head === undefined ? stored : clampEffort(stored, head.provider, head.model, false);
});

// A pinned key is `${provider}:${model}` (quickModelKey) — the provider prefix drives the row's brand mark.
const providerOfKey = (key: string): AgentProvider => key.slice(0, key.indexOf(`:`)) as AgentProvider;
</script>

<template>
    <RowGroup label="Models">
        <!-- The order is drawn IN FULL below the row, because the useful thing to know here is not that a
             default exists but which model a click is about to bill — and, the day that one is spent, which
             one catches it. A trigger 14rem wide can say one of those; the full-width area under the row can
             say all of them, numbered, in the order they will actually be tried. -->
        <Row
            icon="sparkles"
            title="Quick model"
            description="The cheap, fast models behind small automatic jobs like the commit message written when an agent's work lands — tried in order, so a spent account doesn't take the feature down."
        >
            <template #control>
                <Picker
                    v-model="quick.adding.value"
                    :options="quickModelPickerOptions"
                    :disabled="settings === undefined || quickModelGroups.length === 0"
                    placeholder="Add a model…"
                    class="w-56 py-1.5 text-xs"
                    aria-label="Add a quick model"
                />
            </template>
            <!-- Four states, in the order they matter: the list the user wrote, the list the app would use,
                 nothing to use one with, and settings still loading — which draws nothing rather than an
                 "Auto — ." with an empty ladder behind it. -->
            <template #below>
                <ModelPinList
                    v-if="quick.entries.value.length > 0"
                    :entries="quick.entries.value"
                    warn-thinking
                    @promote="quick.promote"
                    @remove="quick.remove"
                >
                    <template #floor>Remove them all to go back to Auto.</template>
                </ModelPinList>
                <!-- AUTO, SPELLED OUT. Naming the ladder rather than the word is what makes this row readable
                     without opening anything: you can see which account your commit messages come from and
                     which one catches it, and decide whether that order is the one you wanted. -->
                <p v-else-if="autoOrder.length > 0" class="text-2xs text-muted">
                    <span class="text-content">Auto</span> — {{ autoOrder.join(`, then `) }}. Add a model to choose the order yourself.
                </p>
                <!-- Nothing connected: the helpers are inert and the dropdown is empty, which on its own reads
                     as a broken control rather than a missing account. -->
                <p v-else-if="settings !== undefined" class="text-2xs text-muted">Connect an AI account above to enable the one-click helpers.</p>
            </template>
        </Row>

        <!-- The tier above it: a real session, started for you. The surfaces it answers for are named — "agent
             runs" means nothing until you can see that the Fix button you press on a red pipeline is one of
             them — but BELOW rather than in the description, because the description column is 14rem wide and
             a five-item list read there as six lines of prose beside a one-line dropdown. The same names on
             the full-width row underneath are one line, and read as the list they are. -->
        <Row
            icon="bolt"
            title="Agent runs"
            description="What a run someone else started opens on — a full session in its own worktree, so pick a tier that can finish the job."
        >
            <template #control>
                <Picker
                    v-model="runs.adding.value"
                    :options="agentRunPickerOptions"
                    :disabled="settings === undefined || agentRunModelGroups.length === 0"
                    placeholder="Add a model…"
                    class="w-56 py-1.5 text-xs"
                    aria-label="Add a model for agent runs"
                >
                    <template #icon="{ option }">
                        <ProviderLogo :provider="providerOfKey(option.value)" class="shrink-0 text-xs text-muted" />
                    </template>
                </Picker>
            </template>
            <!-- TWO BLOCKS, and a hairline between them: the list of models, then the effort those models run
                 at. Without the divider the list's floor caption, the effort label and the footnote underneath
                 it stacked into one run of grey lines, and a control sandwiched between two captions in the
                 same size and colour read as more prose rather than as a setting. Each caption sits directly
                 under the thing it describes, in the smaller, dimmer type — so the eye gets list, then setting,
                 never three unrelated lines. -->
            <template #below>
                <div class="flex flex-col gap-3">
                    <ModelPinList v-if="runs.entries.value.length > 0" :entries="runs.entries.value" @promote="runs.promote" @remove="runs.remove">
                        <template #floor>Remove them all to run on whatever your chat composer is set to.</template>
                    </ModelPinList>
                    <!-- The floor, named. Unlike the row above there is no ladder to spell out — deliberately,
                         since nothing here can judge which tier a whole session is worth — so what this has to
                         say is simply which model answers while the list is empty, and that it follows the
                         composer. -->
                    <p v-else-if="settings !== undefined" class="text-2xs text-muted">
                        <span class="text-content">Composer default</span> — whatever your chat is set to, which keeps following it as you change it.
                        Add a model to pin these runs to a tier of their own.
                    </p>

                    <div class="flex flex-col gap-1.5 border-t border-line pt-3">
                        <!-- The effort scale belongs to the model, so it appears only once one of the pins is
                             reachable — and a model whose runtime forwards no effort at all publishes none,
                             which correctly draws just the footnote. The label is set in the content colour so
                             it reads as the setting it is, not as another caption. -->
                        <div v-if="agentRunEffortOptions.length > 0" class="flex items-center justify-between gap-3">
                            <span class="text-xs font-medium text-content">Reasoning effort</span>
                            <Segmented
                                :model-value="agentRunEffort"
                                :options="agentRunEffortOptions"
                                @update:model-value="(agentRunEffort: string) => patch({ agentRunEffort })"
                            />
                        </div>
                        <!-- Who starts one, and how to deviate without coming back here. A setting that silently
                             does not reach one of the surfaces it lists is worse than one that never claimed to —
                             and the caret is the answer to the question this row otherwise raises, which is what
                             to do when one particular failure wants a bigger model than the standing order. -->
                        <p class="text-2xs text-subtle">
                            Used by Fix with agent, Maintenance, Documentation, Acceptance and pre-push fixes — the caret beside each button
                            overrides this for a single run.
                        </p>
                    </div>
                </div>
            </template>
        </Row>
    </RowGroup>
</template>
