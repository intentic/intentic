<script setup lang="ts">
import { cmp } from "@intentic/ui";
import Button from "primevue/button";
import { onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { apiClient } from "../composables/useApi";
import { errorMessage } from "../composables/useAsyncAction";
import { useAuth } from "../composables/useAuth";
import { useGoogleIdentity } from "../composables/useGoogleIdentity";

/* SIGNING IN FOR THE DESKTOP APP — this page runs in the user's REAL BROWSER, never in the app's webview.
 *
 * The app opened it with `opener` because Google refuses OAuth from an embedded webview and Google Identity
 * Services is FedCM-based, which the Linux webview does not implement (see environments/desktop.ts). Here,
 * both are ordinary: requireAuth has already run the Better Auth sign-in, and GIS mints an ID token the way
 * it does on every other screen.
 *
 * The two credentials are then parked on the platform for one pickup, and the app is handed the row's id —
 * NOT the credentials. A deep link is delivered as a process argument, readable by anything else running on
 * the machine, so the id is the only thing small and worthless enough to travel that way.
 *
 * `state` is the app's own nonce, echoed back untouched: it is how the app knows this handoff answers the
 * sign-in IT started, and not a link that arrived from somewhere else. */

const route = useRoute();
const { user } = useAuth();
const { getIdToken } = useGoogleIdentity();

const error = ref<string | undefined>(undefined);
const handedOff = ref(false);
const working = ref(false);

const hand = async (): Promise<void> => {
    const state = route.query[`state`];
    if (typeof state !== `string` || state === ``) {
        error.value = `This link is missing the value that ties it to your app — open Intentic and sign in from there.`;
        return;
    }
    working.value = true;
    error.value = undefined;
    try {
        // The daemon's credential. Not silent: this page exists BECAUSE the user asked to sign in, so the
        // Google gate appearing here is the thing they asked for rather than an interruption.
        const idToken = await getIdToken();
        if (idToken === undefined) {
            error.value = `Intentic needs your Google sign-in to reach your sandbox.`;
            return;
        }
        const { handoff } = await apiClient.desktop.handoff({ idToken });
        handedOff.value = true;
        globalThis.location.href = `intentic://auth?handoff=${encodeURIComponent(handoff)}&state=${encodeURIComponent(state)}`;
    } catch (err) {
        error.value = errorMessage(err, `Couldn't finish signing in to the app.`);
    } finally {
        working.value = false;
    }
};

// Automatic, because arriving here already means the user pressed a button in the app; a second "yes" between
// the two would be a step whose only content is that a redirect happened. The button below is the retry.
onMounted(() => void hand());
</script>

<template>
    <div class="flex min-h-dvh w-full items-center justify-center bg-canvas px-4 text-content">
        <div class="animate-fade-in flex w-full max-w-md flex-col gap-4 rounded-2xl border border-line bg-surface p-6">
            <header class="flex items-center gap-3">
                <span
                    class="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-primary-600/30 bg-linear-to-br from-primary-600/20 to-primary-600/5"
                >
                    <img src="/assets/intentic-logo-sized.png" alt="" class="h-5 w-5 object-contain" />
                </span>
                <div class="min-w-0">
                    <h1 class="text-lg font-semibold">Signing in to the Intentic app</h1>
                    <p class="truncate text-xs text-muted">{{ user?.email }}</p>
                </div>
            </header>

            <div v-if="error" :class="cmp.alertDanger('text-xs')">{{ error }}</div>
            <p v-else-if="handedOff" class="flex items-start gap-2 text-xs text-muted">
                <Icon name="check-circle" class="mt-0.5 shrink-0 text-success" />
                <span>Sent to the app — you can close this tab. If nothing happened, make sure Intentic is running and try again.</span>
            </p>
            <p v-else class="flex items-start gap-2 text-xs text-muted">
                <Icon name="spinner" spin class="mt-0.5 shrink-0" />
                <span>Handing your sign-in to the app…</span>
            </p>

            <Button
                v-if="error || handedOff"
                :label="error ? `Try again` : `Send it again`"
                severity="secondary"
                class="self-start"
                :loading="working"
                @click="hand"
            />

            <p class="border-t border-line pt-3 text-2xs text-subtle">
                This page exists because Google won't sign you in inside an app window. Nothing is shared with the app beyond this one sign-in.
            </p>
        </div>
    </div>
</template>
