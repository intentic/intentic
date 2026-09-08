<script setup lang="ts">
import { type PageBack, providePageBack, useDevice } from "@intentic/ui";
import { computed } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import MobileTabBar from "./MobileTabBar.vue";
import { onTabRoot, useTabRootPaths } from "./mobileTabs";
import SandboxGate from "../features/sandbox/gates/SandboxGate.vue";

// Mobile chrome: full-screen views over a bottom tab bar. h-dvh tracks the browser's UI chrome; the
// bar yields to the on-screen keyboard. No rail, chat column, or docked terminal: chat and terminal are
// full-screen routes, and the rail's tiles live on /menu.

const { keyboardInset } = useDevice();

// Undefined on a tab root or its own drill-down (mobileTabs.ts): those already carry their own back arrow.
// Otherwise steps back when history.state.back shows one exists, else falls back to Menu.
const route = useRoute();
const router = useRouter();
const tabRoots = useTabRootPaths();

const back = computed<PageBack | undefined>(() => {
    if (onTabRoot(route.path, tabRoots.value)) {
        return undefined;
    }
    const stepped = typeof router.options.history.state[`back`] === `string`;
    return {
        label: stepped ? `Back` : `Back to Menu`,
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
</script>

<template>
    <div class="flex h-dvh flex-col overflow-hidden bg-canvas text-content" style="overscroll-behavior: none">
        <main class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <SandboxGate>
                <div class="min-h-0 flex-1 overflow-auto scrollbar-thin" style="overscroll-behavior: contain">
                    <RouterView />
                </div>
            </SandboxGate>
        </main>
        <MobileTabBar v-show="keyboardInset === 0" />
    </div>
</template>
