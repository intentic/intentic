<script setup lang="ts">
import { Button, Code, Notice } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import { computed } from "vue";
import { useHostedBuild } from "../composables/sandbox/useHostedBuild";

/* REBUILDING A HOSTED SANDBOX'S ENVIRONMENT, the counterpart of HostRecreate for the one lane with no host.
 * A sandbox on the owner's own device rebuilds by a command or a button that runs `ic` THERE; a hosted
 * sandbox is a machine the platform runs, so the platform builds the approved overlay on a machine of its
 * own and switches the sandbox to the result. One button, then the three things a build can be doing:
 * running (minutes, the sandbox stays up throughout), built (the sandbox is restarting onto it), failed
 * (the reason and the log's tail, which is the one thing the owner needs from a failed RUN).
 *
 * The build the card looks at is the one for THIS content's hash. An older build's failure is history the
 * moment the owner approves something else, so it is not shown against the new recipe. */

const props = defineProps<{
    sandboxId: string;
    // The approved overlay's hash and content, both read off the daemon: the platform re-hashes the content.
    hash: string;
    content: string;
}>();

const { build, applied, rebuild } = useHostedBuild(() => props.sandboxId);
const { busy, notice, run } = useAsyncAction();

const current = computed(() => (build.value?.hash === props.hash ? build.value : undefined));
const building = computed(() => current.value?.state === `building`);
// Built, and the platform has already pointed the machine at it: the daemon's own "applied" is what ends
// this state, once the restarted sandbox answers again.
const switching = computed(() => current.value?.state === `built` && applied.value === props.hash);
const failed = computed(() => (current.value?.state === `failed` ? current.value : undefined));

const start = (): Promise<void> =>
    run(async () => {
        await rebuild(props.hash, props.content);
    }, `Could not start the build.`);
</script>

<template>
    <div class="flex flex-col gap-2">
        <template v-if="building">
            <p class="text-xs text-content">
                Building your environment on a machine we run. This takes a few minutes; your sandbox keeps working meanwhile and restarts onto the
                result when it is ready.
            </p>
        </template>
        <template v-else-if="switching">
            <p class="text-xs text-content">Built. Your sandbox is restarting onto the new image; this card updates when it is back.</p>
        </template>
        <template v-else>
            <template v-if="failed">
                <p class="text-xs text-danger">The build failed: {{ failed.error }}</p>
                <Code v-if="failed.log" :code="failed.log" label="Build log (tail)" />
            </template>
            <p class="text-xs font-medium text-content">To finish, build it on the machine we host for you:</p>
            <!-- Wrapping, and the button never shrinks: in a narrow column the sentence goes under the button
                 rather than squeezing its label to a fragment. -->
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <div class="shrink-0">
                    <Button :label="failed ? `Try the build again` : `Rebuild now`" size="small" :loading="busy" @click="start" />
                </div>
                <!-- The one fact worth a sentence: minutes spent building count like minutes spent awake. -->
                <p class="text-2xs text-subtle">Build minutes count against this sandbox's awake hours. Your files in /work are kept.</p>
            </div>
        </template>
        <Notice v-if="notice" :of="notice" />
    </div>
</template>
