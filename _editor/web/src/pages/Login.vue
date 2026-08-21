<script setup lang="ts">
import { useTheme, Notice, type IconName, type NoticeModel } from "@intentic/ui";
import { noticeOf } from "@intentic/ui/async";
import Button from "primevue/button";
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useAuth } from "../composables/useAuth";
import { useGoogleIdentity } from "../composables/useGoogleIdentity";
import { desktopVersion, signInThroughBrowser } from "../environments/desktop";

const { signInWithGoogle, signInWithGoogleCredential } = useAuth();
const { getIdToken, renderButton } = useGoogleIdentity();
const { scheme } = useTheme();
const router = useRouter();

/* Inside the desktop app, the button below CANNOT work: Google refuses OAuth from an embedded webview, and
 * the redirect would dead-end on a `disallowed_useragent` page with no way back. So the app gets a different
 * button that hands the whole sign-in to the user's real browser and receives the result over a deep link
 * (see environments/desktop.ts). Same account, same session: just not in this window. */
const desktop = computed(() => desktopVersion() !== undefined);

const year = new Date().getFullYear();

// Four pillars laddering to the headline (sandbox, persistence, reach, environment) one line each:
// a sign-in page is read in a glance, so every body is short enough to hold a single line at this panel's
// measure and never wrap mid-thought.
const features: readonly { icon: IconName; title: string; description: string }[] = [
    {
        icon: `box`,
        title: `Its own sandbox`,
        description: `A container on hardware you control, one per agent.`,
    },
    {
        icon: `wave-pulse`,
        title: `Runs while you're away`,
        description: `Close the laptop, turns finish and terminals survive.`,
    },
    {
        icon: `globe`,
        title: `A window from any device`,
        description: `Reopen from any browser, or your phone, mid-run.`,
    },
    {
        icon: `sliders-h`,
        title: `A curated environment`,
        description: `Dev-tools installed, systems wired, context loaded.`,
    },
];

/* ONE GOOGLE SIGN-IN, NOT TWO.
 *
 * The redirect below proves the user to the platform and leaves this window holding nothing, which is why
 * the sandbox then asked for Google all over again: the daemon authenticates people against Google itself and
 * only the browser can hand it a Google-signed token. Minting that token HERE, and spending it on the
 * platform as well, means the second ask never happens.
 *
 * The credential the sandbox eventually receives is byte-for-byte what it receives today, so a daemon that is
 * older, forked, or deliberately built to distrust the platform is not affected by any of this.
 *
 * Google's own button is the control, because it is the one surface that works when One Tap does not. Four
 * things can go wrong. Three are observable and each answers with the redirect rather than a dead page:
 * Google's script never arrives (nothing renders), the user dismisses whatever Google shows, or the platform
 * refuses the token. The fourth: a button that renders but cannot work, behind a blocked frame or a popup
 * policy: is invisible from here, which is why the escape link below it is unconditional. */
const googleButton = ref<HTMLElement>();
/* Whether Google's own button is standing there. Starts true so the container is in the DOM for the very
 * first render: a button cannot be rendered into an element that does not exist, and flips to false when
 * the render is refused (Google's script absent, or this being the desktop webview, where the mechanism
 * refuses on every surface's behalf) or when the platform rejects what Google signed. */
const googleReady = ref(true);
const error = ref<NoticeModel | undefined>();

const redirectSignIn = async (): Promise<void> => {
    if (desktop.value) {
        signInThroughBrowser();
        return;
    }
    await signInWithGoogle();
};

/* The mint, started on mount so a click has something to resolve, and so a returning user is signed in with
 * no click at all, which is what Google's automatic re-authentication is for. It can only fire for someone
 * who has signed in this way here BEFORE, so a first-ever account still passes a visible Google surface and
 * the consent line under it. */
const signInWithCredential = async (): Promise<void> => {
    // The mechanism would refuse this window anyway; not starting is just not booting Google's script in a
    // window that can never use it.
    if (desktop.value) {
        return;
    }
    try {
        // `gate: false`, this page's own button IS the gate; the shared overlay would be a second one.
        const idToken = await getIdToken({ gate: false });
        if (idToken === undefined) {
            return; // Dismissed, or Google unavailable. The fallback below is already on screen.
        }
        await signInWithGoogleCredential(idToken);
        await router.push(`/`);
    } catch {
        /* The platform would not take a token Google did in fact sign: a build without the endpoint, or a
         * client-id mismatch between this app and that platform. The redirect does not depend on either, so
         * hand the user that rather than a dead end. The Google credential stays cached on purpose: the
         * sandbox may well accept what the platform just refused, and re-minting would be a third ask. */
        googleReady.value = false;
        error.value = noticeOf(`Couldn't finish that sign-in. Continue with Google below instead.`);
    }
};

onMounted(() => void signInWithCredential());

// Google's button, rendered as soon as its container exists (and re-rendered when the colour scheme flips,
// since its theme is baked in at render). A click resolves the mint above.
watch(
    [googleButton, scheme],
    async () => {
        if (googleButton.value === undefined) {
            return;
        }
        googleReady.value = await renderButton(googleButton.value, scheme.value === `dark`);
    },
    { flush: `post` },
);
</script>

<template>
    <div class="grid min-h-screen w-full bg-canvas text-content lg:grid-cols-2">
        <!-- Brand showcase: hidden on small screens. -->
        <aside
            class="relative hidden overflow-hidden border-r border-line bg-linear-to-br from-primary-600/15 via-canvas to-canvas lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-16"
        >
            <!-- Faint grid accent over the gradient. -->
            <div
                class="pointer-events-none absolute inset-0 opacity-[0.4]"
                style="
                    background-image: radial-gradient(circle at 1px 1px, var(--color-line-strong) 1px, transparent 0);
                    background-size: 28px 28px;
                    mask-image: radial-gradient(ellipse 80% 60% at 30% 20%, black, transparent);
                "
            ></div>

            <div class="animate-fade-in-up relative">
                <img src="/assets/intentic-full.png" alt="intentic platform" class="h-8 w-auto" />
            </div>

            <div class="animate-fade-in-up relative max-w-2xl" style="animation-delay: 60ms">
                <!-- The brand line, split as the site splits it, each block with `text-balance`: a line
                     narrow enough to wrap then splits evenly instead of dropping its last word alone under a
                     full line. 44px from 2xl up rather than 48px: this panel is half the viewport, so the
                     headline is capped below the site's display size to keep each sentence on one line. The
                     panel is max-w-2xl for the headline's sake; the paragraph keeps its own measure below. -->
                <h1 class="text-4xl font-semibold leading-tight tracking-tight 2xl:text-[2.75rem]">
                    <span class="block text-balance">You delegate. Agents work.</span>
                    <span class="block text-balance">You approve.</span>
                </h1>
                <p class="mt-5 max-w-xl text-base leading-relaxed text-pretty text-muted">
                    Your agents live on hardware you own and keep running when you look away. Every browser is a window onto the same fleet.
                </p>

                <ul class="mt-10 flex max-w-lg flex-col gap-4">
                    <li v-for="feature in features" :key="feature.title" class="flex items-start gap-3">
                        <span class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-overlay text-link">
                            <Icon :name="feature.icon" class="text-sm" />
                        </span>
                        <div>
                            <p class="text-sm font-medium text-content">{{ feature.title }}</p>
                            <p class="text-sm text-pretty text-muted">{{ feature.description }}</p>
                        </div>
                    </li>
                </ul>
            </div>

            <p class="animate-fade-in-up relative text-xs text-subtle" style="animation-delay: 120ms">
                © {{ year }} intentic platform. All rights reserved.
            </p>
        </aside>

        <!-- Sign-in panel. -->
        <main class="flex items-center justify-center p-6 sm:p-10">
            <div class="animate-fade-in w-full max-w-sm">
                <!-- Compact brand mark for mobile (brand panel is hidden there). -->
                <div class="mb-10 flex lg:hidden">
                    <img src="/assets/intentic-full.png" alt="intentic platform" class="h-8 w-auto" />
                </div>

                <div class="mb-8">
                    <h2 class="text-2xl font-semibold tracking-tight">Welcome back</h2>
                    <p class="mt-2 text-sm text-muted">Sign in to your intentic workspace.</p>
                </div>

                <Notice v-if="error" :of="error" class="mb-4" />

                <!-- Google's own button, which is also where the credential the sandbox needs comes from: one
                     sign-in doing both jobs. color-scheme:light matches Google's light-scheme button iframe so
                     the browser paints no opaque (white) canvas behind it; the button stays dark via its theme
                     param. Kept mounted (hidden) rather than removed when it fails to render, so nothing can
                     race the container away from under it. -->
                <div v-show="googleReady" ref="googleButton" class="flex justify-center" style="color-scheme: light"></div>

                <Button
                    v-if="!googleReady"
                    :label="desktop ? `Continue with Google in your browser` : `Continue with Google`"
                    severity="secondary"
                    class="w-full justify-center"
                    @click="redirectSignIn"
                >
                    <template #icon><Icon name="google" /></template>
                </Button>

                <!-- The escape hatch, always there while the embedded button is. Some of the ways that button
                     can fail are invisible from here: an extension that blocks its frame, a policy that lets
                     it render but not open, and every one of them looks to the visitor like a sign-in page
                     that does nothing. This is the way in that depends on none of it. -->
                <button
                    v-if="googleReady && !desktop"
                    type="button"
                    class="mt-4 w-full text-center text-xs text-subtle transition-colors hover:text-content"
                    @click="redirectSignIn"
                >
                    Trouble signing in? Use Google's own page.
                </button>

                <p class="mt-8 text-center text-xs leading-relaxed text-subtle">
                    <!-- Acceptable Use is named here rather than left to the Terms that incorporate it: it is the
                         document whose breach destroys a hosted machine without notice, and consent to a rule
                         with that consequence should be given to the rule itself. -->
                    By continuing you agree to our
                    <a href="https://intentic.dev/terms/" target="_blank" rel="noopener" class="text-link hover:underline">Terms</a>,
                    <a href="https://intentic.dev/acceptable-use/" target="_blank" rel="noopener" class="text-link hover:underline"
                        >Acceptable Use Policy</a
                    >
                    and
                    <a href="https://intentic.dev/privacy/" target="_blank" rel="noopener" class="text-link hover:underline">Privacy Policy</a>.
                </p>
            </div>
        </main>
    </div>
</template>
