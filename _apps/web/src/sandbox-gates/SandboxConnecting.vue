<script setup lang="ts">
import Button from "primevue/button";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useSandbox } from "../composables/sandbox/useSandbox";

/* Shown in the workspace outlet whenever the active sandbox's daemon isn't reachable (see WorkspaceShell).
 * The daemon is an external container the user runs via connect.sh, so "not reachable" means it was either
 * never connected (no daemonUrl) or is down — either way the only useful action is to (re)connect it, so we
 * show that instead of a shell of controls that would all fail against a dead daemon. It clears itself: the
 * liveness probe flips `reachable` true the moment the daemon answers, and the real views render. */

const { active, daemonUrl, probeError } = useSandbox();
const router = useRouter();

// No bound URL at all ⇒ created but never connected; otherwise we have an address and are waiting on it.
const neverConnected = computed(() => daemonUrl.value === undefined);
// Carry the sandbox id so /setup resumes THIS sandbox instead of offering a blank create form.
const openSetup = (): void => void router.push({ path: `/setup`, query: { sandbox: active.value?.id } });
</script>

<template>
    <div class="flex h-full w-full items-center justify-center p-8">
        <div class="animate-fade-in flex w-full max-w-md flex-col items-center gap-4 rounded-2xl border border-line bg-card p-8 text-center">
            <span class="flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-canvas text-muted">
                <Icon name="box" class="text-xl" />
            </span>
            <div class="flex flex-col gap-1.5">
                <h2 class="flex items-center justify-center gap-2 text-lg font-semibold text-content">
                    <Icon name="spinner" class="text-info" spin />
                    <template v-if="neverConnected">Connect "{{ active?.name }}"</template>
                    <template v-else>Connecting to "{{ active?.name }}"…</template>
                </h2>
                <p class="text-sm text-muted">
                    <template v-if="neverConnected">
                        This sandbox isn't connected yet — finish setup to start its daemon, and your workspace opens automatically.
                    </template>
                    <template v-else>
                        Waiting for your sandbox's daemon to answer — your workspace opens automatically the moment it does. If you ran the CLI
                        cleanup or stopped the container, reconnect it from setup.
                    </template>
                </p>
                <template v-if="!neverConnected">
                    <a
                        :href="daemonUrl"
                        target="_blank"
                        rel="noopener"
                        class="break-all font-mono text-xs text-muted underline-offset-2 hover:underline"
                    >
                        {{ daemonUrl }}
                    </a>
                    <p v-if="probeError" class="text-xs text-warning">{{ probeError }}</p>
                </template>
            </div>
            <Button :label="neverConnected ? `Finish setup` : `Reconnect`" icon-pos="right" severity="secondary" @click="openSetup">
                <template #icon><Icon name="arrow-right" /></template>
            </Button>
        </div>
    </div>
</template>
