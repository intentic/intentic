<script setup lang="ts">
import type { IconName } from "@intentic-app/ui";
import Button from "primevue/button";
import { useAuth } from "../composables/useAuth";

const { signInWithGoogle } = useAuth();

const year = new Date().getFullYear();

const features: readonly { icon: IconName; title: string; description: string }[] = [
    {
        icon: `box`,
        title: `Its own sandbox`,
        description: `A full workspace in a container on hardware you control — one per agent. Not a chat window: a machine the agent actually works on.`,
    },
    {
        icon: `sliders-h`,
        title: `A curated environment`,
        description: `The libraries and dev-tools the job needs, baked into the image and really installed. The agent proposes the layer; it ships on your approval.`,
    },
    {
        icon: `sitemap`,
        title: `Access to your systems`,
        description: `GitHub, databases, Sentry, Stripe, SSH hosts, MCP servers — added in a click. Credentials stay in the sandbox.`,
    },
    {
        icon: `list-check`,
        title: `Curated context`,
        description: `Skills, runbooks, repos, and house style scoped to this one job, loaded every turn — not a generic dump.`,
    },
];

const signIn = async (): Promise<void> => {
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

            <div class="animate-fade-in-up relative max-w-md" style="animation-delay: 60ms">
                <h1 class="text-4xl font-semibold leading-tight tracking-tight xl:text-5xl">
                    An IDE for your agents. A window for you.
                </h1>
                <p class="mt-4 text-base leading-relaxed text-muted">
                    Everyone else lets you edit the prompt. intentic lets you see and change the whole environment your agents work in — the
                    dev-tools really installed, the systems they can reach, the context they load every turn. Run one, or ten in parallel, on
                    hardware you own.
                </p>

                <ul class="mt-10 flex flex-col gap-5">
                    <li v-for="feature in features" :key="feature.title" class="flex items-start gap-3">
                        <span class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-overlay text-link">
                            <Icon :name="feature.icon" class="text-sm" />
                        </span>
                        <div>
                            <p class="text-sm font-medium text-content">{{ feature.title }}</p>
                            <p class="text-sm text-muted">{{ feature.description }}</p>
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

                <Button label="Continue with Google" severity="secondary" :outlined="true" class="w-full justify-center" @click="signIn">
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
