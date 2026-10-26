<script setup lang="ts">
import type { AutomationRun, AutomationSummary, AutomationTemplate, Trigger } from "@intentic/sandbox-contract/schemas/automations";
import { localZone } from "@intentic/sandbox-contract/time";
import {
    type ActionItem,
    DisclosureRow,
    formatDateTime,
    Icon,
    type IconName,
    OverflowActions,
    ToggleSwitch,
    toneWash,
    ui,
    useDevice,
} from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { nextIn, scheduleTriggerLabel, since } from "./cronSchedule";
import { type AvailableSource, listenerSourceOf } from "./catalog";
import AutomationDetail from "./detail/AutomationDetail.vue";
import AutomationEditor from "./AutomationEditor.vue";
import RunStrip from "./RunStrip.vue";
import { useConversations, useSandboxZone } from "./useAutomations";
import { isWatch, sourceLabel, watchLine } from "./watch";
import { useServices } from "./service/useServices";
import { usePersonaReach } from "./persona/usePersonaReach";
import { answersCard } from "./senderSummary";
import { visitorChatOf } from "./detail/visitorChat";
import { t } from "./i18n.js";

// Two lines only: what it's called, and what it does when; everything else (prompt, URL, wake settings, run ledger,
// edit form) sits behind the disclosure (AutomationDetail), so a page of thirty reads as states, not paragraphs. The
// trigger glyph doubles as the health light. Shared by every shelf, since an enabled chore is an ordinary automation.

const service = useServices();

const props = defineProps<{
    automation: AutomationSummary;
    // What it does, in one line: its note without the shelf it sits on, else its prompt's first line (grouping.ts).
    gist: string;
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
    failed: toneWash(`danger`),
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

const nextLabel = computed<string | undefined>(() => (props.automation.nextRun !== undefined ? nextIn(props.automation.nextRun) : undefined));

// WHERE A WATCH STANDS: what its check saw last and when, what retires it. A quiet check (nothing moved) is not a run,
// so a watch that has only ever waited has no history to show; this line is what says it is alive.
const watched = computed<string | undefined>(() => watchLine(props.automation));
// A watch's row is scanned for where it stands; a guarded chore's for what it does, so its line waits in the drawer.
const leadsWithWatch = computed(() => watched.value !== undefined && isWatch(props.automation));
const checkedAt = computed<number | undefined>(() => props.automation.watch?.checkedAt);

// What a passing check sets off, said only when it is not the default new agent: the conversation it continues, by its
// title, or the owner's phone. Read only for a row that names a conversation.
const target = computed(() => props.automation.target);
const { titleOf } = useConversations(computed(() => target.value?.kind === `conversation`));
const targetPhrase = computed<string | undefined>(() => {
    const goes = target.value;
    if (goes?.kind === `conversation`) {
        return t(`automationRow.continues`, { conversation: titleOf(goes.conversationId) });
    }
    return goes?.kind === `notify` ? t(`automationRow.notifiesYou`) : undefined;
});
const TARGET_ICON = { conversation: `comments`, notify: `mobile` } as const;

// Every value of an opened automation is changed where it is shown (properties/); the full form is for what has no
// place there of its own, mounted only while open, so it loads fresh each time.
const editing = ref(false);
const sandboxZone = useSandboxZone();

const openSettings = (): void => {
    editing.value = true;
    if (!props.expanded) {
        emit(`expand`);
    }
};

// Set only for a Visitor chat whose snippet can be built: its embed code is the deliverable, so its glyph stays on the row.
const visitorChat = computed(() => visitorChatOf(props.automation));

// Whether its wakes get less than the owner likely expects: one quiet mark on the row, the reason in the drawer.
const { reach, reachTip } = usePersonaReach(computed(() => props.automation));

// Who it answers (senderSummary.ts), as a hover card on the row's glyph; the drawer says it in words.
const answersTip = computed(() => answersCard(props.automation.senders));

// One recipe (kit's icon button plus reveal) for the row's verbs; hand-written before, it had no touch hit-area growth
// or disabled tone.
const VERB = ui.iconButton(`md:opacity-0 md:group-hover/row:opacity-100 md:focus-visible:opacity-100`);

// A phone keeps the switch and folds the verbs behind one ⋯: four glyphs beside a switch took a second line under
// every automation and read as a toolbar, and there is no hover there to hide them until wanted. The sheet names each
// verb in words, which the glyphs only did in a tooltip a finger never raises.
const { mobile } = useDevice();
const verbs = computed((): ActionItem[] => [
    ...(visitorChat.value === undefined ? [] : [{ id: `install`, label: t(`automationRow.embedCode`), icon: `globe` as const, run: () => emit(`install`) }]),
    { id: `settings`, label: t(`automationDetail.allSettings`), icon: `sliders-h`, run: () => openSettings() },
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
                <!-- A watch: the daemon checks something outside itself, and nothing runs until it moves. -->
                <Icon
                    v-if="automation.source"
                    name="eye"
                    v-tooltip.top="{ title: t(`automationRow.watches`), note: sourceLabel(automation.source) }"
                    class="shrink-0 text-2xs text-subtle"
                />
                <!-- Where a fire goes when it is not a new agent: unobtrusive, since the drawer says it in words. -->
                <Icon
                    v-if="automation.target && automation.target.kind !== `agent` && targetPhrase"
                    :name="TARGET_ICON[automation.target.kind]"
                    v-tooltip.top="targetPhrase"
                    :aria-label="targetPhrase"
                    class="shrink-0 text-2xs text-subtle"
                />
                <Icon
                    v-if="automation.requireApproval"
                    name="lock"
                    v-tooltip.top="t(`automationRow.needsApproval`)"
                    class="shrink-0 text-2xs text-subtle"
                />
                <span v-if="automation.runAs" class="text-2xs text-subtle" v-tooltip.top="service.summary(automation.runAs)">{{ t(`service.runsAs`) }} {{ service.label(automation.runAs) }}</span>
                <!-- Its wakes reach less than expected: a persona that is gone (nothing at all), or none (no signed-in account). -->
                <Icon
                    v-if="reachTip"
                    :name="reach?.kind === `missing` ? `exclamation-triangle` : `user`"
                    v-tooltip.top="reachTip"
                    :aria-label="reachTip.title"
                    class="shrink-0 text-2xs"
                    :class="reach?.kind === `missing` ? `text-danger` : `text-subtle`"
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
                <!-- A watch's line says where it stands, which is what its row is scanned for; the prompt is in the drawer. -->
                <span class="hidden min-w-0 flex-1 items-center gap-2 truncate text-subtle @xl:flex" aria-hidden="true">
                    <span class="h-2.5 w-px shrink-0 bg-line-strong"></span>
                    <span class="min-w-0 truncate">{{ leadsWithWatch ? watched : gist }}</span>
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
            <!-- A watch that has only ever waited has run nothing, yet it is alive: when it last looked says so. -->
            <span
                v-else-if="checkedAt !== undefined"
                class="hidden w-20 shrink-0 items-center justify-end gap-1 truncate @xl:flex"
                v-tooltip.top="t(`automationRow.checkedAt`, { at: formatDateTime(checkedAt) })"
            >
                <Icon name="eye" class="shrink-0 text-2xs" />{{ since(checkedAt) }}
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

                <!-- Place verbs before the switch so the right edge stays fixed. There is no edit verb: pressing the row opens it, and
                     everything it shows is changed where it is shown. -->
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
                    :class="ui.iconButton({ tone: `danger` }, `md:opacity-0 md:group-hover/row:opacity-100 md:focus-visible:opacity-100`)"
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
            <AutomationEditor
                v-if="editing"
                back
                class="pr-3"
                :automation="automation"
                :listener-sources="listenerSources"
                :templates="templates"
                @done="editing = false"
            />

            <AutomationDetail
                v-else
                :automation="automation"
                :trigger-label="triggerLabel"
                :target-phrase="targetPhrase"
                :spent="spent"
                :busy="busy"
                @settings="openSettings"
                @run="emit(`run`)"
                @install="emit(`install`)"
            />
        </template>
    </DisclosureRow>
</template>
