<script setup lang="ts">
import Button from "primevue/button";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useSandboxSession } from "../composables/sandbox/sandboxSession";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { useGoogleIdentity } from "../composables/useGoogleIdentity";
import { connectionNotice } from "./connectionNotice";

/* Shown in the workspace outlet whenever the active sandbox's daemon isn't reachable (see SandboxGate). What
 * it says is a pure function of the CLASSIFIED connection failure (connectionNotice) rather than of a boolean
 * "did a probe fail" — so a sandbox that never announced itself, one that stopped answering mid-session, and
 * an expired Google session each get their own words and their own offered action instead of sharing one
 * "unreachable" screen. The connection machine flips to `online` the moment the daemon answers, and the real
 * views render. */

const { active, daemonUrl, connection } = useSandbox();
const { clearCredential } = useGoogleIdentity();
const { invalidateSession, getSessionToken } = useSandboxSession();
const router = useRouter();

const notice = computed(() => connectionNotice(connection.value.failure, active.value?.name));

// Carry the sandbox id so /setup resumes THIS sandbox instead of offering a blank create form.
const openSetup = (): void => void router.push({ path: `/setup`, query: { sandbox: active.value?.id } });
// Drop both credentials so the re-establish goes through a fresh Google proof (with the account chooser —
// clearCredential disables auto-select) instead of replaying whatever the daemon just refused.
const signIn = (): void => {
    clearCredential();
    invalidateSession();
    void getSessionToken();
};
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
                    {{ notice.title }}
                </h2>
                <p class="text-sm text-muted">{{ notice.body }}</p>
                <template v-if="notice.showDetail">
                    <a
                        :href="daemonUrl"
                        target="_blank"
                        rel="noopener"
                        class="break-all font-mono text-xs text-muted underline-offset-2 hover:underline"
                    >
                        {{ daemonUrl }}
                    </a>
                    <p class="text-xs text-warning">{{ connection.failure?.message }}</p>
                </template>
            </div>
            <Button
                v-if="notice.action === `setup`"
                label="Finish setup"
                icon-pos="right"
                severity="secondary"
                @click="openSetup"
            >
                <template #icon><Icon name="arrow-right" /></template>
            </Button>
            <Button v-else-if="notice.action === `reconnect`" label="Reconnect" icon-pos="right" severity="secondary" @click="openSetup">
                <template #icon><Icon name="arrow-right" /></template>
            </Button>
            <Button v-else-if="notice.action === `signin`" label="Sign in again" icon-pos="right" severity="secondary" @click="signIn">
                <template #icon><Icon name="arrow-right" /></template>
            </Button>
        </div>
    </div>
</template>
