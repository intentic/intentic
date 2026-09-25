<script setup lang="ts">
import { Button, Code, Notice } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import { computed } from "vue";
import { useHostedBuild } from "../secrets/useHostedBuild";
import { useT } from "@intentic/ui/i18n";

// Rebuilds a hosted sandbox's environment, the counterpart of HostRecreate for the lane with no host device: the
// platform builds the approved overlay itself and switches the sandbox to the result. Only shows the build for this
// content's hash, so an older failure doesn't linger against a new recipe.

const t = useT();

const props = defineProps<{
    sandboxId: string;
    // Both read off the daemon; the platform re-hashes the content itself.
    hash: string;
    content: string;
}>();

const { build, applied, rebuild } = useHostedBuild(() => props.sandboxId);
const { busy, notice, run } = useAsyncAction();

const current = computed(() => (build.value?.hash === props.hash ? build.value : undefined));
const building = computed(() => current.value?.state === `building`);
// Ends once the daemon's own `applied` matches, after the restarted sandbox answers again.
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
                {{ t(`sandbox.hostedRebuild.buildingEnvironmentOnMachine`) }}
            </p>
        </template>
        <template v-else-if="switching">
            <p class="text-xs text-content">{{ t(`sandbox.hostedRebuild.builtSandboxRestartingOnto`) }}</p>
        </template>
        <template v-else>
            <template v-if="failed">
                <p class="text-xs text-danger">{{ t(`sandbox.hostedRebuild.buildFailed`, { error: failed.error }) }}</p>
                <Code v-if="failed.log" :code="failed.log" :label="t(`sandbox.hostedRebuild.buildLogTail`)" />
            </template>
            <p class="text-xs font-medium text-content">{{ t(`sandbox.hostedRebuild.toFinishBuildOn`) }}</p>
            <!-- Wraps without shrinking the button: in a narrow column the sentence drops below it instead of squeezing the label. -->
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <div class="shrink-0">
                    <Button
                        :label="failed ? t(`sandbox.hostedRebuild.tryBuildAgain`) : t(`sandbox.words.rebuildNow`)"
                        size="small"
                        :loading="busy"
                        @click="start"
                    />
                </div>
                <!-- The one fact worth stating: build time counts against this sandbox's awake hours. -->
                <p class="text-2xs text-subtle">{{ t(`sandbox.hostedRebuild.buildMinutesCountAgainst`) }}</p>
            </div>
        </template>
        <Notice v-if="notice" :of="notice" />
    </div>
</template>
