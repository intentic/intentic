<script setup lang="ts">
import { Notice } from "@intentic/ui";
import { computed, nextTick, ref, watch } from "vue";
import type { RunEvent } from "../desktop";
import type { ProgressView } from "../setupPlan";

/* WHAT AN INSTALL LOOKS LIKE WHILE IT RUNS: the plan, where in it we are, and how much is left.
 *
 * This replaced a single line and a disclosure: the last thing the script said, and the log behind it. That
 * is enough to READ a run and nothing like enough to WAIT through one, because the two questions somebody
 * sitting in front of a four-minute image pull actually has (is it stuck, and how long) were both
 * unanswerable from it. An install is the one screen in this app where the user has nothing to do but
 * decide whether to keep waiting, and every affordance a real installer has exists to make that decision
 * for them.
 *
 * So: the whole plan is drawn before anything starts (setupPlan.ts), the current step names itself and
 * carries the script's own words underneath, and the bar is weighted by how long each step takes rather than
 * how many there are: a step counter alone would sit at "6 of 9" through the longest part of the install
 * and then finish three steps in four seconds.
 *
 * The log is still here, still behind a disclosure, and still opens ITSELF on failure: a run that stopped has
 * said why on stderr, and hiding that behind a click is how a stuck user ends up with nothing to paste into a
 * support thread. */

/* `awaiting` is the run that stopped ON PURPOSE, waiting for the requirements card above to be answered. The
 * card owns that conversation; this component only needs to know not to call it a crash. */
const props = defineProps<{ events: RunEvent[]; view: ProgressView; running: boolean; awaiting?: boolean }>();

const open = ref(false);
const logEnd = ref<HTMLElement | undefined>(undefined);

const lines = computed(() => props.events.flatMap((event) => (event.kind === `line` ? [event] : [])));
const exit = computed(() => props.events.find((event) => event.kind === `exit`));
/* A NON-ZERO EXIT IS NOT AUTOMATICALLY A FAILURE, and this component was the last place that still thought so.
 *
 * The first pass of every Windows install that needs anything ends non-zero by design — it reports what it
 * would change and stops. App.vue already knows that and withholds the error box; here the exit code alone
 * drove a `Stopped` heading and a danger-red bar. The result was the screen calling its own two-pass consent
 * flow a crash: red bar, "Stopped", 4%, directly above a card politely asking for one click. */
const failed = computed(() => !props.awaiting && exit.value?.kind === `exit` && !exit.value.ok);

/* PowerShell's ERROR RECORD, which is four lines of furniture around one line of meaning:
 *
 *     connect.ps1 : could not redeem the setup code at … (405 Method Not Allowed) - refresh …   ← the message
 *     At C:\…\connect.ps1:160 char:73
 *     + ... redeem the setup code at $PlatformUrl ($($_.Exception.Message)) - ref ...
 *     +                              ~~~~~~~~~~~~~~~~~~~~~
 *         + CategoryInfo          : NotSpecified: (:) [Write-Error], WriteErrorException
 *         + FullyQualifiedErrorId : Microsoft.PowerShell.Commands.WriteErrorException,connect.ps1
 *
 * The source excerpt and the caret are for someone debugging the script; CategoryInfo and
 * FullyQualifiedErrorId name the .NET exception type, which is `WriteErrorException` for every error the
 * script raises on purpose and so says nothing about this one. Left in, they are the LAST lines, so a
 * "show me the end of stderr" rule shows the four that cannot help and hides the one that can, which is
 * exactly what a user meets on a failed setup. */
const isPowerShellDecoration = (text: string): boolean => /^\s*\+ /.test(text) || /^At .+:\d+ char:\d+$/.test(text);

// The failure's own words. stderr carries what went wrong; the checklist above already says where.
const failure = computed(() =>
    lines.value
        .filter((line) => line.stream === `stderr` && line.text.trim() !== `` && !isPowerShellDecoration(line.text))
        .slice(-4)
        .map((line) => line.text)
        .join(`\n`),
);

// `immediate`, so a card that MOUNTS on a run that already failed opens the log too: closing the overlay
// and coming back is the ordinary way to arrive at one, and it is exactly the reader who needs the detail.
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
        <!-- THE BAR, AND THE TWO NUMBERS EITHER SIDE OF IT. The percentage answers "is it moving", the
             estimate answers "should I wait": the two questions the old single line could not. -->
        <div class="flex flex-col gap-1.5">
            <div class="flex items-baseline gap-2 text-2xs">
                <!-- Three headings, not two: a run that stopped for an ANSWER is neither working nor broken,
                     and the estimate is meaningless while nothing is running, so it goes rather than counting
                     down against a clock the user controls. -->
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

        <!-- THE PLAN, DRAWN IN FULL FROM THE FIRST FRAME. Steps that will not happen on this machine were
             never in it, so nothing here is ever crossed out or skipped: what you see is what will run. -->
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
                    <!-- The script's own sentence, under the step it belongs to. This is where the things
                         only the script knows land, which image, how big, and "accept Docker's first-run
                         dialog if it shows", which is an instruction and not decoration. -->
                    <span v-if="step.detail" class="block truncate text-subtle">{{ step.detail }}</span>
                </span>
            </li>
        </ol>

        <Notice v-if="failed && failure !== ``" tone="danger" class="font-mono text-2xs whitespace-pre-wrap">{{ failure }}</Notice>

        <div class="flex items-center gap-2 text-2xs">
            <!-- True, and the reason the × on this card is not a trap: the script is a process on this
                 machine, not something this window is holding up. -->
            <span v-if="running" class="flex-1 text-subtle">You can close this: the install keeps going.</span>
            <span v-else class="flex-1" />
            <button type="button" class="shrink-0 text-link hover:underline" @click="open = !open">
                {{ open ? `Hide detail` : `Show detail` }}
            </button>
        </div>

        <!-- Monospace and unstyled: this is the script's output, and re-formatting it would make it something
             the user cannot match against what the same command prints in a terminal. -->
        <pre
            v-if="open"
            class="max-h-64 overflow-auto rounded-md border border-line bg-canvas p-2 font-mono text-2xs leading-relaxed text-muted"
        ><span v-for="(line, index) in lines" :key="index" :class="line.stream === `stderr` ? `text-warning` : ``">{{ line.text }}
</span><span ref="logEnd" /></pre>
    </div>
</template>
