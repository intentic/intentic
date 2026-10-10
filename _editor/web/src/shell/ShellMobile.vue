<script setup lang="ts">
import { useGettingStarted } from "../features/gettingStarted/useGettingStarted";
import { type PageBack, providePageBack, useDevice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import { useWallpaperedRoute } from "../skins/useWallpaper";
import MobileTabBar from "./MobileTabBar.vue";
import { useTabRoots } from "./mobileTabs";
import { onTabRoot } from "../lib/routes/tabRoots";
import SandboxGate from "../features/sandbox/gates/SandboxGate.vue";

// Mobile chrome: full-screen views over a bottom tab bar. h-dvh tracks the browser's UI chrome; the
// bar yields to the on-screen keyboard. No rail, chat column, or docked terminal: chat and terminal are
// full-screen routes, and the rail's tiles live on /menu.

const t = useT();
const { keyboardOpen } = useDevice();

// Undefined on a tab root or its own drill-down (mobileTabs.ts): those already carry their own back arrow.
// Otherwise steps back when history.state.back shows one exists, else falls back to Menu.
const route = useRoute();
const router = useRouter();
const tabRoots = useTabRoots();

const back = computed<PageBack | undefined>(() => {
    const panel = route.query[`panel`];
    if (onTabRoot({ path: route.path, panel: typeof panel === `string` ? panel : undefined }, tabRoots.value)) {
        return undefined;
    }
    const stepped = typeof router.options.history.state[`back`] === `string`;
    return {
        label: stepped ? t(`shell.shellMobile.back`) : t(`shell.shellMobile.backToMenu`),
        go: () => {
            if (stepped) {
                router.back();
                return;
            }
            void router.push(`/menu`);
        },
    };
});
providePageBack(back);
// The extension pages a wallpaper shows behind; painted on the scroller so the picture stays put as the page scrolls.
const wallpapered = useWallpaperedRoute();
// The getting-started checklist, started with the shell so every mark in every feature has an answer to read
// (features/tour/tourState.ts), whichever screen a first run opens on.
useGettingStarted();
</script>

<template>
    <div class="flex h-dvh flex-col overflow-hidden bg-canvas text-content" style="overscroll-behavior: none">
        <main class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <SandboxGate>
                <div class="min-h-0 flex-1 overflow-auto" :class="{ 'wallpaper-surface': wallpapered }" style="overscroll-behavior: contain">
                    <RouterView />
                </div>
            </SandboxGate>
        </main>
        <MobileTabBar v-show="!keyboardOpen" />
    </div>
</template>
