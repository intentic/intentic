<script setup lang="ts">
import type { FireOn, ModelPin, SenderSeen, WatchCheckResult } from "@intentic/sandbox-contract";
import { WEBCHAT_DAILY_MAX_DEFAULT } from "@intentic/sandbox-contract";
import {
    Button,
    ui,
    formatDateTime,
    Icon,
    type IconName,
    Picker,
    type PickerOption,
    ProseField,
    SegmentedControl,
    ToggleSwitch,
    vAction,
} from "@intentic/extension-ui";
import { useQuery } from "@tanstack/vue-query";
import { computed, ref } from "vue";
import { glyph } from "./catalog";
import { nextIn, since } from "./cronSchedule";
import { localZone, zoneLabel } from "@intentic/sandbox-contract/time";
import { host } from "./host";
import { useCiDelivery } from "./useCiDelivery";
import { useConversations, useSenders, useWatchCheck } from "./useAutomations";
import { type AutomationFormState, type ConditionKind, type SenderRuleDraft, splitIds, type TargetKind, type TriggerKind } from "./useAutomationForm";
import { t } from "./i18n.js";

// Every field of an automation, rendered once by both the composer that creates one and the row that edits one; the
// shared state lives in useAutomationForm. Three full-width steps (When, Then, Runs as) in a label rail, each sized to
// its own content, rather than two columns forcing every step into the same box.

const props = defineProps<{
    state: AutomationFormState;
    /** The template this form was prefilled from, named beside the Prompt label. */
    recipeNote?: string;
    /** Editing an existing automation: its name is its identity and cannot be retyped here. */
    nameLocked?: boolean;
}>();

const {
    form,
    schedule,
    isVisitorChat,
    listenerSource,
    branchField,
    liveSources,
    visibleSources,
    cronPreview,
    effectiveZone,
    sandboxZone,
    starterPrompt,
    staleStarter,
    applyStarter,
    touched,
    markTouched,
    nameError,
    promptError,
    originsError,
    modelsError,
    sendersOffered,
    addSenderRule,
    removeSenderRule,
    sendersError,
    onceAt,
    onceError,
    targetsOffered,
    effectiveTarget,
    needsModels,
    retireOffered,
    watchSource,
    conditionError,
    expiresAt,
    expiresError,
    conversationError,
} = props.state;

// Personas this sandbox can wear, for the picker below; read here since the list is the same for every automation.
// Names only: a card's connection status belongs on the Personas page, not here.
const personaList = useQuery({
    queryKey: host().sandbox.key(`personas`),
    queryFn: () => host().sandbox.rpc.personas.list(),
    enabled: computed(() => host().sandbox.reachable()),
});
const personas = computed<readonly PickerOption[]>(() =>
    (personaList.data.value?.personas ?? [])
        // `face` draws the same derived character used on the Personas page and in chat, so picking who an automation
        // speaks as is the same act of recognition everywhere.
        .map((persona) => ({ value: persona.id, label: persona.label ?? persona.id, face: persona }))
        // Ordered, because a picker whose rows arrive in the file's order is a list you have to read twice.
        .toSorted((a, b) => a.label.localeCompare(b.label)),
);

// Blank means different things: a Visitor chat fills it in as read-only at save, elsewhere it's nobody. A pinned persona
// whose card is gone still gets a face, greyed, not a glyph, so it reads as gone, not unpinned.
const personaOptions = computed<readonly PickerOption[]>(() => [
    isVisitorChat.value
        ? { value: ``, label: t(`automationFields.visitorChat`), description: `read-only`, icon: `globe` as const }
        : { value: ``, label: t(`automationFields.nobody`), description: t(`automationFields.noAccounts`), icon: `circle` as const },
    ...personas.value,
    ...(form.actsAs !== `` && !personas.value.some((persona) => persona.value === form.actsAs)
        ? [{ value: form.actsAs, label: form.actsAs, description: t(`automationFields.noLongerExists`), face: { id: form.actsAs }, disabled: true }]
        : []),
]);

// A rule's blank row is a different sentence from the automation's: not "nobody", but the whole agent an owner talks to
// themselves. A rule pinned to a card since deleted keeps its face, greyed, like the main picker.
const rulePersonaOptions = computed<readonly PickerOption[]>(() => {
    const known = new Set(personas.value.map((persona) => persona.value));
    const orphans = [...new Set(form.senderRules.map((rule) => rule.actsAs).filter((id) => id !== `` && !known.has(id)))];
    return [
        { value: ``, label: t(`automationFields.noPersona`), description: t(`automationFields.fullToolboxNoAccounts`), icon: `circle` as const },
        ...personas.value,
        ...orphans.map((id) => ({ value: id, label: id, description: t(`automationFields.noLongerExists`), face: { id }, disabled: true })),
    ];
});

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

// CI's delivery path: instant, polled, or never; fetched only while a CI trigger is on screen.
const isCi = computed(() => form.kind === `listener` && form.provider === `ci`);
const { delivery } = useCiDelivery(
    isCi,
    computed(() => form.channelId),
);
const DELIVERY_TONE = {
    ok: `text-muted`,
    polling: `text-warning`,
    none: `text-danger`,
} as const;
const DELIVERY_ICON = {
    ok: `check-circle`,
    polling: `clock`,
    none: `exclamation-triangle`,
} as const;

// Exposed so a submitting parent can focus the first invalid field; `promptInput` reaches inside `<ProseField>` to the
// actual element, not the component.
const nameInput = ref<HTMLInputElement>();
const promptField = ref<InstanceType<typeof ProseField>>();
const promptInput = computed(() => promptField.value?.field);
defineExpose({ nameInput, promptInput });

// The app's segmented control, not four hand-drawn cards, so the loudest thing in the form isn't the trigger-kind
// question. Each keeps its glyph, the same one the list outside this form uses for the row.
const TRIGGER_TABS = computed<readonly { value: TriggerKind; label: string; icon: IconName }[]>(() => [
    { value: `schedule`, label: t(`automationFields.schedule`), icon: `clock` },
    { value: `once`, label: t(`automationFields.once`), icon: `pin` },
    { value: `event`, label: t(`automationFields.webhook`), icon: `bolt` },
    // Needs a connected gateway; an already-Live automation keeps it listed so its editor can't re-point it.
    ...(liveSources.value.length > 0 || form.kind === `listener`
        ? [{ value: `listener` as const, label: t(`automationFields.live`), icon: `wifi` as const }]
        : []),
    { value: `workspace`, label: t(`automationFields.workspace`), icon: `eye` },
]);

// One caption sentence per trigger kind, shown under the picker instead of a label with its own gloss.
// Built when read, so the caption follows the language on screen.
const kindCaption = (kind: TriggerKind): string =>
    ({
        schedule: t(`automationFields.kindCaption.schedule`),
        // Says the two things a reminder's owner has to know and cannot see: which clock the time was read on, and that a
        // sleeping sandbox delivers late rather than never.
        once: t(`automationFields.kindCaption.once`),
        event: t(`automationFields.kindCaption.event`),
        listener: t(`automationFields.kindCaption.listener`),
        workspace: t(`automationFields.kindCaption.workspace`),
    })[kind];
// Names the source directly, not "a connected service", since the reader just picked it; a Visitor chat isn't a service,
// so it says what actually happens.
const whenCaption = computed<string>(() => {
    if (form.kind !== `listener`) {
        return kindCaption(form.kind);
    }
    return isVisitorChat.value
        ? t(`automationFields.kindCaption.visitorChat`)
        : t(`automationFields.kindCaption.source`, { source: listenerSource.value.label });
});

// Wrapped, not bound straight to `form.kind`: switching to Live also has to pick a connected source.
const kind = computed<TriggerKind>({
    get: () => form.kind,
    set: (next) => {
        form.kind = next;
        if (next === `listener` && !liveSources.value.some((source) => source.provider === form.provider)) {
            form.provider = liveSources.value[0]?.provider ?? `discord`;
        }
    },
});

// Every zone ICU knows, which is the only list that cannot go stale against the runtime that will resolve it. Built
// once: it is ~450 strings and the picker is opened rarely.
const ZONE_OPTIONS = Intl.supportedValuesOf(`timeZone`);

// Names the rule's zone beside the preview when the reader is not on that clock, and stays quiet when they are. The
// preview itself is formatted in the READER's zone deliberately — "when does this happen to me" is the question a
// preview answers — and without this line a 20:43 Warsaw rule would read "22:43" to a reader in London with nothing
// on screen explaining the two hours.
const previewZoneNote = computed(() => zoneLabel(effectiveZone.value, localZone()));

const FREQ_OPTIONS = computed(
    () =>
        [
            { value: `minutes`, label: t(`automationFields.minutes2`) },
            { value: `hourly`, label: t(`automationFields.hourly`) },
            { value: `daily`, label: t(`automationFields.daily`) },
            { value: `weekly`, label: t(`automationFields.weekly`) },
            { value: `monthly`, label: t(`automationFields.monthly`) },
            { value: `custom`, label: t(`automationFields.custom`) },
        ] as const,
);
const DAY_OPTIONS = computed(
    () =>
        [
            { value: 1, label: t(`automationFields.mon`) },
            { value: 2, label: t(`automationFields.tue`) },
            { value: 3, label: t(`automationFields.wed`) },
            { value: 4, label: t(`automationFields.thu`) },
            { value: 5, label: t(`automationFields.fri`) },
            { value: 6, label: t(`automationFields.sat`) },
            { value: 0, label: t(`automationFields.sun`) },
        ] as const,
);
const ACCESS_OPTIONS = computed(
    () =>
        [
            { value: `public`, label: t(`automationFields.anyone`) },
            { value: `google`, label: t(`automationFields.googleSignIn`) },
        ] as const,
);
const ANTI_BOT_OPTIONS = computed(
    () =>
        [
            { value: `pow`, label: t(`automationFields.builtInCheck`) },
            { value: `turnstile`, label: t(`automationFields.cloudflareTurnstile`) },
            { value: `off`, label: t(`automationFields.off`) },
        ] as const,
);

// Worded as the moment, not the wire event id, since two ids can fire on the same turn and read as one.
const WORKSPACE_EVENTS = computed(
    () =>
        [
            { value: `turn.settled`, label: t(`automationFields.turnSettles`), hint: t(`automationFields.afterEveryIsolatedAgent`) },
            { value: `agent.landed`, label: t(`automationFields.workLands`), hint: t(`automationFields.onlyAgentsWorkActually`) },
        ] as const,
);

// RETIRED MOMENTS, never offered: `deps.broken` and `deps.fixed` were the edges of the check that ran after every land,
// which is gone, so nothing emits them. An automation written for one still opens as what it is, its moment drawn
// pressed and marked retired, with the sentence that it never fires, rather than as a form with nothing chosen.
const retiredEvent = computed(() => {
    if (form.workspaceEvent === `deps.broken`) {
        return { label: t(`automationFields.checksBreak`) };
    }
    return form.workspaceEvent === `deps.fixed` ? { label: t(`automationFields.checksRecover`) } : undefined;
});

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
        return [described.label, described.accountLabel].filter((part) => part !== undefined && part !== ``).join(` · `);
    }),
);

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

// Chips rather than tabs: five kinds wrap on a phone, and the trigger's own tabs above are already the loud question.
const CONDITION_OPTIONS = computed<readonly { value: ConditionKind; label: string; icon?: IconName }[]>(() => [
    { value: `none`, label: t(`automationFields.conditionNone`) },
    { value: `guard`, label: t(`automationFields.conditionGuard`), icon: `terminal` },
    { value: `npm`, label: t(`automationFields.conditionNpm`), icon: `box` },
    { value: `github-release`, label: t(`automationFields.conditionGithub`), icon: `github` },
    { value: `url`, label: t(`automationFields.conditionUrl`), icon: `globe` },
]);
const conditionCaption = (condition: ConditionKind): string =>
    ({
        none: t(`automationFields.conditionCaption.none`),
        guard: t(`automationFields.conditionCaption.guard`),
        npm: t(`automationFields.conditionCaption.npm`),
        "github-release": t(`automationFields.conditionCaption.github`),
        url: t(`automationFields.conditionCaption.url`),
    })[condition];
const conditionShown = computed(() => touched.has(`condition`) && conditionError.value !== undefined);
const isSource = computed(() => form.condition === `npm` || form.condition === `github-release` || form.condition === `url`);

const FIRE_ON_OPTIONS = computed(
    () =>
        [
            { value: `pass`, label: t(`automationFields.everyPass`) },
            { value: `change`, label: t(`automationFields.onlyOnChange`) },
        ] as const satisfies readonly { value: FireOn; label: string }[],
);

// CHECK NOW: the source as it stands, run once by the daemon, nothing saved. The answer is kept beside the source it was
// for and shown only while the boxes still say the same thing, so an edited source never wears an old verdict.
const check = useWatchCheck();
type Checked = { readonly key: string; readonly result: WatchCheckResult } | { readonly key: string; readonly error: string };
const checked = ref<Checked>();
const sourceKey = computed(() => (watchSource.value === undefined ? undefined : JSON.stringify(watchSource.value)));
const shownCheck = computed(() => (checked.value !== undefined && checked.value.key === sourceKey.value ? checked.value : undefined));
const checkNow = async (): Promise<void> => {
    const source = watchSource.value;
    if (source === undefined) {
        markTouched(`condition`);
        return;
    }
    const key = JSON.stringify(source);
    try {
        checked.value = { key, result: await check.mutateAsync(source) };
    } catch (err) {
        checked.value = { key, error: err instanceof Error ? err.message : t(`automationFields.checkFailed`) };
    }
};
// What the verdict means for THIS watch: a pass fires on the next check, unless it fires only on a change, where the
// first check just notes what it sees.
const checkVerdict = (result: WatchCheckResult): string => {
    if (!result.pass) {
        return t(`automationFields.checkWaiting`);
    }
    return form.fireOn === `change` ? t(`automationFields.checkPassesChange`) : t(`automationFields.checkPassesFires`);
};

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

const toggleDay = (day: number): void => {
    const at = schedule.days.indexOf(day);
    if (at === -1) {
        schedule.days.push(day);
        return;
    }
    schedule.days.splice(at, 1);
};

// Clears the event filter on switch, since an old filter (e.g. `pipeline_failed`) may match nothing on the new source.
const setProvider = (provider: string): void => {
    form.provider = provider;
    form.eventType = undefined;
};
</script>

<template>
    <!-- `divide-y` puts a hairline between steps only, not around each one, so the panel reads as three sections, not three boxes. -->
    <div class="@container flex flex-col divide-y divide-line-subtle">
        <!-- The name is the daemon's upsert key; retyping it while editing would fork a new automation, not rename this one.
             The note is not, so an edit keeps the section for it alone. -->
        <section class="flex flex-col gap-2 pb-4 @2xl:flex-row @2xl:gap-6">
            <div class="flex flex-col gap-0.5 @2xl:w-48 @2xl:shrink-0">
                <span :class="ui.sectionLabel()">{{ nameLocked ? t(`automationFields.note`) : t(`automationFields.name`) }}</span>
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
                <!-- One line on what it is for: a notification's title, and what a conversation it wakes reads it as. -->
                <label class="ui-field min-w-0 max-w-2xl">
                    <span v-if="!nameLocked" class="ui-field-label">{{ t(`automationFields.noteOptional`) }}</span>
                    <input
                        v-model="form.note"
                        maxlength="200"
                        :placeholder="t(`automationFields.notePlaceholder`)"
                        :aria-label="t(`automationFields.note`)"
                        :class="ui.input()"
                    />
                    <span class="text-2xs text-subtle">{{ t(`automationFields.noteHint`) }}</span>
                </label>
            </div>
        </section>

        <!-- WHEN -->
        <section class="flex flex-col gap-3 py-4 first:pt-0 @2xl:flex-row @2xl:gap-6">
            <div class="flex flex-col gap-0.5 @2xl:w-48 @2xl:shrink-0">
                <span :class="ui.sectionLabel()">{{ t(`automationFields.when`) }}</span>
                <span class="text-2xs text-subtle">{{ t(`automationFields.whatWakesAgent`) }}</span>
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-3">
                <!-- Cap the tabs at `max-w-2xl` so one-word choices do not become wide slabs. -->
                <SegmentedControl v-model="kind" :options="TRIGGER_TABS" stretch class="max-w-2xl" />
                <p class="text-2xs text-subtle">{{ whenCaption }}</p>

                <!-- The trigger selects the event and optional repository to watch. -->
                <template v-if="form.kind === 'workspace'">
                    <div class="ui-field">
                        <span class="ui-field-label">{{ t(`automationFields.wake`) }}</span>
                        <div class="flex flex-wrap gap-1.5">
                            <button
                                v-for="option in WORKSPACE_EVENTS"
                                :key="option.value"
                                type="button"
                                :class="ui.chip({ on: form.workspaceEvent === option.value })"
                                :aria-pressed="form.workspaceEvent === option.value"
                                @click="form.workspaceEvent = option.value"
                            >
                                {{ option.label }}
                            </button>
                            <!-- Not a choice: the moment this automation already names, which nothing sends any more. -->
                            <span v-if="retiredEvent !== undefined" data-retired-trigger :class="ui.chip({ on: true }, `gap-1.5 text-subtle`)">
                                <span class="line-through">{{ retiredEvent.label }}</span>
                                <span class="text-2xs">{{ t(`automationFields.retired`) }}</span>
                            </span>
                        </div>
                        <span v-if="retiredEvent !== undefined" class="text-2xs text-warning">{{ t(`automationFields.retiredNeverFires`) }}</span>
                        <span v-else class="text-2xs text-subtle">
                            {{ WORKSPACE_EVENTS.find((option) => option.value === form.workspaceEvent)?.hint }}
                        </span>
                    </div>
                    <label class="ui-field max-w-sm">
                        <span class="ui-field-label">{{ t(`automationFields.onlyRepoOptional`) }}</span>
                        <input
                            v-model="form.repo"
                            :placeholder="t(`automationFields.everyRepoChangeTouched`)"
                            class="font-mono"
                            :class="ui.input()"
                        />
                    </label>
                </template>

                <template v-if="form.kind === 'listener'">
                    <!-- Chips identify choices compactly and wrap when needed. -->
                    <div class="ui-field">
                        <span class="ui-field-label">{{ t(`automationFields.source`) }}</span>
                        <div class="flex flex-wrap gap-1.5">
                            <button
                                v-for="source in visibleSources"
                                :key="source.provider"
                                type="button"
                                :class="ui.chip({ on: form.provider === source.provider })"
                                :aria-pressed="form.provider === source.provider"
                                :disabled="!source.available"
                                @click="setProvider(source.provider)"
                            >
                                <img v-if="source.logo" :src="`https://cdn.simpleicons.org/${source.logo}`" class="h-3.5 w-3.5" alt="" />
                                <Icon v-else :name="glyph(source.icon) ?? 'bolt'" class="text-2xs" />
                                {{ source.label }}
                                <span v-if="!source.available" class="text-warning">{{ t(`automationFields.unavailable`) }}</span>
                            </button>
                        </div>
                    </div>

                    <!-- Visitor chat settings describe its embed location and audience. -->
                    <div v-if="isVisitorChat" class="grid gap-3 @2xl:grid-cols-2">
                        <label class="ui-field @2xl:col-span-2">
                            <span class="ui-field-label">{{ t(`automationFields.allowedSites`) }}</span>
                            <textarea
                                v-model="form.origins"
                                rows="2"
                                placeholder="https://example.com&#10;https://www.example.com"
                                class="font-mono"
                                :class="[ui.input(), touched.has('origins') && originsError ? 'ui-field-error-box' : '']"
                                @blur="markTouched('origins')"
                            ></textarea>
                            <span v-if="touched.has('origins') && originsError" class="ui-field-error">
                                <Icon name="exclamation-triangle" class="text-2xs" />
                                {{ originsError }}
                            </span>
                            <p v-else class="text-2xs text-subtle">{{ t(`automationFields.onePerLineScheme`) }}</p>
                        </label>
                        <div class="ui-field">
                            <span class="ui-field-label">{{ t(`automationFields.whoChat`) }}</span>
                            <div class="flex flex-wrap gap-1.5">
                                <button
                                    v-for="option in ACCESS_OPTIONS"
                                    :key="option.value"
                                    type="button"
                                    :class="ui.chip({ on: form.access === option.value })"
                                    :aria-pressed="form.access === option.value"
                                    @click="form.access = option.value"
                                >
                                    {{ option.label }}
                                </button>
                            </div>
                        </div>
                        <div class="ui-field">
                            <span class="ui-field-label">{{ t(`automationFields.botCheck`) }}</span>
                            <div class="flex flex-wrap gap-1.5">
                                <button
                                    v-for="option in ANTI_BOT_OPTIONS"
                                    :key="option.value"
                                    type="button"
                                    :class="ui.chip({ on: form.antiBot === option.value })"
                                    :aria-pressed="form.antiBot === option.value"
                                    @click="form.antiBot = option.value"
                                >
                                    {{ option.label }}
                                </button>
                            </div>
                            <p class="text-2xs text-subtle">
                                <template v-if="form.antiBot === 'pow'">{{ t(`automationFields.aboutSecondEachVisitors`) }}</template>
                                <template v-else-if="form.antiBot === 'turnstile'">{{ t(`automationFields.invisibleMostVisitorsNeeds`) }}</template>
                                <template v-else>{{ t(`automationFields.onlyAllowedSitesDaily`) }}</template>
                            </p>
                        </div>
                        <label v-if="form.access === 'google'" class="ui-field">
                            <span class="ui-field-label">{{ t(`automationFields.googleClientId`) }}</span>
                            <input
                                v-model="form.googleClientId"
                                placeholder="1234-abc.apps.googleusercontent.com"
                                class="font-mono"
                                :class="ui.input()"
                            />
                            <p class="text-2xs text-subtle">{{ t(`automationFields.sitesOwnOauthClient`) }}</p>
                        </label>
                        <template v-if="form.antiBot === 'turnstile'">
                            <label class="ui-field">
                                <span class="ui-field-label">{{ t(`automationFields.turnstileSiteKey`) }}</span>
                                <input
                                    v-model="form.turnstileSiteKey"
                                    :placeholder="t(`automationFields.n0x4aaa`)"
                                    class="font-mono"
                                    :class="ui.input()"
                                />
                            </label>
                            <label class="ui-field">
                                <span class="ui-field-label">{{ t(`automationFields.turnstileSecretKey`) }}</span>
                                <input
                                    v-model="form.turnstileSecret"
                                    type="password"
                                    :placeholder="t(`automationFields.n0x4aaa`)"
                                    class="font-mono"
                                    :class="ui.input()"
                                />
                                <p class="text-2xs text-subtle">{{ t(`automationFields.staysInSandboxOnly`) }}</p>
                            </label>
                        </template>
                        <label class="ui-field">
                            <span class="ui-field-label">{{ t(`automationFields.greetingOptional`) }}</span>
                            <input v-model="form.greeting" :placeholder="t(`automationFields.hiAskMeAnything`)" :class="ui.input()" />
                        </label>
                        <label class="ui-field">
                            <span class="ui-field-label">{{ t(`automationFields.dailyMessageLimit`) }}</span>
                            <input
                                v-model="form.dailyMessageMax"
                                type="number"
                                min="1"
                                :placeholder="String(WEBCHAT_DAILY_MAX_DEFAULT)"
                                :class="ui.input()"
                            />
                            <p class="text-2xs text-subtle">
                                {{ t(`automationFields.eachMessageRunsAgent`, { webchat_daily_max_default: WEBCHAT_DAILY_MAX_DEFAULT }) }}
                            </p>
                        </label>
                    </div>

                    <div v-else class="grid gap-3 @2xl:grid-cols-2">
                        <div class="ui-field @2xl:col-span-2">
                            <span class="ui-field-label">{{ t(`automationFields.events`) }}</span>
                            <div class="flex flex-wrap gap-1.5">
                                <button
                                    type="button"
                                    :class="ui.chip({ on: form.eventType === undefined })"
                                    :aria-pressed="form.eventType === undefined"
                                    @click="form.eventType = undefined"
                                >
                                    {{ t(`automationFields.any`) }}
                                </button>
                                <button
                                    v-for="eventOption in listenerSource.events"
                                    :key="eventOption.value"
                                    type="button"
                                    :class="ui.chip({ on: form.eventType === eventOption.value })"
                                    :aria-pressed="form.eventType === eventOption.value"
                                    @click="form.eventType = eventOption.value"
                                >
                                    {{ eventOption.label }}
                                </button>
                            </div>
                            <label
                                v-if="form.eventType === 'message' && listenerSource.mentionLabel"
                                class="flex items-center gap-2 text-xs text-muted"
                            >
                                <ToggleSwitch v-model="form.mentioned" :aria-label="listenerSource.mentionLabel" />
                                {{ listenerSource.mentionLabel }}
                            </label>
                        </div>
                        <label class="ui-field">
                            <span class="ui-field-label">{{ listenerSource.channel.label }}</span>
                            <input v-model="form.channelId" :placeholder="listenerSource.channel.placeholder" class="font-mono" :class="ui.input()" />
                        </label>
                        <!-- CI's own second narrowing axis (branch); without it, "wake on CI failure" means every agent's branch too. -->
                        <label v-if="branchField" class="ui-field">
                            <span class="ui-field-label">{{ branchField.label }}</span>
                            <input v-model="form.branch" :placeholder="branchField.placeholder" class="font-mono" :class="ui.input()" />
                            <p class="text-2xs text-subtle">{{ branchField.hint }}</p>
                        </label>
                    </div>
                </template>

                <!-- One box, since a moment is one answer. `datetime-local` reads the reader's own clock, which is how
                     they mean it; what gets stored is the instant that resolves to. -->
                <template v-if="form.kind === 'once'">
                    <label class="ui-field">
                        <span class="ui-field-label">{{ t(`automationFields.fires`) }}</span>
                        <input v-model="form.onceAt" type="datetime-local" class="w-64" :class="ui.input()" @change="markTouched(`onceAt`)" />
                    </label>
                    <p v-if="onceError && touched.has(`onceAt`)" class="text-xs text-danger">{{ onceError }}</p>
                    <!-- The same proof the cron preview gives: how far off the moment they picked actually is. -->
                    <p v-else-if="!onceError" class="text-xs text-muted">{{ t(`automationFields.firesIn`, { when: nextIn(onceAt) }) }}</p>
                </template>

                <template v-if="form.kind === 'schedule'">
                    <div class="ui-field">
                        <span class="ui-field-label">{{ t(`automationFields.repeats`) }}</span>
                        <div class="flex flex-wrap gap-1.5">
                            <button
                                v-for="option in FREQ_OPTIONS"
                                :key="option.value"
                                type="button"
                                :class="ui.chip({ on: schedule.freq === option.value })"
                                :aria-pressed="schedule.freq === option.value"
                                @click="schedule.freq = option.value"
                            >
                                {{ option.label }}
                            </button>
                        </div>
                    </div>
                    <!-- One wrapping row, not stacked, since "Mon…Sun" and "At 09:00" are also spoken side by side. -->
                    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
                        <div v-if="schedule.freq === 'weekly'" class="flex flex-wrap gap-1.5">
                            <button
                                v-for="day in DAY_OPTIONS"
                                :key="day.value"
                                type="button"
                                :class="ui.chip({ on: schedule.days.includes(day.value) })"
                                :aria-pressed="schedule.days.includes(day.value)"
                                @click="toggleDay(day.value)"
                            >
                                {{ day.label }}
                            </button>
                        </div>
                        <label v-if="schedule.freq === 'minutes'" class="flex items-center gap-2 text-xs text-muted">
                            {{ t(`automationFields.every`) }}
                            <input v-model.number="schedule.everyMinutes" type="number" min="1" max="59" class="w-20" :class="ui.input()" />
                            {{ t(`automationFields.minutes`) }}
                        </label>
                        <label v-if="schedule.freq === 'monthly'" class="flex items-center gap-2 text-xs text-muted">
                            {{ t(`automationFields.onDay`) }}
                            <input v-model.number="schedule.dayOfMonth" type="number" min="1" max="31" class="w-20" :class="ui.input()" />
                        </label>
                        <label
                            v-if="schedule.freq === 'daily' || schedule.freq === 'weekly' || schedule.freq === 'monthly'"
                            class="flex items-center gap-2 text-xs text-muted"
                        >
                            <!-- Wide enough for a 12-hour locale: `w-28` clipped the AM/PM suffix in en-US browsers. -->
                            {{ t(`automationFields.at`) }} <input v-model="schedule.time" type="time" class="w-36" :class="ui.input()" />
                        </label>
                        <label v-if="schedule.freq === 'custom'" class="flex min-w-0 flex-col gap-1">
                            <input v-model="schedule.cron" placeholder="0 9 * * 1-5" class="w-48" :class="ui.input('font-mono')" />
                            <span class="text-2xs text-subtle">{{ t(`automationFields.standard5FieldCron`) }}</span>
                        </label>
                        <!-- WHICH CLOCK the times above are on. Offered wherever a schedule names an hour; "every 5
                             minutes" and "hourly" mean the same on every clock, so asking there would be noise.
                             The blank option is not "no zone", it is the sandbox's own, so moving that one setting
                             moves every schedule that never asked for something else. -->
                        <label
                            v-if="schedule.freq !== 'minutes' && schedule.freq !== 'hourly'"
                            class="flex items-center gap-2 text-xs text-muted"
                        >
                            {{ t(`automationFields.inZone`) }}
                            <select v-model="form.tz" class="w-52" :class="ui.input()">
                                <option value="">{{ t(`automationFields.sandboxClock`, { zone: sandboxZone }) }}</option>
                                <option v-for="zone in ZONE_OPTIONS" :key="zone" :value="zone">{{ zone }}</option>
                            </select>
                        </label>
                    </div>
                    <p v-if="schedule.freq === 'weekly' && schedule.days.length === 0" class="text-xs text-danger">
                        {{ t(`automationFields.pickAtLeastOne`) }}
                    </p>
                    <!-- Proof the cron does what it says: shows when it will actually fire next. -->
                    <p v-if="cronPreview" class="text-xs" :class="'error' in cronPreview ? 'text-danger' : 'text-muted'">
                        <template v-if="'runs' in cronPreview">{{
                            t(`automationFields.nextRuns`, { runs: cronPreview.runs.map(formatDateTime).join(" · ") })
                        }}</template>
                        <template v-else>{{ cronPreview.error }}</template>
                    </p>
                    <!-- Shown only to a reader on a different clock from the rule, for whom the preview above reads as
                         a different hour than the one they typed. -->
                    <p v-if="previewZoneNote && cronPreview && 'runs' in cronPreview" class="text-2xs text-subtle">
                        {{ t(`automationFields.shownInYourClock`, { zone: previewZoneNote }) }}
                    </p>
                    <!-- Gates use sessions since the last wake, not elapsed time. -->
                    <label class="flex flex-wrap items-center gap-2 text-xs text-muted">
                        {{ t(`automationFields.onlyOnce`) }}
                        <input
                            v-model.number="form.afterSessions"
                            type="number"
                            min="0"
                            class="w-20 font-mono"
                            :class="ui.input()"
                            :aria-label="t(`automationFields.newSessionsRequiredSince`)"
                        />
                        {{ t(`automationFields.newSessionsRunSince`) }}
                    </label>
                    <p class="text-2xs text-subtle">
                        {{ t(`automationFields.n0FiresOnEvery`) }}
                    </p>
                </template>

                <!-- CI has no held-open gateway: its events arrive by webhook, or by polling if that couldn't register. -->
                <p v-if="isCi && delivery" class="flex items-start gap-1.5 text-xs" :class="DELIVERY_TONE[delivery.state]">
                    <Icon :name="DELIVERY_ICON[delivery.state]" class="mt-0.5 shrink-0 text-2xs" />
                    <span>
                        {{ delivery.summary }}
                        <span v-if="delivery.detail" class="mt-1 block text-2xs text-subtle">{{ delivery.detail }}</span>
                    </span>
                </p>

                <!-- HOW IT ENDS, so a watch never outlives what it was for: as it fires, or at a date. A one-time wake
                     already ends as it fires, so neither is offered there. -->
                <template v-if="retireOffered">
                    <div class="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line-subtle pt-3">
                        <label class="flex items-center gap-2 text-xs text-content">
                            <ToggleSwitch v-model="form.stopAfterFirst" :aria-label="t(`automationFields.stopAfterFirstFire`)" />
                            {{ t(`automationFields.stopAfterFirstFire`) }}
                        </label>
                        <label class="flex items-center gap-2 text-xs text-content">
                            {{ t(`automationFields.endsOn`) }}
                            <input
                                v-model="form.expiresAt"
                                type="datetime-local"
                                class="w-56"
                                :class="[ui.input(), touched.has(`expiresAt`) && expiresError ? `ui-field-error-box` : ``]"
                                :aria-label="t(`automationFields.endDate`)"
                                @change="markTouched(`expiresAt`)"
                            />
                        </label>
                        <button v-if="form.expiresAt !== ``" type="button" :class="ui.textButton({ tone: `quiet`, size: `xs` })" @click="form.expiresAt = ``">
                            {{ t(`automationFields.noEndDate`) }}
                        </button>
                    </div>
                    <p v-if="expiresError && touched.has(`expiresAt`)" class="-mt-1 text-xs text-danger">{{ expiresError }}</p>
                    <p v-else-if="form.expiresAt !== `` && !expiresError" class="-mt-1 text-2xs text-subtle">
                        {{ t(`automationFields.endsCaption`, { when: nextIn(expiresAt) }) }}
                    </p>
                </template>
            </div>
        </section>

        <!-- IF: what decides, with no model, whether a fire goes ahead. -->
        <section class="flex flex-col gap-3 py-4 @2xl:flex-row @2xl:gap-6">
            <div class="flex flex-col gap-0.5 @2xl:w-48 @2xl:shrink-0">
                <span :class="ui.sectionLabel()">{{ t(`automationFields.if`) }}</span>
                <span class="text-2xs text-subtle">{{ t(`automationFields.whatHasToBeTrue`) }}</span>
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-3">
                <div class="flex flex-wrap gap-1.5">
                    <button
                        v-for="option in CONDITION_OPTIONS"
                        :key="option.value"
                        type="button"
                        :class="ui.chip({ on: form.condition === option.value })"
                        :aria-pressed="form.condition === option.value"
                        @click="form.condition = option.value"
                    >
                        <Icon v-if="option.icon" :name="option.icon" class="text-2xs" />
                        {{ option.label }}
                    </button>
                </div>
                <p class="text-2xs text-subtle">{{ conditionCaption(form.condition) }}</p>

                <label v-if="form.condition === `guard`" class="ui-field">
                    <textarea
                        v-model="form.guard"
                        rows="3"
                        spellcheck="false"
                        :placeholder="t(`automationFields.guardPlaceholder`)"
                        :aria-label="t(`automationFields.guardCommand`)"
                        :class="[ui.input(`font-mono`), conditionShown ? `ui-field-error-box` : ``]"
                        @blur="markTouched(`condition`)"
                    ></textarea>
                </label>

                <template v-if="form.condition === `npm`">
                    <div class="flex flex-wrap gap-1.5">
                        <button
                            type="button"
                            :class="ui.chip({ on: form.npmBy === `range` })"
                            :aria-pressed="form.npmBy === `range`"
                            @click="form.npmBy = `range`"
                        >
                            {{ t(`automationFields.waitForVersion`) }}
                        </button>
                        <button
                            type="button"
                            :class="ui.chip({ on: form.npmBy === `tag` })"
                            :aria-pressed="form.npmBy === `tag`"
                            @click="form.npmBy = `tag`"
                        >
                            {{ t(`automationFields.followTag`) }}
                        </button>
                    </div>
                    <div class="grid gap-3 @2xl:grid-cols-2">
                        <label class="ui-field min-w-0">
                            <span class="ui-field-label">{{ t(`automationFields.package`) }}</span>
                            <input
                                v-model="form.npmPackage"
                                placeholder="bun"
                                spellcheck="false"
                                :class="[ui.input(`font-mono`), conditionShown && form.npmPackage.trim() === `` ? `ui-field-error-box` : ``]"
                                @blur="markTouched(`condition`)"
                            />
                        </label>
                        <label v-if="form.npmBy === `range`" class="ui-field min-w-0">
                            <span class="ui-field-label">{{ t(`automationFields.versionRange`) }}</span>
                            <input
                                v-model="form.npmRange"
                                placeholder=">=1.4.3"
                                spellcheck="false"
                                :class="[ui.input(`font-mono`), conditionShown && form.npmRange.trim() === `` ? `ui-field-error-box` : ``]"
                                @blur="markTouched(`condition`)"
                            />
                        </label>
                        <label v-else class="ui-field min-w-0">
                            <span class="ui-field-label">{{ t(`automationFields.distTag`) }}</span>
                            <input v-model="form.npmTag" :placeholder="t(`automationFields.tagPlaceholder`)" spellcheck="false" :class="ui.input(`font-mono`)" />
                        </label>
                    </div>
                    <p class="text-2xs text-subtle">
                        {{ form.npmBy === `range` ? t(`automationFields.npmCaption.range`) : t(`automationFields.npmCaption.tag`) }}
                    </p>
                </template>

                <div v-if="form.condition === `github-release`" class="flex flex-wrap items-end gap-x-6 gap-y-2">
                    <label class="ui-field w-full min-w-0 max-w-sm">
                        <span class="ui-field-label">{{ t(`automationFields.repository`) }}</span>
                        <input
                            v-model="form.githubRepo"
                            placeholder="oven-sh/bun"
                            spellcheck="false"
                            :class="[ui.input(`font-mono`), conditionShown ? `ui-field-error-box` : ``]"
                            @blur="markTouched(`condition`)"
                        />
                    </label>
                    <label class="flex items-center gap-2 pb-2 text-xs text-content">
                        <ToggleSwitch v-model="form.githubPrereleases" :aria-label="t(`automationFields.prereleasesToo`)" />
                        {{ t(`automationFields.prereleasesToo`) }}
                    </label>
                </div>

                <template v-if="form.condition === `url`">
                    <div class="grid gap-3 @2xl:grid-cols-2">
                        <label class="ui-field min-w-0">
                            <span class="ui-field-label">{{ t(`automationFields.page`) }}</span>
                            <input
                                v-model="form.pageUrl"
                                type="url"
                                placeholder="https://example.com/status"
                                spellcheck="false"
                                :class="[ui.input(`font-mono`), conditionShown ? `ui-field-error-box` : ``]"
                                @blur="markTouched(`condition`)"
                            />
                        </label>
                        <label class="ui-field min-w-0">
                            <span class="ui-field-label">{{ t(`automationFields.onlyWhatMatches`) }}</span>
                            <input
                                v-model="form.pageSelect"
                                placeholder="v(\d+\.\d+\.\d+)"
                                spellcheck="false"
                                :class="ui.input(`font-mono`)"
                                @blur="markTouched(`condition`)"
                            />
                        </label>
                    </div>
                    <p class="text-2xs text-subtle">{{ t(`automationFields.pageCaption`) }}</p>
                </template>

                <span v-if="conditionShown" class="ui-field-error">
                    <Icon name="exclamation-triangle" class="text-2xs" />
                    {{ conditionError }}
                </span>

                <!-- CHECK NOW: what the watch would see today, before it is armed. Sources only: a guard command runs
                     with the persona's credentials, which nobody has approved for a preview. -->
                <div v-if="isSource" class="flex flex-col gap-2">
                    <div class="flex flex-wrap items-center gap-2">
                        <Button
                            size="small"
                            tier="boring"
                            :label="t(`automationFields.checkNow`)"
                            :loading="check.isPending.value"
                            @click="checkNow"
                        >
                            <template #icon><Icon name="refresh" /></template>
                        </Button>
                        <span v-if="shownCheck === undefined" class="text-2xs text-subtle">{{ t(`automationFields.checkNowHint`) }}</span>
                    </div>
                    <div
                        v-if="shownCheck !== undefined && `result` in shownCheck"
                        class="flex flex-col gap-1 rounded-md border border-line bg-canvas px-3 py-2"
                    >
                        <span class="flex items-center gap-1.5 text-xs" :class="shownCheck.result.pass ? `text-success` : `text-muted`">
                            <Icon :name="shownCheck.result.pass ? `check-circle` : `clock`" class="text-2xs" />
                            {{ checkVerdict(shownCheck.result) }}
                        </span>
                        <pre class="max-h-32 overflow-auto font-mono text-2xs break-words whitespace-pre-wrap text-content">{{ shownCheck.result.saw }}</pre>
                    </div>
                    <p v-else-if="shownCheck !== undefined" class="flex items-start gap-1.5 text-xs text-danger">
                        <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-2xs" />
                        {{ shownCheck.error }}
                    </p>
                </div>

                <!-- WHEN IT FIRES: every passing check, or only a change in what the check saw. Nothing to compare without a check. -->
                <template v-if="form.condition !== `none`">
                    <div class="flex flex-wrap items-center gap-3 text-xs text-content">
                        <span>{{ t(`automationFields.fireOn`) }}</span>
                        <SegmentedControl v-model="form.fireOn" :options="FIRE_ON_OPTIONS" />
                    </div>
                    <p class="-mt-1 text-2xs text-subtle">
                        {{ form.fireOn === `change` ? t(`automationFields.fireOnCaption.change`) : t(`automationFields.fireOnCaption.pass`) }}
                    </p>
                </template>
            </div>
        </section>

        <!-- THEN -->
        <section class="flex flex-col gap-3 py-4 @2xl:flex-row @2xl:gap-6">
            <div class="flex flex-col gap-0.5 @2xl:w-48 @2xl:shrink-0">
                <span :class="ui.sectionLabel()">{{ t(`automationFields.then`) }}</span>
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
                <span :class="ui.sectionLabel()">{{ t(`automationFields.how`) }}</span>
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
                            <button
                                :ref="(el) => bindRung(form.models.length, el)"
                                type="button"
                                :class="ui.addTile(`self-start px-3 py-2`)"
                                @click="addRung"
                            >
                                <Icon name="plus" />
                                {{ form.models.length === 0 ? t(`automationFields.pickModel`) : t(`automationFields.addFallback`) }}
                            </button>
                        </div>
                        <!-- Its error is about spending, not syntax, so it's shown here, not only on the disabled save button. -->
                        <p v-if="modelsError !== undefined && touched.has(`models`)" class="text-2xs text-danger">{{ modelsError }}</p>
                    </div>
                    <div class="ui-field min-w-0">
                        <span class="ui-field-label">{{ t(`automationFields.persona`) }}</span>
                        <Picker
                            v-model="form.actsAs"
                            :options="personaOptions"
                            :aria-label="t(`automationFields.personaAutomationRuns`)"
                            class="w-full"
                        />
                    </div>
                </div>
                <!-- A blank Visitor chat uses the saved read-only persona's boundary. -->
                <p v-if="isVisitorChat && form.actsAs === ``" class="-mt-1 text-2xs text-subtle">
                    {{ t(`automationFields.strangersWritePromptsSaving`) }}
                </p>

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
                                <label class="flex items-center gap-2 text-xs text-content">
                                    <ToggleSwitch
                                        v-model="rule.requireApproval"
                                        :aria-label="t(`automationFields.holdMessagesRuleApproval`, { index: index + 1 })"
                                    />
                                    {{ t(`automationFields.holdMessagesMe`) }}
                                </label>
                            </div>
                        </div>
                        <button type="button" :class="ui.addTile(`self-start px-3 py-2`)" @click="addSenderRule">
                            <Icon name="plus" />
                            {{ form.senderRules.length === 0 ? t(`automationFields.nameWhoAnswers`) : t(`automationFields.addMorePeople`) }}
                        </button>
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
