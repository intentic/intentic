<script setup lang="ts">
import { Button, Code, Notice, timeAgo } from "@intentic/ui";
import { useAsyncAction, useNow } from "@intentic/ui/async";
import { computed } from "vue";
import { useHostedBuild } from "../../secrets/useHostedBuild";
import { hostedBuildPhase } from "./hostedBuildPhase";
import { useT } from "@intentic/ui/i18n";

// Rebuilds a hosted sandbox's environment, the counterpart of HostRecreate for the lane with no host device: the
// platform builds the approved overlay itself and switches the sandbox to the result. Only shows the build for this
// content's hash, so an older failure doesn't linger against a new recipe. Every phase says when it began: a build
// that has run for an hour and one that started a minute ago used to read the same, under a banner asking for a
// rebuild, with nothing to press.

const t = useT();

const props = defineProps<{
    sandboxId: string;
    // Both read off the daemon; the platform re-hashes the content itself.
    hash: string;
    content: string;
    // A tier below a decision that should come first (a proposal waiting above it), as HostRecreate draws it there.
    text?: boolean;
}>();

const { build, applied, rebuild } = useHostedBuild(() => props.sandboxId);
const { busy, notice, run } = useAsyncAction();

// Ticks once a minute: what it moves is "started 12 minutes ago" and the end of the swap's window.
const now = useNow(true, 60_000);
const phase = computed(() => hostedBuildPhase(build.value, applied.value, props.hash, now.value));

const start = (): Promise<void> =>
    run(async () => {
        await rebuild(props.hash, props.content);
    }, t(`sandbox.hostedRebuild.couldNotStart`));
</script>

<template>
    <div class="flex flex-col gap-2">
        <template v-if="phase.kind === `building`">
            <p class="text-xs text-content">
                {{ t(`sandbox.hostedRebuild.buildingEnvironmentOnMachine`) }}
                {{ t(`sandbox.hostedRebuild.startedAgo`, { ago: timeAgo(phase.since, { now }) }) }}
            </p>
        </template>
        <template v-else-if="phase.kind === `switching`">
            <p class="text-xs text-content">{{ t(`sandbox.hostedRebuild.builtSandboxRestartingOnto`) }}</p>
        </template>
        <template v-else>
            <template v-if="phase.kind === `failed`">
                <p class="text-xs text-danger">{{ t(`sandbox.hostedRebuild.buildFailed`, { error: phase.error }) }}</p>
                <Code v-if="phase.log" :code="phase.log" :label="t(`sandbox.hostedRebuild.buildLogTail`)" />
            </template>
            <!-- Built, and the sandbox never came back on it: said, so the button below reads as the way out. -->
            <p v-else-if="phase.kind === `stalled`" class="text-xs text-content">
                {{ t(`sandbox.hostedRebuild.builtNotSwitched`, { ago: timeAgo(phase.builtAt, { now }) }) }}
            </p>
            <!-- No "to finish" line above it: it leads the Environment card, under the badge that already says a rebuild
                 is waiting. Wraps without shrinking the button: in a narrow column the sentence drops below it instead
                 of squeezing the label. -->
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <div class="shrink-0">
                    <Button
                        :label="
                            phase.kind === `failed`
                                ? t(`sandbox.hostedRebuild.tryBuildAgain`)
                                : phase.kind === `stalled`
                                  ? t(`sandbox.hostedRebuild.rebuildAgain`)
                                  : t(`sandbox.words.rebuildNow`)
                        "
                        size="small"
                        :tier="text ? `quiet` : `accent`"
                        :loading="busy"
                        @click="start"
                    >
                        <template v-if="!text" #icon><Icon name="bolt" /></template>
                    </Button>
                </div>
                <!-- The one fact worth stating: build time counts against this sandbox's awake hours. -->
                <p class="text-2xs text-subtle">{{ t(`sandbox.hostedRebuild.buildMinutesCountAgainst`) }}</p>
            </div>
        </template>
        <Notice v-if="notice" :of="notice" />
    </div>
</template>
