<script setup lang="ts">
import type { SenderSeen } from "@intentic/sandbox-contract/schemas/automations";
import type { ModelPin } from "@intentic/sandbox-contract/schemas/agent";
import { canonicalHarness, loopLabel } from "@intentic/sandbox-contract/models/agent-catalog";
import {
    Button,
    Icon,
    type IconName,
    Picker,
    type PickerOption,
    ProseField,
    SectionHeader,
    SegmentedControl,
    ToggleSwitch,
    ui,
} from "@intentic/extension-ui";
import { computed, ref } from "vue";
import AutomationLabels from "./AutomationLabels.vue";
import ConditionFields from "./fields/ConditionFields.vue";
import TriggerFields from "./fields/TriggerFields.vue";
import { useTriggerKinds } from "./fields/triggerKinds";
import EndsFields from "./schedule/EndsFields.vue";
import { since } from "./cronSchedule";
import { host } from "./host";
import { useConversations, useSenders } from "./useAutomations";
import { type AutomationFormState, type SenderRuleDraft, splitIds, type TargetKind } from "./useAutomationForm";
import { t } from "./i18n.js";
import ServicePicker from "./service/ServicePicker.vue";
import { usePersonaOptions } from "./persona/personaOptions";

// Shared create/edit fields use useAutomationForm, with content-sized When, Then and Runs as steps in a label rail.

const props = defineProps<{
    state: AutomationFormState;
    /** The template this form was prefilled from, named beside the Prompt label. */
    recipeNote?: string;
    /** Editing an existing automation: its name is its identity and cannot be retyped here. */
    nameLocked?: boolean;
}>();

const {
    form,
    isVisitorChat,
    listenerSource,
    starterPrompt,
    staleStarter,
    applyStarter,
    touched,
    markTouched,
    nameError,
    promptError,
    modelsError,
    sendersOffered,
    addSenderRule,
    removeSenderRule,
    sendersError,
    targetsOffered,
    effectiveTarget,
    needsModels,
    retireOffered,
    expiresAt,
    expiresError,
    conversationError,
} = props.state;

// Who its wakes act as: the built-ins and the cards, for the automation and for each sender rule, and the one sentence
// under the picker when a card it names is gone (personaOptions.ts).
const { personaOptions, rulePersonaOptions, personaHint } = usePersonaOptions(form, isVisitorChat);
const { TRIGGER_TABS, whenCaption, kind } = useTriggerKinds(props.state);

// Who has written to this source, by name, so a rule is filled by a click rather than a copied id; read only while the
// block is open.
const { senders: seen } = useSenders(
    computed(() => form.provider),
    computed(() => sendersOffered.value && form.senders),
);
// Enough to recognise the regulars; a busy server's long tail stays a typed id.
const SEEN_SHOWN = 12;
const unnamed = (rule: SenderRuleDraft): readonly SenderSeen[] => {
    const named = new Set(splitIds(rule.ids));
    return seen.value.filter((person) => !named.has(person.id)).slice(0, SEEN_SHOWN);
};
const nameSender = (rule: SenderRuleDraft, id: string): void => {
    rule.ids = [...splitIds(rule.ids), id].join(`, `);
    markTouched(`senders`);
};
// The names behind a rule's ids, for the ones the roster knows; an id it has never heard from stays an id.
const knownNames = (rule: SenderRuleDraft): string[] =>
    splitIds(rule.ids).flatMap((id) => {
        const person = seen.value.find((candidate) => candidate.id === id);
        return person === undefined ? [] : [person.name];
    });
const OTHERS_OPTIONS = computed(
    () =>
        [
            { value: `ignore`, label: t(`automationFields.ignore`) },
            { value: `hold`, label: t(`automationFields.holdMe`) },
            { value: `allow`, label: t(`automationFields.answer`) },
        ] as const,
);
const othersCaption = (others: (typeof OTHERS_OPTIONS.value)[number][`value`]): string =>
    ({
        ignore: t(`automationFields.othersCaption.ignore`),
        hold: t(`automationFields.othersCaption.hold`),
        allow: t(`automationFields.othersCaption.allow`),
    })[others];

// Exposed so a submitting parent can focus the first invalid field; `promptInput` reaches inside `<ProseField>` to the
// actual element, not the component.
const nameInput = ref<HTMLInputElement>();
const promptField = ref<InstanceType<typeof ProseField>>();
const promptInput = computed(() => promptField.value?.field);
defineExpose({ nameInput, promptInput });

// An ordered ladder of picks, walked at fire time; row 1 is preferred, the rest catch it when that account has nothing
// left. No longer defaultable: `modelsError` requires at least one.
const rungs = computed(() =>
    form.models.map((pin) => {
        const described = host().models.describe({
            provider: pin.provider,
            model: pin.model,
            // Shown only while the account is unambiguous (`accountPinnable`).
            ...(accountPinnable.value && form.account !== `` ? { account: form.account } : {}),
            ...(pin.harness !== undefined ? { harness: pin.harness } : {}),
            ...(pin.effort !== undefined ? { effort: pin.effort } : {}),
        });
        return [described.label, loopWord(pin), described.accountLabel].filter((part) => part !== undefined && part !== ``).join(` · `);
    }),
);

// A rung's loop is chosen in the shell's picker with the rest of the pick; the row names it only where it isn't the
// provider's default, since the same model through another loop is another run.
const loopWord = (pin: ModelPin): string | undefined => {
    const harness = canonicalHarness(pin.provider, pin.harness);
    return harness === `native` ? undefined : loopLabel(pin.provider, harness);
};

// An account id only means something beside its own provider, so it can only be pinned while every rung agrees on one;
// crossing providers clears it, falling back to the connected account with the most headroom, same as the scheduler.
const accountPinnable = computed(() => new Set(form.models.map((pin) => pin.provider)).size <= 1);

// A function ref, not one shared element, since the picker anchors to whichever row opened it (popover or sheet; the
// host decides). Slot `form.models.length` anchors the add button.
const rungEls = new Map<number, HTMLElement>();
const bindRung = (index: number, el: unknown): void => {
    if (el instanceof HTMLElement) {
        rungEls.set(index, el);
    } else {
        rungEls.delete(index);
    }
};

/* WHERE THE PICKER OPENS FROM: the rung being edited, or an empty selection for the slot past the end. */
const pickerOptions = (anchor: HTMLElement, current: ModelPin | undefined) => {
    // Blank provider and model are what "nothing chosen yet" looks like to the picker, which is the state the
    // add button opens in; an existing rung opens on itself.
    const { provider = ``, model = ``, harness, effort, thinking, fast } = current ?? {};
    return {
        anchor,
        provider,
        model,
        ...(accountPinnable.value && form.account !== `` ? { account: form.account } : {}),
        ...(harness !== undefined ? { harness } : {}),
        ...(effort !== undefined ? { effort } : {}),
        ...(thinking !== undefined ? { thinking } : {}),
        ...(fast !== undefined ? { fast } : {}),
        chooseRun: true,
    };
};

// A pick as a stored rung. Absent stays absent, never an invented default: a knob the owner did not touch is one
// the model answers for itself, which is the contract every other reader of a pin keeps.
const pinOf = (picked: {
    provider: string;
    model: string;
    effort?: string | undefined;
    harness?: string | undefined;
    thinking?: boolean | undefined;
    fast?: boolean | undefined;
}): ModelPin => ({
    provider: picked.provider,
    model: picked.model,
    ...(picked.effort !== undefined && picked.effort !== `` ? { effort: picked.effort } : {}),
    ...(picked.harness !== undefined && picked.harness !== `` ? { harness: picked.harness as ModelPin["harness"] } : {}),
    ...(picked.thinking !== undefined ? { thinking: picked.thinking } : {}),
    ...(picked.fast !== undefined ? { fast: picked.fast } : {}),
});

// Open the picker over one rung and write back whatever it settles on.
const editRung = async (index: number): Promise<void> => {
    const anchor = rungEls.get(index);
    if (anchor === undefined) {
        return;
    }
    const next = await host().models.pick(pickerOptions(anchor, form.models[index]));
    if (next === undefined) {
        return;
    }
    const pin = pinOf(next);
    form.models = index < form.models.length ? form.models.map((old, at) => (at === index ? pin : old)) : [...form.models, pin];
    // The account is the automation's, not the rung's, kept only while one provider owns the whole ladder.
    form.account = accountPinnable.value ? (next.account ?? ``) : ``;
};

// Opens the picker on the slot past the end; nothing is appended until it actually settles on a model.
const addRung = (): Promise<void> => editRung(form.models.length);

const removeRung = (index: number): void => {
    form.models = form.models.filter((_, at) => at !== index);
    // Marks touched here, so the required-model message appears now, not only when a save is refused.
    markTouched(`models`);
    if (!accountPinnable.value) {
        form.account = ``;
    }
};

// Edited by one step per press, not drag, since order is what the daemon walks and a press works the same on a phone.
const moveRung = (index: number, by: number): void => {
    const to = index + by;
    const moving = form.models[index];
    const displaced = form.models[to];
    if (moving === undefined || displaced === undefined) {
        return;
    }
    form.models = form.models.map((pin, at) => (at === index ? displaced : at === to ? moving : pin));
};

/* ---- the check ---- */

/* ---- what it sets off ---- */

const TARGET_TABS = computed<readonly { value: TargetKind; label: string; icon: IconName }[]>(() => [
    { value: `agent`, label: t(`automationFields.targetAgent`), icon: `sparkles` },
    { value: `conversation`, label: t(`automationFields.targetConversation`), icon: `comments` },
    { value: `notify`, label: t(`automationFields.targetNotify`), icon: `mobile` },
]);
const targetCaption = (target: TargetKind): string =>
    ({
        agent: t(`automationFields.targetCaption.agent`),
        conversation: t(`automationFields.targetCaption.conversation`),
        notify: t(`automationFields.targetCaption.notify`),
    })[target];
// The rail under "Then" says what the prompt is for, which the target decides.
const promptCaption = computed<string>(() =>
    ({
        agent: t(`automationFields.whatWakes`),
        conversation: t(`automationFields.whatConversationIsTold`),
        notify: t(`automationFields.whatNotificationSays`),
    })[effectiveTarget.value],
);

// The board's conversations by title, newest first; read only while this target is picked. One the board no longer
// lists (archived, or gone) stays pickable as itself, so an edit does not silently re-point it.
const conversationsWanted = computed(() => effectiveTarget.value === `conversation`);
const { conversations, fetched: conversationsFetched } = useConversations(conversationsWanted);
const conversationOptions = computed<readonly PickerOption[]>(() => [
    ...conversations.value.map((conversation) => ({
        value: conversation.id,
        label: conversation.title ?? conversation.id,
        description: since(conversation.updatedAt),
    })),
    ...(form.conversationId !== `` && !conversations.value.some((conversation) => conversation.id === form.conversationId)
        ? [
              {
                  value: form.conversationId,
                  label: form.conversationId,
                  mono: true,
                  ...(conversationsFetched.value ? { description: t(`automationFields.notOnBoard`) } : {}),
              },
          ]
        : []),
]);

// The persona decides what a new agent may reach, and what credentials a guard command runs with; a conversation runs
// as itself and a notification runs nothing, so with neither there is nobody to pick.
const personaShown = computed(() => needsModels.value || form.condition === `guard`);

</script>

<template>
    <!-- `divide-y` puts a hairline between steps only, not around each one, so the panel reads as three sections, not three boxes. -->
    <div class="@container flex flex-col divide-y divide-line-subtle">
        <!-- The name is the daemon's upsert key; retyping it while editing would fork a new automation, not rename this one.
             The note is not, so an edit keeps the section for it alone. -->
        <section class="flex flex-col gap-2 pb-4 @2xl:flex-row @2xl:gap-6">
            <div class="flex flex-col gap-0.5 @2xl:w-48 @2xl:shrink-0">
                <SectionHeader :label="nameLocked ? t(`automationFields.note`) : t(`automationFields.name`)" />
                <span class="text-2xs text-subtle">{{ t(`automationFields.howYoullFindLater`) }}</span>
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-3">
                <label v-if="!nameLocked" class="ui-field min-w-0 max-w-sm">
                    <input
                        ref="nameInput"
                        v-model="form.id"
                        placeholder="morning-briefing"
                        :class="[ui.input(), touched.has('name') && nameError ? 'ui-field-error-box' : '']"
                        @blur="markTouched('name')"
                    />
                    <span v-if="touched.has('name') && nameError" class="ui-field-error">
                        <Icon name="exclamation-triangle" class="text-2xs" />
                        {{ nameError }}
                    </span>
                </label>
                <AutomationLabels v-model:note="form.note" v-model:group="form.group" :name-locked="nameLocked" />
            </div>
        </section>

        <!-- WHEN -->
        <section class="flex flex-col gap-3 py-4 first:pt-0 @2xl:flex-row @2xl:gap-6">
            <div class="flex flex-col gap-0.5 @2xl:w-48 @2xl:shrink-0">
                <SectionHeader :label="t(`automationFields.when`)" />
                <span class="text-2xs text-subtle">{{ t(`automationFields.whatWakesAgent`) }}</span>
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-3">
                <!-- Cap the tabs at `max-w-2xl` so one-word choices do not become wide slabs. -->
                <SegmentedControl v-model="kind" :options="TRIGGER_TABS" stretch class="max-w-2xl" />
                <p class="text-2xs text-subtle">{{ whenCaption }}</p>

                <TriggerFields :state="state" />

                <!-- HOW IT ENDS, so a watch never outlives what it was for: as it fires, or at a date. A one-time wake
                     already ends as it fires, so neither is offered there. -->
                <div v-if="retireOffered" class="border-t border-line-subtle pt-3">
                    <EndsFields
                        v-model:stop-after-first="form.stopAfterFirst"
                        v-model:expires-at="form.expiresAt"
                        :at="expiresAt"
                        :error="touched.has(`expiresAt`) ? expiresError : undefined"
                        @update:expires-at="markTouched(`expiresAt`)"
                    />
                </div>
            </div>
        </section>

        <!-- IF: what decides, with no model, whether a fire goes ahead. -->
        <section class="flex flex-col gap-3 py-4 @2xl:flex-row @2xl:gap-6">
            <div class="flex flex-col gap-0.5 @2xl:w-48 @2xl:shrink-0">
                <SectionHeader :label="t(`automationFields.if`)" />
                <span class="text-2xs text-subtle">{{ t(`automationFields.whatHasToBeTrue`) }}</span>
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-3">
                <ConditionFields :state="state" />
            </div>
        </section>

        <!-- THEN -->
        <section class="flex flex-col gap-3 py-4 @2xl:flex-row @2xl:gap-6">
            <div class="flex flex-col gap-0.5 @2xl:w-48 @2xl:shrink-0">
                <SectionHeader :label="t(`automationFields.then`)" />
                <span class="text-2xs text-subtle">{{ promptCaption }}</span>
                <!-- Validation must agree with the trigger's payload shape. -->
                <span v-if="recipeNote" class="mt-1 text-2xs text-subtle">{{ t(`automationFields.starter`, { recipeNote }) }}</span>
                <span v-else-if="starterPrompt && form.prompt === starterPrompt" class="mt-1 text-2xs text-subtle">
                    {{ t(`automationFields.sStarterYoursTo`, { label: listenerSource.label }) }}</span
                >
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-3">
                <!-- WHAT IT SETS OFF. A listener answers whoever wrote, so it only ever starts an agent and is not asked. -->
                <template v-if="targetsOffered">
                    <SegmentedControl v-model="form.target" :options="TARGET_TABS" stretch class="max-w-2xl" />
                    <p class="text-2xs text-subtle">{{ targetCaption(form.target) }}</p>
                    <div v-if="form.target === `conversation`" class="ui-field max-w-md">
                        <Picker
                            v-model="form.conversationId"
                            :options="conversationOptions"
                            :placeholder="t(`automationFields.pickConversation`)"
                            :aria-label="t(`automationFields.conversationToContinue`)"
                            class="w-full"
                        />
                        <span v-if="touched.has(`conversation`) && conversationError" class="ui-field-error">
                            <Icon name="exclamation-triangle" class="text-2xs" />
                            {{ conversationError }}
                        </span>
                    </div>
                </template>
                <label class="ui-field min-w-0 cursor-text">
                    <!-- Use the story editor's borderless prose field for this writing surface. -->
                    <ProseField
                        ref="promptField"
                        v-model="form.prompt"
                        :placeholder="
                            effectiveTarget === `notify` ? t(`automationFields.notifyPlaceholder`) : t(`automationFields.checkInboxSummarizeAnything`)
                        "
                        class="-mx-2 min-h-24"
                        @blur="markTouched('prompt')"
                    />
                    <span v-if="touched.has('prompt') && promptError" class="ui-field-error">
                        <Icon name="exclamation-triangle" class="text-2xs" />
                        {{ promptError }}
                    </span>
                    <!-- A starter left over from a different source; not the form's to rewrite, but worth flagging with a way to swap it. -->
                    <p v-else-if="staleStarter" class="flex flex-wrap items-baseline gap-x-1.5 text-2xs text-warning">
                        <Icon name="exclamation-triangle" class="text-2xs" />
                        <span>{{ t(`automationFields.sStarterSendsDifferent`, { label: staleStarter.label, label2: listenerSource.label }) }}</span>
                        <button type="button" :class="ui.textButton({ tone: `quiet` })" @click="applyStarter">
                            {{ t(`automationFields.useStarter`, { label: listenerSource.label }) }}
                        </button>
                    </p>
                </label>
            </div>
        </section>

        <!-- RUNS AS -->
        <!-- This group defines the agent, wake cost, and unattended authority. -->
        <section class="flex flex-col gap-3 pt-4 @2xl:flex-row @2xl:gap-6">
            <!-- “How” distinguishes the agent's behavior from where it runs. -->
            <div class="flex flex-col gap-0.5 @2xl:w-48 @2xl:shrink-0">
                <SectionHeader :label="t(`automationFields.how`)" />
                <span class="text-2xs text-subtle">{{ t(`automationFields.whoRunsWhatPays`) }}</span>
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-3">
                <!-- Keep the same-shaped behavior and runtime pickers side by side. Only a new agent spends a model of
                     its own; a conversation continues on its own, and a notification runs none. -->
                <div v-if="personaShown" class="grid gap-3 @xl:grid-cols-2">
                    <!-- Preserve the daemon's preference order so fallback remains predictable. -->
                    <div v-if="needsModels" class="ui-field min-w-0">
                        <span class="ui-field-label">{{ t(`automationFields.runsOn`) }}</span>
                        <div class="flex min-w-0 flex-col gap-1.5">
                            <div v-for="(label, index) in rungs" :key="index" class="flex min-w-0 items-center gap-1.5">
                                <!-- The number is the row's whole meaning: order matters here, so it has to be shown. -->
                                <span class="w-3 shrink-0 text-right text-2xs text-subtle tabular-nums">{{ index + 1 }}</span>
                                <button
                                    :ref="(el) => bindRung(index, el)"
                                    type="button"
                                    class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md border border-line bg-canvas px-3 py-2 text-left text-sm text-content transition-colors hover:border-line-strong"
                                    :aria-label="t(`automationFields.modelAutomationChange`, { index: index + 1, label })"
                                    @click="editRung(index)"
                                >
                                    <Icon name="sparkles" class="shrink-0 text-subtle" />
                                    <span class="min-w-0 flex-1 truncate">{{ label }}</span>
                                    <Icon name="chevron-down" class="shrink-0 text-2xs text-subtle" />
                                </button>
                                <!-- Keep the first-row spacer so its chip aligns with later rows. -->
                                <button
                                    type="button"
                                    v-tooltip.top="t(`automationFields.moveUp`)"
                                    :class="ui.iconButton(index === 0 ? `invisible` : ``)"
                                    :disabled="index === 0"
                                    :aria-hidden="index === 0"
                                    :tabindex="index === 0 ? -1 : undefined"
                                    :aria-label="t(`automationFields.moveModelUp`, { index: index + 1 })"
                                    @click="moveRung(index, -1)"
                                >
                                    <Icon name="chevron-up" />
                                </button>
                                <button
                                    type="button"
                                    v-tooltip.top="t(`automationFields.removeModel`)"
                                    :class="ui.iconButton()"
                                    :aria-label="t(`automationFields.removeModel2`, { index: index + 1 })"
                                    @click="removeRung(index)"
                                >
                                    <Icon name="times" />
                                </button>
                            </div>
                            <!-- Adding a rung is a filled button, as every list in the app adds one; the picker anchors to its box. -->
                            <span :ref="(el) => bindRung(form.models.length, el)" class="flex self-start">
                                <Button
                                    size="small"
                                    tier="boring"
                                    :label="form.models.length === 0 ? t(`automationFields.pickModel`) : t(`automationFields.addFallback`)"
                                    @click="addRung"
                                >
                                    <template #icon><Icon name="plus" /></template>
                                </Button>
                            </span>
                        </div>
                        <!-- Its error is about spending, not syntax, so it's shown here, not only on the disabled save button. -->
                        <p v-if="modelsError !== undefined && touched.has(`models`)" class="text-2xs text-danger">{{ modelsError }}</p>
                    </div>
                    <ServicePicker v-model="form.runAs" />
                    <div class="ui-field min-w-0">
                        <span class="ui-field-label">{{ t(`automationFields.persona`) }}</span>
                        <!-- A pick by hand ends the trigger's default for a new automation (usePersonaDefault.ts). -->
                        <Picker
                            v-model="form.actsAs"
                            :options="personaOptions"
                            @update:model-value="markTouched(`actsAs`)"
                            :aria-label="t(`automationFields.personaAutomationRuns`)"
                            class="w-full"
                        />
                    </div>
                </div>
                <!-- A blank Visitor chat uses the saved read-only persona's boundary. -->
                <p v-if="isVisitorChat && form.actsAs === ``" class="-mt-1 text-2xs text-subtle">
                    {{ t(`automationFields.strangersWritePromptsSaving`) }}
                </p>
                <p v-else-if="personaShown && personaHint" class="-mt-1 text-2xs" :class="personaHint.tone">{{ personaHint.text }}</p>

                <!-- WHO IT ANSWERS: drawn only where the source vouches for who is writing; the Visitor chat keeps its own access above. -->
                <div v-if="sendersOffered" class="flex flex-col gap-3 border-t border-line-subtle pt-3">
                    <label class="flex items-center gap-2 text-xs text-content">
                        <ToggleSwitch v-model="form.senders" :aria-label="t(`automationFields.decidePerPersonWho`)" />
                        {{ t(`automationFields.decidePerPersonWho2`) }}
                    </label>
                    <template v-if="form.senders">
                        <div
                            v-for="(rule, index) in form.senderRules"
                            :key="index"
                            class="flex flex-col gap-2 rounded-md border border-line-subtle p-3"
                        >
                            <div class="flex items-start gap-2">
                                <div class="grid min-w-0 flex-1 gap-3" :class="listenerSource.senderGroup ? `@xl:grid-cols-2` : ``">
                                    <label class="ui-field min-w-0">
                                        <span class="ui-field-label">{{ listenerSource.sender?.label }}</span>
                                        <input
                                            v-model="rule.ids"
                                            :class="ui.input(`font-mono`)"
                                            :placeholder="listenerSource.sender?.placeholder"
                                            :aria-label="t(`automationFields.peopleRuleNames`, { index: index + 1 })"
                                            @blur="markTouched(`senders`)"
                                        />
                                        <!-- The roster's names for the ids typed, when it has heard from them; else where to find an id. -->
                                        <span v-if="knownNames(rule).length > 0" class="text-2xs text-subtle">{{
                                            knownNames(rule).join(` · `)
                                        }}</span>
                                        <span v-else-if="listenerSource.sender?.hint" class="text-2xs text-subtle">{{
                                            listenerSource.sender.hint
                                        }}</span>
                                    </label>
                                    <label v-if="listenerSource.senderGroup" class="ui-field min-w-0">
                                        <span class="ui-field-label">{{ listenerSource.senderGroup.label }}</span>
                                        <input
                                            v-model="rule.groups"
                                            :class="ui.input(`font-mono`)"
                                            :placeholder="listenerSource.senderGroup.placeholder"
                                            :aria-label="t(`automationFields.groupsRuleNames`, { index: index + 1 })"
                                            @blur="markTouched(`senders`)"
                                        />
                                        <span v-if="listenerSource.senderGroup.hint" class="text-2xs text-subtle">{{
                                            listenerSource.senderGroup.hint
                                        }}</span>
                                    </label>
                                </div>
                                <button
                                    type="button"
                                    :class="ui.iconButton()"
                                    :aria-label="t(`automationFields.removeRule`, { index: index + 1 })"
                                    v-tooltip.top="t(`automationFields.removeRule2`)"
                                    @click="removeSenderRule(index)"
                                >
                                    <Icon name="times" />
                                </button>
                            </div>
                            <!-- Seen recently: whoever has written, by name; a click stores the id the service vouches for. -->
                            <div v-if="unnamed(rule).length > 0" class="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-subtle">
                                <span>{{ t(`automationFields.seenRecently`) }}</span>
                                <button
                                    v-for="person in unnamed(rule)"
                                    :key="person.id"
                                    type="button"
                                    :class="ui.textButton({ tone: `quiet` })"
                                    v-tooltip.top="person.id"
                                    @click="nameSender(rule, person.id)"
                                >
                                    {{ person.name }}
                                </button>
                            </div>
                            <div class="flex flex-wrap items-center gap-x-6 gap-y-2">
                                <div class="ui-field w-full min-w-0 max-w-xs">
                                    <span class="ui-field-label">{{ t(`automationFields.theyTalkTo`) }}</span>
                                    <Picker
                                        v-model="rule.actsAs"
                                        :options="rulePersonaOptions"
                                        :aria-label="t(`automationFields.personaRuleAnswers`, { index: index + 1 })"
                                        class="w-full"
                                    />
                                </div>
                                <ServicePicker v-model="rule.runAs" inherit class="w-full max-w-xs" />
                                <label class="flex items-center gap-2 text-xs text-content">
                                    <ToggleSwitch
                                        v-model="rule.requireApproval"
                                        :aria-label="t(`automationFields.holdMessagesRuleApproval`, { index: index + 1 })"
                                    />
                                    {{ t(`automationFields.holdMessagesMe`) }}
                                </label>
                            </div>
                        </div>
                        <Button
                            size="small"
                            tier="boring"
                            class="self-start"
                            :label="form.senderRules.length === 0 ? t(`automationFields.nameWhoAnswers`) : t(`automationFields.addMorePeople`)"
                            @click="addSenderRule"
                        >
                            <template #icon><Icon name="plus" /></template>
                        </Button>
                        <p v-if="sendersError !== undefined && touched.has(`senders`)" class="text-2xs text-danger">{{ sendersError }}</p>
                        <div class="flex flex-wrap items-center gap-3 text-xs text-content">
                            <span>{{ t(`automationFields.everyoneElse`) }}</span>
                            <SegmentedControl v-model="form.senderOthers" :options="OTHERS_OPTIONS" />
                        </div>
                        <p class="-mt-1 text-2xs text-subtle">{{ othersCaption(form.senderOthers) }}</p>
                    </template>
                </div>

                <!-- One line, since they compose: approval holds every fire for a click, the countdown holds it and starts by itself. -->
                <div class="flex flex-wrap items-center gap-x-6 gap-y-2" :class="personaShown ? `border-t border-line-subtle pt-3` : ``">
                    <label class="flex items-center gap-2 text-xs text-content">
                        <ToggleSwitch v-model="form.requireApproval" :aria-label="t(`automationFields.requireMyApprovalBefore`)" />
                        {{ t(`automationFields.requireMyApprovalBefore2`) }}
                    </label>
                    <!-- Approval always beats the hold; disabled, the field enforces that itself instead of a warning you had to read. -->
                    <label class="flex items-center gap-2 text-xs" :class="form.requireApproval ? `text-subtle` : `text-content`">
                        {{ t(`automationFields.holdEachRun`) }}
                        <input
                            v-model.number="form.holdForSeconds"
                            type="number"
                            min="0"
                            step="10"
                            class="w-20 font-mono"
                            :class="ui.input()"
                            :disabled="form.requireApproval"
                            :aria-label="t(`automationFields.secondsToHoldEach`)"
                        />
                        {{ t(`automationFields.seconds`) }}
                    </label>
                </div>
                <!-- Said here, not just in the docs, since "require my approval" doesn't sound like a chat that never answers. -->
                <p v-if="form.requireApproval && isVisitorChat" class="-mt-1 text-2xs text-warning">
                    {{ t(`automationFields.visitorsGetNoAnswer`) }}
                </p>

                <!-- Keep the extra job restriction folded because it is uncommon. -->
                <details v-if="personaShown && form.actsAs !== ``" class="text-xs">
                    <summary class="cursor-pointer text-muted hover:text-content">{{ t(`automationFields.narrowOneJobFurther`) }}</summary>
                    <div class="ui-field mt-2 max-w-sm">
                        <input
                            v-model="form.allowedTools"
                            :class="ui.input()"
                            :placeholder="t(`automationFields.readGrepGlob`)"
                            :aria-label="t(`automationFields.toolNamesJobMay`)"
                        />
                        <p class="text-2xs text-subtle">{{ t(`automationFields.toolNamesCommaSeparated`) }}</p>
                    </div>
                </details>
            </div>
        </section>
    </div>
</template>
