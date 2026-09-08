<script setup lang="ts">
import { Notice } from "@intentic/ui";
import { computed, nextTick, ref, watch } from "vue";
import type { RunEvent } from "../desktop";
import type { ProgressView } from "../setupPlan";

// Shows the full plan up front (setupPlan.ts), the current step's own detail, and a bar weighted by each step's
// typical duration rather than step count. The log stays collapsed but opens itself on failure.

// `awaiting` is a deliberate stop for the requirements card above; this component just must not call it a crash.
const props = defineProps<{ events: RunEvent[]; view: ProgressView; running: boolean; awaiting?: boolean }>();

const open = ref(false);
const logEnd = ref<HTMLElement | undefined>(undefined);

const lines = computed(() => props.events.flatMap((event) => (event.kind === `line` ? [event] : [])));
const exit = computed(() => props.events.find((event) => event.kind === `exit`));
// A non-zero exit isn't automatically a failure: a Windows install's first pass exits non-zero by design (it
// reports what it would change and stops), which App.vue also accounts for.
const failed = computed(() => !props.awaiting && exit.value?.kind === `exit` && !exit.value.ok);

// Filters PowerShell's error-record furniture (source excerpt, CategoryInfo, FullyQualifiedErrorId) so a "last N
// lines of stderr" rule shows the actual message, not boilerplate.
const isPowerShellDecoration = (text: string): boolean => /^\s*\+ /.test(text) || /^At .+:\d+ char:\d+$/.test(text);

// Shows only the failure's own words: what went wrong, not where (the checklist covers that).
const failure = computed(() =>
    lines.value
        .filter((line) => line.stream === `stderr` && line.text.trim() !== `` && !isPowerShellDecoration(line.text))
        .slice(-4)
        .map((line) => line.text)
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
    <div class="flex flex-col gap-3">
        <!-- Percentage answers "is it moving"; the estimate answers "should I wait". -->
        <div class="flex flex-col gap-1.5">
            <div class="flex items-baseline gap-2 text-2xs">
                <!-- Three headings, not two: a run awaiting an answer is neither working nor broken. -->
                <span class="flex-1 font-medium text-content">{{
                    awaiting ? `Waiting for you` : failed ? `Stopped` : (view.position ?? `Starting…`)
                }}</span>
                <span v-if="view.remaining && !failed && !awaiting" class="text-subtle">{{ view.remaining }}</span>
                <span class="font-mono tabular-nums text-muted">{{ view.percent }}%</span>
            </div>
            <div class="h-1.5 overflow-hidden rounded-full bg-canvas">
                <div
                    :class="[
                        'h-full rounded-full transition-[width] duration-500 ease-out',
                        failed ? 'bg-danger' : awaiting ? 'bg-warning' : 'bg-primary-400',
                    ]"
                    :style="{ width: `${Math.max(view.percent, 2)}%` }"
                />
            </div>
        </div>

        <!-- Steps that won't run on this machine were never in the plan; nothing here is crossed out or skipped. -->
        <ol class="flex flex-col gap-1">
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

        <Notice v-if="failed && failure !== ``" tone="danger" class="font-mono text-2xs whitespace-pre-wrap">{{ failure }}</Notice>

        <div class="flex items-center gap-2 text-2xs">
            <!-- True, and the reason the × on this card is not a trap: the script is a process on this
                 machine, not something this window is holding up. It also says what the reader will find on
                 the other side of that ×, because "keeps going" alone left the question of HOW it is going
                 to a page that used to have no answer (App.vue `report`). -->
            <span v-if="running" class="flex-1 text-subtle">Closing this doesn't stop the install: your workspace shows its progress.</span>
            <span v-else class="flex-1" />
            <button type="button" class="shrink-0 text-link hover:underline" @click="open = !open">
                {{ open ? `Hide detail` : `Show detail` }}
            </button>
        </div>

        <!-- Monospace and unstyled, so it matches what the same command prints in a terminal. -->
        <pre
            v-if="open"
            class="max-h-64 overflow-auto rounded-md border border-line bg-canvas p-2 font-mono text-2xs leading-relaxed text-muted"
        ><span v-for="(line, index) in lines" :key="index" :class="line.stream === `stderr` ? `text-warning` : ``">{{ line.text }}
</span><span ref="logEnd" /></pre>
    </div>
</template>
