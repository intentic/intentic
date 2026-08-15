<script setup lang="ts">
import { Notice } from "@intentic/ui";
import { computed, nextTick, ref, watch } from "vue";
import { isStep, stepLabel, type RunEvent } from "../desktop";

/* WHAT A RUNNING SCRIPT LOOKS LIKE. The scripts narrate themselves — every step connect.sh or recreate.sh
 * takes is an `intentic: …` line — so this promotes those to the headline and keeps everything else (docker's
 * pull bars, a build's layer chatter) as the detail behind a disclosure. That is the same information the
 * terminal path shows, in the order it shows it; inventing a second progress model on top would only be a
 * thing to keep in step with the scripts' output.
 *
 * The detail opens BY ITSELF on failure. A run that fails has said why on stderr, and hiding that behind a
 * click is how a stuck user ends up with nothing to paste into a support thread. */

const props = defineProps<{ events: RunEvent[]; running: boolean }>();

const open = ref(false);
const logEnd = ref<HTMLElement | undefined>(undefined);

const lines = computed(() => props.events.flatMap((event) => (event.kind === `line` ? [event] : [])));
const exit = computed(() => props.events.find((event) => event.kind === `exit`));
const failed = computed(() => exit.value?.kind === `exit` && !exit.value.ok);

// The last thing the script said it was doing — the headline while it runs, and the step it died on after.
const currentStep = computed(() => {
    const steps = lines.value.filter((line) => line.stream === `stdout` && isStep(line.text));
    const last = steps.at(-1);
    return last === undefined ? `Starting…` : stepLabel(last.text);
});

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
 * script raises on purpose and so says nothing about this one. Left in, they are the LAST lines — so a
 * "show me the end of stderr" rule shows the four that cannot help and hides the one that can, which is
 * exactly what a user meets on a failed setup. */
const isPowerShellDecoration = (text: string): boolean => /^\s*\+ /.test(text) || /^At .+:\d+ char:\d+$/.test(text);

// The failure's own words. stderr carries what went wrong; the script's last stdout step says where.
const failure = computed(() =>
    lines.value
        .filter((line) => line.stream === `stderr` && line.text.trim() !== `` && !isPowerShellDecoration(line.text))
        .slice(-4)
        .map((line) => line.text)
        .join(`\n`),
);

watch(failed, (value) => {
    if (value) {
        open.value = true;
    }
});
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
        <div class="flex items-center gap-2 text-sm">
            <Icon v-if="running" name="spinner" spin class="text-primary-400" />
            <Icon v-else-if="failed" name="x-circle" class="text-danger" />
            <Icon v-else name="check-circle" class="text-success" />
            <span class="min-w-0 flex-1 truncate text-content">{{ failed ? `Couldn't finish` : currentStep }}</span>
            <button type="button" class="shrink-0 text-xs text-link hover:underline" @click="open = !open">
                {{ open ? `Hide detail` : `Show detail` }}
            </button>
        </div>

        <Notice v-if="failed && failure !== ``" tone="danger" class="font-mono text-2xs whitespace-pre-wrap">{{ failure }}</Notice>

        <!-- Monospace and unstyled: this is the script's output, and re-formatting it would make it something
             the user cannot match against what the same command prints in a terminal. -->
        <pre
            v-if="open"
            class="max-h-64 overflow-auto rounded-md border border-line bg-canvas p-2 font-mono text-2xs leading-relaxed text-muted"
        ><span v-for="(line, index) in lines" :key="index" :class="line.stream === `stderr` ? `text-warning` : ``">{{ line.text }}
</span><span ref="logEnd" /></pre>
    </div>
</template>
