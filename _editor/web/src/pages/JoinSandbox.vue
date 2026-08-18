<script setup lang="ts">
import Button from "primevue/button";
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { setGuestAccess } from "../composables/sandbox/guestAccess";
import { useGoogleIdentity } from "../composables/useGoogleIdentity";
import { joinRefusal, readJoinLink } from "./joinLink";
import type { GrantedRole } from "@intentic/sandbox-contract";

/* JOINING A SANDBOX BY LINK — the whole outsider path, on one page, and the only screen in this app that
 * talks to a box the platform has never heard of.
 *
 * The link carries two things and this page spends both: the box's address, and a secret the box minted. It
 * asks Google who the visitor is, hands the box the pair, and the box does the one thing it can do with them
 * — put that verified email on its own members list at the role the link carried. From the next request on,
 * this browser is an ordinary member: the daemon session, the role floors and every gate behave exactly as
 * they do for the owner, because they are the same code paths.
 *
 * WHAT THIS PAGE IS NOT: a sign-up. Nothing is created on the platform, no account exists afterwards, and
 * closing the tab leaves nothing behind but the membership the owner can see and remove. */

const router = useRouter();
const { getIdToken } = useGoogleIdentity();

type State = `working` | `invalid` | `failed`;
const state = ref<State>(`working`);
const detail = ref<string>(``);
// Kept so "Try again" can re-run the same link without the visitor going back to their chat app for it.
const link = ref<{ daemonUrl: string; secret: string }>();

const join = async (): Promise<void> => {
    const parsed = link.value;
    if (parsed === undefined) {
        state.value = `invalid`;
        return;
    }
    state.value = `working`;
    detail.value = ``;
    /* Raises the app-wide Google gate (App.vue) when there is no fresh credential, and resolves once the
     * visitor signs in. `undefined` means they dismissed it — not an error, just an unfinished sign-in. */
    const idToken = await getIdToken();
    if (idToken === undefined) {
        state.value = `failed`;
        detail.value = `Signing in was not completed. This sandbox only opens for a signed-in person, so the link needs a Google account.`;
        return;
    }
    let response: Response;
    try {
        response = await fetch(`${parsed.daemonUrl}/join`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ secret: parsed.secret, idToken }),
        });
    } catch {
        state.value = `failed`;
        detail.value = `That sandbox could not be reached. It may be switched off — whoever sent the link can tell you when it is back.`;
        return;
    }
    const body = (await response.json().catch(() => ({}))) as { email?: string; role?: GrantedRole; error?: string };
    if (!response.ok) {
        state.value = `failed`;
        detail.value = joinRefusal(response.status, body.error ?? ``);
        return;
    }
    if (body.email === undefined || body.role === undefined) {
        state.value = `failed`;
        detail.value = `The sandbox answered something this app did not understand. It may be running an older version than this link expects.`;
        return;
    }
    setGuestAccess({
        daemonUrl: parsed.daemonUrl,
        role: body.role,
        email: body.email,
        joinedAt: new Date().toISOString(),
        name: new URL(parsed.daemonUrl).hostname.split(`.`)[0] ?? new URL(parsed.daemonUrl).hostname,
    });
    /* Straight in, and REPLACE rather than push: the link is spent, so leaving it in history would put a
     * secret behind the back button and offer a second redemption of something already redeemed. */
    await router.replace(`/`);
};

onMounted(() => {
    link.value = readJoinLink(globalThis.location.hash);
    void join();
});
</script>

<template>
    <div class="flex min-h-screen items-center justify-center bg-canvas p-6">
        <div class="w-full max-w-sm rounded-2xl border border-line bg-card p-6 text-center shadow-xl">
            <template v-if="state === 'working'">
                <h1 class="text-lg font-semibold text-content">Joining the sandbox…</h1>
                <p class="mt-2 text-sm text-muted">Sign in with Google to finish. The sandbox checks who you are itself.</p>
            </template>

            <template v-else-if="state === 'invalid'">
                <h1 class="text-lg font-semibold text-content">This link is incomplete</h1>
                <p class="mt-2 text-sm text-muted">
                    It may have been cut short on the way to you — chat apps sometimes shorten long links. Ask for it again, and open it whole.
                </p>
            </template>

            <template v-else>
                <h1 class="text-lg font-semibold text-content">Could not join</h1>
                <p class="mt-2 text-sm text-muted">{{ detail }}</p>
                <Button label="Try again" severity="secondary" class="mt-4 w-full justify-center" @click="join" />
            </template>
        </div>
    </div>
</template>
