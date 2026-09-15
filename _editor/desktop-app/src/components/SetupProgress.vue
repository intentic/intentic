<script setup lang="ts">
import { Notice } from "@intentic/ui";
import { computed, nextTick, ref, watch } from "vue";
import type { RunEvent } from "../desktop";
import type { ProgressView, StepView } from "../setupPlan";

// Shows the full plan up front (setupPlan.ts), the current step's own detail, and a bar weighted by each step's
// typical duration rather than step count. The log stays collapsed but opens itself on failure.
//
// ONE PRIMARY OBJECT PER SCREEN: with a requirements card or a failure above it, the plan folds to its own first
// line; `stepsOpen` is the reader overriding that in either direction for the rest of the run.

// `awaiting` is a deliberate stop for the requirements card above; this component just must not call it a crash.
// `blocked`: that card is on screen, so this one is not the thing to read.
const props = defineProps<{ events: RunEvent[]; view: ProgressView; running: boolean; awaiting?: boolean; blocked?: boolean }>();

// Owned by the card's own action bar (App.vue), which holds every other verb about this transcript.
const open = defineModel<boolean>(`open`, { default: false });
const stepsOpen = ref<boolean | undefined>(undefined);
const logEnd = ref<HTMLElement | undefined>(undefined);

const lines = computed(() => props.events.flatMap((event) => (event.kind === `line` ? [event] : [])));
const exit = computed(() => props.events.find((event) => event.kind === `exit`));
const stoppedShort = computed(() => exit.value?.kind === `exit` && !exit.value.ok);
// A non-zero exit isn't automatically a failure: a Windows install's first pass exits non-zero by design (it
// reports what it would change and stops), which App.vue also accounts for. Nor is one with a requirements card
// above it explaining what to do: that card is the message, and a red bar and a log under it would be this
// screen calling its own instructions a crash.
const failed = computed(() => !props.awaiting && props.blocked !== true && stoppedShort.value);
// The run is parked on something the reader has to answer, whether the script asked (`awaiting`) or stopped on a
// requirement the card above holds.
const parked = computed(() => props.awaiting === true || (props.blocked === true && stoppedShort.value));
// The percentage and the estimate are shown only while the run is the thing that is moving.
const live = computed(() => props.running && !props.awaiting);

const compact = computed(() => props.blocked === true || props.awaiting === true || failed.value);
const listShown = computed(() => stepsOpen.value ?? !compact.value);

// The step the run is in: the running one, or — once it has stopped — the first one it never finished.
const at = computed(() => props.view.steps.find((step) => step.state === `running`) ?? props.view.steps.find((step) => step.state !== `done`));
// Nothing has reported yet: the first step is next, not under way.
const started = computed(() => props.view.steps.some((step) => step.state !== `waiting`));
// Survives a stop, unlike `view.position`, which is the wire report's and goes quiet the moment a run ends.
const positionOf = (step: StepView): string => `Step ${props.view.steps.indexOf(step) + 1} of ${props.view.steps.length}`;
const position = computed(() => (at.value === undefined ? undefined : positionOf(at.value)));
const heading = computed(() => {
    const step = at.value;
    if (parked.value) {
        return `Waiting for you`;
    }
    if (failed.value) {
        return step === undefined ? `Stopped` : `Stopped at ${step.label}`;
    }
    if (step === undefined) {
        return `Done`;
    }
    if (!started.value) {
        return `Starting…`;
    }
    // With the plan on screen its own running row says which step this is; without it, this line has to.
    return listShown.value ? positionOf(step) : step.label;
});
// Never the same fact twice in one row.
const beside = computed(() => (!started.value || position.value === heading.value ? undefined : position.value));

// Filters PowerShell's error-record furniture (source excerpt, CategoryInfo, FullyQualifiedErrorId) so a "last N
// lines of stderr" rule shows the actual message, not boilerplate.
const isPowerShellDecoration = (text: string): boolean => /^\s*\+ /.test(text) || /^At .+:\d+ char:\d+$/.test(text);

// Shows only the failure's own words: what went wrong, not where (the heading covers that). The `error:` a CLI
// prints for a terminal is dropped: on this screen the red border already says it, and the sentence after it is
// written for a person.
const failure = computed(() =>
    lines.value
        .filter((line) => line.stream === `stderr` && line.text.trim() !== `` && !isPowerShellDecoration(line.text))
        .slice(-4)
        .map((line) => line.text.replace(/^\s*error:\s+/i, ``))
        .join(`\n`),
);

// immediate: a card mounting on an already-failed run opens the log too, not just future failures.
watch(
    failed,
    (value) => {
        if (value) {
            open.value = true;
        }
    },
    { immediate: true },
);
watch(
    () => lines.value.length,
    async () => {
        if (!open.value) {
            return;
        }
        await nextTick();
        logEnd.value?.scrollIntoView({ block: `end` });
    },
);
</script>

<template>
    <div class="flex flex-col gap-2">
        <!-- One line for all three questions: what is happening, how far in, how long left. -->
        <div class="flex items-baseline gap-2 text-2xs">
            <span class="min-w-0 flex-1 truncate font-medium text-content">{{ heading }}</span>
            <span v-if="beside" class="shrink-0 text-subtle">{{ beside }}</span>
            <span v-if="live && view.remaining" class="shrink-0 text-subtle">{{ view.remaining }}</span>
            <span v-if="live" class="shrink-0 font-mono tabular-nums text-muted">{{ view.percent }}%</span>
        </div>
        <div class="h-1.5 overflow-hidden rounded-full bg-canvas">
            <div
                :class="[
                    'h-full rounded-full transition-[width] duration-500 ease-out',
                    failed ? 'bg-danger' : parked ? 'bg-warning' : 'bg-primary-400',
                ]"
                :style="{ width: `${Math.max(view.percent, 2)}%` }"
            />
        </div>
        <!-- The folded plan keeps the running step's own sentence, which may be an instruction, not decoration. -->
        <p v-if="!listShown && at?.detail" class="truncate text-2xs text-subtle">{{ at.detail }}</p>

        <!-- Steps that won't run on this machine were never in the plan; nothing here is crossed out or skipped. -->
        <ol v-if="listShown" class="flex flex-col gap-1">
            <li v-for="step in view.steps" :key="step.phase" class="flex items-start gap-2 text-2xs">
                <span class="mt-0.5 flex size-3.5 shrink-0 items-center justify-center">
                    <Icon v-if="step.state === `done`" name="check-circle" class="text-success" />
                    <Icon v-else-if="step.state === `running`" name="spinner" spin class="text-primary-400" />
                    <!-- Neither done nor coming: a run that stopped is not still working through its list. -->
                    <span v-else class="size-1.5 rounded-full" :class="step.state === `stopped` ? 'bg-line' : 'bg-muted/40'" />
                </span>
                <span class="min-w-0 flex-1">
                    <span :class="step.state === `running` ? 'text-content' : step.state === `done` ? 'text-muted' : 'text-subtle'">
                        {{ step.label }}
                    </span>
                    <!-- The script's own detail line for this step, which may be an instruction, not just decoration. -->
                    <span v-if="step.detail" class="block truncate text-subtle">{{ step.detail }}</span>
                </span>
            </li>
        </ol>

        <!-- Prose, not a terminal: the log below is where the machine's own words are, one click away. -->
        <Notice v-if="failed && failure !== ``" tone="danger" class="text-2xs whitespace-pre-wrap">{{ failure }}</Notice>

        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-2xs">
            <!-- True, and the reason the × on this card is not a trap: the script is a process on this machine, not something this window is holding up. -->
            <span v-if="running" class="min-w-0 flex-1 text-subtle">Closing this doesn't stop the install: your workspace shows its progress.</span>
            <span v-else class="flex-1" />
            <button type="button" class="shrink-0 text-link hover:underline" @click="stepsOpen = !listShown">
                {{ listShown ? `Hide steps` : `All ${view.steps.length} steps` }}
            </button>
        </div>

        <!-- Monospace and wrapped: it matches what the same command prints in a terminal, minus the sideways drag. -->
        <pre
            v-if="open"
            class="max-h-64 overflow-auto rounded-md border border-line bg-canvas p-2 font-mono text-2xs leading-relaxed break-words text-muted whitespace-pre-wrap"
        ><span v-for="(line, index) in lines" :key="index" :class="line.stream === `stderr` ? `text-warning` : ``">{{ line.text }}
</span><span ref="logEnd" /></pre>
    </div>
</template>
