<!-- Where the browser's handoff lands, inside the app: the same entry material, at the size of a two-second wait. -->
<script setup lang="ts">
import { AppBrand, Button, Notice, type NoticeModel } from "@intentic/ui";
import { noticeFrom, noticeOf } from "@intentic/ui/async";
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiClient } from "../../lib/useApi";
import { useAuth } from "../../client/auth/useAuth";
import { useGoogleIdentity } from "../../client/auth/useGoogleIdentity";
import { environment } from "../../app/environments/environment";
import { openAgentOnThisComputer } from "../../app/environments/desktop";
import { useT } from "@intentic/ui/i18n";

// This page runs inside the desktop app's webview, which starts with no session.
// 1. Redeem the row the browser parked (single use).
// 2. Verify the Better Auth one-time token at /api/auth/one-time-token/verify; its Set-Cookie gives this webview a
//    session over an ordinary HTTP round trip, nothing injected from Rust.
// 3. Adopt the Google ID token into the shared cache, so the first daemon call gets a session that renews silently.
//    An account with no Google sign-in carries none: its daemon sessions come from the platform's identity assertions,
//    which this webview asks for with the session step 2 gave it.
// 4. `back=agent` (auth.rs `complete_path`): the sign-in began on a folder of this computer, not here. The workspace
//    still has to mount — it is what tells the app who signed in and which sandboxes the account has
//    (`announceDesktopRoster`) — and then the reader is handed back to that folder's own window. Without this step a
//    reader who pressed "Work on this with an agent" ended up on the account's sandbox list, with nothing on screen
//    about the folder they asked about and no sign that anything had been started for it.
// A failure is terminal for this link; retry means signing in again, not reloading the link.

const t = useT();

const route = useRoute();
const router = useRouter();
const { refresh } = useAuth();
const { adoptIdToken } = useGoogleIdentity();

const error = ref<NoticeModel | undefined>(undefined);

const complete = async (): Promise<void> => {
    const handoff = route.query[`handoff`];
    const verifier = route.query[`verifier`];
    if (typeof handoff !== `string` || handoff === `` || typeof verifier !== `string` || verifier === ``) {
        error.value = noticeOf(t(`auth.desktopAuthComplete.linkIncomplete`));
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
            error.value = noticeOf(t(`auth.desktopAuthComplete.expired`));
            return;
        }
        if (idToken !== undefined && !adoptIdToken(idToken)) {
            error.value = noticeOf(t(`auth.desktopAuthComplete.expired`));
            return;
        }
        await refresh();
        await router.replace(`/`);
        if (route.query[`back`] === `agent`) {
            openAgentOnThisComputer();
        }
    } catch (err) {
        error.value = noticeFrom(err, t(`auth.desktopAuthComplete.couldntFinish`));
    }
};

onMounted(() => void complete());
</script>

<template>
    <div class="entry arrival">
        <div class="entry-plate" aria-hidden="true"><div class="entry-plate-img"></div></div>

        <main class="shell">
            <header class="mark"><AppBrand /></header>

            <!-- No frame and no rail while it works: nothing is being asked, so there is nothing to put a frame round. -->
            <template v-if="error === undefined">
                <div class="entry-seal entry-seal-turning" aria-hidden="true">
                    <span class="entry-seal-ring"></span>
                    <span class="entry-seal-sweep"></span>
                    <AppBrand shape="mark" class="entry-seal-mark" />
                </div>
                <p class="say" role="status">{{ t(`auth.desktopAuthComplete.signingIn`) }}</p>
            </template>

            <!-- A failure is terminal for this link, so the frame comes up around the one thing left to do. -->
            <section v-else class="entry-frame gate">
                <span class="entry-corner entry-corner-tl"></span>
                <span class="entry-corner entry-corner-tr"></span>
                <span class="entry-corner entry-corner-bl"></span>
                <span class="entry-corner entry-corner-br"></span>
                <Notice :of="error" class="rounded-none text-left" />
                <Button
                    :label="t(`auth.desktopAuthComplete.backToSignIn`)"
                    tier="boring"
                    class="mt-4 self-center"
                    @click="void router.replace(`/login`)"
                />
            </section>
        </main>
    </div>
</template>

<style scoped>
/* Layout only; the plate, metals and seal are shared material in styles/entry.css. */
.arrival {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: clamp(1rem, 2.5vw, 2rem) 1.5rem;
}
.shell {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    max-width: 30rem;
    margin: auto;
    text-align: center;
}
.mark {
    font-size: 1.375rem;
    margin-bottom: clamp(1.5rem, 5vh, 2.75rem);
}
.say {
    font-size: 0.9375rem;
    color: var(--ink-muted);
}
.gate {
    display: flex;
    flex-direction: column;
    width: 100%;
    padding: 1.75rem 1.75rem 1.5rem;
}
</style>
