<script setup lang="ts">
import { Card, StatusBadge } from "@intentic/ui";
import HostRecreate from "../../components/HostRecreate.vue";
import { useSandboxVersion } from "../../composables/sandbox/useSandboxVersion";

/* "Update available" — the non-blocking prompt on the /sandbox hub when a newer sandbox image has shipped. The
 * daemon reports installed vs latest on /info; the update runs on the host (the sandbox holds no host Docker
 * socket — its own engine is nested, so it can't recreate its own container), which is what HostRecreate is
 * for: a button in the desktop app, the copy-paste one-liner in a browser. A server-managed sandbox updates on
 * its host's next deploy, so it gets a note instead. Hidden unless an update is available. */

const { installed, latest, updateAvailable, serverManaged, slug } = useSandboxVersion();
</script>

<template>
    <Card v-if="updateAvailable" class="flex flex-col gap-4">
        <div class="flex items-start gap-2.5">
            <Icon name="arrow-circle-up" class="mt-0.5 text-lg text-muted" />
            <div class="min-w-0 flex-1">
                <div class="flex items-center justify-between gap-3">
                    <h2 class="font-semibold leading-tight">Update available</h2>
                    <StatusBadge variant="warning" :label="`${installed ?? '?'} → ${latest}`" dot />
                </div>
                <p class="text-2xs text-subtle">
                    A newer sandbox image has been released. Updating pulls it and recreates your sandbox — your files (in /work) are kept.
                </p>
            </div>
        </div>

        <template v-if="serverManaged">
            <p class="text-2xs text-subtle">
                This sandbox updates on the next <span class="font-mono">intentic deploy apply</span> against its host.
            </p>
        </template>
        <template v-else-if="slug">
            <p class="text-xs font-medium text-content">To update, recreate your sandbox on the new image:</p>
            <HostRecreate :slug="slug" action="Update" />
        </template>
    </Card>
</template>
