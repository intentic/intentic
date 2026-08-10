<script setup lang="ts">
import { type AgentProvider, parsePinned, quickModelKey } from "@intentic/sandbox-contract";
import { Picker, type PickerOptions, Row, RowGroup, Segmented } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { providerReady } from "../../../composables/chat/access";
import { effortsFor } from "../../../composables/chat/effortScale";
import { pickerEntries } from "../../../composables/chat/modelPicker";
import { providerDisplayLabel } from "../../../composables/chat/providerCatalog";
import { pinnedQuickModel, quickModelGroups, useQuickModel } from "../../../composables/chat/quickModel";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";
import ProviderLogo from "../../../chat/ProviderLogo.vue";

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
 *   run, the fix a failed pre-push check proposes. PINNED, never derived, and that is the deliberate opposite of
 *   the row above it: nothing here can judge whether a job is worth the frontier tier, and a wrong guess is
 *   billed in whole sessions. The floor is the composer's own pick, which keeps following the user as they
 *   change it.
 *
 * The chat's own model is the third tier and has no row here — it lives in the composer, where it is chosen per
 * turn and per conversation. */

const { settings, patch } = useSandboxSettings();
const quickModel = useQuickModel();

/* THE LIST AS THE USER WROTE IT — not the resolved chain. A pin whose account was disconnected still belongs
 * on screen, greyed, because it is a setting they made and a row that silently stopped drawing it would look
 * like the app had eaten it. (The resolver drops it at run time, which is the right answer THERE: a helper must
 * not fail on a credential the sandbox no longer has.) */
const pinned = computed(() => quickModel.pinned.value.map((key, index) => ({ key, index, ...pinnedQuickModel(key) })));

// Every write goes through one place, so add/remove/reorder cannot each invent their own idea of the order.
const setChain = (keys: readonly string[]): void => patch({ quickModel: [...keys] });

// Emptying the list is not a broken state — it is how you get back to Auto, which is why removing the last row
// needs no confirmation and no separate "reset" control.
const removeQuickModel = (index: number): void => setChain(quickModel.pinned.value.filter((_, at) => at !== index));

// One step up the order. Only up, and only where there is a step to take: with a whole list on screen, "move
// this one earlier" repeated is the entire vocabulary needed, and a second button per row in a 14rem column is
// how a settings page turns into a control panel.
const promoteQuickModel = (index: number): void => {
    const keys = [...quickModel.pinned.value];
    const [moved] = keys.splice(index, 1);
    keys.splice(index - 1, 0, moved!);
    setChain(keys);
};

/* The picker ADDS rather than selects, which is why it is bound to a scratch ref that empties itself again:
 * the trigger has to keep saying "Add a model" instead of latching onto the last pick, since the list below is
 * where a choice actually lands. A model already in the order is shown greyed rather than hidden — a picker
 * whose contents change as you use it makes you hunt for a row that was there a moment ago. */
const adding = ref<string | undefined>(undefined);
watch(adding, (key) => {
    if (key !== undefined && key !== `` && !quickModel.pinned.value.includes(key)) {
        setChain([...quickModel.pinned.value, key]);
    }
    adding.value = undefined;
});

const quickModelPickerOptions = computed<PickerOptions>(() =>
    quickModelGroups.value.map((group) => ({
        label: group.label,
        options: group.options.map((option) => ({
            value: option.key,
            label: option.label,
            ...(quickModel.pinned.value.includes(option.key) ? { disabled: true, description: `In the order` } : {}),
        })),
    })),
);

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
 * repair the thing. The empty row means "whatever the composer is set to", which is the honest floor. */
const agentRunOptions = computed<PickerOptions>(() => {
    const byProvider = new Map<AgentProvider, { value: string; label: string }[]>();
    for (const entry of pickerEntries.value) {
        // A provider with no credential is not offered: pinning a model this sandbox cannot send to would leave
        // every run failing on a credential error, which is a setting that only ever costs a correction.
        // ACP agents own their own model (empty id), so there is nothing here to pin.
        if (!providerReady(entry.provider) || entry.value === ``) {
            continue;
        }
        const options = byProvider.get(entry.provider) ?? [];
        byProvider.set(entry.provider, options);
        options.push({ value: entry.key, label: entry.label });
    }
    return [
        { options: [{ value: ``, label: `Composer default`, description: `Whatever your chat is set to` }] },
        ...[...byProvider].map(([provider, options]) => ({ label: providerDisplayLabel(provider), options })),
    ];
});

// The pinned choice, parsed — the effort scale below is a property of the MODEL, so there is nothing to offer
// until one is named.
const agentRunModel = computed(() => parsePinned(settings.value?.agentRunModel ?? ``));
/* `thinking: false` because the setting pins a starting effort, not a turn: extended thinking is a per-turn
 * Claude knob a proposed session still owns, and Conversation.effort re-clamps this pick against whatever it
 * is when a session actually opens.
 *
 * "Default" leads with the empty value, matching the model row above it, and is not decoration: an unpinned
 * effort really does mean "whatever the composer is set to", and rendering the scale's lowest segment as
 * selected instead would claim this sandbox had pinned `low` when it had pinned nothing. */
const agentRunEffortOptions = computed(() =>
    agentRunModel.value === undefined
        ? []
        : [
              { label: `Default`, value: `` },
              ...effortsFor(agentRunModel.value.provider, agentRunModel.value.model, false).map((e) => ({ label: e.label, value: e.value })),
          ],
);

// The effort scale belongs to the model, so a new model drops the old pick rather than carrying one its scale
// may not contain. Empty re-seeds from the composer — the same floor the model row itself defaults to.
const setAgentRunModel = (value: string): void => patch({ agentRunModel: value, agentRunEffort: `` });

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
                    v-model="adding"
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
                <ol v-if="pinned.length > 0" class="flex flex-col gap-1">
                    <li
                        v-for="entry in pinned"
                        :key="entry.key"
                        class="flex items-center gap-2 rounded-md border border-line bg-canvas px-2 py-1 text-xs"
                        :class="entry.ready ? `text-content` : `text-subtle`"
                    >
                        <span class="w-3 shrink-0 text-2xs tabular-nums text-subtle">{{ entry.index + 1 }}</span>
                        <ProviderLogo v-if="entry.choice" :provider="entry.choice.provider" class="shrink-0 text-xs text-muted" />
                        <span class="min-w-0 flex-1 truncate" v-tooltip.top.overflow="entry.label">{{ entry.label }}</span>
                        <!-- A pin whose account is gone stays on the list and says so. The resolver skips it at
                             run time, so the helpers keep working — but silently dropping it from the screen
                             would look like the app had eaten a setting the user made. -->
                        <span v-if="!entry.ready" class="shrink-0 text-2xs text-warning">Not connected</span>
                        <button
                            type="button"
                            class="shrink-0 rounded p-1 text-subtle transition-colors hover:bg-overlay hover:text-content disabled:cursor-not-allowed disabled:opacity-30"
                            :disabled="entry.index === 0"
                            @click="promoteQuickModel(entry.index)"
                            v-tooltip.top="'Try this one earlier'"
                            :aria-label="`Move ${entry.label} earlier`"
                        >
                            <Icon name="chevron-up" class="text-2xs" />
                        </button>
                        <button
                            type="button"
                            class="shrink-0 rounded p-1 text-subtle transition-colors hover:bg-overlay hover:text-danger"
                            @click="removeQuickModel(entry.index)"
                            v-tooltip.top="'Remove from the order'"
                            :aria-label="`Remove ${entry.label}`"
                        >
                            <Icon name="times" class="text-2xs" />
                        </button>
                    </li>
                    <!-- The way back to Auto, stated rather than implied: with a list on screen it is not
                         obvious that emptying it hands the choice back to the app. -->
                    <li class="text-2xs text-subtle">Remove them all to go back to Auto.</li>
                </ol>
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
                    :model-value="settings?.agentRunModel ?? ``"
                    :options="agentRunOptions"
                    :disabled="settings === undefined"
                    class="w-56 py-1.5 text-xs"
                    aria-label="Model for agent runs"
                    @update:model-value="(value: string | undefined) => setAgentRunModel(value ?? ``)"
                >
                    <template #icon="{ option }">
                        <Icon v-if="option.value === ``" name="comments" class="shrink-0 text-xs text-muted" aria-hidden="true" />
                        <ProviderLogo v-else :provider="providerOfKey(option.value)" class="shrink-0 text-xs text-muted" />
                    </template>
                </Picker>
            </template>
            <template #below>
                <!-- The effort scale belongs to the model, so it appears only once one is pinned — and a model
                     whose runtime forwards no effort at all publishes none, which correctly draws nothing. -->
                <div v-if="agentRunEffortOptions.length > 0" class="flex items-center justify-between gap-3">
                    <span class="text-xs text-muted">Reasoning effort</span>
                    <Segmented
                        :model-value="settings?.agentRunEffort ?? ``"
                        :options="agentRunEffortOptions"
                        @update:model-value="(agentRunEffort: string) => patch({ agentRunEffort })"
                    />
                </div>
                <!-- Who starts one, and the row's own exception on the same line. A setting that silently does
                     not reach one of the surfaces it lists is worse than one that never claimed to: Acceptance
                     keeps a per-run picker because a run costs one session PER STORY, and that is a spend
                     decision worth making each time. -->
                <p class="text-2xs text-muted">
                    Started by Fix with agent, Maintenance, Documentation, Acceptance and pre-push fixes. Acceptance overrides it per run — one
                    session per story.
                </p>
            </template>
        </Row>
    </RowGroup>
</template>
