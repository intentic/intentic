<script setup lang="ts">
import { useGettingStarted } from "../features/gettingStarted/useGettingStarted";
import { type PageBack, providePageBack, useDevice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import { useWallpaperedRoute } from "../skins/useWallpaper";
import MobileRail from "./MobileRail.vue";
import { ownsWayBack, PHONE_HOME } from "../lib/routes/phoneScreens";
import SandboxGate from "../features/sandbox/gates/SandboxGate.vue";
import { useEdgeBack } from "./edgeBack";
import { useKeybindings } from "../workbench/commands/useKeybindings";

// Mobile chrome: two screens and the places between them. The board (/agents) is home, with the rail down its left
// (MobileRail.vue) holding every other place; a conversation (/agents/:id) is the board's drill-down, back by its own
// arrow. Everything else is a full-screen page the rail opened, with the way back drawn at its top. h-dvh tracks the
// browser's UI chrome. No tab bar, chat column, or docked terminal: chat and terminal are full-screen routes.

const t = useT();
const { keyboardOpen } = useDevice();

const route = useRoute();
const router = useRouter();
// The board itself, where the rail is drawn. Not its drill-downs: a conversation keeps the whole width of the screen.
const onBoard = computed(() => route.path === PHONE_HOME);

// Undefined on the board and a conversation under it: the board is home, and a conversation's screen carries its own
// arrow. Otherwise steps back when history.state.back shows one exists, else falls back to the board.
const back = computed<PageBack | undefined>(() => {
    if (ownsWayBack(route.path)) {
        return undefined;
    }
    const stepped = typeof router.options.history.state[`back`] === `string`;
    return {
        label: stepped ? t(`shell.shellMobile.back`) : t(`agents.agentDetail.backToAgents`),
        go: () => {
            if (stepped) {
                router.back();
                return;
            }
            void router.push(PHONE_HOME);
        },
    };
});
providePageBack(back);

// The same way back, from the page's left edge (edgeBack.ts): the shell's back where it draws one, and on an agent's
// screen the board, where that screen's own arrow goes (AgentDetail's link to /agents, which it pushes, so this does too).
const surface = ref<HTMLElement>();
const page = ref<HTMLElement>();
const scrim = ref<HTMLElement>();
const chip = ref<HTMLElement>();
useEdgeBack({
    surface,
    page,
    scrim,
    chip,
    back: () => back.value?.go ?? (route.path.startsWith(`/agents/`) ? () => router.push(`/agents`) : undefined),
    route: () => route.fullPath,
});
// The extension pages a wallpaper shows behind; painted on the scroller so the picture stays put as the page scrolls.
const wallpapered = useWallpaperedRoute();
// The getting-started checklist, started with the shell so every mark in every feature has an answer to read
// (features/tour/tourState.ts), whichever screen a first run opens on.
useGettingStarted();
// The same keystroke dispatcher the desktop shell installs. The shell's own commands are desktop-only, but a surface
// that claims keys of its own (the review pass's j/k/v, reviewKeys.ts) does so through the registry, and a narrow
// window or a tablet with a keyboard lands here.
useKeybindings();
</script>

<template>
    <!-- The foot of the screen keeps clear of the home indicator: a chat's composer
         and the board's floating press both sit there. Not while the keyboard is up, which covers that strip. -->
    <div
        class="flex h-dvh flex-col overflow-hidden bg-canvas text-content"
        :class="{ 'pb-[env(safe-area-inset-bottom)]': !keyboardOpen }"
        style="overscroll-behavior: none"
    >
        <main id="main-content" ref="surface" tabindex="-1" class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <!-- What an edge swipe uncovers (edgeBack.ts): the place a release goes back to, darker while the page still
                 covers most of it, and the arrow that fills once letting go would go there. Hidden unless a swipe is on. -->
            <div aria-hidden="true" class="pointer-events-none invisible absolute inset-0 bg-canvas">
                <div ref="scrim" class="absolute inset-0 bg-black/25" />
                <span ref="chip" class="edge-chip absolute left-3 top-1/2 -mt-5 flex h-10 w-10 items-center justify-center rounded-full opacity-0">
                    <Icon name="arrow-left" class="text-base" />
                </span>
            </div>
            <div ref="page" class="relative flex min-h-0 min-w-0 flex-1 bg-canvas">
                <!-- Outside the gate, as the desktop's rail is: a sandbox that stopped answering still has a way to another. -->
                <MobileRail v-if="onBoard" />
                <div class="relative flex min-h-0 min-w-0 flex-1 flex-col">
                    <SandboxGate>
                        <div class="min-h-0 flex-1 overflow-auto" :class="{ 'wallpaper-surface': wallpapered }" style="overscroll-behavior: contain">
                            <RouterView />
                        </div>
                    </SandboxGate>
                </div>
            </div>
        </main>
    </div>
</template>

<style scoped>
/* The back swipe's arrow: a quiet disc while the release would still spring back, the accent fill once it would go. */
.edge-chip {
    color: var(--color-content);
    background-color: var(--color-card);
    box-shadow: 0 4px 14px -4px rgb(0 0 0 / 0.35);
    transition:
        background-color 140ms var(--ease-smooth),
        color 140ms var(--ease-smooth);
}
.edge-chip[data-armed] {
    color: var(--color-fill-content);
    background-color: var(--color-primary-fill);
}
</style>
