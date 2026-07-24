<script setup lang="ts">
import Button from "primevue/button";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useSandbox } from "../composables/sandbox/useSandbox";

/* Shown in the workspace outlet whenever the active sandbox's daemon isn't reachable (see SandboxGate). Three
 * shapes, so a first-time connect never wears the language of a failure:
 *   • never connected (no daemonUrl) — created but its daemon never announced; the move is to finish setup.
 *   • connecting (daemonUrl present, no probe failure) — the ordinary wait: the daemon reported in and the
 *     browser is opening its stream. Nothing is wrong, so no "reconnect" and nothing to click — it clears itself.
 *   • unreachable (a probe actually failed → probeError) — we reached for a daemon we expected and it didn't
 *     answer (cleanup.sh, stopped container, dead tunnel). Waiting alone won't fix it, so offer to reconnect.
 * The liveness probe flips `reachable` true the moment the daemon answers, and the real views render. */

const { active, daemonUrl, probeError } = useSandbox();
const router = useRouter();

// No bound URL at all ⇒ created but never connected. With a URL but no probe failure we're simply still
// connecting; a probeError means a reach we expected actually failed (the only state that warrants "reconnect").
const neverConnected = computed(() => daemonUrl.value === undefined);
const failed = computed(() => probeError.value !== undefined);
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
                    <template v-else-if="failed">
                        Waiting for your sandbox's daemon to answer — your workspace opens automatically the moment it does. If you ran the CLI
                        cleanup or stopped the container, reconnect it from setup.
                    </template>
                    <template v-else>
                        Your sandbox reported in — opening a live connection to it. Your workspace appears automatically in a moment.
                    </template>
                </p>
                <template v-if="!neverConnected && failed">
                    <a
                        :href="daemonUrl"
                        target="_blank"
                        rel="noopener"
                        class="break-all font-mono text-xs text-muted underline-offset-2 hover:underline"
                    >
                        {{ daemonUrl }}
                    </a>
                    <p class="text-xs text-warning">{{ probeError }}</p>
                </template>
            </div>
            <Button
                v-if="neverConnected || failed"
                :label="neverConnected ? `Finish setup` : `Reconnect`"
                icon-pos="right"
                severity="secondary"
                @click="openSetup"
            >
                <template #icon><Icon name="arrow-right" /></template>
            </Button>
        </div>
    </div>
</template>
