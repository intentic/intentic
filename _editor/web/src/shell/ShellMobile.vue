<script setup lang="ts">
import { type PageBack, providePageBack, useDevice } from "@intentic/ui";
import { computed } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import MobileTabBar from "./MobileTabBar.vue";
import { onTabRoot, useTabRootPaths } from "./mobileTabs";
import SandboxGate from "../sandbox-gates/SandboxGate.vue";

/* The mobile chrome: full-screen views over a bottom tab bar. h-dvh (not h-screen) tracks the browser UI
 * chrome; the tab bar yields to the on-screen keyboard so composers keep the room. The desktop grid's rail,
 * chat column, and docked terminal have no mobile equivalents: chat and terminal are full-screen routes,
 * the rail's tiles live on /menu. */

const { keyboardInset } = useDevice();

/* THE WAY OUT, published from here because here is the only place that knows there is nothing else offering
 * one. A phone shows one view at a time and the bar below has four addresses; every OTHER route — the hubs,
 * a capability card, an extension's area — was reachable forwards only. Tapping Menu is not the way back: it
 * goes to the menu whether or not that is where the reader came from, and a deep link (a push notification, a
 * chat card's link, a shared URL) never came from anywhere in this app at all.
 *
 * NOT ON A TAB'S OWN SCREEN, and not on a drill-down inside one: /agents/:id and the workspace's file views
 * carry their own back arrow against their own list, which is a different journey from this one and is already
 * right. mobileTabs.ts answers which paths those are, so the bar and this cannot disagree about where Review
 * lives.
 *
 * BACK, OR HOME. `history.state.back` is set only when this entry was pushed from another one inside the app,
 * so it is the honest test for "there is somewhere to step back TO": with it, the arrow undoes the navigation
 * that got here (and the OS back gesture does the same thing, which is the point); without it — a cold deep
 * link — stepping back would leave the app entirely, so the arrow goes to the menu, the surface every one of
 * these routes is listed on. */
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
