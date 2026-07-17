<script setup lang="ts">
import { useDevice } from "@intentic-app/ui";
import { RouterView } from "vue-router";
import MobileTabBar from "./MobileTabBar.vue";
import SandboxGate from "../sandbox-gates/SandboxGate.vue";

/* The mobile chrome: full-screen views over a bottom tab bar. h-dvh (not h-screen) tracks the browser UI
 * chrome; the tab bar yields to the on-screen keyboard so composers keep the room. The desktop grid's rail,
 * chat column, and docked terminal have no mobile equivalents — chat and terminal are full-screen routes,
 * the rail's tiles live on /menu. */

const { keyboardInset } = useDevice();
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
