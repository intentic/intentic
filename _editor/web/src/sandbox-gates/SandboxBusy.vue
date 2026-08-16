<script setup lang="ts">
import Button from "primevue/button";
import { computed } from "vue";
import { useGoogleIdentity } from "../composables/useGoogleIdentity";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { useSandboxSession } from "../composables/sandbox/sandboxSession";

/* A previously-painted workspace whose daemon has stayed quiet long enough to deserve words. This floats over
 * the live DOM instead of replacing it: reading, drafting and navigation remain useful, and automatic recovery
 * should not look like a page-level failure. Short stalls never mount this component at all (availability.ts). */

const { connection } = useSandbox();
const { clearCredential } = useGoogleIdentity();
const { invalidateSession, getSessionToken } = useSandboxSession();
const needsSignin = computed(() => connection.value.failure?.kind === "unauthenticated");

const signIn = (): void => {
    clearCredential();
    invalidateSession();
    void getSessionToken();
};
</script>

<template>
    <div class="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3" role="status" aria-live="polite">
        <div
            class="pointer-events-auto flex max-w-lg items-center gap-2 rounded-full border border-line bg-card/95 px-3 py-2 text-xs text-muted shadow-lg backdrop-blur"
        >
            <Icon name="spinner" class="shrink-0 text-info" spin />
            <span class="min-w-0 flex-1">
                {{
                    needsSignin
                        ? `This browser's sandbox session needs attention. Your workspace is still here.`
                        : `The sandbox is busy. Your workspace stays open while it catches up automatically.`
                }}
            </span>
            <Button v-if="needsSignin" label="Sign in again" size="small" severity="secondary" class="shrink-0" @click="signIn" />
        </div>
    </div>
</template>
