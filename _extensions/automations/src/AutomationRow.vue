<script setup lang="ts">
import type { AutomationRun, AutomationSummary, Trigger } from "@intentic/sandbox-contract";
import { Button, cmp, CopyButton, Icon, type IconName, ToggleSwitch } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { formatAt, nextIn, scheduleLabel, since } from "./cronSchedule";
import { host } from "./host";
import { LISTENER_SOURCES } from "./listenerSources";
import AutomationFields from "./AutomationFields.vue";
import { embedSnippet, useAutomations, webhookUrl } from "./useAutomations";
import { useAutomationForm } from "./useAutomationForm";

/* One automation as ONE line: a health dot, its name, what fires it, when it last ran, when it fires next, and
 * the switch. Everything that is prose rather than state — the prompt, the guard, which agent and model the
 * wake runs on, the webhook URL, the run history — sits behind the row's own disclosure, because a page that
 * must still be readable at thirty automations is read as a COLUMN OF STATES, not as thirty paragraphs. The
 * two time columns are fixed-width and right-aligned for the same reason: they only scan if they line up.
 *
 * Shared by both shelves on the Automations page (chores and integrations) because an enabled chore IS an
 * ordinary automation and must not grow a second presentation that can drift from it. */

const props = defineProps<{ automation: AutomationSummary; expanded: boolean; busy?: boolean }>();
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
    // A provider with no source entry is a gateway extension this build doesn't know — it reads as its own id
    // rather than as a blank.
    const source = LISTENER_SOURCES[fires.provider as keyof typeof LISTENER_SOURCES]?.label ?? fires.provider;
    return [
        // "live" means a gateway is holding a connection open. CI has none — its events arrive by webhook or
        // by poll — so saying it there would be describing a thing that isn't running.
        fires.provider === `ci` ? source : `${source} live`,
        ...(fires.eventType !== undefined ? [fires.eventType] : []),
        // The branch matters enough to earn room in the row: two CI automations differing only by branch are
        // otherwise the same line twice.
        ...(fires.branch !== undefined ? [fires.branch] : []),
        ...(fires.mentioned === true ? [`mentions`] : []),
    ].join(` · `);
});

/* The dot: one mark carrying "is it on" and "did the last run go wrong". `idle` covers never-run AND
 * all-skipped, because a guard that skipped is the DESIGNED outcome of a tool-driven chore — it checked, found
 * nothing, and cost nothing — and must never wear a warning colour for doing its job. An `interrupted` run is
 * `idle` for the same reason inverted: nothing went wrong with the automation, the sandbox went away under it. */
type Health = `off` | `ok` | `failed` | `idle`;
const DOT: Record<Health, string> = {
    ok: `bg-success`,
    failed: `bg-danger`,
    idle: `bg-subtle/50`,
    off: `ring-1 ring-inset ring-line-strong`,
};
const health = computed<Health>(() => {
    if (!props.automation.enabled) {
        return `off`;
    }
    const outcome = lastRun.value?.outcome;
    return outcome === `error` ? `failed` : outcome === `completed` ? `ok` : `idle`;
});

const OUTCOME_VERB: Record<AutomationRun[`outcome`], string> = {
    completed: `ran`,
    error: `failed`,
    skipped: `skipped`,
    // Not "failed": the run never reached an outcome of its own — the sandbox restarted under it.
    interrupted: `cut off`,
};
const OUTCOME_CLASS: Record<AutomationRun[`outcome`], string> = {
    completed: `text-muted`,
    error: `text-danger`,
    skipped: `text-subtle`,
    interrupted: `text-subtle`,
};
const runTooltip = (run: AutomationRun): string => `${formatAt(run.at)}${run.detail !== undefined ? ` — ${run.detail}` : ``}`;

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
 * an automation EXECUTES — a Doorbell with half an origin typed into it would start turning visitors away
 * between keystrokes. */
const editing = ref(false);
const editError = ref<string | undefined>(undefined);
const editForm = useAutomationForm();
const { save } = useAutomations();
const saving = computed(() => save.isPending.value);

const startEdit = (): void => {
    editForm.load(props.automation);
    editError.value = undefined;
    editing.value = true;
    // Editing implies reading what you are editing — a collapsed row would hide the form entirely.
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

/* The Doorbell summary the expanded row shows: the snippet to paste, and the two settings that decide whether
 * it works at all. Undefined for every other automation, which is what keeps the block out of their rows.
 * Undefined until the sandbox's own origin is known, because without it there is no snippet to install and
 * the Install action would open a panel with nothing in it. */
const doorbell = computed(() => {
    const fires = props.automation.trigger;
    if (fires.kind !== `listener` || fires.provider !== `webchat` || embedSnippet(props.automation) === undefined) {
        return undefined;
    }
    const config = props.automation.webchat ?? {};
    // Mirrors the daemon's own resolution (webchat-config.ts): a mechanism whose keys are missing is reported
    // as off, because that is what will actually be enforced — the row must not claim a check nobody runs.
    const turnstileReady = config.turnstileSiteKey !== undefined && config.turnstileSecret !== undefined;
    return {
        origins: fires.allowedOrigins ?? [],
        access: config.access === `google` ? `Google sign-in required` : `open to anyone`,
        botCheck:
            config.antiBot === `turnstile` && turnstileReady
                ? `Turnstile`
                : config.antiBot === `turnstile`
                  ? `Turnstile not finished — no bot check`
                  : config.antiBot === `pow`
                    ? `built-in bot check`
                    : `no bot check`,
    };
});
</script>

<template>
    <div class="group/row">
        <div class="flex items-center gap-2 px-2.5 py-1.5 transition-colors hover:bg-content/5">
            <button
                type="button"
                class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                :aria-expanded="expanded"
                @click="emit(`expand`)"
            >
                <Icon :name="expanded ? `chevron-down` : `chevron-right`" class="shrink-0 text-2xs text-subtle" />
                <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="DOT[health]"></span>
                <span class="truncate text-xs font-medium" :class="automation.enabled ? `text-content` : `text-subtle`">{{ automation.id }}</span>
                <span class="inline-flex shrink-0 items-center gap-1 rounded bg-overlay px-1.5 py-0.5 text-2xs text-muted">
                    <Icon :name="TRIGGER_ICON[trigger.kind]" class="text-2xs" />
                    {{ triggerLabel }}
                </span>
                <Icon v-if="automation.guard" name="shield" v-tooltip.top="`Guarded — a check runs first`" class="shrink-0 text-2xs text-subtle" />
                <Icon
                    v-if="automation.requireApproval"
                    name="lock"
                    v-tooltip.top="`Held for your approval before it runs`"
                    class="shrink-0 text-2xs text-subtle"
                />
                <!-- What it says, in the width the row has spare: the name answers "which one", this answers
                     "and what does it do" without costing a second line. First thing to go as the page narrows.
                     aria-hidden so the disclosure's accessible name stays "<id> <trigger>" rather than a whole
                     truncated prompt — the full text is one expand away, unabridged. -->
                <span class="hidden min-w-0 flex-1 truncate text-2xs text-subtle lg:block" aria-hidden="true">{{ automation.prompt }}</span>
            </button>

            <span
                v-if="lastRun"
                class="hidden w-24 shrink-0 truncate text-right text-2xs sm:block"
                :class="OUTCOME_CLASS[lastRun.outcome]"
                v-tooltip.top="runTooltip(lastRun)"
            >
                {{ OUTCOME_VERB[lastRun.outcome] }} {{ since(lastRun.at) }}
            </span>
            <span v-else class="hidden w-24 shrink-0 text-right text-2xs text-subtle sm:block">never run</span>

            <span
                class="hidden w-12 shrink-0 truncate text-right text-2xs text-subtle sm:block"
                v-tooltip.top="automation.nextRun !== undefined ? `Next: ${formatAt(automation.nextRun)}` : undefined"
            >
                {{ nextLabel }}
            </span>

            <!-- A Doorbell's snippet is the DELIVERABLE — the one thing the owner came here to get — so unlike
                 Run and Delete it is always visible rather than hover-revealed, and it sits before them because
                 installing is what you do first and most often. It also carries the install status, which is
                 the only place in the app that can say whether the paste worked. -->
            <button
                v-if="doorbell"
                type="button"
                class="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-2xs font-medium text-muted transition-colors hover:bg-overlay hover:text-content"
                :aria-label="`Install ${automation.id} on a website`"
                v-tooltip.top="`Embed code & install status`"
                @click="emit(`install`)"
            >
                <Icon name="globe" class="mr-1 text-2xs" />Install
            </button>

            <!-- Edit. Hover-revealed like Run and Delete because reading the list is the common act, but it is
                 the one that was missing entirely: an automation could be made and deleted, never changed. -->
            <button
                type="button"
                class="shrink-0 cursor-pointer text-muted transition-colors hover:text-content md:opacity-0 md:group-hover/row:opacity-100 md:focus-visible:opacity-100"
                :aria-label="`Edit ${automation.id}`"
                v-tooltip.top="`Edit`"
                @click="startEdit"
            >
                <Icon name="pencil" class="text-xs" />
            </button>

            <!-- Fire it now. The reason this exists at all: a 3 a.m. cron, a webhook you would have to forge, a
                 Discord mention you would have to provoke — none of them testable by waiting. Hover-revealed
                 beside Delete, because it is an occasional act, not part of reading the column of states. It
                 works on a disabled row too: trying the prompt before switching it on is the point. -->
            <button
                type="button"
                class="shrink-0 cursor-pointer text-muted transition-colors hover:text-content md:opacity-0 md:group-hover/row:opacity-100 md:focus-visible:opacity-100"
                :disabled="busy"
                :aria-label="`Run ${automation.id} now`"
                v-tooltip.top="`Run now`"
                @click="emit(`run`)"
            >
                <Icon name="play" class="text-xs" />
            </button>

            <ToggleSwitch
                :model-value="automation.enabled"
                :disabled="busy"
                :aria-label="`Enable ${automation.id}`"
                @update:model-value="emit(`toggle`, $event)"
            />

            <!-- Destructive and rarely wanted, so it stays out of the scan on a pointer device and stays put on
                 a touch one, where there is no hover to reveal it. -->
            <button
                type="button"
                class="shrink-0 cursor-pointer text-muted transition-colors hover:text-danger md:opacity-0 md:group-hover/row:opacity-100 md:focus-visible:opacity-100"
                :aria-label="`Delete ${automation.id}`"
                v-tooltip.top="`Delete`"
                @click="emit(`remove`)"
            >
                <Icon name="trash" class="text-xs" />
            </button>
        </div>

        <!-- The prose half, on demand: what this automation actually says and does, then what it has done. -->
        <div v-if="expanded" class="flex flex-col gap-2.5 border-t border-line bg-canvas/40 px-3 py-2.5 pl-8">
            <!-- EDITING HAPPENS HERE, not in a dialog. Same argument the acceptance rows make: a modal hides the
                 list you are comparing against, and at 32rem it turned a form with a Doorbell's worth of fields
                 into a column you scrolled twice. The row has the whole page width and the automation's own
                 history under it. -->
            <div v-if="editing" class="flex flex-col gap-3 pr-3">
                <div v-if="editError" :class="cmp.alertDanger()">{{ editError }}</div>
                <AutomationFields :state="editForm" :name-locked="true" />
                <div class="flex items-center justify-end gap-2 border-t border-line pt-2.5">
                    <Button label="Cancel" severity="secondary" :text="true" @click="cancelEdit" />
                    <Button label="Save" :loading="saving" @click="saveEdit">
                        <template #icon><Icon name="check" /></template>
                    </Button>
                </div>
            </div>

            <template v-else>
                <p class="scrollbar-thin max-h-32 overflow-auto text-2xs leading-relaxed whitespace-pre-wrap text-muted">{{ automation.prompt }}</p>

                <div v-if="automation.guard" class="flex items-start gap-1.5">
                    <Icon name="shield" class="mt-0.5 shrink-0 text-2xs text-subtle" />
                    <code class="line-clamp-2 min-w-0 font-mono text-2xs break-all text-subtle" :title="automation.guard">{{
                        automation.guard
                    }}</code>
                </div>

                <div v-if="trigger.kind === `event`" class="flex items-center gap-1.5">
                    <Icon name="link" class="shrink-0 text-2xs text-subtle" />
                    <code class="min-w-0 flex-1 truncate font-mono text-2xs text-subtle">{{ webhookUrl(automation) }}</code>
                    <CopyButton
                        :text="webhookUrl(automation) ?? ``"
                        :aria-label="`Copy webhook URL for ${automation.id}`"
                        v-tooltip.top="`Copy URL`"
                    />
                </div>

                <!-- A Doorbell's embed snippet, where the owner will actually look for it: on the row, months after
                 the create dialog that first showed it. Beside it, the two things that decide whether the widget
                 works at all — which sites may load it, and who it lets in. -->
                <!-- State only. The snippet itself lives behind Install above rather than being repeated here: two
                 copies of the one string the owner acts on is two places for it to be stale or disagree. -->
                <div v-if="doorbell" class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle">
                    <span v-if="doorbell.origins.length > 0">on {{ doorbell.origins.join(`, `) }}</span>
                    <span v-else class="text-danger">no sites allowed — nobody can chat</span>
                    <span>{{ doorbell.access }}</span>
                    <span>{{ doorbell.botCheck }}</span>
                </div>

                <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle">
                    <span>wakes {{ automation.agent ?? `claude` }}{{ automation.model ? ` · ${automation.model}` : `` }}</span>
                    <span v-if="automation.harness">on the {{ automation.harness }} harness</span>
                    <span v-if="automation.requireApproval">holds for approval</span>
                </div>

                <!-- The run history, and — where the run reached a turn — a way INTO it. "It failed at 3am and I
                 can't see why" is answered by a transcript, so a run with a conversation is a button that opens
                 one; a guard-skip has nothing behind it and stays plain text. -->
                <div class="flex flex-col gap-1 border-t border-line pt-2">
                    <p v-if="automation.runs.length === 0" class="text-2xs text-subtle">No runs yet.</p>
                    <component
                        :is="run.conversationId ? `button` : `div`"
                        v-for="run in automation.runs"
                        :key="run.at"
                        :type="run.conversationId ? `button` : undefined"
                        class="flex items-baseline gap-2 rounded text-left text-2xs"
                        :class="run.conversationId ? `cursor-pointer hover:bg-content/5` : undefined"
                        :aria-label="run.conversationId ? `Open the transcript of the run from ${formatAt(run.at)}` : undefined"
                        @click="openRun(run)"
                    >
                        <span class="w-20 shrink-0 text-subtle" v-tooltip.top="formatAt(run.at)">{{ since(run.at) }}</span>
                        <span class="w-14 shrink-0" :class="OUTCOME_CLASS[run.outcome]">{{ OUTCOME_VERB[run.outcome] }}</span>
                        <span v-if="run.detail" class="min-w-0 truncate text-subtle" v-tooltip.top="run.detail">{{ run.detail }}</span>
                        <Icon v-if="run.conversationId" name="chevron-right" class="shrink-0 text-2xs text-subtle" />
                    </component>
                </div>
            </template>
        </div>
    </div>
</template>
