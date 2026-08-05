<script setup lang="ts">
import { type AgentProvider, parsePinned, quickModelKey } from "@intentic/sandbox-contract";
import { Picker, type PickerOptions, Row, RowGroup, Segmented } from "@intentic/ui";
import { computed } from "vue";
import { providerReady } from "../../../composables/chat/access";
import { effortsFor } from "../../../composables/chat/effortScale";
import { pickerEntries } from "../../../composables/chat/modelPicker";
import { providerDisplayLabel } from "../../../composables/chat/providerCatalog";
import { quickModelGroups, useQuickModel } from "../../../composables/chat/quickModel";
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
 *   QUICK MODEL — no conversation, no tools, one string back (a commit message, a session title). Auto is the
 *   default and it is DERIVED, not stored: the empty string means "work it out from whatever is connected right
 *   now" (resolveQuickModel — cheapest tier first, free channel before a paid one), so connecting an account
 *   tomorrow improves the answer by itself. Cheapest wins BECAUSE the job is small; being frontier here is not
 *   generosity, it is the wrong tool.
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

// The model Auto currently resolves to, by its SHORT label — the trigger is 14rem wide, and "Auto — Claude
// Code · Claude Haiku 4.5" truncated to "Auto — Claude Code · Cla…" hid exactly the part worth showing. The
// provider rides on the row's logo and the full resolution sits in the Auto row's description instead.
const autoModelLabel = computed<string | undefined>(() => {
    const choice = quickModel.choice.value;
    if (choice === undefined) {
        return undefined;
    }
    const key = quickModelKey(choice);
    return quickModelGroups.value.flatMap((group) => group.options).find((option) => option.key === key)?.label ?? choice.model;
});
// Auto leads as its own ungrouped row; the connected providers follow as labelled groups, so a model row can
// drop the "Claude Code · " prefix that used to eat the width of every line.
const quickModelPickerOptions = computed<PickerOptions>(() => [
    {
        options: [
            {
                value: ``,
                label: autoModelLabel.value === undefined ? `Auto` : `Auto · ${autoModelLabel.value}`,
                description: `Cheapest connected model`,
            },
        ],
    },
    ...quickModelGroups.value.map((group) => ({
        label: group.label,
        options: group.options.map((option) => ({ value: option.key, label: option.label })),
    })),
]);

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
        <!-- Auto leads and states what it resolves to, because the useful thing to know here is not that a
             default exists but WHICH model a click is about to bill. -->
        <Row
            icon="sparkles"
            title="Quick model"
            description="The cheap, fast model behind one-click helpers like the commit-message autofill — never the model your chat runs on."
        >
            <template #control>
                <Picker
                    :model-value="quickModel.pinned.value"
                    :options="quickModelPickerOptions"
                    :disabled="settings === undefined"
                    class="w-56 py-1.5 text-xs"
                    aria-label="Quick model"
                    @update:model-value="(value: string | undefined) => patch({ quickModel: value ?? `` })"
                >
                    <!-- Auto keeps the sparkle the helpers themselves wear; a pinned model wears its provider's
                         mark, so the trigger names the account a click will spend at a glance. -->
                    <template #icon="{ option }">
                        <Icon v-if="option.value === ``" name="sparkles" class="shrink-0 text-xs text-muted" aria-hidden="true" />
                        <ProviderLogo v-else :provider="providerOfKey(option.value)" class="shrink-0 text-xs text-muted" />
                    </template>
                </Picker>
            </template>
            <!-- Nothing connected: the helpers are inert and the dropdown has only Auto in it, which on its own
                 reads as a broken control rather than a missing account. -->
            <template v-if="quickModel.choice.value === undefined && settings !== undefined" #below>
                <p class="text-2xs text-muted">Connect an AI account above to enable the one-click helpers.</p>
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
