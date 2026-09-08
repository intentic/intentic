<script setup lang="ts">
import { Button, useTheme, vAction, ui } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useAuth } from "../../auth/useAuth";
import { useGoogleIdentity } from "../../auth/useGoogleIdentity";
import { useSandbox } from "../client/useSandbox";
import { desktopVersion, signInThroughBrowser } from "../../../app/environments/desktop";

// The sign-in overlay: useGoogleIdentity raises `needsSignIn` when a token is needed, and this offers the way to
// mint one; no token touches the platform here. Two surfaces, since Google's button does nothing inside the
// desktop app's webview: that window hands off to the real browser and adopts the credential on return.

const { needsSignIn, renderButton, cancelSignIn } = useGoogleIdentity();
const { user } = useAuth();
const sandbox = useSandbox();
const router = useRouter();
const { scheme } = useTheme();

const btn = ref<HTMLElement>();
const desktop = computed(() => desktopVersion() !== undefined);

// Watches the container itself, not just the flag: a mint already in flight when mounted never toggles it.
watch(
    [needsSignIn, scheme, btn],
    () => {
        if (needsSignIn.value && btn.value && !desktop.value) {
            void renderButton(btn.value, scheme.value === `dark`);
        }
    },
    { flush: `post` },
);

// Opens the platform's sign-in page in the default browser; the deep-link return reloads this SPA, abandoning the
// mint awaited here, and the adopted credential answers the call that follows instead.
const signInOutside = (): void => signInThroughBrowser();

// Settles the awaiting mint and returns to setup instead of signing in; nothing needs severing.
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
                <!-- Google's own button does nothing when clicked here, so the desktop app hands off to the real browser instead. -->
                <Button
                    v-if="desktop"
                    label="Continue with Google in your browser"
                    severity="secondary"
                    class="mt-2 w-full justify-center"
                    @click="signInOutside"
                >
                    <template #icon><Icon name="google" /></template>
                </Button>
                <!-- `color-scheme: light` matches Google's button iframe so the browser paints no opaque canvas behind it. -->
                <div v-else ref="btn" class="mt-2 flex justify-center" style="color-scheme: light"></div>
                <button type="button" :class="ui.textAction(`mt-1 text-subtle`)" v-action="backToSetup">Back to setup</button>
            </div>
        </div>
    </div>
</template>
