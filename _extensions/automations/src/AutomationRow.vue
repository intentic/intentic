<script setup lang="ts">
import type { AutomationRun, AutomationSummary, Trigger } from "@intentic/sandbox-contract";
import { CopyButton, Icon, type IconName, ToggleSwitch } from "@intentic/extension-ui";
import { computed } from "vue";
import { formatAt, nextIn, scheduleLabel, since } from "./cronSchedule";
import { LISTENER_SOURCES } from "./listenerSources";
import { webhookUrl } from "./useAutomations";

/* One automation as ONE line: a health dot, its name, what fires it, when it last ran, when it fires next, and
 * the switch. Everything that is prose rather than state — the prompt, the guard, which agent and model the
 * wake runs on, the webhook URL, the run history — sits behind the row's own disclosure, because a page that
 * must still be readable at thirty automations is read as a COLUMN OF STATES, not as thirty paragraphs. The
 * two time columns are fixed-width and right-aligned for the same reason: they only scan if they line up.
 *
 * Shared by both shelves on the Automations page (chores and integrations) because an enabled chore IS an
 * ordinary automation and must not grow a second presentation that can drift from it. */

const props = defineProps<{ automation: AutomationSummary; expanded: boolean; busy?: boolean }>();
const emit = defineEmits<{ toggle: [enabled: boolean]; remove: []; expand: [] }>();

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
    return `${source} live${fires.eventType !== undefined ? ` · ${fires.eventType}` : ``}${fires.mentioned === true ? ` · mentions` : ``}`;
});

/* The dot: one mark carrying "is it on" and "did the last run go wrong". `idle` covers never-run AND
 * all-skipped, because a guard that skipped is the DESIGNED outcome of a tool-driven chore — it checked, found
 * nothing, and cost nothing — and must never wear a warning colour for doing its job. */
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

const OUTCOME_VERB: Record<AutomationRun[`outcome`], string> = { completed: `ran`, error: `failed`, skipped: `skipped` };
const OUTCOME_CLASS: Record<AutomationRun[`outcome`], string> = { completed: `text-muted`, error: `text-danger`, skipped: `text-subtle` };
const runTooltip = (run: AutomationRun): string => `${formatAt(run.at)}${run.detail !== undefined ? ` — ${run.detail}` : ``}`;

const nextLabel = computed<string | undefined>(() => (props.automation.nextRun !== undefined ? nextIn(props.automation.nextRun) : undefined));
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
            <p class="scrollbar-thin max-h-32 overflow-auto text-2xs leading-relaxed whitespace-pre-wrap text-muted">{{ automation.prompt }}</p>

            <div v-if="automation.guard" class="flex items-start gap-1.5">
                <Icon name="shield" class="mt-0.5 shrink-0 text-2xs text-subtle" />
                <code class="line-clamp-2 min-w-0 font-mono text-2xs break-all text-subtle" :title="automation.guard">{{ automation.guard }}</code>
            </div>

            <div v-if="trigger.kind === `event`" class="flex items-center gap-1.5">
                <Icon name="link" class="shrink-0 text-2xs text-subtle" />
                <code class="min-w-0 flex-1 truncate font-mono text-2xs text-subtle">{{ webhookUrl(automation) }}</code>
                <CopyButton :text="webhookUrl(automation) ?? ``" :aria-label="`Copy webhook URL for ${automation.id}`" v-tooltip.top="`Copy URL`" />
            </div>

            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle">
                <span>wakes {{ automation.agent ?? `claude` }}{{ automation.model ? ` · ${automation.model}` : `` }}</span>
                <span v-if="automation.harness">on the {{ automation.harness }} harness</span>
                <span v-if="automation.requireApproval">holds for approval</span>
            </div>

            <div class="flex flex-col gap-1 border-t border-line pt-2">
                <p v-if="automation.runs.length === 0" class="text-2xs text-subtle">No runs yet.</p>
                <div v-for="run in automation.runs" :key="run.at" class="flex items-baseline gap-2 text-2xs">
                    <span class="w-20 shrink-0 text-subtle" v-tooltip.top="formatAt(run.at)">{{ since(run.at) }}</span>
                    <span class="w-14 shrink-0" :class="OUTCOME_CLASS[run.outcome]">{{ run.outcome === `skipped` ? `skipped` : run.outcome }}</span>
                    <span v-if="run.detail" class="min-w-0 truncate text-subtle" v-tooltip.top="run.detail">{{ run.detail }}</span>
                </div>
            </div>
        </div>
    </div>
</template>
