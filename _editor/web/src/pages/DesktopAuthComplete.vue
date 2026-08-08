<script setup lang="ts">
import { cmp } from "@intentic/ui";
import Button from "primevue/button";
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiClient } from "../composables/useApi";
import { errorMessage } from "../composables/useAsyncAction";
import { useAuth } from "../composables/useAuth";
import { useGoogleIdentity } from "../composables/useGoogleIdentity";
import { environment } from "../environments/environment";

/* THE OTHER END OF THE HANDOFF — this page runs INSIDE the desktop app's webview, which has no session yet.
 *
 * Three steps, and the middle one is the whole trick:
 *   1. redeem the row the browser parked (single use — the platform deletes it as it answers)
 *   2. spend the Better Auth one-time token at /api/auth/one-time-token/verify. That endpoint replies with a
 *      Set-Cookie, so THIS webview obtains the platform session through an ordinary HTTP round trip; nothing
 *      is injected from Rust and no cookie is forged.
 *   3. adopt the Google ID token into the same cache a local mint would have filled, so the first daemon call
 *      exchanges it for a daemon session — which renews silently from then on, and is why Google does not
 *      come back every hour.
 *
 * A failure here is always terminal for this link (the row is gone either way), so the retry is "sign in
 * again", not "try this link again". */

const route = useRoute();
const router = useRouter();
const { refresh } = useAuth();
const { adoptIdToken } = useGoogleIdentity();

const error = ref<string | undefined>(undefined);

const complete = async (): Promise<void> => {
    const handoff = route.query[`handoff`];
    const verifier = route.query[`verifier`];
    if (typeof handoff !== `string` || handoff === `` || typeof verifier !== `string` || verifier === ``) {
        error.value = `This sign-in link is incomplete.`;
        return;
    }
    try {
        const { ott, idToken } = await apiClient.desktop.redeem({ handoff, verifier });
        // Better Auth's own endpoint, called directly rather than through the oRPC client: it lives under
        // /api/auth (not the contract), and what we are after is its Set-Cookie, not its body.
        const verified = await globalThis.fetch(`${environment.api.url}/api/auth/one-time-token/verify`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            credentials: `include`,
            body: JSON.stringify({ token: ott }),
        });
        if (!verified.ok) {
            error.value = `That sign-in had already expired. Sign in from the app again.`;
            return;
        }
        if (!adoptIdToken(idToken)) {
            error.value = `That sign-in had already expired. Sign in from the app again.`;
            return;
        }
        await refresh();
        await router.replace(`/`);
    } catch (err) {
        error.value = errorMessage(err, `Couldn't finish signing in.`);
    }
};

onMounted(() => void complete());
</script>

<template>
    <div class="flex min-h-dvh w-full items-center justify-center bg-canvas px-4 text-content">
        <div class="animate-fade-in flex w-full max-w-sm flex-col gap-4 text-center">
            <template v-if="error">
                <div :class="cmp.alertDanger('text-xs')">{{ error }}</div>
                <Button label="Back to sign in" severity="secondary" class="self-center" @click="void router.replace(`/login`)" />
            </template>
            <p v-else class="flex items-center justify-center gap-2 text-sm text-muted">
                <Icon name="spinner" spin />
                <span>Signing you in…</span>
            </p>
        </div>
    </div>
</template>
