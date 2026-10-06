<script setup lang="ts">
import type { AutomationRun, AutomationSummary, AutomationTemplate, Trigger } from "@intentic/sandbox-contract";
import { localZone } from "@intentic/sandbox-contract/time";
import {
    type ActionItem,
    Button,
    ui,
    CopyButton,
    DisclosureRow,
    formatDateTime,
    Icon,
    Notice,
    noticeOf,
    OverflowActions,
    ToggleSwitch,
    type IconName,
    useDevice,
} from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { nextIn, scheduleTriggerLabel, since } from "./cronSchedule";
import { host } from "./host";
import { type AvailableSource, listenerSourceOf } from "./catalog";
import AutomationFields from "./AutomationFields.vue";
import RunStrip from "./RunStrip.vue";
import { embedSnippet, useAutomations, useSandboxZone, webhookUrl } from "./useAutomations";
import { useAutomationForm } from "./useAutomationForm";
import { t } from "./i18n.js";

// Two lines only: what it's called, and what it does when; everything else (prompt, URL, wake settings, run ledger,
// edit form) sits behind the disclosure, so a page of thirty reads as states, not paragraphs. The trigger glyph doubles
// as the health light. Shared by chores and integrations, since an enabled chore is an ordinary automation.

const props = defineProps<{
    automation: AutomationSummary;
    listenerSources: readonly AvailableSource[];
    templates: readonly AutomationTemplate[];
    expanded: boolean;
    busy?: boolean;
}>();
const emit = defineEmits<{ toggle: [enabled: boolean]; remove: []; expand: []; run: []; install: [] }>();

const trigger = computed<Trigger>(() => props.automation.trigger);
const lastRun = computed<AutomationRun | undefined>(() => props.automation.runs[0]);

// What fires this row, one glyph plus one phrase; a workspace trigger names the moment itself, not a sender.
const TRIGGER_ICON: Record<Trigger[`kind`], IconName> = { schedule: `clock`, once: `pin`, event: `bolt`, listener: `wifi`, workspace: `eye` };
// The source and every filter narrowing it, as one phrase; its own function so the row's label stays a short list of
// kinds rather than one kind's detail plus four others.
const listenerLabel = (fires: Extract<Trigger, { kind: `listener` }>): string => {
    // An unrecognised provider reads as its own id, not a blank.
    const source = listenerSourceOf(props.listenerSources, fires.provider, fires.eventType).label;
    return [
        // "live" means a held-open gateway; CI has none, so saying it there would describe a thing that isn't running.
        fires.provider === `ci` ? source : t(`automationRow.sourceLive`, { source }),
        ...(fires.eventType !== undefined ? [fires.eventType] : []),
        // Branch earns room in the row; two CI automations differing only by branch would otherwise read identically.
        ...(fires.branch !== undefined ? [fires.branch] : []),
        ...(fires.mentioned === true ? [t(`automationRow.mentions`)] : []),
    ].join(` · `);
};
// A workspace moment by name. The two retired ones (the edges of the check that ran after every land) say so, since an
// automation still naming one never fires, and reading it as "Work lands" would promise that it does.
const workspaceWhen = (event: Extract<Trigger, { kind: `workspace` }>[`event`]): string => {
    if (event === `deps.broken`) {
        return t(`automationRow.checksBreakRetired`);
    }
    if (event === `deps.fixed`) {
        return t(`automationRow.checksRecoverRetired`);
    }
    return event === `turn.settled` ? t(`automationRow.turnSettles`) : t(`automationFields.workLands`);
};
const triggerLabel = computed<string>(() => {
    const fires = trigger.value;
    if (fires.kind === `schedule`) {
        // The reader's own zone is what decides whether the badge names one: "Daily 20:43" is only unambiguous to
        // somebody on the clock it means, and this row is the surface that told everyone else the wrong hour.
        return scheduleTriggerLabel(fires, localZone(), sandboxZone.value);
    }
    // The moment itself, in the reader's own clock, since that is the clock they picked it on.
    if (fires.kind === `once`) {
        return t(`automationRow.onceAt`, { at: formatDateTime(fires.at) });
    }
    if (fires.kind === `event`) {
        return t(`automationRow.webhook`);
    }
    if (fires.kind === `workspace`) {
        const when = workspaceWhen(fires.event);
        return fires.repo !== undefined ? `${when} · ${fires.repo}` : when;
    }
    return listenerLabel(fires);
});

// A one-time wake that has already fired. The daemon switches it off AS it fires, so off-plus-a-moment-in-the-past is
// the spent state; without this, a reminder delivered and a reminder cancelled are the same grey row.
const spent = computed<boolean>(() => trigger.value.kind === `once` && !props.automation.enabled && trigger.value.at <= Date.now());

// Only a few tones: `failed` is the one that carries hue, since a page normally all-fine would go green everywhere
// otherwise. A skipped guard or an interrupted run is not a failure.
type Health = `off` | `on` | `done` | `failed`;
const TILE: Record<Health, string> = {
    on: `bg-overlay text-muted`,
    failed: `bg-danger/15 text-danger`,
    // Finished, not stopped: it keeps the live tile's weight rather than the dimmed one that means somebody switched
    // this off.
    done: `bg-overlay text-subtle`,
    off: `bg-content/5 text-subtle`,
};
const health = computed<Health>(() => {
    if (spent.value) {
        return lastRun.value?.outcome === `error` ? `failed` : `done`;
    }
    if (!props.automation.enabled) {
        return `off`;
    }
    return lastRun.value?.outcome === `error` ? `failed` : `on`;
});

const outcomeVerb = (outcome: AutomationRun[`outcome`]): string =>
    ({
        completed: t(`automationRow.outcome.ran`),
        error: t(`automationRow.outcome.failed`),
        skipped: t(`automationRow.outcome.skipped`),
        // Not "failed": the sandbox restarted under it before the run reached its own outcome.
        interrupted: t(`automationRow.outcome.cutOff`),
    })[outcome];
const OUTCOME_CLASS: Record<AutomationRun[`outcome`], string> = {
    completed: `text-muted`,
    error: `text-danger`,
    skipped: `text-subtle`,
    interrupted: `text-subtle`,
};
const runTooltip = (run: AutomationRun): string => `${formatDateTime(run.at)}${run.detail !== undefined ? `, ${run.detail}` : ``}`;

// Opens the run's transcript; a guard-skip has no conversation to open.
const openRun = (run: AutomationRun): void => {
    if (run.conversationId !== undefined) {
        host().chat.openSession(run.conversationId);
    }
};

const nextLabel = computed<string | undefined>(() => (props.automation.nextRun !== undefined ? nextIn(props.automation.nextRun) : undefined));

// Loaded fresh on Edit, discarded on Cancel, never half-typed against what the list shows as saved. No
// save-as-you-type, unlike the acceptance rows this borrows from: a half-typed Visitor chat would turn visitors away
// mid-keystroke.
const editing = ref(false);
const editError = ref<string | undefined>(undefined);
const sandboxZone = useSandboxZone();
const editForm = useAutomationForm(
    computed(() => props.listenerSources),
    computed(() => props.templates),
    sandboxZone,
);
const { save, rotateToken } = useAutomations();
const saving = computed(() => save.isPending.value);
// Two presses, like every undoable action here: the old URL dies the moment the daemon answers.
const confirmingRotate = ref(false);
const rotate = async (): Promise<void> => {
    confirmingRotate.value = false;
    await rotateToken.mutateAsync(props.automation.id);
};

const startEdit = (): void => {
    editForm.load(props.automation);
    editError.value = undefined;
    editing.value = true;
    // Editing implies reading what you are editing: a collapsed row would hide the form entirely.
    if (!props.expanded) {
        emit(`expand`);
    }
};

const cancelEdit = (): void => {
    editing.value = false;
    editError.value = undefined;
};

const saveEdit = async (): Promise<void> => {
    editForm.touchAll();
    if (!editForm.valid.value || saving.value) {
        return;
    }
    editError.value = undefined;
    try {
        await save.mutateAsync(editForm.build());
        editing.value = false;
    } catch (err) {
        editError.value = err instanceof Error ? err.message : t(`automationRow.couldntSave`);
    }
};

// The Visitor chat summary the row shows: the snippet, and the two settings deciding whether it works. Undefined for any
// other automation, and until the sandbox's own origin is known, so Install never opens on nothing.
const visitorChat = computed(() => {
    const fires = props.automation.trigger;
    if (fires.kind !== `listener` || fires.provider !== `webchat` || embedSnippet(props.automation) === undefined) {
        return undefined;
    }
    const config = props.automation.webchat ?? {};
    // Mirrors the daemon's resolution (webchat-config.ts): missing keys report as off, matching what's enforced.
    const turnstileReady = config.turnstileSiteKey !== undefined && config.turnstileSecret !== undefined;
    return {
        origins: fires.allowedOrigins ?? [],
        access: config.access === `google` ? t(`automationRow.googleSignInRequired`) : t(`automationRow.openToAnyone`),
        botCheck:
            config.antiBot === `turnstile` && turnstileReady
                ? `Turnstile`
                : config.antiBot === `turnstile`
                  ? t(`automationRow.turnstileUnfinished`)
                  : config.antiBot === `pow`
                    ? t(`automationRow.builtInBotCheck`)
                    : t(`automationRow.noBotCheck`),
    };
});

// Labelled facts, not one run-on sentence: four settings read at a glance instead of parsed out of prose.
// The model wanted, then a count of fallbacks, not a full list: scanning asks "which model", not "what are all four";
// the full ladder is one click away in the editor.
const runsOn = computed<string>(() => {
    const [head, ...rest] = props.automation.models;
    if (head === undefined) {
        return t(`automationRow.noModel`);
    }
    const named = `${head.provider} · ${head.model}`;
    return rest.length === 0 ? named : `${named} +${rest.length}`;
});
// Who it answers, in one phrase: how many people and groups the rules name, then what everyone else gets.
const othersPhrase = (others: NonNullable<AutomationSummary[`senders`]>[`others`]): string =>
    ({
        ignore: t(`automationRow.othersPhrase.ignore`),
        hold: t(`automationRow.othersPhrase.hold`),
        allow: t(`automationRow.othersPhrase.allow`),
    })[others];
const namedIn = (senders: NonNullable<AutomationSummary[`senders`]>) => ({
    people: senders.rules.reduce((sum, rule) => sum + (rule.ids?.length ?? 0), 0),
    groups: senders.rules.reduce((sum, rule) => sum + (rule.groups?.length ?? 0), 0),
});
const answers = computed<string | undefined>(() => {
    const senders = props.automation.senders;
    if (senders === undefined) {
        return undefined;
    }
    const { people, groups } = namedIn(senders);
    const named = [
        ...(people > 0 ? [t(`automationRow.peopleCount`, { count: people }, people)] : []),
        ...(groups > 0 ? [t(`automationRow.groupsCount`, { count: groups }, groups)] : []),
    ];
    return [
        named.length > 0 ? t(`automationRow.named`, { who: named.join(t(`automationRow.and`)) }) : t(`automationRow.nobodyNamed`),
        othersPhrase(senders.others),
    ].join(` · `);
});
// The same rules as a hover card on the row's glyph: the counts, then what everyone else gets.
const othersWord = (others: NonNullable<AutomationSummary[`senders`]>[`others`]): string =>
    others === `ignore` ? t(`automationRow.othersIgnore`) : others === `hold` ? t(`automationRow.othersHold`) : t(`automationRow.othersAllow`);
const answersTip = computed<{ title: string; rows: { label: string; value: number | string }[] } | undefined>(() => {
    const senders = props.automation.senders;
    if (senders === undefined) {
        return undefined;
    }
    const { people, groups } = namedIn(senders);
    return {
        title: t(`automationRow.answers`),
        rows: [
            { label: t(`automationRow.people`), value: people },
            { label: t(`automationRow.groups`), value: groups > 0 ? groups : `` },
            { label: t(`automationRow.others`), value: othersWord(senders.others) },
        ],
    };
});
const settings = computed<readonly { label: string; value: string }[]>(() => [
    { label: t(`automationRow.runsOn`), value: runsOn.value },
    ...(props.automation.actsAs !== undefined ? [{ label: t(`automationRow.runs2`), value: props.automation.actsAs }] : []),
    ...(answers.value !== undefined ? [{ label: t(`automationRow.answers`), value: answers.value }] : []),
    ...(props.automation.requireApproval === true ? [{ label: t(`automationRow.approval`), value: t(`automationRow.heldForYou`) }] : []),
    ...(props.automation.holdForSeconds !== undefined && props.automation.holdForSeconds > 0
        ? [{ label: t(`automationRow.hold`), value: t(`automationRow.holdBeforeRun`, { seconds: props.automation.holdForSeconds }) }]
        : []),
]);

// One recipe (kit's icon button plus reveal) for all three verbs; hand-written before, it had no touch hit-area growth
// or disabled tone.
const VERB = ui.iconButton(`md:opacity-0 md:group-hover/row:opacity-100 md:focus-visible:opacity-100`);

// A phone keeps the switch and folds the verbs behind one ⋯: four glyphs beside a switch took a second line under
// every automation and read as a toolbar, and there is no hover there to hide them until wanted. The sheet names each
// verb in words, which the glyphs only did in a tooltip a finger never raises.
const { mobile } = useDevice();
const verbs = computed((): ActionItem[] => [
    ...(visitorChat.value === undefined ? [] : [{ id: `install`, label: t(`automationRow.embedCode`), icon: `globe` as const, run: () => emit(`install`) }]),
    { id: `edit`, label: t(`automationRow.edit2`), icon: `pencil`, run: () => startEdit() },
    ...(trigger.value.kind === `listener`
        ? []
        : [{ id: `run`, label: t(`automationRow.runNow2`), icon: `play` as const, disabled: props.busy === true, run: () => emit(`run`) }]),
    { id: `remove`, label: t(`automationRow.delete2`), icon: `trash`, danger: true, run: () => emit(`remove`) },
]);
</script>

<template>
    <!-- Use the row's container width so columns respond to the open chat panel. -->
    <!-- The drawer contains the automation's prose and edit form. -->
    <DisclosureRow class="group/row @container" body="drawer" :open="expanded" @update:open="emit(`expand`)">
        <!-- The row's one mark: what wakes it, tinted by health. -->
        <template #lead="{ mark, iconClass }">
            <span
                class="flex shrink-0 items-center justify-center rounded-md"
                :class="TILE[health]"
                :style="{ width: `${mark}px`, height: `${mark}px` }"
            >
                <Icon :name="TRIGGER_ICON[trigger.kind]" :class="iconClass" />
            </span>
        </template>

        <template #title>
            <span class="flex min-w-0 items-center gap-1.5">
                <span class="truncate" :class="automation.enabled ? `text-content` : `text-subtle`">{{ automation.id }}</span>
                <!-- A chore wakes only when its own check finds something. -->
                <Icon
                    v-if="automation.guard"
                    name="shield"
                    v-tooltip.top="{ title: t(`automationRow.guarded`), note: t(`automationRow.wakesOnFinding`) }"
                    class="shrink-0 text-2xs text-subtle"
                />
                <Icon
                    v-if="automation.requireApproval"
                    name="lock"
                    v-tooltip.top="t(`automationRow.needsApproval`)"
                    class="shrink-0 text-2xs text-subtle"
                />
                <!-- Answers only the people its rules name. -->
                <Icon v-if="answersTip" name="users" v-tooltip.top="answersTip" class="shrink-0 text-2xs text-subtle" />
                <!-- Done, rather than switched off by somebody. -->
                <Icon
                    v-if="spent"
                    name="check"
                    v-tooltip.top="{ title: t(`automationRow.alreadyFired`), note: t(`automationRow.editToRearm`) }"
                    class="shrink-0 text-2xs text-subtle"
                />
            </span>
        </template>

        <!-- This line names when an automation fires and what it does. -->
        <template #description>
            <span class="flex min-w-0 items-baseline gap-1.5">
                <span class="shrink-0">{{ triggerLabel }}</span>
                <!-- A hairline, not a middle dot: the trigger phrase is itself dot-separated, so one more dot would just extend that list. -->
                <span class="hidden min-w-0 flex-1 items-center gap-2 truncate text-subtle @xl:flex" aria-hidden="true">
                    <span class="h-2.5 w-px shrink-0 bg-line-strong"></span>
                    <span class="min-w-0 truncate">{{ automation.prompt }}</span>
                </span>
            </span>
        </template>

        <!-- Facts, not verbs, scanned down the list: history first, then the two clocks. -->
        <template #meta>
            <!-- `w-14` keeps the newest run marks aligned across rows. -->
            <span class="hidden w-14 shrink-0 @2xl:block"><RunStrip :runs="automation.runs" /></span>
            <span
                v-if="lastRun"
                class="hidden w-20 shrink-0 truncate text-right @xl:block"
                :class="OUTCOME_CLASS[lastRun.outcome]"
                v-tooltip.top="runTooltip(lastRun)"
            >
                {{ outcomeVerb(lastRun.outcome) }} {{ since(lastRun.at) }}
            </span>
            <span v-else class="hidden w-20 shrink-0 text-right @xl:block">{{ t(`automationRow.neverRun`) }}</span>

            <!-- An em dash distinguishes “no schedule” from missing data. -->
            <span
                class="hidden w-12 shrink-0 truncate text-right @xl:block"
                :class="nextLabel === undefined ? `text-subtle/50` : ``"
                v-tooltip.top="
                    automation.nextRun !== undefined
                        ? t(`automationRow.next`, { nextRun: formatDateTime(automation.nextRun) })
                        : t(`automationRow.noSchedule`)
                "
            >
                {{ nextLabel ?? `—` }}
            </span>
        </template>

        <template #control>
            <OverflowActions v-if="mobile" :actions="verbs" :header="automation.id" />
            <!-- Reserved boxes keep conditional verbs from shifting the row. -->
            <template v-else>
                <!-- Keep the install snippet visible because it is the deliverable. -->
                <span class="flex w-6 shrink-0 items-center justify-center">
                    <button
                        v-if="visitorChat"
                        type="button"
                        :class="ui.iconButton()"
                        :aria-label="t(`automationRow.installOnWebsite`, { id: automation.id })"
                        v-tooltip.top="t(`automationRow.embedCode`)"
                        @click="emit(`install`)"
                    >
                        <Icon name="globe" class="text-xs" />
                    </button>
                </span>

                <!-- Place verbs before the switch so the right edge stays fixed. -->
                <button
                    type="button"
                    :class="VERB"
                    :aria-label="t(`automationRow.edit`, { id: automation.id })"
                    v-tooltip.top="t(`automationRow.edit2`)"
                    @click="startEdit"
                >
                    <Icon name="pencil" class="text-xs" />
                </button>

                <!-- Lets you test a 3am cron or a webhook without waiting or forging one, even on a disabled row. -->
                <span class="flex w-6 shrink-0 items-center justify-center">
                    <button
                        v-if="trigger.kind !== `listener`"
                        type="button"
                        :class="VERB"
                        :disabled="busy"
                        :aria-label="t(`automationRow.runNow`, { id: automation.id })"
                        v-tooltip.top="t(`automationRow.runNow2`)"
                        @click="emit(`run`)"
                    >
                        <Icon name="play" class="text-xs" />
                    </button>
                </span>

                <!-- Destructive and rare, so it hides from the scan on a pointer device, but stays put on touch, where there's no hover. -->
                <button
                    type="button"
                    :class="ui.iconButton(`hover:text-danger md:opacity-0 md:group-hover/row:opacity-100 md:focus-visible:opacity-100`)"
                    :aria-label="t(`automationRow.delete`, { id: automation.id })"
                    v-tooltip.top="t(`automationRow.delete2`)"
                    @click="emit(`remove`)"
                >
                    <Icon name="trash" class="text-xs" />
                </button>
            </template>

            <!-- A spent one-time wake cannot be re-armed by the switch: its moment is in the past, so the daemon would
                 fire it on the spot rather than schedule anything. Edit it to a new moment instead. -->
            <ToggleSwitch
                :model-value="automation.enabled"
                :disabled="busy || spent"
                :aria-label="t(`automationRow.enable`, { id: automation.id })"
                @update:model-value="emit(`toggle`, $event)"
            />
        </template>

        <!-- The prose half, on demand: what this automation actually says and does, then what it has done. -->
        <template #below>
            <!-- Not a dialog, same reasoning as the acceptance rows: a modal hides the list you're comparing against. -->
            <div v-if="editing" class="flex flex-col gap-3 pr-3">
                <Notice v-if="editError" :of="noticeOf(editError)" />
                <AutomationFields :state="editForm" :name-locked="true" />
                <!-- Match the composer's footer size because this is a form submit. -->
                <div class="flex items-center justify-end gap-2 border-t border-line-subtle pt-3">
                    <Button :label="t(`automationRow.cancel`)" severity="secondary" :text="true" @click="cancelEdit" />
                    <Button :label="t(`automationRow.save`)" :loading="saving" @click="saveEdit">
                        <template #icon><Icon name="check" /></template>
                    </Button>
                </div>
            </div>

            <!-- Two columns for two questions: what this is, and what it's done. -->
            <div v-else class="grid gap-x-6 gap-y-4 pr-3 @3xl:grid-cols-3">
                <div class="flex min-w-0 flex-col gap-3 @3xl:col-span-2">
                    <div class="flex flex-col gap-1">
                        <span :class="ui.sectionLabel(`text-2xs`)">{{ t(`automationRow.prompt`) }}</span>
                        <p class="max-h-32 overflow-auto text-2xs leading-relaxed whitespace-pre-wrap text-muted">
                            {{ automation.prompt }}
                        </p>
                    </div>

                    <div v-if="trigger.kind === `event`" class="flex flex-col gap-1">
                        <span :class="ui.sectionLabel(`text-2xs`)">{{ t(`automationRow.webhook`) }}</span>
                        <!-- The URL carries the door's token; the daemon hands it to a maintainer or owner only, never a viewer. -->
                        <div v-if="webhookUrl(automation) !== undefined" class="flex items-center gap-1.5">
                            <code class="min-w-0 flex-1 truncate font-mono text-2xs text-subtle">{{ webhookUrl(automation) }}</code>
                            <CopyButton
                                :text="webhookUrl(automation) ?? ``"
                                :aria-label="t(`automationRow.copyWebhookUrl`, { id: automation.id })"
                                v-tooltip.top="t(`automationRow.copyUrl`)"
                            />
                            <Button
                                v-if="!confirmingRotate"
                                :label="t(`automationRow.rotate`)"
                                size="small"
                                severity="secondary"
                                :text="true"
                                :disabled="rotateToken.isPending.value"
                                v-tooltip.top="{ title: t(`automationRow.newToken`), note: t(`automationRow.oldUrlStops`) }"
                                @click="confirmingRotate = true"
                            />
                        </div>
                        <p v-else class="text-2xs text-subtle">{{ t(`automationRow.urlShownToMaintainers`) }}</p>
                        <div v-if="confirmingRotate" class="flex flex-wrap items-center justify-end gap-2">
                            <span class="mr-auto text-2xs text-subtle">{{ t(`automationRow.sureEverySenderWired`) }}</span>
                            <Button
                                :label="t(`automationRow.cancel`)"
                                size="small"
                                severity="secondary"
                                :text="true"
                                @click="confirmingRotate = false"
                            />
                            <Button
                                :label="t(`automationRow.rotateToken`)"
                                size="small"
                                severity="danger"
                                :loading="rotateToken.isPending.value"
                                @click="rotate"
                            />
                        </div>
                    </div>

                    <!-- The two settings deciding whether the widget works at all. -->
                    <div v-if="visitorChat" class="flex flex-col gap-1.5">
                        <span :class="ui.sectionLabel(`text-2xs`)">{{ t(`automationRow.visitorChat`) }}</span>
                        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle">
                            <span v-if="visitorChat.origins.length > 0">{{
                                t(`automationRow.onOrigins`, { origins: visitorChat.origins.join(`, `) })
                            }}</span>
                            <span v-else class="text-danger">{{ t(`automationRow.noSitesAllowedNobody`) }}</span>
                            <span>{{ visitorChat.access }}</span>
                            <span>{{ visitorChat.botCheck }}</span>
                        </div>
                        <!-- Use a glyph in the row and words after the reader opens it. -->
                        <Button
                            size="small"
                            severity="secondary"
                            class="self-start"
                            :label="t(`automationRow.getEmbedCode`)"
                            :aria-label="t(`automationRow.installOnWebsite`, { id: automation.id })"
                            @click="emit(`install`)"
                        >
                            <template #icon><Icon name="globe" /></template>
                        </Button>
                    </div>

                    <!-- Labelled pairs expose the two facts most checked during diagnosis. -->
                    <dl class="flex flex-wrap gap-x-5 gap-y-1.5">
                        <div v-for="setting in settings" :key="setting.label" class="flex min-w-0 flex-col">
                            <dt class="text-2xs text-subtle">{{ setting.label }}</dt>
                            <dd class="truncate text-2xs text-muted">{{ setting.value }}</dd>
                        </div>
                    </dl>
                </div>

                <!-- Run history links to transcripts for runs that reached a turn. -->
                <div class="flex min-w-0 flex-col gap-1">
                    <span :class="ui.sectionLabel(`text-2xs`)">{{ t(`automationRow.runs`) }}</span>
                    <p v-if="automation.runs.length === 0" class="text-2xs text-subtle">{{ t(`automationRow.nothingYetRunNow`) }}</p>
                    <div v-else class="-mx-1 flex max-h-40 flex-col overflow-y-auto">
                        <component
                            :is="run.conversationId ? `button` : `div`"
                            v-for="run in automation.runs"
                            :key="run.at"
                            :type="run.conversationId ? `button` : undefined"
                            class="flex items-baseline gap-2 rounded px-1 py-0.5 text-left text-2xs"
                            :class="run.conversationId ? `cursor-pointer hover:bg-content/5` : undefined"
                            :aria-label="run.conversationId ? t(`automationRow.openTranscriptRun`, { at: formatDateTime(run.at) }) : undefined"
                            @click="openRun(run)"
                        >
                            <span class="w-16 shrink-0 text-subtle" v-tooltip.top="formatDateTime(run.at)">{{ since(run.at) }}</span>
                            <span class="w-12 shrink-0" :class="OUTCOME_CLASS[run.outcome]">{{ outcomeVerb(run.outcome) }}</span>
                            <span v-if="run.detail" class="min-w-0 flex-1 truncate text-subtle" v-tooltip.top="run.detail">{{ run.detail }}</span>
                            <Icon v-if="run.conversationId" name="chevron-right" class="ml-auto shrink-0 text-2xs text-subtle" />
                        </component>
                    </div>
                </div>
            </div>
        </template>
    </DisclosureRow>
</template>
