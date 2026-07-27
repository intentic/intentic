<script setup lang="ts">
import { Card, Code, StatusBadge } from "@intentic-app/ui";
import { computed } from "vue";
import { daemonBehind, missingRoutes } from "../../composables/sandbox/useDaemonRoutes";

/* "This sandbox predates some features" — the specific companion to SandboxUpdateCard.
 *
 * That card compares version strings against the latest published release, which answers "is something newer
 * out?". This one compares the daemon's ADVERTISED route surface against the contract this app was built with,
 * which answers the sharper question: "what can this sandbox actually not do?". Two reasons it exists
 * separately rather than folding into the version check:
 *
 *   - In local development every package is version 0.0.0, so there is no release to compare against and the
 *     update card can never fire — which is exactly the case where a developer's daemon is most often behind
 *     their working tree, and exactly the confusion this whole mechanism was built to end.
 *   - A version being newer does not tell you whether anything you care about changed. A named route gap does.
 *
 * Non-blocking on purpose. An older sandbox is a fully supported thing to be running — everything it does
 * implement keeps working, and nothing here forces an update. It only stops the gap being invisible. */

const groups = computed(() => [...new Set(missingRoutes.value.map((name) => name.split(`.`)[0]))].toSorted());
// The developer's remedy is the one the dev loop already documents; a user's is the update card's path.
const isDev = import.meta.env.DEV;
const rebuildCommand = `pnpm build:sandbox && sh _apps/sandbox/scripts/dev-sandbox.sh`;
</script>

<template>
    <Card v-if="daemonBehind" class="flex flex-col gap-4">
        <div class="flex items-start gap-2.5">
            <Icon name="info-circle" class="mt-0.5 text-lg text-muted" />
            <div class="min-w-0 flex-1">
                <div class="flex items-center justify-between gap-3">
                    <h2 class="font-semibold leading-tight">This sandbox is behind the app</h2>
                    <StatusBadge variant="warning" :label="`${missingRoutes.length} missing`" dot />
                </div>
                <p class="text-2xs text-subtle">
                    Its daemon was built before some features this app knows about, so those will report that the route is unavailable rather than
                    working. Everything else is unaffected.
                </p>
            </div>
        </div>

        <p class="text-2xs text-subtle">
            Affected area<span v-if="groups.length !== 1">s</span>: <span class="font-mono">{{ groups.join(`, `) }}</span>
        </p>

        <template v-if="isDev">
            <p class="text-xs font-medium text-content">Your dev image predates your working tree — rebuild it:</p>
            <Code :code="rebuildCommand" lang="bash" label="Rebuild command" :wrap="true" />
        </template>
        <p v-else class="text-2xs text-subtle">Updating the sandbox to a newer image restores these features.</p>
    </Card>
</template>
