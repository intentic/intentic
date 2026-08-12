<script setup lang="ts">
import type { IconName } from "@intentic/ui";
import Button from "primevue/button";
import { computed } from "vue";
import { useAuth } from "../composables/useAuth";
import { DESKTOP_SIGN_IN_LINK, desktopVersion, openDesktopLink } from "../environments/desktop";

const { signInWithGoogle } = useAuth();

/* Inside the desktop app, the button below CANNOT work: Google refuses OAuth from an embedded webview, and
 * the redirect would dead-end on a `disallowed_useragent` page with no way back. So the app gets a different
 * button that hands the whole sign-in to the user's real browser and receives the result over a deep link
 * (see environments/desktop.ts). Same account, same session — just not in this window. */
const desktop = computed(() => desktopVersion() !== undefined);

const year = new Date().getFullYear();

// Four pillars laddering to the headline — sandbox, persistence, reach, environment — one line each:
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
        description: `Close the laptop — turns finish and terminals survive.`,
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

const signIn = async (): Promise<void> => {
    if (desktop.value) {
        openDesktopLink(DESKTOP_SIGN_IN_LINK);
        return;
    }
    await signInWithGoogle();
};
</script>

<template>
    <div class="grid min-h-screen w-full bg-canvas text-content lg:grid-cols-2">
        <!-- Brand showcase — hidden on small screens. -->
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
                    <span class="block text-balance">You delegate. They work.</span>
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

                <Button
                    :label="desktop ? `Continue with Google in your browser` : `Continue with Google`"
                    severity="secondary"
                    :outlined="true"
                    class="w-full justify-center"
                    @click="signIn"
                >
                    <template #icon><Icon name="google" /></template>
                </Button>

                <p class="mt-8 text-center text-xs leading-relaxed text-subtle">
                    By continuing you agree to our
                    <a href="https://intentic.dev/terms/" target="_blank" rel="noopener" class="text-link hover:underline">Terms</a>
                    and
                    <a href="https://intentic.dev/privacy/" target="_blank" rel="noopener" class="text-link hover:underline">Privacy Policy</a>.
                </p>
            </div>
        </main>
    </div>
</template>
