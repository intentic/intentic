<script setup lang="ts">
import type { AutomationRun, AutomationSummary, AutomationTemplate, Trigger } from "@intentic/sandbox-contract";
import { Button, ui, CopyButton, DisclosureRow, formatDateTime, Icon, Notice, noticeOf, ToggleSwitch, type IconName } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { nextIn, scheduleLabel, since } from "./cronSchedule";
import { host } from "./host";
import { type AvailableSource, listenerSourceOf } from "./catalog";
import AutomationFields from "./AutomationFields.vue";
import RunStrip from "./RunStrip.vue";
import { embedSnippet, useAutomations, webhookUrl } from "./useAutomations";
import { useAutomationForm } from "./useAutomationForm";

/* ONE STANDING JOB, AS TWO LINES: what it is called, and what it does when. Everything longer than that — the
 * whole prompt, the webhook URL, which agent and persona the wake wears, the run ledger, the edit form — is
 * behind the row's own disclosure, because a page that must stay readable at thirty automations is read as a
 * COLUMN OF STATES rather than as thirty paragraphs.
 *
 * IT WAS ONE LINE, AND ONE LINE IS WHY THIS PAGE WAS UNREADABLE. Five runs of text — a 6px dot, the id, a
 * trigger pill, a truncated prompt, two time columns — competed inside 28px at the rail tier's 12px, and the
 * loudest thing on the row was the switch: a CONTROL outranking every FACT beside it. Splitting the line in two
 * is what let each of those become one thing: the name is the name, the second line is the sentence ("Daily
 * 03:00 · audit the dependencies"), and the trailing cluster is history and time and nothing else.
 *
 * THE TRIGGER GLYPH IS ALSO THE HEALTH LIGHT, one mark instead of two. A tinted tile beside the name says what
 * WAKES this row (a clock, a bolt, a live connection, this workspace's own work) at a size the eye lands on
 * while scanning, and it takes the danger tone when the last run failed. The dot it replaces said only the
 * second half, at a sixth of the area, next to a pill saying only the first.
 *
 * NO DENSITY OF ITS OWN. The <RowGroup> above publishes the tier and a group is compact (see <RowGroup>); this
 * row used to override it to `dense`, which is the NAVIGATOR RAIL's tier — a 12px title and 8px of padding, on
 * a full-width page, which is most of why the list read as a wall.
 *
 * Shared by both shelves on the Automations page (chores and integrations) because an enabled chore IS an
 * ordinary automation and must not grow a second presentation that can drift from it. */

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

// What fires this row, in one glyph + one phrase. A workspace trigger names a moment in the fleet's own work
// rather than a clock or an external sender, so it reads as the moment itself.
const TRIGGER_ICON: Record<Trigger[`kind`], IconName> = { schedule: `clock`, event: `bolt`, listener: `wifi`, workspace: `eye` };
const triggerLabel = computed<string>(() => {
    const fires = trigger.value;
    if (fires.kind === `schedule`) {
        return scheduleLabel(fires.cron);
    }
    if (fires.kind === `event`) {
        return `Webhook`;
    }
    if (fires.kind === `workspace`) {
        const when = fires.event === `turn.settled` ? `Turn settles` : `Work lands`;
        return fires.repo !== undefined ? `${when} · ${fires.repo}` : when;
    }
    // A provider with no source entry is a gateway extension this build doesn't know: it reads as its own id
    // rather than as a blank.
    const source = listenerSourceOf(props.listenerSources, fires.provider, fires.eventType).label;
    return [
        // "live" means a gateway is holding a connection open. CI has none: its events arrive by webhook or
        // by poll, so saying it there would be describing a thing that isn't running.
        fires.provider === `ci` ? source : `${source} live`,
        ...(fires.eventType !== undefined ? [fires.eventType] : []),
        // The branch matters enough to earn room in the row: two CI automations differing only by branch are
        // otherwise the same line twice.
        ...(fires.branch !== undefined ? [fires.branch] : []),
        ...(fires.mentioned === true ? [`mentions`] : []),
    ].join(` · `);
});

/* THE TILE'S TONE, and there are deliberately only three of them.
 *
 * `failed` is the one thing on this page that has to interrupt a scan, so it is the only tone that carries a
 * hue. "Enabled and fine" gets no colour at all: painting it success would put a green wall down a page whose
 * normal state is that everything is fine, and a wall says nothing. Off is the same tile a step quieter, which
 * is the same thing the dimmed name beside it and the switch at the end of the row are already saying.
 *
 * A guard that SKIPPED is not a dent and never was: it checked, found nothing, cost nothing, and that is the
 * designed outcome of a chore. Neither is `interrupted` — the sandbox went away under the wake. */
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
    // Not "failed": the run never reached an outcome of its own, the sandbox restarted under it.
    interrupted: `cut off`,
};
const OUTCOME_CLASS: Record<AutomationRun[`outcome`], string> = {
    completed: `text-muted`,
    error: `text-danger`,
    skipped: `text-subtle`,
    interrupted: `text-subtle`,
};
const runTooltip = (run: AutomationRun): string => `${formatDateTime(run.at)}${run.detail !== undefined ? `, ${run.detail}` : ``}`;

// A run's transcript, on the host's one chat surface. Runs that reached a turn carry the stable conversation;
// a guard-skip never needed one.
const openRun = (run: AutomationRun): void => {
    if (run.conversationId !== undefined) {
        host().chat.openSession(run.conversationId);
    }
};

const nextLabel = computed<string | undefined>(() => (props.automation.nextRun !== undefined ? nextIn(props.automation.nextRun) : undefined));

/* EDITING, in the row rather than in a dialog.
 *
 * The form is loaded from the stored automation when Edit is pressed and thrown away on Cancel, so the row is
 * never quietly holding a half-typed version of something the list is showing as saved. There is no
 * save-as-you-type here, unlike the acceptance rows this borrows its shape from: a story is a document, while
 * an automation EXECUTES: a Front Desk with half an origin typed into it would start turning visitors away
 * between keystrokes. */
const editing = ref(false);
const editError = ref<string | undefined>(undefined);
const editForm = useAutomationForm(
    computed(() => props.listenerSources),
    computed(() => props.templates),
);
const { save } = useAutomations();
const saving = computed(() => save.isPending.value);

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

/* The Front Desk summary the expanded row shows: the snippet to paste, and the two settings that decide whether
 * it works at all. Undefined for every other automation, which is what keeps the block out of their rows.
 * Undefined until the sandbox's own origin is known, because without it there is no snippet to install and
 * the Install action would open a panel with nothing in it. */
const frontDesk = computed(() => {
    const fires = props.automation.trigger;
    if (fires.kind !== `listener` || fires.provider !== `webchat` || embedSnippet(props.automation) === undefined) {
        return undefined;
    }
    const config = props.automation.webchat ?? {};
    // Mirrors the daemon's own resolution (webchat-config.ts): a mechanism whose keys are missing is reported
    // as off, because that is what will actually be enforced: the row must not claim a check nobody runs.
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

/* WHAT THE WAKE RUNS ON AND AS, as labelled facts rather than as one run-on sentence. They were
 * "wakes claude · claude-sonnet-5 on the native harness holds for approval", which is four settings printed
 * as prose in a place a reader is scanning for one of them. */
const runsOn = computed<string>(() => {
    // A blank model is the DEFAULT, not a gap: the provider resolves its own at wake time, which is what keeps
    // a year-old automation running after a model is retired. So the row names the provider and stops.
    const provider = props.automation.agent ?? `claude`;
    return props.automation.model === undefined ? provider : `${provider} · ${props.automation.model}`;
});
const settings = computed<readonly { label: string; value: string }[]>(() => [
    { label: `Runs on`, value: runsOn.value },
    ...(props.automation.harness !== undefined ? [{ label: `Harness`, value: props.automation.harness }] : []),
    ...(props.automation.actsAs !== undefined ? [{ label: `Runs as`, value: props.automation.actsAs }] : []),
    ...(props.automation.requireApproval === true ? [{ label: `Approval`, value: `held for you` }] : []),
    ...(props.automation.holdForSeconds !== undefined && props.automation.holdForSeconds > 0
        ? [{ label: `Hold`, value: `${props.automation.holdForSeconds}s before each run` }]
        : []),
]);

// The three hover-revealed verbs share one recipe: the kit's icon button, plus the reveal. Hand-written before,
// which meant no hit-area growth on a touch pointer and no disabled tone — both of which `ui.iconButton` owns.
const VERB = ui.iconButton(`md:opacity-0 md:group-hover/row:opacity-100 md:focus-visible:opacity-100`);
</script>

<template>
    <!-- A @container, so the columns below thin out against THIS ROW rather than against the window. They were on
         viewport breakpoints, which are a fair guess only for a page that owns the screen: with the chat panel
         open the list gets ~350px, `sm:` and `lg:` both still read as true, and the last-run column, the next-run
         column and the whole prompt were laid on top of the automation's own name. -->
    <!-- `body="drawer"`: what opens is the automation's prose and its edit form, a place of its own rather than
         a fact hanging off its id. -->
    <DisclosureRow class="group/row @container" body="drawer" :open="expanded" @update:open="emit(`expand`)">
        <!-- THE ROW'S ONE MARK: what wakes it, tinted by whether it is well. Sized from the tier the group
             publishes rather than from a number typed here, which is what the slot prop is for. -->
        <template #lead="{ mark }">
            <span
                class="flex shrink-0 items-center justify-center rounded-md"
                :class="TILE[health]"
                :style="{ width: `${mark}px`, height: `${mark}px` }"
            >
                <Icon :name="TRIGGER_ICON[trigger.kind]" class="text-xs" />
            </span>
        </template>

        <template #title>
            <span class="flex min-w-0 items-center gap-1.5">
                <span class="truncate" :class="automation.enabled ? `text-content` : `text-subtle`">{{ automation.id }}</span>
                <!-- Chores carry their own check (knip clean, no advisories, duplication under the floor) and
                     wake only when it finds something. There is no longer a field for one: the icon says the
                     row behaves that way, which is what explains its "skipped" runs; the command itself was a
                     line of shell in a list of automations, read by nobody. -->
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

        <!-- THE SENTENCE: when it fires, then what it is for. The prompt used to ride the title line, where it
             competed with the name for the same pixels and was the first thing cut; on its own line it is the
             one place in the list that says what an automation is actually FOR, which is what a reader coming
             back to a page of ids they wrote months ago is looking for. -->
        <template #description>
            <span class="flex min-w-0 items-baseline gap-1.5">
                <span class="shrink-0">{{ triggerLabel }}</span>
                <!-- A HAIRLINE, NOT A MIDDLE DOT. The two halves have to be parted — the trigger is a phrase and
                     the prompt is a sentence, and at 10px in two neighbouring greys they read as one broken
                     clause — but the trigger phrase is ITSELF dot-separated ("Discord live · message ·
                     mentions"), so a fourth dot joins the list it was meant to end.
                     aria-hidden so the disclosure's accessible name stays "<id> <trigger>" rather than a whole
                     truncated prompt: the full text is one expand away, unabridged. -->
                <span class="hidden min-w-0 flex-1 items-center gap-2 truncate text-subtle @xl:flex" aria-hidden="true">
                    <span class="h-2.5 w-px shrink-0 bg-line-strong"></span>
                    <span class="min-w-0 truncate">{{ automation.prompt }}</span>
                </span>
            </span>
        </template>

        <!-- Facts, not verbs: the cluster a reader scans DOWN the list. History first (how it has been going),
             then the two clocks. -->
        <template #meta>
            <!-- The box the strip is right-aligned in. `w-14` is the eight-mark width plus air: the strip draws
                 no width of its own so that a row with two runs and a row with eight put their newest mark in
                 the same column. See <RunStrip>. -->
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

            <!-- The em dash is doing real work: without it this column empties on every trigger that has no
                 clock, and an empty cell next to a full one reads as a missing value rather than as "there is
                 no next time, it fires when something happens". -->
            <span
                class="hidden w-12 shrink-0 truncate text-right @xl:block"
                :class="nextLabel === undefined ? `text-subtle/50` : ``"
                v-tooltip.top="automation.nextRun !== undefined ? `Next: ${formatDateTime(automation.nextRun)}` : `Fires on its trigger, not a clock`"
            >
                {{ nextLabel ?? `—` }}
            </span>
        </template>

        <template #control>
            <!-- EVERY ROW'S CLUSTER IS THE SAME WIDTH, and that is the whole reason the two conditional verbs
                 sit in reserved boxes rather than simply being absent.
                 The trailing cluster is laid out from the RIGHT, so a row missing the Install button and a row
                 missing Run pushed their history strip and their two time columns to three different x
                 positions down one list — and columns that do not line up are columns nobody reads. An empty
                 24px box costs one glyph of width and buys the alignment back. -->

            <!-- A Front Desk's snippet is the DELIVERABLE: the one thing the owner came here to get, so unlike
                 Edit, Run and Delete it is always visible rather than hover-revealed. It also carries the
                 install status, which is the only place in the app that can say whether the paste worked. -->
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

            <!-- THE VERBS, THEN THE STATE. All three are hover-revealed because reading the list is the common
                 act, and they are grouped BEFORE the switch so the one control that is always drawn sits at a
                 fixed right edge: a switch with verbs appearing on both sides of it is a switch that looks like
                 it moved. On a touch pointer, where there is no hover, they simply stay. -->
            <button type="button" :class="VERB" :aria-label="`Edit ${automation.id}`" v-tooltip.top="`Edit`" @click="startEdit">
                <Icon name="pencil" class="text-xs" />
            </button>

            <!-- Fire it now. The reason this exists at all: a 3 a.m. cron or a webhook you would have to forge:
                 neither testable by waiting. It works on a disabled row too: trying the prompt before switching
                 it on is the point.

                 A chat listener has no button, because a by-hand fire carries no message: it could only ever
                 wake an agent that asks where the events went, and it would hold the automation's turn against
                 the real mention arriving behind it. Testing one means sending the bot a message, which is the
                 whole path anyway. -->
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

            <!-- Destructive and rarely wanted, so it stays out of the scan on a pointer device and stays put on
                 a touch one, where there is no hover to reveal it. -->
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
            <!-- EDITING HAPPENS HERE, not in a dialog. Same argument the acceptance rows make: a modal hides the
                 list you are comparing against, and at 32rem it turned a form with a Front Desk's worth of fields
                 into a column you scrolled twice. The row has the whole page width and the automation's own
                 history under it. -->
            <div v-if="editing" class="flex flex-col gap-3 pr-3">
                <Notice v-if="editError" :of="noticeOf(editError)" />
                <AutomationFields :state="editForm" :name-locked="true" />
                <!-- The same footer the composer draws, at the same size: this is a form's submit standing in a
                     panel, not a verb in a row's control cluster, and the two must not disagree about that
                     because a reader meets them one click apart. -->
                <div class="flex items-center justify-end gap-2 border-t border-line-subtle pt-3">
                    <Button label="Cancel" severity="secondary" :text="true" @click="cancelEdit" />
                    <Button label="Save" :loading="saving" @click="saveEdit">
                        <template #icon><Icon name="check" /></template>
                    </Button>
                </div>
            </div>

            <!-- TWO COLUMNS, BECAUSE THEY ANSWER TWO QUESTIONS: what this thing is (its prompt, its address, what
                 it runs as) and what it has done (its ledger). Stacked, the ledger was always below the fold of
                 a long prompt — so the one question an opened row is most often opened for ("it failed at 3am
                 and I can't see why") was answered last. They stack again under 3xl, where two columns of 2xs
                 text is two columns of nothing. -->
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
                        <div class="flex items-center gap-1.5">
                            <code class="min-w-0 flex-1 truncate font-mono text-2xs text-subtle">{{ webhookUrl(automation) }}</code>
                            <CopyButton
                                :text="webhookUrl(automation) ?? ``"
                                :aria-label="`Copy webhook URL for ${automation.id}`"
                                v-tooltip.top="`Copy URL`"
                            />
                        </div>
                    </div>

                    <!-- A Front Desk's two settings that decide whether the widget works at all: which sites may
                         load it, and who it lets in. The snippet itself lives behind Install above rather than
                         being repeated here: two copies of the one string the owner acts on is two places for it
                         to be stale or to disagree. -->
                    <div v-if="frontDesk" class="flex flex-col gap-1.5">
                        <span :class="ui.sectionLabel(`text-2xs`)">Front desk</span>
                        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle">
                            <span v-if="frontDesk.origins.length > 0">on {{ frontDesk.origins.join(`, `) }}</span>
                            <span v-else class="text-danger">no sites allowed: nobody can chat</span>
                            <span>{{ frontDesk.access }}</span>
                            <span>{{ frontDesk.botCheck }}</span>
                        </div>
                        <!-- The row's own globe is a glyph, which is the right size for a control that appears on
                             one row in five; the WORD belongs here, where a reader has opened the automation to
                             find out what to do with it. Same press, and the panel behind it is the only place
                             in the app that can say whether the paste worked. -->
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

                    <!-- LABELLED PAIRS, not a sentence. Which model pays for the wake and which persona it wears
                         are the two facts most often checked on a row that misbehaved, and a reader looking for
                         one of them should not have to parse the other four. -->
                    <dl class="flex flex-wrap gap-x-5 gap-y-1.5">
                        <div v-for="setting in settings" :key="setting.label" class="flex min-w-0 flex-col">
                            <dt class="text-2xs text-subtle">{{ setting.label }}</dt>
                            <dd class="truncate text-2xs text-muted">{{ setting.value }}</dd>
                        </div>
                    </dl>
                </div>

                <!-- The run history, and, where the run reached a turn: a way INTO it. "It failed at 3am and I
                     can't see why" is answered by a transcript, so a run with a conversation is a button that
                     opens one; a guard-skip has nothing behind it and stays plain text. -->
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
