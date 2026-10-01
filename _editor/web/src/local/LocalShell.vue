<script setup lang="ts">
import type { ViewBadge } from "@intentic/extension-api";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, onUnmounted } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import { LOCAL_NAVIGATE_EVENT } from "../app/environments/local";
import { type LocalView, localHost } from "../app/environments/localHost";
import { railFrame } from "../shell/rail/railFrame";
import RailTile from "../shell/rail/RailTile.vue";
import { useIconRailSize } from "../shell/rail/useIconRailSize";
import { navigatedPath } from "./appEvents";
import LocalAccountTile from "./LocalAccountTile.vue";
import LocalPlaceSwitcher from "./LocalPlaceSwitcher.vue";

// THE SHELL OF A DESKTOP WINDOW ON A FOLDER OF THIS COMPUTER: the sandbox shell's rail and page, holding what needs no
// sandbox and no account. At the top, the place this window shows and every other one, the account's sandboxes
// included (LocalPlaceSwitcher); under it Files, the folder itself, then every view the app adds (This device, titled
// This computer, localHost.ts); at the foot, the account, or the sign-in before there is one (LocalAccountTile). The
// tiles are the sandbox shell's own (shell/rail/iconRail.css), so signing in changes what the rail holds, never what it is.

const t = useT();
const host = localHost();
const route = useRoute();
const router = useRouter();
const { iconRailSize } = useIconRailSize();
const gridStyle = computed(() => railFrame(iconRailSize.value));

interface Tile {
    readonly section: string;
    readonly to: string;
    readonly label: string;
    readonly badge?: ViewBadge;
}

// A view's tile, carrying its badge only while it has one.
const viewTile = (view: LocalView): Tile => {
    const tile: Tile = { section: view.section, to: `/${view.path}`, label: view.title() };
    const badge = view.badge?.value;
    return badge === undefined ? tile : { ...tile, badge };
};

// Files first, as the sandbox shell ranks its workspace, then the app's views in the order it gives them.
const tiles = computed<readonly Tile[]>(() => [{ section: `workspace`, to: `/workspace`, label: t(`shared.files`) }, ...host.views.map(viewTile)]);

// Prefix match, as the sandbox shell's: a file path under /workspace keeps its tile lit.
const isActive = (to: string): boolean => route.path === to || route.path.startsWith(`${to}/`);
const tileLabel = (tile: Tile): string => [tile.label, tile.badge?.tooltip, tile.badge?.running].filter((part) => part !== undefined && part !== ``).join(` · `);

// The app showing this window for a reason of its own (a setup handed over, the tray's agent row) names the screen it
// is for; only a route of this shell is taken, anything else leaves the reader where they are.
const onNavigate = (event: Event): void => {
    const path = navigatedPath(event);
    if (path !== undefined && router.resolve(path).matched.length > 0 && route.path !== path) {
        void router.push(path);
    }
};
onMounted(() => window.addEventListener(LOCAL_NAVIGATE_EVENT, onNavigate));
onUnmounted(() => window.removeEventListener(LOCAL_NAVIGATE_EVENT, onNavigate));
</script>

<template>
    <div class="local-shell grid h-screen overflow-hidden bg-canvas text-content" :style="gridStyle">
        <nav class="icon-rail flex flex-col items-center border-r border-line bg-card" style="grid-area: rail">
            <!-- Top of the rail: the place this window shows, and every other one this computer has opened. -->
            <LocalPlaceSwitcher />
            <span class="my-1 icon-rail-divider h-px bg-line"></span>

            <div class="icon-rail-nav scrollbar-none flex flex-col items-center overflow-y-auto overscroll-contain">
                <!-- The sandbox shell's corners, drawn the same: a badge for news, a spinning mark for work in flight. -->
                <RailTile
                    v-for="tile in tiles"
                    :key="tile.to"
                    :section="tile.section"
                    :to="tile.to"
                    :label="tileLabel(tile)"
                    :badge="tile.badge"
                    :active="isActive(tile.to)"
                />
            </div>

            <!-- At the foot, where the sandbox shell keeps the account: the account, or the sign-in that brings one. -->
            <div class="mt-auto flex flex-col items-center">
                <LocalAccountTile />
            </div>
        </nav>

        <main class="relative flex min-w-0 flex-col overflow-hidden" style="grid-area: workspace">
            <div class="min-h-0 flex-1 overflow-auto">
                <RouterView />
            </div>
        </main>
    </div>
</template>

<style scoped>
.local-shell {
    grid-template-columns: var(--icon-rail-width) minmax(0, 1fr);
    /* One explicit row, so a stray element landing in an implicit row can't starve 1fr to zero height. */
    grid-template-rows: minmax(0, 1fr);
    grid-template-areas: "rail workspace";
}
</style>
