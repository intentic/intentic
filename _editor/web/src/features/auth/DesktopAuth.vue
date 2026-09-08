<script setup lang="ts">
import { Button, useTheme, Notice, type NoticeModel, vAction, ui } from "@intentic/ui";
import { noticeFrom, noticeOf } from "@intentic/ui/async";
import { onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { idTokenClaims } from "./googleToken";
import { apiClient } from "../../lib/useApi";
import { useAuth } from "./useAuth";
import { useGoogleIdentity } from "./useGoogleIdentity";
import { signInThroughBrowser } from "../../app/environments/desktop";
import AppBrand from "../../components/AppBrand.vue";

// Runs in the user's real browser, not the app's webview (Google refuses OAuth there; see environments/desktop.ts).
// Session handling is this page's own job, not a route guard's: bouncing a signed-out window to /login would sign
// in the wrong browser while the app that asked stays stuck. Only the handoff row's id crosses to the app, never
// the credentials; `state` is the app's nonce, echoed back to match.

const route = useRoute();
const { user, refresh, signInWithGoogle, signInWithGoogleCredential } = useAuth();
const { getIdToken, renderButton, adoptIdToken } = useGoogleIdentity();
const { scheme } = useTheme();

const error = ref<NoticeModel | undefined>(undefined);
const working = ref(false);
// Which wait the user is in; only `signin` (Google) can need a click, so only then does the button show.
const stage = ref<`checking` | `signin` | `handing` | `done`>(`checking`);

const googleButton = ref<HTMLElement>();

// Minimum life left to hand over a token; Google's last about an hour, most of which this asks for.
const HANDOFF_USABLE_FOR_MS = 45 * 60 * 1000;

// Tried first when there's a session, avoiding a redundant Google consent. Re-checks expiry since the token leaves
// for a process that may not spend it soon; too-close-to-expiring counts as nothing held, and a live pull is
// cached for this browser too.
const platformHeldToken = async (): Promise<string | undefined> => {
    try {
        const { idToken } = await apiClient.desktop.googleIdToken();
        if (idToken === undefined || idToken === ``) {
            return undefined;
        }
        const claims = idTokenClaims(idToken);
        if (claims === undefined || Date.now() >= claims.expiresAt - HANDOFF_USABLE_FOR_MS) {
            return undefined;
        }
        adoptIdToken(idToken);
        return idToken;
    } catch {
        // An older or self-hosted platform without this route isn't an error, just one that holds nothing.
        return undefined;
    }
};

// Checked first: a sessionless call gets a 401, tearing down the signed-in runtime and cancelling the Google mint
// the router started. An unreachable platform also answers false, since nothing further can work anyway.
const platformSession = async (): Promise<boolean> => {
    if (user.value !== null) {
        return true;
    }
    try {
        return (await refresh()) !== null;
    } catch {
        return false;
    }
};

// Last resort: a full-page redirect works even where Google's in-page frame won't run. Returns to this same URL
// with fresh tokens stored, so the check above then succeeds on its own.
const useGooglesOwnPage = async (): Promise<void> => {
    await signInWithGoogle(route.fullPath);
};

const hand = async (): Promise<void> => {
    const state = route.query[`state`];
    const challenge = route.query[`challenge`];
    if (typeof state !== `string` || state === `` || typeof challenge !== `string` || challenge === ``) {
        error.value = noticeOf(`This link is missing the value that ties it to your app: open Intentic and sign in from there.`);
        return;
    }
    // Parks the credential for one pickup; the app receives only the row's id, never the credential itself.
    const deliver = async (idToken: string): Promise<void> => {
        stage.value = `handing`;
        const { handoff } = await apiClient.desktop.handoff({ idToken, challenge });
        stage.value = `done`;
        globalThis.location.href = `intentic://auth?handoff=${encodeURIComponent(handoff)}&state=${encodeURIComponent(state)}`;
    };
    working.value = true;
    error.value = undefined;
    stage.value = `checking`;
    try {
        const session = await platformSession();
        const held = session ? await platformHeldToken() : undefined;
        if (held !== undefined) {
            await deliver(held);
            return;
        }
        stage.value = `signin`;
        // `gate: false`: this page's own button is already up, so the shared overlay is redundant; a silent re-auth
        // attempt races it. `usableFor`: the token leaves for the app, which may be a whole setup away from having a
        // daemon to spend it on, so a nearly-expired one is re-minted here instead.
        const idToken = await getIdToken({ gate: false, usableFor: HANDOFF_USABLE_FOR_MS });
        if (idToken === undefined) {
            error.value = noticeOf(`Intentic needs your Google sign-in to reach your sandbox.`);
            return;
        }
        // Only runs when there was no session: the freshly minted token both signs this browser in and is the
        // credential
        // the daemon verifies, the same trade the login screen makes. A refusal (client-id mismatch, no endpoint) falls
        // to
        // the catch below, which offers Google's own page instead.
        if (!session) {
            stage.value = `handing`;
            await signInWithGoogleCredential(idToken);
        }
        await deliver(idToken);
    } catch (err) {
        error.value = noticeFrom(err, `Couldn't finish signing in to the app.`);
    } finally {
        working.value = false;
    }
};

// Shown from the first frame rather than after a timer; the silent attempt is often blocked (a suppressed FedCM
// prompt), and this is the only thing that can then end the wait. A render refusal means this is running in the
// desktop webview, so the fallback opens the real browser instead.
const googleReady = ref(true);

watch(
    [stage, scheme, googleButton],
    async () => {
        if (stage.value === `signin` && googleButton.value) {
            googleReady.value = await renderButton(googleButton.value, scheme.value === `dark`);
        }
    },
    { flush: `post`, immediate: true },
);

// Automatic: reaching this page already means the app's button was pressed; asking again would be redundant.
onMounted(() => void hand());
</script>

<template>
    <div class="flex min-h-dvh w-full items-center justify-center bg-canvas px-4 text-content">
        <div class="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-line bg-surface p-6">
            <header class="flex items-center gap-3">
                <span
                    class="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-primary-600/30 bg-linear-to-br from-primary-600/20 to-primary-600/5"
                >
                    <AppBrand shape="mark" class="text-base" />
                </span>
                <div class="min-w-0">
                    <h1 class="text-lg font-semibold">Signing in to the Intentic app</h1>
                    <!--
                        Shown only once there's an account; a browser that was never signed in gets one from the
                        credential below.
                    -->
                    <p v-if="user" class="truncate text-xs text-muted">{{ user.email }}</p>
                </div>
            </header>

            <Notice v-if="error" :of="error" />
            <p v-else-if="stage === `done`" class="flex items-start gap-2 text-xs text-muted">
                <Icon name="check-circle" class="mt-0.5 shrink-0 text-success" />
                <span>Sent to the app: you can close this tab. If nothing happened, make sure Intentic is running and try again.</span>
            </p>
            <p v-else-if="stage === `handing`" class="flex items-start gap-2 text-xs text-muted">
                <Icon name="spinner" spin class="mt-0.5 shrink-0" />
                <span>Handing your sign-in to the app…</span>
            </p>
            <!--
                The ordinary path: already signed in, so the credential is asked of the platform, not the user; the
                Google block
                below appears only if that comes back empty.
            -->
            <p v-else-if="stage === `checking`" class="flex items-start gap-2 text-xs text-muted">
                <Icon name="spinner" spin class="mt-0.5 shrink-0" />
                <span>Finishing your sign-in…</span>
            </p>
            <!--
                Google may resolve this silently, or need this button; it's on screen from the start either way.
                color-scheme:light matches Google's button iframe so no opaque white canvas shows behind it; the button
                itself
                stays dark via its theme param.
            -->
            <template v-else>
                <p class="text-xs text-muted">
                    <template v-if="googleReady">Continue with Google to hand this sign-in to the app.</template>
                    <template v-else>This page has to run in your browser: Google won't sign you in inside an app window.</template>
                </p>
                <div v-show="googleReady" ref="googleButton" class="flex justify-center" style="color-scheme: light"></div>
                <Button v-if="!googleReady" label="Open this in your browser" severity="secondary" class="self-start" @click="signInThroughBrowser" />

                <!--
                    Unconditional, like the login page's: a button that renders but can't work (blocked frame, policy,
                    rejected
                    origin) looks identical to one doing nothing. This path is a full-page redirect that needs none of
                    that
                    machinery.
                -->
                <button
                    v-if="googleReady"
                    type="button"
                    :class="ui.textAction(`w-full justify-center text-center text-subtle`)"
                    v-action="useGooglesOwnPage"
                >
                    Trouble signing in? Use Google's own page.
                </button>
            </template>

            <!--
                Both options after a failure, since retrying alone repeats what just failed (often the platform
                refusing the
                token); Google's own page bypasses that path entirely. Same pair the login screen offers.
            -->
            <div v-if="error || stage === `done`" class="flex flex-wrap items-center gap-3">
                <Button :label="error ? `Try again` : `Send it again`" severity="secondary" :loading="working" @click="hand" />
                <button v-if="error" type="button" :class="ui.textAction(`text-subtle`)" v-action="useGooglesOwnPage">Use Google's own page.</button>
            </div>

            <p class="border-t border-line pt-3 text-2xs text-subtle">
                This page exists because Google won't sign you in inside an app window. Nothing is shared with the app beyond this one sign-in.
            </p>
        </div>
    </div>
</template>
