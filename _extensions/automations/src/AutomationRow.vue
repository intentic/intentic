<script setup lang="ts">
import type { AutomationRun, AutomationSummary, AutomationTemplate, Trigger } from "@intentic/sandbox-contract";
import { Button, ui, CopyButton, DisclosureRow, formatDateTime, Icon, Notice, noticeOf, ToggleSwitch, type IconName } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { nextIn, scheduleTriggerLabel, since } from "./cronSchedule";
import { host } from "./host";
import { type AvailableSource, listenerSourceOf } from "./catalog";
import AutomationFields from "./AutomationFields.vue";
import RunStrip from "./RunStrip.vue";
import { embedSnippet, useAutomations, webhookUrl } from "./useAutomations";
import { useAutomationForm } from "./useAutomationForm";

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
const TRIGGER_ICON: Record<Trigger[`kind`], IconName> = { schedule: `clock`, event: `bolt`, listener: `wifi`, workspace: `eye` };
const triggerLabel = computed<string>(() => {
    const fires = trigger.value;
    if (fires.kind === `schedule`) {
        return scheduleTriggerLabel(fires);
    }
    if (fires.kind === `event`) {
        return `Webhook`;
    }
    if (fires.kind === `workspace`) {
        const when = fires.event === `turn.settled` ? `Turn settles` : `Work lands`;
        return fires.repo !== undefined ? `${when} · ${fires.repo}` : when;
    }
    // An unrecognised provider reads as its own id, not a blank.
    const source = listenerSourceOf(props.listenerSources, fires.provider, fires.eventType).label;
    return [
        // "live" means a held-open gateway; CI has none, so saying it there would describe a thing that isn't running.
        fires.provider === `ci` ? source : `${source} live`,
        ...(fires.eventType !== undefined ? [fires.eventType] : []),
        // Branch earns room in the row; two CI automations differing only by branch would otherwise read identically.
        ...(fires.branch !== undefined ? [fires.branch] : []),
        ...(fires.mentioned === true ? [`mentions`] : []),
    ].join(` · `);
});

// Only three tones: `failed` is the one that carries hue, since a page normally all-fine would go green everywhere
// otherwise. A skipped guard or an interrupted run is not a failure.
type Health = `off` | `on` | `failed`;
const TILE: Record<Health, string> = {
    on: `bg-overlay text-muted`,
    failed: `bg-danger/15 text-danger`,
    off: `bg-content/5 text-subtle`,
};
const health = computed<Health>(() => {
    if (!props.automation.enabled) {
        return `off`;
    }
    return lastRun.value?.outcome === `error` ? `failed` : `on`;
});

const OUTCOME_VERB: Record<AutomationRun[`outcome`], string> = {
    completed: `ran`,
    error: `failed`,
    skipped: `skipped`,
    // Not "failed": the sandbox restarted under it before the run reached its own outcome.
    interrupted: `cut off`,
};
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
// save-as-you-type, unlike the acceptance rows this borrows from: a half-typed Front Desk would turn visitors away
// mid-keystroke.
const editing = ref(false);
const editError = ref<string | undefined>(undefined);
const editForm = useAutomationForm(
    computed(() => props.listenerSources),
    computed(() => props.templates),
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
        editError.value = err instanceof Error ? err.message : `Could not save the automation.`;
    }
};

// The Front Desk summary the row shows: the snippet, and the two settings deciding whether it works. Undefined for any
// other automation, and until the sandbox's own origin is known, so Install never opens on nothing.
const frontDesk = computed(() => {
    const fires = props.automation.trigger;
    if (fires.kind !== `listener` || fires.provider !== `webchat` || embedSnippet(props.automation) === undefined) {
        return undefined;
    }
    const config = props.automation.webchat ?? {};
    // Mirrors the daemon's resolution (webchat-config.ts): missing keys report as off, matching what's enforced.
    const turnstileReady = config.turnstileSiteKey !== undefined && config.turnstileSecret !== undefined;
    return {
        origins: fires.allowedOrigins ?? [],
        access: config.access === `google` ? `Google sign-in required` : `open to anyone`,
        botCheck:
            config.antiBot === `turnstile` && turnstileReady
                ? `Turnstile`
                : config.antiBot === `turnstile`
                  ? `Turnstile not finished: no bot check`
                  : config.antiBot === `pow`
                    ? `built-in bot check`
                    : `no bot check`,
    };
});

// Labelled facts, not one run-on sentence: four settings read at a glance instead of parsed out of prose.
// The model wanted, then a count of fallbacks, not a full list: scanning asks "which model", not "what are all four";
// the full ladder is one click away in the editor.
const runsOn = computed<string>(() => {
    const [head, ...rest] = props.automation.models;
    if (head === undefined) {
        return `no model`;
    }
    const named = `${head.provider} · ${head.model}`;
    return rest.length === 0 ? named : `${named} +${rest.length}`;
});
const settings = computed<readonly { label: string; value: string }[]>(() => [
    { label: `Runs on`, value: runsOn.value },
    ...(props.automation.actsAs !== undefined ? [{ label: `Runs as`, value: props.automation.actsAs }] : []),
    ...(props.automation.requireApproval === true ? [{ label: `Approval`, value: `held for you` }] : []),
    ...(props.automation.holdForSeconds !== undefined && props.automation.holdForSeconds > 0
        ? [{ label: `Hold`, value: `${props.automation.holdForSeconds}s before each run` }]
        : []),
]);

// One recipe (kit's icon button plus reveal) for all three verbs; hand-written before, it had no touch hit-area growth
// or disabled tone.
const VERB = ui.iconButton(`md:opacity-0 md:group-hover/row:opacity-100 md:focus-visible:opacity-100`);
</script>

<template>
    <!--
        A `@container`, not viewport breakpoints, so columns thin against this row's own width; with the chat panel open the list can be ~350px while
        `sm:`/`lg:` still read true.
    -->
    <!-- `body="drawer"`: what opens is the automation's prose and its edit form, a place of its own rather than
         a fact hanging off its id. -->
    <DisclosureRow class="group/row @container" body="drawer" :open="expanded" @update:open="emit(`expand`)">
        <!-- The row's one mark: what wakes it, tinted by health. Sized from the group's own tier via the slot prop, not a number typed here. -->
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
                <!--
                    A chore's own check (knip, advisories, duplication) wakes it only when something's found; the icon says so and explains its
                    "skipped" runs.
                -->
                <Icon
                    v-if="automation.guard"
                    name="shield"
                    v-tooltip.top="`Wakes only when its own check finds something`"
                    class="shrink-0 text-2xs text-subtle"
                />
                <Icon
                    v-if="automation.requireApproval"
                    name="lock"
                    v-tooltip.top="`Held for your approval before it runs`"
                    class="shrink-0 text-2xs text-subtle"
                />
            </span>
        </template>

        <!--
            When it fires, then what it's for: the one place in the list that says what an automation is actually for, on its own line rather than
            competing with the name.
        -->
        <template #description>
            <span class="flex min-w-0 items-baseline gap-1.5">
                <span class="shrink-0">{{ triggerLabel }}</span>
                <!--
                    A hairline, not a middle dot: the trigger phrase is itself dot-separated, so one more dot would just extend that list.
                    `aria-hidden`, so the row's accessible name stays "<id> <trigger>", not the truncated prompt too.
                -->
                <span class="hidden min-w-0 flex-1 items-center gap-2 truncate text-subtle @xl:flex" aria-hidden="true">
                    <span class="h-2.5 w-px shrink-0 bg-line-strong"></span>
                    <span class="min-w-0 truncate">{{ automation.prompt }}</span>
                </span>
            </span>
        </template>

        <!-- Facts, not verbs, scanned down the list: history first, then the two clocks. -->
        <template #meta>
            <!-- `w-14` is the eight-mark width plus air, so a row with two runs and one with eight still align their newest mark in the same column. -->
            <span class="hidden w-14 shrink-0 @2xl:block"><RunStrip :runs="automation.runs" /></span>
            <span
                v-if="lastRun"
                class="hidden w-20 shrink-0 truncate text-right @xl:block"
                :class="OUTCOME_CLASS[lastRun.outcome]"
                v-tooltip.top="runTooltip(lastRun)"
            >
                {{ OUTCOME_VERB[lastRun.outcome] }} {{ since(lastRun.at) }}
            </span>
            <span v-else class="hidden w-20 shrink-0 text-right @xl:block">never run</span>

            <!-- The em dash matters: an empty cell beside a full one would read as a missing value, not "fires on its trigger, no clock". -->
            <span
                class="hidden w-12 shrink-0 truncate text-right @xl:block"
                :class="nextLabel === undefined ? `text-subtle/50` : ``"
                v-tooltip.top="automation.nextRun !== undefined ? `Next: ${formatDateTime(automation.nextRun)}` : `Fires on its trigger, not a clock`"
            >
                {{ nextLabel ?? `—` }}
            </span>
        </template>

        <template #control>
            <!--
                Reserved boxes, not absence, for the two conditional verbs: laid out from the right, a missing one would shift every column after it
                out of alignment down the list.
            -->

            <!--
                Always visible, not hover-revealed, since the snippet is the deliverable itself; it also carries install status, the only place that
                can say whether the paste worked.
            -->
            <span class="flex w-6 shrink-0 items-center justify-center">
                <button
                    v-if="frontDesk"
                    type="button"
                    :class="ui.iconButton()"
                    :aria-label="`Install ${automation.id} on a website`"
                    v-tooltip.top="`Embed code & install status`"
                    @click="emit(`install`)"
                >
                    <Icon name="globe" class="text-xs" />
                </button>
            </span>

            <!--
                Verbs before the switch, so the always-visible control sits at a fixed right edge instead of shifting as hover-revealed verbs appear
                beside it. They just stay on a touch pointer.
            -->
            <button type="button" :class="VERB" :aria-label="`Edit ${automation.id}`" v-tooltip.top="`Edit`" @click="startEdit">
                <Icon name="pencil" class="text-xs" />
            </button>

            <!--
                Lets you test a 3am cron or a webhook without waiting or forging one, even on a disabled row. No button for a chat listener: a
                by-hand fire carries no message, so testing one just means sending the bot a message.
            -->
            <span class="flex w-6 shrink-0 items-center justify-center">
                <button
                    v-if="trigger.kind !== `listener`"
                    type="button"
                    :class="VERB"
                    :disabled="busy"
                    :aria-label="`Run ${automation.id} now`"
                    v-tooltip.top="`Run now`"
                    @click="emit(`run`)"
                >
                    <Icon name="play" class="text-xs" />
                </button>
            </span>

            <!-- Destructive and rare, so it hides from the scan on a pointer device, but stays put on touch, where there's no hover. -->
            <button
                type="button"
                :class="ui.iconButton(`hover:text-danger md:opacity-0 md:group-hover/row:opacity-100 md:focus-visible:opacity-100`)"
                :aria-label="`Delete ${automation.id}`"
                v-tooltip.top="`Delete`"
                @click="emit(`remove`)"
            >
                <Icon name="trash" class="text-xs" />
            </button>

            <ToggleSwitch
                :model-value="automation.enabled"
                :disabled="busy"
                :aria-label="`Enable ${automation.id}`"
                @update:model-value="emit(`toggle`, $event)"
            />
        </template>

        <!-- The prose half, on demand: what this automation actually says and does, then what it has done. -->
        <template #below>
            <!--
                Not a dialog, same reasoning as the acceptance rows: a modal hides the list you're comparing against. The row gets the whole page
                width, with its own history right below.
            -->
            <div v-if="editing" class="flex flex-col gap-3 pr-3">
                <Notice v-if="editError" :of="noticeOf(editError)" />
                <AutomationFields :state="editForm" :name-locked="true" />
                <!--
                    The composer's own footer, same size: a form's submit, not a row verb, and the two must agree since a reader meets both one click
                    apart.
                -->
                <div class="flex items-center justify-end gap-2 border-t border-line-subtle pt-3">
                    <Button label="Cancel" severity="secondary" :text="true" @click="cancelEdit" />
                    <Button label="Save" :loading="saving" @click="saveEdit">
                        <template #icon><Icon name="check" /></template>
                    </Button>
                </div>
            </div>

            <!--
                Two columns for two questions: what this is, and what it's done. Stacked, the ledger sat below the fold of a long prompt, answering
                the question a row is usually opened for last. Stacks again under `3xl`, too narrow for two columns of this text.
            -->
            <div v-else class="grid gap-x-6 gap-y-4 pr-3 @3xl:grid-cols-3">
                <div class="flex min-w-0 flex-col gap-3 @3xl:col-span-2">
                    <div class="flex flex-col gap-1">
                        <span :class="ui.sectionLabel(`text-2xs`)">Prompt</span>
                        <p class="scrollbar-thin max-h-32 overflow-auto text-2xs leading-relaxed whitespace-pre-wrap text-muted">
                            {{ automation.prompt }}
                        </p>
                    </div>

                    <div v-if="trigger.kind === `event`" class="flex flex-col gap-1">
                        <span :class="ui.sectionLabel(`text-2xs`)">Webhook</span>
                        <!-- The URL carries the door's token; the daemon hands it to a maintainer or owner only, never a viewer. -->
                        <div v-if="webhookUrl(automation) !== undefined" class="flex items-center gap-1.5">
                            <code class="min-w-0 flex-1 truncate font-mono text-2xs text-subtle">{{ webhookUrl(automation) }}</code>
                            <CopyButton
                                :text="webhookUrl(automation) ?? ``"
                                :aria-label="`Copy webhook URL for ${automation.id}`"
                                v-tooltip.top="`Copy URL`"
                            />
                            <Button
                                v-if="!confirmingRotate"
                                label="Rotate"
                                size="small"
                                severity="secondary"
                                :text="true"
                                :disabled="rotateToken.isPending.value"
                                v-tooltip.top="`Mint a new token; the current URL stops working`"
                                @click="confirmingRotate = true"
                            />
                        </div>
                        <p v-else class="text-2xs text-subtle">Its URL is shown to maintainers and the owner.</p>
                        <div v-if="confirmingRotate" class="flex flex-wrap items-center justify-end gap-2">
                            <span class="mr-auto text-2xs text-subtle">Sure? Every sender wired to this URL has to be handed the new one.</span>
                            <Button label="Cancel" size="small" severity="secondary" :text="true" @click="confirmingRotate = false" />
                            <Button label="Rotate token" size="small" severity="danger" :loading="rotateToken.isPending.value" @click="rotate" />
                        </div>
                    </div>

                    <!--
                        The two settings deciding whether the widget works at all. The snippet lives behind Install instead, so there aren't two
                        copies to go stale or disagree.
                    -->
                    <div v-if="frontDesk" class="flex flex-col gap-1.5">
                        <span :class="ui.sectionLabel(`text-2xs`)">Front desk</span>
                        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle">
                            <span v-if="frontDesk.origins.length > 0">on {{ frontDesk.origins.join(`, `) }}</span>
                            <span v-else class="text-danger">no sites allowed: nobody can chat</span>
                            <span>{{ frontDesk.access }}</span>
                            <span>{{ frontDesk.botCheck }}</span>
                        </div>
                        <!--
                            A glyph suffices in the row's own control, one in five rows; the word belongs here, once the reader has opened it to find
                            out what to do.
                        -->
                        <Button
                            size="small"
                            severity="secondary"
                            class="self-start"
                            label="Get the embed code"
                            :aria-label="`Install ${automation.id} on a website`"
                            @click="emit(`install`)"
                        >
                            <template #icon><Icon name="globe" /></template>
                        </Button>
                    </div>

                    <!-- Labelled pairs, not a sentence: the two facts most checked on a misbehaving row shouldn't require parsing the other four. -->
                    <dl class="flex flex-wrap gap-x-5 gap-y-1.5">
                        <div v-for="setting in settings" :key="setting.label" class="flex min-w-0 flex-col">
                            <dt class="text-2xs text-subtle">{{ setting.label }}</dt>
                            <dd class="truncate text-2xs text-muted">{{ setting.value }}</dd>
                        </div>
                    </dl>
                </div>

                <!--
                    Run history, with a way into any run that reached a turn: a button opening its transcript; a guard-skip has none, so it stays
                    plain text.
                -->
                <div class="flex min-w-0 flex-col gap-1">
                    <span :class="ui.sectionLabel(`text-2xs`)">Runs</span>
                    <p v-if="automation.runs.length === 0" class="text-2xs text-subtle">Nothing yet. Run now to try it.</p>
                    <div v-else class="scrollbar-thin -mx-1 flex max-h-40 flex-col overflow-y-auto">
                        <component
                            :is="run.conversationId ? `button` : `div`"
                            v-for="run in automation.runs"
                            :key="run.at"
                            :type="run.conversationId ? `button` : undefined"
                            class="flex items-baseline gap-2 rounded px-1 py-0.5 text-left text-2xs"
                            :class="run.conversationId ? `cursor-pointer hover:bg-content/5` : undefined"
                            :aria-label="run.conversationId ? `Open the transcript of the run from ${formatDateTime(run.at)}` : undefined"
                            @click="openRun(run)"
                        >
                            <span class="w-16 shrink-0 text-subtle" v-tooltip.top="formatDateTime(run.at)">{{ since(run.at) }}</span>
                            <span class="w-12 shrink-0" :class="OUTCOME_CLASS[run.outcome]">{{ OUTCOME_VERB[run.outcome] }}</span>
                            <span v-if="run.detail" class="min-w-0 flex-1 truncate text-subtle" v-tooltip.top="run.detail">{{ run.detail }}</span>
                            <Icon v-if="run.conversationId" name="chevron-right" class="ml-auto shrink-0 text-2xs text-subtle" />
                        </component>
                    </div>
                </div>
            </div>
        </template>
    </DisclosureRow>
</template>
