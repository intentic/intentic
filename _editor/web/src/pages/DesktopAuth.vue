<script setup lang="ts">
import { Button, useTheme, Notice, type NoticeModel, vAction } from "@intentic/ui";
import { noticeFrom, noticeOf } from "@intentic/ui/async";
import { onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { idTokenClaims } from "../composables/googleToken";
import { apiClient } from "../composables/useApi";
import { useAuth } from "../composables/useAuth";
import { useGoogleIdentity } from "../composables/useGoogleIdentity";
import { signInThroughBrowser } from "../environments/desktop";

/* SIGNING IN FOR THE DESKTOP APP: this page runs in the user's REAL BROWSER, never in the app's webview.
 *
 * The app opened it with `opener` because Google refuses OAuth from an embedded webview and Google Identity
 * Services is FedCM-based, which the Linux webview does not implement (see environments/desktop.ts). Here,
 * both are ordinary: the route's guard has already run the Better Auth sign-in, and GIS mints an ID token the
 * way it does on every other screen.
 *
 * EVERYTHING ON THIS PAGE IS A WAIT, so the two things that end one start as early as they can: the router
 * kicks the Google mint off before the session round trip (router/index.ts), and the button below is on
 * screen from the first frame instead of behind a timer. What the user sees is the whole product here.
 *
 * The two credentials are then parked on the platform for one pickup, and the app is handed the row's id:
 * NOT the credentials. A deep link is delivered as a process argument, readable by anything else running on
 * the machine, so the id is the only thing small and worthless enough to travel that way.
 *
 * `state` is the app's own nonce, echoed back untouched: it is how the app knows this handoff answers the
 * sign-in IT started, and not a link that arrived from somewhere else. */

const route = useRoute();
const { user, signInWithGoogle } = useAuth();
const { getIdToken, renderButton, adoptIdToken } = useGoogleIdentity();
const { scheme } = useTheme();

const error = ref<NoticeModel | undefined>(undefined);
const working = ref(false);
/* Which wait the user is in. They are different lengths and only one of them is theirs to end: `checking`
 * and `handing` are round trips to the platform, `signin` is Google and may need a click. Naming them apart
 * is what lets the Google button stand on the page during the one wait it can shorten, and, more to the
 * point, stay OFF it during the two it cannot. */
const stage = ref<`checking` | `signin` | `handing` | `done`>(`checking`);

const googleButton = ref<HTMLElement>();

/* How much life the credential must have left to be worth handing over. Google's tokens live about an hour,
 * so this asks for most of one: enough to cover an install that goes on to create and boot a sandbox before
 * anything can spend it. It is not a guarantee (nothing here can extend a Google token), which is why the
 * workspace's own sign-in gate now offers this same hand-off when the hour does run out. */
const HANDOFF_USABLE_FOR_MS = 45 * 60 * 1000;

/* THE CREDENTIAL THE PLATFORM ALREADY HOLDS: tried first, so the ordinary desktop sign-in shows no Google
 * surface at all. Arriving here means the user pressed sign in inside the app AND is signed in to this
 * platform in this browser; a Google button on top of that is a third act of consent for something they have
 * already twice agreed to, and it is the step people were getting stuck on.
 *
 * It is also the only escape that works when Google's in-page button CANNOT run: a blocked frame, an
 * extension, an origin Google is refusing. Those are invisible from this page: the button renders, takes the
 * click, and does nothing. Asking the platform costs one round trip and needs none of that machinery.
 *
 * The expiry is re-checked HERE rather than trusted, because this token leaves for another process that may
 * not spend it for a whole setup. Anything the daemon would reject on arrival is treated as nothing held, and
 * the Google button becomes the answer after all. Adopted into the shared cache on the way through: it is the
 * same credential this browser's own sandbox gate wants, so one fetch settles both. */
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
        // A platform without this route (an older or self-hosted build) is not an error here: it is simply
        // one that holds nothing, and the Google button below is exactly what that case already had.
        return undefined;
    }
};

/* Google's own page, as the last way out. Everything above can fail silently in a browser that will not run
 * Google's frame, and this depends on none of it: it is a full-page redirect, which is the one sign-in Google
 * accepts everywhere. It returns to THIS url (state and challenge intact) with the account's Google tokens
 * freshly stored, so the check above then answers on the first try and the hand-off completes by itself. */
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
    // Park the credentials for one pickup and send the app the row's id: never the credentials themselves.
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
        const held = await platformHeldToken();
        if (held !== undefined) {
            await deliver(held);
            return;
        }
        stage.value = `signin`;
        /* The daemon's credential, when the platform held none. `gate: false` because the button is already
         * ON this page: the shared overlay's job is to interrupt a screen that was doing something else, and
         * this screen is doing nothing else. The silent attempt (auto re-auth for a returning user) races that
         * button: whichever produces a credential first resolves this.
         *
         * `usableFor` because this token LEAVES: the app cannot spend it until it has a daemon to spend it
         * on, which after a fresh install is a whole setup away. A cached one with minutes left would satisfy
         * this page and strand the app, so anything shorter than the window below is re-minted here, where
         * Google is available and usually silent, rather than in the app's webview, where it is neither. */
        const idToken = await getIdToken({ gate: false, usableFor: HANDOFF_USABLE_FOR_MS });
        if (idToken === undefined) {
            error.value = noticeOf(`Intentic needs your Google sign-in to reach your sandbox.`);
            return;
        }
        await deliver(idToken);
    } catch (err) {
        error.value = noticeFrom(err, `Couldn't finish signing in to the app.`);
    } finally {
        working.value = false;
    }
};

/* Google's own button, on screen from the first frame rather than after a timer decides the silent attempt
 * failed. It costs nothing when it goes unused, and it is the only thing that can end the wait when the
 * silent attempt is blocked, which is the ordinary case in a browser that suppresses the FedCM prompt.
 * Re-rendered whenever the container reappears (a retry) or the colour scheme flips.
 *
 * A refusal means this page is somewhere it cannot work, and the one place that is true is the desktop
 * webview, which is exactly where this page's whole purpose says it should not be. So the answer is to send
 * it where it belongs rather than to leave an empty card: the app opens the real browser at this same page. */
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

            <Notice v-if="error" :of="error" />
            <p v-else-if="stage === `done`" class="flex items-start gap-2 text-xs text-muted">
                <Icon name="check-circle" class="mt-0.5 shrink-0 text-success" />
                <span>Sent to the app: you can close this tab. If nothing happened, make sure Intentic is running and try again.</span>
            </p>
            <p v-else-if="stage === `handing`" class="flex items-start gap-2 text-xs text-muted">
                <Icon name="spinner" spin class="mt-0.5 shrink-0" />
                <span>Handing your sign-in to the app…</span>
            </p>
            <!-- The ordinary path ends here and shows no Google surface at all: the user pressed sign in in the
                 app and is already signed in to this browser, so the credential is asked of the platform, not
                 of them. Only when that comes back empty does the Google block below appear. -->
            <p v-else-if="stage === `checking`" class="flex items-start gap-2 text-xs text-muted">
                <Icon name="spinner" spin class="mt-0.5 shrink-0" />
                <span>Finishing your sign-in…</span>
            </p>
            <!-- The sign-in wait. Google may answer it on its own (auto re-auth for a returning user, no click
                 at all); when it doesn't, this button is the only thing that can, so it is here from the start.
                 color-scheme:light matches Google's light-scheme button iframe so the browser paints no opaque
                 (white) canvas behind it; the button stays dark via its theme param. -->
            <template v-else>
                <p class="text-xs text-muted">
                    <template v-if="googleReady">Continue with Google to hand this sign-in to the app.</template>
                    <template v-else>This page has to run in your browser: Google won't sign you in inside an app window.</template>
                </p>
                <div v-show="googleReady" ref="googleButton" class="flex justify-center" style="color-scheme: light"></div>
                <Button v-if="!googleReady" label="Open this in your browser" severity="secondary" class="self-start" @click="signInThroughBrowser" />

                <!-- Unconditional, for the same reason the login page's is. A button that renders but cannot
                     work (a blocked frame, a policy, an origin Google has stopped accepting) is invisible
                     from this page, and every one of those looks identical to a screen that simply does
                     nothing. This way out depends on none of that machinery: a full-page redirect, back to
                     this same link, after which the check above answers on its own. -->
                <button
                    v-if="googleReady"
                    type="button"
                    class="w-full text-center text-xs text-subtle transition-colors hover:text-content"
                    v-action="useGooglesOwnPage"
                >
                    Trouble signing in? Use Google's own page.
                </button>
            </template>

            <Button
                v-if="error || stage === `done`"
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
