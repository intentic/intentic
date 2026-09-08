<script setup lang="ts">
import { Button, ui, Notice, type NoticeModel } from "@intentic/ui";
import { noticeFrom, noticeOf } from "@intentic/ui/async";
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiClient } from "../../lib/useApi";
import { useAuth } from "./useAuth";
import { useGoogleIdentity } from "./useGoogleIdentity";
import { environment } from "../../app/environments/environment";

// This page runs inside the desktop app's webview, which starts with no session.
// 1. Redeem the row the browser parked (single use).
// 2. Verify the Better Auth one-time token at /api/auth/one-time-token/verify; its Set-Cookie gives this webview a
//    session over an ordinary HTTP round trip, nothing injected from Rust.
// 3. Adopt the Google ID token into the shared cache, so the first daemon call gets a session that renews silently.
// A failure is terminal for this link; retry means signing in again, not reloading the link.

const route = useRoute();
const router = useRouter();
const { refresh } = useAuth();
const { adoptIdToken } = useGoogleIdentity();

const error = ref<NoticeModel | undefined>(undefined);

const complete = async (): Promise<void> => {
    const handoff = route.query[`handoff`];
    const verifier = route.query[`verifier`];
    if (typeof handoff !== `string` || handoff === `` || typeof verifier !== `string` || verifier === ``) {
        error.value = noticeOf(`This sign-in link is incomplete.`);
        return;
    }
    try {
        const { ott, idToken } = await apiClient.desktop.redeem({ handoff, verifier });
        // Called directly, not through oRPC: this lives under /api/auth. Only its Set-Cookie matters, not the body.
        const verified = await globalThis.fetch(`${environment.api.url}/api/auth/one-time-token/verify`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            credentials: `include`,
            body: JSON.stringify({ token: ott }),
        });
        if (!verified.ok) {
            error.value = noticeOf(`That sign-in had already expired. Sign in from the app again.`);
            return;
        }
        if (!adoptIdToken(idToken)) {
            error.value = noticeOf(`That sign-in had already expired. Sign in from the app again.`);
            return;
        }
        await refresh();
        await router.replace(`/`);
    } catch (err) {
        error.value = noticeFrom(err, `Couldn't finish signing in.`);
    }
};

onMounted(() => void complete());
</script>

<template>
    <div class="flex min-h-dvh w-full items-center justify-center bg-canvas px-4 text-content">
        <div class="flex w-full max-w-sm flex-col gap-4 text-center">
            <template v-if="error">
                <Notice v-if="error" :of="error" />
                <Button label="Back to sign in" severity="secondary" class="self-center" @click="void router.replace(`/login`)" />
            </template>
            <p v-else class="flex items-center justify-center gap-2 text-sm text-muted">
                <Icon name="spinner" spin />
                <span>Signing you in…</span>
            </p>
        </div>
    </div>
</template>
