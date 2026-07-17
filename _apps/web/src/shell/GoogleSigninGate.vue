<script setup lang="ts">
import { useTheme } from "@intentic-app/ui";
import { ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useAuth } from "../composables/useAuth";
import { useGoogleIdentity } from "../composables/useGoogleIdentity";
import { useSandbox } from "../composables/useSandbox";

/* The browser→sandbox sign-in surface. useGoogleIdentity raises `needsSignIn` whenever a Google ID token is
 * needed; this overlay then renders Google's own "Sign in" button (the sole sign-in path). A click resolves
 * the awaiting sandbox call automatically; "Back to setup" instead settles the awaiting mint and leaves for
 * the setup screen. Presentational over the composable — no token ever touches the platform. */

const { needsSignIn, renderButton, cancelSignIn } = useGoogleIdentity();
const { user } = useAuth();
const sandbox = useSandbox();
const router = useRouter();
const { scheme } = useTheme();

const btn = ref<HTMLElement>();

// Render Google's own button into the gate each time it opens: the v-if recreates the container, so the ref
// updates and this re-runs (flush: post, after DOM update) to mount a fresh button onto the live element.
// Depends on the color scheme too, so toggling theme while the gate is open re-renders it in the right theme.
watch(
    [needsSignIn, scheme],
    () => {
        if (needsSignIn.value && btn.value) {
            renderButton(btn.value, scheme.value === `dark`);
        }
    },
    { flush: `post` },
);

// Instead of signing in: settle the awaiting mint and return to setup for the active sandbox (the registry
// keeps its daemon-reported address — there is nothing to sever).
const backToSetup = async (): Promise<void> => {
    cancelSignIn();
    const active = sandbox.activeSandboxId.value;
    await router.push(active === undefined ? `/setup` : { path: `/setup`, query: { sandbox: active } });
};
</script>

<template>
    <div v-if="needsSignIn" class="fixed inset-0 z-50 flex items-center justify-center bg-canvas/70 p-6 backdrop-blur-sm">
        <div class="animate-fade-in w-full max-w-sm rounded-2xl border border-line bg-card p-6 shadow-xl">
            <div class="flex flex-col items-center gap-3 text-center">
                <span class="flex h-11 w-11 items-center justify-center rounded-xl bg-overlay text-link">
                    <Icon name="google" class="text-lg" />
                </span>
                <h2 class="text-lg font-semibold text-content">Sign in to reach your sandbox</h2>
                <p class="text-sm text-muted">
                    Continue with Google to securely connect the browser directly to your sandbox.
                    <template v-if="user?.email">
                        Use your intentic account — <span class="font-medium text-content">{{ user.email }}</span
                        >.
                    </template>
                </p>
                <!-- color-scheme:light matches Google's light-scheme button iframe so the browser paints no
                     opaque (white) canvas behind it; the button stays dark via its theme param. -->
                <div ref="btn" class="mt-2 flex justify-center" style="color-scheme: light"></div>
                <button type="button" class="mt-1 text-xs text-subtle transition-colors hover:text-content" @click="backToSetup">
                    Back to setup
                </button>
            </div>
        </div>
    </div>
</template>
