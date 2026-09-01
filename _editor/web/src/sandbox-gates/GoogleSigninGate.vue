<script setup lang="ts">
import { Button, useTheme, vAction, ui } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useAuth } from "../composables/useAuth";
import { useGoogleIdentity } from "../composables/useGoogleIdentity";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { desktopVersion, signInThroughBrowser } from "../environments/desktop";

/* The browser→sandbox sign-in surface. useGoogleIdentity raises `needsSignIn` whenever a Google ID token is
 * needed; this overlay then offers the way to mint one. A credential resolves the awaiting sandbox call
 * automatically; "Back to setup" instead settles the awaiting mint and leaves for the setup screen.
 * Presentational over the composable: no token ever touches the platform.
 *
 * TWO SURFACES, BECAUSE GOOGLE'S BUTTON IS DEAD IN THE DESKTOP APP'S WINDOW. Google refuses OAuth from an
 * embedded webview and Identity Services is FedCM-based, which that webview does not implement, so the
 * button rendered here fine and did NOTHING when clicked, on the one screen standing between a fresh install
 * and a working workspace. The login screen has always answered this by handing sign-in to the real browser
 * (environments/desktop.ts); this gate had not, and the same hole was open here every time the sandbox needed
 * Google again: a month away, an account switch, an adopted token that expired before a daemon existed to
 * spend it on. Same link, same round trip: the app signs in outside, comes back, and adopts the credential. */

const { needsSignIn, renderButton, cancelSignIn } = useGoogleIdentity();
const { user } = useAuth();
const sandbox = useSandbox();
const router = useRouter();
const { scheme } = useTheme();

const btn = ref<HTMLElement>();
const desktop = computed(() => desktopVersion() !== undefined);

/* Render Google's own button into the gate each time it opens: the v-if recreates the container, so the ref
 * updates and this re-runs (flush: post, after DOM update) to mount a fresh button onto the live element.
 * Depends on the color scheme too, so toggling theme while the gate is open re-renders it in the right theme.
 *
 * The CONTAINER is what this watches, not just the flag. Watching the flag alone assumed the gate was always
 * mounted before anything raised it: true when a mint starts from a click, false when one is already in
 * flight as this component mounts (a reload lands mid-establish). In that ordering the flag never changed, so
 * nothing ever rendered and the card came up empty: a sign-in gate with no way to sign in. */
watch(
    [needsSignIn, scheme, btn],
    () => {
        if (needsSignIn.value && btn.value && !desktop.value) {
            void renderButton(btn.value, scheme.value === `dark`);
        }
    },
    { flush: `post` },
);

/* Sign in the only way this window can. The app opens the platform's page in the default browser and returns
 * over its deep link, which reloads this SPA at the completion route, so the mint currently awaiting here
 * goes with the page rather than being resolved, and the adopted credential answers the call that follows. */
const signInOutside = (): void => signInThroughBrowser();

// Instead of signing in: settle the awaiting mint and return to setup for the active sandbox (the registry
// keeps its daemon-reported address: there is nothing to sever).
const backToSetup = async (): Promise<void> => {
    cancelSignIn();
    const active = sandbox.activeSandboxId.value;
    await router.push(active === undefined ? `/setup` : { path: `/setup`, query: { sandbox: active } });
};
</script>

<template>
    <div v-if="needsSignIn" class="fixed inset-0 z-50 flex items-center justify-center bg-canvas/70 p-6 backdrop-blur-sm">
        <div class="w-full max-w-sm rounded-2xl border border-line bg-card p-6 shadow-xl">
            <div class="flex flex-col items-center gap-3 text-center">
                <span class="flex h-11 w-11 items-center justify-center rounded-xl bg-overlay text-link">
                    <Icon name="google" class="text-lg" />
                </span>
                <h2 class="text-lg font-semibold text-content">Sign in to reach your sandbox</h2>
                <p class="text-sm text-muted">
                    <template v-if="desktop">Intentic signs you in through your browser, then brings you straight back here.</template>
                    <template v-else>Continue with Google to securely connect the browser directly to your sandbox.</template>
                    <template v-if="user?.email">
                        Use your intentic account: <span class="font-medium text-content">{{ user.email }}</span
                        >.
                    </template>
                </p>
                <!-- Inside the desktop app Google's own button renders and then does nothing when clicked, so
                     that window gets the hand-off to the real browser instead: the same one the login screen
                     offers there, and the only sign-in this webview can actually complete. -->
                <Button
                    v-if="desktop"
                    label="Continue with Google in your browser"
                    severity="secondary"
                    class="mt-2 w-full justify-center"
                    @click="signInOutside"
                >
                    <template #icon><Icon name="google" /></template>
                </Button>
                <!-- color-scheme:light matches Google's light-scheme button iframe so the browser paints no
                     opaque (white) canvas behind it; the button stays dark via its theme param. -->
                <div v-else ref="btn" class="mt-2 flex justify-center" style="color-scheme: light"></div>
                <button type="button" :class="ui.textAction(`mt-1 text-subtle`)" v-action="backToSetup">Back to setup</button>
            </div>
        </div>
    </div>
</template>
